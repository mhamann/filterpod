package app.filterpod

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures

/**
 * Playback, running as a foreground service.
 *
 * This exists because of one constraint: the filter action is "skip", so something has
 * to compare the playhead against the filter map continuously and seek past flagged
 * spans. In a WebView that work stops the moment the screen turns off — rAF is
 * suspended and timers are throttled — which is exactly when someone is listening to a
 * podcast. Here the check runs on a native Handler at [TICK_MS], independent of the
 * WebView's lifecycle.
 *
 * Holding the MediaSession here also gets lock-screen, notification and Bluetooth
 * controls without extra work.
 */
class PlaybackService : MediaSessionService() {

    /**
     * How often the playhead is checked against the filter map.
     *
     * 20ms is far tighter than needed for accuracy — spans are padded by 200ms+ to
     * absorb ASR timing error — but it is cheap, and it keeps the seek from landing
     * audibly late into a flagged word.
     */
    private val tickMs = TICK_MS

    private var player: ExoPlayer? = null
    private var session: MediaSession? = null

    private val handler = Handler(Looper.getMainLooper())
    private var spans: List<FilterSpan> = emptyList()
    private var skippedMs: Long = 0

    /**
     * Analyzed coverage, for the native frontier backstop.
     *
     * The real frontier guard lives in the web layer, which also knows how to catch up
     * and resume. But the OS reclaims the WebView independently of this service, and a
     * dead guard must not mean unfiltered audio: with the ranges mirrored here, the
     * ticker pauses at the edge of coverage even with no web layer alive. The margin is
     * deliberately smaller than the web guard's, so when both are alive the web one —
     * the one that can resume — always fires first.
     */
    private var analyzed: List<LongRange> = emptyList()

    /** Which episode is loaded, so position can be journaled against it. */
    var currentEpisodeId: String? = null
        private set

    /**
     * When playback last stopped being audible, for the resume rewind.
     *
     * Recorded only when playWhenReady is false — a buffering stall is not a pause, and
     * rewinding after one would punish a bad connection twice.
     */
    private var pausedAtMs: Long = 0

    /** Wall-clock time of the last position journal write. */
    private var lastJournalAt = 0L

    /**
     * Skip increments for the notification and lock-screen buttons.
     *
     * Live values, not constructor arguments: they come from a user setting that can
     * change mid-episode, and ExoPlayer's own increments are fixed at build time. See
     * [SkipPlayer].
     */
    private var skipBackMs: Long = pendingSkipBackMs
    private var skipForwardMs: Long = pendingSkipForwardMs

    /** Set by the plugin so skip and status events reach the web layer. */
    var listener: PlaybackListener? = null

    interface PlaybackListener {
        fun onSkip(span: FilterSpan)
        fun onStatus(state: String, positionMs: Long, durationMs: Long, skippedMs: Long, bufferedMs: Long)
    }

    private var lastStatusAt = 0L

    private val ticker = object : Runnable {
        override fun run() {
            val active = player
            if (active != null) {
                // Skips are checked every tick — that precision is the whole point.
                applySkips(active)
                holdAtFrontier(active)

                // Status is not. Emitting at 20ms meant ~50 bridge crossings a second
                // for a UI that shows whole seconds; 5/s is plenty and far cheaper.
                val now = System.currentTimeMillis()
                if (now - lastStatusAt >= STATUS_INTERVAL_MS) {
                    lastStatusAt = now
                    emitStatus(active)
                }

                // The WebView's own progress saves freeze the moment it is backgrounded,
                // which used to mean a resume after a background pause landed wherever the
                // app was last on screen. The service journals position itself so the web
                // layer has something true to reconcile against.
                if (active.isPlaying && now - lastJournalAt >= JOURNAL_INTERVAL_MS) {
                    lastJournalAt = now
                    journalPosition(active)
                }
            }
            handler.postDelayed(this, tickMs)
        }
    }

    /** Persists (episode, position) so it survives both the WebView and this service. */
    private fun journalPosition(exo: ExoPlayer) {
        val episodeId = currentEpisodeId ?: return
        getSharedPreferences(JOURNAL_PREFS, MODE_PRIVATE).edit()
            .putString("episodeId", episodeId)
            .putLong("positionMs", exo.currentPosition)
            .putLong("updatedAt", System.currentTimeMillis())
            .apply()
    }

    /*
     * No notification is posted here on purpose.
     *
     * An earlier version put up a placeholder to satisfy the five-second
     * startForeground deadline. That deadline only existed because the service was
     * being started from play(), before anything was loaded — fixed since. The
     * placeholder then became the problem: it held the foreground notification slot, so
     * Media3's media-style notification never replaced it and there were no transport
     * controls, and it could not simply be cancelled because a foreground service's own
     * notification is not removable while it is in the foreground.
     *
     * MediaSessionService already manages notification and foreground state for a
     * loaded session. Letting it do that is both simpler and the only way to get real
     * controls.
     */

    @UnstableApi
    override fun onCreate() {
        super.onCreate()
        instance = this

        // Branding for the status bar: the default Media3 small icon is a generic
        // music note; this is the asterisk, the same mark as everywhere else.
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply {
                setSmallIcon(R.drawable.ic_stat_filterpod)
            },
        )

        // Streamed audio is read through the shared cache, so the bytes ExoPlayer pulls
        // off the network are the same ones the transcriber later decodes rather than a
        // second copy of them. Downloaded episodes are routed straight to the file — see
        // MediaCache.playbackFactory.
        val exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(
                androidx.media3.exoplayer.source.DefaultMediaSourceFactory(
                    MediaCache.playbackFactory(this),
                ),
            )
            // Audio focus: when another app starts playing, this one pauses instead of
            // talking over it, and short interruptions (navigation prompts) duck.
            // Without this ExoPlayer ignores focus entirely and both sources play.
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus= */ true,
            )
            // Unplugging headphones pauses rather than blaring from the speaker.
            .setHandleAudioBecomingNoisy(true)
            // Partial wake + wifi lock while playing: streamed audio and the
            // transcription racing ahead of it both need the CPU and radio up with the
            // screen off.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
            .also { player = it }

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) = emitStatus(exo)
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying && !exo.playWhenReady) {
                    // A genuine pause, whatever pressed it — earbud, notification, UI.
                    pausedAtMs = System.currentTimeMillis()
                    journalPosition(exo)
                }
                emitStatus(exo)
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                // Every pause names its cause in the log. "It just stopped" reports are
                // undiagnosable without this; with it they are one logcat away.
                val cause = when (reason) {
                    Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "user-request"
                    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "audio-focus-loss"
                    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "becoming-noisy"
                    Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "remote"
                    Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "end-of-item"
                    else -> "reason-$reason"
                }
                android.util.Log.i("FilterPod", "playWhenReady=$playWhenReady ($cause)")

                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY) {
                    // A headset dropping mid-listen — the mower scenario. Pausing is
                    // right; staying paused after the earbuds reconnect a second later
                    // is not. Arm a resume that fires when a headset returns.
                    armHeadsetResume()
                } else {
                    // Any other transition — the user pressing pause after the drop,
                    // or playback resuming by any path — retires the pending resume.
                    disarmHeadsetResume()
                }
            }

            override fun onPlaybackSuppressionReasonChanged(reason: Int) {
                android.util.Log.i("FilterPod", "suppression=$reason")
            }
        })

        session = MediaSession.Builder(this, SkipPlayer(exo))
            .setCallback(SkipCallback())
            .setMediaButtonPreferences(skipButtons())
            // Tapping the notification (or the system media card) opens the app. Without
            // a session activity the tap simply does nothing.
            .apply {
                packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
                    setSessionActivity(
                        PendingIntent.getActivity(
                            this@PlaybackService,
                            0,
                            launch,
                            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                        ),
                    )
                }
            }
            .build().also {
            // Registering the session is what hands Media3 responsibility for the media
            // notification and for promoting the service to the foreground. Building a
            // session and only returning it from onGetSession is not enough: that path
            // serves incoming controller connections, so without this the service stayed
            // started-but-background and no transport controls were ever posted.
            addSession(it)
        }
        handler.post(ticker)

        // Service creation is asynchronous, so commands issued between
        // startForegroundService() and onCreate() have nowhere to land. Rather than
        // block the caller or drop them, they are parked and applied here.
        pendingLoad?.let { request ->
            pendingLoad = null
            load(request.url, request.title, request.artist, request.artworkUrl, request.startAtMs, request.episodeId)
        }
        if (pendingPlay) {
            pendingPlay = false
            exo.play()
        }
    }

    /** Seeks past a flagged span the playhead is about to enter. */
    private fun applySkips(exo: ExoPlayer) {
        if (spans.isEmpty() || !exo.isPlaying) return
        val position = exo.currentPosition
        // Decided against the playhead a moment in the future, not where it is now.
        // Seeking flushes ExoPlayer's own buffers, but audio already handed to the output
        // — and, over Bluetooth, already sitting in the headset — cannot be recalled, so
        // a skip decided the instant the span is entered is heard anyway. This was the
        // difference between cutting a word and cutting the tail of one.
        val span = spans.spanAt(position + SKIP_LOOKAHEAD_MS) ?: return

        skippedMs += span.endMs - position
        exo.seekTo(span.endMs)
        android.util.Log.i(
            "FilterPod",
            "skip ${span.startMs}-${span.endMs}ms (${span.severity}) " +
                "decided at ${position}ms, ${span.startMs - position}ms early",
        )
        listener?.onSkip(span)
    }

    /** The native backstop: never play past the end of analyzed coverage. */
    private fun holdAtFrontier(exo: ExoPlayer) {
        if (analyzed.isEmpty() || !exo.isPlaying) return
        val position = exo.currentPosition
        val frontierMs = analyzed.firstOrNull { position in it }?.last
            ?: position // outside all coverage: the frontier is here, pause now

        val duration = exo.duration
        val atEnd = duration > 0 && frontierMs >= duration - FRONTIER_MARGIN_MS
        if (!atEnd && position >= frontierMs - FRONTIER_MARGIN_MS) {
            android.util.Log.i(
                "FilterPod",
                "frontier hold at ${position}ms (coverage ends ${frontierMs}ms)",
            )
            exo.pause()
        }
    }

    private fun emitStatus(exo: ExoPlayer) {
        val state = when {
            exo.playerError != null -> "error"
            exo.playbackState == Player.STATE_BUFFERING -> "loading"
            exo.playbackState == Player.STATE_ENDED -> "ended"
            exo.isPlaying -> "playing"
            exo.playbackState == Player.STATE_READY -> "paused"
            else -> "idle"
        }
        listener?.onStatus(
            state,
            exo.currentPosition,
            if (exo.duration > 0) exo.duration else 0,
            skippedMs,
            exo.bufferedPosition,
        )
    }

    /**
     * Runs [block] on the main thread.
     *
     * ExoPlayer may only be touched from the thread it was built on, and every one of
     * these commands arrives from Capacitor's `CapacitorPlugins` worker — which threw
     * `IllegalStateException: Player is accessed on the wrong thread` and killed the
     * app. Marshalling here rather than at each call site means no future caller has to
     * remember.
     */
    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post { block() }
    }

    fun load(url: String, title: String, artist: String, artworkUrl: String?, startAtMs: Long, episodeId: String? = null) = onMain {
        val exo = player ?: return@onMain
        skippedMs = 0
        currentEpisodeId = episodeId
        pausedAtMs = 0

        // The URI and whether it actually resolves. "Source error" from ExoPlayer says
        // nothing about which of those two failed.
        val localPath = url.removePrefix("file://")
        android.util.Log.i(
            "FilterPod",
            "load: $url (exists=${java.io.File(localPath).exists()}, " +
                "size=${java.io.File(localPath).length()}) @${startAtMs}ms",
        )

        val metadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .apply { artworkUrl?.let { setArtworkUri(android.net.Uri.parse(it)) } }
            .build()

        exo.setMediaItem(
            MediaItem.Builder().setUri(url).setMediaMetadata(metadata).build()
        )
        exo.prepare()
        if (startAtMs > 0) exo.seekTo(startAtMs)
    }

    /** Also main-thread: the ticker reads this list, so writing it elsewhere races. */
    fun setSpans(next: List<FilterSpan>, analyzedRanges: List<LongRange>? = null) = onMain {
        // Logged because "the UI counted cuts but nothing was skipped" is otherwise
        // indistinguishable from "the spans never arrived", and they have different fixes.
        android.util.Log.i("FilterPod", "setSpans: ${next.size} span(s), ${analyzedRanges?.size ?: 0} analyzed range(s)")
        spans = next
        analyzedRanges?.let { analyzed = it }
    }

    fun play() = onMain {
        val exo = player ?: return@onMain
        applyResumeRewind(exo)
        exo.play()
    }

    fun pause() = onMain {
        player?.pause()
    }

    /**
     * Held while playback is paused waiting for analysis to catch up.
     *
     * ExoPlayer's wake mode releases its lock the moment playback pauses, and the
     * per-transcription lock only exists while a chunk is in flight. In the gap — paused
     * at the frontier, next chunk not yet requested — a still, cool phone suspends the
     * CPU, the service ticker and the WebView both stop, and the pause becomes permanent
     * until the screen wakes. This lock bridges exactly that gap, driven by the web
     * layer's catchingUp state and time-capped in case that state is never cleared.
     */
    private var catchupLock: android.os.PowerManager.WakeLock? = null

    fun setCatchupHold(active: Boolean) = onMain {
        if (active) {
            if (catchupLock == null) {
                val powerManager = getSystemService(android.content.Context.POWER_SERVICE)
                    as android.os.PowerManager
                catchupLock = powerManager.newWakeLock(
                    android.os.PowerManager.PARTIAL_WAKE_LOCK, "filterpod:catchup",
                ).apply {
                    setReferenceCounted(false)
                    acquire(CATCHUP_HOLD_TIMEOUT_MS)
                }
            }
        } else {
            catchupLock?.takeIf { it.isHeld }?.release()
            catchupLock = null
        }
    }

    /** Wall-clock of the becoming-noisy pause the pending headset resume belongs to. */
    private var noisyPausedAtMs = 0L
    private var deviceCallback: android.media.AudioDeviceCallback? = null

    /**
     * Resumes playback when a headset returns after a becoming-noisy pause.
     *
     * Bluetooth earbuds drop for a moment constantly in the real world — a mower's
     * vibration, a phone in the far pocket — and Android's becoming-noisy contract only
     * covers the pause half. Without this, every blip was a permanent stop the listener
     * discovered as silence. The resume fires only for a genuine headset (never the
     * speaker), only within [NOISY_RESUME_WINDOW_MS], and is disarmed by any other
     * playback transition — a user who pressed pause after the drop stays paused.
     */
    private fun armHeadsetResume() {
        noisyPausedAtMs = System.currentTimeMillis()
        if (deviceCallback != null) return
        val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        val callback = object : android.media.AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<android.media.AudioDeviceInfo>) {
                if (!added.any { it.isSink && it.type in HEADSET_DEVICE_TYPES }) return
                if (System.currentTimeMillis() - noisyPausedAtMs > NOISY_RESUME_WINDOW_MS) {
                    disarmHeadsetResume()
                    return
                }
                android.util.Log.i("FilterPod", "headset returned; resuming")
                disarmHeadsetResume()
                // A beat for the audio route to actually settle on the new device;
                // resuming into a route mid-switch clips the first words.
                handler.postDelayed({ play() }, 750)
            }
        }
        deviceCallback = callback
        audioManager.registerAudioDeviceCallback(callback, handler)
    }

    private fun disarmHeadsetResume() {
        val callback = deviceCallback ?: return
        deviceCallback = null
        val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        audioManager.unregisterAudioDeviceCallback(callback)
    }

    /**
     * Rewinds a little on resume after a real break, so the listener gets a running
     * start back into the sentence instead of a cold mid-word entry. Ten seconds after
     * a couple of minutes away, fifteen after half an hour — and never more, because a
     * resume point that drifts backwards stops being trustworthy.
     *
     * The rewound stretch was already analyzed (it was just played), so this cannot
     * carry the playhead into unfiltered audio.
     */
    private fun applyResumeRewind(exo: ExoPlayer) {
        if (pausedAtMs == 0L || exo.isPlaying) return
        val away = System.currentTimeMillis() - pausedAtMs
        pausedAtMs = 0
        val rewind = when {
            away >= LONG_BREAK_MS -> 15_000L
            away >= SHORT_BREAK_MS -> 10_000L
            else -> return
        }
        exo.seekTo((exo.currentPosition - rewind).coerceAtLeast(0))
    }

    fun seekTo(positionMs: Long) = onMain {
        val exo = player ?: return@onMain
        // An explicit seek is the user choosing a position; resuming later must not
        // second-guess it with a rewind.
        pausedAtMs = 0
        exo.seekTo(positionMs)
        // A scrub can land inside a flagged span; resolve it now rather than waiting
        // for the next tick, which would play a fragment of it.
        spans.spanAt(positionMs)?.let { exo.seekTo(it.endMs) }
    }

    fun setRate(rate: Float) = onMain {
        player?.setPlaybackSpeed(rate)
    }

    /** Seeks by [deltaMs], clamped to the episode, and resolves any span it lands in. */
    private fun seekRelative(deltaMs: Long) = onMain {
        val exo = player ?: return@onMain
        val duration = exo.duration
        var target = exo.currentPosition + deltaMs
        if (target < 0) target = 0
        if (duration > 0 && target > duration) target = duration
        seekTo(target)
    }

    /**
     * Applies new skip increments, taking effect on the next button press.
     *
     * The buttons are rebuilt too, because the icons carry the number — Media3 ships
     * distinct "back 15" and "back 30" glyphs, and a button that says 15 while seeking 30
     * is worse than no number at all.
     */
    fun setSkipIncrements(backMs: Long, forwardMs: Long) = onMain {
        if (backMs == skipBackMs && forwardMs == skipForwardMs) return@onMain
        skipBackMs = backMs
        skipForwardMs = forwardMs
        session?.setMediaButtonPreferences(skipButtons())
    }

    /**
     * The two buttons that replace Media3's defaults in the notification.
     *
     * Bound to CUSTOM session commands, not to COMMAND_SEEK_BACK/FORWARD, and that
     * distinction is the whole bug it fixes: on Android 13+ the notification is drawn
     * by System UI from the platform MediaSession, which renders play/pause plus
     * *custom actions* and simply ignores the standard rewind/fast-forward actions a
     * player command maps to. (Verified against Pocket Casts on a Pixel: its notification
     * skip buttons are custom actions named "Skip back"/"Skip forward".) The slots still
     * matter pre-13, where Media3's own notification provider fills them directly.
     *
     * Bluetooth and headset skips never see these buttons — they arrive as media-key
     * seek commands and are handled by [SkipPlayer].
     */
    private fun skipButtons(): ImmutableList<CommandButton> = ImmutableList.of(
        CommandButton.Builder(backIcon(skipBackMs))
            .setSessionCommand(SessionCommand(COMMAND_SKIP_BACK, Bundle.EMPTY))
            .setSlots(CommandButton.SLOT_BACK)
            .setDisplayName("Skip back ${skipBackMs / 1000} seconds")
            .build(),
        CommandButton.Builder(forwardIcon(skipForwardMs))
            .setSessionCommand(SessionCommand(COMMAND_SKIP_FORWARD, Bundle.EMPTY))
            .setSlots(CommandButton.SLOT_FORWARD)
            .setDisplayName("Skip forward ${skipForwardMs / 1000} seconds")
            .build(),
    )

    /** Accepts the custom skip commands and dispatches them through the filtered seek. */
    private inner class SkipCallback : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult =
            MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                        .add(SessionCommand(COMMAND_SKIP_BACK, Bundle.EMPTY))
                        .add(SessionCommand(COMMAND_SKIP_FORWARD, Bundle.EMPTY))
                        .build(),
                )
                .build()

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ) = when (customCommand.customAction) {
            COMMAND_SKIP_BACK -> {
                seekRelative(-skipBackMs)
                Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            COMMAND_SKIP_FORWARD -> {
                seekRelative(skipForwardMs)
                Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            else -> Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
        }
    }

    /**
     * Presents the configured increments to everything outside this service.
     *
     * ExoPlayer takes its seek increments as builder arguments and offers no setter, but
     * the increments here are a user setting. Forwarding lets them change at any time,
     * and routing the seeks through [seekRelative] means a skip from the notification is
     * filtered exactly like one from the in-app buttons — otherwise skipping forward could
     * drop the playhead into the middle of a flagged word and play it.
     */
    private inner class SkipPlayer(inner: Player) : ForwardingPlayer(inner) {
        override fun getSeekBackIncrement(): Long = skipBackMs
        override fun getSeekForwardIncrement(): Long = skipForwardMs
        override fun seekBack() { seekRelative(-skipBackMs) }
        override fun seekForward() { seekRelative(skipForwardMs) }
        // Resumes from the notification, lock screen and Bluetooth route through the
        // same rewind-on-resume as the in-app button.
        override fun play() { this@PlaybackService.play() }
    }

    /** What [snapshot] answers with. Null episodeId cases resolve to a null snapshot. */
    data class Snapshot(
        val episodeId: String,
        val state: String,
        val positionMs: Long,
        val durationMs: Long,
        val skippedMs: Long,
    )

    /**
     * Current playback identity and position, for the web layer to reattach against.
     * Asynchronous because ExoPlayer may only be read on its own thread; always calls
     * back exactly once, with null when nothing is loaded.
     */
    fun snapshot(onResult: (Snapshot?) -> Unit) {
        onMain {
            val exo = player
            val episodeId = currentEpisodeId
            if (exo == null || episodeId == null) {
                onResult(null)
                return@onMain
            }
            val state = when {
                exo.playerError != null -> "error"
                exo.playbackState == Player.STATE_BUFFERING -> "loading"
                exo.playbackState == Player.STATE_ENDED -> "ended"
                exo.isPlaying -> "playing"
                exo.playbackState == Player.STATE_READY -> "paused"
                else -> "idle"
            }
            onResult(
                Snapshot(episodeId, state, exo.currentPosition, if (exo.duration > 0) exo.duration else 0, skippedMs),
            )
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app away should not kill audio mid-episode; only stop if paused.
        val exo = player
        if (exo == null || !exo.playWhenReady) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        // The last position must outlive the service, or a kill while paused loses it.
        player?.let { journalPosition(it) }
        disarmHeadsetResume()
        setCatchupHold(false)
        handler.removeCallbacks(ticker)
        session?.release()
        player?.release()
        session = null
        player = null
        instance = null
        super.onDestroy()
    }

    companion object {
        const val TICK_MS = 20L

        /**
         * How far in front of the playhead a skip is decided.
         *
         * Covers the audio that is already past the point of recall when `seekTo` runs:
         * the platform mixer and HAL buffers, and over A2DP the headset's own buffer,
         * which together run to a couple of hundred milliseconds. Too small and the start
         * of a flagged word is audible before the cut lands — the bug this fixes. Too
         * large and the cut eats into the word before it, so this deliberately errs only
         * slightly past typical wired latency.
         */
        private const val SKIP_LOOKAHEAD_MS = 250L

        /** Status updates to the WebView. The UI shows whole seconds. */
        private const val STATUS_INTERVAL_MS = 200L

        /** Where the native position journal lives. Read by [FilterPlayerPlugin]. */
        const val JOURNAL_PREFS = "filterpod_playback"

        /** Position journal cadence. Matches the web layer's own save interval. */
        private const val JOURNAL_INTERVAL_MS = 5_000L

        /** Away this long, resume rewinds 10s; less and it resumes exactly in place. */
        private const val SHORT_BREAK_MS = 2 * 60_000L

        /** Away this long, resume rewinds the full 15s. */
        private const val LONG_BREAK_MS = 30 * 60_000L

        /** Custom session commands for the notification skip buttons. */
        const val COMMAND_SKIP_BACK = "app.filterpod.SKIP_BACK"
        const val COMMAND_SKIP_FORWARD = "app.filterpod.SKIP_FORWARD"

        /**
         * Native frontier margin. Half the web guard's two seconds, so the web layer —
         * which can catch up and auto-resume — always pauses first when it is alive.
         */
        private const val FRONTIER_MARGIN_MS = 1_000L

        /** Cap on the catch-up hold, in case the web layer dies without clearing it. */
        private const val CATCHUP_HOLD_TIMEOUT_MS = 15 * 60_000L

        /**
         * How long a becoming-noisy pause stays willing to resume when a headset
         * returns. Long enough to cover earbuds going back in their case for a chore's
         * worth of interruption; short enough that putting them in tomorrow morning
         * does not start audio out of nowhere.
         */
        private const val NOISY_RESUME_WINDOW_MS = 10 * 60_000L

        /**
         * Output types that count as "a headset came back" for the auto-resume.
         * Raw constants because several are newer than minSdk: A2DP(8), wired
         * headset(3)/headphones(4), USB headset(22), hearing aid(23), BLE
         * headset(26), BLE broadcast(30).
         */
        private val HEADSET_DEVICE_TYPES = setOf(3, 4, 8, 22, 23, 26, 30)

        /** A load requested before the service finished starting. */
        data class LoadRequest(
            val url: String,
            val title: String,
            val artist: String,
            val artworkUrl: String?,
            val startAtMs: Long,
            val episodeId: String? = null,
        )

        @Volatile
        var pendingLoad: LoadRequest? = null

        @Volatile
        var pendingPlay: Boolean = false

        /*
         * Increments to build the session with, for when they are set before the service
         * exists — which is the normal case, since the web layer pushes them from its
         * startup sequence. Defaults match DEFAULT_SETTINGS in src/data/defaults.ts.
         */
        @Volatile
        var pendingSkipBackMs: Long = 15_000

        @Volatile
        var pendingSkipForwardMs: Long = 30_000

        /** Media3 ships numbered glyphs for the common increments; the rest get a plain arrow. */
        private fun backIcon(ms: Long) = when (ms) {
            5_000L -> CommandButton.ICON_SKIP_BACK_5
            10_000L -> CommandButton.ICON_SKIP_BACK_10
            15_000L -> CommandButton.ICON_SKIP_BACK_15
            30_000L -> CommandButton.ICON_SKIP_BACK_30
            else -> CommandButton.ICON_SKIP_BACK
        }

        private fun forwardIcon(ms: Long) = when (ms) {
            5_000L -> CommandButton.ICON_SKIP_FORWARD_5
            10_000L -> CommandButton.ICON_SKIP_FORWARD_10
            15_000L -> CommandButton.ICON_SKIP_FORWARD_15
            30_000L -> CommandButton.ICON_SKIP_FORWARD_30
            else -> CommandButton.ICON_SKIP_FORWARD
        }


        /**
         * The running service, so the plugin can reach it without binding.
         * Set in onCreate and cleared in onDestroy, so it is null exactly when there
         * is no service to talk to.
         */
        @Volatile
        var instance: PlaybackService? = null
    }
}
