package app.filterpod

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.collect.ImmutableList

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

                // Status is not. Emitting at 20ms meant ~50 bridge crossings a second
                // for a UI that shows whole seconds; 5/s is plenty and far cheaper.
                val now = System.currentTimeMillis()
                if (now - lastStatusAt >= STATUS_INTERVAL_MS) {
                    lastStatusAt = now
                    emitStatus(active)
                }
            }
            handler.postDelayed(this, tickMs)
        }
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

    override fun onCreate() {
        super.onCreate()
        instance = this
        val exo = ExoPlayer.Builder(this).build().also { player = it }

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) = emitStatus(exo)
            override fun onIsPlayingChanged(isPlaying: Boolean) = emitStatus(exo)
        })

        session = MediaSession.Builder(this, SkipPlayer(exo))
            .setMediaButtonPreferences(skipButtons())
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
            load(request.url, request.title, request.artist, request.artworkUrl, request.startAtMs)
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

    fun load(url: String, title: String, artist: String, artworkUrl: String?, startAtMs: Long) = onMain {
        val exo = player ?: return@onMain
        skippedMs = 0

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
    fun setSpans(next: List<FilterSpan>) = onMain {
        // Logged because "the UI counted cuts but nothing was skipped" is otherwise
        // indistinguishable from "the spans never arrived", and they have different fixes.
        android.util.Log.i("FilterPod", "setSpans: ${next.size} span(s)")
        spans = next
    }

    fun play() = onMain {
        player?.play()
    }

    fun pause() = onMain {
        player?.pause()
    }

    fun seekTo(positionMs: Long) = onMain {
        val exo = player ?: return@onMain
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
     * `DefaultMediaNotificationProvider` fills the slots either side of play/pause from
     * the media button preferences, falling back to previous/next track only when nothing
     * claims [CommandButton.SLOT_BACK] and [CommandButton.SLOT_FORWARD]. Previous/next is
     * the wrong idiom for a podcast — there is no queue, and a single ±30s jump is what
     * the content is actually navigated by.
     *
     * Binding them to player commands rather than session commands means Media3 dispatches
     * them itself, so they also work from Bluetooth controls, Android Auto and Wear
     * without any of this class being involved.
     */
    private fun skipButtons(): ImmutableList<CommandButton> = ImmutableList.of(
        CommandButton.Builder(backIcon(skipBackMs))
            .setPlayerCommand(Player.COMMAND_SEEK_BACK)
            .setSlots(CommandButton.SLOT_BACK)
            .setDisplayName("Skip back ${skipBackMs / 1000} seconds")
            .build(),
        CommandButton.Builder(forwardIcon(skipForwardMs))
            .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
            .setSlots(CommandButton.SLOT_FORWARD)
            .setDisplayName("Skip forward ${skipForwardMs / 1000} seconds")
            .build(),
    )

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

        /** A load requested before the service finished starting. */
        data class LoadRequest(
            val url: String,
            val title: String,
            val artist: String,
            val artworkUrl: String?,
            val startAtMs: Long,
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
