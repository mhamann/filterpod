import type { Show } from "./feed";
import { cacheOk } from "./cache";
import { sameFeed } from "./links";
import { itunesIdForShow, type PodcastIndexCreds } from "./podcastindex";

/**
 * Finds a feed in Apple's podcast directory.
 *
 * The directory's id is what most "open in" links want. Podcast Index gives it by
 * exact feed URL (see podcastindex.ts), so that is asked first. Failing that, Apple
 * is searched by title and only the result whose feedUrl is ours is kept — Apple
 * rate-limits the Worker, so this fallback often comes back empty. Anything looser is
 * dropped: a wrong show behind an "Apple Podcasts" button is worse than no button.
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

export async function findAppleShow(show: Show, creds: PodcastIndexCreds = {}): Promise<AppleShow | null> {
  const indexed = await itunesIdForShow(show, creds);
  // Apple redirects this short form to the show's full URL.
  if (indexed) return { collectionId: indexed, url: `https://podcasts.apple.com/podcast/id${indexed}` };

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
