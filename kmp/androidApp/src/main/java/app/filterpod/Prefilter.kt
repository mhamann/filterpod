package app.filterpod

import android.content.Context
import app.filterpod.shared.data.ENGINE_VERSION
import app.filterpod.shared.data.Repo
import app.filterpod.shared.data.WORDLIST_VERSION
import app.filterpod.shared.filter.compileWordlist
import app.filterpod.shared.model.DownloadState
import app.filterpod.shared.model.FilterMap
import app.filterpod.shared.model.FilterMapStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Ahead-of-time filtering for downloaded episodes — the prefilter.ts port.
 *
 * Downloading an episode is the one signal strong enough to justify spending
 * transcription on audio nobody has pressed play on: it makes "downloaded" mean
 * "filtered and ready", which is the durable answer to thermal throttling mid-listen.
 *
 * The playhead's pipeline always wins the transcriber. The engine and this class
 * share one serialized lane (TranscriptionCore), so the discipline here is about not
 * *queueing* hours of backlog work in front of a listener: work happens one window at
 * a time, and between windows the engine being active — or a recent cancel, which
 * precedes the engine flag by a few hundred milliseconds — drops the whole backlog.
 * The startup sweep restores it later.
 */
class Prefilter(
    private val context: Context,
    private val repo: Repo,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val queue = ArrayDeque<String>()
    private val running = Mutex()
    @Volatile private var cancelledAtMs = 0L

    fun prefilterEpisode(episodeId: String) {
        synchronized(queue) { if (episodeId !in queue) queue.addLast(episodeId) }
        scope.launch { run() }
    }

    /** Queues every downloaded episode that lacks a current map. Run once at startup. */
    suspend fun prefilterDownloadedBacklog() {
        for (download in repo.listDownloads(DownloadState.DOWNLOADED)) {
            prefilterEpisode(download.episodeId)
        }
    }

    /** A play press cancels the pass in flight; the live session owns the transcriber. */
    fun cancelActive() {
        cancelledAtMs = System.currentTimeMillis()
    }

    private fun mustYield(): Boolean =
        PlaybackService.instance?.engine?.isActive() == true ||
            System.currentTimeMillis() - cancelledAtMs < CANCEL_QUIET_MS

    private suspend fun run(): Unit = running.withLock {
        while (true) {
            val episodeId = synchronized(queue) { queue.removeFirstOrNull() } ?: return
            if (mustYield()) {
                // Someone is listening, or just pressed play. Drop the backlog rather
                // than idle-loop; the startup sweep restores it.
                synchronized(queue) { queue.clear() }
                return
            }
            try {
                build(episodeId)
            } catch (error: Throwable) {
                android.util.Log.w("FilterPod", "prefilter failed for $episodeId: ${error.message}")
            }
        }
    }

    private suspend fun build(episodeId: String) {
        val episode = repo.getEpisode(episodeId) ?: return
        val profile = repo.getProfileForPodcast(episode.podcastId)
        if (profile.severities.isEmpty()) return

        val fileKey = "audio/$episodeId"
        /*
         * Which copy this episode is, before a word of it is read.
         *
         * Without this the prefilter analysed whatever the feed URL returned per window,
         * and for an ad-supported show that is assembled per request — so a single map
         * could be built across several differently stitched copies, and then never
         * checked against the one that plays. Same rule as the live path: the file when
         * there is one, otherwise the copy at the end of the redirect chain.
         */
        val local = java.io.File(context.filesDir, "filterpod/$fileKey")
        val localIdentity = StreamPin.localIdentity(local)
        val pin = if (localIdentity != null) null
        else StreamPin.forEpisode(context, episodeId, episode.audioUrl)
        val audioIdentity = localIdentity ?: pin?.identity
        val readUrl = pin?.url ?: episode.audioUrl
        val cacheKey = pin?.cacheKey(episodeId)

        // Already current — engine, wordlist and profile all match — means nothing to do.
        val stored = repo.getValidFilterMap(episodeId, profile.id)
        // Work timed against a copy that is no longer this one is not a head start.
        val existing = if (StreamPin.isStale(stored?.audioIdentity, audioIdentity)) null else stored
        if (existing?.status == FilterMapStatus.READY) return

        val overrides = repo.listWordOverrides()
        val compiled = compileWordlist(profile, overrides).toMatcher()
        val model = repo.getSettings().whisperModel

        val declared = (episode.durationSec ?: 0).toDouble()
        // Feeds lie about duration; leave slack past the declared end so the real tail
        // is not left unexamined, and stop on the first empty window.
        val limit = if (declared > 0) declared + DURATION_SLACK_SEC else MAX_SCAN_SEC

        TranscriptionCore.ensureModel(context, model) { }

        var spans = existing?.spans?.map { it.toEngine() } ?: emptyList()
        var ranges = existing?.analyzedRanges?.map { it.toEngine() } ?: emptyList()
        var start = SpanMath.analyzedUntil(ranges, 0.0)

        while (start < limit) {
            if (mustYield()) {
                synchronized(queue) { queue.clear() }
                return
            }
            val end = minOf(limit, start + WINDOW_SEC)
            val words = TranscriptionCore.transcribeWindow(
                context, fileKey, readUrl, model, start, end, cacheKey,
            )
            val matches = WordMatcher.matchWords(SpanMath.sortAndDedupe(words), compiled)
            spans = SpanMath.normalizeSpans(
                spans + SpanMath.spansFromMatches(
                    matches, profile.padBeforeSec, profile.padAfterSec, profile.mergeGapSec,
                    declared.takeIf { it > 0 },
                ),
                profile.mergeGapSec,
            )
            ranges = SpanMath.mergeRanges(ranges + listOf(Range(start, end)))
            persist(episodeId, profile.id, spans, ranges, declared, audioIdentity, done = false)

            // Past the declared end, an empty window means the audio really is over.
            if (start >= declared && words.isEmpty()) break
            start = end
        }

        persist(episodeId, profile.id, spans, ranges, declared, audioIdentity, done = true)
    }

    private suspend fun persist(
        episodeId: String,
        profileId: String,
        spans: List<EngineSpan>,
        ranges: List<Range>,
        durationSec: Double,
        audioIdentity: String?,
        done: Boolean,
    ) {
        val existing = repo.getFilterMap(episodeId)
        repo.putFilterMap(
            FilterMap(
                episodeId = episodeId,
                status = if (done) FilterMapStatus.READY else FilterMapStatus.PARTIAL,
                spans = spans.map { it.toModel() },
                analyzedRanges = ranges.map { it.toModel() },
                source = "asr",
                engineVersion = ENGINE_VERSION,
                wordlistVersion = WORDLIST_VERSION,
                profileId = profileId,
                audioIdentity = audioIdentity,
                progress = if (durationSec > 0) minOf(1.0, SpanMath.analyzedSec(ranges) / durationSec) else 0.0,
                createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                skippedSec = SpanMath.totalSkippedSec(spans),
            ),
        )
    }

    companion object {
        /** ASR window cap; the transcriber changes hands within one window of a cancel. */
        private const val WINDOW_SEC = 120.0
        private const val CANCEL_QUIET_MS = 60_000L
        private const val DURATION_SLACK_SEC = 300.0
        /** Bound for episodes whose feed declared no duration at all. */
        private const val MAX_SCAN_SEC = 6 * 3600.0
    }
}
