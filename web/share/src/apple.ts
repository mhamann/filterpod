import type { Show } from "./feed";
import { cacheOk } from "./cache";

/**
 * Finds a feed in Apple's podcast directory.
 *
 * The directory's id is what most "open in" links want, and the only public way from
 * a feed URL to that id without an API key is to search by title and keep the result
 * whose feedUrl is ours. Anything looser is dropped: a wrong show behind an "Apple
 * Podcasts" button is worse than no button.
 */

export interface AppleShow {
  collectionId: number;
  url: string;
}

export interface AppleEpisode {
  trackId: number;
  url: string;
}

const SEARCH = "https://itunes.apple.com/search";
const LOOKUP = "https://itunes.apple.com/lookup";

async function itunes(url: string): Promise<any[]> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      cf: cacheOk(86_400),
    });
    if (!response.ok) {
      // Status only: Workers logs are off, so this is visible to a live `wrangler tail` and nowhere else.
      console.warn(`itunes lookup failed: HTTP ${response.status}`);
      return [];
    }
    const body = (await response.json()) as { results?: unknown };
    return Array.isArray(body.results) ? body.results : [];
  } catch (e) {
    console.warn(`itunes lookup failed: ${e instanceof Error ? e.name : "error"}`);
    return [];
  }
}

export function sameFeed(a: string, b: string): boolean {
  const norm = (u: string) =>
    u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

export async function findAppleShow(show: Show): Promise<AppleShow | null> {
  const params = new URLSearchParams({ term: show.title, media: "podcast", entity: "podcast", limit: "25" });
  const results = (await itunes(`${SEARCH}?${params}`)).filter((r) => r.collectionId);
  // Apple sometimes holds an older feed URL than the one being shared (a host move).
  // Exact title and author together are the fallback; either alone is too loose.
  const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
  const hit =
    results.find((r) => typeof r.feedUrl === "string" && sameFeed(r.feedUrl, show.feedUrl)) ??
    (show.author ? results.find((r) => same(r.collectionName, show.title) && same(r.artistName, show.author)) : undefined);
  if (!hit) return null;
  return {
    collectionId: hit.collectionId,
    url: stripTracking(hit.collectionViewUrl ?? `https://podcasts.apple.com/podcast/id${hit.collectionId}`),
  };
}

export async function findAppleEpisode(collectionId: number, guid: string): Promise<AppleEpisode | null> {
  const params = new URLSearchParams({
    id: String(collectionId),
    media: "podcast",
    entity: "podcastEpisode",
    limit: "200",
  });
  const results = await itunes(`${LOOKUP}?${params}`);
  const hit = results.find((r) => r.wrapperType === "podcastEpisode" && r.episodeGuid === guid);
  if (!hit?.trackViewUrl) return null;
  return { trackId: hit.trackId, url: stripTracking(hit.trackViewUrl) };
}

/** Apple appends `uo=4` (an affiliate/tracking marker) to every view URL. */
function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("uo");
    return u.toString();
  } catch {
    return url;
  }
}
