import { XMLParser } from 'fast-xml-parser'

/**
 * OPML import — the lingua franca of podcast migration.
 *
 * Pocket Casts, AntennaPod, Overcast and nearly everything else export an OPML file of
 * subscriptions, so one parser covers most "switch to FilterPod" paths. Queues and
 * listening history are not in OPML (no app exports them publicly); subscriptions are
 * what migrates.
 */

export interface OpmlFeed {
  title: string
  feedUrl: string
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
})

type XmlNode = Record<string, unknown>

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Extracts every feed from an OPML document, folders and all.
 *
 * Outlines nest arbitrarily — apps group shows into folders — so this walks rather than
 * mapping a single level. Deduped by URL, because the same feed can appear in more than
 * one folder and importing it twice would just churn.
 */
export function parseOpml(xml: string): OpmlFeed[] {
  const doc = parser.parse(xml) as XmlNode
  const opml = doc.opml as XmlNode | undefined
  const body = opml?.body as XmlNode | undefined
  if (!body) throw new Error('not an OPML file')

  const feeds: OpmlFeed[] = []
  const seen = new Set<string>()

  const walk = (node: unknown) => {
    for (const outline of asArray(node) as XmlNode[]) {
      if (!outline || typeof outline !== 'object') continue
      const url = outline['@_xmlUrl']
      if (typeof url === 'string' && url.startsWith('http') && !seen.has(url)) {
        seen.add(url)
        feeds.push({
          title: String(outline['@_text'] ?? outline['@_title'] ?? url),
          feedUrl: url,
        })
      }
      if (outline.outline) walk(outline.outline)
    }
  }
  walk(body.outline)
  return feeds
}
