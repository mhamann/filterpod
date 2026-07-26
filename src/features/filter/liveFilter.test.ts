import { beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('@/data/repo', () => ({
  getFilterMap: async () => undefined,
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

describe('failure handling', () => {
  it('advances past a chunk that fails rather than retrying it forever', async () => {
    transcribe.mockRejectedValueOnce(new Error('decode failed'))
    transcribe.mockResolvedValue([])
    const errors: string[] = []

    await startLiveFilter({
      ...baseOptions,
      episode: episode(),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: (m) => errors.push(m) },
    })
    stopLiveFilter()

    expect(errors).toContain('decode failed')
    const windows = requestedWindows()
    // The second attempt must be a different window, not the same one again.
    expect(windows[1].startSec).toBeGreaterThan(windows[0].startSec)
  })

  it('does not mark a failed chunk as analyzed', async () => {
    transcribe.mockRejectedValue(new Error('decode failed'))

    const { ranges } = await startLiveFilter({
      ...baseOptions,
      episode: episode({ durationSec: 120 }),
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })
    stopLiveFilter()

    // Nothing was successfully transcribed, so nothing may be claimed as safe.
    expect(ranges).toEqual([])
    expect(isAnalyzed(ranges, 10)).toBe(false)
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
        cue(0, 600, 'entirely fine'),
        cue(600, 604, 'oh fuvg did you see that'),
        cue(604, 1200, 'fine again'),
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
    expect(isAnalyzed(ranges, 601)).toBe(false)

    // And nothing is transcribed yet: ten clean minutes is already far more cushion
    // than the pipeline tries to keep, so the suspect window waits until it is near.
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
})
