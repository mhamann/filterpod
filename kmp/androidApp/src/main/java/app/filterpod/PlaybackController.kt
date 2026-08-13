package app.filterpod

import android.content.Context
import android.content.Intent
import app.filterpod.shared.data.ENGINE_VERSION
import app.filterpod.shared.data.Repo
import app.filterpod.shared.data.WORDLIST_VERSION
import app.filterpod.shared.filter.compileWordlist
import app.filterpod.shared.model.AnalyzedRange
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.FilterMap
import app.filterpod.shared.model.FilterMapStatus
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.model.WordOverride
import app.filterpod.shared.model.FilterSpan as ModelSpan
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Playback controller — the Kotlin home of what playerStore.ts did in the WebView.
 *
 * Owns "what is playing", position persistence, queue advance, and the filtering
 * session around the playhead. The mechanics of decoding and skipping stay in
 * PlaybackService; the chunk pump stays in LiveFilterEngine. What died with the
 * bridge: every serialization boundary, the reconnect dance (the controller lives in
 * the service's process), and the event plumbing a frozen WebView used to drop.
 *
 * The invariant this class exists to uphold is unchanged: **playback never runs past
 * the end of analyzed coverage.** Audio nobody has looked at is unknown, not clean.
 */
class PlaybackController(
    private val context: Context,
    private val repo: Repo,
    /** Publisher-transcript shortcut; returns null when no usable transcript exists. */
    private val transcriptSeeder: TranscriptSeeder = TranscriptSeeder { _, _, _, _ -> null },
    /**
     * Fired when a live session is about to start. The prefilter hooks this to yield
     * the transcriber immediately instead of making the lead-in queue behind it.
     */
    private val onLiveSessionStarting: () -> Unit = {},
) {
    fun interface TranscriptSeeder {
        suspend fun seed(
            episode: Episode,
            profile: FilterProfile,
            overrides: List<WordOverride>,
            durationSec: Double,
        ): TranscriptSeed?
    }

    data class TranscriptSeed(
        val spans: List<ModelSpan>,
        val ranges: List<AnalyzedRange>,
        val source: String,
        /** True when the transcript settles the whole episode and no ASR is needed. */
        val complete: Boolean,
    )

    data class UiState(
        val episode: Episode? = null,
        val podcast: Podcast? = null,
        val state: String = "idle",
        val positionSec: Double = 0.0,
        val durationSec: Double = 0.0,
        val skippedSec: Double = 0.0,
        val rate: Double = 1.0,
        val spans: List<ModelSpan> = emptyList(),
        val analyzedRanges: List<AnalyzedRange> = emptyList(),
        /** Set while the lead-in is being analyzed before playback can start. */
        val preparing: Boolean = false,
        /** 0..1 while the speech model downloads, null otherwise. */
        val modelProgress: Double? = null,
        /** Playback paused because it caught up with the analysis frontier. */
        val catchingUp: Boolean = false,
        /** Restored for display but not loaded into the player. */
        val loaded: Boolean = false,
        val error: String? = null,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    /** Serializes open/close/profile transitions; UI taps arrive concurrently. */
    private val transition = Mutex()

    private var lastSaveAt = 0L
    private val measuredDurationSaved = mutableSetOf<String>()
    private var completionThresholdSec = 30

    /** Edge latches for 'ended' — status is emitted on a timer, not on change. */
    private var sawActive = false
    private var endedHandled = false

    /** Resolved when engine coverage reaches the lead-in target; see open(). */
    private var leadWaiter: CompletableDeferred<Unit>? = null

    private fun service(): PlaybackService? = PlaybackService.instance

    private val listener = object : PlaybackService.PlaybackListener {
        override fun onSkip(span: FilterSpan) = Unit

        override fun onStatus(
            state: String,
            positionMs: Long,
            durationMs: Long,
            skippedMs: Long,
            bufferedMs: Long,
            frontierHeld: Boolean,
        ) {
            val episode = _state.value.episode ?: return
            val positionSec = positionMs / 1000.0
            val durationSec = durationMs / 1000.0
            _state.value = _state.value.copy(
                state = state,
                positionSec = positionSec,
                durationSec = if (durationSec > 0) durationSec else _state.value.durationSec,
                skippedSec = skippedMs / 1000.0,
                // The native frontier hold IS the catch-up state now; adopt it.
                catchingUp = frontierHeld || (_state.value.catchingUp && state != "playing"),
            )

            // The player's measured duration is ground truth; feeds lie by whole
            // percents. Written back once per episode.
            if (durationSec > 1 && episode.id !in measuredDurationSaved &&
                kotlin.math.abs(durationSec - (episode.durationSec ?: 0)) > 2
            ) {
                measuredDurationSaved += episode.id
                scope.launch { repo.recordMeasuredDuration(episode.id, durationSec) }
            }

            val now = System.currentTimeMillis()
            if (state == "playing" && now - lastSaveAt > SAVE_INTERVAL_MS) {
                lastSaveAt = now
                scope.launch {
                    repo.saveProgress(episode.id, positionSec, durationSec, completionThresholdSec, now)
                }
            }

            if (state == "loading" || state == "playing" || state == "paused") sawActive = true
            if (state == "ended" && sawActive && !endedHandled) {
                endedHandled = true
                scope.launch {
                    repo.saveProgress(episode.id, durationSec, durationSec, completionThresholdSec, now)
                    advanceQueue(episode.id)
                }
            }
        }

        override fun onFilterUpdate(session: LiveFilterEngine.Snapshot) {
            val current = _state.value.episode
            if (current == null || current.id != session.episodeId) return
            val spans = session.spans.map { it.toModel() }
            val ranges = session.ranges.map { it.toModel() }
            _state.value = _state.value.copy(spans = spans, analyzedRanges = ranges)
            maybeReleaseLeadWaiter(session)
            scope.launch { persistFilterMap(session) }
        }

        override fun onFilterModelProgress(fraction: Double) {
            _state.value = _state.value.copy(modelProgress = if (fraction < 1) fraction else null)
        }

        override fun onFilterError(message: String) {
            _state.value = _state.value.copy(error = message)
        }
    }

    // --- lifecycle ------------------------------------------------------------

    /** Adopts a service that survived the UI, or restores the last episode on screen. */
    suspend fun start() {
        completionThresholdSec = repo.getSettings().completionThresholdSec
        val settings = repo.getSettings()
        service()?.let { running ->
            running.listener = listener
            running.snapshot { snap ->
                if (snap != null) scope.launch { adoptRunning(snap) }
            }
        }
        service()?.setSkipIncrements(settings.skipBackSec * 1000L, settings.skipForwardSec * 1000L)
        PlaybackService.pendingSkipBackMs = settings.skipBackSec * 1000L
        PlaybackService.pendingSkipForwardMs = settings.skipForwardSec * 1000L
        if (_state.value.episode == null) restoreLast()
    }

    private suspend fun adoptRunning(snap: PlaybackService.Snapshot) {
        val episode = repo.getEpisode(snap.episodeId) ?: return
        val podcast = repo.getPodcast(episode.podcastId)
        val map = repo.getFilterMap(episode.id)
        _state.value = UiState(
            episode = episode,
            podcast = podcast,
            state = snap.state,
            positionSec = snap.positionMs / 1000.0,
            durationSec = if (snap.durationMs > 0) snap.durationMs / 1000.0 else (episode.durationSec ?: 0).toDouble(),
            skippedSec = snap.skippedMs / 1000.0,
            rate = repo.getSettings().playbackRate,
            spans = map?.spans ?: emptyList(),
            analyzedRanges = map?.analyzedRanges ?: emptyList(),
            loaded = true,
        )
        sawActive = false
        endedHandled = false
    }

    /** Puts the last-played episode back on screen without loading the player. */
    private suspend fun restoreLast() {
        val recent = repo.listInProgress(limit = 1).firstOrNull() ?: return
        val episode = repo.getEpisode(recent.episodeId) ?: return
        if (_state.value.episode != null) return
        val podcast = repo.getPodcast(episode.podcastId)
        val map = repo.getFilterMap(episode.id)
        _state.value = UiState(
            episode = episode,
            podcast = podcast,
            state = "paused",
            positionSec = recent.positionSec,
            durationSec = if (recent.durationSec > 0) recent.durationSec else (episode.durationSec ?: 0).toDouble(),
            rate = repo.getSettings().playbackRate,
            spans = map?.spans ?: emptyList(),
            analyzedRanges = map?.analyzedRanges ?: emptyList(),
            loaded = false,
        )
    }

    // --- open/play ------------------------------------------------------------

    fun openAsync(episodeId: String, autoPlay: Boolean = true) {
        scope.launch { open(episodeId, autoPlay) }
    }

    suspend fun open(episodeId: String, autoPlay: Boolean = true): Unit = transition.withLock {
        // Re-opening the loaded episode just resumes it; a full re-open would throw
        // away the chunk in flight and reset the session.
        val current = _state.value
        if (current.episode?.id == episodeId && current.loaded && current.state != "idle") {
            if (autoPlay) play()
            return
        }

        val settings = repo.getSettings()
        completionThresholdSec = settings.completionThresholdSec
        val episode = repo.getEpisode(episodeId) ?: run {
            _state.value = current.copy(error = "unknown episode $episodeId")
            return
        }

        // Settle the episode being walked away from: save its position, and if it was
        // within the completion threshold of its end, switching away counts as
        // finishing. An episode that reached its natural end is advanceQueue's
        // business, not this path's.
        val outgoing = _state.value
        if (outgoing.episode != null && outgoing.loaded &&
            outgoing.episode.id != episodeId && outgoing.state != "ended"
        ) {
            val now = System.currentTimeMillis()
            repo.saveProgress(
                outgoing.episode.id, outgoing.positionSec, outgoing.durationSec,
                settings.completionThresholdSec, now,
            )
            val nearEnd = outgoing.durationSec > 0 &&
                outgoing.positionSec >= outgoing.durationSec - settings.completionThresholdSec
            if (nearEnd) repo.removeFromQueue(outgoing.episode.id)
        }

        val podcast = repo.getPodcast(episode.podcastId)
        val download = repo.getDownload(episodeId)
        val progress = repo.getProgress(episodeId)
        val profile = repo.getProfileForPodcast(episode.podcastId)
        val overrides = repo.listWordOverrides()

        // Playing something moves it to the front of the queue; position 0 is always
        // what is playing.
        repo.enqueueEpisode(episodeId, next = true, now = System.currentTimeMillis())

        val startAtSec = progress?.positionSec ?: 0.0
        val fileKey = download?.fileKey ?: "audio/$episodeId"

        sawActive = false
        endedHandled = false
        _state.value = UiState(
            episode = episode,
            podcast = podcast,
            state = "loading",
            positionSec = startAtSec,
            durationSec = (episode.durationSec ?: 0).toDouble(),
            rate = settings.playbackRate,
            preparing = true,
            loaded = false,
        )

        // The playhead's pipeline owns the transcriber; a background prefilter build
        // in flight yields now rather than making the lead-in queue behind it.
        onLiveSessionStarting()

        // The player is loaded before analysis begins: loading starts the service,
        // buffers audio while the lead-in transcribes, and gives the engine a home.
        startServiceForLoad(episode, podcast, fileKey, startAtSec)
        service()?.listener = listener
        service()?.setRate(settings.playbackRate.toFloat())
        _state.value = _state.value.copy(loaded = true)

        startFilterSession(episode, profile, overrides, startAtSec)

        if (autoPlay) play()
    }

    private fun startServiceForLoad(
        episode: Episode,
        podcast: Podcast?,
        fileKey: String,
        startAtSec: Double,
    ) {
        val request = PlaybackService.Companion.LoadRequest(
            url = episode.audioUrl,
            title = episode.title,
            artist = podcast?.title ?: "",
            artworkUrl = episode.artworkUrl ?: podcast?.artworkUrl,
            startAtMs = (startAtSec * 1000).toLong(),
            episodeId = episode.id,
        )
        val running = service()
        if (running != null) {
            running.listener = listener
            running.load(request.url, request.title, request.artist, request.artworkUrl, request.startAtMs, request.episodeId)
        } else {
            PlaybackService.pendingListener = listener
            PlaybackService.pendingLoad = request
            context.startForegroundService(Intent(context, PlaybackService::class.java))
        }
        // MediaCache prefetch for streams, mirroring the plugin's load path.
        MediaCache.prefetch(context, episode.audioUrl)
    }

    /**
     * Starts (or re-adopts) the engine session for an episode: seed from the stored
     * map and the publisher transcript, compile the wordlist, hand the engine its
     * config, then block only until the lead-in is covered (bounded — past the cap,
     * playback starts against the frontier hold and catch-up takes over).
     */
    private suspend fun startFilterSession(
        episode: Episode,
        profile: FilterProfile,
        overrides: List<WordOverride>,
        startAtSec: Double,
    ) {
        val durationSec = (episode.durationSec ?: 0).toDouble()

        if (profile.severities.isEmpty()) {
            // Filtering is off: no cuts, playback unrestricted, and nothing persisted —
            // a map claiming full coverage with no spans would be believed by the next
            // profile this show is switched to.
            service()?.engine?.stop()
            val full = listOf(AnalyzedRange(0.0, if (durationSec > 0) durationSec else Double.MAX_VALUE))
            _state.value = _state.value.copy(
                spans = emptyList(), analyzedRanges = full, preparing = false,
            )
            service()?.setSpans(emptyList(), listOf(0L..(if (durationSec > 0) (durationSec * 1000).toLong() else Long.MAX_VALUE)))
            return
        }

        val valid = repo.getValidFilterMap(episode.id, profile.id)
        var seedSpans = valid?.spans ?: emptyList()
        var seedRanges = valid?.analyzedRanges ?: emptyList()
        var source = "asr"

        val seed = runCatching {
            transcriptSeeder.seed(episode, profile, overrides, durationSec)
        }.getOrNull()
        if (seed != null && seed.complete) {
            service()?.engine?.stop()
            _state.value = _state.value.copy(
                spans = seed.spans, analyzedRanges = seed.ranges, preparing = false,
            )
            service()?.setSpans(
                seed.spans.map { it.toEngine().toServiceSpan() },
                seed.ranges.map { (it.startSec * 1000).toLong()..(it.endSec * 1000).toLong() },
            )
            persistCompleteSeed(episode.id, profile.id, seed)
            return
        }
        if (seed != null) {
            seedRanges = SpanMath.mergeRanges((seedRanges + seed.ranges).map { it.toEngine() })
                .map { it.toModel() }
            source = seed.source
        }

        val compiled = compileWordlist(profile, overrides)
        val waiter = CompletableDeferred<Unit>()
        leadWaiter = waiter

        service()?.engine?.start(
            LiveFilterEngine.Config(
                episodeId = episode.id,
                fileKey = "audio/${episode.id}",
                streamUrl = episode.audioUrl,
                model = repo.getSettings().whisperModel,
                profileId = profile.id,
                padBeforeSec = profile.padBeforeSec,
                padAfterSec = profile.padAfterSec,
                mergeGapSec = profile.mergeGapSec,
                wordlist = compiled.toMatcher(),
                startAtSec = startAtSec,
                durationSec = durationSec,
                engineVersion = ENGINE_VERSION,
                wordlistVersion = WORDLIST_VERSION,
                seedSpans = seedSpans.map { it.toEngine() },
                seedRanges = seedRanges.map { it.toEngine() },
                source = source,
            ),
        )

        // Bounded lead-in wait: normally resolved by the first covering snapshot in a
        // few seconds; a model download blows the cap and the frontier hold + catch-up
        // machinery carries the UX instead.
        leadWaiterTarget = startAtSec + LEAD_IN_SEC
        withTimeoutOrNull(LEAD_WAIT_CAP_MS) { waiter.await() }
        leadWaiter = null
        _state.value = _state.value.copy(preparing = false, modelProgress = null)
    }

    private var leadWaiterTarget = 0.0

    private fun maybeReleaseLeadWaiter(session: LiveFilterEngine.Snapshot) {
        val waiter = leadWaiter ?: return
        val covered = SpanMath.analyzedUntil(session.ranges, _state.value.positionSec)
        val atEnd = session.durationSec > 0 && covered >= session.durationSec - 0.5
        if (covered >= leadWaiterTarget || atEnd || session.reachedEnd) waiter.complete(Unit)
    }

    private suspend fun persistFilterMap(session: LiveFilterEngine.Snapshot) {
        val existing = repo.getFilterMap(session.episodeId)
        repo.putFilterMap(
            FilterMap(
                episodeId = session.episodeId,
                status = if (session.reachedEnd) FilterMapStatus.READY else FilterMapStatus.PARTIAL,
                spans = session.spans.map { it.toModel() },
                // Only honestly analyzed coverage may outlive the session; playable
                // coverage includes abandoned stretches, which must stay per-session.
                analyzedRanges = session.persistableRanges.map { it.toModel() },
                source = if (existing != null && existing.source != "asr") existing.source else session.source,
                engineVersion = ENGINE_VERSION,
                wordlistVersion = WORDLIST_VERSION,
                profileId = session.profileId,
                progress = if (session.durationSec > 0) {
                    minOf(1.0, SpanMath.analyzedSec(session.ranges) / session.durationSec)
                } else 0.0,
                createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                skippedSec = SpanMath.totalSkippedSec(session.spans),
            ),
        )
    }

    private suspend fun persistCompleteSeed(episodeId: String, profileId: String, seed: TranscriptSeed) {
        val existing = repo.getFilterMap(episodeId)
        repo.putFilterMap(
            FilterMap(
                episodeId = episodeId,
                status = FilterMapStatus.READY,
                spans = seed.spans,
                analyzedRanges = seed.ranges,
                source = seed.source,
                engineVersion = ENGINE_VERSION,
                wordlistVersion = WORDLIST_VERSION,
                profileId = profileId,
                progress = 1.0,
                createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                skippedSec = seed.spans.sumOf { it.endSec - it.startSec },
            ),
        )
    }

    // --- transport ------------------------------------------------------------

    fun play() {
        val s = _state.value
        if (s.episode != null && !s.loaded) {
            openAsync(s.episode.id, autoPlay = true)
            return
        }
        // Still starting from a load issued moments ago; play once it is up.
        val running = service()
        if (running == null) PlaybackService.pendingPlay = true else running.play()
        _state.value = _state.value.copy(catchingUp = false)
    }

    fun pause() {
        if (!_state.value.loaded) return
        _state.value = _state.value.copy(catchingUp = false)
        service()?.pause()
        val s = _state.value
        s.episode?.let { episode ->
            scope.launch {
                repo.saveProgress(
                    episode.id, s.positionSec, s.durationSec,
                    completionThresholdSec, System.currentTimeMillis(),
                )
            }
        }
    }

    fun toggle() = if (_state.value.state == "playing") pause() else play()

    fun seek(positionSec: Double) {
        val target = maxOf(0.0, positionSec)
        val s = _state.value
        if (s.episode != null && !s.loaded) {
            // Scrubbing a restored episode moves where it will start from.
            _state.value = s.copy(positionSec = target)
            scope.launch {
                repo.saveProgress(
                    s.episode.id, target, s.durationSec,
                    completionThresholdSec, System.currentTimeMillis(),
                )
            }
            return
        }
        // The service retargets the engine and re-evaluates spans natively.
        service()?.seekTo((target * 1000).toLong())
        _state.value = _state.value.copy(positionSec = target)
    }

    fun skipForward() = scope.launch {
        seek(_state.value.positionSec + repo.getSettings().skipForwardSec)
    }

    fun skipBack() = scope.launch {
        seek(_state.value.positionSec - repo.getSettings().skipBackSec)
    }

    fun setRate(rate: Double) {
        if (_state.value.loaded) service()?.setRate(rate.toFloat())
        _state.value = _state.value.copy(rate = rate)
        scope.launch { repo.updateSettings { it.copy(playbackRate = rate) } }
    }

    /** Re-tunes filtering after a show's profile changes, mid-playback. */
    suspend fun applyProfileChange(podcastId: String) {
        val s = _state.value
        val episode = s.episode ?: return
        if (episode.podcastId != podcastId || !s.loaded) return
        val profile = repo.getProfileForPodcast(podcastId)
        val overrides = repo.listWordOverrides()
        startFilterSession(episode, profile, overrides, s.positionSec)
    }

    private suspend fun advanceQueue(finishedEpisodeId: String) {
        repo.removeFromQueue(finishedEpisodeId)
        val next = repo.headOfQueue() ?: return
        open(next, autoPlay = true)
    }

    companion object {
        private const val SAVE_INTERVAL_MS = 5_000L
        /** Same lead-in the engine targets before playback starts (LEAD_IN_SEC there). */
        private const val LEAD_IN_SEC = 15.0
        private const val LEAD_WAIT_CAP_MS = 20_000L
    }
}
