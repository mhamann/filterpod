import { useCallback, useMemo, useRef } from 'react'
import type { FilterSpan } from '@/core/types'

/**
 * The app's signature control: a scrub bar that shows where audio was cut.
 *
 * Every filtered span renders as an ember notch on the track, so the removals are
 * visible rather than invisible — you can see at a glance that an episode had three
 * cuts in the first ten minutes, and scrub to just after one. It doubles as the
 * app's honesty about what it is doing to the audio.
 */

interface CutTimelineProps {
  positionSec: number
  durationSec: number
  spans: FilterSpan[]
  onSeek(positionSec: number): void
  /**
   * How far filtering has checked, in seconds. Rendered as a subtle sage shading so it
   * is visible that the app is working ahead of you — and where it will stop if you
   * scrub past it.
   */
  analyzedUntilSec?: number
  /** Chapter starts, rendered as faint ticks so the structure is visible at a glance. */
  chapterMarks?: number[]
  /** Compact form for the mini player: shorter, no handle, not interactive. */
  compact?: boolean
}

export function CutTimeline({
  positionSec,
  durationSec,
  spans,
  onSeek,
  analyzedUntilSec,
  chapterMarks,
  compact = false,
}: CutTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const safeDuration = durationSec > 0 ? durationSec : 1
  const progress = Math.min(1, Math.max(0, positionSec / safeDuration))

  const marks = useMemo(
    () =>
      spans.map((span) => ({
        left: (span.startSec / safeDuration) * 100,
        // Sub-second cuts would render sub-pixel, so every mark gets a visible floor.
        width: Math.max(0.45, ((span.endSec - span.startSec) / safeDuration) * 100),
        key: `${span.startSec}-${span.endSec}`,
      })),
    [spans, safeDuration],
  )

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      onSeek(ratio * safeDuration)
    },
    [onSeek, safeDuration],
  )

  if (compact) {
    return (
      <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-panel-700">
        {marks.map((mark) => (
          <span
            key={mark.key}
            className="absolute inset-y-0 bg-ember-600/70"
            style={{ left: `${mark.left}%`, width: `${mark.width}%` }}
          />
        ))}
        <span
          className="absolute inset-y-0 left-0 bg-ink-100/85"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    )
  }

  return (
    <div
      ref={trackRef}
      // Scrubbing tracks the pointer, so this must not also drag the Now Playing panel
      // down; the panel's gesture handler skips anything inside a [data-no-drag].
      data-no-drag
      role="slider"
      tabIndex={0}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={Math.round(safeDuration)}
      aria-valuenow={Math.round(positionSec)}
      aria-valuetext={`${Math.round(positionSec)} seconds`}
      className="focus-ring group relative h-11 w-full cursor-pointer touch-none select-none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        seekFromPointer(event.clientX)
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) seekFromPointer(event.clientX)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') onSeek(positionSec + 15)
        if (event.key === 'ArrowLeft') onSeek(positionSec - 15)
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-[6px] -translate-y-1/2 overflow-hidden rounded-full bg-panel-800 ring-1 ring-inset ring-panel-700">
        {/* How far ahead filtering has checked. Sits under everything else. */}
        {analyzedUntilSec !== undefined && analyzedUntilSec > 0 && (
          <span
            className="absolute inset-y-0 left-0 bg-sage-500/25"
            style={{ width: `${Math.min(100, (analyzedUntilSec / safeDuration) * 100)}%` }}
          />
        )}
        {/* Chapter boundaries: navigation hints, kept fainter than anything meaningful. */}
        {chapterMarks?.map((sec) =>
          sec > 0 && sec < safeDuration ? (
            <span
              key={`ch-${sec}`}
              className="absolute inset-y-0 w-[2px] bg-ink-100/20"
              style={{ left: `${(sec / safeDuration) * 100}%` }}
            />
          ) : null,
        )}
        {/* Cuts sit beneath the elapsed fill, so passed cuts read as history. */}
        {marks.map((mark) => (
          <span
            key={mark.key}
            className="absolute inset-y-0 bg-ember-500"
            style={{ left: `${mark.left}%`, width: `${mark.width}%` }}
          />
        ))}
        <span
          className="absolute inset-y-0 left-0 bg-ink-100/90 mix-blend-overlay"
          style={{ width: `${progress * 100}%` }}
        />
        <span
          className="absolute inset-y-0 left-0 bg-ink-100/25"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <span
        // Slightly translucent so the cut markers it sits on top of stay readable through it.
        className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-100/90 shadow-lg transition-transform duration-150 group-active:scale-125"
        style={{ left: `${progress * 100}%` }}
      />
    </div>
  )
}
