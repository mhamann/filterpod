import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/data/db'
import { clearQueue, moveInQueue, removeFromQueue } from '@/data/repo'
import { usePlayerStore } from '@/features/player/playerStore'
import { duration } from './format'
import { Icon } from './Icon'

/**
 * The play queue, in order, with the controls to rearrange it.
 *
 * Reordering is done with explicit up/down controls rather than by dragging. This list
 * lives inside the Now Playing panel, which already interprets a drag as dismiss and
 * contains a timeline that scrubs on pointer movement — a third gesture competing in the
 * same space would be a coin toss as to which one the browser awarded the pointer to.
 * Buttons cost a tap but never do the wrong thing, and they work for anyone driving the
 * app by assistive technology.
 */
export function UpNext() {
  const items = useLiveQuery(async () => {
    const queued = await db.queue.orderBy('position').toArray()
    const episodes = await db.episodes.bulkGet(queued.map((item) => item.episodeId))
    return queued
      .map((item, index) => ({ item, episode: episodes[index] }))
      // An episode can be removed from the library while queued; skip rather than
      // rendering a row with nothing in it.
      .filter((entry): entry is { item: typeof queued[number]; episode: NonNullable<typeof episodes[number]> } =>
        Boolean(entry.episode),
      )
  }, [])

  const open = usePlayerStore((state) => state.open)

  if (!items || items.length === 0) return null

  return (
    <section className="mt-10">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="silkscreen">Up next · {items.length}</h2>
        <button
          onClick={() => void clearQueue()}
          className="focus-ring rounded-full px-2 py-1 text-[11px] text-ink-600"
        >
          Clear
        </button>
      </div>

      <ol className="overflow-hidden rounded-xl ring-1 ring-panel-800">
        {items.map(({ item, episode }, index) => (
          <li
            key={item.episodeId}
            className="flex items-center gap-2 border-b border-panel-800 bg-panel-900/60 px-3 py-2.5 last:border-b-0"
          >
            <span className="tabular w-4 shrink-0 text-[11px] text-ink-600">{index + 1}</span>

            <button
              onClick={() => void open(episode.id)}
              className="focus-ring min-w-0 flex-1 text-left"
            >
              <p className="truncate text-[13px] text-ink-100">{episode.title}</p>
              <p className="tabular text-[11px] text-ink-600">{duration(episode.durationSec)}</p>
            </button>

            <div className="flex shrink-0 items-center">
              <button
                onClick={() => void moveInQueue(item.episodeId, -1)}
                disabled={index === 0}
                aria-label={`Move ${episode.title} up`}
                className="focus-ring rounded-full p-1.5 text-ink-500 disabled:opacity-25"
              >
                <Icon name="chevronDown" size={16} className="rotate-180" />
              </button>
              <button
                onClick={() => void moveInQueue(item.episodeId, 1)}
                disabled={index === items.length - 1}
                aria-label={`Move ${episode.title} down`}
                className="focus-ring rounded-full p-1.5 text-ink-500 disabled:opacity-25"
              >
                <Icon name="chevronDown" size={16} />
              </button>
              <button
                onClick={() => void removeFromQueue(item.episodeId)}
                aria-label={`Remove ${episode.title} from the queue`}
                className="focus-ring rounded-full p-1.5 text-ink-500"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
