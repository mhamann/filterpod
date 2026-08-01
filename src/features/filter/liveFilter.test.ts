import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Episode, TimedWord } from '@/core/types'
import { DEFAULT_PROFILES } from '@/data/defaults'
import { analyzedUntil, isAnalyzed } from '@/core/filterMath'

/**
 * Tests for just-in-time filtering.
 *
 * The property that matters most is the safety one: coverage must never claim a stretch
 * that was not actually transcribed, because the player uses coverage to decide what is
 * safe to play. A gap that is wrongly reported as covered plays unfiltered audio.
 */

const transcribe = vi.fn<(req: {
  windows?: Array<{ startSec: number; endSec: number }>
}) => Promise<TimedWord[]>>()
const ensureModel = vi.fn(async () => {})

vi.mock('@/platform', () => ({
  getPlatform: () => ({
    transcriber: {
      transcribe,
      ensureModel,
      isAvailable: async () => true,
      // Already downloaded, so these tests exercise transcription rather than the
      // one-time model fetch.
      isModelReady: async () => true,
    },
    http: { get: vi.fn() },
  }),
}))

const httpGet = vi.fn()
vi.mock('@/features/filter/transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transcript')>()
  return { ...actual, fetchTranscript: (...args: unknown[]) => fetchTranscript(...(args as [])) }
})
const fetchTranscript = vi.fn<() => Promise<unknown>>()

const putFilterMap = vi.fn(async () => {})
const getFilterMap = vi.fn<() => Promise<unknown>>(async () => undefined)
vi.mock('@/data/repo', () => ({
  getFilterMap: (...args: unknown[]) => getFilterMap(...(args as [])),
  putFilterMap: (...args: unknown[]) => putFilterMap(...(args as [])),
}))

vi.mock('@/data/db', () => ({
  db: { filterMaps: { get: async () => undefined } },
}))

const { startLiveFilter, stopLiveFilter, retargetLiveFilter, LIVE_FILTER_TUNING } = await import(
  './liveFilter'
)

const standard = DEFAULT_PROFILES.find((p) => p.id === 'standard')!

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
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
    ...overrides,
  }
}

/** Records every window the pipeline asked to transcribe. */
function requestedWindows() {
  return transcribe.mock.calls.map((call) => call[0].windows![0])
}

const baseOptions = {
  fileKey: 'audio/e1',
  profile: standard,
  overrides: [],
  model: 'base.en',
}

beforeEach(() => {
  stopLiveFilter()
  transcribe.mockReset()
  transcribe.mockResolvedValue([])
  putFilterMap.mockClear()
  getFilterMap.mockReset()
  getFilterMap.mockResolvedValue(undefined)
  httpGet.mockReset()
  fetchTranscript.mockReset()
  fetchTranscript.mockResolvedValue(null)
})

/** An episode advertising a transcript, so the shortcut path is exercised. */
function withTranscript() {
  return episode({
    transcripts: [{ url: 'https://cdn.example.com/t.vtt', type: 'text/vtt' as const }],
  })
}

function cue(startSec: number, endSec: number, text: string) {
  return { startSec, endSec, text }
}

describe('lead-in', () => {
  it('analyzes enough to start, and no more before returning', async () => {
    const { ranges } = await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // Coverage from the start position must reach at least the lead-in.
    expect(analyzedUntil(ranges, 0)).toBeGreaterThanOrEqual(LIVE_FILTER_TUNING.LEAD_IN_SEC)
    // ...but nowhere near the whole 60-minute episode. That is the entire point.
    expect(analyzedUntil(ranges, 0)).toBeLessThan(600)
  })

  it('starts from the resume position rather than the beginning', async () => {
    const { ranges } = await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 1800,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(requestedWindows()[0].startSec).toBe(1800)
    expect(isAnalyzed(ranges, 1800)).toBe(true)
    // Audio before the resume point was never touched; nothing should claim otherwise.
    expect(isAnalyzed(ranges, 60)).toBe(false)
  })

  it('produces contiguous coverage with no gaps between chunks', async () => {
    const { ranges } = await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // A gap wrongly merged into one range would let the player run over unchecked audio.
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startSec).toBe(0)
  })
})

describe('spans found during the lead-in', () => {
  it('reports cuts from the analyzed region', async () => {
    transcribe.mockResolvedValue([{ word: 'fuvg', startSec: 10, endSec: 10.4 }])

    const { spans } = await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(spans.length).toBeGreaterThan(0)
    expect(spans[0].terms).toContain('fuvg')
  })
})

describe('restarting', () => {
  // Regression: on device, tapping Play twice cancelled the in-flight chunk and
  // restarted from zero. Chunks take tens of seconds, so it never finished — the UI
  // sat at "Filtering 0%" indefinitely.
  it('does not tear down a session already filtering the same episode', async () => {
    const ep = episode()
    await startLiveFilter({
      ...baseOptions,
      episode: ep,
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    const callsAfterFirst = transcribe.mock.calls.length

    // Second open of the same episode, as a second tap on Play would do.
    await startLiveFilter({
      ...baseOptions,
      episode: ep,
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // No repeat of the lead-in: work already done is kept, not redone from zero.
    expect(transcribe.mock.calls.length).toBe(callsAfterFirst)
  })

  it('does restart when a different episode is opened', async () => {
    await startLiveFilter({
      ...baseOptions,
      episode: episode({ id: 'e1' }),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    const callsAfterFirst = transcribe.mock.calls.length

    await startLiveFilter({
      ...baseOptions,
      episode: episode({ id: 'e2' }),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(transcribe.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('restarts when the filter profile changes', async () => {
    const ep = episode()
    const family = DEFAULT_PROFILES.find((p) => p.id === 'family')!

    await startLiveFilter({
      ...baseOptions,
      episode: ep,
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    const callsAfterFirst = transcribe.mock.calls.length

    // A stricter profile must re-examine the audio; reusing the session would keep
    // the old profile's results.
    await startLiveFilter({
      ...baseOptions,
      profile: family,
      episode: ep,
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(transcribe.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})

describe('seeking', () => {
  it('re-targets analysis to the new position', async () => {
    await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    const before = requestedWindows().length

    retargetLiveFilter(2400)
    await vi.waitFor(() => expect(requestedWindows().length).toBeGreaterThan(before))
    stopLiveFilter()

    // Work after the seek must start at the new spot, not continue from the old one.
    expect(requestedWindows().at(-1)!.startSec).toBeGreaterThanOrEqual(2400)
  })
})

/**
 * A failed chunk is a genuine conflict between the two things this module guarantees.
 *
 * Claiming coverage for audio that was never transcribed lets unfiltered speech through.
 * Refusing to ever claim it walls the playhead in behind the failure, because the player
 * will not cross unanalyzed audio — the episode stops dead at that second and no amount
 * of waiting or pressing play gets past it.
 *
 * The resolution is to treat a first failure as probably transient and retry, and to give
 * up only once a stretch has proved it will not transcribe — reporting an error rather
 * than doing it quietly. An earlier version instead moved the cursor past the failure
 * immediately, which produced the worst of both: a permanent hole in coverage that the
 * pump then worked *ahead* of, so the playhead stayed pinned in front of a gap nothing
 * would ever come back and fill.
 */
describe('failure handling', () => {
  // Retries sleep between attempts, so these tests drive the clock by hand.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Runs a startLiveFilter call to completion under fake timers. */
  async function run(options: Parameters<typeof startLiveFilter>[0]) {
    const promise = startLiveFilter(options)
    await vi.runAllTimersAsync()
    return promise
  }

  it('retries a failed chunk rather than leaving a hole behind it', async () => {
    transcribe.mockRejectedValueOnce(new Error('decode failed'))
    transcribe.mockResolvedValue([])
    const errors: string[] = []

    await run({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: (m) => errors.push(m) },
    })
    stopLiveFilter()

    expect(errors).toContain('decode failed')
    const windows = requestedWindows()
    // The retry covers the same audio; skipping ahead is what left the gap.
    expect(windows[1]).toEqual(windows[0])
  })

  it('claims no coverage while a failure could still be transient', async () => {
    transcribe.mockRejectedValueOnce(new Error('decode failed'))
    transcribe.mockRejectedValueOnce(new Error('decode failed'))
    transcribe.mockResolvedValue([])

    const { ranges } = await run({
      ...baseOptions,
      episode: episode({ durationSec: 120 }),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // One failure must never be enough to call a stretch examined.
    const firstAttempt = requestedWindows()[0]
    expect(isAnalyzed(ranges, firstAttempt.startSec + 1)).toBe(true)
    expect(transcribe.mock.calls.length).toBeGreaterThan(1)
  })

  it('gives up on a chunk that keeps failing, so playback is not walled in', async () => {
    transcribe.mockRejectedValue(new Error('decode failed'))
    const errors: string[] = []

    const { ranges } = await run({
      ...baseOptions,
      episode: episode({ durationSec: 120 }),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: (m) => errors.push(m) },
    })
    stopLiveFilter()

    // Abandoned, so the playhead can move — but never silently.
    expect(isAnalyzed(ranges, 1)).toBe(true)
    expect(errors).toContain('decode failed')
  })

  it('abandons a chunk that hangs, instead of wedging the pipeline', async () => {
    // A hung network read produces neither result nor error. The pump used to wait on
    // it forever — no coverage updates, play refusing at the frontier, a frozen-looking
    // app. The watchdog turns silence into an ordinary failure.
    transcribe.mockImplementation(() => new Promise(() => {}))
    let liveRanges: Array<{ startSec: number; endSec: number }> = []
    const errors: string[] = []

    await run({
      ...baseOptions,
      episode: episode({ durationSec: 60 }),
      startAtSec: 0,
      callbacks: {
        onUpdate: (_spans, ranges) => { liveRanges = ranges },
        onError: (m) => errors.push(m),
      },
    })
    stopLiveFilter()

    expect(errors.some((m) => m.includes('timed out'))).toBe(true)
    // Abandoned in-session, so the playhead is free again.
    expect(isAnalyzed(liveRanges, 1)).toBe(true)
  })

  it('never persists an abandoned stretch as analyzed', async () => {
    // A mixed session: the middle chunk fails permanently, its neighbours succeed.
    transcribe.mockImplementation(async (req) => {
      if (req.windows![0].startSec === 15) throw new Error('decode failed')
      return []
    })

    // The abandonment happens in the background pump, after the lead-in resolves, so
    // the live update stream is where its effect is visible.
    let liveRanges: Array<{ startSec: number; endSec: number }> = []
    await run({
      ...baseOptions,
      episode: episode({ durationSec: 120 }),
      startAtSec: 0,
      callbacks: { onUpdate: (_spans, ranges) => { liveRanges = ranges }, onError: () => {} },
    })
    stopLiveFilter()

    // In-session the abandoned stretch counts as analyzed, or the episode stops dead —
    expect(isAnalyzed(liveRanges, 20)).toBe(true)

    // — but what was written to storage must not contain it. Persisting the lie is
    // how one transient network failure became a region that was never examined
    // again, and played a profanity to a real listener.
    const persisted = putFilterMap.mock.calls.map((call) => (call as unknown[])[0] as {
      analyzedRanges: Array<{ startSec: number; endSec: number }>
    })
    expect(persisted.length).toBeGreaterThan(0)
    const last = persisted.at(-1)!
    expect(isAnalyzed(last.analyzedRanges, 5)).toBe(true)   // real work is kept
    expect(isAnalyzed(last.analyzedRanges, 20)).toBe(false) // the lie is not
  })
})

describe('publisher transcripts', () => {
  it('settles the episode outright from word-level timings, with no ASR', async () => {
    fetchTranscript.mockResolvedValue({
      cues: [],
      words: [
        { word: 'hello', startSec: 5, endSec: 5.3 },
        { word: 'fuvg', startSec: 9, endSec: 9.4 },
      ],
    })

    const { spans, ranges } = await startLiveFilter({
      ...baseOptions,
      episode: withTranscript(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(transcribe).not.toHaveBeenCalled()
    expect(spans).toHaveLength(1)
    // Fully settled, so playback is unrestricted.
    expect(isAnalyzed(ranges, 3599)).toBe(true)
  })

  it('declares an episode clean from cues alone, with no ASR', async () => {
    fetchTranscript.mockResolvedValue({
      words: null,
      cues: [cue(0, 30, 'a perfectly pleasant conversation'), cue(30, 60, 'about bread')],
    })

    const { ranges } = await startLiveFilter({
      ...baseOptions,
      episode: withTranscript(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(transcribe).not.toHaveBeenCalled()
    expect(isAnalyzed(ranges, 3599)).toBe(true)
  })

  it('marks clean cue regions analyzed and sends ASR straight to the suspect window', async () => {
    fetchTranscript.mockResolvedValue({
      words: null,
      cues: [
        cue(0, 900, 'entirely fine'),
        cue(900, 904, 'oh fuvg did you see that'),
        cue(904, 1500, 'fine again'),
      ],
    })

    const { ranges } = await startLiveFilter({
      ...baseOptions,
      episode: withTranscript(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // The clean stretch before the flagged cue is analyzed without transcribing it.
    expect(isAnalyzed(ranges, 300)).toBe(true)
    // The flagged cue is NOT — it is exactly what still needs a closer look.
    expect(isAnalyzed(ranges, 901)).toBe(false)

    // And nothing is transcribed yet: fifteen clean minutes outruns even the widened
    // lead target, so the suspect window waits until the playhead draws near.
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('transcribes the suspect window once the playhead approaches it', async () => {
    fetchTranscript.mockResolvedValue({
      words: null,
      cues: [
        cue(0, 600, 'entirely fine'),
        cue(600, 604, 'oh fuvg did you see that'),
        cue(604, 1200, 'fine again'),
      ],
    })

    await startLiveFilter({
      ...baseOptions,
      episode: withTranscript(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })

    // Move the playhead up to the clean/suspect boundary.
    retargetLiveFilter(590)
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    stopLiveFilter()

    // ASR skipped the ten clean minutes and went straight to the suspect window.
    expect(requestedWindows()[0].startSec).toBeGreaterThan(500)
  })
})

describe('filtering disabled', () => {
  it('marks the episode fully analyzed and does no work', async () => {
    const off = DEFAULT_PROFILES.find((p) => p.id === 'off')!

    const { ranges, spans } = await startLiveFilter({
      ...baseOptions,
      profile: off,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(transcribe).not.toHaveBeenCalled()
    expect(spans).toEqual([])
    // Coverage spans the episode so the player imposes no restriction.
    expect(isAnalyzed(ranges, 3599)).toBe(true)
  })

  it('ignores stored spans and persists nothing, so no other profile inherits its coverage', async () => {
    const off = DEFAULT_PROFILES.find((p) => p.id === 'off')!
    // A map from an earlier session under a filtering profile: real spans, real coverage.
    getFilterMap.mockResolvedValue({
      episodeId: 'e1',
      status: 'partial',
      spans: [{ startSec: 10, endSec: 11, severity: 'strong', category: 'profanity' }],
      analyzedRanges: [{ startSec: 0, endSec: 120 }],
      source: 'asr',
      engineVersion: (await import('@/data/defaults')).ENGINE_VERSION,
      wordlistVersion: (await import('@/data/defaults')).WORDLIST_VERSION,
      profileId: 'standard',
      progress: 0.1,
    })

    const { spans } = await startLiveFilter({
      ...baseOptions,
      profile: off,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // Off means off: a span built under another profile must not keep cutting.
    expect(spans).toEqual([])
    // And nothing may be written: a persisted "fully analyzed, no spans" map would be
    // believed by the next profile this show is switched to.
    expect(putFilterMap).not.toHaveBeenCalled()
  })
})

describe('per-profile maps', () => {
  it('discards a stored map built under a different profile', async () => {
    const defaults = await import('@/data/defaults')
    getFilterMap.mockResolvedValue({
      episodeId: 'e1',
      status: 'partial',
      spans: [{ startSec: 10, endSec: 11, severity: 'mild', category: 'blasphemy' }],
      analyzedRanges: [{ startSec: 0, endSec: 1200 }],
      source: 'asr',
      engineVersion: defaults.ENGINE_VERSION,
      wordlistVersion: defaults.WORDLIST_VERSION,
      profileId: 'family',
      progress: 0.33,
    })

    const { ranges, spans } = await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // Family's coverage must not vouch for Standard: it flagged different words. The
    // session starts over — old spans gone, coverage rebuilt from the playhead.
    expect(spans.some((span) => span.startSec === 10)).toBe(false)
    expect(analyzedUntil(ranges, 0)).toBeLessThan(1200)
  })

  it('keeps a stored map built under the same profile', async () => {
    const defaults = await import('@/data/defaults')
    getFilterMap.mockResolvedValue({
      episodeId: 'e1',
      status: 'partial',
      spans: [{ startSec: 10, endSec: 11, severity: 'strong', category: 'profanity' }],
      analyzedRanges: [{ startSec: 0, endSec: 1200 }],
      source: 'asr',
      engineVersion: defaults.ENGINE_VERSION,
      wordlistVersion: defaults.WORDLIST_VERSION,
      profileId: 'standard',
      progress: 0.33,
    })

    const { spans } = await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    expect(spans.some((span) => span.startSec === 10)).toBe(true)
  })
})
