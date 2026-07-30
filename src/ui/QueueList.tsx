import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { db } from '@/data/db'
import { moveInQueue, removeFromQueue } from '@/data/repo'
import { getPlatform } from '@/platform'
import { usePlayerStore } from '@/features/player/playerStore'
import { duration } from './format'
import { Icon } from './Icon'

/**
 * The queue, in play order, rearranged by direct manipulation.
 *
 * Position 0 is whatever is playing rather than what plays next, so the list is a single
 * account of what is happening instead of one that has to be read alongside a separate
 * "and this is playing" somewhere else. That row is marked and cannot be dragged: while
 * it is playing it is first by definition, and letting it be dragged down would only
 * create a state the next press of play immediately undoes.
 *
 * Reordering is a drag on the grip — the grip specifically, because a whole-row drag
 * would fight both scrolling and the swipe. Removal is a horizontal swipe past
 * [REMOVE_FRACTION] of the row's width; anything short of that springs back, so a
 * grazed row is never an episode silently gone.
 */

/** How far across the row a swipe must travel before release removes it. */
const REMOVE_FRACTION = 0.45

/** Movement before a touch is committed as a swipe rather than a tap or scroll. */
const INTENT_PX = 14

interface DragState {
  id: string
  from: number
  to: number
  dy: number
  rowH: number
}

interface SwipeState {
  id: string
  dx: number
  /** True while the finger is down — transforms track it with no transition. */
  active: boolean
  /** Set once release commits the removal; the row slides out and then goes. */
  leaving?: boolean
}

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

  const [drag, setDrag] = useState<DragState | null>(null)
  const [swipe, setSwipe] = useState<SwipeState | null>(null)
  const dragStartY = useRef(0)
  const gesture = useRef<{
    id: string
    startX: number
    startY: number
    mode: 'idle' | 'swipe' | 'scroll'
    /** Whether the swipe is currently past the point where release removes. */
    armed?: boolean
  } | null>(null)
  // A swipe releases directly over the row's own tap target; this keeps that release
  // from also counting as "open the episode".
  const suppressTap = useRef(false)

  if (!items || items.length === 0) return null

  // The playing episode holds the first slot, so the row below it is as far up as
  // anything else can go.
  const firstMovable = items[0].episode.id === currentId ? 1 : 0

  function onGripDown(event: React.PointerEvent, id: string, index: number, rowH: number) {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStartY.current = event.clientY
    setDrag({ id, from: index, to: index, dy: 0, rowH })
  }

  function onGripMove(event: React.PointerEvent) {
    setDrag((current) => {
      if (!current) return current
      const dy = event.clientY - dragStartY.current
      const to = Math.min(
        (items?.length ?? 1) - 1,
        Math.max(firstMovable, current.from + Math.round(dy / current.rowH)),
      )
      // The detent: each slot the row snaps into is felt, not just seen.
      if (to !== current.to) getPlatform().haptics.tick()
      return { ...current, dy, to }
    })
  }

  function onGripUp() {
    if (drag && drag.to !== drag.from) void moveInQueue(drag.id, drag.to - drag.from)
    setDrag(null)
  }

  function onRowDown(event: React.PointerEvent, id: string) {
    if (drag) return
    gesture.current = { id, startX: event.clientX, startY: event.clientY, mode: 'idle' }
    suppressTap.current = false
  }

  function onRowMove(event: React.PointerEvent, id: string) {
    const g = gesture.current
    if (!g || g.id !== id || g.mode === 'scroll') return
    const dx = event.clientX - g.startX
    const dy = event.clientY - g.startY

    if (g.mode === 'idle') {
      // Decide once what this gesture is; a vertical drift is the list scrolling.
      if (Math.abs(dx) > INTENT_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
        g.mode = 'swipe'
        suppressTap.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
      } else if (Math.abs(dy) > INTENT_PX) {
        g.mode = 'scroll'
        return
      } else {
        return
      }
    }

    // Tick when the swipe arms (and again if it backs off), so the finger knows the
    // moment release stops being harmless — the "little force" made legible.
    const width = (event.currentTarget as HTMLElement).offsetWidth
    const armed = Math.abs(dx) >= width * REMOVE_FRACTION
    if (armed !== Boolean(g.armed)) {
      g.armed = armed
      getPlatform().haptics.tick()
    }

    setSwipe({ id, dx, active: true })
  }

  function onRowUp(event: React.PointerEvent, id: string) {
    const g = gesture.current
    gesture.current = null
    if (!g || g.mode !== 'swipe') return

    const width = (event.currentTarget as HTMLElement).offsetWidth
    const dx = event.clientX - g.startX
    if (Math.abs(dx) >= width * REMOVE_FRACTION) {
      setSwipe({ id, dx: Math.sign(dx) * width, active: false, leaving: true })
      window.setTimeout(() => {
        void removeFromQueue(id)
        setSwipe(null)
      }, 170)
    } else {
      setSwipe({ id, dx: 0, active: false })
      window.setTimeout(() => setSwipe(null), 170)
    }
  }

  /** Where a bystander row sits while another row is being dragged past it. */
  function shiftFor(index: number): number {
    if (!drag) return 0
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.rowH
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return drag.rowH
    return 0
  }

  return (
    <ol className="overflow-hidden rounded-xl ring-1 ring-panel-800">
      {items.map(({ item, episode }, index) => {
        const isCurrent = episode.id === currentId
        const isDragging = drag?.id === item.episodeId
        const isSwiping = swipe?.id === item.episodeId

        return (
          <li
            key={item.episodeId}
            className={clsx(
              'relative border-b border-panel-800 last:border-b-0',
              isDragging && 'z-10',
            )}
            style={{
              transform: isDragging
                ? `translateY(${drag.dy}px)`
                : shiftFor(index)
                  ? `translateY(${shiftFor(index)}px)`
                  : undefined,
              transition: isDragging ? 'none' : 'transform 150ms ease',
              // Horizontal gestures belong to the swipe; vertical ones stay the list's.
              touchAction: 'pan-y',
            }}
            onPointerDown={(event) => onRowDown(event, item.episodeId)}
            onPointerMove={(event) => onRowMove(event, item.episodeId)}
            onPointerUp={(event) => onRowUp(event, item.episodeId)}
            onPointerCancel={() => {
              gesture.current = null
              setSwipe(null)
            }}
            onClickCapture={(event) => {
              if (suppressTap.current) {
                event.preventDefault()
                event.stopPropagation()
                suppressTap.current = false
              }
            }}
          >
            {isSwiping && (
              <div
                className={clsx(
                  'absolute inset-0 flex items-center bg-alarm-500/15 px-4 text-alarm-400',
                  swipe.dx < 0 ? 'justify-end' : 'justify-start',
                )}
              >
                <Icon name="trash" size={16} />
              </div>
            )}

            <div
              className={clsx(
                'relative flex items-center gap-2 px-3 py-2.5',
                isCurrent ? 'bg-ember-500/[0.06]' : 'bg-panel-900/60',
                isSwiping && 'bg-panel-900',
              )}
              style={{
                transform: isSwiping ? `translateX(${swipe.dx}px)` : undefined,
                transition: isSwiping && swipe.active ? 'none' : 'transform 160ms ease',
              }}
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

              {!isCurrent && (
                <span
                  aria-label={`Drag to move ${episode.title}`}
                  className="shrink-0 cursor-grab touch-none rounded-full p-2 text-ink-600 active:cursor-grabbing"
                  onPointerDown={(event) => {
                    // The grip's drag must not also start a row swipe.
                    event.stopPropagation()
                    const row = event.currentTarget.closest('li') as HTMLElement
                    onGripDown(event, item.episodeId, index, row.offsetHeight)
                  }}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  <Icon name="grip" size={16} />
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
