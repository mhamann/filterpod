package app.filterpod

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Just-in-time filtering, driven by the playhead — the native port of liveFilter.ts.
 *
 * This engine exists because of where it runs, not what it does. The TypeScript
 * original is correct, but it lives in the WebView: the one process Android freezes
 * with the screen off, starves of network in doze, and kills under pressure — every
 * one of which was field-diagnosed as "the podcast just stops". Here the pipeline
 * shares the playback service's process, foreground standing and exemptions: when
 * playback is alive, filtering is alive, by construction.
 *
 * The algorithm is a faithful port. Tuning constants, retry policy, abandonment
 * semantics and the safety invariants are identical to the TS driver (which remains
 * the browser implementation); the matcher and span math are held byte-identical by
 * FilterParityTest. The one deliberate difference: publisher-transcript handling
 * stays in TypeScript — the web layer runs the shortcut before starting a session
 * and hands the result in as seed coverage, so this engine only ever runs ASR chunks.
 *
 * Two properties carry over unchanged, because they are the product:
 *  - **Unanalyzed is not clean.** Playback may never run past analyzed coverage;
 *    the service's frontier hold enforces it and this engine keeps the frontier fed.
 *  - **It stops when far enough ahead.** TARGET_LEAD of cushion, then idle.
 */
class LiveFilterEngine(
    private val appContext: Context,
    private val scope: CoroutineScope,
    private val listener: Listener,
) {

    interface Listener {
        /** New spans or coverage landed. [ranges] includes abandoned stretches. */
        fun onUpdate(session: Snapshot)
        fun onModelProgress(fraction: Double)
        fun onError(message: String)
    }

    /** What the service and the web layer see of a session. */
    data class Snapshot(
        val episodeId: String,
        val profileId: String,
        val spans: List<EngineSpan>,
        /** Playable coverage: analyzed plus abandoned, for the frontier. */
        val ranges: List<Range>,
        /** Coverage that is honestly analyzed — what may be persisted. */
        val persistableRanges: List<Range>,
        val durationSec: Double,
        val source: String,
        val reachedEnd: Boolean,
    )

    class Config(
        val episodeId: String,
        val fileKey: String,
        val streamUrl: String?,
        val model: String,
        val profileId: String,
        val padBeforeSec: Double,
        val padAfterSec: Double,
        val mergeGapSec: Double,
        val wordlist: WordMatcher.Compiled,
        val startAtSec: Double,
        val durationSec: Double,
        val engineVersion: String,
        val wordlistVersion: String,
        /** Coverage and spans a previous session or transcript shortcut established. */
        val seedSpans: List<EngineSpan>,
        val seedRanges: List<Range>,
        val source: String,
    )

    private class Session(val config: Config) {
        var spans: List<EngineSpan> = config.seedSpans
        var ranges: List<Range> = SpanMath.mergeRanges(config.seedRanges)
        var abandoned: List<Range> = emptyList()
        @Volatile var positionSec: Double = config.startAtSec
        @Volatile var durationSec: Double = config.durationSec
        @Volatile var stopped = false
        val attempts = HashMap<Long, Int>()
        var chunk: Deferred<List<TimedWord>>? = null
        var chunkWindow: Range? = null
        var pumpJob: Job? = null
        var source: String = config.source
    }

    @Volatile private var session: Session? = null

    fun isActive(): Boolean = session?.stopped == false

    fun activeEpisodeId(): String? = session?.takeIf { !it.stopped }?.config?.episodeId

    /**
     * Starts (or adopts) a session. Mirrors startLiveFilter's never-tear-down rule:
     * restarting the same episode+profile+model only retargets, because a restart
     * throws away the chunk in flight and a double play press must not livelock.
     */
    fun start(config: Config) {
        val current = session
        if (
            current != null && !current.stopped &&
            current.config.episodeId == config.episodeId &&
            current.config.profileId == config.profileId &&
            current.config.model == config.model
        ) {
            retarget(config.startAtSec)
            emit(current)
            return
        }

        stop()
        val next = Session(config)
        // A journal from a session the WebView never got to mirror — merged only when
        // it describes the same episode under the same rules.
        loadJournal(config)?.let { journal ->
            next.spans = SpanMath.normalizeSpans(next.spans + journal.first, config.mergeGapSec)
            next.ranges = SpanMath.mergeRanges(next.ranges + journal.second)
        }
        session = next
        log(
            "engine start ${config.episodeId} at ${config.startAtSec.toInt()}s, " +
                "seeded ${next.ranges.size} range(s), ${next.spans.size} span(s)",
        )
        emit(next)

        next.pumpJob = scope.launch {
            try {
                TranscriptionCore.ensureModel(appContext, config.model) { fraction ->
                    listener.onModelProgress(fraction)
                }
                listener.onModelProgress(1.0)
                pump(next)
            } catch (error: Throwable) {
                if (next.stopped) return@launch
                listener.onError(error.message ?: "filter engine failed")
            }
        }
    }

    fun stop() {
        val current = session ?: return
        current.stopped = true
        current.chunk?.cancel()
        current.pumpJob?.cancel()
        session = null
    }

    /** The player's periodic position report; cheap, called from the service ticker. */
    fun updatePosition(positionSec: Double) {
        val current = session?.takeIf { !it.stopped } ?: return
        current.positionSec = positionSec
        // Wake the pump if the cushion has worn thin and it has gone idle.
        if (current.pumpJob?.isActive != true) {
            val lead = SpanMath.analyzedUntil(current.ranges, positionSec) - positionSec
            if (lead < RESUME_LEAD_SEC && !reachedEnd(current)) {
                current.pumpJob = scope.launch { pump(current) }
            }
        }
    }

    /** Called after a seek: cancel out-of-window work, resume from the new spot. */
    fun retarget(positionSec: Double) {
        val current = session?.takeIf { !it.stopped } ?: return
        log("engine retarget position=${positionSec.toInt()}")
        current.positionSec = positionSec

        val window = current.chunkWindow
        if (
            window != null &&
            !(window.endSec > positionSec && window.startSec <= positionSec + TARGET_LEAD_SEC)
        ) {
            current.chunk?.cancel()
        }
        if (current.pumpJob?.isActive != true) {
            current.pumpJob = scope.launch { pump(current) }
        }
    }

    /** Measured duration from the player; feeds lie by whole percents. */
    fun updateDuration(durationSec: Double) {
        val current = session?.takeIf { !it.stopped } ?: return
        if (durationSec > 1 && kotlin.math.abs(current.durationSec - durationSec) > 2) {
            current.durationSec = durationSec
        }
    }

    fun snapshot(): Snapshot? = session?.takeIf { !it.stopped }?.let { toSnapshot(it) }

    // -----------------------------------------------------------------------

    private fun nextChunkStart(session: Session): Double =
        SpanMath.analyzedUntil(session.ranges, session.positionSec)

    private fun reachedEnd(session: Session): Boolean {
        if (session.durationSec <= 0) return false
        return nextChunkStart(session) >= session.durationSec - 0.5
    }

    private fun chunkLengthFor(session: Session): Double {
        val lead = SpanMath.analyzedUntil(session.ranges, session.positionSec) - session.positionSec
        return when {
            lead < FIRST_CHUNK_SEC -> FIRST_CHUNK_SEC
            lead < RAMP_UNTIL_SEC -> RAMP_CHUNK_SEC
            else -> CHUNK_SEC
        }
    }

    private suspend fun pump(session: Session) {
        while (this.session === session && !session.stopped && !reachedEnd(session)) {
            val lead = SpanMath.analyzedUntil(session.ranges, session.positionSec) - session.positionSec
            if (lead >= TARGET_LEAD_SEC) break
            transcribeNextChunk(session)
        }
    }

    private suspend fun transcribeNextChunk(session: Session) {
        val startSec = nextChunkStart(session)
        val length = chunkLengthFor(session)
        val endSec = if (session.durationSec > 0) {
            minOf(session.durationSec, startSec + length)
        } else {
            startSec + length
        }
        if (endSec <= startSec) return

        val chunk = scope.async {
            TranscriptionCore.transcribeWindow(
                appContext,
                session.config.fileKey,
                session.config.streamUrl,
                session.config.model,
                startSec,
                endSec,
            )
        }
        session.chunk = chunk
        session.chunkWindow = Range(startSec, endSec)

        try {
            val words = withTimeout(CHUNK_TIMEOUT_MS) { chunk.await() }
            if (this.session !== session || session.stopped) return

            val matches = WordMatcher.matchWords(
                SpanMath.sortAndDedupe(words),
                session.config.wordlist,
            )
            val chunkSpans = SpanMath.spansFromMatches(
                matches,
                session.config.padBeforeSec,
                session.config.padAfterSec,
                session.config.mergeGapSec,
                session.durationSec.takeIf { it > 0 },
            )

            session.spans = SpanMath.normalizeSpans(
                session.spans + chunkSpans,
                session.config.mergeGapSec,
            )
            session.ranges = SpanMath.mergeRanges(session.ranges + listOf(Range(startSec, endSec)))
            session.attempts.remove(startSec.toRawBits())

            writeJournal(session)
            emit(session)
        } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
            // The watchdog fired; the late result must be discarded, but this IS a
            // failure and must reach the retry path, or a hung chunk wedges silently.
            chunk.cancel()
            abandonOrRetry(session, startSec, endSec, "chunk timed out after ${CHUNK_TIMEOUT_MS / 1000}s")
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            // A chunk cancelled because the listener moved is not a failure and must
            // not count against this stretch — the audio was never examined. But if
            // the PUMP itself is being cancelled, propagate; swallowing our own
            // cancellation would keep a dead coroutine looping.
            if (session.pumpJob?.isActive != true || session.stopped) throw cancelled
        } catch (error: Throwable) {
            abandonOrRetry(session, startSec, endSec, error.message ?: "transcription failed")
        } finally {
            if (session.chunk === chunk) {
                session.chunk = null
                session.chunkWindow = null
            }
        }
    }

    private suspend fun abandonOrRetry(
        session: Session,
        startSec: Double,
        endSec: Double,
        message: String,
    ) {
        val key = startSec.toRawBits()
        val attempts = (session.attempts[key] ?: 0) + 1
        session.attempts[key] = attempts
        listener.onError(message)

        if (attempts < MAX_CHUNK_ATTEMPTS) {
            // Spaced, not immediate: back-to-back retries land inside the same
            // transient, and a network blip would fail all of them in milliseconds.
            delay(attempts * RETRY_BACKOFF_MS)
            return
        }

        android.util.Log.e(
            "FilterPod",
            "engine giving up on ${startSec.toInt()}-${endSec.toInt()}s after $attempts " +
                "attempts ($message); it will play unfiltered this session",
        )
        // Abandonment is a lie told to the playhead so it is not walled in forever.
        // It is merged into playable coverage but never into the persistable journal —
        // the next session must try this stretch again rather than inherit bad luck.
        session.abandoned = SpanMath.mergeRanges(session.abandoned + listOf(Range(startSec, endSec)))
        session.ranges = SpanMath.mergeRanges(session.ranges + listOf(Range(startSec, endSec)))
        emit(session)
    }

    private fun toSnapshot(session: Session): Snapshot = Snapshot(
        episodeId = session.config.episodeId,
        profileId = session.config.profileId,
        spans = session.spans,
        ranges = session.ranges,
        persistableRanges = SpanMath.subtractRanges(session.ranges, session.abandoned),
        durationSec = session.durationSec,
        source = session.source,
        reachedEnd = reachedEnd(session),
    )

    private fun emit(session: Session) {
        listener.onUpdate(toSnapshot(session))
    }

    // --- session journal ----------------------------------------------------

    private fun journalFile() = File(appContext.filesDir, "filterpod/live-session.json")

    /**
     * Coverage the WebView may never have mirrored. The web layer persists to its own
     * database from update events, but it can be dead for an entire session; this file
     * is the native record that survives, and it carries the same validity stamps the
     * database maps do — episode, profile, engine and wordlist versions must all match
     * or it is discarded, exactly like a stale map.
     */
    private fun writeJournal(session: Session) {
        runCatching {
            val spans = JSONArray()
            for (span in session.spans) {
                spans.put(
                    JSONObject()
                        .put("startSec", span.startSec)
                        .put("endSec", span.endSec)
                        .put("severity", span.severity)
                        .put("category", span.category)
                        .put("terms", JSONArray(span.terms)),
                )
            }
            val ranges = JSONArray()
            for (range in SpanMath.subtractRanges(session.ranges, session.abandoned)) {
                ranges.put(
                    JSONObject().put("startSec", range.startSec).put("endSec", range.endSec),
                )
            }
            val json = JSONObject()
                .put("episodeId", session.config.episodeId)
                .put("profileId", session.config.profileId)
                .put("engineVersion", session.config.engineVersion)
                .put("wordlistVersion", session.config.wordlistVersion)
                .put("spans", spans)
                .put("ranges", ranges)
                .put("updatedAt", System.currentTimeMillis())
            val file = journalFile()
            file.parentFile?.mkdirs()
            file.writeText(json.toString())
        }
    }

    private fun loadJournal(config: Config): Pair<List<EngineSpan>, List<Range>>? {
        return runCatching {
            val file = journalFile()
            if (!file.exists()) return null
            val json = JSONObject(file.readText())
            if (json.optString("episodeId") != config.episodeId) return null
            if (json.optString("profileId") != config.profileId) return null
            if (json.optString("engineVersion") != config.engineVersion) return null
            if (json.optString("wordlistVersion") != config.wordlistVersion) return null

            val spans = ArrayList<EngineSpan>()
            json.optJSONArray("spans")?.let { array ->
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val terms = ArrayList<String>()
                    item.optJSONArray("terms")?.let { t ->
                        for (j in 0 until t.length()) terms.add(t.optString(j))
                    }
                    spans.add(
                        EngineSpan(
                            startSec = item.optDouble("startSec"),
                            endSec = item.optDouble("endSec"),
                            severity = item.optString("severity", "moderate"),
                            category = item.optString("category", "profanity"),
                            terms = terms,
                        ),
                    )
                }
            }
            val ranges = ArrayList<Range>()
            json.optJSONArray("ranges")?.let { array ->
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    ranges.add(Range(item.optDouble("startSec"), item.optDouble("endSec")))
                }
            }
            spans.toList() to ranges.toList()
        }.getOrNull()
    }

    private fun log(message: String) = android.util.Log.i("FilterPod", message)

    companion object {
        // Tuning identical to liveFilter.ts; see its commentary for every number's
        // field history. Change only together with LIVE_FILTER_TUNING.
        const val LEAD_IN_SEC = 15.0
        const val TARGET_LEAD_SEC = 600.0
        const val RESUME_LEAD_SEC = 150.0
        const val CHUNK_SEC = 45.0
        const val FIRST_CHUNK_SEC = 15.0
        const val RAMP_CHUNK_SEC = 30.0
        const val RAMP_UNTIL_SEC = 60.0
        const val MAX_CHUNK_ATTEMPTS = 3
        const val RETRY_BACKOFF_MS = 2_000L
        const val CHUNK_TIMEOUT_MS = 90_000L
    }
}
