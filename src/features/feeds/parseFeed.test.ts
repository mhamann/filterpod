import { describe, expect, it } from 'vitest'
import { decodeEntities, parseFeed } from './parseFeed'

/**
 * Entity handling for the feeds that exist rather than the feeds the spec describes.
 * A real subscription rendered its own name as "The King&#39;s Chapel" — publisher
 * double-encoding — and its episode descriptions carried literal "&apos;" from CDATA.
 */
describe('decodeEntities', () => {
  it('decodes the double-encoded apostrophe that started this', () => {
    // In the XML this was &amp;#39; — the parser correctly yields the literal below.
    expect(decodeEntities('The King&#39;s Chapel')).toBe("The King's Chapel")
  })

  it('decodes named, numeric and hex forms', () => {
    expect(decodeEntities('Lord&apos;s Day &#8212; a &quot;service&quot;')).toBe(
      'Lord’s Day — a "service"'.replace('’', "'"),
    )
    expect(decodeEntities('caf&#xe9;')).toBe('café')
    expect(decodeEntities('A &rsquo;B&rsquo;')).toBe('A ’B’')
  })

  it('leaves unknown entities and bare ampersands alone', () => {
    expect(decodeEntities('Q&A with &unknown; people & friends')).toBe(
      'Q&A with &unknown; people & friends',
    )
  })
})

describe('parseFeed entity handling', () => {
  const feed = `<?xml version="1.0" encoding="utf-8"?>
    <rss><channel>
      <title>The King&amp;#39;s Chapel</title>
      <item>
        <title><![CDATA[The Lord&apos;s Day]]></title>
        <description><![CDATA[Preaching at The King&apos;s Chapel]]></description>
        <enclosure url="https://example.com/ep.mp3" type="audio/mpeg"/>
      </item>
    </channel></rss>`

  it('renders human apostrophes for both encoding pathologies', () => {
    const { podcast, episodes } = parseFeed(feed, 'https://example.com/feed.xml')
    expect(podcast.title).toBe("The King's Chapel")
    expect(episodes[0].title).toBe("The Lord's Day")
    expect(episodes[0].description).toBe("Preaching at The King's Chapel")
  })
})
