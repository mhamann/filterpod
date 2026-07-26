package app.filterpod;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate so the bridge sees them during initialization.
        registerPlugin(FilterPlayerPlugin.class);
        registerPlugin(DownloaderPlugin.class);
        registerPlugin(TranscriberPlugin.class);

        evictServiceWorker();

        super.onCreate(savedInstanceState);
    }

    /**
     * Deletes any service worker the WebView has cached, before the WebView starts.
     *
     * Packaged builds no longer register one, but a device that ran an earlier APK still
     * has it installed and serving a cached app shell — so a freshly installed APK keeps
     * executing the previous bundle. This cannot be fixed from JavaScript: the eviction
     * code would live in the very bundle the stale worker is preventing from loading.
     * Hence doing it natively, from outside the WebView.
     *
     * Deliberately narrow — only the Service Worker directory. IndexedDB and
     * localStorage hold subscriptions, progress and download records, and must survive.
     */
    private void evictServiceWorker() {
        // The directory sits under a profile folder ("Default"), not directly under
        // app_webview — an earlier version of this looked only at the latter, found
        // nothing, and wrongly cleared the WebView of suspicion. Both are checked, and
        // any profile folder is scanned, since the layout is a Chromium detail that can
        // move between WebView versions.
        File webview = new File(getFilesDir().getParentFile(), "app_webview");
        if (!webview.exists()) return;

        evictAt(new File(webview, "Service Worker"));
        File[] profiles = webview.listFiles();
        if (profiles != null) {
            for (File profile : profiles) {
                if (profile.isDirectory()) evictAt(new File(profile, "Service Worker"));
            }
        }
    }

    private void evictAt(File dir) {
        if (!dir.exists()) return;
        boolean removed = deleteRecursively(dir);
        Log.i("FilterPod", "evicted stale service worker cache at " + dir.getPath() + ": " + removed);
    }

    private boolean deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        return file.delete();
    }
}
