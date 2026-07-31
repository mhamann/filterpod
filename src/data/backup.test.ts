import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The wipe-and-heal round trip. The scenario is real: Chromium evicted the entire
 * IndexedDB on a full phone, and the app came up amnesiac. The backup lives outside
 * WebView storage, so this pins that everything unreconstructable comes back — and
 * that a library emptied on purpose stays empty.
 */

const stored = new Map<string, ArrayBuffer>()
vi.mock('@/platform', () => ({
  getPlatform: () => ({
    files: {
      write: async (key: string, data: Blob) => {
        stored.set(key, await data.arrayBuffer())
        return { key, size: 0 }
      },
      read: async (key: string) => {
        const bytes = stored.get(key)
        if (!bytes) throw new Error('missing')
        return bytes
      },
    },
  }),
}))

const { db } = await import('./db')
const { writeLibraryBackup, restoreLibraryBackupIfEmpty } = await import('./backup')

async function clearAll() {
  await Promise.all(
    [db.podcasts, db.subscriptions, db.progress, db.queue, db.settings, db.filterProfiles, db.wordOverrides].map(
      (table) => table.clear(),
    ),
  )
}

describe('library backup', () => {
  beforeEach(async () => {
    stored.clear()
    await clearAll()
  })

  it('puts a wiped library back together', async () => {
    await db.podcasts.add({
      id: 'p1', feedUrl: 'https://a.example/feed', title: 'Show', author: '', description: '',
      artworkUrl: '', categories: [], explicit: false,
    })
    await db.subscriptions.add({
      podcastId: 'p1', subscribedAt: 1, autoDownload: false, autoDownloadLimit: 3,
      notifyOnNew: true, autoQueue: true, filterProfileId: 'off',
    })
    await db.progress.add({
      episodeId: 'e1', positionSec: 120, durationSec: 300, played: false, lastPlayedAt: 2,
    })
    await db.queue.add({ episodeId: 'e1', position: 0, addedAt: 3 })
    await db.wordOverrides.add({ term: 'crikey', action: 'block', addedAt: 4 })

    await writeLibraryBackup()
    await clearAll()

    expect(await restoreLibraryBackupIfEmpty()).toBe(true)
    expect((await db.subscriptions.get('p1'))?.filterProfileId).toBe('off')
    expect((await db.podcasts.get('p1'))?.feedUrl).toBe('https://a.example/feed')
    expect((await db.progress.get('e1'))?.positionSec).toBe(120)
    expect((await db.queue.get('e1'))?.position).toBe(0)
    expect((await db.wordOverrides.get('crikey'))?.action).toBe('block')
  })

  it('leaves a deliberately emptied library empty', async () => {
    // The last unsubscribe rewrites the backup with zero subscriptions...
    await writeLibraryBackup()
    // ...so a later empty-database launch has nothing to resurrect.
    expect(await restoreLibraryBackupIfEmpty()).toBe(false)
    expect(await db.subscriptions.count()).toBe(0)
  })

  it('does not restore over a library that has subscriptions', async () => {
    await db.subscriptions.add({
      podcastId: 'p1', subscribedAt: 1, autoDownload: false, autoDownloadLimit: 3, notifyOnNew: true,
    })
    await writeLibraryBackup()
    await db.subscriptions.put({
      podcastId: 'p2', subscribedAt: 5, autoDownload: false, autoDownloadLimit: 3, notifyOnNew: true,
    })

    expect(await restoreLibraryBackupIfEmpty()).toBe(false)
    expect(await db.subscriptions.get('p2')).toBeTruthy()
  })
})
