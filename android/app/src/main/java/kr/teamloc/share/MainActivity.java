package kr.teamloc.share;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * 웹 화면을 담는 껍데기.
 *
 * 화면 안의 지도/메모/임무 기능은 전부 웹 코드가 그대로 처리한다. 네이티브가 하는 일은 셋뿐이다.
 *   1. 위치·카메라 권한을 안드로이드에서 받아 WebView 에 넘겨준다
 *   2. 파일 선택(사진/동영상 첨부)을 중개한다
 *   3. 화면이 꺼져도 위치가 계속 올라가도록 TrackerService 를 켜고 끈다
 *   4. 웹이 만든 파일(임무 영상, 임무 기록)을 다운로드 폴더에 써 준다
 *
 * 웹 코드는 window.AndroidBridge 가 있는지 보고 백그라운드 추적 UI 를 노출한다.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "MainActivity";
    private static final int REQ_PERMISSIONS = 100;
    private static final int REQ_BACKGROUND_LOCATION = 101;
    private static final int REQ_FILE_CHOOSER = 102;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;

    // 웹이 조각으로 넘기는 파일을 받아 쓰는 중인 대상.
    private OutputStream pendingOut;
    private Uri pendingUri;          // MediaStore 로 만든 항목 (API 29+)
    private File pendingLegacyFile;  // 그 이하에서 직접 쓰는 파일
    private String pendingFileName;
    private long pendingBytes;

    // 웹이 넘겨준 팀 자격 정보. 메모리에만 둔다(저장하지 않는다).
    private String pendingTeam;
    private String pendingSecret;
    private String pendingCallsign;
    private String pendingClientId;
    private String pendingBroker;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // localStorage / IndexedDB
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // 우리 사이트는 앱 안에서, 나머지 링크는 기본 브라우저로 넘긴다.
                if (url.getHost() != null && url.getHost().equals(Uri.parse(getString(R.string.launch_url)).getHost())) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback callback) {
                boolean granted = ContextCompat.checkSelfPermission(MainActivity.this,
                        Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                callback.invoke(origin, granted, false);
                if (!granted) requestBasicPermissions();
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 카메라/마이크 요청은 앱 권한이 있으면 바로 허용한다.
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        boolean cameraOk = ContextCompat.checkSelfPermission(MainActivity.this,
                                Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                        if (cameraOk) {
                            request.grant(request.getResources());
                        } else {
                            request.deny();
                            requestBasicPermissions();
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;

                try {
                    startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, R.string.file_chooser_failed,
                            Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        // WebView 는 다운로드를 스스로 처리하지 않는다. 리스너가 없으면 a[download] 클릭이
        // 조용히 무시된다. blob: 는 네이티브에서 열 수 없으므로 웹이 AndroidBridge 로 직접
        // 넘기게 하고, 여기서는 일반 http 링크만 브라우저에 맡긴다.
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                if (url == null) return;
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // 웹 코드가 AndroidBridge 경로로 저장하므로 여기서는 할 일이 없다.
                    Log.d(TAG, "blob/data 다운로드는 AndroidBridge 가 처리한다");
                    return;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, R.string.save_failed, Toast.LENGTH_SHORT).show();
                }
            }
        });

        requestBasicPermissions();

        if (savedInstanceState == null) {
            webView.loadUrl(getString(R.string.launch_url));
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    // ---------- 권한 ----------

    private void requestBasicPermissions() {
        java.util.List<String> need = new java.util.ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.CAMERA);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        // 안드로이드 9 이하에서만 다운로드 폴더에 쓰기 권한이 필요하다.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }

        if (!need.isEmpty()) {
            ActivityCompat.requestPermissions(this, need.toArray(new String[0]), REQ_PERMISSIONS);
        }
    }

    /**
     * 화면이 꺼진 상태의 추적에는 "항상 허용" 위치 권한이 필요하다.
     * 안드로이드 규칙상 기본 위치 권한을 먼저 받은 뒤 따로 요청해야 한다.
     */
    private boolean ensureBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
            return true;
        }

        Toast.makeText(this, R.string.need_background_location, Toast.LENGTH_LONG).show();
        ActivityCompat.requestPermissions(this,
                new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                REQ_BACKGROUND_LOCATION);
        return false;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);

        if (requestCode == REQ_BACKGROUND_LOCATION && results.length > 0
                && results[0] == PackageManager.PERMISSION_GRANTED) {
            // 권한을 받은 뒤 보류해 둔 요청을 이어서 실행한다.
            startService(true);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---------- 백그라운드 추적 ----------

    /**
     * 서비스를 시작한다.
     * @param withLocation true 면 위치까지 올린다. false 면 메시지 수신만 한다.
     */
    private void startService(boolean withLocation) {
        if (pendingTeam == null || pendingSecret == null || pendingClientId == null) return;
        if (withLocation && !ensureBackgroundLocation()) return;

        Intent intent = new Intent(this, TrackerService.class)
                .setAction(TrackerService.ACTION_START)
                .putExtra("team", pendingTeam)
                .putExtra("secret", pendingSecret)
                .putExtra("callsign", pendingCallsign)
                .putExtra("clientId", pendingClientId)
                .putExtra("broker", pendingBroker)
                .putExtra("trackLocation", withLocation);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    // ---------- 파일 저장 ----------

    /**
     * 다운로드 폴더에 쓰기 시작한다.
     *
     * API 29 부터는 MediaStore 에 항목을 만들어 쓰므로 저장 권한이 필요 없다.
     * 그 이하에서는 공용 Downloads 폴더에 직접 쓰고 WRITE_EXTERNAL_STORAGE 가 필요하다.
     */
    private synchronized boolean openForWrite(String fileName, String mime) {
        closeQuietly(true);

        String safe = sanitizeFileName(fileName);
        if (safe.isEmpty()) return false;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                values.put(MediaStore.Downloads.MIME_TYPE,
                        mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                pendingUri = getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (pendingUri == null) return false;
                pendingOut = getContentResolver().openOutputStream(pendingUri);
            } else {
                if (ContextCompat.checkSelfPermission(this,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(this,
                            new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERMISSIONS);
                    return false;
                }
                File dir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) return false;
                pendingLegacyFile = uniqueFile(dir, safe);
                pendingOut = new FileOutputStream(pendingLegacyFile);
            }

            if (pendingOut == null) return false;
            pendingFileName = safe;
            pendingBytes = 0;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "파일 저장 시작 실패", e);
            closeQuietly(true);
            return false;
        }
    }

    private synchronized boolean writeChunk(String base64) {
        if (pendingOut == null || base64 == null) return false;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            pendingOut.write(bytes);
            pendingBytes += bytes.length;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "파일 조각 쓰기 실패", e);
            closeQuietly(true);
            return false;
        }
    }

    private synchronized boolean finishWrite() {
        if (pendingOut == null) return false;

        final String name = pendingFileName;
        final long size = pendingBytes;

        try {
            pendingOut.flush();
            pendingOut.close();
        } catch (Exception e) {
            Log.w(TAG, "파일 닫기 실패", e);
            closeQuietly(true);
            return false;
        }
        pendingOut = null;

        if (pendingUri != null) {
            // IS_PENDING 을 내려야 다른 앱과 파일 관리자에서 보인다.
            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            try {
                getContentResolver().update(pendingUri, done, null, null);
            } catch (Exception e) {
                Log.w(TAG, "IS_PENDING 해제 실패", e);
            }
            pendingUri = null;
        }
        pendingLegacyFile = null;
        pendingFileName = null;
        pendingBytes = 0;

        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this,
                        getString(R.string.saved_to_downloads, name, size / 1024),
                        Toast.LENGTH_LONG).show();
            }
        });
        return size > 0;
    }

    /** 실패했거나 중간에 끊긴 저장을 정리한다. deleteTarget 이면 만들던 파일도 지운다. */
    private synchronized void closeQuietly(boolean deleteTarget) {
        if (pendingOut != null) {
            try {
                pendingOut.close();
            } catch (Exception ignored) {
                /* 이미 닫힌 경우 */
            }
            pendingOut = null;
        }
        if (deleteTarget) {
            if (pendingUri != null) {
                try {
                    getContentResolver().delete(pendingUri, null, null);
                } catch (Exception ignored) {
                    /* 이미 지워진 경우 */
                }
            }
            if (pendingLegacyFile != null && pendingLegacyFile.exists()) {
                // 반쪽짜리 파일을 남기지 않는다.
                if (!pendingLegacyFile.delete()) Log.w(TAG, "임시 파일 삭제 실패");
            }
        }
        pendingUri = null;
        pendingLegacyFile = null;
        pendingFileName = null;
        pendingBytes = 0;
    }

    /** 경로 조작과 못 쓰는 문자를 막는다. 웹에서 온 이름은 믿지 않는다. */
    private static String sanitizeFileName(String name) {
        if (name == null) return "";
        String base = name.replace("\\", "/");
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9가-힣._ -]", "_").trim();
        while (base.startsWith(".")) base = base.substring(1);
        if (base.length() > 100) base = base.substring(base.length() - 100);
        return base;
    }

    /** 같은 이름이 있으면 뒤에 번호를 붙인다. */
    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        if (!file.exists()) return file;

        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(dir, stem + "(" + i + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return file;
    }

    /** 웹 코드가 호출하는 다리. */
    private class Bridge {

        @JavascriptInterface
        public boolean available() {
            return true;
        }

        // ---------- 파일 저장 ----------
        // 웹은 blob 을 512KB 조각으로 잘라 base64 로 넘긴다. 거대한 문자열 하나를 넘기면
        // 기기 메모리가 버티지 못하기 때문이다.

        @JavascriptInterface
        public boolean canSaveFile() {
            return true;
        }

        @JavascriptInterface
        public boolean beginFile(String fileName, String mime) {
            return openForWrite(fileName, mime);
        }

        @JavascriptInterface
        public boolean appendFile(String base64) {
            return writeChunk(base64);
        }

        @JavascriptInterface
        public boolean endFile() {
            return finishWrite();
        }

        @JavascriptInterface
        public void abortFile() {
            closeQuietly(true);
        }

        private void remember(String team, String secret, String callsign,
                             String clientId, String broker) {
            pendingTeam = team;
            pendingSecret = secret;
            pendingCallsign = callsign;
            pendingClientId = clientId;
            pendingBroker = broker;
        }

        /**
         * 메시지 수신만 시작한다. 팀에 입장하면 웹이 곧바로 호출한다.
         * 이게 켜져 있어야 앱을 보고 있지 않을 때도 메시지 팝업이 뜬다.
         * 위치 권한은 필요하지 않다.
         */
        @JavascriptInterface
        public void startMessaging(String team, String secret, String callsign,
                                   String clientId, String broker) {
            remember(team, secret, callsign, clientId, broker);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startService(false);
                }
            });
        }

        /**
         * 화면이 꺼져도 위치를 올리도록 위치 추적까지 켠다.
         * 웹에서 넘기는 값: team, secret, callsign, clientId, broker
         */
        @JavascriptInterface
        public void startTracking(String team, String secret, String callsign,
                                  String clientId, String broker) {
            remember(team, secret, callsign, clientId, broker);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startService(true);
                }
            });
        }

        /** 위치 추적만 끈다. 메시지 수신은 유지한다. */
        @JavascriptInterface
        public void stopTracking() {
            Intent intent = new Intent(MainActivity.this, TrackerService.class)
                    .setAction(TrackerService.ACTION_STOP_LOCATION);
            MainActivity.this.startService(intent);
        }

        /** 팀에서 나갈 때. 메시지 수신까지 완전히 종료한다. */
        @JavascriptInterface
        public void stopAll() {
            pendingTeam = null;
            pendingSecret = null;
            Intent intent = new Intent(MainActivity.this, TrackerService.class)
                    .setAction(TrackerService.ACTION_STOP);
            MainActivity.this.startService(intent);
        }

        @JavascriptInterface
        public boolean isTracking() {
            return TrackerService.isTrackingLocation();
        }

        /** 메시지 수신 서비스가 돌고 있는지. */
        @JavascriptInterface
        public boolean isMessaging() {
            return TrackerService.isRunning();
        }

        /**
         * 메시지 도착 진동. 웹의 navigator.vibrate 가 막히는 기기가 있어
         * 네이티브로 한 번 더 확실히 울린다. 알람을 끈 경우 웹이 호출하지 않는다.
         */
        @JavascriptInterface
        public void notifyMessage(String sender, String text) {
            Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;

            long[] pattern = {0, 220, 120, 320};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
            } else {
                vibrator.vibrate(pattern, -1);
            }
        }
    }

    // ---------- 생명주기 ----------

    @Override
    protected void onResume() {
        super.onResume();
        // 화면을 보고 있는 동안에는 서비스가 알림 팝업을 띄우지 않게 한다.
        TrackerService.appForeground = true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        TrackerService.appForeground = false;
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        // 저장 중에 화면이 사라지면 반쪽 파일이 남는다.
        closeQuietly(true);
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
        }
        super.onDestroy();
    }
}
