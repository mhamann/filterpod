/**
 * Podcast Index: Apple's id for a feed, looked up by the feed URL itself.
 *
 * Apple's own directory can only be searched by title, and it answers the Worker
 * with HTTP 429 more often than not — Cloudflare's egress addresses are shared, so
 * its per-address limit is spent before we arrive. Podcast Index has an exact
 * feed-URL lookup that returns the iTunes id when it knows one, with no guessing.
 *
 * Auth is Amazon-style: X-Auth-Key, X-Auth-Date (unix seconds, a three-minute
 * window) and Authorization = lowercase hex SHA-1 of key + secret + date. Both
 * values are Worker secrets (PODCASTINDEX_API_KEY / PODCASTINDEX_API_SECRET); for
 * `npm run dev` they come from .dev.vars.
 */

import { cacheOk } from "./cache";
import type { Show } from "./feed";
import { sameFeed } from "./links";

export interface PodcastIndexCreds {
  PODCASTINDEX_API_KEY?: string;
  PODCASTINDEX_API_SECRET?: string;
}

const API = "https://api.podcastindex.org/api/1.0";

export async function authHeaders(key: string, secret: string, nowSec: number): Promise<Record<string, string>> {
  const date = String(Math.floor(nowSec));
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key + secret + date));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    "User-Agent": "FilterPodShare/1.0 (+https://github.com/mhamann/filterpod)",
    "X-Auth-Key": key,
    "X-Auth-Date": date,
    Authorization: hex,
  };
}

interface IndexFeed {
  url?: string;
  originalUrl?: string;
  title?: string;
  author?: string;
  itunesId?: unknown;
}

/**
 * The show's iTunes id, or null when Podcast Index doesn't know one (or isn't
 * configured). The exact feed URL is asked first; failing that, a title search, kept
 * only where a result is this feed under another spelling, or the one feed with this
 * exact title and author.
 */
export async function itunesIdForShow(show: Show, creds: PodcastIndexCreds): Promise<number | null> {
  const key = creds.PODCASTINDEX_API_KEY;
  const secret = creds.PODCASTINDEX_API_SECRET;
  if (!key || !secret) return null;
  const get = (path: string, params: Record<string, string>) => call(`${API}/${path}?${new URLSearchParams(params)}`, key, secret);

  const exact = await get("podcasts/byfeedurl", { url: show.feedUrl });
  const feed = exact?.feed;
  if (feed && !Array.isArray(feed)) {
    const id = itunesId(feed as IndexFeed);
    if (id) return id;
  }

  const found = await get("search/bytitle", { q: show.title, max: "20" });
  const feeds: IndexFeed[] = Array.isArray(found?.feeds) ? found.feeds : [];
  const sameUrl = feeds.find((f) => [f.url, f.originalUrl].some((u) => u && sameFeed(u, show.feedUrl)) && itunesId(f));
  if (sameUrl) return itunesId(sameUrl);
  const lower = (s?: string) => (s ?? "").trim().toLowerCase();
  const named = feeds.filter(
    (f) => itunesId(f) && lower(f.title) === lower(show.title) && show.author && lower(f.author) === lower(show.author),
  );
  const ids = new Set(named.map(itunesId));
  return ids.size === 1 ? itunesId(named[0]) : null;
}

function itunesId(feed: IndexFeed): number | null {
  const id = feed.itunesId;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

async function call(url: string, key: string, secret: string): Promise<any | null> {
  try {
    const response = await fetch(url, {
      headers: await authHeaders(key, secret, Date.now() / 1000),
      signal: AbortSignal.timeout(4_000),
      cf: cacheOk(86_400),
    });
    if (!response.ok) {
      // Podcast Index explains itself in `description`; its words, never our request.
      const why = await response.json().then((b: any) => String(b?.description ?? "").slice(0, 80), () => "");
      console.warn(`podcast index lookup failed: HTTP ${response.status} ${why}`.trim());
      return null;
    }
    const body = (await response.json()) as { status?: string };
    return body.status === "true" ? body : null;
  } catch (e) {
    console.warn(`podcast index lookup failed: ${e instanceof Error ? e.name : "error"}`);
    return null;
  }
}
