import { create } from 'zustand'
import type { AnalyzedRange, Episode, FilterSpan, Podcast, Progress } from '@/core/types'
import { analyzedUntil, isAnalyzed, mergeRanges, toFilteredPosition } from '@/core/filterMath'
import { getPlatform } from '@/platform'
import {
  getDownload,
  getEpisode,
  getFilterMap,
  getPodcast,
  getProfileForPodcast,
  getProgress,
  getSettings,
  listWordOverrides,
  saveProgress,
} from '@/data/repo'
import { enqueueDownload, fileKeyFor } from '@/features/downloads/downloadManager'
import {
  maybeResume,
  retargetLiveFilter,
  startLiveFilter,
  stopLiveFilter,
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
  queue: string[]

  open(episodeId: string, autoPlay?: boolean): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  toggle(): Promise<void>
  seek(positionSec: number): Promise<void>
  skipForward(): Promise<void>
  skipBack(): Promise<void>
  setRate(rate: number): Promise<void>
  /** Re-reads the filter map, e.g. after a prefilter pass finishes for this episode. */
  refreshSpans(): Promise<void>
  enqueue(episodeId: string): void
  clearQueue(): void
  close(): Promise<void>
}

let unsubscribeStatus: (() => void) | null = null
let unsubscribeSkip: (() => void) | null = null
let lastSaveAt = 0

export const usePlayerStore = create<PlayerState>((set, get) => ({
  episode: null,
  podcast: null,
  spans: [],
  analyzedRanges: [],
  state: 'idle',
  positionSec: 0,
  durationSec: 0,
  skippedSec: 0,
  rate: 1,
  preparing: false,
  modelProgress: null,
  catchingUp: false,
  queue: [],

  async open(episodeId, autoPlay = true) {
    const platform = getPlatform()

    // Re-opening the episode that is already loaded just resumes it. Running the full
    // open path again would tear down and restart filtering, throwing away the chunk
    // in flight — so a second tap on Play used to reset progress to zero rather than
    // start playback.
    if (get().episode?.id === episodeId && get().state !== 'idle') {
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

    // Transcription reads local audio, so the episode has to be on disk first.
    // Downloading is cheap (network, not CPU); it is the filtering that is expensive,
    // and that is what now happens on demand.
    //
    // The file itself is checked, not just the record. A download interrupted before
    // its final rename leaves a `.part` behind, and a record claiming "downloaded"
    // then points at a path that does not exist — which surfaces as an opaque
    // ExoPlayer "Source error" rather than anything a user could act on.
    const fileKey = download?.fileKey ?? fileKeyFor(episodeId)
    const audioPresent =
      download?.state === 'downloaded' && (await platform.files.exists(fileKey))

    if (!audioPresent) {
      if (download?.state === 'downloaded') {
        // Record and disk disagree; re-download rather than leaving it unplayable.
        await enqueueDownload(episodeId)
      }
      set({
        blockedReason:
          download?.state === 'downloaded'
            ? 'That download is incomplete — fetching it again.'
            : 'Download this episode first.',
      })
      setTimeout(() => {
        if (get().blockedReason) set({ blockedReason: undefined })
      }, 5000)
      return
    }

    const startAtSec = progress?.positionSec ?? 0
    const url = await platform.files.toPlayableUrl(fileKey)

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

    // Analyze a lead-in, then start; the rest is filtered while the audio plays.
    try {
      const { spans, ranges } = await startLiveFilter({
        episode,
        fileKey: fileKeyFor(episodeId),
        profile,
        overrides,
        model: settings.whisperModel,
        startAtSec,
        callbacks: {
          onUpdate: (nextSpans, nextRanges) => {
            // Only the currently open episode may drive the player.
            if (get().episode?.id !== episodeId) return
            set({ spans: nextSpans, analyzedRanges: nextRanges })
            void platform.player.setFilterSpans(nextSpans)
            // New coverage may have unblocked a playhead that was waiting.
            if (get().catchingUp) void get().play()
          },
          onModelProgress: (fraction) => {
            if (get().episode?.id !== episodeId) return
            set({ modelProgress: fraction < 1 ? fraction : null })
          },
          onError: (message) => {
            if (get().episode?.id === episodeId) set({ error: message })
          },
        },
      })
      set({ spans, analyzedRanges: ranges, preparing: false, modelProgress: null })
      await platform.player.setFilterSpans(spans)
    } catch (error) {
      set({
        preparing: false,
        modelProgress: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    unsubscribeStatus = platform.player.onStatus((status) => {
      set({
        state: status.state,
        positionSec: status.positionSec,
        durationSec: status.durationSec || get().durationSec,
        skippedSec: status.skippedSec,
        error: status.error,
      })

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
        void saveProgress(
          episodeId,
          status.positionSec,
          status.durationSec,
          settings.completionThresholdSec,
        )
      }
      if (status.state === 'ended') {
        void saveProgress(
          episodeId,
          status.durationSec,
          status.durationSec,
          settings.completionThresholdSec,
        )
        void advanceQueue()
      }
    })

    unsubscribeSkip = platform.player.onSkip(() => {
      // Status events already carry the running total; this hook exists for
      // transient UI ("skipped a word") without re-rendering on every tick.
    })

    if (autoPlay) await get().play()
  },

  async play() {
    const { analyzedRanges, positionSec } = get()
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
    await getPlatform().player.setRate(rate)
    set({ rate })
  },

  async refreshSpans() {
    const { episode } = get()
    if (!episode) return
    const map = await getFilterMap(episode.id)
    if (!map) return
    await getPlatform().player.setFilterSpans(map.spans)
    set({ spans: map.spans, analyzedRanges: mergeRanges(map.analyzedRanges) })
  },

  enqueue(episodeId) {
    set({ queue: [...get().queue, episodeId] })
  },

  clearQueue() {
    set({ queue: [] })
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
      preparing: false,
      catchingUp: false,
    })
  },
}))

/** Advances to the next queued episode when one finishes. */
async function advanceQueue() {
  const { queue } = usePlayerStore.getState()
  if (queue.length === 0) return
  const [next, ...rest] = queue
  usePlayerStore.setState({ queue: rest })
  await usePlayerStore.getState().open(next, true)
}

/** Elapsed listening time with skipped audio removed. */
export function selectFilteredPosition(state: PlayerState): number {
  return toFilteredPosition(state.spans, state.positionSec)
}

export type { Progress }
