import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getPlatform } from '@/platform'

/**
 * A grid whose tiles rearrange by long-press and drag.
 *
 * Long-press is what disambiguates: a tap opens the tile, a swipe scrolls (or pulls to
 * refresh), and only holding still for [LIFT_MS] lifts the tile out of the flow. Once
 * lifted, the drag owns the gesture — pointer moves stop propagating (so the
 * pull-to-refresh above never sees them) and touchmove is consumed (so the scroller
 * cannot claim the pointer, the same lesson the pull itself taught).
 *
 * Geometry is captured once at lift: every tile's rect, in slot order. During the drag
 * nothing scrolls and transforms do not affect layout, so those rects stay true, and
 * "which slot is the finger over" is a nearest-center search rather than grid math that
 * would need to know column counts.
 */

/** Hold this long, without wandering, to lift a tile. */
const LIFT_MS = 350

/** Movement during the hold that turns the gesture back into a scroll. */
const WANDER_PX = 10

export function ReorderableGrid<T>({
  items,
  idOf,
  onReorder,
  enabled = true,
  className,
  renderItem,
}: {
  items: T[]
  idOf(item: T): string
  /** Called on drop with the full id order. */
  onReorder(ids: string[]): void
  /** Off while a search filter is showing a subset — reordering a subset is ambiguous. */
  enabled?: boolean
  className?: string
  renderItem(item: T, dragging: boolean): ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const holdTimer = useRef<number | null>(null)
  const start = useRef<{ x: number; y: number; index: number } | null>(null)
  const rects = useRef<DOMRect[]>([])
  const justDragged = useRef(false)
  const [drag, setDrag] = useState<{ index: number; to: number; dx: number; dy: number } | null>(
    null,
  )

  // The browser must not claim the pointer for scrolling mid-drag.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onTouchMove = (event: TouchEvent) => {
      if (drag && event.cancelable) event.preventDefault()
    }
    element.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => element.removeEventListener('touchmove', onTouchMove)
  }, [drag])

  function clearHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  function onTileDown(event: React.PointerEvent, index: number) {
    if (!enabled || items.length < 2) return
    start.current = { x: event.clientX, y: event.clientY, index }
    clearHold()
    holdTimer.current = window.setTimeout(() => {
      const container = containerRef.current
      if (!container || !start.current) return
      rects.current = [...container.children].map((child) => child.getBoundingClientRect())
      setDrag({ index, to: index, dx: 0, dy: 0 })
      getPlatform().haptics.tick()
    }, LIFT_MS)
  }

  function onTileMove(event: React.PointerEvent) {
    const s = start.current
    if (!s) return

    if (!drag) {
      // Still deciding: wandering before the hold completes means this is a scroll.
      if (Math.hypot(event.clientX - s.x, event.clientY - s.y) > WANDER_PX) {
        clearHold()
        start.current = null
      }
      return
    }

    event.stopPropagation()
    const dx = event.clientX - s.x
    const dy = event.clientY - s.y

    // The slot whose center is nearest the finger is where this tile would land.
    const cx = event.clientX
    const cy = event.clientY
    let nearest = drag.to
    let best = Infinity
    rects.current.forEach((rect, slot) => {
      const d = Math.hypot(rect.x + rect.width / 2 - cx, rect.y + rect.height / 2 - cy)
      if (d < best) {
        best = d
        nearest = slot
      }
    })

    if (nearest !== drag.to) getPlatform().haptics.tick()
    setDrag({ ...drag, dx, dy, to: nearest })
  }

  function onTileUp() {
    clearHold()
    const s = start.current
    start.current = null
    if (!drag || !s) return

    if (drag.to !== drag.index) {
      const order = items.map(idOf)
      const [moved] = order.splice(drag.index, 1)
      order.splice(drag.to, 0, moved)
      onReorder(order)
    }
    justDragged.current = true
    setDrag(null)
  }

  /** Where tile `slot` sits while the drag is in flight. */
  function transformFor(slot: number): string | undefined {
    if (!drag || rects.current.length === 0) return undefined
    if (slot === drag.index) return `translate(${drag.dx}px, ${drag.dy}px) scale(1.05)`

    // Everyone between the origin and the target shifts one slot toward the origin.
    let target = slot
    if (drag.index < drag.to && slot > drag.index && slot <= drag.to) target = slot - 1
    else if (drag.index > drag.to && slot >= drag.to && slot < drag.index) target = slot + 1
    if (target === slot) return undefined

    const from = rects.current[slot]
    const to = rects.current[target]
    return `translate(${to.x - from.x}px, ${to.y - from.y}px)`
  }

  return (
    <div
      ref={containerRef}
      className={className}
      onClickCapture={(event) => {
        // The release of a drag lands on a tile that is usually a link; one drag must
        // not also be one navigation.
        if (justDragged.current) {
          event.preventDefault()
          event.stopPropagation()
          justDragged.current = false
        }
      }}
    >
      {items.map((item, index) => (
        <div
          key={idOf(item)}
          className={drag?.index === index ? 'relative z-10' : undefined}
          style={{
            transform: transformFor(index),
            transition: drag?.index === index ? 'none' : 'transform 160ms ease',
            touchAction: drag ? 'none' : undefined,
          }}
          onPointerDown={(event) => onTileDown(event, index)}
          onPointerMove={onTileMove}
          onPointerUp={onTileUp}
          onPointerCancel={() => {
            clearHold()
            start.current = null
            setDrag(null)
          }}
          onContextMenu={(event) => {
            // A long-press on Android also raises a context menu; the lift owns it.
            if (enabled && items.length >= 2) event.preventDefault()
          }}
        >
          {renderItem(item, drag?.index === index)}
        </div>
      ))}
    </div>
  )
}
