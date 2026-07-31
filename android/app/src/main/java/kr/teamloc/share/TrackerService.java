package kr.teamloc.share;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Granularity;
import com.google.android.gms.location.LocationAvailability;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.eclipse.paho.client.mqttv3.MqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * 화면이 꺼져도 위치를 계속 올리는 포그라운드 서비스.
 *
 * WebView(및 크롬)는 화면이 꺼지거나 앱이 백그라운드로 가면 위치 갱신을 멈춘다.
 * 그래서 위치 수집과 전송은 네이티브 서비스가 전담한다.
 *
 * v1.5.4 부터는 LocationManager 를 주 수집기로 쓰지 않는다. Google Play Services 의
 * Fused Location Provider 에 고정밀 위치를 5초 간격, 이동거리 0m, 배치 없음으로 요청한다.
 * 화면이 꺼질 때 CPU 자체가 잠들지 않도록 이 서비스가 도는 동안 PARTIAL_WAKE_LOCK 도
 * 잡는다. Google Play Services 가 없는 기기에서만 LocationManager GPS 로 되돌아간다.
 *
 * 5초는 Android 에 보내는 강한 요청이지 하드웨어 보장은 아니다. 위성 신호가 없거나
 * 제조사 절전 정책이 서비스를 막으면 새 위치를 만들 수 없다. 그런 때는 부정확한 기지국
 * 위치나 오래된 위치를 현재 위치인 것처럼 보내지 않고, 정확한 새 위치를 기다린다.
 */
public class TrackerService extends Service {

    private static final String TAG = "TrackerService";
    private static final String CHANNEL_ID = "tracking";
    private static final String MESSAGE_CHANNEL_ID = "messages";
    private static final String WAKE_LOCK_TAG = "kr.teamloc.share:TrackerService";
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

    // Fused Location 요청. 원하는 주기는 5초이고, 이동거리 조건은 두지 않는다.
    // min interval 은 기기 지터 때문에 4.5초로 둔다. 5초보다 조금 일찍 온 좋은 값을
    // 버렸다가 10초 뒤에 받는 일이 없게 하기 위해서다.
    private static final long LOCATION_INTERVAL_MS = 5000;
    private static final long LOCATION_MIN_INTERVAL_MS = 4500;
    private static final float LOCATION_MIN_DISTANCE_M = 0f;
    private static final long PUBLISH_RETRY_INTERVAL_MS = 5000;
    private static final long MQTT_RETRY_INTERVAL_MS = 5000;
    private static final long PUBLISH_MIN_INTERVAL_MS = 4000;
    private static final long MAX_FIX_AGE_MS = 15000;

    // Google Play Services 가 없는 기기에서만 쓰는 LocationManager 예비 경로.
    private static final long NETWORK_FALLBACK_INTERVAL_MS = 30000;
    private static final float NETWORK_FALLBACK_DISTANCE_M = 50f;

    // 튀는 위치 필터. mission.js 의 acceptFix 와 반드시 같은 값이어야 한다.
    // 90초 뒤 1km 위치를 받아 주던 v1.5.3 완화 규칙은 제거했다. 경로가 비는 편이
    // 가지도 않은 곳을 다녀온 경로를 만드는 것보다 정직하다.
    private static final float FIX_GOOD_ACCURACY_M = 50f;
    private static final float FIX_MAX_ACCURACY_M = 100f;
    private static final float FIX_ACCURACY_SLACK_M = 30f;
    private static final double FIX_MAX_SPEED_MPS = 55; // 약 200km/h

    private static final String LOCATION_STATE_STARTING = "starting";
    private static final String LOCATION_STATE_ACTIVE = "active";
    private static final String LOCATION_STATE_UNAVAILABLE = "unavailable";

    private static volatile boolean running = false;
    private static volatile boolean locationRunning = false;
    private static volatile String trackingState = LOCATION_STATE_UNAVAILABLE;

    private LocationManager locationManager;
    private FusedLocationProviderClient fusedLocationClient;
    private PowerManager.WakeLock trackingWakeLock;
    private MqttAsyncClient client;
    private volatile boolean mqttReady = false;
    private volatile boolean mqttConnecting = false;
    private boolean mqttRetryScheduled = false;
    private boolean mqttSubscriptionPending = false;
    private boolean mqttSubscriptionRetryScheduled = false;
    private int mqttSubscriptionGeneration = 0;
    private String mqttBrokerUrl = "";
    private String mqttUser = "";
    private String mqttPass = "";
    private TeamCrypto crypto;
    private Handler handler;
    private volatile boolean serviceActive = false;

    private String clientId = "";
    private String callsign = "";
    private boolean trackLocation = false;

    // 위치 요청 등록 상태. "추적하고 싶다" 와 "실제로 콜백이 등록됐다" 를 구분한다.
    // 예전에는 권한 오류가 나도 locationRunning=true 가 되어, 권한을 고친 뒤에도 웹이
    // 이미 추적 중이라고 믿고 다시 요청하지 않는 버그가 있었다.
    private boolean fusedUpdatesRegistered = false;
    private boolean platformUpdatesRegistered = false;
    private boolean locationRequestPending = false;
    private boolean publishLoopScheduled = false;
    private int locationRequestGeneration = 0;
    private LocationCallback activeFusedCallback;
    private LocationCallback pendingFusedCallback;

    private Location lastLocation;
    private long lastPublishedAt;
    private long lastPublishedFixElapsedNanos;

    static boolean isRunning() {
        return running;
    }

    /** 실제 위치 콜백이 등록돼 있는지. 추적 희망 상태를 돌려주지 않는다. */
    static boolean isTrackingLocation() {
        return locationRunning;
    }

    /** WebView가 v1.5.4 네이티브 publisher의 현재 소유권을 판단할 때 쓴다. */
    static String locationTrackingState() {
        return trackingState;
    }

    /** JavascriptInterface 호출과 서비스 시작 사이에도 이중 발행이 생기지 않게 한다. */
    static void markLocationTrackingStarting() {
        if (!LOCATION_STATE_ACTIVE.equals(trackingState)) {
            trackingState = LOCATION_STATE_STARTING;
        }
    }

    static void markLocationTrackingUnavailable() {
        trackingState = LOCATION_STATE_UNAVAILABLE;
    }

    /** 위치 callback과 MQTT transport가 모두 준비됐을 때만 네이티브가 발행을 전담한다. */
    private void refreshPublisherState() {
        if (!serviceActive) return;
        if (!trackLocation) {
            trackingState = LOCATION_STATE_UNAVAILABLE;
        } else if (locationRunning && mqttReady) {
            trackingState = LOCATION_STATE_ACTIVE;
        } else if (mqttConnecting || (locationRequestPending && mqttReady)) {
            trackingState = LOCATION_STATE_STARTING;
        } else {
            trackingState = LOCATION_STATE_UNAVAILABLE;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
        } catch (Throwable e) {
            // Google Play Services 가 없는 AOSP 기기. LocationManager 예비 경로를 쓴다.
            Log.w(TAG, "Fused Location 초기화 실패; GPS provider 로 대체", e);
            fusedLocationClient = null;
        }
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

        // 구버전 웹에서만 올 수 있다. 현재 UI 에는 위치만 끄는 버튼이 없다.
        if (ACTION_STOP_LOCATION.equals(action)) {
            trackLocation = false;
            stopLocationUpdates();
            startForegroundSafely(getString(R.string.messaging_active));
            return START_NOT_STICKY;
        }

        if (!ACTION_START.equals(action) || intent == null) {
            // START_REDELIVER_INTENT 면 보통 마지막 START 인텐트가 다시 온다. 기기 사정으로
            // 값 없이 살아난 경우에는 자격 정보가 없으므로 안전하게 끝낸다.
            trackingState = LOCATION_STATE_UNAVAILABLE;
            stopSelf();
            return START_NOT_STICKY;
        }

        String team = intent.getStringExtra("team");
        String secret = intent.getStringExtra("secret");
        String broker = intent.getStringExtra("broker");
        String brokerUser = orEmpty(intent.getStringExtra("brokerUser"));
        String brokerPass = orEmpty(intent.getStringExtra("brokerPass"));
        clientId = orEmpty(intent.getStringExtra("clientId"));
        callsign = orEmpty(intent.getStringExtra("callsign"));
        boolean wantLocation = intent.getBooleanExtra("trackLocation", false);

        if (team == null || secret == null || clientId.isEmpty()) {
            Log.w(TAG, "missing credentials");
            trackingState = LOCATION_STATE_UNAVAILABLE;
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean redelivered = (flags & START_FLAG_REDELIVERY) != 0;
        if (wantLocation && redelivered && !hasBackgroundLocationPermission()) {
            // Android 14는 background에서 while-in-use 위치 권한만으로 location FGS를
            // 되살리는 것을 허용하지 않는다. 메시지는 복구하되 Activity가 다시 보일 때까지
            // 위치 요청과 wake lock은 보류한다.
            Log.w(TAG, "background location permission missing on redelivery");
            trackLocation = false;
            trackingState = LOCATION_STATE_UNAVAILABLE;
        } else {
            trackLocation = trackLocation || wantLocation;
            if (trackLocation && !locationRunning) {
                trackingState = LOCATION_STATE_STARTING;
            }
        }

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

        // connect callback이 매우 빨리 와도 중지된 서비스로 오인하지 않게 먼저 표시한다.
        serviceActive = true;
        running = true;

        if (client == null) {
            connect(broker != null && !broker.isEmpty()
                    ? broker : getString(R.string.default_broker), brokerUser, brokerPass);
        }

        // 반복 START 도 매번 확인한다. 요청 함수 자체가 멱등이라 중복 등록하지 않는다.
        // 권한을 고친 뒤 다시 들어온 START 를 놓치지 않기 위해 wasTracking 조건을 없앴다.
        if (trackLocation) {
            ensureLocationUpdates();
            ensurePublishLoop();
        }

        // 프로세스가 메모리 압박으로 죽으면 마지막 START 인텐트를 다시 받아, 사용자가
        // 화면을 켤 때까지 기다리지 않고 위치 추적을 복구한다.
        return START_REDELIVER_INTENT;
    }

    // ---------- 위치 ----------

    private LocationCallback createFusedLocationCallback(final int generation) {
        return new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (!trackLocation || generation != locationRequestGeneration || result == null) return;
                List<Location> locations = result.getLocations();
                for (Location location : locations) handleLocation(location);
            }

            @Override
            public void onLocationAvailability(LocationAvailability availability) {
                if (!trackLocation || generation != locationRequestGeneration || availability == null) return;
                if (!availability.isLocationAvailable()) {
                    updateNotification(mqttReady
                            ? getString(R.string.tracking_waiting_for_gps)
                            : currentTrackingNotification());
                }
            }
        };
    }

    /** Google Play Services 가 없는 기기에서만 쓰는 예비 callback. */
    private final LocationListener platformLocationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            handleLocation(location);
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

    /**
     * 5초 고정밀 위치 요청을 한 번만 등록한다.
     *
     * Fused 요청은 비동기로 성공/실패가 정해진다. pending/registered/generation 을 따로 둬서
     * 반복 START, 권한 변경, 중지 직후 늦게 도착한 성공 callback 이 중복 요청을 만들지 않게 한다.
     */
    @SuppressLint("MissingPermission")
    private void ensureLocationUpdates() {
        if (!trackLocation) {
            trackingState = LOCATION_STATE_UNAVAILABLE;
            return;
        }

        if (!hasLocationPermission()) {
            locationRunning = false;
            trackingState = LOCATION_STATE_UNAVAILABLE;
            downgradeLocationForeground(getString(R.string.tracking_no_permission));
            releaseTrackingWakeLock();
            return;
        }

        if (fusedUpdatesRegistered || platformUpdatesRegistered) {
            locationRunning = true;
            refreshPublisherState();
            acquireTrackingWakeLock();
            return;
        }
        if (locationRequestPending) {
            refreshPublisherState();
            return;
        }

        trackingState = LOCATION_STATE_STARTING;
        acquireTrackingWakeLock();

        if (fusedLocationClient == null) {
            if (!startPlatformLocationFallback()) {
                trackingState = LOCATION_STATE_UNAVAILABLE;
                downgradeLocationForeground(getString(R.string.tracking_unavailable));
                releaseTrackingWakeLock();
            }
            return;
        }

        LocationRequest request = new LocationRequest.Builder(
                Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
                .setGranularity(Granularity.GRANULARITY_FINE)
                .setMinUpdateIntervalMillis(LOCATION_MIN_INTERVAL_MS)
                .setMinUpdateDistanceMeters(LOCATION_MIN_DISTANCE_M)
                .setMaxUpdateDelayMillis(LOCATION_INTERVAL_MS) // 2배 미만이므로 배치되지 않는다
                .setMaxUpdateAgeMillis(0) // 첫 callback 도 캐시가 아닌 새 위치만
                .setWaitForAccurateLocation(true)
                .build();

        final int generation = ++locationRequestGeneration;
        final LocationCallback callback = createFusedLocationCallback(generation);
        pendingFusedCallback = callback;
        locationRequestPending = true;
        refreshPublisherState();

        try {
            fusedLocationClient
                    .requestLocationUpdates(request, callback, Looper.getMainLooper())
                    .addOnSuccessListener(unused -> {
                        if (!trackLocation || generation != locationRequestGeneration
                                || pendingFusedCallback != callback) {
                            // 이 요청만 제거한다. 공유 callback을 제거하면 새 세대 요청까지
                            // 같이 끊기는 race가 생긴다.
                            removeFusedCallback(callback);
                            return;
                        }
                        pendingFusedCallback = null;
                        activeFusedCallback = callback;
                        locationRequestPending = false;
                        fusedUpdatesRegistered = true;
                        platformUpdatesRegistered = false;
                        locationRunning = true;
                        refreshPublisherState();
                        updateNotification(currentTrackingNotification());
                    })
                    .addOnFailureListener(error -> {
                        if (generation != locationRequestGeneration
                                || pendingFusedCallback != callback) {
                            removeFusedCallback(callback);
                            return;
                        }
                        pendingFusedCallback = null;
                        locationRequestPending = false;
                        fusedUpdatesRegistered = false;
                        locationRunning = false;
                        Log.w(TAG, "Fused Location 요청 실패; GPS provider 로 대체", error);
                        if (!startPlatformLocationFallback()) {
                            trackingState = LOCATION_STATE_UNAVAILABLE;
                            downgradeLocationForeground(getString(R.string.tracking_unavailable));
                            releaseTrackingWakeLock();
                        }
                    });
        } catch (SecurityException e) {
            if (pendingFusedCallback == callback) pendingFusedCallback = null;
            locationRequestPending = false;
            locationRunning = false;
            trackingState = LOCATION_STATE_UNAVAILABLE;
            removeFusedCallback(callback);
            Log.e(TAG, "location permission missing", e);
            downgradeLocationForeground(getString(R.string.tracking_no_permission));
            releaseTrackingWakeLock();
        } catch (Throwable e) {
            if (pendingFusedCallback == callback) pendingFusedCallback = null;
            locationRequestPending = false;
            locationRunning = false;
            removeFusedCallback(callback);
            Log.w(TAG, "Fused Location 호출 실패; GPS provider 로 대체", e);
            if (!startPlatformLocationFallback()) {
                trackingState = LOCATION_STATE_UNAVAILABLE;
                downgradeLocationForeground(getString(R.string.tracking_unavailable));
                releaseTrackingWakeLock();
            }
        }
    }

    private void removeFusedCallback(LocationCallback callback) {
        if (callback == null || fusedLocationClient == null) return;
        try {
            fusedLocationClient.removeLocationUpdates(callback);
        } catch (Exception ignored) {
            /* 등록 전이거나 Google Play Services 가 내려간 경우 */
        }
    }

    /**
     * Fused Location 을 쓸 수 없는 기기의 예비 경로.
     * GPS 가 켜져 있으면 GPS 만 5초/0m 로 받는다. 네트워크 위치를 섞으면 다시 경로가
     * 튈 수 있으므로, GPS provider 자체가 꺼진 경우에만 네트워크를 30초 간격으로 쓴다.
     */
    @SuppressLint("MissingPermission")
    private boolean startPlatformLocationFallback() {
        if (!trackLocation || !hasLocationPermission() || locationManager == null) return false;
        if (platformUpdatesRegistered) return true;

        boolean registered = false;
        try {
            boolean gpsEnabled = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
            if (gpsEnabled) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER,
                        LOCATION_INTERVAL_MS, LOCATION_MIN_DISTANCE_M,
                        platformLocationListener, Looper.getMainLooper());
                registered = true;
            } else if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER,
                        NETWORK_FALLBACK_INTERVAL_MS, NETWORK_FALLBACK_DISTANCE_M,
                        platformLocationListener, Looper.getMainLooper());
                registered = true;
            }
        } catch (SecurityException e) {
            Log.e(TAG, "location permission missing", e);
            downgradeLocationForeground(getString(R.string.tracking_no_permission));
        } catch (Exception e) {
            Log.w(TAG, "LocationManager 요청 실패", e);
        }

        platformUpdatesRegistered = registered;
        locationRunning = registered;
        if (registered) {
            refreshPublisherState();
            updateNotification(currentTrackingNotification());
        } else {
            trackingState = LOCATION_STATE_UNAVAILABLE;
        }
        return registered;
    }

    /** 새 위치 하나를 필터, 경로 보관, MQTT 발행까지 한 줄로 처리한다. */
    private void handleLocation(Location location) {
        if (!trackLocation || location == null) return;

        // accuracy 가 없는 값과 15초 넘게 묵은 값은 고정밀 실시간 위치가 아니다.
        if (!location.hasAccuracy() || locationAgeMillis(location) > MAX_FIX_AGE_MS) return;
        if (!acceptFix(location)) return;

        lastLocation = new Location(location);
        long fixTime = fixTimeMillis(location);

        remember(clientId, callsign,
                location.getLatitude(), location.getLongitude(),
                location.hasAltitude() ? location.getAltitude() : Double.NaN,
                Math.round(location.getAccuracy()), fixTime);

        publishIfDue(false);
    }

    /** 방금 받은 내 위치를 믿어도 되는지. 직전에 받아들인 위치와 비교한다. */
    private boolean acceptFix(Location next) {
        if (next == null || !next.hasAccuracy()) return false;

        double acc = next.getAccuracy();
        Location prev = lastLocation;
        if (prev == null) {
            return acceptFix(0, 0, -1, 0,
                    next.getLatitude(), next.getLongitude(), acc, fixTimeMillis(next));
        }

        return acceptFix(prev.getLatitude(), prev.getLongitude(),
                prev.hasAccuracy() ? prev.getAccuracy() : -1, fixTimeMillis(prev),
                next.getLatitude(), next.getLongitude(), acc, fixTimeMillis(next));
    }

    /**
     * 튀는 위치를 걸러내는 기준. mission.js 의 acceptFix 와 같은 판단 순서다.
     *
     * 첫 위치도 100m 이내여야 하고, 오래 기다렸다고 기준을 1km 로 풀지 않는다.
     * 정확한 5초 위치가 없으면 그 시간은 비워 둔다. 거친 점으로 거짓 경로를 만드는 것보다 낫다.
     */
    private static boolean acceptFix(double prevLat, double prevLng, double prevAcc, long prevTs,
                                     double lat, double lng, double acc, long ts) {
        if (Double.isNaN(lat) || Double.isInfinite(lat)
                || Double.isNaN(lng) || Double.isInfinite(lng)) return false;
        if (!(acc > 0) || acc > FIX_MAX_ACCURACY_M) return false;
        if (prevTs <= 0) return true; // 첫 위치도 알려진 accuracy 가 100m 이내여야 한다

        long gap = ts - prevTs;
        if (gap <= 0) return false; // 중복 또는 순서가 뒤집힌 값

        // 정밀한 새 위치는 앞선 값보다 우선한다. 앞선 값이 낡아 순간이동처럼 보일 수 있다.
        if (acc <= FIX_GOOD_ACCURACY_M) return true;

        double moved = metersBetween(prevLat, prevLng, lat, lng);
        double slack = acc + (prevAcc > 0 ? prevAcc : 0);
        if (Math.max(0, moved - slack) / (gap / 1000.0) > FIX_MAX_SPEED_MPS) return false;

        double base = prevAcc > 0 ? prevAcc : FIX_GOOD_ACCURACY_M;
        return acc <= base + FIX_ACCURACY_SLACK_M;
    }

    /** 위치 객체가 실제로 만들어진 시각. 이상한 제공자 시각이면 지금 시각으로 보정한다. */
    private static long fixTimeMillis(Location location) {
        long now = System.currentTimeMillis();
        long time = location == null ? 0 : location.getTime();
        if (time <= 0 || Math.abs(now - time) > 24L * 60 * 60 * 1000) return now;
        return time;
    }

    /** monotonic clock 기준 위치 나이. 기기 시각을 바꿔도 영향받지 않는다. */
    private static long locationAgeMillis(Location location) {
        if (location == null) return Long.MAX_VALUE;
        long fixNanos = location.getElapsedRealtimeNanos();
        if (fixNanos <= 0) return Math.max(0, System.currentTimeMillis() - fixTimeMillis(location));
        return Math.max(0, (SystemClock.elapsedRealtimeNanos() - fixNanos) / 1_000_000L);
    }

    /** 5초마다 연결이 돌아왔는지 확인하고, 아직 안 보낸 최신 위치가 있으면 다시 보낸다. */
    private void ensurePublishLoop() {
        if (publishLoopScheduled || handler == null) return;
        publishLoopScheduled = true;
        handler.postDelayed(publishLoop, PUBLISH_RETRY_INTERVAL_MS);
    }

    private final Runnable publishLoop = new Runnable() {
        @Override
        public void run() {
            publishLoopScheduled = false;
            if (!running || !trackLocation) return;
            publishIfDue(false);
            ensurePublishLoop();
        }
    };

    // ---------- 화면 꺼짐 CPU 유지 ----------

    /** 위치 추적 중에만 CPU가 suspend 되지 않게 한다. 화면은 켜지 않는다. */
    @SuppressLint("WakelockTimeout")
    private void acquireTrackingWakeLock() {
        if (trackingWakeLock != null && trackingWakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power == null) return;

        trackingWakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
        trackingWakeLock.setReferenceCounted(false);
        trackingWakeLock.acquire();
    }

    private void releaseTrackingWakeLock() {
        if (trackingWakeLock == null) return;
        try {
            if (trackingWakeLock.isHeld()) trackingWakeLock.release();
        } catch (RuntimeException e) {
            Log.w(TAG, "wake lock 해제 실패", e);
        }
        trackingWakeLock = null;
    }

    // ---------- MQTT ----------

    /** Paho callback을 Service lifecycle과 같은 main queue에서 직렬화한다. */
    private void postToServiceThread(Runnable action) {
        Handler current = handler;
        if (current != null) current.post(action);
    }

    private final Runnable mqttReconnectLoop = new Runnable() {
        @Override
        public void run() {
            mqttRetryScheduled = false;
            if (!serviceActive || !running || client != null || mqttBrokerUrl.isEmpty()) return;
            connect(mqttBrokerUrl, mqttUser, mqttPass);
        }
    };

    private final Runnable mqttSubscriptionRetryLoop = new Runnable() {
        @Override
        public void run() {
            mqttSubscriptionRetryScheduled = false;
            MqttAsyncClient mqttClient = client;
            if (!serviceActive || !running || mqttClient == null || !mqttClient.isConnected()) return;
            subscribeForMessages(mqttClient);
        }
    };

    private void scheduleMqttReconnect() {
        if (!serviceActive || !running || handler == null || mqttRetryScheduled
                || mqttBrokerUrl.isEmpty()) return;
        mqttRetryScheduled = true;
        handler.postDelayed(mqttReconnectLoop, MQTT_RETRY_INTERVAL_MS);
    }

    private void scheduleMqttSubscriptionRetry() {
        if (!serviceActive || !running || handler == null || mqttSubscriptionRetryScheduled) return;
        mqttSubscriptionRetryScheduled = true;
        handler.postDelayed(mqttSubscriptionRetryLoop, MQTT_RETRY_INTERVAL_MS);
    }

    private void connect(String brokerUrl, String user, String pass) {
        mqttBrokerUrl = orEmpty(brokerUrl);
        mqttUser = orEmpty(user);
        mqttPass = orEmpty(pass);
        if (!serviceActive || !running || client != null || mqttBrokerUrl.isEmpty()) return;

        if (handler != null) handler.removeCallbacks(mqttReconnectLoop);
        mqttRetryScheduled = false;

        try {
            final MqttAsyncClient mqttClient = new MqttAsyncClient(
                    mqttBrokerUrl, "rtloc-bg-" + clientId, new MemoryPersistence());
            client = mqttClient;
            mqttReady = false;
            mqttConnecting = true;
            refreshPublisherState();

            mqttClient.setCallback(new org.eclipse.paho.client.mqttv3.MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverURI) {
                    postToServiceThread(() -> onNativeMqttConnected(mqttClient));
                }

                @Override
                public void connectionLost(Throwable cause) {
                    postToServiceThread(() -> onNativeMqttDisconnected(mqttClient, cause));
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) throws Exception {
                    // topic 전용 listener가 없는 경우의 안전망이다.
                    String envelope = new String(message.getPayload(), StandardCharsets.UTF_8);
                    postToServiceThread(() -> handleIncoming(envelope));
                }

                @Override
                public void deliveryComplete(
                        org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {
                }
            });

            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            options.setAutomaticReconnect(true);
            options.setConnectionTimeout(10);
            options.setKeepAliveInterval(30);
            if (user != null && !user.isEmpty()) {
                options.setUserName(user);
                options.setPassword(pass == null ? new char[0] : pass.toCharArray());
            }

            mqttClient.connect(options, null, new org.eclipse.paho.client.mqttv3.IMqttActionListener() {
                @Override
                public void onSuccess(org.eclipse.paho.client.mqttv3.IMqttToken token) {
                    // connectComplete와 어느 쪽이 먼저 와도 main queue에서 한 번만 처리된다.
                    postToServiceThread(() -> onNativeMqttConnected(mqttClient));
                }

                @Override
                public void onFailure(org.eclipse.paho.client.mqttv3.IMqttToken token, Throwable e) {
                    postToServiceThread(() -> onNativeMqttConnectFailed(mqttClient, e));
                }
            });
        } catch (Exception e) {
            client = null;
            mqttReady = false;
            mqttConnecting = false;
            refreshPublisherState();
            Log.e(TAG, "mqtt setup failed", e);
            updateNotification(getString(R.string.tracking_offline));
            scheduleMqttReconnect();
        }
    }

    private void onNativeMqttConnectFailed(MqttAsyncClient mqttClient, Throwable error) {
        if (!serviceActive || !running || client != mqttClient) return;

        mqttReady = false;
        mqttConnecting = false;
        try {
            mqttClient.close();
        } catch (Exception ignored) {
        }
        if (client == mqttClient) client = null;
        refreshPublisherState();
        Log.e(TAG, "mqtt connect failed", error);
        updateNotification(getString(R.string.tracking_offline));
        scheduleMqttReconnect();
    }

    private void onNativeMqttConnected(MqttAsyncClient mqttClient) {
        if (!serviceActive || !running || client != mqttClient
                || !mqttClient.isConnected() || mqttReady) return;

        mqttConnecting = false;
        mqttReady = true;
        if (handler != null) handler.removeCallbacks(mqttReconnectLoop);
        mqttRetryScheduled = false;
        subscribeForMessages(mqttClient);
        refreshPublisherState();
        updateNotification(currentTrackingNotification());
        publishIfDue(true);
    }

    private void onNativeMqttDisconnected(MqttAsyncClient mqttClient, Throwable cause) {
        if (!serviceActive || !running || client != mqttClient) return;

        // automatic reconnect가 성공하기 전까지 WebView publisher가 fallback할 수 있게
        // 소유권을 즉시 돌려준다. connectComplete가 오면 다시 active가 된다.
        mqttReady = false;
        mqttConnecting = false;
        mqttSubscriptionGeneration++;
        mqttSubscriptionPending = false;
        if (handler != null) handler.removeCallbacks(mqttSubscriptionRetryLoop);
        mqttSubscriptionRetryScheduled = false;
        refreshPublisherState();
        Log.w(TAG, "mqtt connection lost", cause);
        updateNotification(getString(R.string.tracking_offline));
    }

    /** 팀 채널을 QoS 1로 구독하고 SUBACK 실패 시 화면이 꺼져 있어도 다시 시도한다. */
    private void subscribeForMessages(final MqttAsyncClient mqttClient) {
        if (!serviceActive || mqttSubscriptionPending || client != mqttClient
                || !mqttClient.isConnected()) return;

        final int generation = ++mqttSubscriptionGeneration;
        mqttSubscriptionPending = true;
        try {
            mqttClient.subscribe(
                    crypto.topic(),
                    1,
                    null,
                    new org.eclipse.paho.client.mqttv3.IMqttActionListener() {
                        @Override
                        public void onSuccess(org.eclipse.paho.client.mqttv3.IMqttToken token) {
                            postToServiceThread(() ->
                                    onMqttSubscriptionSucceeded(mqttClient, generation));
                        }

                        @Override
                        public void onFailure(org.eclipse.paho.client.mqttv3.IMqttToken token,
                                              Throwable error) {
                            postToServiceThread(() ->
                                    onMqttSubscriptionFailed(mqttClient, generation, error));
                        }
                    },
                    new org.eclipse.paho.client.mqttv3.IMqttMessageListener() {
                        @Override
                        public void messageArrived(String topic, MqttMessage message) throws Exception {
                            String envelope = new String(message.getPayload(), StandardCharsets.UTF_8);
                            postToServiceThread(() -> handleIncoming(envelope));
                        }
                    });
        } catch (Exception e) {
            onMqttSubscriptionFailed(mqttClient, generation, e);
        }
    }

    private void onMqttSubscriptionSucceeded(MqttAsyncClient mqttClient, int generation) {
        if (generation != mqttSubscriptionGeneration) return;
        mqttSubscriptionPending = false;
        if (!serviceActive || !running || client != mqttClient || !mqttClient.isConnected()) return;
        if (handler != null) handler.removeCallbacks(mqttSubscriptionRetryLoop);
        mqttSubscriptionRetryScheduled = false;
    }

    private void onMqttSubscriptionFailed(MqttAsyncClient mqttClient, int generation,
                                          Throwable error) {
        if (generation != mqttSubscriptionGeneration) return;
        mqttSubscriptionPending = false;
        if (!serviceActive || !running || client != mqttClient) return;
        Log.e(TAG, "subscribe failed", error);
        scheduleMqttSubscriptionRetry();
    }

    private void handleIncoming(String envelope) {
        if (!serviceActive) return;
        String json;
        try {
            json = crypto.decrypt(envelope);
        } catch (Exception e) {
            return; // 다른 팀 암호로 온 메시지. 조용히 버린다.
        }

        String type = TeamCrypto.extract(json, "type");

        // 화면이 꺼져 있는 동안 도착한 대원 위치도 모아 둔다.
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
        if (appForeground) return; // 웹 화면이 직접 알려 중복을 막는다

        showMessageNotification(sender == null || sender.isEmpty() ? "대원" : sender, text);
    }

    /**
     * 최신이고 아직 안 보낸 위치만 전송한다.
     *
     * 예전 15초 loop 는 오래된 마지막 위치에 새 시각을 붙여 다시 보냈다. 화면 꺼짐 동안
     * 사용자가 이동했는데도 옛 자리에 계속 점이 쌓이고, GPS 복귀 때 긴 직선으로 튀는 원인이
     * 됐다. 이제 15초 넘은 위치는 보내지 않고, JSON ts 도 발행 시각이 아니라 fix 시각이다.
     */
    private synchronized void publishIfDue(boolean force) {
        if (!serviceActive || !running || !trackLocation || !locationRunning || !mqttReady) return;
        if (crypto == null || lastLocation == null || client == null) return;
        if (!client.isConnected()) return;
        if (locationAgeMillis(lastLocation) > MAX_FIX_AGE_MS) return;

        long now = System.currentTimeMillis();
        long fixNanos = lastLocation.getElapsedRealtimeNanos();
        if (!force && fixNanos > 0 && fixNanos <= lastPublishedFixElapsedNanos) return;
        if (!force && now - lastPublishedAt < PUBLISH_MIN_INTERVAL_MS) return;

        String alt = lastLocation.hasAltitude()
                ? String.valueOf(Math.round(lastLocation.getAltitude()))
                : "null";

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
                + "\"ts\":" + fixTimeMillis(lastLocation)
                + "}";

        try {
            MqttMessage message = new MqttMessage(
                    crypto.encrypt(json).getBytes(StandardCharsets.UTF_8));
            // 위치도 QoS 1 로 보낸다. 연결된 상태에서 한 점이 유실되는 일을 줄인다.
            // 중복 수신은 ts 와 필터가 제거한다.
            message.setQos(1);
            client.publish(crypto.topic(), message);
            lastPublishedAt = now;
            if (fixNanos > 0) lastPublishedFixElapsedNanos = fixNanos;
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

        NotificationChannel tracking = new NotificationChannel(CHANNEL_ID,
                getString(R.string.tracking_channel), NotificationManager.IMPORTANCE_LOW);
        tracking.setShowBadge(false);
        manager.createNotificationChannel(tracking);

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

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setContentIntent(contentIntent)
                .build();
    }

    private void startForegroundSafely(String text) {
        Notification notification = buildNotification(text);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            int type = trackLocation && hasLocationPermission()
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                    : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            startForeground(NOTIFICATION_ID, notification, type);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /** 위치 등록이 끝내 실패하면 Android 14의 location type도 메시지 전용으로 내린다. */
    private void downgradeLocationForeground(String text) {
        if (!serviceActive) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(NOTIFICATION_ID, buildNotification(text),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "foreground service type downgrade failed", e);
            }
        }
        updateNotification(text);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private String currentTrackingNotification() {
        if (!trackLocation) return getString(R.string.messaging_active);
        if (locationRunning && mqttReady && LOCATION_STATE_ACTIVE.equals(trackingState)) {
            return getString(R.string.tracking_active);
        }
        if (!hasLocationPermission()) return getString(R.string.tracking_no_permission);
        if (locationRunning && !mqttReady && !mqttConnecting) {
            return getString(R.string.tracking_offline);
        }
        if (mqttConnecting || (locationRequestPending && mqttReady)) {
            return getString(R.string.tracking_starting);
        }
        return getString(R.string.tracking_unavailable);
    }

    private void updateNotification(String text) {
        if (!serviceActive) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    // ---------- 정리 ----------

    /** Fused/LocationManager/loop/wake lock 을 한 번에, 여러 번 불러도 안전하게 정리한다. */
    private void stopLocationUpdates() {
        locationRequestGeneration++;

        LocationCallback active = activeFusedCallback;
        LocationCallback pending = pendingFusedCallback;
        activeFusedCallback = null;
        pendingFusedCallback = null;

        locationRequestPending = false;
        fusedUpdatesRegistered = false;
        platformUpdatesRegistered = false;
        locationRunning = false;
        trackingState = LOCATION_STATE_UNAVAILABLE;

        if (handler != null) {
            handler.removeCallbacks(publishLoop);
            publishLoopScheduled = false;
        }

        removeFusedCallback(active);
        if (pending != active) removeFusedCallback(pending);

        if (locationManager != null) {
            try {
                locationManager.removeUpdates(platformLocationListener);
            } catch (Exception ignored) {
                /* 등록되지 않은 경우 */
            }
        }

        releaseTrackingWakeLock();
    }

    private void cancelMqttRetries() {
        mqttSubscriptionGeneration++;
        mqttSubscriptionPending = false;
        mqttRetryScheduled = false;
        mqttSubscriptionRetryScheduled = false;
        if (handler != null) {
            handler.removeCallbacks(mqttReconnectLoop);
            handler.removeCallbacks(mqttSubscriptionRetryLoop);
        }
    }

    private void stopTracking() {
        serviceActive = false;
        running = false;
        trackLocation = false;
        mqttReady = false;
        mqttConnecting = false;
        cancelMqttRetries();
        stopLocationUpdates();

        if (client != null) {
            try {
                if (client.isConnected()) client.disconnectForcibly(500, 500);
                client.close();
            } catch (Exception ignored) {
                /* 이미 끊어진 경우 */
            }
            client = null;
        }

        crypto = null;
        lastLocation = null;
        lastPublishedAt = 0;
        lastPublishedFixElapsedNanos = 0;
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        // 시스템 종료와 명시적 종료 모두 같은 정리 경로를 지난다. 특히 wake lock 을 놓친
        // 경로가 하나라도 있으면 화면을 켤 때까지 CPU를 붙잡아 배터리를 소모한다.
        serviceActive = false;
        running = false;
        trackLocation = false;
        mqttReady = false;
        mqttConnecting = false;
        cancelMqttRetries();
        stopLocationUpdates();

        if (client != null) {
            try {
                if (client.isConnected()) client.disconnectForcibly(500, 500);
                client.close();
            } catch (Exception ignored) {
            }
            client = null;
        }
        crypto = null;
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
    // 앱이 뒤로 가면 웹 화면(자바스크립트)이 멈춘다. 서비스가 받은 위치를 여기에 모아 두고,
    // 웹 화면이 다시 앞으로 올 때 가져가 경로를 메꾼다.
    // 솎는 기준(5m / 4초)은 mission.js 와 같다.

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
        final long seq;

        Fix(String id, String name, double lat, double lng, double alt, int acc, long ts, long seq) {
            this.id = id;
            this.name = name;
            this.lat = lat;
            this.lng = lng;
            this.alt = alt;
            this.acc = acc;
            this.ts = ts;
            this.seq = seq;
        }
    }

    private static final java.util.ArrayDeque<Fix> trail = new java.util.ArrayDeque<>();
    private static final java.util.HashMap<String, Fix> trailLast = new java.util.HashMap<>();
    private static long trailSequence = 0;

    /** 위치 하나를 보관 대상으로 넣는다. 위치 callback과 MQTT 수신 스레드가 함께 부른다. */
    private static synchronized void remember(String id, String name,
                                              double lat, double lng, double alt, int acc, long ts) {
        if (id == null || id.isEmpty()) return;
        if (Double.isNaN(lat) || Double.isNaN(lng)) return;

        Fix prev = trailLast.get(id);
        if (prev != null && ts <= prev.ts) return;

        // 내 위치는 handleLocation 에서 이미 걸렀지만, 구버전 대원이 보낸 위치는 여기가
        // 첫 관문일 수 있다. 모든 경로가 똑같은 엄격한 필터를 지난다.
        if (!acceptFix(prev == null ? 0 : prev.lat, prev == null ? 0 : prev.lng,
                prev == null ? -1 : prev.acc, prev == null ? 0 : prev.ts,
                lat, lng, acc, ts)) {
            return;
        }

        if (prev != null) {
            boolean moved = metersBetween(prev.lat, prev.lng, lat, lng) >= TRAIL_MIN_DISTANCE_M;
            boolean waited = ts - prev.ts >= TRAIL_MIN_INTERVAL_MS;
            if (!moved && !waited) return;
        }

        Fix fix = new Fix(id, name == null ? "" : name, lat, lng, alt, acc, ts,
                ++trailSequence);
        trail.addLast(fix);
        trailLast.put(id, fix);
        while (trail.size() > TRAIL_MAX) trail.pollFirst();
    }

    /** 받은 위치 메시지에서 값을 뽑아 보관한다. */
    private void rememberIncoming(String json) {
        String senderId = TeamCrypto.extract(json, "id");
        if (senderId == null || senderId.equals(clientId)) return; // 내 것은 callback에서 이미 넣었다

        Double lat = asNumber(TeamCrypto.extract(json, "lat"));
        Double lng = asNumber(TeamCrypto.extract(json, "lng"));
        if (lat == null || lng == null) return;

        Double alt = asNumber(TeamCrypto.extract(json, "alt"));
        Double acc = asNumber(TeamCrypto.extract(json, "acc"));
        Double ts = asNumber(TeamCrypto.extract(json, "ts"));

        String name = TeamCrypto.extract(json, "name");
        long receivedAt = System.currentTimeMillis();
        long sourceTs = ts == null || Double.isNaN(ts) || Double.isInfinite(ts)
                ? receivedAt : (long) (double) ts;
        if (Math.abs(receivedAt - sourceTs) >= 24L * 60 * 60 * 1000) {
            sourceTs = receivedAt;
        }
        remember(senderId, name, lat, lng,
                alt == null ? Double.NaN : alt,
                acc == null ? -1 : (int) Math.round(acc),
                sourceTs);
    }

    /** 임무 시작 시각과 sequence를 같은 native lock에서 고정한다. */
    static synchronized String trailBoundary() {
        return "{\"seq\":" + trailSequence + ",\"at\":" + System.currentTimeMillis() + "}";
    }

    /** 현재 native 삽입 순서. 임무 시작 시 cursor로 잡아 이전 팀 경로를 제외한다. */
    static synchronized String trailCursor() {
        return String.valueOf(trailSequence);
    }

    /** 여러 기기의 wall-clock 차이와 무관하게 native 삽입 순서 이후만 돌려준다. */
    static synchronized String trailAfter(long sequence) {
        return trailJson(sequence, true);
    }

    /** 구버전 웹 호환용 timestamp 조회. v1.5.4 웹은 trailAfter를 사용한다. */
    static synchronized String trailSince(long since) {
        return trailJson(since, false);
    }

    private static String trailJson(long cursor, boolean bySequence) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('[');
        boolean first = true;
        for (Fix f : trail) {
            long value = bySequence ? f.seq : f.ts;
            if (value <= cursor) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"id\":\"").append(escape(f.id)).append("\",")
                    .append("\"name\":\"").append(escape(f.name)).append("\",")
                    .append("\"lat\":").append(round6(f.lat)).append(',')
                    .append("\"lng\":").append(round6(f.lng)).append(',')
                    .append("\"acc\":").append(f.acc <= 0 ? "null" : String.valueOf(f.acc)).append(',')
                    .append("\"alt\":")
                    .append(Double.isNaN(f.alt) ? "null" : String.valueOf(Math.round(f.alt)))
                    .append(",\"ts\":").append(f.ts)
                    .append(",\"seq\":").append(f.seq).append('}');
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
