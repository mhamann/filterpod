import type { EpisodeId, PodcastId } from '@/core/types'
import { podcastIdFor } from '@/data/db'
import {
  enqueueEpisode,
  listEpisodes,
  listSubscriptions,
  subscribe as persistSubscription,
  unsubscribe as persistUnsubscribe,
} from '@/data/repo'
import { db } from '@/data/db'
import { writeLibraryBackup } from '@/data/backup'
import { fetchFeed, refreshAllSubscriptions } from '@/features/feeds/refresh'
import { deleteDownload, enqueueDownload } from '@/features/downloads/downloadManager'

/**
 * Subscription lifecycle.
 *
 * Subscribing kicks off the work that makes episodes actually listenable — fetching the
 * feed, then downloading and filtering the most recent episodes — because on this app's
 * no-server design an episode is not playable until it has been processed.
 */

export interface SubscribeResult {
  podcastId: PodcastId
  episodeCount: number
  queuedForDownload: EpisodeId[]
}

export async function subscribeToFeed(
  feedUrl: string,
  options: { autoDownload?: boolean; autoDownloadLimit?: number } = {},
): Promise<SubscribeResult> {
  const result = await fetchFeed(feedUrl, false)
  if (result.error) throw new Error(`Could not load feed: ${result.error}`)

  const podcastId = podcastIdFor(feedUrl)
  const autoDownloadLimit = options.autoDownloadLimit ?? 3
  const subscription = await persistSubscription(podcastId, {
    // Off by default. Subscribing to a show is not a request to fill the phone with it:
    // episodes stream, and downloading is for the ones somebody deliberately wants
    // offline. Still available per-show for exactly that.
    autoDownload: options.autoDownload ?? false,
    autoDownloadLimit,
  })

  const episodes = await listEpisodes(podcastId, Math.max(1, autoDownloadLimit))
  const queuedForDownload: EpisodeId[] = []

  if (subscription.autoDownload) {
    for (const episode of episodes.slice(0, autoDownloadLimit)) {
      await enqueueDownload(episode.id, { auto: true })
      queuedForDownload.push(episode.id)
    }
  }

  const episodeCount = await db.episodes.where('podcastId').equals(podcastId).count()

  // Keep the durable mirror current, so a WebView storage wipe can be healed. Done on
  // the subscription mutations specifically: they are what make an empty database
  // distinguishable from a deliberately emptied library.
  void writeLibraryBackup().catch(() => {})

  return { podcastId, episodeCount, queuedForDownload }
}

/** Unsubscribes and reclaims the storage used by that feed's downloads. */
export async function unsubscribeFromFeed(podcastId: PodcastId): Promise<void> {
  const episodeIds = await db.episodes
    .where('podcastId')
    .equals(podcastId)
    .primaryKeys() as EpisodeId[]

  for (const episodeId of episodeIds) {
    await deleteDownload(episodeId)
  }
  await persistUnsubscribe(podcastId)
  // Unsubscribing the last show must leave a backup that says "empty on purpose",
  // or the next launch would faithfully restore what was just removed.
  void writeLibraryBackup().catch(() => {})
}

/**
 * Refreshes every feed, then applies each subscription's new-episode behaviour:
 * auto-download and/or auto-queue. Returns the episodes queued for download, which is
 * what the UI reports as "N new episodes".
 */
export async function refreshAndAutoDownload(): Promise<EpisodeId[]> {
  const results = await refreshAllSubscriptions()
  const subscriptions = await listSubscriptions()
  const byPodcast = new Map(subscriptions.map((s) => [s.podcastId, s]))
  const queued: EpisodeId[] = []

  for (const result of results) {
    const subscription = byPodcast.get(result.podcastId)
    if (!subscription || result.newEpisodeIds.length === 0) continue
    if (!subscription.autoDownload && !subscription.autoQueue) continue

    // Newest first, so a feed that dumps a backlog does not queue it oldest-first.
    const episodes = await db.episodes.bulkGet(result.newEpisodeIds)
    const ordered = episodes
      .filter((episode): episode is NonNullable<typeof episode> => Boolean(episode))
      .sort((a, b) => b.publishedAt - a.publishedAt)

    if (subscription.autoDownload) {
      const limit = subscription.autoDownloadLimit || ordered.length
      for (const episode of ordered.slice(0, limit)) {
        await enqueueDownload(episode.id, { auto: true })
        queued.push(episode.id)
      }
    }

    if (subscription.autoQueue) {
      // Appended oldest-first: the queue plays top-down, and Monday's episode should
      // play before Tuesday's. No limit — the queue is an intention list, not storage,
      // and anything unwanted is one swipe from gone.
      for (const episode of [...ordered].reverse()) {
        await enqueueEpisode(episode.id)
      }
    }
  }

  return queued
}
