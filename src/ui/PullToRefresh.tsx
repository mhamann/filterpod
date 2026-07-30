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

/**
 * Upward travel that means "this is a scroll, not a pull", handing the gesture back to
 * the browser. Anything smaller is finger jitter: a real touch routinely wobbles a few
 * pixels upward before heading down, and treating the first wobble as intent is why the
 * pull only ever worked "occasionally" — a perfectly monotonic injected swipe passed
 * while real fingers failed.
 */
const HAND_BACK_PX = 10

/** How far above the top edge the indicator disc hides when idle. */
const DISC_HIDDEN_PX = 56

/**
 * The least time the disc spins after release. A conditional refresh of one unchanged
 * feed answers 304 in a couple hundred milliseconds — faster than the eye credits, so
 * the gesture felt like it did nothing. The work is not slowed; the acknowledgement is
 * held long enough to be seen.
 */
const MIN_SPIN_MS = 700

/** Disc travel per damped pull pixel; >1 so the disc clears the edge before the trigger. */
const INDICATOR_TRAVEL = 1.4

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

    if (delta < -HAND_BACK_PX && pull === 0) {
      // Decisively upward before any pull built: a scroll. The browser takes it from
      // the next unconsumed touchmove; the few pixels eaten deciding are imperceptible.
      pullFrom.current = null
      setPull(0)
      return
    }
    if (delta <= 0) {
      // Jitter, or a pull dragged back to its start: keep the gesture, show nothing.
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
    // Started before the work and awaited in finally, so success and failure alike
    // hold the spinner long enough to read.
    const minSpin = new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS))
    try {
      await onRefresh()
    } catch {
      // A feed that will not load is not worth interrupting someone's browsing for, and
      // the list they are already looking at is still perfectly good. Swallowed rather
      // than left to reject, which would surface as an unhandled rejection and nothing
      // more useful than that.
    } finally {
      await minSpin
      setRefreshing(false)
      setPull(0)
    }
  }

  const armed = pull >= TRIGGER_PX

  // Android convention: the content does not move. A floating disc descends from under
  // the top edge as the pull builds, and holds there spinning while the refresh runs.
  const discY = refreshing
    ? TRIGGER_PX * INDICATOR_TRAVEL - DISC_HIDDEN_PX
    : Math.min(pull, MAX_PULL_PX) * INDICATOR_TRAVEL - DISC_HIDDEN_PX

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => void onPointerEnd()}
      onPointerCancel={() => void onPointerEnd()}
    >
      {/* A clipping strip of its own, so the tucked-away disc never peeks over content. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-32 justify-center overflow-hidden">
        <div
          className="flex h-11 w-11 items-center justify-center self-start rounded-full bg-panel-800 shadow-lg shadow-black/50 ring-1 ring-panel-700"
          style={{
            transform: `translateY(${discY}px)`,
            transition:
              pullFrom.current === null || refreshing ? 'transform 220ms ease' : undefined,
          }}
        >
          <Icon
            name="refresh"
            size={24}
            className={clsx(
              'transition-colors',
              refreshing && 'animate-spin',
              armed || refreshing ? 'text-ember-400' : 'text-ink-500',
            )}
            // Turns with the pull, so it is obvious the gesture is doing something
            // before it has gone far enough to fire.
            style={refreshing ? undefined : { transform: `rotate(${(pull / TRIGGER_PX) * 270}deg)` }}
          />
        </div>
      </div>

      {children}
    </div>
  )
}
