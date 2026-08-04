import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimedWord } from '@/core/types'
import { DEFAULT_PROFILES, ENGINE_VERSION, WORDLIST_VERSION } from '@/data/defaults'

/**
 * The ahead-of-time filter pass: a downloaded episode ends up with a complete,
 * profile-stamped map, current work is never redone, and a live listening session
 * always wins the transcriber.
 */

// A word the Standard profile actually flags — mild terms are left in by design.
const transcribe = vi.fn<() => Promise<TimedWord[]>>(async () => [
  { word: 'shit', startSec: 10, endSec: 10.4 },
])
vi.mock('@/platform', () => ({
  getPlatform: () => ({
    transcriber: { transcribe: (...args: unknown[]) => transcribe(...(args as [])) },
  }),
}))

let liveActive = false
vi.mock('./filterDriver', () => ({
  filterPipelineActive: async () => liveActive,
}))

const { db } = await import('@/data/db')
const { prefilterEpisode, prefilterDownloadedBacklog } = await import('./prefilter')

async function seedEpisode(id: string) {
  await db.podcasts.put({
    id: 'p1', feedUrl: 'https://a.example/feed', title: 'Show', author: '', description: '',
    artworkUrl: '', categories: [], explicit: false,
  })
  await db.subscriptions.put({
    podcastId: 'p1', subscribedAt: 1, autoDownload: true, autoDownloadLimit: 3, notifyOnNew: true,
  })
  await db.episodes.put({
    id, podcastId: 'p1', guid: id, title: id, description: '',
    audioUrl: `https://a.example/${id}.mp3`, durationSec: 1800, publishedAt: 0,
    explicit: false, transcripts: [],
  })
  await db.downloads.put({
    episodeId: id, state: 'downloaded', fileKey: `audio/${id}`, bytesDownloaded: 1,
    bytesTotal: 1, startedAt: 0, completedAt: 1, auto: false,
  })
}

/** The queue is fire-and-forget; poll until it settles. */
async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe('prefilter', () => {
  beforeEach(async () => {
    liveActive = false
    transcribe.mockClear()
    await Promise.all(
      [db.podcasts, db.subscriptions, db.episodes, db.downloads, db.filterMaps, db.settings, db.filterProfiles].map(
        (table) => table.clear(),
      ),
    )
    await db.settings.put({ id: 'singleton', ...(await import('@/data/defaults')).DEFAULT_SETTINGS })
    for (const profile of DEFAULT_PROFILES) await db.filterProfiles.put(profile)
  })

  it('writes a complete, profile-stamped map for a downloaded episode', async () => {
    await seedEpisode('e1')

    prefilterEpisode('e1')
    await settled()

    const map = await db.filterMaps.get('e1')
    expect(map?.status).toBe('ready')
    expect(map?.profileId).toBe('standard')
    expect(map?.engineVersion).toBe(ENGINE_VERSION)
    expect(map?.wordlistVersion).toBe(WORDLIST_VERSION)
    // Full coverage: this is what lets playback run start to finish with no live ASR.
    expect(map?.analyzedRanges).toEqual([{ startSec: 0, endSec: 1800 }])
    expect(map?.spans.length).toBeGreaterThan(0)
  })

  it('skips episodes whose map is already current', async () => {
    await seedEpisode('e1')
    prefilterEpisode('e1')
    await settled()
    transcribe.mockClear()

    prefilterEpisode('e1')
    await settled()

    expect(transcribe).not.toHaveBeenCalled()
  })

  it('yields the transcriber to a live session', async () => {
    await seedEpisode('e1')
    liveActive = true

    prefilterEpisode('e1')
    await settled()

    expect(transcribe).not.toHaveBeenCalled()
    expect(await db.filterMaps.get('e1')).toBeUndefined()
  })

  it('sweeps the downloaded backlog', async () => {
    await seedEpisode('e1')
    await seedEpisode('e2')

    await prefilterDownloadedBacklog()
    await settled()

    expect((await db.filterMaps.get('e1'))?.status).toBe('ready')
    expect((await db.filterMaps.get('e2'))?.status).toBe('ready')
  })
})
