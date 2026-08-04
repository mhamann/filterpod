import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The wipe-and-heal round trip. The scenario is real: Chromium evicted the entire
 * IndexedDB on a full phone, and the app came up amnesiac. The backup lives outside
 * WebView storage, so this pins that everything unreconstructable comes back — and
 * that a library emptied on purpose stays empty.
 */

const stored = new Map<string, ArrayBuffer>()
let documentToOpen: string | null = null
let savedDocument: { fileName: string; mimeType: string; contents: string } | null = null
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
    documents: {
      save: async (fileName: string, mimeType: string, contents: string) => {
        savedDocument = { fileName, mimeType, contents }
        return true
      },
      open: async () => documentToOpen,
    },
  }),
}))

const { db } = await import('./db')
const {
  exportLibraryBackup,
  importLibraryBackup,
  restoreLibraryBackupIfEmpty,
  startLibraryBackupWatcher,
  writeLibraryBackup,
} = await import('./backup')

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
    documentToOpen = null
    savedDocument = null
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
    await db.wordOverrides.add({
      term: 'crikey',
      action: 'block',
      severity: 'mild',
      category: 'custom',
      createdAt: 4,
    })

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

  it('exports the same compact snapshot to a user-owned JSON document', async () => {
    await db.podcasts.add({
      id: 'p1', feedUrl: 'https://a.example/feed', title: 'Show', author: '', description: '',
      artworkUrl: '', categories: [], explicit: false,
    })
    await db.subscriptions.add({
      podcastId: 'p1', subscribedAt: 1, autoDownload: false, autoDownloadLimit: 3,
      notifyOnNew: true,
    })

    expect(await exportLibraryBackup()).toBe(true)
    expect(savedDocument?.fileName).toMatch(/^filterpod-backup-\d{4}-\d{2}-\d{2}\.json$/)
    expect(savedDocument?.mimeType).toBe('application/json')
    const exported = JSON.parse(savedDocument?.contents ?? '{}') as {
      subscriptions: Array<{ podcastId: string }>
    }
    expect(exported.subscriptions[0]?.podcastId).toBe('p1')
    expect(stored.has('backup/library.json')).toBe(true)
  })

  it('imports safely by keeping newer local progress and a non-empty local queue', async () => {
    await db.progress.put({
      episodeId: 'e1', positionSec: 240, durationSec: 300, played: false, lastPlayedAt: 20,
    })
    await db.queue.put({ episodeId: 'local', position: 0, addedAt: 20 })
    documentToOpen = JSON.stringify({
      version: 1,
      savedAt: 10,
      podcasts: [{
        id: 'p1', feedUrl: 'https://a.example/feed', title: 'Show', author: '', description: '',
        artworkUrl: '', categories: [], explicit: false,
      }],
      subscriptions: [{
        podcastId: 'p1', subscribedAt: 1, autoDownload: false, autoDownloadLimit: 3,
        notifyOnNew: true,
      }],
      progress: [{
        episodeId: 'e1', positionSec: 120, durationSec: 300, played: false, lastPlayedAt: 10,
      }],
      queue: [{ episodeId: 'imported', position: 0, addedAt: 10 }],
      settings: [],
      filterProfiles: [],
      wordOverrides: [],
    })

    const result = await importLibraryBackup()

    expect(result).toEqual({ cancelled: false, subscriptions: 1, progress: 0, queue: 0 })
    expect((await db.progress.get('e1'))?.positionSec).toBe(240)
    expect(await db.queue.get('local')).toBeTruthy()
    expect(await db.queue.get('imported')).toBeUndefined()
    expect(await db.subscriptions.get('p1')).toBeTruthy()
  })

  it('rejects a document that is not a FilterPod backup', async () => {
    documentToOpen = JSON.stringify({ version: 1, savedAt: Date.now(), podcasts: [] })
    await expect(importLibraryBackup()).rejects.toThrow('invalid subscriptions')
  })

  it('keeps the native snapshot current after protected-table mutations', async () => {
    const stop = startLibraryBackupWatcher(0)
    try {
      await db.wordOverrides.put({
        term: 'new choice', action: 'allow', severity: 'mild', category: 'custom', createdAt: 30,
      })
      await vi.waitFor(async () => {
        const bytes = stored.get('backup/library.json')
        if (!bytes) throw new Error('snapshot not written yet')
        const backup = JSON.parse(new TextDecoder().decode(bytes)) as {
          wordOverrides: Array<{ term: string }>
        }
        expect(backup.wordOverrides.some((row) => row.term === 'new choice')).toBe(true)
      })
    } finally {
      stop()
    }
  })
})
