import type { EpisodeId, PodcastId } from '@/core/types'
import { db, podcastIdFor } from '@/data/db'
import { getPlatform } from '@/platform'
import { listSubscriptions, upsertEpisodes, upsertPodcast } from '@/data/repo'
import { parseFeed } from './parseFeed'

/**
 * Feed fetching and refresh.
 *
 * Refresh uses conditional requests (ETag / Last-Modified). Most feeds answer 304 on
 * most refreshes, so a library-wide refresh is usually a handful of empty responses
 * rather than megabytes of re-parsed XML.
 */

export interface RefreshResult {
  podcastId: PodcastId
  newEpisodeIds: EpisodeId[]
  unchanged: boolean
  error?: string
}

/** Fetches and stores a feed. Used both for first subscribe and for refresh. */
export async function fetchFeed(feedUrl: string, conditional = true): Promise<RefreshResult> {
  const platform = getPlatform()
  const podcastId = podcastIdFor(feedUrl)
  const existing = await db.podcasts.get(podcastId)

  try {
    const response = await platform.http.get(feedUrl, {
      etag: conditional ? existing?.etag : undefined,
      lastModified: conditional ? existing?.lastModified : undefined,
    })

    if (response.status === 304) {
      await db.podcasts.update(podcastId, { lastFetchedAt: Date.now(), lastFetchError: undefined })
      return { podcastId, newEpisodeIds: [], unchanged: true }
    }

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`)
    }

    const xml = await response.text()
    const { podcast, episodes } = parseFeed(xml, feedUrl)

    await upsertPodcast({
      ...podcast,
      etag: response.headers['etag'] ?? existing?.etag,
      lastModified: response.headers['last-modified'] ?? existing?.lastModified,
      lastFetchError: undefined,
    })
    const newEpisodeIds = await upsertEpisodes(episodes)

    return { podcastId, newEpisodeIds, unchanged: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Record the failure without clobbering the cached feed; a transient network error
    // should never empty someone's library.
    if (existing) {
      await db.podcasts.update(podcastId, { lastFetchError: message, lastFetchedAt: Date.now() })
    }
    return { podcastId, newEpisodeIds: [], unchanged: false, error: message }
  }
}

/** Refreshes every subscribed feed with bounded concurrency. */
export async function refreshAllSubscriptions(concurrency = 4): Promise<RefreshResult[]> {
  const subscriptions = await listSubscriptions()
  const podcasts = await db.podcasts.bulkGet(subscriptions.map((s) => s.podcastId))
  const feedUrls = podcasts.filter(Boolean).map((podcast) => podcast!.feedUrl)

  const results: RefreshResult[] = []
  let cursor = 0

  // A small pool rather than Promise.all: refreshing 200 feeds at once would swamp
  // a phone's connection and get us rate-limited by the larger hosts.
  const workers = Array.from({ length: Math.min(concurrency, feedUrls.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= feedUrls.length) return
      results.push(await fetchFeed(feedUrls[index]))
    }
  })

  await Promise.all(workers)
  return results
}
