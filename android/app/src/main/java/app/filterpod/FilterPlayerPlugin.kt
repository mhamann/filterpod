package app.filterpod

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Bridge to [PlaybackService].
 *
 * Deliberately thin: all playback state and the skip loop live in the service, because
 * the service outlives the WebView. This class only forwards commands and relays events.
 * Mirrors the `FilterPlayerPlugin` interface in src/platform/native/plugins.ts.
 */
@CapacitorPlugin(name = "FilterPlayer")
class FilterPlayerPlugin : Plugin(), PlaybackService.PlaybackListener {

    private fun service(): PlaybackService? = PlaybackService.instance

    /**
     * Runs [block] against the playback service, starting it only if needed.
     *
     * Only load() may start it. startService rather than startForegroundService: the
     * latter commits Android to killing the app unless a notification follows within
     * five seconds, and firing it from play() before anything was loaded did exactly
     * that. Media3 promotes the service to foreground itself once playback begins.
     */
    private fun withService(call: PluginCall, start: Boolean, block: (PlaybackService) -> Unit) {
        var running = service()
        if (running == null && start) {
            context.startService(Intent(context, PlaybackService::class.java))
            running = service()
        }
        if (running == null) {
            call.reject("playback service is not running")
            return
        }
        running.listener = this
        block(running)
        call.resolve()
    }

    @PluginMethod
    fun load(call: PluginCall) {
        /*
         * A storage key is resolved here, natively, in preference to any URL from the
         * web layer. Capacitor's Filesystem.getUri hands back a `_capacitor_file_`
         * localhost URL intended for the WebView; ExoPlayer cannot open it and reports
         * only "Source error". Resolving against filesDir keeps path handling on the
         * side that owns the files, the same way the transcriber does it.
         */
        val fileKey = call.getString("fileKey")
        val candidate = fileKey?.let { java.io.File(context.filesDir, "filterpod/$it") }
        val resolved = candidate
            ?.takeIf { it.exists() }
            ?.let { android.net.Uri.fromFile(it).toString() }

        android.util.Log.i(
            "FilterPod",
            "load resolve: fileKey=$fileKey path=${candidate?.path} " +
                "exists=${candidate?.exists()} -> ${if (resolved != null) "file" else "FALLBACK to url"}",
        )

        val url = resolved ?: call.getString("url")
        if (url == null) {
            call.reject("url or fileKey is required")
            return
        }
        val startAtMs = ((call.getDouble("startAtSec") ?: 0.0) * 1000).toLong()

        val request = PlaybackService.Companion.LoadRequest(
            url = url,
            title = call.getString("title") ?: "",
            artist = call.getString("artist") ?: "",
            artworkUrl = call.getString("artworkUrl"),
            startAtMs = startAtMs,
        )

        val running = service()
        if (running != null) {
            running.listener = this
            running.load(request.url, request.title, request.artist, request.artworkUrl, request.startAtMs)
        } else {
            // Park it: the service applies this in onCreate. Waiting here instead would
            // block the bridge thread on an asynchronous service start.
            PlaybackService.pendingLoad = request
            context.startService(Intent(context, PlaybackService::class.java))
        }
        call.resolve()
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val running = service()
        if (running == null) {
            // Still starting from a load issued moments ago; play once it is up.
            PlaybackService.pendingPlay = true
            call.resolve()
            return
        }
        running.listener = this
        running.play()
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) = withService(call, start = false) { it.pause() }

    @PluginMethod
    fun seek(call: PluginCall) {
        val positionMs = ((call.getDouble("positionSec") ?: 0.0) * 1000).toLong()
        withService(call, start = false) { it.seekTo(positionMs) }
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val rate = (call.getDouble("rate") ?: 1.0).toFloat()
        withService(call, start = false) { it.setRate(rate) }
    }

    @PluginMethod
    fun setSkipIncrements(call: PluginCall) {
        val backMs = ((call.getDouble("backSec") ?: 15.0) * 1000).toLong()
        val forwardMs = ((call.getDouble("forwardSec") ?: 30.0) * 1000).toLong()

        // Recorded even when the service is down: this is pushed during app startup,
        // long before anything is played, and it has to survive until the session is
        // built or the first notification would show the wrong numbers.
        PlaybackService.pendingSkipBackMs = backMs
        PlaybackService.pendingSkipForwardMs = forwardMs
        service()?.setSkipIncrements(backMs, forwardMs)
        call.resolve()
    }

    @PluginMethod
    fun setFilterSpans(call: PluginCall) {
        val array = call.getArray("spans")
        val spans = if (array == null) emptyList() else FilterSpan.fromJson(array)
        withService(call, start = false) { it.setSpans(spans) }
    }

    @PluginMethod
    fun release(call: PluginCall) {
        service()?.listener = null
        context.stopService(Intent(context, PlaybackService::class.java))
        call.resolve()
    }

    // --- events back to the web layer ---------------------------------------

    override fun onSkip(span: FilterSpan) {
        val payload = JSObject().put(
            "span",
            JSObject()
                .put("startSec", span.startMs / 1000.0)
                .put("endSec", span.endMs / 1000.0)
                .put("severity", span.severity)
                .put("category", span.category),
        )
        notifyListeners("skip", payload)
    }

    override fun onStatus(
        state: String,
        positionMs: Long,
        durationMs: Long,
        skippedMs: Long,
        bufferedMs: Long,
    ) {
        notifyListeners(
            "status",
            JSObject()
                .put("state", state)
                .put("positionSec", positionMs / 1000.0)
                .put("durationSec", durationMs / 1000.0)
                .put("skippedSec", skippedMs / 1000.0)
                .put("buffered", bufferedMs / 1000.0),
        )
    }
}
