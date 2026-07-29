package kr.teamloc.share;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 앱 스스로 새 버전을 찾아 내려받고 설치 화면까지 띄운다.
 *
 * 스토어에 올리지 않은 앱이라 플레이 스토어의 자동 업데이트를 쓸 수 없다. 대신 릴리스
 * 페이지를 직접 확인한다.
 *
 * 안드로이드 규칙상 일반 앱은 사용자 확인 없이 다른 앱(자기 자신 포함)을 설치할 수 없다.
 * 그래서 여기까지가 자동으로 되는 최대치다.
 *   1. 앱을 켤 때 새 버전이 있는지 조용히 확인한다(하루에 몇 번만)
 *   2. 있으면 물어보고, 허락하면 내려받는다
 *   3. 시스템 설치 화면을 띄운다. 사용자는 "업데이트"만 누르면 된다
 *
 * "알 수 없는 앱 설치" 권한은 처음 한 번만 허용하면 다음부터는 묻지 않는다.
 */
final class UpdateManager {

    private static final String TAG = "UpdateManager";

    // 최신 릴리스 정보. 태그 이름(v1.4.2)에서 버전을 읽는다.
    private static final String LATEST_API =
            "https://api.github.com/repos/forestgps/team-location-share/releases/latest";
    // 항상 최신 릴리스의 APK 를 가리키는 주소.
    private static final String APK_URL =
            "https://github.com/forestgps/team-location-share/releases/latest/download/team-location-share.apk";

    private static final String PREFS = "update";
    private static final String KEY_LAST_CHECK = "lastCheck";
    private static final long CHECK_INTERVAL = 6L * 60 * 60 * 1000; // 6시간
    private static final Pattern TAG_NAME = Pattern.compile("\"tag_name\"\\s*:\\s*\"v?([0-9][0-9.]*)\"");

    private static boolean working;

    private UpdateManager() {
    }

    /**
     * 새 버전을 확인한다.
     * @param force 사용자가 직접 눌렀을 때. 시간 제한을 무시하고 결과를 알려 준다.
     */
    static void check(final Activity activity, final boolean force) {
        if (activity == null || working) return;

        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long last = prefs.getLong(KEY_LAST_CHECK, 0);
        if (!force && System.currentTimeMillis() - last < CHECK_INTERVAL) return;

        working = true;
        prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();

        new Thread(new Runnable() {
            @Override
            public void run() {
                String latest = null;
                try {
                    latest = fetchLatestVersion();
                } catch (Exception e) {
                    Log.w(TAG, "새 버전 확인 실패", e);
                }

                final String remote = latest;
                final String current = currentVersion(activity);
                working = false;

                if (remote == null) {
                    if (force) toastOnUi(activity, activity.getString(R.string.update_check_failed));
                    return;
                }
                if (compare(remote, current) <= 0) {
                    if (force) {
                        toastOnUi(activity, activity.getString(R.string.update_up_to_date, current));
                    }
                    return;
                }

                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (activity.isFinishing()) return;
                        askToUpdate(activity, remote, current);
                    }
                });
            }
        }, "update-check").start();
    }

    // ---------- 확인 ----------

    private static String fetchLatestVersion() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(LATEST_API).openConnection();
        try {
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "team-location-share-app");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);

            if (connection.getResponseCode() != 200) return null;

            StringBuilder body = new StringBuilder();
            InputStream in = connection.getInputStream();
            byte[] buffer = new byte[8192];
            int read;
            // 응답이 커도 태그 이름은 앞부분에 있다. 32KB 만 읽는다.
            while ((read = in.read(buffer)) > 0 && body.length() < 32 * 1024) {
                body.append(new String(buffer, 0, read, "UTF-8"));
            }
            in.close();

            Matcher matcher = TAG_NAME.matcher(body);
            return matcher.find() ? matcher.group(1) : null;
        } finally {
            connection.disconnect();
        }
    }

    private static String currentVersion(Context context) {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /** 1.4.10 이 1.4.9 보다 크도록 마디별 숫자로 비교한다. */
    static int compare(String left, String right) {
        String[] a = String.valueOf(left).split("\\.");
        String[] b = String.valueOf(right).split("\\.");
        int length = Math.max(a.length, b.length);

        for (int i = 0; i < length; i++) {
            int x = i < a.length ? number(a[i]) : 0;
            int y = i < b.length ? number(b[i]) : 0;
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    private static int number(String text) {
        try {
            return Integer.parseInt(text.trim());
        } catch (Exception e) {
            return 0;
        }
    }

    // ---------- 내려받기와 설치 ----------

    private static void askToUpdate(final Activity activity, final String remote, String current) {
        new AlertDialog.Builder(activity)
                .setTitle(R.string.update_title)
                .setMessage(activity.getString(R.string.update_available, remote, current))
                .setPositiveButton(R.string.update_now, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        download(activity, remote);
                    }
                })
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private static void download(final Activity activity, final String version) {
        if (working) return;
        working = true;
        Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_LONG).show();

        new Thread(new Runnable() {
            @Override
            public void run() {
                File apk = null;
                try {
                    apk = downloadApk(activity, version);
                } catch (Exception e) {
                    Log.w(TAG, "업데이트 내려받기 실패", e);
                }
                working = false;

                final File file = apk;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (activity.isFinishing()) return;
                        if (file == null) {
                            Toast.makeText(activity, R.string.update_download_failed,
                                    Toast.LENGTH_LONG).show();
                            return;
                        }
                        install(activity, file);
                    }
                });
            }
        }, "update-download").start();
    }

    private static File downloadApk(Context context, String version) throws Exception {
        File dir = new File(context.getCacheDir(), "updates");
        clean(dir);
        if (!dir.exists() && !dir.mkdirs()) return null;

        File target = new File(dir, "team-location-share-" + version + ".apk");

        HttpURLConnection connection = (HttpURLConnection) new URL(APK_URL).openConnection();
        InputStream in = null;
        OutputStream out = null;
        try {
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "team-location-share-app");
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);

            if (connection.getResponseCode() != 200) return null;

            in = connection.getInputStream();
            out = new FileOutputStream(target);

            byte[] buffer = new byte[64 * 1024];
            int read;
            long total = 0;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                total += read;
            }
            out.flush();

            // 반쪽 파일을 설치 화면에 넘기지 않는다.
            if (total < 500 * 1024) {
                if (!target.delete()) Log.w(TAG, "반쪽 파일 삭제 실패");
                return null;
            }
            return target;
        } finally {
            closeSilently(in);
            closeSilently(out);
            connection.disconnect();
        }
    }

    private static void install(final Activity activity, File apk) {
        // 안드로이드 8 부터는 이 앱에 설치 권한이 한 번 허용돼 있어야 한다.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity)
                    .setTitle(R.string.update_title)
                    .setMessage(R.string.update_need_permission)
                    .setPositiveButton(R.string.update_open_settings, new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            try {
                                activity.startActivity(new Intent(
                                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                        Uri.parse("package:" + activity.getPackageName())));
                            } catch (Exception e) {
                                Toast.makeText(activity, R.string.update_download_failed,
                                        Toast.LENGTH_LONG).show();
                            }
                        }
                    })
                    .setNegativeButton(R.string.update_later, null)
                    .show();
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(activity,
                    activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "설치 화면을 열 수 없음", e);
            Toast.makeText(activity, R.string.update_download_failed, Toast.LENGTH_LONG).show();
        }
    }

    // ---------- 잡일 ----------

    private static void clean(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.delete()) Log.w(TAG, "예전 설치 파일 삭제 실패: " + file.getName());
        }
    }

    private static void closeSilently(java.io.Closeable target) {
        if (target == null) return;
        try {
            target.close();
        } catch (Exception ignored) {
            /* 이미 닫힘 */
        }
    }

    private static void toastOnUi(final Activity activity, final String text) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (activity.isFinishing()) return;
                Toast.makeText(activity, text, Toast.LENGTH_LONG).show();
            }
        });
    }
}
