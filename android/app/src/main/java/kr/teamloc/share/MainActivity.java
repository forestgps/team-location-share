package kr.teamloc.share;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
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
import java.io.InputStream;
import java.io.OutputStream;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

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

    // 즉석 촬영 결과를 받을 임시 파일. 카메라 앱은 결과 Intent 가 아니라 이 파일에 쓴다.
    private File captureFile;
    private Uri captureUri;

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
        // 파일 첨부(input type=file)로 고른 사진·동영상을 WebView 가 읽을 수 있어야 한다.
        // 갤러리에 따라 content:// 가 아니라 file:// 를 돌려주는 기기가 있어서, 둘을 막아 두면
        // 파일이 0바이트로 넘어오거나 첨부가 조용히 실패한다.
        // 페이지는 원격 https 라서 스킴이 달라 파일을 스스로 열 수는 없다.
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
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

            /**
             * 메모 첨부용 파일 선택.
             *
             * 규칙이 하나 있다. 한 번 받은 callback 은 반드시 값을 돌려줘야 한다.
             * 그냥 버리면 WebView 가 그 input 을 계속 "선택 중"으로 여겨서, 그다음부터는
             * 첨부 버튼을 눌러도 아무 반응이 없다. 첨부가 안 되는 가장 흔한 원인이었다.
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                discardCapture();
                fileCallback = callback;

                boolean video = wantsVideo(params);
                Intent content = buildContentIntent(params);
                Intent capture = buildCaptureIntent(video);

                // 갤러리 선택 + 즉석 촬영을 한 화면에 같이 띄운다.
                Intent chooser = new Intent(Intent.ACTION_CHOOSER)
                        .putExtra(Intent.EXTRA_INTENT, content)
                        .putExtra(Intent.EXTRA_TITLE,
                                getString(video ? R.string.pick_video : R.string.pick_photo));
                if (capture != null) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{capture});
                }

                if (launchChooser(chooser)) return true;
                // 기기에 따라 ACTION_CHOOSER 가 막히면 선택기를 직접 띄운다.
                if (launchChooser(content)) return true;
                if (launchChooser(openDocumentFallback(content))) return true;

                // 하나도 열지 못했다. 반드시 결과를 돌려주고 끝낸다.
                discardCapture();
                fileCallback.onReceiveValue(null);
                fileCallback = null;
                Toast.makeText(MainActivity.this, R.string.file_chooser_failed,
                        Toast.LENGTH_LONG).show();
                return true;
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

        // 새 버전이 있는지 조용히 확인한다. 6시간에 한 번만 물어본다.
        UpdateManager.check(this, false);
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

    // ---------- 파일 선택 ----------

    /** 웹이 요청한 accept 이 동영상인지. 사진/동영상 버튼을 구분하는 데 쓴다. */
    private static boolean wantsVideo(WebChromeClient.FileChooserParams params) {
        String[] accepts = params == null ? null : params.getAcceptTypes();
        if (accepts == null) return false;
        for (String accept : accepts) {
            if (accept == null) continue;
            String value = accept.toLowerCase(java.util.Locale.US);
            if (value.contains("video") || value.endsWith(".mp4") || value.endsWith(".mov")) return true;
        }
        return false;
    }

    /**
     * 갤러리/파일 선택 인텐트.
     *
     * WebView 의 params.createIntent() 를 쓰지 않는다. accept 목록에 확장자가 섞여 있으면
     * 종류를 "*\/*" 로 바꾸고 EXTRA_MIME_TYPES 를 덧붙이는데, 그 조합에서 갤러리가 사진을
     * 고를 수 없게 되는 기기가 있다. 우리가 필요한 것은 사진 아니면 동영상 하나뿐이라
     * 직접 단순하게 만든다.
     */
    private Intent buildContentIntent(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT)
                .setType(wantsVideo(params) ? "video/*" : "image/*")
                .addCategory(Intent.CATEGORY_OPENABLE);

        if (params != null && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        return intent;
    }

    /** 마지막 수단. 문서 선택기는 어느 기기에나 있다. */
    private static Intent openDocumentFallback(Intent content) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(content.getType() == null ? "*/*" : content.getType());
        if (content.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        return intent;
    }

    /**
     * 즉석 촬영 인텐트. 사진을 찍어 바로 첨부할 수 있게 선택 화면에 함께 올린다.
     * 카메라 앱은 우리가 만든 파일에 결과를 쓰므로 FileProvider 로 주소를 내준다.
     */
    @Nullable
    private Intent buildCaptureIntent(boolean video) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            return null;
        }

        try {
            File dir = new File(getCacheDir(), "captures");
            if (!dir.exists() && !dir.mkdirs()) return null;

            File file = new File(dir,
                    (video ? "video-" : "photo-") + System.currentTimeMillis() + (video ? ".mp4" : ".jpg"));
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);

            Intent intent = new Intent(video ? MediaStore.ACTION_VIDEO_CAPTURE
                    : MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

            if (intent.resolveActivity(getPackageManager()) == null) return null;

            captureFile = file;
            captureUri = uri;
            return intent;
        } catch (Exception e) {
            Log.w(TAG, "촬영 인텐트 준비 실패", e);
            discardCapture();
            return null;
        }
    }

    private boolean launchChooser(Intent intent) {
        if (intent == null) return false;
        try {
            startActivityForResult(intent, REQ_FILE_CHOOSER);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "선택 화면을 열 수 없음: " + intent.getAction(), e);
            return false;
        }
    }

    /** 쓰지 않은 촬영 파일을 지운다. 캐시에 빈 파일이 쌓이지 않게. */
    private void discardCapture() {
        if (captureFile != null && captureFile.exists() && !captureFile.delete()) {
            Log.w(TAG, "촬영 임시 파일 삭제 실패");
        }
        captureFile = null;
        captureUri = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (resultCode != RESULT_OK) {
                discardCapture();
                finishFileChooser(null);
                return;
            }

            boolean fromPicker = data != null && (data.getData() != null || data.getClipData() != null);

            if (fromPicker) {
                final Uri[] picked = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                if (picked == null || picked.length == 0) {
                    finishFileChooser(null);
                    return;
                }

                // 갤러리 주소를 그대로 넘기면 읽지 못하는 기기가 있어 사본을 만든다.
                // 큰 동영상이면 시간이 걸리므로 화면을 붙잡지 않도록 딴 스레드에서 한다.
                final ValueCallback<Uri[]> pending = fileCallback;
                fileCallback = null;
                if (pending == null) return;

                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        final Uri[] copies = localCopies(picked);
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                pending.onReceiveValue(copies);
                            }
                        });
                    }
                }, "attach-copy").start();
                return;
            }

            // 카메라로 찍은 경우다. 결과 Intent 가 비어 있고 파일에만 들어 있다.
            if (captureUri != null && captureFile != null && captureFile.length() > 0) {
                Uri[] shot = new Uri[]{captureUri};
                captureFile = null; // 웹이 읽어간 뒤 다음 요청에서 정리한다
                finishFileChooser(shot);
            } else {
                discardCapture();
                finishFileChooser(null);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 파일 선택 결과를 웹에 돌려준다. null 이라도 반드시 한 번은 불러야 한다. */
    private void finishFileChooser(@Nullable Uri[] result) {
        if (fileCallback == null) return;
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /**
     * 갤러리가 돌려준 주소를 앱 캐시로 복사하고 우리 FileProvider 주소로 바꿔 준다.
     *
     * 왜 복사하나. 갤러리마다 돌려주는 주소의 성격이 다르다(content:// / file:// / 미디어
     * 문서 주소). 어떤 조합에서는 WebView 가 그 파일을 읽지 못해 첨부가 0바이트로 끝난다.
     * 촬영 경로는 우리가 만든 파일을 넘겨서 잘 동작했으므로, 갤러리도 같은 모양으로
     * 맞춰 주면 기기별 차이가 사라진다.
     *
     * 복사에 실패하면 원래 주소를 그대로 돌려준다(지금보다 나빠지지 않게).
     */
    private Uri[] localCopies(Uri[] picked) {
        File dir = new File(getCacheDir(), "picked");
        cleanOldFiles(dir, 60 * 60 * 1000L); // 한 시간 지난 사본은 지운다
        if (!dir.exists() && !dir.mkdirs()) return picked;

        Uri[] out = new Uri[picked.length];
        for (int i = 0; i < picked.length; i++) {
            out[i] = copyToCache(dir, picked[i]);
            if (out[i] == null) out[i] = picked[i];
        }
        return out;
    }

    @Nullable
    private Uri copyToCache(File dir, Uri source) {
        if (source == null) return null;
        // 아주 큰 동영상은 사본을 만들지 않는다. 캐시를 두 배로 쓰는 값이 크다.
        if (sizeOf(source) > 64L * 1024 * 1024) return null;

        InputStream in = null;
        OutputStream out = null;
        File target = null;
        try {
            in = getContentResolver().openInputStream(source);
            if (in == null) return null;

            target = new File(dir, System.currentTimeMillis() + "-" + displayNameOf(source));
            out = new FileOutputStream(target);

            byte[] buffer = new byte[64 * 1024];
            int read;
            long total = 0;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                total += read;
            }
            out.flush();

            if (total == 0) {
                if (!target.delete()) Log.w(TAG, "빈 사본 삭제 실패");
                return null;
            }
            return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", target);
        } catch (Exception e) {
            Log.w(TAG, "고른 파일 복사 실패", e);
            if (target != null && target.exists() && !target.delete()) {
                Log.w(TAG, "실패한 사본 삭제 실패");
            }
            return null;
        } finally {
            closeSilently(in);
            closeSilently(out);
        }
    }

    /** 파일 크기. 알 수 없으면 0 을 돌려준다. */
    private long sizeOf(Uri source) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(source,
                    new String[]{OpenableColumns.SIZE}, null, null, null);
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getLong(0);
            }
        } catch (Exception e) {
            Log.w(TAG, "크기를 읽을 수 없음", e);
        } finally {
            if (cursor != null) cursor.close();
        }
        return 0;
    }

    /** 첨부 목록에 뜰 이름. 확장자가 있어야 WebView 가 종류를 제대로 잡는다. */
    private String displayNameOf(Uri source) {
        String name = null;
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(source,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                name = cursor.getString(0);
            }
        } catch (Exception e) {
            Log.w(TAG, "이름을 읽을 수 없음", e);
        } finally {
            if (cursor != null) cursor.close();
        }

        if (name == null || name.trim().isEmpty()) name = source.getLastPathSegment();
        name = sanitizeFileName(name);

        if (name.isEmpty() || name.lastIndexOf('.') <= 0) {
            String mime = getContentResolver().getType(source);
            String ext = mime == null ? null
                    : MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (ext == null) ext = "jpg";
            if (name.isEmpty()) name = "attachment";
            name = name + "." + ext;
        }
        return name;
    }

    private static void cleanOldFiles(File dir, long maxAgeMillis) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - maxAgeMillis;
        for (File file : files) {
            if (file.lastModified() < cutoff && !file.delete()) {
                Log.w(TAG, "오래된 사본 삭제 실패: " + file.getName());
            }
        }
    }

    private static void closeSilently(@Nullable java.io.Closeable target) {
        if (target == null) return;
        try {
            target.close();
        } catch (Exception ignored) {
            /* 이미 닫힘 */
        }
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
        /**
         * 새 버전을 지금 확인한다. 웹의 "업데이트 확인" 버튼이 부른다.
         * 최신이면 최신이라고 알려 준다(자동 확인은 조용히 지나간다).
         */
        @JavascriptInterface
        public void checkUpdate() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    UpdateManager.check(MainActivity.this, true);
                }
            });
        }

        /** 웹 화면에 표시할 앱 버전. */
        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

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
        // 며칠씩 켜 두는 기기도 있다. 돌아올 때마다 확인하되 시간 제한이 걸러 준다.
        UpdateManager.check(this, false);
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
        discardCapture();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
        }
        super.onDestroy();
    }
}
