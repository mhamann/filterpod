import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { usePlayerStore } from '@/features/player/playerStore'
import { analyzedUntil, toFilteredPosition } from '@/core/filterMath'
import { db } from '@/data/db'
import { DEFAULT_SETTINGS } from '@/data/defaults'
import { CutTimeline } from '@/ui/CutTimeline'
import { Artwork, Pill } from '@/ui/components'
import { Icon } from '@/ui/Icon'
import { SkipIcon } from '@/ui/SkipIcon'
import { timecode } from '@/ui/format'

const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2]

/**
 * How far the panel must be dragged down before letting go dismisses it.
 *
 * Below this it springs back. Small enough that a deliberate flick works without much
 * travel, large enough that it is not triggered by the slack in a tap.
 */
const DISMISS_PX = 110

/** Upward travel on the mini player that counts as "open the player". */
const EXPAND_PX = 32

/**
 * Full-screen player. The console metaphor is most literal here.
 *
 * Mounted whenever there is an episode and moved in and out of view by transform, rather
 * than mounted and unmounted with the open state. That is what gives it a real exit
 * animation instead of vanishing, and it means the drag-to-dismiss gesture is writing to
 * the same property the open/close transition animates — the panel simply follows your
 * finger and then continues on its own.
 */
export function NowPlaying({ open, onClose }: { open: boolean; onClose(): void }) {
  const {
    episode,
    podcast,
    spans,
    analyzedRanges,
    state,
    positionSec,
    durationSec,
    rate,
    preparing,
    modelProgress,
    catchingUp,
    toggle,
    seek,
    skipForward,
    skipBack,
    setRate,
  } = usePlayerStore()
  const [showRates, setShowRates] = useState(false)

  const settings = useLiveQuery(() => db.settings.get('singleton'), [])
  const skipBackSec = settings?.skipBackSec ?? DEFAULT_SETTINGS.skipBackSec
  const skipForwardSec = settings?.skipForwardSec ?? DEFAULT_SETTINGS.skipForwardSec

  const scrollRef = useRef<HTMLDivElement>(null)
  const dragFrom = useRef<number | null>(null)
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)

  // Any drag left over from last time would otherwise be applied the moment it reopens.
  useEffect(() => {
    if (open) {
      dragFrom.current = null
      setDragY(0)
      setDragging(false)
    }
  }, [open])

  /**
   * Starts a dismiss drag, unless the gesture belongs to something else.
   *
   * Two things can legitimately claim a downward drag here: the scrolled content, and
   * the timeline, which tracks the pointer to scrub. Neither should also be dragging the
   * whole panel about, so the scroll position gates the first and `data-no-drag` the
   * second.
   */
  function onPointerDown(event: React.PointerEvent) {
    if (!open) return
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    if ((scrollRef.current?.scrollTop ?? 0) > 0) return
    dragFrom.current = event.clientY
  }

  function onPointerMove(event: React.PointerEvent) {
    if (dragFrom.current === null) return
    // Downward only: dragging up should do nothing rather than lift the panel off-screen.
    const delta = Math.max(0, event.clientY - dragFrom.current)
    if (delta > 0 && !dragging) setDragging(true)
    setDragY(delta)
  }

  function onPointerEnd() {
    if (dragFrom.current === null) return
    dragFrom.current = null
    setDragging(false)
    if (dragY > DISMISS_PX) onClose()
    setDragY(0)
  }

  if (!episode) return null

  const remaining = Math.max(0, durationSec - positionSec)
  const filteredElapsed = toFilteredPosition(spans, positionSec)
  const cutsPassed = spans.filter((span) => span.endSec <= positionSec).length
  const totalCutSec = spans.reduce((sum, span) => sum + (span.endSec - span.startSec), 0)
  const frontier = analyzedUntil(analyzedRanges, positionSec)
  const fullyAnalyzed = durationSec > 0 && frontier >= durationSec - 2

  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 flex flex-col bg-panel-950 will-change-transform',
        // No transition while a finger is on it: the panel should track the drag exactly,
        // and easing toward the pointer reads as lag.
        dragging ? 'transition-none' : 'transition-transform duration-[380ms] ease-snap',
        !open && 'pointer-events-none',
      )}
      style={{ transform: open ? `translateY(${dragY}px)` : 'translateY(100%)' }}
      aria-hidden={!open}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {/*
        touch-action none over the header and handle so a drag started here is always
        ours. Elsewhere the gesture competes with the scrolling content below, which the
        browser may claim mid-drag; at the top of a scrolled-to-top panel that works out,
        but this strip is the part people actually reach for and it should never miss.
      */}
      <div style={{ touchAction: 'none' }}>
        <div className="rack-texture safe-top flex items-center justify-between border-b border-panel-800 px-4 py-3">
          <button onClick={onClose} className="focus-ring rounded-full p-2 text-ink-300">
            <Icon name="chevronDown" size={22} />
          </button>
          <span className="silkscreen">Now playing</span>
          <div className="w-9" />
        </div>

        {/* The grab affordance: says the panel can be pulled down before anyone tries. */}
        <div className="flex justify-center pt-2">
          <span className="h-1 w-9 rounded-full bg-panel-700" />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex flex-1 flex-col overflow-y-auto overscroll-contain px-6 pb-8"
      >
        <div className="mx-auto mt-6 w-full max-w-[300px]">
          <Artwork
            src={episode.artworkUrl ?? podcast?.artworkUrl}
            alt={episode.title}
            className="aspect-square w-full shadow-2xl shadow-black/60"
          />
        </div>

        <div className="mt-7 text-center">
          <p className="silkscreen mb-2">{podcast?.title}</p>
          <h1 className="text-balance text-xl leading-tight">{episode.title}</h1>
        </div>

        {/* The cut readout — the app's core claim, stated plainly. */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {modelProgress !== null ? (
            // First run only: a ~150MB download that would otherwise look like a hang.
            <Pill tone="ember" pulse icon="download">
              Getting speech model… {Math.round(modelProgress * 100)}%
            </Pill>
          ) : preparing ? (
            // Deliberately vague about how much: the lead-in is a latency budget that
            // has already been retuned once, and copy naming a duration goes stale
            // silently — this said "the first minute" when it had become fifteen seconds.
            <Pill tone="ember" pulse icon="shield">
              Checking ahead…
            </Pill>
          ) : spans.length === 0 ? (
            <Pill tone="sage" icon="check">
              {fullyAnalyzed ? 'Nothing to cut' : 'Nothing so far'}
            </Pill>
          ) : (
            <>
              <Pill tone="ember" icon="scissors">
                {cutsPassed}/{spans.length} cuts
              </Pill>
              <Pill tone="neutral">−{timecode(totalCutSec)} total</Pill>
            </>
          )}
        </div>

        {catchingUp && (
          <p className="animate-pulse-ember mt-3 text-center text-[12px] text-ember-300">
            Paused while the next stretch is checked.
          </p>
        )}

        <div className="mt-6">
          <CutTimeline
            positionSec={positionSec}
            durationSec={durationSec}
            spans={spans}
            analyzedUntilSec={frontier}
            onSeek={seek}
          />
          <div className="flex items-center justify-between px-0.5">
            <span className="tabular text-xs text-ink-300">{timecode(positionSec)}</span>
            <span className="tabular text-xs text-ink-600">
              {/* Filtered elapsed differs from raw position once cuts are behind you. */}
              {filteredElapsed < positionSec - 1 && `${timecode(filteredElapsed)} heard · `}
              −{timecode(remaining)}
            </span>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-center gap-6">
          <button onClick={skipBack} className="focus-ring rounded-full p-3 text-ink-300">
            <SkipIcon direction="back" seconds={skipBackSec} size={30} />
          </button>

          <button
            onClick={toggle}
            className="glow-ember focus-ring flex h-[72px] w-[72px] items-center justify-center rounded-full bg-ember-500 text-panel-950 transition active:scale-95"
            aria-label={state === 'playing' ? 'Pause' : 'Play'}
          >
            <Icon name={state === 'playing' ? 'pause' : 'play'} size={34} />
          </button>

          <button onClick={skipForward} className="focus-ring rounded-full p-3 text-ink-300">
            <SkipIcon direction="forward" seconds={skipForwardSec} size={30} />
          </button>
        </div>

        <div className="mt-8 flex items-center justify-center">
          <button
            onClick={() => setShowRates((open) => !open)}
            className="focus-ring tabular rounded-full bg-panel-850 px-4 py-2 text-sm text-ink-300 ring-1 ring-panel-700"
          >
            {rate.toFixed(2).replace(/0$/, '')}×
          </button>
        </div>

        {showRates && (
          <div className="animate-rise mt-3 flex flex-wrap justify-center gap-2">
            {RATES.map((option) => (
              <button
                key={option}
                onClick={() => {
                  void setRate(option)
                  setShowRates(false)
                }}
                className={clsx(
                  'tabular focus-ring rounded-full px-3 py-1.5 text-xs ring-1 transition',
                  option === rate
                    ? 'bg-ember-500 text-panel-950 ring-ember-500'
                    : 'bg-panel-850 text-ink-300 ring-panel-700',
                )}
              >
                {option}×
              </button>
            ))}
          </div>
        )}

        {state === 'error' && (
          <p className="mt-6 text-center text-sm text-alarm-400">
            Playback failed. Try re-downloading this episode.
          </p>
        )}
      </div>
    </div>
  )
}

/** Docked bar above the tab rail. Tapping it — or swiping up on it — opens the full player. */
export function MiniPlayer({ onExpand }: { onExpand(): void }) {
  const { episode, podcast, spans, state, positionSec, durationSec, toggle } = usePlayerStore()
  const swipeFrom = useRef<{ x: number; y: number } | null>(null)

  function onPointerDown(event: React.PointerEvent) {
    swipeFrom.current = { x: event.clientX, y: event.clientY }
  }

  /**
   * Opens on an upward flick.
   *
   * Decided on release rather than as it moves, so it never competes with the play/pause
   * button underneath: a tap registers as a tap, and only travel opens the panel. The
   * horizontal check keeps a sloppy sideways swipe from counting.
   */
  function onPointerUp(event: React.PointerEvent) {
    const from = swipeFrom.current
    swipeFrom.current = null
    if (!from) return
    const up = from.y - event.clientY
    if (up > EXPAND_PX && up > Math.abs(event.clientX - from.x)) onExpand()
  }

  if (!episode) return null

  return (
    <div
      className="border-t border-panel-800 bg-panel-900/95 backdrop-blur"
      // Vertical gestures belong to this bar, not to any scroll container around it.
      style={{ touchAction: 'pan-x' }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {/* Mirrors the handle on the expanded panel, hinting the same gesture upward. */}
      <div className="flex justify-center pt-1.5">
        <span className="h-1 w-9 rounded-full bg-panel-700" />
      </div>
      <CutTimeline
        positionSec={positionSec}
        durationSec={durationSec}
        spans={spans}
        onSeek={() => {}}
        compact
      />
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button onClick={onExpand} className="focus-ring flex min-w-0 flex-1 items-center gap-3">
          <Artwork
            src={episode.artworkUrl ?? podcast?.artworkUrl}
            alt=""
            className="h-11 w-11"
          />
          <div className="min-w-0 text-left">
            <p className="truncate text-[13px] font-medium text-ink-100">{episode.title}</p>
            <p className="truncate text-[11px] text-ink-600">{podcast?.title}</p>
          </div>
        </button>
        <button
          onClick={toggle}
          aria-label={state === 'playing' ? 'Pause' : 'Play'}
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panel-800 text-ink-100 ring-1 ring-panel-700 active:scale-95"
        >
          <Icon name={state === 'playing' ? 'pause' : 'play'} size={20} />
        </button>
      </div>
    </div>
  )
}
