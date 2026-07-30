import { create } from 'zustand'
import type { AnalyzedRange, Episode, FilterSpan, Podcast, Progress } from '@/core/types'
import { analyzedUntil, isAnalyzed, mergeRanges, toFilteredPosition } from '@/core/filterMath'
import { getPlatform } from '@/platform'
import { db } from '@/data/db'
import {
  getDownload,
  getEpisode,
  getFilterMap,
  getPodcast,
  getProfileForPodcast,
  getProgress,
  getSettings,
  enqueueEpisode,
  headOfQueue,
  recordMeasuredDuration,
  removeFromQueue,
  listWordOverrides,
  saveProgress,
} from '@/data/repo'
import { enqueueDownload, fileKeyFor } from '@/features/downloads/downloadManager'
import {
  maybeResume,
  retargetLiveFilter,
  startLiveFilter,
  stopLiveFilter,
  updateDurationSec,
} from '@/features/filter/liveFilter'

/**
 * Playback controller.
 *
 * Owns the "what is playing" state and the persistence of listening position; the
 * mechanics of decoding and skipping live behind `platform.player`. Position is always
 * stored on the ORIGINAL timeline so resume survives a change of filter profile —
 * re-filtering an episode must not move where you left off.
 *
 * Filtering runs just-in-time alongside playback rather than up front, so this store
 * also enforces the rule that makes that safe: **playback never runs past the end of
 * analyzed coverage.** Audio nobody has looked at is unknown, not clean.
 */

/** Position is persisted on this cadence rather than every tick. */
const SAVE_INTERVAL_MS = 5_000

/**
 * Stop this far before the analyzed frontier.
 *
 * Skips are decided slightly ahead of the playhead, so pausing exactly at the frontier
 * would let the player evaluate a moment it has no data for.
 */
const FRONTIER_MARGIN_SEC = 2

interface PlayerState {
  episode: Episode | null
  podcast: Podcast | null
  spans: FilterSpan[]
  /** How much of the episode has been analyzed so far. */
  analyzedRanges: AnalyzedRange[]
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  positionSec: number
  durationSec: number
  /** Audio skipped during this listening session. */
  skippedSec: number
  rate: number
  error?: string
  /** Set while the lead-in is being analyzed before playback can start. */
  preparing: boolean
  /**
   * 0..1 while the speech model is downloading, null otherwise.
   * Distinct from `preparing` because a ~150MB fetch needs its own progress, not a
   * spinner that looks identical to a hang.
   */
  modelProgress: number | null
  /** Set when playback paused because it caught up with the analysis frontier. */
  catchingUp: boolean
  blockedReason?: string
  /**
   * Whether the episode on screen is actually loaded into the player.
   *
   * False for one restored at startup. Restoring shows what you were listening to; it
   * deliberately does not start the playback service or the filter pipeline, because
   * opening the app is not a request to transcribe anything. Everything that would talk
   * to the player checks this and opens for real first.
   */
  loaded: boolean

  open(episodeId: string, autoPlay?: boolean): Promise<void>
  /**
   * Reconnects this page to whatever playback is really happening.
   *
   * The playback service outlives the WebView, so a fresh page may arrive while audio
   * is already playing. Reattaching — rather than re-loading the player, which resets
   * the stream and audibly hiccups — picks up the live position, resubscribes to
   * status, and restarts the analysis pipeline the old page took with it. When the
   * service is gone instead, the native position journal reconciles stored progress
   * (the web layer's own saves freeze in the background) and the last episode is
   * restored for display.
   */
  reconnect(): Promise<void>
  /**
   * Re-tunes live filtering after a show's filter profile changes, when the episode
   * playing right now belongs to that show. Playback keeps running under the old spans
   * while the new profile's lead-in analyzes; the frontier guards hold it back if it
   * outruns the fresh coverage. No-op when nothing of that show is loaded.
   */
  applyProfileChange(podcastId: string): Promise<void>
  /** Puts the last-played episode back on screen, without loading or filtering it. */
  restoreLast(): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  toggle(): Promise<void>
  seek(positionSec: number): Promise<void>
  skipForward(): Promise<void>
  skipBack(): Promise<void>
  setRate(rate: number): Promise<void>
  /** Re-reads the filter map, e.g. after a prefilter pass finishes for this episode. */
  refreshSpans(): Promise<void>
  close(): Promise<void>
}

let unsubscribeStatus: (() => void) | null = null
let unsubscribeSkip: (() => void) | null = null
let lastSaveAt = 0

/** Episodes whose measured duration was already written back this session. */
const measuredDurationSaved = new Set<string>()

export const usePlayerStore = create<PlayerState>((set, get) => {
  /** Callbacks the live filter uses to drive the store and the native player. */
  const filterCallbacks = (episodeId: string) => ({
    onUpdate: (nextSpans: FilterSpan[], nextRanges: AnalyzedRange[]) => {
      // Only the currently open episode may drive the player.
      if (get().episode?.id !== episodeId) return
      set({ spans: nextSpans, analyzedRanges: nextRanges })
      void getPlatform().player.setFilterSpans(nextSpans, nextRanges)
      // New coverage may have unblocked a playhead that was waiting.
      if (get().catchingUp) void get().play()
    },
    onModelProgress: (fraction: number) => {
      if (get().episode?.id !== episodeId) return
      set({ modelProgress: fraction < 1 ? fraction : null })
    },
    onError: (message: string) => {
      if (get().episode?.id === episodeId) set({ error: message })
    },
  })

  /** Subscribes the store to player status. Shared by open() and reconnect(). */
  const attachStatus = (episode: Episode, completionThresholdSec: number) => {
    const episodeId = episode.id
    const platform = getPlatform()
    unsubscribeStatus?.()
    unsubscribeSkip?.()

    unsubscribeStatus = platform.player.onStatus((status) => {
      set({
        state: status.state,
        positionSec: status.positionSec,
        durationSec: status.durationSec || get().durationSec,
        skippedSec: status.skippedSec,
        error: status.error,
      })

      // The player's measured duration is ground truth; feeds lie by whole percents.
      // Written back once per episode so the timeline, the remaining-time display and
      // the filter pipeline's end clamp stop trusting the feed's number.
      if (
        status.durationSec > 1 &&
        !measuredDurationSaved.has(episodeId) &&
        Math.abs(status.durationSec - (episode.durationSec ?? 0)) > 2
      ) {
        measuredDurationSaved.add(episodeId)
        updateDurationSec(status.durationSec)
        void recordMeasuredDuration(episodeId, status.durationSec)
      }

      // Keep the analysis frontier ahead of where we are.
      maybeResume(status.positionSec)

      // The guard that makes partial analysis safe: never let the playhead cross into
      // audio nobody has looked at. Unanalyzed is unknown, not clean.
      const { analyzedRanges, catchingUp } = get()
      if (status.state === 'playing' && analyzedRanges.length > 0) {
        const frontier = analyzedUntil(analyzedRanges, status.positionSec)
        const atFrontier =
          !isAnalyzed(analyzedRanges, status.positionSec) ||
          status.positionSec >= frontier - FRONTIER_MARGIN_SEC

        // Genuinely reaching the end of the episode is not "catching up".
        const atEnd =
          status.durationSec > 0 && frontier >= status.durationSec - FRONTIER_MARGIN_SEC

        if (atFrontier && !atEnd) {
          set({ catchingUp: true })
          void platform.player.pause()
        }
      } else if (catchingUp && status.state === 'playing') {
        set({ catchingUp: false })
      }

      const now = Date.now()
      if (status.state === 'playing' && now - lastSaveAt > SAVE_INTERVAL_MS) {
        lastSaveAt = now
        void saveProgress(episodeId, status.positionSec, status.durationSec, completionThresholdSec)
      }
      if (status.state === 'ended') {
        void saveProgress(episodeId, status.durationSec, status.durationSec, completionThresholdSec)
        void advanceQueue()
      }
    })

    unsubscribeSkip = platform.player.onSkip(() => {
      // Status events already carry the running total; this hook exists for
      // transient UI ("skipped a word") without re-rendering on every tick.
    })
  }

  return {
  episode: null,
  podcast: null,
  spans: [],
  analyzedRanges: [],
  state: 'idle',
  positionSec: 0,
  durationSec: 0,
  skippedSec: 0,
  rate: 1,
  loaded: false,
  preparing: false,
  modelProgress: null,
  catchingUp: false,

  async open(episodeId, autoPlay = true) {
    const platform = getPlatform()

    // Re-opening the episode that is already loaded just resumes it. Running the full
    // open path again would tear down and restart filtering, throwing away the chunk
    // in flight — so a second tap on Play used to reset progress to zero rather than
    // start playback.
    if (get().episode?.id === episodeId && get().loaded && get().state !== 'idle') {
      if (autoPlay) await get().play()
      return
    }

    const settings = await getSettings()
    const episode = await getEpisode(episodeId)
    if (!episode) throw new Error(`unknown episode ${episodeId}`)

    const [podcast, download, progress, profile, overrides] = await Promise.all([
      getPodcast(episode.podcastId),
      getDownload(episodeId),
      getProgress(episodeId),
      getProfileForPodcast(episode.podcastId),
      listWordOverrides(),
    ])

    /*
     * Downloaded episodes play from disk; everything else streams.
     *
     * Downloading is no longer a precondition for playing, only a way to keep an episode
     * offline. Filtering used to force it to be one — transcription needed a local file —
     * but both the player and the transcriber now read streamed audio through one shared
     * cache, so an episode is fetched once whether or not it is ever saved.
     *
     * The file itself is checked, not just the record. A download interrupted before its
     * final rename leaves a `.part` behind, and a record claiming "downloaded" then points
     * at a path that does not exist; streaming is a far better answer to that than the
     * opaque ExoPlayer "Source error" it used to produce.
     */
    const fileKey = download?.fileKey ?? fileKeyFor(episodeId)
    const audioPresent =
      download?.state === 'downloaded' && (await platform.files.exists(fileKey))

    if (!audioPresent && download?.state === 'downloaded') {
      // Record and disk disagree. Stream now, and fetch it again in the background.
      await enqueueDownload(episodeId)
    }

    // Playing something moves it to the front of the queue, pushing everything else
    // down, so position 0 is always what is playing. That makes the queue a single
    // ordered account of what is happening rather than a list that has to be read
    // alongside a separate "and this is playing" — and it means whatever was playing
    // before is still there, one place further down, rather than lost.
    await enqueueEpisode(episodeId, { next: true })

    const startAtSec = progress?.positionSec ?? 0
    const url = audioPresent
      ? await platform.files.toPlayableUrl(fileKey)
      : episode.audioUrl

    unsubscribeStatus?.()
    unsubscribeSkip?.()

    set({
      episode,
      podcast: podcast ?? null,
      spans: [],
      analyzedRanges: [],
      state: 'loading',
      positionSec: startAtSec,
      durationSec: episode.durationSec ?? 0,
      skippedSec: 0,
      rate: settings.playbackRate,
      error: undefined,
      blockedReason: undefined,
      preparing: true,
      modelProgress: null,
      catchingUp: false,
    })

    /*
     * The player is loaded before analysis begins, not after.
     *
     * Loading is what starts the playback service, and `setFilterSpans` is rejected
     * outright while that service does not exist. In the old order every span found
     * during the lead-in was therefore thrown away, and the opening stretch of the
     * episode played completely unfiltered — the UI would report the cuts it had found
     * while the audio sailed straight through them. Spans only started landing once a
     * later background chunk happened to call `onUpdate`.
     *
     * Doing it first also means the audio buffers while the lead-in is transcribed
     * rather than afterwards, which is most of what makes playback start promptly.
     */
    await platform.player.load(
      {
        episodeId,
        url,
        fileKey,
        title: episode.title,
        artist: podcast?.title ?? '',
        artworkUrl: episode.artworkUrl ?? podcast?.artworkUrl,
        durationSec: episode.durationSec,
      },
      startAtSec,
    )
    await platform.player.setRate(settings.playbackRate)
    set({ loaded: true })

    // Analyze a lead-in, then start; the rest is filtered while the audio plays.
    try {
      const { spans, ranges } = await startLiveFilter({
        episode,
        fileKey: fileKeyFor(episodeId),
        profile,
        overrides,
        model: settings.whisperModel,
        startAtSec,
        callbacks: filterCallbacks(episodeId),
      })
      set({ spans, analyzedRanges: ranges, preparing: false, modelProgress: null })
      await platform.player.setFilterSpans(spans, ranges)
    } catch (error) {
      set({
        preparing: false,
        modelProgress: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    attachStatus(episode, settings.completionThresholdSec)

    if (autoPlay) await get().play()
  },

  async reconnect() {
    const platform = getPlatform()
    const snap = await platform.player.getState().catch(() => null)

    if (snap?.running && snap.episodeId) {
      const episode = await getEpisode(snap.episodeId)
      if (episode) {
        const [podcast, map, settings, profile, overrides] = await Promise.all([
          getPodcast(episode.podcastId),
          getFilterMap(episode.id),
          getSettings(),
          getProfileForPodcast(episode.podcastId),
          listWordOverrides(),
        ])

        set({
          episode,
          podcast: podcast ?? null,
          spans: map?.spans ?? [],
          analyzedRanges: mergeRanges(map?.analyzedRanges ?? []),
          state: snap.state ?? 'paused',
          positionSec: snap.positionSec ?? 0,
          durationSec: snap.durationSec || episode.durationSec || 0,
          skippedSec: snap.skippedSec ?? 0,
          rate: settings.playbackRate,
          loaded: true,
          preparing: false,
          modelProgress: null,
          catchingUp: false,
          error: undefined,
        })
        attachStatus(episode, settings.completionThresholdSec)

        // The analysis pipeline died with the previous page; restart it pointed at the
        // live playhead. Playback keeps running while the lead-in re-analyzes — the
        // frontier guards hold it back if it gets ahead of coverage.
        try {
          const { spans, ranges } = await startLiveFilter({
            episode,
            fileKey: fileKeyFor(episode.id),
            profile,
            overrides,
            model: settings.whisperModel,
            startAtSec: snap.positionSec ?? 0,
            callbacks: filterCallbacks(episode.id),
          })
          set({ spans, analyzedRanges: ranges })
          await platform.player.setFilterSpans(spans, ranges)
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
    }

    // The service is gone, but it may know a better resume point than we do: the web
    // layer's own saves freeze whenever the page is backgrounded, and a pause pressed
    // on an earbud never reaches a frozen page at all.
    const saved = snap?.lastSaved
    if (saved) {
      const existing = await getProgress(saved.episodeId)
      if (!existing || (existing.lastPlayedAt ?? 0) < saved.updatedAt) {
        const episode = await getEpisode(saved.episodeId)
        if (episode) {
          const settings = await getSettings()
          await saveProgress(
            saved.episodeId,
            saved.positionSec,
            existing?.durationSec ?? episode.durationSec ?? 0,
            settings.completionThresholdSec,
          )
        }
      }
    }

    await get().restoreLast()
  },

  async applyProfileChange(podcastId) {
    const { episode, loaded, positionSec } = get()
    if (!episode || episode.podcastId !== podcastId || !loaded) return

    const [profile, overrides, settings] = await Promise.all([
      getProfileForPodcast(podcastId),
      listWordOverrides(),
      getSettings(),
    ])

    // A different profile means the running session and its stored map are both stale;
    // startLiveFilter tears them down itself (the profile-mismatch discard) and begins
    // analyzing under the new rules from wherever the playhead is now.
    try {
      const { spans, ranges } = await startLiveFilter({
        episode,
        fileKey: fileKeyFor(episode.id),
        profile,
        overrides,
        model: settings.whisperModel,
        startAtSec: positionSec,
        callbacks: filterCallbacks(episode.id),
      })
      set({ spans, analyzedRanges: ranges })
      await getPlatform().player.setFilterSpans(spans, ranges)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  /**
   * Restores the last episode that was being listened to.
   *
   * Only the display state: what it is, where you were, and the cuts already known from
   * a previous session. Loading the player is left until play is pressed, so launching
   * the app costs nothing — no foreground service, no speech model, no transcription for
   * an episode that may not be the one you came here for.
   */
  async restoreLast() {
    if (get().episode) return

    const recent = await db.progress.orderBy('lastPlayedAt').reverse().limit(10).toArray()
    // Something finished is not "what you were listening to", and neither is an episode
    // that was opened and abandoned in the first few seconds.
    const last = recent.find((row) => !row.played && row.positionSec > 5)
    if (!last) return

    const episode = await getEpisode(last.episodeId)
    if (!episode) return

    const [podcast, map, settings] = await Promise.all([
      getPodcast(episode.podcastId),
      getFilterMap(episode.id),
      getSettings(),
    ])

    // Another episode may have been opened while this was reading from disk.
    if (get().episode) return

    set({
      episode,
      podcast: podcast ?? null,
      spans: map?.spans ?? [],
      analyzedRanges: map?.analyzedRanges ?? [],
      state: 'paused',
      positionSec: last.positionSec,
      durationSec: last.durationSec || episode.durationSec || 0,
      skippedSec: 0,
      rate: settings.playbackRate,
      loaded: false,
      preparing: false,
      modelProgress: null,
      catchingUp: false,
      error: undefined,
    })
  },

  async play() {
    const { episode, loaded, analyzedRanges, positionSec } = get()

    // Restored from a previous session and never actually loaded. Pressing play is the
    // point at which the user has asked for this episode, so open it properly now.
    if (episode && !loaded) {
      await get().open(episode.id, true)
      return
    }

    // Refuse to start into unanalyzed audio; the pipeline is already working on it.
    if (analyzedRanges.length > 0 && !isAnalyzed(analyzedRanges, positionSec)) {
      set({ catchingUp: true })
      maybeResume(positionSec)
      return
    }
    set({ catchingUp: false })
    await getPlatform().player.play()
  },

  async pause() {
    if (!get().loaded) return
    await getPlatform().player.pause()
    const { episode, positionSec, durationSec } = get()
    if (episode) {
      const settings = await getSettings()
      await saveProgress(episode.id, positionSec, durationSec, settings.completionThresholdSec)
    }
  },

  async toggle() {
    const { state } = get()
    if (state === 'playing') await get().pause()
    else await get().play()
  },

  async seek(positionSec) {
    const target = Math.max(0, positionSec)

    // Scrubbing a restored episode moves where it will start from, rather than loading
    // the player to honour a seek nobody has asked to hear yet. Persisted, because the
    // resume point is read back from storage when it is eventually opened.
    const { episode, loaded, durationSec } = get()
    if (episode && !loaded) {
      set({ positionSec: target })
      const settings = await getSettings()
      await saveProgress(episode.id, target, durationSec, settings.completionThresholdSec)
      return
    }

    await getPlatform().player.seek(target)
    set({ positionSec: target })

    // A seek can land anywhere, including audio that was never analyzed. Point the
    // pipeline at the new spot so it starts filling in from there rather than
    // continuing to work ahead of where the user used to be.
    retargetLiveFilter(target)

    const { analyzedRanges } = get()
    if (analyzedRanges.length > 0 && !isAnalyzed(analyzedRanges, target)) {
      set({ catchingUp: true })
      await getPlatform().player.pause()
    } else {
      set({ catchingUp: false })
    }
  },

  async skipForward() {
    const settings = await getSettings()
    await get().seek(get().positionSec + settings.skipForwardSec)
  },

  async skipBack() {
    const settings = await getSettings()
    await get().seek(get().positionSec - settings.skipBackSec)
  },

  async setRate(rate) {
    // Applied to the player at load time, so a restored episode only needs the value.
    if (get().loaded) await getPlatform().player.setRate(rate)
    set({ rate })
  },

  async refreshSpans() {
    const { episode } = get()
    if (!episode) return
    const map = await getFilterMap(episode.id)
    if (!map) return
    if (get().loaded) await getPlatform().player.setFilterSpans(map.spans, map.analyzedRanges)
    set({ spans: map.spans, analyzedRanges: mergeRanges(map.analyzedRanges) })
  },

  /** Tears down playback and stops filtering, so nothing keeps working in the background. */
  async close() {
    stopLiveFilter()
    unsubscribeStatus?.()
    unsubscribeSkip?.()
    unsubscribeStatus = null
    unsubscribeSkip = null
    await getPlatform().player.release()
    set({
      episode: null,
      podcast: null,
      spans: [],
      analyzedRanges: [],
      state: 'idle',
      loaded: false,
      preparing: false,
      catchingUp: false,
    })
  },
  }
})

/**
 * Advances to the next queued episode when one finishes.
 *
 * The queue lives in storage rather than in this store, so it survives a restart the
 * same way the restored episode does — a queue that evaporated when the app was closed
 * would not be worth arranging.
 */
async function advanceQueue() {
  // The episode that just finished is the head, so it comes off first; whatever is then
  // at the front is the one to play.
  const finished = usePlayerStore.getState().episode?.id
  if (finished) await removeFromQueue(finished)

  const next = await headOfQueue()
  if (!next) return
  await usePlayerStore.getState().open(next, true)
}

/** Elapsed listening time with skipped audio removed. */
export function selectFilteredPosition(state: PlayerState): number {
  return toFilteredPosition(state.spans, state.positionSec)
}

export type { Progress }
