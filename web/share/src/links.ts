/**
 * The share URL format, and the one piece of the app it has to agree with.
 *
 *   /p/<feed>                 a podcast
 *   /e/<feed>/<episode>?t=90  an episode, optionally from a position in seconds
 *
 * <feed> is the feed URL, base64url-encoded: the worker can only show a podcast it
 * can fetch, and a feed URL is the one identifier every podcast has. <episode> is
 * the same FNV-1a hash of the guid the app puts at the end of its episode ids, so
 * the app can build these links from what it already stores.
 */

export function encodeFeed(feedUrl: string): string {
  const bytes = new TextEncoder().encode(feedUrl.trim());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The feed URL a token names, or null when it is not an http(s) URL. */
export function decodeFeed(token: string): string | null {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const url = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * FNV-1a over UTF-16 code units, unsigned base-36 — bit-for-bit the app's
 * `fnv1a` in kmp/shared/.../data/Ids.kt. A divergence here breaks every episode link.
 */
export function fnv1a(input: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

export function podcastPath(feedUrl: string): string {
  return `/p/${encodeFeed(feedUrl)}`;
}

export function episodePath(feedUrl: string, guid: string, atSec?: number): string {
  const t = atSec && atSec > 0 ? `?t=${Math.floor(atSec)}` : "";
  return `/e/${encodeFeed(feedUrl)}/${fnv1a(guid)}${t}`;
}

/** `?t=` as whole seconds; accepts 90, 1:30 and 1:02:03. */
export function parseStart(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) || null;
  const parts = raw.split(":");
  if (parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0) || null;
}
