/**
 * FilterPod share pages.
 *
 *   /                 what FilterPod is
 *   /privacy          PRIVACY.md from the repo root
 *   /p/<feed>         a shared podcast
 *   /e/<feed>/<ep>    a shared episode, ?t=<sec> for a position
 *
 * See links.ts for the URL format. Rendered pages are cached at the edge for a few
 * minutes, which bounds how often any one link makes us fetch the publisher's feed.
 */

import { findAppleEpisode, findAppleShow } from "./apple";
import { appLinks, resolveCastro } from "./apps";
import { FeedError, readFeed } from "./feed";
import { decodeFeed, parseStart, podcastPath } from "./links";
import { episodePage, homePage, podcastPage, privacyPage, SCRIPT } from "./page";
import { PRIVACY_HTML } from "./privacy";
import { latestRelease } from "./release";

const PAGE_TTL = 600;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "img-src 'self' https: data:",
    "style-src 'unsafe-inline'",
    // Cloudflare Web Analytics: its beacon script, and where the beacon reports —
    // this origin's /cdn-cgi/rum when the zone injects it, its own host otherwise.
    "script-src 'self' https://static.cloudflareinsights.com",
    "connect-src 'self' https://cloudflareinsights.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  // Nothing about which show someone opened leaks to the artwork CDN or the apps.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><defs><radialGradient id="g" cx=".5" cy=".42" r=".78"><stop offset="0" stop-color="#1b120b"/><stop offset="1" stop-color="#0a0605"/></radialGradient></defs><rect width="108" height="108" rx="24" fill="url(#g)"/><g stroke="#cf8842" stroke-width="11" stroke-linecap="round"><path d="M54 54 L54 29"/><path d="M54 54 L32.35 41.5"/><path d="M54 54 L32.35 66.5"/><path d="M54 54 L54 79"/><path d="M54 54 L75.65 66.5"/><path d="M54 54 L75.65 41.5"/></g></svg>`;

function page(body: string, status = 200, ttl = PAGE_TTL): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short in browsers, longer at the edge, where it spares the publisher's feed.
      "Cache-Control": `public, max-age=${Math.min(ttl, 60)}, s-maxage=${ttl}`,
      ...SECURITY_HEADERS,
    },
  });
}

function asset(body: string, type: string): Response {
  return new Response(body, {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" },
  });
}

/** Only ?t= means anything; anything else would just split the cache. */
function canonicalUrl(url: URL): string {
  const start = parseStart(url.searchParams.get("t"));
  return url.origin + url.pathname + (start ? `?t=${start}` : "");
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const canonical = canonicalUrl(url);

  if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
    return asset(FAVICON, "image/svg+xml");
  }
  if (url.pathname === "/app.js") return asset(SCRIPT, "text/javascript; charset=utf-8");
  if (url.pathname === "/robots.txt") return asset("User-agent: *\nAllow: /\n", "text/plain");

  if (url.pathname === "/privacy") return page(privacyPage(PRIVACY_HTML, canonical));

  const releasePromise = latestRelease();

  if (parts.length === 0) return page(homePage(await releasePromise, canonical));

  const [kind, token, hash] = parts;
  const feedUrl = token ? decodeFeed(token) : null;
  const shape = (kind === "p" && parts.length === 2) || (kind === "e" && parts.length === 3);
  if (!shape || !feedUrl) {
    return page(homePage(await releasePromise, canonical, "That share link isn't one we recognize."), 404, 60);
  }

  try {
    if (kind === "p") {
      const feed = await readFeed(feedUrl, { maxItems: 5 });
      const apple = await findAppleShow(feed.show);
      const castroUrl = await resolveCastro(apple);
      return page(
        podcastPage({
          show: feed.show,
          items: feed.items,
          apps: appLinks({ show: feed.show, apple, castroUrl }),
          release: await releasePromise,
          url: canonical,
        }),
      );
    }

    const feed = await readFeed(feedUrl, { maxItems: 10_000, done: (item) => item.hash === hash });
    const item = feed.items.find((i) => i.hash === hash);
    // Publishers prune old episodes; the show is still worth landing on.
    if (!item) return Response.redirect(url.origin + podcastPath(feedUrl), 302);

    const apple = await findAppleShow(feed.show);
    const [appleEpisode, castroUrl] = await Promise.all([
      apple ? findAppleEpisode(apple.collectionId, item.guid) : null,
      resolveCastro(apple),
    ]);
    return page(
      episodePage({
        show: feed.show,
        item,
        startSec: parseStart(url.searchParams.get("t")),
        apps: appLinks({ show: feed.show, item, apple, appleEpisode, castroUrl }),
        release: await releasePromise,
        url: canonical,
      }),
    );
  } catch (e) {
    const reason = e instanceof FeedError ? e.message : "the request failed";
    console.warn(`feed unavailable: ${reason}`);
    // A 404 or 410 is a feed that moved without a redirect or was taken down;
    // telling someone to try again later would be a lie.
    const gone = e instanceof FeedError && (e.status === 404 || e.status === 410);
    const notice = gone
      ? "That podcast's feed has moved or been taken down, so this link can't show it anymore."
      : "We couldn't reach that podcast's feed just now. Try again in a bit.";
    return page(homePage(await releasePromise, canonical, notice), gone ? 404 : 502, 60);
  }
}

interface Env {
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    const cache = caches.default;
    const keyUrl = new URL(canonicalUrl(url));
    keyUrl.searchParams.set("_v", env.CF_VERSION_METADATA.id);
    const key = new Request(keyUrl, { method: "GET" });
    const hit = await cache.match(key);
    if (hit) return hit;

    const response = await route(request);
    if (response.status === 200) ctx.waitUntil(cache.put(key, response.clone()));
    return response;
  },
} satisfies ExportedHandler<Env>;
