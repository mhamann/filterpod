import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/data/db'
import { Icon } from './Icon'

/**
 * Shortcut to the queue, with however many episodes are in it.
 *
 * Appears in the same top-right position on the Library and in the player, because those
 * are the two places you are when you decide what to line up next, and a control that
 * moves depending on the screen has to be found again each time.
 */
export function QueueButton({ onClick }: { onClick(): void }) {
  const count = useLiveQuery(() => db.queue.count(), [], 0)

  return (
    <button
      onClick={onClick}
      aria-label={count > 0 ? `Queue, ${count} episodes` : 'Queue'}
      className="focus-ring relative rounded-full p-2 text-ink-400"
    >
      <Icon name="queue" size={20} />
      {count > 0 && (
        <span className="tabular absolute top-0 right-0 min-w-[15px] rounded-full bg-ember-500 px-1 text-[9px] leading-[15px] font-semibold text-panel-950">
          {count}
        </span>
      )}
    </button>
  )
}
