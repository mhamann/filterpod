import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  clearQueue,
  dequeueNext,
  enqueueEpisode,
  listQueue,
  moveInQueue,
  removeFromQueue,
} from './repo'

/**
 * Queue ordering, against a real Dexie rather than a mock.
 *
 * The logic worth testing here is entirely about positions — they are rewritten on every
 * mutation, and a mock that just records calls would assert nothing about whether the
 * order that comes back out is the order someone arranged.
 */

async function order(): Promise<string[]> {
  return (await listQueue()).map((item) => item.episodeId)
}

describe('the play queue', () => {
  beforeEach(async () => {
    await clearQueue()
  })

  it('keeps the order things were added in', async () => {
    await enqueueEpisode('a')
    await enqueueEpisode('b')
    await enqueueEpisode('c')

    expect(await order()).toEqual(['a', 'b', 'c'])
  })

  it('puts "play next" at the front', async () => {
    await enqueueEpisode('a')
    await enqueueEpisode('b')
    await enqueueEpisode('c', { next: true })

    expect(await order()).toEqual(['c', 'a', 'b'])
  })

  it('moves an episode rather than queueing it twice', async () => {
    await enqueueEpisode('a')
    await enqueueEpisode('b')
    await enqueueEpisode('a', { next: true })

    // The same episode twice would strand the second copy at a position already heard.
    expect(await order()).toEqual(['a', 'b'])
  })

  it('reorders by relative moves, clamped at the ends', async () => {
    await enqueueEpisode('a')
    await enqueueEpisode('b')
    await enqueueEpisode('c')

    await moveInQueue('c', -1)
    expect(await order()).toEqual(['a', 'c', 'b'])

    await moveInQueue('a', -1)
    // Already first; moving up must be a no-op rather than wrapping to the end.
    expect(await order()).toEqual(['a', 'c', 'b'])

    await moveInQueue('a', 5)
    expect(await order()).toEqual(['c', 'b', 'a'])
  })

  it('leaves positions dense after a removal, so later moves still land', async () => {
    await enqueueEpisode('a')
    await enqueueEpisode('b')
    await enqueueEpisode('c')
    await removeFromQueue('b')

    expect((await listQueue()).map((item) => item.position)).toEqual([0, 1])

    await moveInQueue('c', -1)
    expect(await order()).toEqual(['c', 'a'])
  })

  it('takes from the front and empties cleanly', async () => {
    await enqueueEpisode('a')
    await enqueueEpisode('b')

    expect(await dequeueNext()).toBe('a')
    expect(await order()).toEqual(['b'])
    expect(await dequeueNext()).toBe('b')
    expect(await dequeueNext()).toBeUndefined()
  })

  afterAll(async () => {
    db.close()
  })
})
