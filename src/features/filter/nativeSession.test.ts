import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzedRange, Episode, FilterSpan } from '@/core/types'
import type { NativeFilterSession } from '@/platform/types'
import { DEFAULT_PROFILES, ENGINE_VERSION, WORDLIST_VERSION } from '@/data/defaults'

/**
 * The web-side half of the native filter driver: engine snapshots land in Dexie
 * (persistable coverage only), seeds come from a still-valid stored map, and a
 * session already running this episode is re-adopted rather than restarted.
 */

interface FakeLiveFilter {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  retarget: ReturnType<typeof vi.fn>
  isEngineActive: ReturnType<typeof vi.fn>
  onUpdate(cb: (session: NativeFilterSession) => void): () => void
  onModelProgress(cb: (fraction: number) => void): () => void
  onError(cb: (message: string) => void): () => void
}

let updateListeners: Array<(session: NativeFilterSession) => void> = []
const fakeLiveFilter: FakeLiveFilter = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  retarget: vi.fn(async () => {}),
  isEngineActive: vi.fn(async () => false),
  onUpdate(cb) {
    updateListeners.push(cb)
    return () => {}
  },
  onModelProgress() {
    return () => {}
  },
  onError() {
    return () => {}
  },
}

vi.mock('@/platform', () => ({
  getPlatform: () => ({ liveFilter: fakeLiveFilter }),
}))

const { db } = await import('@/data/db')
const { startNativeSession, stopNativeSession, nativeSessionActive } = await import(
  './nativeSession'
)

const standard = DEFAULT_PROFILES.find((p) => p.id === 'standard')!

function makeEpisode(id: string): Episode {
  return {
    id,
    podcastId: 'p1',
    guid: id,
    title: id,
    description: '',
    audioUrl: `https://a.example/${id}.mp3`,
    durationSec: 1800,
    publishedAt: 0,
    explicit: false,
    transcripts: [],
  }
}

function emit(session: NativeFilterSession) {
  for (const cb of [...updateListeners]) cb(session)
}

function snapshot(overrides: Partial<NativeFilterSession> = {}): NativeFilterSession {
  return {
    episodeId: 'e1',
    profileId: 'standard',
    spans: [],
    analyzedRanges: [{ startSec: 0, endSec: 60 }],
    persistableRanges: [{ startSec: 0, endSec: 60 }],
    durationSec: 1800,
    source: 'asr',
    reachedEnd: false,
    ...overrides,
  }
}

async function startSession(episode: Episode, startAtSec = 0) {
  return startNativeSession({
    episode,
    fileKey: `audio/${episode.id}`,
    profile: standard,
    overrides: [],
    model: 'base.en',
    startAtSec,
    callbacks: { onUpdate: () => {}, onError: () => {} },
  })
}

describe('nativeSession', () => {
  beforeEach(async () => {
    await stopNativeSession()
    vi.clearAllMocks()
    // Persists triggered by a previous test's snapshot are fire-and-forget; let them
    // land before clearing, or they resurrect the map after the wipe.
    await new Promise((resolve) => setTimeout(resolve, 25))
    await db.filterMaps.clear()
  })

  it('starts the engine and resolves once the lead-in is covered', async () => {
    const pending = startSession(makeEpisode('e1'))
    // The engine's first snapshot after the initial chunk covers the lead-in.
    await vi.waitFor(() => expect(fakeLiveFilter.start).toHaveBeenCalled())
    emit(snapshot())

    const { ranges } = await pending
    expect(ranges).toEqual([{ startSec: 0, endSec: 60 }])
    expect(nativeSessionActive()).toBe(true)

    const config = fakeLiveFilter.start.mock.calls[0][0]
    expect(config.episodeId).toBe('e1')
    expect(config.profileId).toBe('standard')
    expect(config.engineVersion).toBe(ENGINE_VERSION)
    // The wordlist crosses the bridge pre-compiled; the engine never compiles one.
    expect(config.wordlist.exact.length).toBeGreaterThan(0)
  })

  it('mirrors engine snapshots into Dexie, persisting only honest coverage', async () => {
    const pending = startSession(makeEpisode('e1'))
    await vi.waitFor(() => expect(fakeLiveFilter.start).toHaveBeenCalled())

    const spans: FilterSpan[] = [
      { startSec: 10, endSec: 11, severity: 'strong', category: 'profanity', terms: ['x'] },
    ]
    // Playable coverage includes an abandoned stretch (60-90s) that must not persist.
    emit(
      snapshot({
        spans,
        analyzedRanges: [{ startSec: 0, endSec: 90 }],
        persistableRanges: [{ startSec: 0, endSec: 60 }],
      }),
    )
    const { ranges } = await pending
    expect(ranges).toEqual([{ startSec: 0, endSec: 90 }])

    await vi.waitFor(async () => {
      const map = await db.filterMaps.get('e1')
      expect(map?.analyzedRanges).toEqual([{ startSec: 0, endSec: 60 }])
      expect(map?.spans).toEqual(spans)
      expect(map?.status).toBe('partial')
      expect(map?.profileId).toBe('standard')
    })

    // The final snapshot flips the map to ready.
    emit(
      snapshot({
        spans,
        analyzedRanges: [{ startSec: 0, endSec: 1800 }],
        persistableRanges: [{ startSec: 0, endSec: 1800 }],
        reachedEnd: true,
      }),
    )
    await vi.waitFor(async () => {
      expect((await db.filterMaps.get('e1'))?.status).toBe('ready')
    })
  })

  it('seeds the engine from a still-valid stored map and discards a stale one', async () => {
    const seededRanges: AnalyzedRange[] = [{ startSec: 0, endSec: 300 }]
    await db.filterMaps.put({
      episodeId: 'e1',
      status: 'partial',
      spans: [],
      analyzedRanges: seededRanges,
      source: 'asr',
      engineVersion: ENGINE_VERSION,
      wordlistVersion: WORDLIST_VERSION,
      profileId: 'standard',
      progress: 0.1,
      createdAt: 1,
      skippedSec: 0,
    })

    const pending = startSession(makeEpisode('e1'))
    await vi.waitFor(() => expect(fakeLiveFilter.start).toHaveBeenCalled())
    // Seed coverage already spans the lead-in, so start resolves without any snapshot.
    const { ranges } = await pending
    expect(ranges).toEqual(seededRanges)
    expect(fakeLiveFilter.start.mock.calls[0][0].seedRanges).toEqual(seededRanges)

    // A map built under another profile vouches for audio this profile never examined.
    await stopNativeSession()
    vi.clearAllMocks()
    await db.filterMaps.update('e1', { profileId: 'family' })
    const second = startSession(makeEpisode('e1'))
    await vi.waitFor(() => expect(fakeLiveFilter.start).toHaveBeenCalled())
    expect(fakeLiveFilter.start.mock.calls[0][0].seedRanges).toEqual([])
    emit(snapshot())
    await second
  })

  it('re-adopts a running session with a retarget instead of a restart', async () => {
    const episode = makeEpisode('e1')
    const pending = startSession(episode)
    await vi.waitFor(() => expect(fakeLiveFilter.start).toHaveBeenCalled())
    emit(snapshot())
    await pending

    fakeLiveFilter.start.mockClear()
    await startSession(episode, 120)

    expect(fakeLiveFilter.start).not.toHaveBeenCalled()
    expect(fakeLiveFilter.retarget).toHaveBeenCalledWith(120)
  })

  it('with filtering off, stops the engine, allows everything, persists nothing', async () => {
    const off = { ...standard, id: 'off', severities: [] }
    const { spans, ranges } = await startNativeSession({
      episode: makeEpisode('e1'),
      fileKey: 'audio/e1',
      profile: off,
      overrides: [],
      model: 'base.en',
      startAtSec: 0,
      callbacks: { onUpdate: () => {}, onError: () => {} },
    })

    expect(spans).toEqual([])
    expect(ranges).toEqual([{ startSec: 0, endSec: 1800 }])
    expect(fakeLiveFilter.start).not.toHaveBeenCalled()
    expect(fakeLiveFilter.stop).toHaveBeenCalled()
    expect(nativeSessionActive()).toBe(false)
    expect(await db.filterMaps.get('e1')).toBeUndefined()
  })
})
