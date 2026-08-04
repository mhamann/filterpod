import { liveQuery } from 'dexie'
import type {
  FilterProfile,
  Podcast,
  Progress,
  QueueItem,
  Subscription as PodcastSubscription,
} from '@/core/types'
import { getPlatform } from '@/platform'
import { db, type SettingsRow, type WordOverride } from './db'

/**
 * The compact, reconstructable part of a FilterPod installation.
 *
 * Episode metadata, downloaded audio, Whisper models and filter maps are deliberately
 * absent. Feeds, downloads and filtering can rebuild those; the rows below are the
 * user's choices and listening history, which cannot be reconstructed anywhere else.
 */
export interface LibraryBackup {
  version: 1
  savedAt: number
  podcasts: Podcast[]
  subscriptions: PodcastSubscription[]
  progress: Progress[]
  queue: QueueItem[]
  settings: SettingsRow[]
  filterProfiles: FilterProfile[]
  wordOverrides: WordOverride[]
}

export interface ImportResult {
  cancelled: boolean
  subscriptions: number
  progress: number
  queue: number
}

const BACKUP_KEY = 'backup/library.json'
const BACKUP_VERSION = 1
const BACKUP_MIME = 'application/json'
const IMPORT_MIME_TYPES = [BACKUP_MIME, 'text/json', 'text/plain', '.json']
const WATCH_DEBOUNCE_MS = 1_000

let writeTail: Promise<void> = Promise.resolve()
let stopActiveWatcher: (() => void) | null = null

/** Reads one transactionally consistent snapshot of every irreplaceable table. */
async function readLibraryBackup(): Promise<LibraryBackup> {
  return db.transaction(
    'r',
    [
      db.podcasts,
      db.subscriptions,
      db.progress,
      db.queue,
      db.settings,
      db.filterProfiles,
      db.wordOverrides,
    ],
    async () => {
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

      // Discover previews are transient. Preserve only metadata required to reconstruct
      // subscriptions, which also keeps the cloud payload comfortably below its quota.
      const subscribed = new Set(subscriptions.map((subscription) => subscription.podcastId))
      return {
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
    },
  )
}

/** Serializes writes so an older, slower snapshot can never overwrite a newer one. */
function persistLibraryBackup(backup: LibraryBackup): Promise<void> {
  const write = writeTail.then(async () => {
    await getPlatform().files.write(
      BACKUP_KEY,
      new Blob([JSON.stringify(backup)], { type: BACKUP_MIME }),
    )
  })
  writeTail = write.catch(() => {})
  return write
}

/** Immediately refreshes the app-private snapshot used by Android Auto Backup. */
export async function writeLibraryBackup(): Promise<void> {
  await persistLibraryBackup(await readLibraryBackup())
}

/**
 * Keeps the snapshot current after progress, queue, settings and word-list mutations.
 *
 * The previous implementation wrote only at startup and subscription changes, leaving
 * a backup stale for an entire long-running app session. Dexie's live query observes all
 * seven protected tables; a short debounce coalesces progress ticks and bulk imports.
 */
export function startLibraryBackupWatcher(debounceMs = WATCH_DEBOUNCE_MS): () => void {
  if (stopActiveWatcher) return stopActiveWatcher

  let timer: ReturnType<typeof setTimeout> | undefined
  let latest: LibraryBackup | undefined
  const subscription = liveQuery(readLibraryBackup).subscribe({
    next(backup) {
      latest = backup
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (latest) void persistLibraryBackup(latest).catch(() => {})
      }, debounceMs)
    },
    error(error) {
      console.warn('FilterPod: library backup watcher stopped', error)
    },
  })

  const stop = () => {
    if (timer) clearTimeout(timer)
    subscription.unsubscribe()
    if (stopActiveWatcher === stop) stopActiveWatcher = null
  }
  stopActiveWatcher = stop
  return stop
}

/** Saves an immediate, human-owned copy through the platform document picker. */
export async function exportLibraryBackup(): Promise<boolean> {
  const backup = await readLibraryBackup()
  await persistLibraryBackup(backup)
  const date = new Date(backup.savedAt).toISOString().slice(0, 10)
  return getPlatform().documents.save(
    `filterpod-backup-${date}.json`,
    BACKUP_MIME,
    JSON.stringify(backup, null, 2),
  )
}

/** Opens and merges a user-selected backup. Existing, newer listening progress wins. */
export async function importLibraryBackup(): Promise<ImportResult> {
  const contents = await getPlatform().documents.open(IMPORT_MIME_TYPES)
  if (contents == null) return { cancelled: true, subscriptions: 0, progress: 0, queue: 0 }

  const backup = parseLibraryBackup(contents)
  const result = await applyLibraryBackup(backup)
  // Persist the merged result, not the imported file verbatim, so automatic backup and
  // a later export both see the same state the UI now sees.
  await writeLibraryBackup()
  return { cancelled: false, ...result }
}

/**
 * Restores Android's app-private snapshot when WebView storage starts empty.
 *
 * Android restores `library.json` before the first launch after reinstall or device
 * transfer. The IndexedDB database is then empty, so this bridges that native restore
 * back into the web data layer before feeds are refreshed.
 */
export async function restoreLibraryBackupIfEmpty(): Promise<boolean> {
  if ((await db.subscriptions.count()) > 0) return false

  let backup: LibraryBackup
  try {
    const bytes = await getPlatform().files.read(BACKUP_KEY)
    backup = parseLibraryBackup(new TextDecoder().decode(bytes))
  } catch {
    return false
  }
  // An empty file is meaningful: the user deliberately removed their last show. Do
  // not turn seeded defaults into a false-positive "restore" on every launch.
  if (backup.subscriptions.length === 0) return false

  await applyLibraryBackup(backup)
  return true
}

async function applyLibraryBackup(
  backup: LibraryBackup,
): Promise<Omit<ImportResult, 'cancelled'>> {
  let restoredSubscriptions = 0
  let restoredProgress = 0
  let restoredQueue = 0
  await db.transaction(
    'rw',
    [
      db.podcasts,
      db.subscriptions,
      db.progress,
      db.queue,
      db.settings,
      db.filterProfiles,
      db.wordOverrides,
    ],
    async () => {
      const currentSubscriptions = await db.subscriptions.bulkGet(
        backup.subscriptions.map((subscription) => subscription.podcastId),
      )
      const subscriptions = backup.subscriptions.filter(
        (_incoming, index) => !currentSubscriptions[index],
      )
      const currentProgress = await db.progress.bulkGet(
        backup.progress.map((progress) => progress.episodeId),
      )
      const progress = backup.progress.filter((incoming, index) => {
        const current = currentProgress[index]
        return !current || incoming.lastPlayedAt >= current.lastPlayedAt
      })
      const queue = (await db.queue.count()) === 0 ? backup.queue : []
      restoredSubscriptions = subscriptions.length
      restoredProgress = progress.length
      restoredQueue = queue.length

      // Merge rather than clear. This makes importing an old backup safe on a phone
      // already in use: current per-show choices and newer progress are retained.
      await db.podcasts.bulkPut(backup.podcasts)
      await db.subscriptions.bulkPut(subscriptions)
      await db.progress.bulkPut(progress)
      await db.queue.bulkPut(queue)
      await db.settings.bulkPut(backup.settings)
      await db.filterProfiles.bulkPut(backup.filterProfiles)
      await db.wordOverrides.bulkPut(backup.wordOverrides)
    },
  )
  return {
    subscriptions: restoredSubscriptions,
    progress: restoredProgress,
    queue: restoredQueue,
  }
}

function parseLibraryBackup(contents: string): LibraryBackup {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  if (!isRecord(value) || value.version !== BACKUP_VERSION || !Number.isFinite(value.savedAt)) {
    throw new Error('That is not a supported FilterPod backup.')
  }

  requireRows(value, 'podcasts', (row) => hasString(row, 'id') && hasString(row, 'feedUrl'))
  requireRows(value, 'subscriptions', (row) => hasString(row, 'podcastId'))
  requireRows(value, 'progress', (row) =>
    hasString(row, 'episodeId') && hasNumber(row, 'positionSec') && hasNumber(row, 'lastPlayedAt'))
  requireRows(value, 'queue', (row) => hasString(row, 'episodeId') && hasNumber(row, 'position'))
  requireRows(value, 'settings', (row) => row.id === 'singleton')
  requireRows(value, 'filterProfiles', (row) => hasString(row, 'id'))
  requireRows(value, 'wordOverrides', (row) => hasString(row, 'term') && hasString(row, 'action'))

  return value as unknown as LibraryBackup
}

function requireRows(
  backup: Record<string, unknown>,
  field: string,
  valid: (row: Record<string, unknown>) => boolean,
): void {
  const rows = backup[field]
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row) || !valid(row))) {
    throw new Error(`The backup has invalid ${field}.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasString(row: Record<string, unknown>, field: string): boolean {
  return typeof row[field] === 'string'
}

function hasNumber(row: Record<string, unknown>, field: string): boolean {
  return typeof row[field] === 'number' && Number.isFinite(row[field])
}
