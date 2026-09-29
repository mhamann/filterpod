/**
 * Just enough RSS to draw a share page.
 *
 * The page needs the show's header and, for an episode link, one item — never the
 * whole feed. Feeds run to megabytes and the episode someone shares is almost always
 * near the top, so the body is read as a stream and dropped the moment what the page
 * needs has arrived. That also keeps parsing well inside a Worker's CPU budget.
 *
 * Field precedence follows the app's parser (kmp/shared/.../feeds/ParseFeed.kt), and
 * the guid rule has to match it exactly: the episode hash in a share link is computed
 * from it, so a different fallback would mean a link the page cannot find.
 */

import { fnv1a } from "./links";

export interface Show {
  feedUrl: string;
  title: string;
  author: string;
  description: string;
  artworkUrl: string;
  link: string | null;
}

export interface Item {
  guid: string;
  /** fnv1a(guid): the episode segment of a share link. */
  hash: string;
  title: string;
  description: string;
  link: string | null;
  audioUrl: string;
  publishedAt: number;
  durationSec: number | null;
  artworkUrl: string | null;
  season: number | null;
  episode: number | null;
}

export interface Feed {
  show: Show;
  items: Item[];
}

export class FeedError extends Error {
  /** The publisher's HTTP status, when the feed answered at all. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const MAX_BYTES = 24 * 1024 * 1024;
const USER_AGENT = "FilterPodShare/1.0 (+https://github.com/mhamann/filterpod)";

/**
 * Reads [feedUrl] until [done] says the items so far are enough, or [maxItems] have
 * been parsed, or the feed ends.
 */
export async function readFeed(
  feedUrl: string,
  opts: { maxItems: number; done?: (item: Item) => boolean },
): Promise<Feed> {
  const response = await fetch(feedUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
    },
    signal: AbortSignal.timeout(10_000),
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!response.ok || !response.body) throw new FeedError(`feed returned HTTP ${response.status}`, response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const scanner = new FeedScanner(feedUrl);
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) break;
      if (scanner.push(decoder.decode(value, { stream: true }), opts)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return scanner.finish();
}

/** Incremental parser; exported for tests, which feed it text directly. */
export class FeedScanner {
  private buffer = "";
  private show: Show | null = null;
  private items: Item[] = [];
  private sawXml = false;

  constructor(private feedUrl: string) {}

  /** Appends text; true once there is no reason to read further. */
  push(text: string, opts: { maxItems: number; done?: (item: Item) => boolean }): boolean {
    this.buffer += text;
    if (!this.sawXml && /<(rss|channel)[\s>]/i.test(this.buffer)) this.sawXml = true;

    if (!this.show) {
      const start = this.buffer.search(/<item[\s>]/i);
      if (start < 0) return false;
      this.show = parseShow(this.buffer.slice(0, start), this.feedUrl);
      this.buffer = this.buffer.slice(start);
    }

    while (true) {
      const end = this.buffer.search(/<\/item\s*>/i);
      if (end < 0) return false;
      const close = this.buffer.indexOf(">", end) + 1;
      const item = parseItem(this.buffer.slice(0, close));
      this.buffer = this.buffer.slice(close);
      const next = this.buffer.search(/<item[\s>]/i);
      this.buffer = next < 0 ? "" : this.buffer.slice(next);
      if (!item) continue;
      this.items.push(item);
      if (opts.done?.(item) || this.items.length >= opts.maxItems) return true;
    }
  }

  finish(): Feed {
    if (!this.sawXml) throw new FeedError("not a podcast feed");
    // A feed with no items never reached the header split.
    const show = this.show ?? parseShow(this.buffer, this.feedUrl);
    return { show, items: this.items };
  }
}

function parseShow(header: string, feedUrl: string): Show {
  // Blocks with their own <title>s, which would otherwise shadow the channel's.
  const xml = strip(header, ["image", "itunes:owner", "podcast:liveItem", "podcast:trailer"]);
  const image = tag(header, "image");
  return {
    feedUrl,
    title: plain(tag(xml, "title")) || "Untitled podcast",
    author: plain(tag(xml, "itunes:author")) || plain(tag(xml, "managingEditor")),
    description: prose(tag(xml, "description") || tag(xml, "itunes:summary")),
    artworkUrl: attr(xml, "itunes:image", "href") || plain(tag(image, "url")),
    link: httpUrl(plain(tag(xml, "link"))),
  };
}

function parseItem(xml: string): Item | null {
  const audioUrl = attr(xml, "enclosure", "url");
  // An item without playable audio is not an episode — the app skips it too.
  if (!audioUrl) return null;
  const guid = guidOf(xml) || audioUrl;
  const published = Date.parse(plain(tag(xml, "pubDate")));
  return {
    guid,
    hash: fnv1a(guid),
    title: plain(tag(xml, "title")) || "Untitled episode",
    description: prose(
      tag(xml, "content:encoded") || tag(xml, "description") || tag(xml, "itunes:summary"),
    ),
    link: httpUrl(plain(tag(xml, "link"))),
    audioUrl,
    publishedAt: Number.isNaN(published) ? 0 : published,
    durationSec: parseDuration(plain(tag(xml, "itunes:duration"))),
    artworkUrl: attr(xml, "itunes:image", "href") || null,
    season: int(plain(tag(xml, "itunes:season"))),
    episode: int(plain(tag(xml, "itunes:episode"))),
  };
}

/**
 * The guid string exactly as the app derives it, since the share link hashes it.
 *
 * ParseFeed.kt mirrors fast-xml-parser's value shapes, JS stringification included:
 * the text is XML-decoded once and trimmed, nothing more; an attributed guid with no
 * text reads "[object Object]" (and ids really were minted from that); a repeated
 * guid joins its values with commas, attributed ones again as "[object Object]".
 */
export function guidOf(itemXml: string): string {
  const re = /<guid(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/guid\s*>)/gi;
  const found: { attributed: boolean; value: string }[] = [];
  for (let m; (m = re.exec(itemXml)); ) {
    const attributed = /\S/.test((m[1] ?? "").replace(/\/\s*$/, ""));
    found.push({ attributed, value: xmlText(m[2] ?? "").trim() });
  }
  if (found.length === 0) return "";
  if (found.length === 1) {
    const [g] = found;
    return g.attributed ? g.value || "[object Object]" : g.value;
  }
  return found.map((g) => (g.attributed ? "[object Object]" : g.value)).join(",");
}

// --- XML, loosely ----------------------------------------------------------------

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Raw inner XML of the first <name>, or "". */
function tag(xml: string, name: string): string {
  const n = escapeName(name);
  const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}\\s*>`, "i").exec(xml);
  return m ? m[1] : "";
}

function strip(xml: string, names: string[]): string {
  let out = xml;
  for (const name of names) {
    const n = escapeName(name);
    out = out.replace(new RegExp(`<${n}(?:\\s[^>]*)?>[\\s\\S]*?</${n}\\s*>`, "gi"), "");
  }
  return out;
}

function attr(xml: string, name: string, attribute: string): string {
  const el = new RegExp(`<${escapeName(name)}\\s[^>]*>`, "i").exec(xml);
  if (!el) return "";
  const m = new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(el[0]);
  return m ? decodeEntities((m[1] ?? m[2]).trim()) : "";
}

/** Element text: CDATA taken literally, everything else entity-decoded. */
function text(raw: string): string {
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  for (let m; (m = re.exec(raw)); last = re.lastIndex) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
  }
  return out + decodeEntities(raw.slice(last));
}

/** Character data as an XML parser reports it: CDATA literal, only XML's own entities decoded. */
function xmlText(raw: string): string {
  const xmlEntities = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, body: string) => {
      if (body[0] !== "#") return NAMED[body.toLowerCase()] ?? whole;
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  for (let m; (m = re.exec(raw)); last = re.lastIndex) out += xmlEntities(raw.slice(last, m.index)) + m[1];
  return out + xmlEntities(raw.slice(last));
}

/**
 * A title-like field. Entities are decoded twice, as the app does, because feeds
 * double-encode titles often; markup is left alone — "<Angles>" in a CDATA title is
 * the title, and the page escapes it anyway.
 */
function plain(raw: string): string {
  return decodeEntities(text(raw)).replace(/\s+/g, " ").trim();
}

/** Show notes are HTML; keep the paragraphs, drop the rest. */
function prose(raw: string): string {
  const html = text(raw);
  const withBreaks = html
    // Keep where a link goes, not just what it said (the page linkifies bare URLs).
    .replace(/<a\s[^>]*?href\s*=\s*["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return !text || text === href || href.includes(text) ? href : `${text} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n\n")
    .replace(/<li[\s>]/gi, "\n• $&")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®",
  trade: "™", eacute: "é", bull: "•", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function httpUrl(s: string): string | null {
  return /^https?:\/\//i.test(s) ? s : null;
}

function int(s: string): number | null {
  const n = Number(s);
  return s !== "" && Number.isInteger(n) ? n : null;
}

/** itunes:duration as seconds: "3600", "60:00" or "1:00:00". */
export function parseDuration(s: string): number | null {
  if (!s) return null;
  const parts = s.split(":").map(Number);
  if (parts.length > 3 || parts.some((p) => Number.isNaN(p))) return null;
  const sec = parts.reduce((acc, p) => acc * 60 + p, 0);
  return sec > 0 ? Math.round(sec) : null;
}
