import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { healEncodedTitles } from './repo'

/**
 * The heal pass exists because refresh cannot fix these rows: a 304-answering feed is
 * never re-parsed, so a title stored as "The King&#39;s Chapel" stays that way forever
 * without it. Tested against real Dexie for the same reason the queue is.
 */

describe('healEncodedTitles', () => {
  beforeEach(async () => {
    await db.podcasts.clear()
    await db.episodes.clear()
  })

  it('decodes entity-encoded rows and leaves clean ones alone', async () => {
    await db.podcasts.bulkAdd([
      {
        id: 'p1',
        feedUrl: 'https://a.example/feed',
        title: 'The King&#39;s Chapel',
        author: 'Tom &amp; Jerry',
        description: 'Q&amp;A every week',
        artworkUrl: '',
        categories: [],
        explicit: false,
      },
      {
        id: 'p2',
        feedUrl: 'https://b.example/feed',
        title: 'Already Clean & Fine',
        author: 'Someone',
        description: 'Nothing to do here',
        artworkUrl: '',
        categories: [],
        explicit: false,
      },
    ])
    await db.episodes.add({
      id: 'e1',
      podcastId: 'p1',
      guid: 'g1',
      title: 'It&#8217;s a Start',
      description: 'notes',
      audioUrl: 'https://a.example/1.mp3',
      publishedAt: 0,
      explicit: false,
      transcripts: [],
    })

    expect(await healEncodedTitles()).toBe(2)

    const podcast = await db.podcasts.get('p1')
    expect(podcast?.title).toBe("The King's Chapel")
    expect(podcast?.author).toBe('Tom & Jerry')
    expect(podcast?.description).toBe('Q&A every week')
    expect((await db.episodes.get('e1'))?.title).toBe('It’s a Start')
    // The clean row must come through byte-identical — healing is not rewriting.
    expect((await db.podcasts.get('p2'))?.title).toBe('Already Clean & Fine')
  })

  it('is a no-op on the second pass', async () => {
    await db.podcasts.add({
      id: 'p1',
      feedUrl: 'https://a.example/feed',
      title: 'A &quot;Quoted&quot; Show',
      author: '',
      description: '',
      artworkUrl: '',
      categories: [],
      explicit: false,
    })

    expect(await healEncodedTitles()).toBe(1)
    expect(await healEncodedTitles()).toBe(0)
  })
})
