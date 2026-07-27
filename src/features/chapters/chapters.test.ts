import { describe, expect, it, vi } from 'vitest'

vi.mock('@/platform', () => ({ getPlatform: () => ({ http: { get: vi.fn() } }) }))
// Partial mock: parseFeed pulls the id helpers from the same module the cache lives in.
vi.mock('@/data/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/db')>()),
  db: { chapters: { get: vi.fn(), put: vi.fn() } },
}))

const { chapterAt, normalizeChapters } = await import('./chapters')
const { parseFeed } = await import('@/features/feeds/parseFeed')

/**
 * Chapter files are third-party data, so the normalization is where the safety lives:
 * whatever a publisher ships, the player must end up with clean, ordered, seekable
 * markers or nothing.
 */
describe('normalizeChapters', () => {
  it('orders chapters and keeps only what is renderable', () => {
    const chapters = normalizeChapters({
      chapters: [
        { startTime: 300, title: 'Second' },
        { startTime: 0, title: 'Intro', img: 'https://example.com/a.jpg' },
        { startTime: 'nonsense', title: 'dropped' },
        { startTime: -5, title: 'dropped too' },
        { startTime: 120, title: 'Hidden marker', toc: false },
      ],
    })

    expect(chapters.map((c) => [c.startSec, c.title])).toEqual([
      [0, 'Intro'],
      [300, 'Second'],
    ])
    expect(chapters[0].imageUrl).toBe('https://example.com/a.jpg')
  })

  it('keeps one of two chapters starting at the same instant', () => {
    const chapters = normalizeChapters({
      chapters: [
        { startTime: 60, title: 'A' },
        { startTime: 60, title: 'B' },
      ],
    })
    expect(chapters).toHaveLength(1)
  })

  it('returns nothing for garbage documents', () => {
    expect(normalizeChapters(null)).toEqual([])
    expect(normalizeChapters('chapters')).toEqual([])
    expect(normalizeChapters({ chapters: 'nope' })).toEqual([])
  })
})

describe('chapterAt', () => {
  const chapters = normalizeChapters({
    chapters: [
      { startTime: 0, title: 'Intro' },
      { startTime: 100, title: 'Middle' },
      { startTime: 200, title: 'End' },
    ],
  })

  it('finds the chapter containing the playhead', () => {
    expect(chapterAt(chapters, 0)?.title).toBe('Intro')
    expect(chapterAt(chapters, 150)?.title).toBe('Middle')
    expect(chapterAt(chapters, 9999)?.title).toBe('End')
  })

  it('is null before the first marker', () => {
    const late = normalizeChapters({ chapters: [{ startTime: 30, title: 'Late start' }] })
    expect(chapterAt(late, 10)).toBeNull()
  })
})

describe('podcast:chapters in the feed', () => {
  const feed = (chaptersTag: string) => `<?xml version="1.0"?>
    <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
      <channel><title>Show</title>
        <item>
          <title>Ep</title>
          <enclosure url="https://example.com/ep.mp3" type="audio/mpeg"/>
          ${chaptersTag}
        </item>
      </channel>
    </rss>`

  it('extracts the chapters URL', () => {
    const { episodes } = parseFeed(
      feed('<podcast:chapters url="https://example.com/ch.json" type="application/json+chapters"/>'),
      'https://example.com/feed.xml',
    )
    expect(episodes[0].chaptersUrl).toBe('https://example.com/ch.json')
  })

  it('accepts plain application/json, which real hosts emit', () => {
    const { episodes } = parseFeed(
      feed('<podcast:chapters url="https://example.com/ch.json" type="application/json"/>'),
      'https://example.com/feed.xml',
    )
    expect(episodes[0].chaptersUrl).toBe('https://example.com/ch.json')
  })

  it('ignores non-JSON chapter formats rather than fetching what it cannot parse', () => {
    const { episodes } = parseFeed(
      feed('<podcast:chapters url="https://example.com/ch.psc" type="application/xml"/>'),
      'https://example.com/feed.xml',
    )
    expect(episodes[0].chaptersUrl).toBeUndefined()
  })
})
