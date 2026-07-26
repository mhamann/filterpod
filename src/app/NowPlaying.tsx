import { useState } from 'react'
import clsx from 'clsx'
import { usePlayerStore } from '@/features/player/playerStore'
import { analyzedUntil, toFilteredPosition } from '@/core/filterMath'
import { CutTimeline } from '@/ui/CutTimeline'
import { Artwork, Pill } from '@/ui/components'
import { Icon } from '@/ui/Icon'
import { timecode } from '@/ui/format'

const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2]

/** Full-screen player. The console metaphor is most literal here. */
export function NowPlaying({ onClose }: { onClose(): void }) {
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

  if (!episode) return null

  const remaining = Math.max(0, durationSec - positionSec)
  const filteredElapsed = toFilteredPosition(spans, positionSec)
  const cutsPassed = spans.filter((span) => span.endSec <= positionSec).length
  const totalCutSec = spans.reduce((sum, span) => sum + (span.endSec - span.startSec), 0)
  const frontier = analyzedUntil(analyzedRanges, positionSec)
  const fullyAnalyzed = durationSec > 0 && frontier >= durationSec - 2

  return (
    <div className="animate-rise fixed inset-0 z-50 flex flex-col bg-panel-950">
      <div className="rack-texture safe-top flex items-center justify-between border-b border-panel-800 px-4 py-3">
        <button onClick={onClose} className="focus-ring rounded-full p-2 text-ink-300">
          <Icon name="chevronDown" size={22} />
        </button>
        <span className="silkscreen">Now playing</span>
        <div className="w-9" />
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto px-6 pb-8">
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
            <Pill tone="ember" pulse icon="shield">
              Checking the first minute…
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
          {/* Filtering runs alongside playback, so say how far ahead it has reached. */}
          {!preparing && !fullyAnalyzed && analyzedRanges.length > 0 && (
            <Pill tone="neutral" icon="shield">
              checked to {timecode(frontier)}
            </Pill>
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
            <Icon name="back15" size={28} />
          </button>

          <button
            onClick={toggle}
            className="glow-ember focus-ring flex h-[72px] w-[72px] items-center justify-center rounded-full bg-ember-500 text-panel-950 transition active:scale-95"
            aria-label={state === 'playing' ? 'Pause' : 'Play'}
          >
            <Icon name={state === 'playing' ? 'pause' : 'play'} size={34} />
          </button>

          <button onClick={skipForward} className="focus-ring rounded-full p-3 text-ink-300">
            <Icon name="forward30" size={28} />
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

/** Docked bar above the tab rail. Tapping it opens the full player. */
export function MiniPlayer({ onExpand }: { onExpand(): void }) {
  const { episode, podcast, spans, state, positionSec, durationSec, toggle } = usePlayerStore()
  if (!episode) return null

  return (
    <div className="border-t border-panel-800 bg-panel-900/95 backdrop-blur">
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
