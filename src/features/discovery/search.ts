import { getPlatform } from '@/platform'
import { podcastIdFor } from '@/data/db'

/**
 * Podcast discovery via the iTunes Search API.
 *
 * Chosen because it is public, needs no key and no account, and returns `feedUrl`
 * directly — which is what satisfies the no-server constraint. Podcast Index offers
 * richer data but requires an API key and HMAC secret, and a secret embedded in a
 * distributed APK is not a secret.
 */

const SEARCH_ENDPOINT = 'https://itunes.apple.com/search'

export interface SearchResult {
  id: string
  title: string
  author: string
  artworkUrl: string
  feedUrl: string
  genres: string[]
  episodeCount?: number
}

interface ItunesPodcast {
  collectionName?: string
  trackName?: string
  artistName?: string
  artworkUrl600?: string
  artworkUrl100?: string
  feedUrl?: string
  genres?: string[]
  trackCount?: number
}

export async function searchPodcasts(term: string, limit = 25): Promise<SearchResult[]> {
  const query = term.trim()
  if (!query) return []

  const url = `${SEARCH_ENDPOINT}?${new URLSearchParams({
    media: 'podcast',
    entity: 'podcast',
    term: query,
    limit: String(limit),
  })}`

  const response = await getPlatform().http.get(url)
  if (response.status !== 200) {
    throw new Error(`search failed: HTTP ${response.status}`)
  }

  const body = JSON.parse(await response.text()) as { results?: ItunesPodcast[] }

  const results: SearchResult[] = []
  // iTunes lists the same feed more than once (regional storefronts, renamed
  // collections). Since a feed URL is the app's identity for a podcast, duplicates
  // would collide on id — dedupe here rather than papering over it in the UI.
  const seen = new Set<string>()

  for (const result of body.results ?? []) {
    // A result without a feed URL is useless to us — we cannot subscribe to it.
    if (!result.feedUrl) continue
    const id = podcastIdFor(result.feedUrl)
    if (seen.has(id)) continue
    seen.add(id)

    results.push({
      id,
      title: result.collectionName ?? result.trackName ?? 'Untitled',
      author: result.artistName ?? '',
      artworkUrl: result.artworkUrl600 ?? result.artworkUrl100 ?? '',
      feedUrl: result.feedUrl,
      genres: result.genres ?? [],
      episodeCount: result.trackCount,
    })
  }

  return results
}
