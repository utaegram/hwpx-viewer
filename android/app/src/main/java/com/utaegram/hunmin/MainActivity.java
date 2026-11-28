package com.utaegram.hunmin;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/**
 * 훈민정음 — 웹앱(https://utaegram.github.io/hwpx-viewer/)을 WebView 로 감싼 안드로이드 앱.
 *
 * 다른 앱(파일 관리자·메일·메신저)에서 .hwp/.hwpx 를 열거나 공유하면 그 파일을 읽어
 * Base64 로 웹앱에 넘기고(window.openAndroidFile), 웹앱에서 [저장]하면 기기의
 * Downloads 폴더에 저장한다(AndroidBridge.saveFile).
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "https://utaegram.github.io/hwpx-viewer/";
    private static final String APP_HOST_PREFIX = "https://utaegram.github.io/hwpx-viewer";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_STORAGE_PERMISSION = 1002;

    /** evaluateJavascript 로 한 번에 넘기는 Base64 조각 크기 — 큰 문서도 안전하게 나눠 보낸다 */
    private static final int JS_CHUNK = 128 * 1024;

    private WebView webView;
    private boolean pageLoaded = false;

    private String pendingName;
    private String pendingBase64;

    private ValueCallback<Uri[]> filePathCallback;

    private String pendingSaveName;
    private String pendingSaveMime;
    private String pendingSaveBase64;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(Color.WHITE);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.WHITE);
        root.addView(webView);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageLoaded = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                /* 앱 화면이 실제로 떴을 때만 '준비됨'으로 본다.
                   오류 안내 화면에서는 기다리던 파일을 그대로 들고 있는다. */
                if (url != null && url.startsWith(APP_HOST_PREFIX)) {
                    pageLoaded = true;
                    deliverPendingFile();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                String host = uri.getHost() == null ? "" : uri.getHost();
                if (scheme.startsWith("http") && "utaegram.github.io".equals(host)) {
                    return false;   // 훈민정음 화면은 앱 안에서
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    toast("열 수 있는 앱이 없습니다");
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                pageLoaded = false;
                view.loadDataWithBaseURL(null, offlinePage(), "text/html", "UTF-8", null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/hwp+zip",
                        "application/hwpx+zip",
                        "application/x-hwp",
                        "application/haansofthwp",
                        "application/vnd.hancom.hwp",
                        "application/vnd.hancom.hwpx",
                        "application/octet-stream",
                        "application/zip",
                });
                try {
                    startActivityForResult(Intent.createChooser(intent, "한글 문서 선택"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        /* 예제 문서·APK 같은 내려받기 링크는 기본 브라우저(또는 다운로드 앱)로 넘긴다 */
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                toast("내려받을 수 있는 앱이 없습니다");
            }
        });

        handleIntent(getIntent());
        webView.loadUrl(APP_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /* ---------------- 다른 앱에서 넘어온 파일 받기 ---------------- */

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            Parcelable extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) uri = (Uri) extra;
            if (uri == null) uri = intent.getData();
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            try {
                ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null && !list.isEmpty() && list.get(0) instanceof Uri) {
                    uri = (Uri) list.get(0);   // 여러 개 중 첫 문서를 연다
                }
            } catch (Exception ignored) {
                /* 형식이 다르면 무시 */
            }
        }
        if (uri == null) return;
        readSharedFile(uri);
    }

    private void readSharedFile(final Uri uri) {
        final String name = queryDisplayName(uri);
        new Thread(() -> {
            try {
                byte[] bytes = readAll(uri);
                if (bytes == null || bytes.length == 0) {
                    toastMain("빈 파일이라 열 수 없습니다");
                    return;
                }
                final String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                mainHandler.post(() -> dispatchFile(name, base64));
            } catch (Throwable t) {
                toastMain("파일을 읽지 못했습니다: " + t.getMessage());
            }
        }).start();
    }

    private String queryDisplayName(Uri uri) {
        String name = null;
        if (uri != null && "content".equals(uri.getScheme())) {
            Cursor cursor = null;
            try {
                cursor = getContentResolver().query(
                        uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                if (cursor != null && cursor.moveToFirst()) {
                    int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) name = cursor.getString(idx);
                }
            } catch (Exception ignored) {
                /* 이름을 못 읽으면 경로에서 가져온다 */
            } finally {
                if (cursor != null) {
                    try {
                        cursor.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }
        if (name == null || name.trim().isEmpty()) {
            name = uri == null ? null : uri.getLastPathSegment();
        }
        if (name == null || name.trim().isEmpty()) {
            name = "document.hwpx";
        }
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        return name;
    }

    private byte[] readAll(Uri uri) throws IOException {
        ContentResolver resolver = getContentResolver();
        InputStream in = resolver.openInputStream(uri);
        if (in == null) throw new IOException("파일을 열지 못했습니다");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            try {
                in.close();
            } catch (Exception ignored) {
            }
        }
    }

    /* ---------------- 웹앱으로 파일 넘기기 ---------------- */

    private void dispatchFile(String fileName, String base64) {
        String name = fileName == null ? "" : fileName.trim();
        if (name.isEmpty()) name = "document.hwpx";
        if (!pageLoaded) {
            /* 페이지가 아직이면 받아 두었다가 onPageFinished 에서 넘긴다 */
            pendingName = name;
            pendingBase64 = base64;
            return;
        }
        webView.evaluateJavascript("window.__androidFileParts=[];", null);
        pushChunk(name, base64, 0);
    }

    /** Base64 를 잘라 순서대로 웹앱에 쌓고, 다 쌓이면 window.openAndroidFile 을 부른다 */
    private void pushChunk(final String name, final String base64, final int offset) {
        if (base64 == null || offset >= base64.length()) {
            finishAndroidFile(name);
            return;
        }
        String part = base64.substring(offset, Math.min(base64.length(), offset + JS_CHUNK));
        webView.evaluateJavascript(
                "window.__androidFileParts.push(" + jsQuote(part) + ");",
                value -> pushChunk(name, base64, offset + JS_CHUNK));
    }

    private void finishAndroidFile(String name) {
        String quoted = jsQuote(name);
        String js = "(function(){try{"
                + "var d=(window.__androidFileParts||[]).join('');window.__androidFileParts=[];"
                + "if(typeof window.openAndroidFile==='function'){window.openAndroidFile(" + quoted + ",d);}"
                + "else{window.__pendingAndroidFile={fileName:" + quoted + ",base64:d};}"
                + "}catch(e){}})();";
        webView.evaluateJavascript(js, null);
    }

    private void deliverPendingFile() {
        if (pendingBase64 == null) return;
        String name = pendingName;
        String data = pendingBase64;
        pendingName = null;
        pendingBase64 = null;
        dispatchFile(name, data);
    }

    private String jsQuote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 16);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\':
                    b.append("\\\\");
                    break;
                case '"':
                    b.append("\\\"");
                    break;
                case '\n':
                    b.append("\\n");
                    break;
                case '\r':
                    b.append("\\r");
                    break;
                case '\t':
                    b.append("\\t");
                    break;
                case '\u2028':
                    b.append("\\u2028");
                    break;
                case '\u2029':
                    b.append("\\u2029");
                    break;
                default:
                    b.append(c);
            }
        }
        b.append('"');
        return b.toString();
    }

    /* ---------------- 웹앱 [저장] → 기기 Downloads 폴더 ---------------- */

    private class AndroidBridge {
        @JavascriptInterface
        public String saveFile(String fileName, String mimeType, String base64) {
            final String name = sanitizeName(fileName);
            final String mime = (mimeType == null || mimeType.trim().isEmpty())
                    ? "application/octet-stream" : mimeType.trim();
            if (Build.VERSION.SDK_INT < 29
                    && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                pendingSaveName = name;
                pendingSaveMime = mime;
                pendingSaveBase64 = base64;
                mainHandler.post(() -> requestPermissions(
                        new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        REQ_STORAGE_PERMISSION));
                return name;
            }
            startSave(name, mime, base64);
            return name;
        }
    }

    private void startSave(final String name, final String mime, final String base64) {
        new Thread(() -> {
            try {
                byte[] bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
                if (bytes.length == 0) throw new IOException("내용이 비어 있습니다");
                String saved = writeToDownloads(name, mime, bytes);
                toastMain("저장 완료 · Downloads/" + saved);
            } catch (Throwable t) {
                toastMain("저장하지 못했습니다: " + t.getMessage());
            }
        }).start();
    }

    private String writeToDownloads(String fileName, String mimeType, byte[] bytes) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (item == null) throw new IOException("Downloads 폴더에 자리를 만들지 못했습니다");
            try {
                OutputStream out = resolver.openOutputStream(item);
                if (out == null) throw new IOException("파일을 열지 못했습니다");
                try {
                    out.write(bytes);
                    out.flush();
                } finally {
                    try {
                        out.close();
                    } catch (Exception ignored) {
                    }
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(item, done, null, null);
            } catch (IOException e) {
                try {
                    resolver.delete(item, null, null);
                } catch (Exception ignored) {
                }
                throw e;
            }
            return fileName;
        }

        /* 안드로이드 9 이하: 공용 Downloads 폴더에 직접 쓴다 */
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new IOException("Downloads 폴더를 찾지 못했습니다");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Downloads 폴더를 만들지 못했습니다");
        File target = uniqueFile(dir, fileName);
        FileOutputStream out = new FileOutputStream(target);
        try {
            out.write(bytes);
            out.flush();
        } finally {
            try {
                out.close();
            } catch (Exception ignored) {
            }
        }
        try {
            sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(target)));
        } catch (Exception ignored) {
        }
        return target.getName();
    }

    private File uniqueFile(File dir, String fileName) {
        File first = new File(dir, fileName);
        if (!first.exists()) return first;
        int dot = fileName.lastIndexOf('.');
        String base = dot > 0 ? fileName.substring(0, dot) : fileName;
        String ext = dot > 0 ? fileName.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            File candidate = new File(dir, base + " (" + i + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private String sanitizeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (n.isEmpty()) n = "document.hwpx";
        if (n.length() > 120) {
            int dot = n.lastIndexOf('.');
            String ext = dot > 0 ? n.substring(dot) : "";
            n = n.substring(0, Math.min(120, dot > 0 ? dot : n.length())) + ext;
        }
        return n;
    }

    /* ---------------- 그 밖 ---------------- */

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_STORAGE_PERMISSION) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (pendingSaveBase64 != null) {
                startSave(pendingSaveName, pendingSaveMime, pendingSaveBase64);
            }
        } else {
            toast("저장 권한이 없어 Downloads 폴더에 저장하지 못했습니다");
        }
        pendingSaveName = null;
        pendingSaveMime = null;
        pendingSaveBase64 = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                webView.removeJavascriptInterface("AndroidBridge");
                webView.loadUrl("about:blank");
                webView.destroy();
            } catch (Exception ignored) {
            }
            webView = null;
        }
        super.onDestroy();
    }

    private String offlinePage() {
        return "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                + "<style>body{font-family:sans-serif;margin:0;padding:48px 24px;text-align:center;color:#1f2937}"
                + "h1{font-size:20px}p{color:#6b7280;line-height:1.6}a{display:inline-block;margin-top:20px;"
                + "background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px}</style>"
                + "</head><body><h1>훈민정음</h1>"
                + "<p>문서 편집 화면을 불러오지 못했습니다.<br>인터넷 연결을 확인한 뒤 다시 시도해 주세요.</p>"
                + "<a href=\"" + APP_URL + "\">다시 시도</a></body></html>";
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private void toastMain(final String message) {
        mainHandler.post(() -> toast(message));
    }
}
