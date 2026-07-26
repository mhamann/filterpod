import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzedRange, FilterSpan } from '@/core/types'

/**
 * Tests for the order in which the player and the filter pipeline are wired up.
 *
 * This is worth pinning down because the failure it guards against is invisible in a
 * browser. On Android `setFilterSpans` is a call into a foreground service that only
 * exists once `load` has started it, so installing spans first silently discarded them
 * and the opening stretch of every episode played unfiltered. The web player has no
 * service and accepted spans at any point, so dev builds looked perfectly fine.
 */

/** Every player call, in order, so the sequence itself can be asserted on. */
const calls: string[] = []

/**
 * Whether the playback service is up.
 *
 * The native plugin starts it from `load` and nowhere else, and rejects every other
 * command until it exists. Modelling that here is the whole point: a mock that quietly
 * accepts spans at any time reproduces the browser's forgiving behaviour, which is what
 * hid this bug in the first place.
 */
let serviceRunning = false

/** The store's status listener, so tests can deliver player events like 'ended'. */
let statusCallback: ((status: unknown) => void) | null = null

const player = {
  load: vi.fn(async () => {
    serviceRunning = true
    calls.push('load')
  }),
  play: vi.fn(async () => {
    calls.push('play')
  }),
  pause: vi.fn(async () => {}),
  seek: vi.fn(async () => {}),
  setRate: vi.fn(async () => {
    calls.push('setRate')
  }),
  setSkipIncrements: vi.fn(async () => {}),
  setFilterSpans: vi.fn(async (spans: FilterSpan[]) => {
    if (!serviceRunning) throw new Error('playback service is not running')
    calls.push(`setFilterSpans:${spans.length}`)
  }),
  onStatus: vi.fn((cb: (s: unknown) => void) => {
    statusCallback = cb
    return () => {}
  }),
  onSkip: vi.fn(() => () => {}),
  release: vi.fn(async () => {}),
}

vi.mock('@/platform', () => ({
  getPlatform: () => ({
    player,
    files: {
      exists: async () => true,
      toPlayableUrl: async (key: string) => `file:///${key}`,
    },
  }),
}))

const episode = {
  id: 'e1',
  podcastId: 'p1',
  guid: 'g1',
  title: 'Test',
  description: '',
  audioUrl: 'https://cdn.example.com/a.mp3',
  durationSec: 3600,
  publishedAt: 0,
  explicit: false,
  transcripts: [],
}

vi.mock('@/data/repo', () => ({
  // Honours the id asked for, so advancing to a *different* episode exercises the real
  // open path rather than open()'s already-current short-circuit.
  getEpisode: async (id: string) => ({ ...episode, id }),
  getPodcast: async () => ({ id: 'p1', title: 'Pod' }),
  getDownload: async () => ({ episodeId: 'e1', fileKey: 'audio/e1', state: 'downloaded' }),
  getProgress: async () => undefined,
  getFilterMap: async () => undefined,
  getProfileForPodcast: async () => ({ id: 'standard', severities: ['strong'], mergeGapSec: 0.3 }),
  listWordOverrides: async () => [],
  getSettings: async () => ({ playbackRate: 1, whisperModel: 'base.en', completionThresholdSec: 60 }),
  saveProgress: async () => {},
  removeFromQueue: async () => {},
  dequeueNext: async () => dequeueNextResult,
}))

/** What the queue hands back when the current episode ends. */
let dequeueNextResult: string | undefined

/** Progress rows the restore path scans, newest first. */
const progressRows: Array<{
  episodeId: string
  positionSec: number
  durationSec: number
  played: boolean
  lastPlayedAt: number
}> = []

vi.mock('@/data/db', () => ({
  db: {
    progress: {
      orderBy: () => ({
        reverse: () => ({ limit: () => ({ toArray: async () => progressRows }) }),
      }),
    },
  },
}))

vi.mock('@/features/downloads/downloadManager', () => ({
  enqueueDownload: async () => {},
  fileKeyFor: (id: string) => `audio/${id}`,
}))

/** A span the lead-in "finds", so it can be traced through to the player. */
const leadInSpan: FilterSpan = {
  startSec: 4,
  endSec: 4.6,
  severity: 'strong',
  category: 'profanity',
  terms: ['x'],
}
const leadInRanges: AnalyzedRange[] = [{ startSec: 0, endSec: 15 }]

vi.mock('@/features/filter/liveFilter', () => ({
  startLiveFilter: vi.fn(async (options: { callbacks: {
    onUpdate(s: FilterSpan[], r: AnalyzedRange[]): void
  } }) => {
    // Mirrors the real pipeline: results are reported as each chunk lands, and the
    // returned value is the state at the moment the lead-in was satisfied.
    options.callbacks.onUpdate([leadInSpan], leadInRanges)
    return { spans: [leadInSpan], ranges: leadInRanges }
  }),
  stopLiveFilter: vi.fn(),
  retargetLiveFilter: vi.fn(),
  maybeResume: vi.fn(),
}))

const { startLiveFilter } = await import('@/features/filter/liveFilter')
const { usePlayerStore } = await import('./playerStore')

describe('opening an episode', () => {
  beforeEach(() => {
    calls.length = 0
    serviceRunning = false
    vi.clearAllMocks()
    usePlayerStore.setState({ episode: null, state: 'idle' })
  })

  it('loads the player before installing any spans', async () => {
    await usePlayerStore.getState().open('e1', false)

    const firstSpans = calls.findIndex((call) => call.startsWith('setFilterSpans'))
    expect(firstSpans).toBeGreaterThan(-1)
    expect(calls.indexOf('load')).toBeLessThan(firstSpans)
  })

  it('delivers spans found during the lead-in to the player', async () => {
    await usePlayerStore.getState().open('e1', false)

    // The regression: these were reported to the UI but never reached the player, so
    // the cuts were counted on screen while the audio played straight through them.
    const accepted = calls.filter((call) => call.startsWith('setFilterSpans'))
    expect(accepted.length).toBeGreaterThan(0)
    expect(usePlayerStore.getState().spans).toContain(leadInSpan)
    expect(usePlayerStore.getState().error).toBeUndefined()
  })

  it('does not start playback before the lead-in is analyzed', async () => {
    await usePlayerStore.getState().open('e1', true)

    // Play may only happen once coverage exists; starting earlier would run the
    // playhead through audio nobody has looked at.
    expect(calls.indexOf('play')).toBeGreaterThan(
      calls.findIndex((call) => call.startsWith('setFilterSpans')),
    )
  })
})

/**
 * Restoring is a display-only operation.
 *
 * The whole point is that opening the app costs nothing: no foreground service, no
 * ~150MB speech model, no transcription for an episode you may not have come back for.
 * If any of that starts on launch the feature has become a battery bug, so these assert
 * on what the player and the filter pipeline were asked to do, not just on what is shown.
 */
describe('restoring the last episode', () => {
  beforeEach(() => {
    calls.length = 0
    serviceRunning = false
    progressRows.length = 0
    vi.clearAllMocks()
    usePlayerStore.setState({ episode: null, state: 'idle', loaded: false })
  })

  it('shows what was playing without touching the player', async () => {
    progressRows.push({
      episodeId: 'e1',
      positionSec: 942,
      durationSec: 3600,
      played: false,
      lastPlayedAt: 10,
    })

    await usePlayerStore.getState().restoreLast()

    const state = usePlayerStore.getState()
    expect(state.episode?.id).toBe('e1')
    expect(state.positionSec).toBe(942)
    expect(state.loaded).toBe(false)
    expect(calls).toEqual([])
    expect(startLiveFilter).not.toHaveBeenCalled()
  })

  it('ignores a finished episode, and one barely started', async () => {
    progressRows.push(
      { episodeId: 'e1', positionSec: 3599, durationSec: 3600, played: true, lastPlayedAt: 30 },
      { episodeId: 'e1', positionSec: 2, durationSec: 3600, played: false, lastPlayedAt: 20 },
    )

    await usePlayerStore.getState().restoreLast()

    expect(usePlayerStore.getState().episode).toBeNull()
  })

  it('opens for real the first time play is pressed', async () => {
    progressRows.push({
      episodeId: 'e1',
      positionSec: 942,
      durationSec: 3600,
      played: false,
      lastPlayedAt: 10,
    })
    await usePlayerStore.getState().restoreLast()

    await usePlayerStore.getState().play()

    // Guards against the recursion this invites: open() short-circuits when the episode
    // is already current, which would hand straight back to play() and round again.
    expect(calls).toContain('load')
    expect(calls).toContain('play')
    expect(usePlayerStore.getState().loaded).toBe(true)
  })
})

describe('the queue', () => {
  beforeEach(() => {
    calls.length = 0
    serviceRunning = false
    progressRows.length = 0
    dequeueNextResult = undefined
    vi.clearAllMocks()
    usePlayerStore.setState({ episode: null, state: 'idle', loaded: false })
  })

  it('plays the next queued episode when one ends', async () => {
    await usePlayerStore.getState().open('e1', false)
    dequeueNextResult = 'e2'
    calls.length = 0

    statusCallback?.({
      state: 'ended',
      positionSec: 3600,
      durationSec: 3600,
      skippedSec: 0,
      buffered: 3600,
    })
    // advanceQueue is fired without being awaited by the listener.
    await vi.waitFor(() => expect(calls).toContain('play'))

    expect(calls.indexOf('load')).toBeLessThan(calls.indexOf('play'))
  })

  it('stops at the end when nothing is queued', async () => {
    await usePlayerStore.getState().open('e1', false)
    dequeueNextResult = undefined
    calls.length = 0

    statusCallback?.({
      state: 'ended',
      positionSec: 3600,
      durationSec: 3600,
      skippedSec: 0,
      buffered: 3600,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(calls).toEqual([])
  })
})
