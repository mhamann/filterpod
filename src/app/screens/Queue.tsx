import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/data/db'
import { clearQueue } from '@/data/repo'
import { QueueList } from '@/ui/QueueList'
import { Icon } from '@/ui/Icon'
import { Header } from './Library'

/**
 * The queue's own screen.
 *
 * It first lived only at the bottom of the Now Playing panel, which meant opening the
 * player and scrolling past the artwork, the timeline and the transport controls to find
 * it — reasonable as a glance at what is coming, useless as the place you go to arrange
 * anything. A queue you have to hunt for is one nobody builds.
 */
export function Queue() {
  const count = useLiveQuery(() => db.queue.count(), [], 0)

  return (
    <div className="animate-rise pb-6">
      <Header
        title="Queue"
        action={
          count > 0 ? (
            <button
              onClick={() => void clearQueue()}
              className="focus-ring rounded-full px-2 py-1 text-[12px] text-ink-500"
            >
              Clear all
            </button>
          ) : undefined
        }
      />

      {count === 0 ? (
        <div className="px-6 py-16 text-center">
          <Icon name="queue" size={26} className="mx-auto mb-3 text-panel-600" />
          <p className="text-[14px] text-ink-300">Nothing queued yet.</p>
          <p className="mx-auto mt-1.5 max-w-[260px] text-[12px] leading-relaxed text-ink-600">
            Use the queue button on any episode to line it up. Whatever is playing sits at
            the top, and the rest follow it in order.
          </p>
        </div>
      ) : (
        <div className="px-4 pt-2">
          <QueueList />
        </div>
      )}
    </div>
  )
}
