import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Episode } from '@/core/types'
import { db } from '@/data/db'
import { clearQueue, listQueue, subscribe } from '@/data/repo'

/**
 * The auto-queue path: a subscription with autoQueue gets its new episodes appended to
 * the queue on refresh, oldest first, without disturbing what is already queued. Against
 * real Dexie because the property under test is queue order.
 */

const refreshAllSubscriptions = vi.fn<() => Promise<unknown[]>>()
vi.mock('@/features/feeds/refresh', () => ({
  fetchFeed: vi.fn(),
  refreshAllSubscriptions: (...args: unknown[]) => refreshAllSubscriptions(...(args as [])),
}))

const enqueueDownload = vi.fn(async () => {})
vi.mock('@/features/downloads/downloadManager', () => ({
  enqueueDownload: (...args: unknown[]) => enqueueDownload(...(args as [])),
  deleteDownload: vi.fn(async () => {}),
}))

const { refreshAndAutoDownload } = await import('./service')

function episode(id: string, publishedAt: number): Episode {
  return {
    id,
    podcastId: 'p1',
    guid: id,
    title: id,
    description: '',
    audioUrl: `https://a.example/${id}.mp3`,
    publishedAt,
    explicit: false,
    transcripts: [],
  }
}

describe('auto-queue on refresh', () => {
  beforeEach(async () => {
    await clearQueue()
    await db.subscriptions.clear()
    await db.episodes.clear()
    refreshAllSubscriptions.mockReset()
    enqueueDownload.mockClear()
  })

  it('appends new episodes oldest-first behind the existing queue', async () => {
    await subscribe('p1', { autoDownload: false, autoQueue: true })
    await db.episodes.bulkAdd([episode('monday', 1), episode('tuesday', 2)])
    await db.queue.add({ episodeId: 'already-there', position: 0, addedAt: 0 })
    refreshAllSubscriptions.mockResolvedValue([
      { podcastId: 'p1', newEpisodeIds: ['tuesday', 'monday'], unchanged: false },
    ])

    await refreshAndAutoDownload()

    expect((await listQueue()).map((item) => item.episodeId)).toEqual([
      'already-there',
      'monday',
      'tuesday',
    ])
    // autoDownload is off; queueing must not have smuggled in downloads.
    expect(enqueueDownload).not.toHaveBeenCalled()
  })

  it('leaves the queue alone for subscriptions that only follow', async () => {
    await subscribe('p1', { autoDownload: false })
    await db.episodes.bulkAdd([episode('monday', 1)])
    refreshAllSubscriptions.mockResolvedValue([
      { podcastId: 'p1', newEpisodeIds: ['monday'], unchanged: false },
    ])

    await refreshAndAutoDownload()

    expect(await listQueue()).toEqual([])
  })
})
