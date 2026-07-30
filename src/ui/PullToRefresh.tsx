import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Icon } from './Icon'

/**
 * Pull down at the top of a list to refresh it.
 *
 * Replaces a refresh button. The gesture is the one people already try, and it costs no
 * space in a header that has better uses.
 *
 * The pull is tracked in JS rather than handed to the browser's own overscroll
 * behaviour: Android WebView does not provide a pull-to-refresh, and the scroll container
 * this lives in already sets `overscroll-contain`, so there is nothing to hook into.
 */

/** Pull distance, after damping, that arms the refresh. */
const TRIGGER_PX = 64

/** Furthest the content will follow a pull, however hard it is dragged. */
const MAX_PULL_PX = 96

/**
 * Fraction of finger travel the content actually moves.
 *
 * The resistance is the feedback: it makes the end of the pull feel like an end rather
 * than a scroll that stopped working.
 */
const DAMPING = 0.5

export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh(): Promise<void>
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pullFrom = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  /** The scrolling ancestor, which owns the scroll position this gesture depends on. */
  const scroller = () => rootRef.current?.closest('main') ?? null

  /*
   * The part pointer events cannot do alone: keep the WebView from claiming the drag.
   *
   * On a touch screen the browser takes over a vertical drag for scrolling after ~10px
   * and sends pointercancel — measured on-device: one pointermove, then cancel — so the
   * pull never accumulates. A mouse has no native scrolling, which is how the gesture
   * can pass in browser dev while doing nothing on the phone. Declarative touch-action
   * was tried first and pan-up was not honoured; what works is consuming touchmove
   * while a pull is live. Direction is safe to trust here because the pointermove for
   * the same motion fires first: an upward drag clears pullFrom before this runs, so
   * scrolling from the top stays native.
   *
   * A native listener because it must be passive: false, which React does not
   * guarantee for its synthetic handlers.
   */
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const onTouchMove = (event: TouchEvent) => {
      if (pullFrom.current !== null && event.cancelable) event.preventDefault()
    }
    element.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => element.removeEventListener('touchmove', onTouchMove)
  }, [])

  function onPointerDown(event: React.PointerEvent) {
    if (refreshing) return
    // Only from the very top: anywhere else, a downward drag is a scroll.
    if ((scroller()?.scrollTop ?? 0) > 0) return
    pullFrom.current = event.clientY
  }

  function onPointerMove(event: React.PointerEvent) {
    if (pullFrom.current === null) return
    const delta = event.clientY - pullFrom.current
    if (delta <= 0) {
      // Dragging back up hands the gesture to the scroller rather than fighting it.
      pullFrom.current = null
      setPull(0)
      return
    }
    setPull(Math.min(MAX_PULL_PX, delta * DAMPING))
  }

  async function onPointerEnd() {
    if (pullFrom.current === null) return
    pullFrom.current = null

    if (pull < TRIGGER_PX) {
      setPull(0)
      return
    }

    // Held at the trigger point while the work runs, so the spinner has somewhere to be.
    setRefreshing(true)
    setPull(TRIGGER_PX)
    try {
      await onRefresh()
    } catch {
      // A feed that will not load is not worth interrupting someone's browsing for, and
      // the list they are already looking at is still perfectly good. Swallowed rather
      // than left to reject, which would surface as an unhandled rejection and nothing
      // more useful than that.
    } finally {
      setRefreshing(false)
      setPull(0)
    }
  }

  const armed = pull >= TRIGGER_PX

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => void onPointerEnd()}
      onPointerCancel={() => void onPointerEnd()}
    >
      <div
        className="pointer-events-none flex items-end justify-center overflow-hidden"
        style={{ height: pull, transition: pullFrom.current === null ? 'height 240ms' : undefined }}
      >
        <Icon
          name="refresh"
          size={18}
          className={clsx(
            'mb-2 transition-colors',
            refreshing && 'animate-spin',
            armed ? 'text-ember-400' : 'text-ink-600',
          )}
          // Turns with the pull, so it is obvious the gesture is doing something before
          // it has gone far enough to fire.
          style={refreshing ? undefined : { transform: `rotate(${(pull / TRIGGER_PX) * 270}deg)` }}
        />
      </div>

      {children}
    </div>
  )
}
