import { Network } from '@capacitor/network'
import type { Download, EpisodeId } from '@/core/types'
import { getPlatform } from '@/platform'
import type { DownloadHandle } from '@/platform'
import { getEpisode, getSettings, listDownloads, patchDownload, putDownload } from '@/data/repo'
import { db } from '@/data/db'

/**
 * Episode downloads.
 *
 * Downloading is not just an offline convenience here — transcription needs local audio,
 * so a download is the first half of making an episode listenable. Completing one hands
 * off to the processing queue.
 */

/** Concurrent downloads. Phones do not benefit from more, and each one costs memory. */
const MAX_CONCURRENT = 2

const active = new Map<EpisodeId, DownloadHandle>()
const listeners = new Set<(download: Download) => void>()
let onDownloaded: ((episodeId: EpisodeId) => void) | null = null

export function onDownloadChange(cb: (download: Download) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Registered by the processing queue so a finished download starts filtering. */
export function setDownloadCompletionHandler(cb: (episodeId: EpisodeId) => void): void {
  onDownloaded = cb
}

function emit(download: Download) {
  for (const listener of listeners) listener(download)
}

export function fileKeyFor(episodeId: EpisodeId): string {
  return `audio/${episodeId}`
}

export async function enqueueDownload(
  episodeId: EpisodeId,
  options: { auto?: boolean } = {},
): Promise<void> {
  const existing = await db.downloads.get(episodeId)
  if (existing && (existing.state === 'downloaded' || existing.state === 'downloading')) return

  const download: Download = {
    episodeId,
    state: 'queued',
    bytesDownloaded: 0,
    bytesTotal: 0,
    startedAt: Date.now(),
    auto: options.auto ?? false,
  }
  await putDownload(download)
  emit(download)
  void pump()
}

/**
 * True when auto-downloads should wait.
 *
 * Only auto-queued downloads are held back — tapping Get is an explicit instruction
 * and is honoured on any connection.
 */
async function shouldHoldAutoDownloads(): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.autoDownloadOnWifiOnly) return false
  try {
    const status = await Network.getStatus()
    if (!status.connected) return true
    return status.connectionType !== 'wifi' && status.connectionType !== 'unknown'
  } catch {
    // If connection type cannot be determined, downloading is the lesser failure.
    return false
  }
}

export async function cancelDownload(episodeId: EpisodeId): Promise<void> {
  const handle = active.get(episodeId)
  if (handle) {
    await handle.cancel()
    active.delete(episodeId)
  }
  await patchDownload(episodeId, { state: 'cancelled' })
  const download = await db.downloads.get(episodeId)
  if (download) emit(download)
  void pump()
}

/** Deletes the audio file and its download record, keeping progress and filter map. */
export async function deleteDownload(episodeId: EpisodeId): Promise<void> {
  await cancelDownload(episodeId)
  await getPlatform().files.delete(fileKeyFor(episodeId))
  await db.downloads.delete(episodeId)
}

/** Starts queued downloads up to the concurrency limit. */
async function pump(): Promise<void> {
  if (active.size >= MAX_CONCURRENT) return

  const holdAuto = await shouldHoldAutoDownloads()
  const queued = await listDownloads('queued')

  for (const download of queued) {
    if (active.size >= MAX_CONCURRENT) return
    if (active.has(download.episodeId)) continue
    // Left queued rather than cancelled, so it starts on its own once Wi-Fi returns.
    if (download.auto && holdAuto) continue
    await start(download.episodeId)
  }
}

async function start(episodeId: EpisodeId): Promise<void> {
  const episode = await getEpisode(episodeId)
  if (!episode) {
    await patchDownload(episodeId, { state: 'failed', error: 'episode not found' })
    return
  }

  const fileKey = fileKeyFor(episodeId)
  await patchDownload(episodeId, { state: 'downloading', startedAt: Date.now() })

  try {
    const handle = await getPlatform().downloads.start({
      episodeId,
      url: episode.audioUrl,
      fileKey,

      onProgress: (progress) => {
        void (async () => {
          await patchDownload(episodeId, {
            bytesDownloaded: progress.bytesDownloaded,
            bytesTotal: progress.bytesTotal,
          })
          const current = await db.downloads.get(episodeId)
          if (current) emit(current)
        })()
      },

      onComplete: (bytes) => {
        void (async () => {
          active.delete(episodeId)
          await patchDownload(episodeId, {
            state: 'downloaded',
            fileKey,
            bytesDownloaded: bytes,
            bytesTotal: bytes,
            completedAt: Date.now(),
          })
          const finished = await db.downloads.get(episodeId)
          if (finished) emit(finished)
          // Only now is the audio actually on disk, so filtering can safely start.
          onDownloaded?.(episodeId)
          void pump()
        })()
      },

      onError: (message) => {
        void (async () => {
          active.delete(episodeId)
          await patchDownload(episodeId, { state: 'failed', error: message })
          const failed = await db.downloads.get(episodeId)
          if (failed) emit(failed)
          void pump()
        })()
      },
    })
    active.set(episodeId, handle)
  } catch (error) {
    active.delete(episodeId)
    await patchDownload(episodeId, {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    const failed = await db.downloads.get(episodeId)
    if (failed) emit(failed)
    void pump()
  }
}

/**
 * Enforces the storage budget by deleting the least recently useful downloads:
 * finished episodes first, then the oldest.
 */
export async function enforceStorageBudget(): Promise<number> {
  const settings = await getSettings()
  const platform = getPlatform()
  let usage = await platform.files.usageBytes()
  if (usage <= settings.maxStorageBytes) return 0

  const downloads = await listDownloads('downloaded')
  const progress = await db.progress.bulkGet(downloads.map((d) => d.episodeId))

  const ranked = downloads
    .map((download, index) => ({ download, played: progress[index]?.played ?? false }))
    .sort((a, b) => {
      if (a.played !== b.played) return a.played ? -1 : 1
      return (a.download.completedAt ?? 0) - (b.download.completedAt ?? 0)
    })

  let reclaimed = 0
  for (const { download } of ranked) {
    if (usage <= settings.maxStorageBytes) break
    const size = download.bytesTotal || download.bytesDownloaded
    await deleteDownload(download.episodeId)
    usage -= size
    reclaimed += size
  }
  return reclaimed
}

/**
 * Reconciles download records against what is actually on disk, then re-queues
 * anything left mid-flight by a previous session.
 *
 * The existence check is not paranoia: browser OPFS can be evicted under storage
 * pressure while IndexedDB survives, and Android can clear app cache independently of
 * app data. Either way the records claim "downloaded" while the audio is gone, which
 * would surface as playback failing and transcription erroring on a missing file.
 */
export async function reconcileDownloads(): Promise<number> {
  const platform = getPlatform()
  const finished = await listDownloads('downloaded')
  let requeued = 0

  for (const download of finished) {
    const fileKey = download.fileKey ?? fileKeyFor(download.episodeId)
    if (await platform.files.exists(fileKey)) continue

    // The filter map was built from the missing file, so it goes too — the
    // replacement download must be re-timed against its own audio.
    await db.filterMaps.delete(download.episodeId)
    await patchDownload(download.episodeId, {
      state: 'queued',
      bytesDownloaded: 0,
      bytesTotal: 0,
      completedAt: undefined,
    })
    requeued++
  }

  const stuck = await listDownloads('downloading')
  for (const download of stuck) {
    await patchDownload(download.episodeId, { state: 'queued', bytesDownloaded: 0 })
  }

  void pump()
  return requeued
}

/**
 * Retries the queue when the connection changes, so downloads held back on cellular
 * start on their own once Wi-Fi is back rather than waiting for the next app launch.
 */
export function watchNetwork(): void {
  void Network.addListener('networkStatusChange', (status) => {
    if (status.connected) void pump()
  })
}
