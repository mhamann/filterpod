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
        // Streaming: start filling the cache now, so the transcriber is reading from disk
        // by the time it asks rather than fetching in MediaExtractor-sized pieces.
        if (resolved == null) MediaCache.prefetch(context, url)
        val startAtMs = ((call.getDouble("startAtSec") ?: 0.0) * 1000).toLong()

        val request = PlaybackService.Companion.LoadRequest(
            url = url,
            title = call.getString("title") ?: "",
            artist = call.getString("artist") ?: "",
            artworkUrl = call.getString("artworkUrl"),
            startAtMs = startAtMs,
            episodeId = call.getString("episodeId"),
        )

        val running = service()
        if (running != null) {
            running.listener = this
            running.load(request.url, request.title, request.artist, request.artworkUrl, request.startAtMs, request.episodeId)
        } else {
            // Park it: the service applies this in onCreate. Waiting here instead would
            // block the bridge thread on an asynchronous service start.
            PlaybackService.pendingLoad = request
            try {
                context.startService(Intent(context, PlaybackService::class.java))
            } catch (error: IllegalStateException) {
                // The OS refuses service starts from an app it considers backgrounded —
                // including "top but the screen just locked". Reject rather than crash;
                // the web layer surfaces the error and the next foreground press works.
                PlaybackService.pendingLoad = null
                call.reject(error.message ?: "cannot start playback from the background")
                return
            }
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

    /**
     * Starts the native filter driver for the loaded episode.
     *
     * The web layer compiles the wordlist (profile + inflections + user overrides —
     * single-sourced in TypeScript) and hands the flat result across once, together
     * with any seed coverage from a stored map or a publisher-transcript shortcut.
     * From here the session lives entirely in the service's process; the WebView can
     * die without the pipeline noticing.
     */
    @PluginMethod
    fun startNativeFilter(call: PluginCall) {
        val running = service()
        if (running == null) {
            call.reject("playback service is not running")
            return
        }
        running.listener = this
        try {
            val wordlist = call.getObject("wordlist")
                ?: return call.reject("wordlist is required")
            val config = LiveFilterEngine.Config(
                episodeId = call.getString("episodeId")
                    ?: return call.reject("episodeId is required"),
                fileKey = call.getString("fileKey") ?: return call.reject("fileKey is required"),
                streamUrl = call.getString("url"),
                model = call.getString("model") ?: "base.en",
                profileId = call.getString("profileId") ?: "standard",
                padBeforeSec = call.getDouble("padBeforeSec") ?: 0.2,
                padAfterSec = call.getDouble("padAfterSec") ?: 0.3,
                mergeGapSec = call.getDouble("mergeGapSec") ?: 0.45,
                wordlist = WordMatcher.Compiled.fromJson(wordlist),
                startAtSec = call.getDouble("startAtSec") ?: 0.0,
                durationSec = call.getDouble("durationSec") ?: 0.0,
                engineVersion = call.getString("engineVersion") ?: "",
                wordlistVersion = call.getString("wordlistVersion") ?: "",
                seedSpans = parseSeedSpans(call.getArray("seedSpans")),
                seedRanges = parseSeedRanges(call.getArray("seedRanges")),
                source = call.getString("source") ?: "asr",
            )
            running.engine.start(config)
            call.resolve()
        } catch (error: Throwable) {
            call.reject(error.message ?: "could not start filter engine")
        }
    }

    @PluginMethod
    fun stopNativeFilter(call: PluginCall) {
        service()?.engine?.stop()
        call.resolve()
    }

    @PluginMethod
    fun retargetNativeFilter(call: PluginCall) {
        val positionSec = call.getDouble("positionSec") ?: 0.0
        service()?.engine?.retarget(positionSec)
        call.resolve()
    }

    private fun parseSeedSpans(array: com.getcapacitor.JSArray?): List<EngineSpan> {
        if (array == null) return emptyList()
        val spans = ArrayList<EngineSpan>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val terms = ArrayList<String>()
            item.optJSONArray("terms")?.let { t ->
                for (j in 0 until t.length()) terms.add(t.optString(j))
            }
            spans.add(
                EngineSpan(
                    startSec = item.optDouble("startSec", 0.0),
                    endSec = item.optDouble("endSec", 0.0),
                    severity = item.optString("severity", "moderate"),
                    category = item.optString("category", "profanity"),
                    terms = terms,
                ),
            )
        }
        return spans
    }

    private fun parseSeedRanges(array: com.getcapacitor.JSArray?): List<Range> {
        if (array == null) return emptyList()
        val ranges = ArrayList<Range>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            ranges.add(Range(item.optDouble("startSec", 0.0), item.optDouble("endSec", 0.0)))
        }
        return ranges
    }

    /** Holds/releases the catch-up wakelock; see PlaybackService.setCatchupHold. */
    @PluginMethod
    fun setCatchupHold(call: PluginCall) {
        val active = call.getBoolean("active") ?: false
        // Not an error when the service is down: clearing a hold that cannot exist.
        service()?.setCatchupHold(active)
        call.resolve()
    }

    @PluginMethod
    fun setFilterSpans(call: PluginCall) {
        val array = call.getArray("spans")
        val spans = if (array == null) emptyList() else FilterSpan.fromJson(array)
        val analyzed = call.getArray("analyzed")?.toList<org.json.JSONObject>()?.map {
            val startMs = (it.getDouble("startSec") * 1000).toLong()
            val endMs = (it.getDouble("endSec") * 1000).toLong()
            startMs..endMs
        }
        withService(call, start = false) { it.setSpans(spans, analyzed) }
    }

    /**
     * What is actually happening in the playback service, if anything.
     *
     * The WebView dies and reloads independently of the service — Android reclaims it
     * for memory, the user swipes the task — and a fresh page has no idea audio is
     * already playing. This answers that: a live snapshot when the service is up
     * (re-registering this plugin as its listener, which is what reattaches the event
     * stream), or the last journaled position when it is not, so the web layer can
     * resume from where playback really was rather than from its own stale record.
     */
    @PluginMethod
    fun getState(call: PluginCall) {
        val running = service()
        if (running != null && running.currentEpisodeId != null) {
            running.listener = this
            running.snapshot { snap ->
                if (snap == null) {
                    call.resolve(lastJournaled())
                } else {
                    val result = JSObject()
                        .put("running", true)
                        .put("episodeId", snap.episodeId)
                        .put("state", snap.state)
                        .put("positionSec", snap.positionMs / 1000.0)
                        .put("durationSec", snap.durationMs / 1000.0)
                        .put("skippedSec", snap.skippedMs / 1000.0)
                    // A live engine session rides along, so a fresh page reattaches to
                    // the pipeline's real state instead of a stale database mirror.
                    running.engine.snapshot()?.let { session ->
                        result.put("filtering", true)
                        result.put("filterSession", snapshotToJson(session))
                    }
                    call.resolve(result)
                }
            }
            return
        }
        call.resolve(lastJournaled())
    }

    private fun lastJournaled(): JSObject {
        val result = JSObject().put("running", false)
        val prefs = context.getSharedPreferences(PlaybackService.JOURNAL_PREFS, android.content.Context.MODE_PRIVATE)
        val episodeId = prefs.getString("episodeId", null) ?: return result
        return result.put(
            "lastSaved",
            JSObject()
                .put("episodeId", episodeId)
                .put("positionSec", prefs.getLong("positionMs", 0) / 1000.0)
                .put("updatedAt", prefs.getLong("updatedAt", 0)),
        )
    }

    /**
     * One crisp haptic tick, for gesture detents in the web layer.
     *
     * Here and not in @capacitor/haptics because that plugin's selectionChanged() is an
     * iOS concept that quietly does nothing on Android — verified in the vibrator log:
     * three calls, zero vibrations. EFFECT_TICK is the platform's own detent feel.
     */
    @PluginMethod
    fun hapticTick(call: PluginCall) {
        val vibrator = if (android.os.Build.VERSION.SDK_INT >= 31) {
            val manager = context.getSystemService(android.content.Context.VIBRATOR_MANAGER_SERVICE)
                as android.os.VibratorManager
            manager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(android.content.Context.VIBRATOR_SERVICE) as android.os.Vibrator
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            vibrator.vibrate(android.os.VibrationEffect.createPredefined(android.os.VibrationEffect.EFFECT_TICK))
        } else {
            // No predefined effects below API 29; a short one-shot is the nearest feel.
            vibrator.vibrate(android.os.VibrationEffect.createOneShot(10, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
        }
        call.resolve()
    }

    @PluginMethod
    fun release(call: PluginCall) {
        service()?.listener = null
        context.stopService(Intent(context, PlaybackService::class.java))
        call.resolve()
    }

    // --- events back to the web layer ---------------------------------------

    private fun snapshotToJson(session: LiveFilterEngine.Snapshot): JSObject {
        val spans = com.getcapacitor.JSArray()
        for (span in session.spans) {
            spans.put(
                JSObject()
                    .put("startSec", span.startSec)
                    .put("endSec", span.endSec)
                    .put("severity", span.severity)
                    .put("category", span.category)
                    .put("terms", com.getcapacitor.JSArray(span.terms)),
            )
        }
        val ranges = com.getcapacitor.JSArray()
        for (range in session.ranges) {
            ranges.put(JSObject().put("startSec", range.startSec).put("endSec", range.endSec))
        }
        val persistable = com.getcapacitor.JSArray()
        for (range in session.persistableRanges) {
            persistable.put(JSObject().put("startSec", range.startSec).put("endSec", range.endSec))
        }
        return JSObject()
            .put("episodeId", session.episodeId)
            .put("profileId", session.profileId)
            .put("spans", spans)
            .put("analyzedRanges", ranges)
            .put("persistableRanges", persistable)
            .put("durationSec", session.durationSec)
            .put("source", session.source)
            .put("reachedEnd", session.reachedEnd)
    }

    override fun onFilterUpdate(session: LiveFilterEngine.Snapshot) {
        notifyListeners("filterUpdate", snapshotToJson(session))
    }

    override fun onFilterModelProgress(fraction: Double) {
        notifyListeners("filterModelProgress", JSObject().put("fraction", fraction))
    }

    override fun onFilterError(message: String) {
        notifyListeners("filterError", JSObject().put("message", message))
    }

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
        frontierHeld: Boolean,
    ) {
        notifyListeners(
            "status",
            JSObject()
                .put("state", state)
                .put("positionSec", positionMs / 1000.0)
                .put("durationSec", durationMs / 1000.0)
                .put("skippedSec", skippedMs / 1000.0)
                .put("buffered", bufferedMs / 1000.0)
                .put("frontierHeld", frontierHeld),
        )
    }
}
