import Dexie from 'dexie'
import type {
  Download,
  DownloadState,
  Episode,
  EpisodeId,
  FilterMap,
  FilterProfile,
  Podcast,
  PodcastId,
  Progress,
  QueueItem,
  Settings,
  Subscription,
} from '@/core/types'
import { db, type WordOverride } from './db'
import { DEFAULT_PROFILES, DEFAULT_SETTINGS } from './defaults'

/**
 * Rewrites filter maps left in a state nothing will ever advance.
 *
 * Filtering used to be a background queue with 'queued' and 'transcribing' states.
 * Live filtering owns that work in memory now, so any row still carrying those statuses
 * is orphaned — it would sit at "Filtering 0%" forever. Rows that got some analysis done
 * are demoted to 'partial' so the work is not thrown away; empty ones are deleted so the
 * episode simply looks unchecked.
 */
export async function reconcileFilterMaps(): Promise<number> {
  const stale = await db.filterMaps
    .filter((map) => map.status !== 'partial' && map.status !== 'ready' &&
      map.status !== 'failed' && map.status !== 'unsupported')
    .toArray()

  for (const map of stale) {
    if (map.analyzedRanges?.length > 0) {
      await db.filterMaps.put({ ...map, status: 'partial' })
    } else {
      await db.filterMaps.delete(map.episodeId)
    }
  }
  return stale.length
}

/** Seeds built-in profiles and settings. Safe to call on every startup. */
export async function initializeStore(): Promise<void> {
  await db.transaction('rw', db.settings, db.filterProfiles, async () => {
    const existing = await db.settings.get('singleton')
    if (!existing) {
      await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS })
    }
    for (const profile of DEFAULT_PROFILES) {
      // put() rather than add() so profile tuning ships in updates, but user-created
      // profiles (which never share these ids) are left alone.
      const current = await db.filterProfiles.get(profile.id)
      if (!current) await db.filterProfiles.put(profile)
    }
  })
}

// --- settings ---------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get('singleton')
  return row ?? { ...DEFAULT_SETTINGS }
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings()
  await db.settings.put({ id: 'singleton', ...current, ...patch })
}

export async function getActiveProfile(): Promise<FilterProfile> {
  const settings = await getSettings()
  const profile = await db.filterProfiles.get(settings.activeFilterProfileId)
  return profile ?? DEFAULT_PROFILES[1]
}

/** Resolves the profile for an episode, honouring a per-subscription override. */
export async function getProfileForPodcast(podcastId: PodcastId): Promise<FilterProfile> {
  const subscription = await db.subscriptions.get(podcastId)
  if (subscription?.filterProfileId) {
    const profile = await db.filterProfiles.get(subscription.filterProfileId)
    if (profile) return profile
  }
  return getActiveProfile()
}

// --- podcasts and episodes --------------------------------------------------

export async function upsertPodcast(podcast: Podcast): Promise<void> {
  const existing = await db.podcasts.get(podcast.id)
  await db.podcasts.put(existing ? { ...existing, ...podcast } : podcast)
}

export function getPodcast(id: PodcastId): Promise<Podcast | undefined> {
  return db.podcasts.get(id)
}

/**
 * Writes episodes, preserving any fields already stored.
 * Returns the ids that were new, which drives new-episode notifications and
 * auto-download.
 */
export async function upsertEpisodes(episodes: Episode[]): Promise<EpisodeId[]> {
  if (episodes.length === 0) return []
  return db.transaction('rw', db.episodes, async () => {
    const ids = episodes.map((episode) => episode.id)
    const existing = await db.episodes.bulkGet(ids)
    const known = new Set(existing.filter(Boolean).map((episode) => episode!.id))
    await db.episodes.bulkPut(episodes)
    return ids.filter((id) => !known.has(id))
  })
}

export function listEpisodes(podcastId: PodcastId, limit = 200): Promise<Episode[]> {
  return db.episodes
    .where('[podcastId+publishedAt]')
    .between([podcastId, Dexie.minKey], [podcastId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export function getEpisode(id: EpisodeId): Promise<Episode | undefined> {
  return db.episodes.get(id)
}

// --- subscriptions ----------------------------------------------------------

export async function subscribe(podcastId: PodcastId, patch: Partial<Subscription> = {}) {
  const subscription: Subscription = {
    podcastId,
    subscribedAt: Date.now(),
    autoDownload: true,
    autoDownloadLimit: 3,
    notifyOnNew: true,
    ...patch,
  }
  await db.subscriptions.put(subscription)
  return subscription
}

/** Unsubscribes and reclaims storage; listening history is kept. */
export async function unsubscribe(podcastId: PodcastId): Promise<EpisodeId[]> {
  const episodes = await db.episodes.where('podcastId').equals(podcastId).toArray()
  const episodeIds = episodes.map((episode) => episode.id)
  await db.transaction('rw', db.subscriptions, db.downloads, db.filterMaps, async () => {
    await db.subscriptions.delete(podcastId)
    await db.downloads.bulkDelete(episodeIds)
    await db.filterMaps.bulkDelete(episodeIds)
  })
  return episodeIds
}

export function listSubscriptions(): Promise<Subscription[]> {
  return db.subscriptions.orderBy('subscribedAt').reverse().toArray()
}

export function isSubscribed(podcastId: PodcastId): Promise<boolean> {
  return db.subscriptions.get(podcastId).then((row) => row !== undefined)
}

// --- progress ---------------------------------------------------------------

export function getProgress(episodeId: EpisodeId): Promise<Progress | undefined> {
  return db.progress.get(episodeId)
}

export async function saveProgress(
  episodeId: EpisodeId,
  positionSec: number,
  durationSec: number,
  completionThresholdSec: number,
): Promise<void> {
  const nearEnd = durationSec > 0 && positionSec >= durationSec - completionThresholdSec
  const existing = await db.progress.get(episodeId)
  await db.progress.put({
    episodeId,
    positionSec,
    durationSec,
    played: nearEnd || (existing?.played ?? false),
    completedAt: nearEnd ? (existing?.completedAt ?? Date.now()) : existing?.completedAt,
    lastPlayedAt: Date.now(),
  })
}

export async function setPlayed(episodeId: EpisodeId, played: boolean): Promise<void> {
  const existing = await db.progress.get(episodeId)
  await db.progress.put({
    episodeId,
    positionSec: played ? (existing?.durationSec ?? 0) : 0,
    durationSec: existing?.durationSec ?? 0,
    played,
    completedAt: played ? Date.now() : undefined,
    lastPlayedAt: Date.now(),
  })
}

/** Most recently played, unfinished episodes — the "continue listening" row. */
export async function listInProgress(limit = 20): Promise<Progress[]> {
  const rows = await db.progress.orderBy('lastPlayedAt').reverse().limit(limit * 3).toArray()
  return rows.filter((row) => !row.played && row.positionSec > 5).slice(0, limit)
}

// --- downloads --------------------------------------------------------------

export function getDownload(episodeId: EpisodeId): Promise<Download | undefined> {
  return db.downloads.get(episodeId)
}

export async function putDownload(download: Download): Promise<void> {
  await db.downloads.put(download)
}

export async function patchDownload(
  episodeId: EpisodeId,
  patch: Partial<Download>,
): Promise<void> {
  const existing = await db.downloads.get(episodeId)
  if (!existing) return
  await db.downloads.put({ ...existing, ...patch })
}

export function listDownloads(state?: DownloadState): Promise<Download[]> {
  return state ? db.downloads.where('state').equals(state).toArray() : db.downloads.toArray()
}

// --- filter maps ------------------------------------------------------------

export function getFilterMap(episodeId: EpisodeId): Promise<FilterMap | undefined> {
  return db.filterMaps.get(episodeId)
}

export async function putFilterMap(map: FilterMap): Promise<void> {
  await db.filterMaps.put(map)
}

export async function patchFilterMap(
  episodeId: EpisodeId,
  patch: Partial<FilterMap>,
): Promise<void> {
  const existing = await db.filterMaps.get(episodeId)
  if (!existing) return
  await db.filterMaps.put({ ...existing, ...patch })
}

// --- wordlist overrides -----------------------------------------------------

export function listWordOverrides(): Promise<WordOverride[]> {
  return db.wordOverrides.toArray()
}

export async function putWordOverride(override: WordOverride): Promise<void> {
  await db.wordOverrides.put(override)
}

export async function deleteWordOverride(term: string): Promise<void> {
  await db.wordOverrides.delete(term)
}

// --- play queue -------------------------------------------------------------

/**
 * The queue, in play order.
 *
 * Position is dense and rewritten wholesale by the mutations below, so reading is a
 * plain ordered scan and callers never have to reason about gaps.
 */
export function listQueue(): Promise<QueueItem[]> {
  return db.queue.orderBy('position').toArray()
}

/**
 * Adds an episode to the queue.
 *
 * Keyed by episode, so queueing something already queued moves it rather than
 * duplicating it — a queue with the same episode twice is never what was meant, and
 * playing it would strand the second copy at a position already listened to.
 */
export async function enqueueEpisode(
  episodeId: EpisodeId,
  options: { next?: boolean } = {},
): Promise<void> {
  await db.transaction('rw', db.queue, async () => {
    const items = (await db.queue.orderBy('position').toArray()).filter(
      (item) => item.episodeId !== episodeId,
    )
    const entry: QueueItem = { episodeId, position: 0, addedAt: Date.now() }
    const ordered = options.next ? [entry, ...items] : [...items, entry]
    await renumber(ordered)
  })
}

export async function removeFromQueue(episodeId: EpisodeId): Promise<void> {
  await db.transaction('rw', db.queue, async () => {
    await db.queue.delete(episodeId)
    await renumber(await db.queue.orderBy('position').toArray())
  })
}

/**
 * Moves a queued episode by [delta] places, clamped to the ends.
 *
 * Expressed as a relative move rather than an absolute index because that is what the
 * controls do, and it means the caller never has to know the current position — which it
 * would otherwise have to read first, racing anything else editing the queue.
 */
export async function moveInQueue(episodeId: EpisodeId, delta: number): Promise<void> {
  await db.transaction('rw', db.queue, async () => {
    const items = await db.queue.orderBy('position').toArray()
    const from = items.findIndex((item) => item.episodeId === episodeId)
    if (from < 0) return

    const to = Math.min(items.length - 1, Math.max(0, from + delta))
    if (to === from) return

    const [moved] = items.splice(from, 1)
    items.splice(to, 0, moved)
    await renumber(items)
  })
}

/** Takes the next episode off the queue, or undefined when it is empty. */
export async function dequeueNext(): Promise<EpisodeId | undefined> {
  return db.transaction('rw', db.queue, async () => {
    const items = await db.queue.orderBy('position').toArray()
    const next = items.shift()
    if (!next) return undefined
    await db.queue.delete(next.episodeId)
    await renumber(items)
    return next.episodeId
  })
}

export async function clearQueue(): Promise<void> {
  await db.queue.clear()
}

/** Writes back dense positions matching array order. */
async function renumber(items: QueueItem[]): Promise<void> {
  await db.queue.bulkPut(items.map((item, index) => ({ ...item, position: index })))
}
