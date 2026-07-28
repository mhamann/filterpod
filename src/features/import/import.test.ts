import { describe, expect, it, vi } from 'vitest'
import { parseOpml } from './opml'

vi.mock('@/platform', () => ({ getPlatform: () => ({ http: { get: vi.fn() } }) }))
vi.mock('@/features/discovery/search', () => ({ searchPodcasts: vi.fn() }))

const { normalizeTitle, matchShow } = await import('./spotify')
const { searchPodcasts } = await import('@/features/discovery/search')

describe('parseOpml', () => {
  it('walks nested folders and dedupes by URL', () => {
    const feeds = parseOpml(`<?xml version="1.0"?>
      <opml version="2.0"><body>
        <outline text="News">
          <outline text="The Daily" type="rss" xmlUrl="https://feeds.example.com/daily.xml"/>
          <outline text="Dup" type="rss" xmlUrl="https://feeds.example.com/daily.xml"/>
        </outline>
        <outline text="Solo Show" type="rss" xmlUrl="https://feeds.example.com/solo.xml"/>
        <outline text="No URL folder"/>
      </body></opml>`)
    expect(feeds.map((feed) => feed.feedUrl)).toEqual([
      'https://feeds.example.com/daily.xml',
      'https://feeds.example.com/solo.xml',
    ])
    expect(feeds[0].title).toBe('The Daily')
  })

  it('rejects a file with no OPML body rather than importing nothing silently', () => {
    expect(() => parseOpml('<html><body>hello</body></html>')).toThrow('not an OPML')
  })
})

describe('Spotify show matching', () => {
  it('normalizes bracketed noise and punctuation', () => {
    expect(normalizeTitle('The Daily [Video]')).toBe('the daily')
    expect(normalizeTitle('Stuff You Should Know!')).toBe('stuff you should know')
  })

  it('accepts only an exact normalized title match', async () => {
    vi.mocked(searchPodcasts).mockResolvedValue([
      { id: '1', title: 'The Daily Show', author: 'X', artworkUrl: '', feedUrl: 'https://a', genres: [] },
      { id: '2', title: 'The Daily', author: 'The New York Times', artworkUrl: '', feedUrl: 'https://b', genres: [] },
    ])
    const match = await matchShow({ name: 'The Daily', publisher: 'The New York Times' })
    expect(match.feedUrl).toBe('https://b')
  })

  it('breaks title ties by publisher, and reports no match rather than guessing', async () => {
    vi.mocked(searchPodcasts).mockResolvedValue([
      { id: '1', title: 'Rewind', author: 'Somebody Else', artworkUrl: '', feedUrl: 'https://a', genres: [] },
      { id: '2', title: 'Rewind', author: 'Real Publisher', artworkUrl: '', feedUrl: 'https://b', genres: [] },
    ])
    const tied = await matchShow({ name: 'Rewind', publisher: 'Real Publisher' })
    expect(tied.feedUrl).toBe('https://b')

    vi.mocked(searchPodcasts).mockResolvedValue([
      { id: '1', title: 'Completely Different', author: 'X', artworkUrl: '', feedUrl: 'https://a', genres: [] },
    ])
    const miss = await matchShow({ name: 'Obscure Show', publisher: 'Y' })
    expect(miss.feedUrl).toBeUndefined()
  })
})

describe('parseSpotifyExport', () => {
  it('reads saved shows out of the export zip', async () => {
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    zip.file('Spotify Account Data/YourLibrary.json', JSON.stringify({
      tracks: [{ artist: 'ignored' }],
      shows: [
        { name: 'The Daily', publisher: 'The New York Times' },
        { name: 'No Publisher Show' },
        { notAShow: true },
      ],
    }))
    const blob = await zip.generateAsync({ type: 'blob' })
    const { parseSpotifyExport } = await import('./spotify')

    const shows = await parseSpotifyExport(new File([blob], 'my_spotify_data.zip'))
    expect(shows).toEqual([
      { name: 'The Daily', publisher: 'The New York Times' },
      { name: 'No Publisher Show', publisher: '' },
    ])
  })

  it('accepts a bare YourLibrary.json, and rejects files with no shows', async () => {
    const { parseSpotifyExport } = await import('./spotify')
    const shows = await parseSpotifyExport(
      new File([JSON.stringify({ shows: [{ name: 'Solo' }] })], 'YourLibrary.json'),
    )
    expect(shows[0].name).toBe('Solo')

    await expect(
      parseSpotifyExport(new File([JSON.stringify({ tracks: [] })], 'other.json')),
    ).rejects.toThrow('no saved shows')
  })
})
