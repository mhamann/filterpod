import Dexie, { type EntityTable } from 'dexie'
import type {
  Download,
  Episode,
  FilterMap,
  FilterProfile,
  Podcast,
  Progress,
  Settings,
  Subscription,
} from '@/core/types'

/** A user-authored addition to, or exemption from, the bundled wordlist. */
export interface WordOverride {
  term: string
  action: 'block' | 'allow'
  severity: 'mild' | 'moderate' | 'strong'
  category: 'profanity' | 'sexual' | 'slur' | 'blasphemy' | 'scatological' | 'custom'
  createdAt: number
}

/** Single-row table holding app settings under a fixed key. */
export interface SettingsRow extends Settings {
  id: 'singleton'
}

class FilterPodDatabase extends Dexie {
  podcasts!: EntityTable<Podcast, 'id'>
  episodes!: EntityTable<Episode, 'id'>
  subscriptions!: EntityTable<Subscription, 'podcastId'>
  progress!: EntityTable<Progress, 'episodeId'>
  downloads!: EntityTable<Download, 'episodeId'>
  filterMaps!: EntityTable<FilterMap, 'episodeId'>
  filterProfiles!: EntityTable<FilterProfile, 'id'>
  wordOverrides!: EntityTable<WordOverride, 'term'>
  settings!: EntityTable<SettingsRow, 'id'>

  constructor() {
    super('filterpod')

    this.version(1).stores({
      podcasts: 'id, feedUrl, title',
      // Compound index drives the "episodes for a podcast, newest first" query.
      episodes: 'id, podcastId, publishedAt, [podcastId+publishedAt], guid',
      subscriptions: 'podcastId, subscribedAt',
      progress: 'episodeId, lastPlayedAt, played',
      downloads: 'episodeId, state',
      filterMaps: 'episodeId, status',
      filterProfiles: 'id',
      wordOverrides: 'term, action',
      settings: 'id',
    })

    // v2: the downloads screen orders by start time, and Dexie can only order by an
    // index — without this, `orderBy('startedAt')` throws rather than sorting.
    this.version(2).stores({
      downloads: 'episodeId, state, startedAt',
    })
  }
}

export const db = new FilterPodDatabase()

/** Stable ids so a re-subscribe reuses existing episodes and progress. */
export function podcastIdFor(feedUrl: string): string {
  return `p_${hash(feedUrl.trim().toLowerCase())}`
}

export function episodeIdFor(podcastId: string, guid: string): string {
  return `e_${podcastId}_${hash(guid)}`
}

/** FNV-1a. Short, stable, and collision-safe enough for feed-scoped keys. */
function hash(input: string): string {
  let value = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    value ^= input.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0).toString(36)
}
