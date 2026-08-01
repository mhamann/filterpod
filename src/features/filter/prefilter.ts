import type { EpisodeId } from '@/core/types'
import { db } from '@/data/db'
import {
  getDownload,
  getEpisode,
  getFilterMap,
  getProfileForPodcast,
  getSettings,
  listWordOverrides,
  putFilterMap,
} from '@/data/repo'
import { fileKeyFor } from '@/features/downloads/downloadManager'
import { buildFilterMap, isStale, toFilterMapRecord } from './buildFilterMap'
import { liveFilterActive } from './liveFilter'

/**
 * Filters downloaded episodes ahead of time, so playing one needs no live ASR at all.
 *
 * This exists because just-in-time filtering meets physics outdoors: sustained whisper
 * in a warm pocket thermally throttles the SoC until transcription barely outruns
 * playback, and the never-play-unanalyzed guard turns that into pauses. An episode
 * filtered at download time — indoors, cool, often charging — plays start to finish
 * with zero transcription work, whatever the weather. This is also what makes the
 * auto-download card's "filtered and ready" wording true rather than aspirational.
 *
 * The live pipeline always wins the transcriber: a queued backlog is dropped when a
 * session is active (the startup sweep re-queues it next launch), and a build in
 * flight is aborted the moment an episode is opened for playback. Prefilter work is
 * a background nicety; the episode someone is listening to is the product.
 */

const queue: EpisodeId[] = []
let running = false
let activeController: AbortController | null = null

/**
 * When a cancel last arrived. The live session that caused it flips liveFilterActive
 * a few awaits later, and the queue must not slip the next episode into that gap —
 * observed in the field as a listener starved for eleven minutes behind a backlog
 * build that started microseconds after their play press cancelled the previous one.
 */
let cancelledAtMs = 0
const CANCEL_QUIET_MS = 60_000

/** ASR window cap; the transcriber changes hands within one window of a cancel. */
const PREFILTER_WINDOW_SEC = 120

/** Queues a downloaded episode for ahead-of-time filtering. Deduplicated, serial. */
export function prefilterEpisode(episodeId: EpisodeId): void {
  if (!queue.includes(episodeId)) queue.push(episodeId)
  void run()
}

/** Aborts the build in flight, freeing the native transcriber for live playback. */
export function cancelActivePrefilter(): void {
  cancelledAtMs = Date.now()
  activeController?.abort()
}

/** Queues every downloaded episode that lacks a current map. Run once at startup. */
export async function prefilterDownloadedBacklog(): Promise<void> {
  const downloads = await db.downloads.where('state').equals('downloaded').toArray()
  for (const download of downloads) prefilterEpisode(download.episodeId)
}

async function run(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      if (liveFilterActive() || Date.now() - cancelledAtMs < CANCEL_QUIET_MS) {
        // Someone is listening — or just pressed play and the session is still
        // spinning up. The playhead's pipeline owns the transcriber. Drop the
        // backlog rather than idle-loop — the startup sweep restores it.
        queue.length = 0
        return
      }
      const episodeId = queue.shift()!
      try {
        await prefilterOne(episodeId)
      } catch {
        // One failed episode must not strand the rest of the backlog.
      }
    }
  } finally {
    running = false
  }
}

async function prefilterOne(episodeId: EpisodeId): Promise<void> {
  const [episode, download] = await Promise.all([getEpisode(episodeId), getDownload(episodeId)])
  if (!episode || download?.state !== 'downloaded') return

  const profile = await getProfileForPodcast(episode.podcastId)
  if (profile.severities.length === 0) return

  const existing = await getFilterMap(episodeId)
  if (
    existing &&
    existing.status === 'ready' &&
    !isStale(existing) &&
    existing.profileId === profile.id
  ) {
    return
  }

  const [overrides, settings] = await Promise.all([listWordOverrides(), getSettings()])
  const controller = new AbortController()
  activeController = controller
  try {
    const result = await buildFilterMap({
      episode,
      fileKey: download.fileKey ?? fileKeyFor(episodeId),
      profile,
      overrides,
      model: settings.whisperModel,
      maxWindowSec: PREFILTER_WINDOW_SEC,
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    await putFilterMap(toFilterMapRecord(episodeId, result, episode.durationSec, profile.id))
  } finally {
    if (activeController === controller) activeController = null
  }
}
