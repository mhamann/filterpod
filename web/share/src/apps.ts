/**
 * "Or open in" — the visitor's own podcast app.
 *
 * Only formats that were checked against each app's source, app-link files or live
 * redirects are here (September 2026). Most apps want Apple's directory id; the ones
 * that take a feed URL work even for shows Apple doesn't list. Apps that only accept
 * their own opaque ids (Fountain, Podverse, Spotify's show pages) can't be built from
 * a feed without another API, so Spotify gets a search instead and the rest are left
 * out. None of these take a start position.
 */

import type { AppleEpisode, AppleShow } from "./apple";
import type { Item, Show } from "./feed";
import { cacheOk } from "./cache";

export type Platform = "android" | "ios" | "web";

export interface AppLink {
  name: string;
  url: string;
  /** Where the link can open something; the page hides the rest on the client. */
  platforms: Platform[];
}

const bare = (url: string) => url.replace(/^https?:\/\//i, "");

export function appLinks(opts: {
  show: Show;
  item?: Item;
  apple: AppleShow | null;
  appleEpisode?: AppleEpisode | null;
  /** castro.fm/podcast/<uuid>, resolved from its /itunes/ redirect. */
  castroUrl?: string | null;
}): AppLink[] {
  const { show, item, apple, appleEpisode, castroUrl } = opts;
  const feed = show.feedUrl;
  const links: AppLink[] = [];

  if (apple) {
    links.push({
      name: "Apple Podcasts",
      // Apple's episode lookup stops at a couple hundred recent episodes.
      url: appleEpisode?.url ?? apple.url,
      platforms: ["ios", "web"],
    });
  }

  links.push({
    name: "Spotify",
    url: `https://open.spotify.com/search/${encodeURIComponent(
      item ? `${show.title} ${item.title}` : show.title,
    )}`,
    platforms: ["android", "ios", "web"],
  });

  links.push({
    name: "Pocket Casts",
    // pca.st is an app link on both platforms; /feed/ 404s for shows outside its directory.
    url: apple ? `https://pca.st/itunes/${apple.collectionId}` : `https://pca.st/feed/${bare(feed)}`,
    platforms: ["android", "ios", "web"],
  });

  links.push({
    name: "Overcast",
    // overcast.fm/itunes<id> now lands logged-out visitors on a sign-in page.
    url: `overcast://x-callback-url/add?url=${encodeURIComponent(feed)}`,
    platforms: ["ios"],
  });

  if (castroUrl) links.push({ name: "Castro", url: castroUrl, platforms: ["ios"] });

  links.push({
    name: "AntennaPod",
    url: `https://antennapod.org/deeplink/subscribe/?url=${encodeURIComponent(feed)}&title=${encodeURIComponent(show.title)}`,
    platforms: ["android"],
  });

  links.push({
    name: "Podcast Addict",
    url: item
      ? `https://podcastaddict.com/episode/${encodeURIComponent(item.audioUrl)}`
      : `https://podcastaddict.com/feed/${encodeURIComponent(feed)}`,
    platforms: ["android"],
  });

  return links;
}

/**
 * Castro's /itunes/<id> link redirects to its own podcast page, and only that page is
 * a universal link — so follow the redirect here and hand out where it lands.
 */
export async function resolveCastro(apple: AppleShow | null): Promise<string | null> {
  if (!apple) return null;
  try {
    const response = await fetch(`https://castro.fm/itunes/${apple.collectionId}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
      // The answer is a redirect, so redirects are what gets kept.
      cf: cacheOk(86_400, "300-399"),
    });
    const location = response.headers.get("Location");
    if (!location) return null;
    const url = new URL(location, "https://castro.fm");
    return url.hostname === "castro.fm" && url.pathname.startsWith("/podcast/") ? url.toString() : null;
  } catch {
    return null;
  }
}
