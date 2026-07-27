import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { db } from '@/data/db'
import { moveInQueue, removeFromQueue } from '@/data/repo'
import { usePlayerStore } from '@/features/player/playerStore'
import { duration } from './format'
import { Icon } from './Icon'

/**
 * The queue, in play order, with the controls to rearrange it.
 *
 * Position 0 is whatever is playing rather than what plays next, so the list is a single
 * account of what is happening instead of one that has to be read alongside a separate
 * "and this is playing" somewhere else. That row is marked and cannot be moved: while it
 * is playing it is first by definition, and letting it be dragged down would only create
 * a state the next press of play immediately undoes.
 *
 * Reordering uses explicit up/down controls rather than dragging, which costs a tap but
 * never does the wrong thing and works for anyone driving the app by assistive technology.
 */
export function QueueList() {
  const items = useLiveQuery(async () => {
    const queued = await db.queue.orderBy('position').toArray()
    const episodes = await db.episodes.bulkGet(queued.map((item) => item.episodeId))
    return queued
      .map((item, index) => ({ item, episode: episodes[index] }))
      // An episode can be removed from the library while queued; skip rather than
      // rendering a row with nothing in it.
      .filter(
        (entry): entry is { item: (typeof queued)[number]; episode: NonNullable<(typeof episodes)[number]> } =>
          Boolean(entry.episode),
      )
  }, [])

  const open = usePlayerStore((state) => state.open)
  const currentId = usePlayerStore((state) => state.episode?.id)

  if (!items || items.length === 0) return null

  // The playing episode holds the first slot, so the row below it is as far up as
  // anything else can go.
  const firstMovable = items[0].episode.id === currentId ? 1 : 0

  return (
    <ol className="overflow-hidden rounded-xl ring-1 ring-panel-800">
      {items.map(({ item, episode }, index) => {
        const isCurrent = episode.id === currentId

        return (
          <li
            key={item.episodeId}
            className={clsx(
              'flex items-center gap-2 border-b border-panel-800 px-3 py-2.5 last:border-b-0',
              isCurrent ? 'bg-ember-500/[0.06]' : 'bg-panel-900/60',
            )}
          >
            <span className="flex w-4 shrink-0 justify-center">
              {isCurrent ? (
                <Icon name="play" size={11} className="text-ember-400" />
              ) : (
                <span className="tabular text-[11px] text-ink-600">{index + 1}</span>
              )}
            </span>

            <button
              onClick={() => void open(episode.id)}
              className="focus-ring min-w-0 flex-1 text-left"
            >
              <p className={clsx('truncate text-[13px]', isCurrent ? 'text-ember-300' : 'text-ink-100')}>
                {episode.title}
              </p>
              <p className="tabular text-[11px] text-ink-600">
                {isCurrent ? 'Playing' : duration(episode.durationSec)}
              </p>
            </button>

            <div className="flex shrink-0 items-center">
              {!isCurrent && (
                <>
                  <button
                    onClick={() => void moveInQueue(item.episodeId, -1)}
                    disabled={index === firstMovable}
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
                </>
              )}
              <button
                onClick={() => void removeFromQueue(item.episodeId)}
                aria-label={`Remove ${episode.title} from the queue`}
                className="focus-ring rounded-full p-1.5 text-ink-500"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
