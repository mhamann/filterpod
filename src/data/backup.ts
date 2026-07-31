import { db } from './db'
import { getPlatform } from '@/platform'

/**
 * Library backup, written to native app storage.
 *
 * IndexedDB on Android WebView is *evictable*: `persist()` is never granted, and a
 * phone running out of disk had Chromium's quota manager silently delete this app's
 * entire database — subscriptions, progress, queue, settings, all of it — while the
 * app's own files directory sat untouched. That directory is the durable ground here,
 * so everything that cannot be reconstructed from feeds is mirrored into it as JSON,
 * and an app that wakes up to an empty database quietly puts itself back together.
 *
 * Episodes and filter maps are deliberately absent: they rebuild from feed refresh and
 * playback respectively, and ids are deterministic (hashes of feed URL and guid), so
 * restored progress and queue rows re-attach to re-fetched episodes on their own.
 */

const BACKUP_KEY = 'backup/library.json'
const BACKUP_VERSION = 1

interface LibraryBackup {
  version: number
  savedAt: number
  podcasts: unknown[]
  subscriptions: unknown[]
  progress: unknown[]
  queue: unknown[]
  settings: unknown[]
  filterProfiles: unknown[]
  wordOverrides: unknown[]
}

/** Mirrors the critical tables into native storage. Cheap; a few hundred KB of JSON. */
export async function writeLibraryBackup(): Promise<void> {
  const [podcasts, subscriptions, progress, queue, settings, filterProfiles, wordOverrides] =
    await Promise.all([
      db.podcasts.toArray(),
      db.subscriptions.toArray(),
      db.progress.toArray(),
      db.queue.toArray(),
      db.settings.toArray(),
      db.filterProfiles.toArray(),
      db.wordOverrides.toArray(),
    ])

  // Only artwork/description-bearing podcast rows for *subscribed* shows: preview rows
  // from Discover are transient by design and not worth resurrecting.
  const subscribed = new Set(subscriptions.map((subscription) => subscription.podcastId))
  const backup: LibraryBackup = {
    version: BACKUP_VERSION,
    savedAt: Date.now(),
    podcasts: podcasts.filter((podcast) => subscribed.has(podcast.id)),
    subscriptions,
    progress,
    queue,
    settings,
    filterProfiles,
    wordOverrides,
  }

  await getPlatform().files.write(
    BACKUP_KEY,
    new Blob([JSON.stringify(backup)], { type: 'application/json' }),
  )
}

/**
 * Restores the backup when the database has plainly been wiped.
 *
 * Gated on "no subscriptions": a deliberate empty library rewrites the backup as empty
 * on the same actions that emptied it (see the service layer), so restore never fights
 * a user's own choices. Returns whether anything was restored; the caller refreshes
 * feeds afterwards to repopulate episodes.
 */
export async function restoreLibraryBackupIfEmpty(): Promise<boolean> {
  if ((await db.subscriptions.count()) > 0) return false

  let backup: LibraryBackup
  try {
    const bytes = await getPlatform().files.read(BACKUP_KEY)
    backup = JSON.parse(new TextDecoder().decode(bytes)) as LibraryBackup
  } catch {
    return false
  }
  if (backup.version !== BACKUP_VERSION || backup.subscriptions.length === 0) return false

  await db.transaction(
    'rw',
    [db.podcasts, db.subscriptions, db.progress, db.queue, db.settings, db.filterProfiles, db.wordOverrides],
    async () => {
      // bulkPut, not clear-and-write: anything the user did since the wipe wins.
      await db.podcasts.bulkPut(backup.podcasts as never[])
      await db.subscriptions.bulkPut(backup.subscriptions as never[])
      await db.progress.bulkPut(backup.progress as never[])
      await db.queue.bulkPut(backup.queue as never[])
      await db.settings.bulkPut(backup.settings as never[])
      await db.filterProfiles.bulkPut(backup.filterProfiles as never[])
      await db.wordOverrides.bulkPut(backup.wordOverrides as never[])
    },
  )
  return true
}
