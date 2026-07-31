package kr.teamloc.share;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.eclipse.paho.client.mqttv3.MqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;

import java.nio.charset.StandardCharsets;

/**
 * 화면이 꺼져도 위치를 계속 올리는 포그라운드 서비스.
 *
 * 왜 필요한가: WebView(및 크롬)는 화면이 꺼지거나 앱이 백그라운드로 가면 위치 갱신을
 * 멈춘다. 브라우저 엔진의 제약이라 웹 코드로는 우회할 수 없다. 그래서 위치 수집과
 * 전송만 네이티브로 따로 돌린다.
 *
 * 웹 화면과 같은 대원 id 로 발행하므로 팀원 지도에서는 끊김 없이 이어진다.
 * 팀 이름과 암호는 메모리에만 두고 저장하지 않는다. 서비스가 강제 종료되면
 * 추적도 멈추고, 다시 시작할 때 웹 화면에서 값을 다시 넘겨받는다.
 */
public class TrackerService extends Service {

    private static final String TAG = "TrackerService";
    private static final String CHANNEL_ID = "tracking";
    private static final String MESSAGE_CHANNEL_ID = "messages";
    private static final int NOTIFICATION_ID = 1;
    private static int messageNotificationId = 100;

    static final String ACTION_START = "kr.teamloc.share.START";
    static final String ACTION_STOP = "kr.teamloc.share.STOP";
    static final String ACTION_STOP_LOCATION = "kr.teamloc.share.STOP_LOCATION";

    /**
     * 앱 화면이 보이는 중인지. 보이는 동안에는 웹 화면이 직접 알리므로
     * 알림 팝업을 띄우지 않는다(같은 메시지를 두 번 알리지 않기 위함).
     */
    static volatile boolean appForeground = false;

    private static final long PUBLISH_INTERVAL_MS = 15000;
    private static final long LOCATION_MIN_INTERVAL_MS = 5000;
    private static final float LOCATION_MIN_DISTANCE_M = 5f;

    private static volatile boolean running = false;

    private LocationManager locationManager;
    private MqttAsyncClient client;
    private TeamCrypto crypto;
    private Handler handler;

    private String clientId = "";
    private String callsign = "";
    private boolean trackLocation = false;
    private Location lastLocation;
    private long lastPublishedAt;

    private static volatile boolean locationRunning = false;

    static boolean isRunning() {
        return running;
    }

    /** 위치 추적(화면 꺼짐 추적)이 켜져 있는지. 메시지 수신만 하는 상태와 구분한다. */
    static boolean isTrackingLocation() {
        return locationRunning;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            // 팀에서 나가는 것이므로 모아 둔 경로도 버린다. 다음 임무에 섞이면 안 된다.
            clearTrail();
            stopTracking();
            return START_NOT_STICKY;
        }

        // 위치 추적만 끄고 메시지 수신은 유지한다.
        if (ACTION_STOP_LOCATION.equals(action)) {
            trackLocation = false;
            locationRunning = false;
            handler.removeCallbacks(publishLoop);
            try {
                locationManager.removeUpdates(locationListener);
            } catch (Exception ignored) {
            }
            updateNotification(getString(R.string.messaging_active));
            return START_STICKY;
        }

        if (!ACTION_START.equals(action) || intent == null) {
            // 시스템이 값 없이 서비스를 되살린 경우. 자격 정보가 없으니 그냥 종료한다.
            stopSelf();
            return START_NOT_STICKY;
        }

        String team = intent.getStringExtra("team");
        String secret = intent.getStringExtra("secret");
        String broker = intent.getStringExtra("broker");
        // 자체 브로커는 아이디·암호를 요구하는 경우가 많다. 없으면 비워 둔다.
        String brokerUser = orEmpty(intent.getStringExtra("brokerUser"));
        String brokerPass = orEmpty(intent.getStringExtra("brokerPass"));
        clientId = orEmpty(intent.getStringExtra("clientId"));
        callsign = orEmpty(intent.getStringExtra("callsign"));

        // 위치까지 올릴지, 메시지 수신만 할지.
        // 메시지 알림은 앱에 들어오면 항상 켜지고, 위치 추적은 사용자가 따로 켠다.
        boolean wantLocation = intent.getBooleanExtra("trackLocation", false);

        if (team == null || secret == null || clientId.isEmpty()) {
            Log.w(TAG, "missing credentials");
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean wasTracking = trackLocation;
        trackLocation = trackLocation || wantLocation;

        startForegroundSafely(trackLocation
                ? getString(R.string.tracking_starting)
                : getString(R.string.messaging_active));

        if (crypto == null) {
            try {
                crypto = TeamCrypto.derive(team, secret);
            } catch (Exception e) {
                Log.e(TAG, "key derivation failed", e);
                stopTracking();
                return START_NOT_STICKY;
            }
        }

        if (client == null) {
            connect(broker != null && !broker.isEmpty()
                    ? broker : getString(R.string.default_broker), brokerUser, brokerPass);
        }

        // 위치 추적을 이제 막 켠 경우에만 위치 수신을 시작한다.
        if (trackLocation && !wasTracking) {
            requestLocationUpdates();
            handler.postDelayed(publishLoop, PUBLISH_INTERVAL_MS);
        }

        running = true;
        locationRunning = trackLocation;
        return START_STICKY;
    }

    // ---------- 위치 ----------

    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            lastLocation = location;
            // 화면이 꺼져 있는 동안에도 임무 경로가 이어지도록 따로 모아 둔다.
            remember(clientId, callsign,
                    location.getLatitude(), location.getLongitude(),
                    location.hasAltitude() ? location.getAltitude() : Double.NaN,
                    Math.round(location.getAccuracy()),
                    System.currentTimeMillis());
            publishIfDue(false);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {
        }

        @Override
        public void onProviderEnabled(String provider) {
        }

        @Override
        public void onProviderDisabled(String provider) {
        }
    };

    private void requestLocationUpdates() {
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER,
                        LOCATION_MIN_INTERVAL_MS, LOCATION_MIN_DISTANCE_M, locationListener,
                        Looper.getMainLooper());
            }
            // 실내에서 GPS 가 잡히지 않을 때를 대비해 네트워크 위치도 함께 받는다.
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER,
                        LOCATION_MIN_INTERVAL_MS, LOCATION_MIN_DISTANCE_M, locationListener,
                        Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            Log.e(TAG, "location permission missing", e);
            updateNotification(getString(R.string.tracking_no_permission));
        }
    }

    /** 위치 변화가 없어도 주기적으로 한 번씩 올려서 팀원 화면에서 사라지지 않게 한다. */
    private final Runnable publishLoop = new Runnable() {
        @Override
        public void run() {
            publishIfDue(true);
            if (running) handler.postDelayed(this, PUBLISH_INTERVAL_MS);
        }
    };

    // ---------- MQTT ----------

    private void connect(String brokerUrl, String user, String pass) {
        try {
            client = new MqttAsyncClient(brokerUrl, "rtloc-bg-" + clientId, new MemoryPersistence());

            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            options.setAutomaticReconnect(true);
            options.setConnectionTimeout(10);
            options.setKeepAliveInterval(30);
            if (user != null && !user.isEmpty()) {
                options.setUserName(user);
                options.setPassword(pass == null ? new char[0] : pass.toCharArray());
            }

            client.connect(options, null, new org.eclipse.paho.client.mqttv3.IMqttActionListener() {
                @Override
                public void onSuccess(org.eclipse.paho.client.mqttv3.IMqttToken token) {
                    updateNotification(getString(R.string.tracking_active));
                    publishIfDue(true);
                    subscribeForMessages();
                }

                @Override
                public void onFailure(org.eclipse.paho.client.mqttv3.IMqttToken token, Throwable e) {
                    Log.e(TAG, "mqtt connect failed", e);
                    updateNotification(getString(R.string.tracking_offline));
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "mqtt setup failed", e);
            updateNotification(getString(R.string.tracking_offline));
        }
    }

    /**
     * 팀 채널을 구독해서 화면이 꺼져 있어도 메시지 알림을 띄운다.
     *
     * 위치만 보내고 끝내면, 화면이 꺼진 대원은 팀 메시지를 놓친다.
     * 그래서 이 서비스가 메시지도 함께 받아 알림으로 알린다.
     */
    private void subscribeForMessages() {
        try {
            client.subscribe(crypto.topic(), 0, new org.eclipse.paho.client.mqttv3.IMqttMessageListener() {
                @Override
                public void messageArrived(String topic, MqttMessage message) throws Exception {
                    handleIncoming(new String(message.getPayload(), StandardCharsets.UTF_8));
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "subscribe failed", e);
        }
    }

    private void handleIncoming(String envelope) {
        String json;
        try {
            json = crypto.decrypt(envelope);
        } catch (Exception e) {
            return; // 다른 팀 암호로 온 메시지. 조용히 버린다.
        }

        String type = TeamCrypto.extract(json, "type");

        // 화면이 꺼져 있는 동안 도착한 대원 위치도 모아 둔다.
        // 예전에는 그냥 버려서, 돌아왔을 때 그 시간대 경로가 통째로 비었다.
        if ("pos".equals(type)) {
            rememberIncoming(json);
            return;
        }

        if (!"chat".equals(type)) return;

        String senderId = TeamCrypto.extract(json, "senderId");
        if (clientId.equals(senderId)) return; // 내가 보낸 메시지

        String sender = TeamCrypto.extract(json, "senderName");
        String text = TeamCrypto.extract(json, "text");
        if (text == null || text.isEmpty()) return;

        // 앱 화면을 보고 있는 중이면 웹 화면이 직접 알린다. 중복 알림을 막는다.
        if (appForeground) return;

        showMessageNotification(sender == null || sender.isEmpty() ? "대원" : sender, text);
    }

    private void publishIfDue(boolean force) {
        if (crypto == null || lastLocation == null || client == null) return;

        long now = System.currentTimeMillis();
        if (!force && now - lastPublishedAt < LOCATION_MIN_INTERVAL_MS) return;
        lastPublishedAt = now;

        // 고도. hasAltitude() 가 false 면 getAltitude() 는 0.0 을 돌려주므로
        // 확인 없이 보내면 해수면 높이로 잘못 표시된다. 없을 때는 null 로 보낸다.
        String alt = lastLocation.hasAltitude()
                ? String.valueOf(Math.round(lastLocation.getAltitude()))
                : "null";

        // 수직 정확도는 안드로이드 8(API 26) 부터 제공된다.
        String altAcc = "null";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && lastLocation.hasVerticalAccuracy()) {
            altAcc = String.valueOf(Math.round(lastLocation.getVerticalAccuracyMeters()));
        }

        String json = "{"
                + "\"type\":\"pos\","
                + "\"id\":\"" + escape(clientId) + "\","
                + "\"name\":\"" + escape(callsign) + "\","
                + "\"lat\":" + round6(lastLocation.getLatitude()) + ","
                + "\"lng\":" + round6(lastLocation.getLongitude()) + ","
                + "\"acc\":" + Math.round(lastLocation.getAccuracy()) + ","
                + "\"alt\":" + alt + ","
                + "\"altAcc\":" + altAcc + ","
                + "\"bg\":true,"
                + "\"ts\":" + now
                + "}";

        try {
            if (!client.isConnected()) return;
            MqttMessage message = new MqttMessage(
                    crypto.encrypt(json).getBytes(StandardCharsets.UTF_8));
            message.setQos(0);
            client.publish(crypto.topic(), message);
            updateNotification(getString(R.string.tracking_active));
        } catch (Exception e) {
            Log.e(TAG, "publish failed", e);
        }
    }

    // ---------- 알림 ----------

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        // 추적 상태 알림: 조용히 떠 있어야 하므로 낮은 중요도.
        NotificationChannel tracking = new NotificationChannel(CHANNEL_ID,
                getString(R.string.tracking_channel), NotificationManager.IMPORTANCE_LOW);
        tracking.setShowBadge(false);
        manager.createNotificationChannel(tracking);

        // 메시지 알림: 소리와 진동으로 확실히 알려야 하므로 높은 중요도.
        NotificationChannel messages = new NotificationChannel(MESSAGE_CHANNEL_ID,
                getString(R.string.message_channel), NotificationManager.IMPORTANCE_HIGH);
        messages.enableVibration(true);
        messages.setVibrationPattern(new long[]{0, 220, 120, 320});
        messages.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(messages);
    }

    /** 팀 메시지 도착 알림. 소리와 진동은 채널 설정과 기기 설정을 따른다. */
    private void showMessageNotification(String sender, String text) {
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 2, open, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, MESSAGE_CHANNEL_ID)
                : new Notification.Builder(this);

        builder.setContentTitle(sender)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(contentIntent);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 화면 위에 잠깐 떠오르는 팝업(헤즈업)으로 보이게 한다.
            builder.setVibrate(new long[]{0, 220, 120, 320});
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
            builder.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        }

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(messageNotificationId++, builder.build());
            if (messageNotificationId > 999) messageNotificationId = 100;
        }
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, flags);

        Intent stop = new Intent(this, TrackerService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setContentIntent(contentIntent)
                .addAction(new Notification.Action.Builder(null,
                        getString(R.string.tracking_stop), stopIntent).build())
                .build();
    }

    private void startForegroundSafely(String text) {
        Notification notification = buildNotification(text);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // 안드로이드 14 부터는 서비스 종류를 밝혀야 한다.
            // 위치를 쓰지 않는 메시지 전용 모드에서 location 종류로 시작하면 거부된다.
            int type = trackLocation && hasLocationPermission()
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                    : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            startForeground(NOTIFICATION_ID, notification, type);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    // ---------- 정리 ----------

    private void stopTracking() {
        running = false;
        locationRunning = false;
        trackLocation = false;
        if (handler != null) handler.removeCallbacks(publishLoop);

        try {
            locationManager.removeUpdates(locationListener);
        } catch (Exception ignored) {
        }

        if (client != null) {
            try {
                if (client.isConnected()) client.disconnectForcibly(500, 500);
                client.close();
            } catch (Exception ignored) {
            }
            client = null;
        }

        crypto = null;
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- 유틸 ----------

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    // ---------- 임무 경로 보관 ----------
    //
    // 앱이 뒤로 가면 웹 화면(자바스크립트)이 멈춘다. 위치는 이 서비스가 계속 받고 보내지만
    // 임무 경로에 기록하는 주체가 없어서, 돌아왔을 때 한 점만 찍히고 그 사이가 직선으로
    // 이어져 버렸다. 그래서 받은 위치를 여기에 모아 두고, 웹 화면이 다시 앞으로 나올 때
    // 가져가 경로를 메꾸게 한다.
    //
    // 솎는 기준(5m / 4초)은 mission.js 와 같게 맞췄다. 그쪽에서 어차피 그 기준으로
    // 걸러내므로 더 촘촘히 모아 둘 이유가 없다.

    private static final int TRAIL_MAX = 20000;
    private static final double TRAIL_MIN_DISTANCE_M = 5;
    private static final long TRAIL_MIN_INTERVAL_MS = 4000;

    private static final class Fix {
        final String id;
        final String name;
        final double lat;
        final double lng;
        final double alt; // 없으면 NaN
        final int acc;
        final long ts;

        Fix(String id, String name, double lat, double lng, double alt, int acc, long ts) {
            this.id = id;
            this.name = name;
            this.lat = lat;
            this.lng = lng;
            this.alt = alt;
            this.acc = acc;
            this.ts = ts;
        }
    }

    private static final java.util.ArrayDeque<Fix> trail = new java.util.ArrayDeque<>();
    // 대원별로 마지막에 남긴 점. 솎는 기준을 판단하는 데 쓴다.
    private static final java.util.HashMap<String, Fix> trailLast = new java.util.HashMap<>();

    /** 위치 하나를 보관 대상으로 넣는다. 위치 콜백과 MQTT 수신 스레드가 함께 부르므로 동기화한다. */
    private static synchronized void remember(String id, String name,
                                             double lat, double lng, double alt, int acc, long ts) {
        if (id == null || id.isEmpty()) return;
        if (Double.isNaN(lat) || Double.isNaN(lng)) return;

        Fix prev = trailLast.get(id);
        if (prev != null) {
            if (ts <= prev.ts) return; // 순서가 뒤집힌 것은 버린다
            boolean moved = metersBetween(prev.lat, prev.lng, lat, lng) >= TRAIL_MIN_DISTANCE_M;
            boolean waited = ts - prev.ts >= TRAIL_MIN_INTERVAL_MS;
            if (!moved && !waited) return;
        }

        Fix fix = new Fix(id, name == null ? "" : name, lat, lng, alt, acc, ts);
        trail.addLast(fix);
        trailLast.put(id, fix);
        while (trail.size() > TRAIL_MAX) trail.pollFirst();
    }

    /** 받은 위치 메시지에서 값을 뽑아 보관한다. */
    private void rememberIncoming(String json) {
        String senderId = TeamCrypto.extract(json, "id");
        if (senderId == null || senderId.equals(clientId)) return; // 내 것은 위치 콜백에서 이미 넣었다

        Double lat = asNumber(TeamCrypto.extract(json, "lat"));
        Double lng = asNumber(TeamCrypto.extract(json, "lng"));
        if (lat == null || lng == null) return;

        Double alt = asNumber(TeamCrypto.extract(json, "alt"));
        Double acc = asNumber(TeamCrypto.extract(json, "acc"));
        Double ts = asNumber(TeamCrypto.extract(json, "ts"));

        String name = TeamCrypto.extract(json, "name");
        remember(senderId, name, lat, lng,
                alt == null ? Double.NaN : alt,
                acc == null ? 0 : (int) Math.round(acc),
                ts == null ? System.currentTimeMillis() : (long) (double) ts);
    }

    /**
     * 지정한 시각 이후에 모아 둔 위치를 JSON 배열로 돌려준다.
     * 웹 화면이 앞으로 나올 때와 임무를 끝낼 때 가져간다.
     */
    static synchronized String trailSince(long since) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('[');
        boolean first = true;
        for (Fix f : trail) {
            if (f.ts <= since) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"id\":\"").append(escape(f.id)).append("\",")
                    .append("\"name\":\"").append(escape(f.name)).append("\",")
                    .append("\"lat\":").append(round6(f.lat)).append(',')
                    .append("\"lng\":").append(round6(f.lng)).append(',')
                    .append("\"acc\":").append(f.acc).append(',')
                    .append("\"alt\":")
                    .append(Double.isNaN(f.alt) ? "null" : String.valueOf(Math.round(f.alt)))
                    .append(",\"ts\":").append(f.ts).append('}');
        }
        return sb.append(']').toString();
    }

    /** 팀에서 나갈 때 보관한 경로도 버린다. 다음 임무에 섞이면 안 된다. */
    private static synchronized void clearTrail() {
        trail.clear();
        trailLast.clear();
    }

    private static Double asNumber(String text) {
        if (text == null || text.isEmpty() || "null".equals(text)) return null;
        try {
            return Double.valueOf(text);
        } catch (Exception e) {
            return null;
        }
    }

    /** 두 좌표 사이 거리(m). 솎는 기준 판단용이라 구면 근사로 충분하다. */
    private static double metersBetween(double lat1, double lng1, double lat2, double lng2) {
        double r = 6371000;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    private static double round6(double value) {
        return Math.round(value * 1e6) / 1e6;
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
