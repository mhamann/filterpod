import { XMLParser } from 'fast-xml-parser'
import type { Episode, Podcast, TranscriptRef } from '@/core/types'
import { episodeIdFor, podcastIdFor } from '@/data/db'

/**
 * RSS parsing for podcast feeds.
 *
 * Covers RSS 2.0 plus the itunes namespace (the de-facto standard) and the parts of the
 * podcast namespace we actually use — chiefly `podcast:transcript`, which is what lets
 * the filter pipeline skip or narrow an expensive ASR pass.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Namespace prefixes are kept: `itunes:duration` and `podcast:transcript` must stay
  // distinguishable from any same-named element in the default namespace.
  removeNSPrefix: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
})

type XmlNode = Record<string, unknown>

/** Feed elements are singular or repeated depending on count; normalize to an array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** fast-xml-parser yields a string for a bare element and an object when attributes exist. */
function text(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && '#text' in (value as XmlNode)) {
    return String((value as XmlNode)['#text'] ?? '')
  }
  return String(value)
}

function attr(node: unknown, name: string): string | undefined {
  if (node && typeof node === 'object') {
    const value = (node as XmlNode)[`@_${name}`]
    if (value != null) return String(value)
  }
  return undefined
}

/** Accepts `HH:MM:SS`, `MM:SS`, or plain seconds — all three appear in the wild. */
export function parseDuration(raw: string): number | undefined {
  const value = raw.trim()
  if (!value) return undefined
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value))

  const parts = value.split(':').map((part) => Number(part))
  if (parts.some((part) => Number.isNaN(part))) return undefined
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return undefined
}

function parseDate(raw: string): number {
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

function parseExplicit(raw: string): boolean {
  const value = raw.trim().toLowerCase()
  return value === 'yes' || value === 'true' || value === 'explicit'
}

/** Strips markup from a description without pulling in a sanitizer dependency. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

const TRANSCRIPT_TYPES: Record<string, TranscriptRef['type']> = {
  'text/vtt': 'text/vtt',
  'application/x-subrip': 'application/x-subrip',
  'application/srt': 'application/x-subrip',
  'application/json': 'application/json',
  'text/plain': 'text/plain',
}

function parseTranscripts(item: XmlNode): TranscriptRef[] {
  const refs: TranscriptRef[] = []
  for (const node of asArray(item['podcast:transcript'])) {
    const url = attr(node, 'url')
    const type = TRANSCRIPT_TYPES[(attr(node, 'type') ?? '').toLowerCase()]
    if (!url || !type) continue
    refs.push({ url, type, language: attr(node, 'language') })
  }
  return refs
}

export interface ParsedFeed {
  podcast: Podcast
  episodes: Episode[]
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const doc = parser.parse(xml) as XmlNode
  const rss = (doc.rss ?? doc) as XmlNode
  const channel = (rss.channel ?? rss) as XmlNode
  if (!channel || typeof channel !== 'object') {
    throw new Error('not a podcast feed: no channel element')
  }

  const id = podcastIdFor(feedUrl)

  const artworkUrl =
    attr(channel['itunes:image'], 'href') ??
    text((channel.image as XmlNode | undefined)?.url) ??
    ''

  const categories = asArray(channel['itunes:category'])
    .map((node) => attr(node, 'text') ?? '')
    .filter(Boolean)

  const podcast: Podcast = {
    id,
    feedUrl,
    title: text(channel.title) || 'Untitled podcast',
    author: text(channel['itunes:author']) || text(channel.managingEditor) || '',
    description: stripHtml(text(channel.description) || text(channel['itunes:summary'])),
    artworkUrl,
    link: text(channel.link) || undefined,
    categories,
    explicit: parseExplicit(text(channel['itunes:explicit'])),
    lastFetchedAt: Date.now(),
  }

  const episodes: Episode[] = []
  for (const item of asArray(channel.item) as XmlNode[]) {
    const enclosure = item.enclosure
    const audioUrl = attr(enclosure, 'url')
    // An item without playable audio is not an episode.
    if (!audioUrl) continue

    const guidNode = item.guid
    const guid = text(guidNode) || audioUrl

    const durationSec = parseDuration(text(item['itunes:duration']))
    const lengthAttr = attr(enclosure, 'length')

    episodes.push({
      id: episodeIdFor(id, guid),
      podcastId: id,
      guid,
      title: text(item.title) || 'Untitled episode',
      description: stripHtml(
        text(item['content:encoded']) || text(item.description) || text(item['itunes:summary']),
      ),
      audioUrl,
      audioType: attr(enclosure, 'type'),
      audioLength: lengthAttr ? Number(lengthAttr) || undefined : undefined,
      durationSec,
      publishedAt: parseDate(text(item.pubDate)),
      episodeNumber: Number(text(item['itunes:episode'])) || undefined,
      seasonNumber: Number(text(item['itunes:season'])) || undefined,
      explicit: parseExplicit(text(item['itunes:explicit'])) || podcast.explicit,
      artworkUrl: attr(item['itunes:image'], 'href'),
      transcripts: parseTranscripts(item),
    })
  }

  return { podcast, episodes }
}
