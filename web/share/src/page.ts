/**
 * The share page, drawn to look like FilterPod's Now Playing sheet.
 *
 * Same palette (kmp/androidApp/.../ui/Theme.kt), same bones: a wash of the artwork's
 * own color behind everything, a halo hugging the cover, the show as a small caps
 * label over the episode title, and the cut timeline when the link carries a position.
 * Where the app has its play button, the page has the one thing it is for: get
 * FilterPod. Everything a visitor might want instead — their own app, the feed — is
 * right below it, not hidden.
 */

import type { AppLink } from "./apps";
import type { Item, Show } from "./feed";
import { html, raw, type Raw } from "./html";
import { episodePath, podcastPath } from "./links";
import { RELEASES_URL, REPO, type Release } from "./release";

const REPO_URL = `https://github.com/${REPO}`;

interface Meta {
  title: string;
  description: string;
  image: string | null;
  url: string;
}

// --- shared bits -----------------------------------------------------------------

const MARK = raw(
  `<svg viewBox="0 0 108 108" aria-hidden="true"><g stroke="currentColor" stroke-width="11" stroke-linecap="round"><path d="M54 54 L54 29"/><path d="M54 54 L32.35 41.5"/><path d="M54 54 L32.35 66.5"/><path d="M54 54 L54 79"/><path d="M54 54 L75.65 66.5"/><path d="M54 54 L75.65 41.5"/></g></svg>`,
);
const ICON_PLAY = raw(`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`);
const ICON_CHECK = raw(
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
);
const ICON_SHIELD = raw(
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>`,
);
const ICON_RSS = raw(
  `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.18" cy="17.82" r="2.18"/><path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z"/></svg>`,
);

function https(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/^http:\/\//i, "https://");
}

export function timecode(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function duration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

function date(ms: number): string | null {
  if (!ms) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(ms);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/** Escaped show notes with bare URLs turned into links. */
function notes(text: string): Raw {
  const escaped = html`${clip(text, 5000)}`.value;
  return raw(
    escaped.replace(
      /https?:\/\/[^\s<]+[^\s<.,;:!?)'"&]/g,
      (url) => `<a href="${url}" rel="nofollow noopener ugc" target="_blank">${url}</a>`,
    ),
  );
}

function artwork(url: string | null, alt: string): Raw {
  if (!url) {
    return html`<div class="art"><div class="cover placeholder">${MARK}</div></div>`;
  }
  return html`<div class="art">
    <img class="halo" src="${url}" alt="" aria-hidden="true" />
    <img class="cover" src="${url}" alt="${alt}" width="300" height="300" />
  </div>`;
}

function glow(url: string | null): Raw {
  if (!url) return html``;
  return html`<div class="glow" aria-hidden="true"><img src="${url}" alt="" /></div>`;
}

function getButton(release: Release, title = "Listen clean with FilterPod"): Raw {
  const detail = ["Free for Android", release.version].filter(Boolean).join(" · ");
  return html`<a class="cta" href="${release.downloadUrl}">
      <span class="cta-icon">${ICON_PLAY}</span>
      <span class="cta-text">
        <span class="cta-title">${title}</span>
        <span class="cta-detail" data-get-detail>${detail}</span>
      </span>
    </a>
    <p class="cta-note">Skips the swearing before you hear it. Filtering runs on your phone.</p>`;
}

function openIn(apps: AppLink[], feedUrl: string): Raw {
  return html`<section class="open-in">
    <h2 class="label">Or open in</h2>
    <div class="chips">
      ${apps.map(
        (a) =>
          html`<a class="chip" href="${a.url}" data-platforms="${a.platforms.join(" ")}" rel="noopener"
            >${a.name}</a
          >`,
      )}
      <button class="chip" type="button" data-copy="${feedUrl}">
        ${ICON_RSS}<span data-copy-label>Copy RSS feed</span>
      </button>
    </div>
  </section>`;
}

function pitch(release: Release, headline = "Coarse language, filtered out."): Raw {
  return html`<section class="pitch" id="filterpod">
    <div class="pitch-mark">${MARK}</div>
    <h2 class="pitch-title">${headline}</h2>
    <p class="pitch-lede">
      FilterPod is a podcast player that skips swearing before you hear it. Subscribe to
      anything with an RSS feed, press play, and it listens a few seconds ahead.
    </p>
    <ul class="features">
      <li>
        <span class="feature-icon ember">${ICON_PLAY}</span>
        <span><strong>Cut before it reaches you.</strong> The player seeks past each flagged
          word just ahead of the playhead, so the cut lands before the word, not after.</span>
      </li>
      <li>
        <span class="feature-icon sage">${ICON_SHIELD}</span>
        <span><strong>Nothing leaves your phone.</strong> Transcription runs on-device. No
          account, no analytics, and the app never talks to a FilterPod server.</span>
      </li>
      <li>
        <span class="feature-icon sage">${ICON_CHECK}</span>
        <span><strong>A real podcast app.</strong> Subscriptions, queue, downloads, chapters,
          per-show speed — with the filter built in.</span>
      </li>
    </ul>
    ${getButton(release, "Get FilterPod")}
    <p class="pitch-links">
      <a href="${REPO_URL}">Source on GitHub</a>
      <span aria-hidden="true">·</span>
      <a href="${RELEASES_URL}">All releases</a>
    </p>
  </section>`;
}

function header(label: string): Raw {
  return html`<header class="strip">
    <a class="brand" href="#filterpod" aria-label="About FilterPod">${MARK}</a>
    <span class="label">${label}</span>
    <span class="brand-spacer"></span>
  </header>`;
}

function footer(opts: { show?: string } = {}): Raw {
  return html`<footer>
    ${opts.show ? html`<p>FilterPod isn't affiliated with ${opts.show}.</p>` : ""}
    <p>
      ${opts.show ? "This page read the show's public feed to draw itself. " : ""}No cookies, no
      tracking. <a href="/privacy">Privacy</a> · <a href="/">About FilterPod</a>
    </p>
  </footer>`;
}

function layout(meta: Meta, art: string | null, body: Raw): string {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${meta.title}</title>
    <meta name="description" content="${meta.description}" />
    <meta name="theme-color" content="#0D0F13" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="canonical" href="${meta.url}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="FilterPod" />
    <meta property="og:title" content="${meta.title}" />
    <meta property="og:description" content="${meta.description}" />
    <meta property="og:url" content="${meta.url}" />
    ${meta.image ? html`<meta property="og:image" content="${meta.image}" />` : ""}
    <meta name="twitter:card" content="summary" />
    <style>${raw(CSS)}</style>
  </head>
  <body>
    ${glow(art)}
    <div class="shade" aria-hidden="true"></div>
    <main>${body}</main>
    <script src="/app.js" defer></script>
  </body>
</html>`.value;
}

// --- pages -----------------------------------------------------------------------

export function episodePage(opts: {
  show: Show;
  item: Item;
  startSec: number | null;
  apps: AppLink[];
  release: Release;
  url: string;
}): string {
  const { show, item, startSec, apps, release } = opts;
  const art = https(item.artworkUrl) ?? https(show.artworkUrl);
  const number = [
    item.season ? `S${item.season}` : null,
    item.episode ? `E${item.episode}` : null,
  ].filter(Boolean).join(" ");
  const meta = [date(item.publishedAt), item.durationSec ? duration(item.durationSec) : null, number || null]
    .filter(Boolean)
    .join(" · ");

  const start = startSec && item.durationSec ? Math.min(startSec, item.durationSec) : startSec;
  const timeline =
    start && item.durationSec
      ? html`<div class="timeline" role="img" aria-label="Shared from ${timecode(start)}">
            <div class="track"><div class="fill" style="width:${((start / item.durationSec) * 100).toFixed(2)}%"></div></div>
          </div>
          <div class="times"><span>${timecode(start)}</span><span>−${timecode(item.durationSec - start)}</span></div>`
      : "";

  const body = html`
    ${header("Shared episode")}
    <section class="sheet">
      ${artwork(art, item.title)}
      <a class="label show-link" href="${podcastPath(show.feedUrl)}">${show.title}</a>
      <h1 class="title">${item.title}</h1>
      ${meta ? html`<p class="meta">${meta}</p>` : ""}
      ${start ? html`<p class="pill ember">Starts at ${timecode(start)}</p>` : ""}
      ${timeline}
      ${item.description
        ? html`<details class="notes">
            <summary class="chip">Show notes</summary>
            <div class="notes-body">${notes(item.description)}</div>
          </details>`
        : ""}
      <div class="actions">${getButton(release)}</div>
      ${openIn(apps, show.feedUrl)}
    </section>
    ${pitch(release)}
    ${footer({ show: show.title })}
  `;

  return layout(
    {
      title: `${item.title} · ${show.title}`,
      description: start
        ? `From ${timecode(start)} — listen clean with FilterPod.`
        : clip(item.description, 180) || `Listen clean with FilterPod.`,
      image: art,
      url: opts.url,
    },
    art,
    body,
  );
}

export function podcastPage(opts: {
  show: Show;
  items: Item[];
  apps: AppLink[];
  release: Release;
  url: string;
}): string {
  const { show, items, apps, release } = opts;
  const art = https(show.artworkUrl);

  const latest = items.length
    ? html`<section class="latest">
        <h2 class="label">Latest episodes</h2>
        <ol class="episodes">
          ${items.map(
            (item) => html`<li>
              <a href="${episodePath(show.feedUrl, item.guid)}">
                <span class="ep-meta">${[date(item.publishedAt), item.durationSec ? duration(item.durationSec) : null]
                  .filter(Boolean)
                  .join(" · ")}</span>
                <span class="ep-title">${item.title}</span>
              </a>
            </li>`,
          )}
        </ol>
      </section>`
    : "";

  const body = html`
    ${header("Shared podcast")}
    <section class="sheet">
      ${artwork(art, show.title)}
      ${show.author ? html`<p class="label">${show.author}</p>` : ""}
      <h1 class="title">${show.title}</h1>
      ${show.description ? html`<p class="blurb">${clip(show.description, 420)}</p>` : ""}
      <div class="actions">${getButton(release)}</div>
      ${openIn(apps, show.feedUrl)}
      ${latest}
    </section>
    ${pitch(release)}
    ${footer({ show: show.title })}
  `;

  return layout(
    {
      title: `${show.title} · Listen clean with FilterPod`,
      description: clip(show.description, 180) || `Listen clean with FilterPod.`,
      image: art,
      url: opts.url,
    },
    art,
    body,
  );
}

export function homePage(release: Release, url: string, notice?: string): string {
  const body = html`
    ${header("FilterPod")}
    ${notice ? html`<p class="notice">${notice}</p>` : ""}
    ${pitch(release, "Podcasts, minus the swearing.")}
    ${footer()}
  `;
  return layout(
    {
      title: "FilterPod · Podcasts, minus the swearing",
      description: "A podcast player that skips coarse language before you hear it. On-device, open source.",
      image: null,
      url,
    },
    null,
    body,
  );
}

export function privacyPage(policyHtml: string, url: string): string {
  const body = html`
    ${header("Privacy")}
    <article class="doc">${raw(policyHtml)}</article>
    ${footer()}
  `;
  return layout(
    {
      title: "Privacy · FilterPod",
      description: "FilterPod doesn't collect your data. What the app and its share pages do and don't do.",
      image: null,
      url,
    },
    null,
    body,
  );
}

// --- style -----------------------------------------------------------------------

const CSS = /* css */ `
:root {
  --bg: #0d0f13;
  --on: #e9e5df;
  --muted: #9ba0a8;
  --container: #14171c;
  --high: #1b1e24;
  --highest: #23262e;
  --outline: #3a3e48;
  --outline-v: #262a32;
  --ember: #f97316;
  --ember-dim: #e05e10;
  --on-ember: #15100b;
  --sage: #86c68c;
  --mark: #cf8842;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--on);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
a { color: inherit; }
svg { fill: currentColor; }

/* The artwork's color, washed behind the sheet — the app's artGlowBackground. */
.glow {
  position: absolute; inset: 0 0 auto 0; height: 1100px;
  overflow: hidden; pointer-events: none; z-index: 0;
  -webkit-mask-image: linear-gradient(#000 35%, transparent 95%);
          mask-image: linear-gradient(#000 35%, transparent 95%);
}
.glow img {
  position: absolute; left: 50%; top: 40px; width: 900px; max-width: 180vw;
  transform: translateX(-50%);
  filter: blur(110px) saturate(1.5);
  opacity: 0.28;
}
/* topShade: darkens the strip under the status bar, eased to nothing. */
.shade {
  position: absolute; inset: 0 0 auto 0; height: 120px; pointer-events: none; z-index: 0;
  background: linear-gradient(rgba(0,0,0,.42), rgba(0,0,0,.30) 30%, rgba(0,0,0,.10) 70%, transparent);
}

main {
  position: relative; z-index: 1;
  max-width: 460px; margin: 0 auto;
  padding: 0 16px calc(24px + env(safe-area-inset-bottom));
}

.label {
  margin: 0;
  font-size: 11px; font-weight: 500; line-height: 16px;
  letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--muted);
}

.strip {
  display: grid; grid-template-columns: 40px 1fr 40px; align-items: center;
  padding: calc(10px + env(safe-area-inset-top)) 0 6px;
  text-align: center;
}
.brand { display: grid; place-items: center; width: 40px; height: 40px; color: var(--mark); }
.brand svg { width: 26px; height: 26px; }

.sheet { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 8px; }

.art { position: relative; width: min(300px, 76vw); aspect-ratio: 1; margin-top: 36px; }
.art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 14px; }
/* artHaloGlow: a tight, bright rim of the art's own light, even at the corners. */
.art .halo { filter: blur(24px) saturate(1.5); opacity: 0.75; transform: scale(1.03); }
.art .cover { box-shadow: 0 1px 0 rgba(255,255,255,.04) inset; background: var(--high); }
.placeholder {
  position: absolute; inset: 0; border-radius: 14px; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 42%, #1b120b, #0a0605); color: var(--mark);
}
.placeholder svg { width: 42%; }

.show-link { margin-top: 20px; text-decoration: none; }
.show-link:hover { color: var(--on); }
.sheet > .label:not(.show-link) { margin-top: 20px; }
.title {
  margin: 8px 0 0; font-size: 22px; line-height: 28px; font-weight: 400;
  text-wrap: balance; overflow-wrap: anywhere;
}
.meta { margin: 6px 0 0; font-size: 13px; color: var(--muted); }
.blurb {
  margin: 12px 0 0; font-size: 14px; line-height: 20px; color: var(--muted);
  white-space: pre-line; text-align: left;
}

.pill {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 18px 0 0; padding: 4px 12px; border-radius: 999px;
  font-size: 12px; font-weight: 500; line-height: 18px;
}
.pill.ember { background: rgba(249,115,22,.14); color: var(--ember); }

/* CutTimeline, at rest at the shared position. */
.timeline { width: 100%; margin-top: 16px; padding: 10px 0; }
.track { position: relative; height: 4px; border-radius: 2px; background: var(--highest); }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--on); }
.fill::after {
  content: ""; position: absolute; right: -6px; top: 50%; width: 12px; height: 12px;
  border-radius: 50%; background: var(--on); transform: translateY(-50%);
}
.times {
  display: flex; justify-content: space-between; width: 100%;
  font-size: 11px; line-height: 16px; font-weight: 500; color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px; border-radius: 999px; border: 0;
  background: var(--high); color: var(--on);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 18px;
  text-decoration: none; cursor: pointer;
  transition: background .15s;
}
.chip:hover { background: var(--highest); }
.chip svg { width: 15px; height: 15px; color: var(--ember); }
.chip.copied { color: var(--sage); }

.notes { width: 100%; margin-top: 14px; }
.notes summary { list-style: none; }
.notes summary::-webkit-details-marker { display: none; }
.notes-body {
  margin-top: 12px; padding: 14px 16px; border-radius: 16px; background: var(--container);
  text-align: left; font-size: 14px; line-height: 21px; color: var(--muted);
  white-space: pre-line; overflow-wrap: anywhere; max-height: 360px; overflow-y: auto;
}
.notes-body a { color: var(--ember); text-decoration: none; }

.actions { width: 100%; margin-top: 28px; }
.cta {
  display: flex; align-items: center; gap: 14px; width: 100%;
  padding: 10px 20px 10px 10px; border-radius: 999px;
  background: var(--ember); color: var(--on-ember); text-decoration: none; text-align: left;
  box-shadow: 0 10px 30px -12px rgba(249,115,22,.55);
  transition: background .15s, transform .15s;
}
.cta:hover { background: #fb8531; }
.cta:active { transform: scale(.985); }
.cta-icon {
  flex: none; display: grid; place-items: center; width: 48px; height: 48px;
  border-radius: 50%; background: rgba(21,16,11,.12);
}
.cta-icon svg { width: 26px; height: 26px; }
.cta-text { display: flex; flex-direction: column; min-width: 0; }
.cta-title { font-size: 17px; line-height: 22px; font-weight: 600; }
.cta-detail { font-size: 12px; line-height: 16px; opacity: .72; }
.cta-note { margin: 10px 0 0; font-size: 12px; line-height: 17px; color: var(--muted); text-align: center; }

.open-in { width: 100%; margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--outline-v); }
.chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 12px; }

.latest { width: 100%; margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--outline-v); text-align: left; }
.latest .label { text-align: center; }
.episodes { list-style: none; margin: 8px 0 0; padding: 0; }
.episodes li + li { border-top: 1px solid var(--outline-v); }
.episodes a { display: flex; flex-direction: column; gap: 2px; padding: 12px 4px; text-decoration: none; }
.episodes a:hover .ep-title { color: var(--ember); }
.ep-meta { font-size: 11px; line-height: 16px; font-weight: 500; letter-spacing: .04em; color: var(--muted); }
.ep-title { font-size: 15px; line-height: 21px; }

.pitch {
  margin-top: 56px; padding: 28px 20px 24px; border-radius: 24px;
  background: linear-gradient(180deg, var(--container), rgba(20,23,28,.6));
  border: 1px solid var(--outline-v);
}
.pitch-mark {
  width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 42%, #1b120b, #0a0605); color: var(--mark);
  box-shadow: 0 0 0 1px rgba(207,136,66,.18), 0 8px 24px -8px rgba(249,115,22,.35);
}
.pitch-mark svg { width: 38px; height: 38px; }
.pitch-title { margin: 18px 0 0; font-size: 26px; line-height: 32px; font-weight: 600; letter-spacing: -.01em; }
.pitch-lede { margin: 10px 0 0; font-size: 15px; line-height: 22px; color: var(--muted); }
.features { list-style: none; margin: 22px 0 26px; padding: 0; display: grid; gap: 16px; }
.features li { display: grid; grid-template-columns: 32px 1fr; gap: 12px; font-size: 14px; line-height: 20px; color: var(--muted); }
.features strong { color: var(--on); font-weight: 600; }
.feature-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; }
.feature-icon svg { width: 17px; height: 17px; }
.feature-icon.ember { background: rgba(249,115,22,.14); color: var(--ember); }
.feature-icon.sage { background: rgba(134,198,140,.15); color: var(--sage); }
.pitch-links { margin: 16px 0 0; font-size: 13px; color: var(--muted); text-align: center; }
.pitch-links a { color: var(--on); text-decoration: none; }
.pitch-links a:hover { color: var(--ember); }

.notice {
  margin: 24px 0 0; padding: 12px 16px; border-radius: 14px;
  background: rgba(240,106,90,.12); color: #f5a197; font-size: 14px; text-align: center;
}

.doc { margin-top: 12px; padding: 4px 4px 0; font-size: 15px; line-height: 23px; color: var(--muted); overflow-wrap: anywhere; }
.doc h1 { margin: 16px 0 4px; font-size: 26px; line-height: 32px; font-weight: 600; letter-spacing: -.01em; color: var(--on); }
.doc h1 + p em { font-style: normal; font-size: 12px; letter-spacing: .04em; }
.doc h2 {
  margin: 32px 0 10px; font-size: 11px; line-height: 16px; font-weight: 500;
  letter-spacing: .11em; text-transform: uppercase; color: var(--ember);
}
.doc p, .doc ul, .doc ol { margin: 0 0 14px; }
.doc ul, .doc ol { padding-left: 20px; }
.doc li { margin: 6px 0; }
.doc li p { margin: 0 0 8px; }
.doc strong { color: var(--on); font-weight: 600; }
.doc a { color: var(--ember); text-decoration: none; }
.doc a:hover { text-decoration: underline; }
.doc code {
  font: 13px/1 ui-monospace, "SF Mono", Menlo, monospace;
  padding: 2px 5px; border-radius: 6px; background: var(--high); color: var(--on);
}

footer { margin-top: 28px; text-align: center; font-size: 12px; line-height: 18px; color: var(--muted); }
footer p { margin: 6px 0; }
footer a { color: var(--on); }

:focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

// --- behavior --------------------------------------------------------------------

export const SCRIPT = /* js */ `
(() => {
  const ua = navigator.userAgent;
  const platform = /android/i.test(ua) ? "android"
    : /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ? "ios"
    : "web";

  // Offer only the apps that can open here; with no script, every chip stays.
  for (const chip of document.querySelectorAll("[data-platforms]")) {
    if (!chip.dataset.platforms.split(" ").includes(platform)) chip.remove();
  }

  // FilterPod is Android-only for now; say so rather than hand an iPhone an APK.
  if (platform === "ios") {
    for (const d of document.querySelectorAll("[data-get-detail]")) d.textContent = "Android only for now";
  }

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const label = button.querySelector("[data-copy-label]");
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        label.textContent = "Feed copied";
        button.classList.add("copied");
      } catch {
        window.prompt("RSS feed", button.dataset.copy);
      }
    });
  }
})();
`;
