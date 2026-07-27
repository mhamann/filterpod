import { getPlatform } from '@/platform'
import { podcastIdFor } from '@/data/db'

/**
 * Popular podcasts, for a Discover tab that has something to show before a search.
 *
 * Apple's marketing-tools chart is the source for the same reason iTunes Search is:
 * public, keyless, and CORS-free through native HTTP. The chart entries do not carry
 * feed URLs, so a second batch lookup resolves them — the lookup endpoint accepts
 * comma-separated ids, so "top 30 with feeds" costs exactly two requests.
 */

const CHART_URL = 'https://rss.applemarketingtools.com/api/v2/us/podcasts/top/30/podcasts.json'
const LOOKUP_URL = 'https://itunes.apple.com/lookup'

export interface ChartPodcast {
  /** The app's podcast id (derived from the feed URL), so subscribed state is checkable. */
  id: string
  title: string
  author: string
  artworkUrl: string
  feedUrl: string
}

interface ChartEntry {
  id?: string
  name?: string
  artistName?: string
}

interface LookupResult {
  collectionId?: number
  collectionName?: string
  artistName?: string
  artworkUrl600?: string
  artworkUrl100?: string
  feedUrl?: string
}

/**
 * Cached for the session. The chart moves daily at most, and refetching two requests
 * every time the tab is flipped to would be pure waste on a phone.
 */
let cache: ChartPodcast[] | null = null

export async function fetchTopPodcasts(): Promise<ChartPodcast[]> {
  if (cache) return cache

  const http = getPlatform().http
  const chartResponse = await http.get(CHART_URL)
  if (chartResponse.status !== 200) {
    throw new Error(`chart failed: HTTP ${chartResponse.status}`)
  }
  const chart = JSON.parse(await chartResponse.text()) as {
    feed?: { results?: ChartEntry[] }
  }
  const entries = (chart.feed?.results ?? []).filter((entry) => entry.id)
  if (entries.length === 0) return []

  const lookupResponse = await http.get(
    `${LOOKUP_URL}?${new URLSearchParams({
      id: entries.map((entry) => entry.id!).join(','),
      entity: 'podcast',
    })}`,
  )
  if (lookupResponse.status !== 200) {
    throw new Error(`lookup failed: HTTP ${lookupResponse.status}`)
  }
  const lookup = JSON.parse(await lookupResponse.text()) as { results?: LookupResult[] }
  const byId = new Map(
    (lookup.results ?? [])
      .filter((result) => result.collectionId && result.feedUrl)
      .map((result) => [String(result.collectionId), result]),
  )

  // Walk the chart order, not the lookup order — the lookup endpoint returns results
  // in whatever order it likes, and the chart ranking is the whole point.
  const out: ChartPodcast[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const detail = byId.get(entry.id!)
    if (!detail?.feedUrl) continue
    const id = podcastIdFor(detail.feedUrl)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      title: detail.collectionName ?? entry.name ?? '',
      author: detail.artistName ?? entry.artistName ?? '',
      artworkUrl: detail.artworkUrl600 ?? detail.artworkUrl100 ?? '',
      feedUrl: detail.feedUrl,
    })
  }

  cache = out
  return out
}
