import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { Download, FilterMap } from '@/core/types'
import { Icon, type IconName } from './Icon'
import { bytes } from './format'

/** Podcast artwork with a panel-toned placeholder for missing or failed images. */
export function Artwork({
  src,
  alt,
  className,
}: {
  src?: string
  alt: string
  className?: string
}) {
  return (
    <div
      className={clsx(
        'relative shrink-0 overflow-hidden rounded-lg bg-panel-800 ring-1 ring-panel-700',
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden'
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-ink-600">
          <Icon name="library" size={22} />
        </div>
      )}
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  className,
  icon,
  'aria-label': ariaLabel,
}: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  icon?: IconName
  /** Required for icon-only buttons, which otherwise have no accessible name. */
  'aria-label'?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={clsx(
        'focus-ring inline-flex items-center justify-center gap-2 rounded-full font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-3 py-1.5 text-[13px]' : 'px-4 py-2.5 text-sm',
        variant === 'primary' &&
          'bg-ember-500 text-panel-950 hover:bg-ember-400 active:scale-[0.97]',
        variant === 'secondary' &&
          'bg-panel-800 text-ink-100 ring-1 ring-panel-700 hover:bg-panel-700 active:scale-[0.97]',
        variant === 'ghost' && 'text-ink-300 hover:text-ink-100',
        variant === 'danger' && 'bg-alarm-500/15 text-alarm-400 ring-1 ring-alarm-500/30',
        className,
      )}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  )
}

/**
 * Episode filter state.
 *
 * This is deliberately prominent throughout the app. Because filtering happens on
 * device after download, "is this episode ready?" is a real, visible part of the
 * model rather than something to hide behind a spinner.
 */
export function FilterStatus({
  map,
  download,
  compact = false,
}: {
  map?: FilterMap
  download?: Download
  compact?: boolean
}) {
  if (download && (download.state === 'downloading' || download.state === 'queued')) {
    const pct =
      download.bytesTotal > 0
        ? Math.round((download.bytesDownloaded / download.bytesTotal) * 100)
        : 0
    return (
      <Pill tone="neutral" icon="download">
        {download.state === 'queued' ? 'Queued' : `${pct}%`}
      </Pill>
    )
  }

  // No map is the normal resting state now: filtering starts when you press play, so
  // an unplayed episode simply has not been looked at yet.
  if (!map || map.status === 'absent') {
    return compact ? null : <Pill tone="muted">Not checked yet</Pill>
  }

  switch (map.status) {
    case 'partial': {
      // Partway through. Report cuts found so far rather than a percentage — the work
      // is bounded by where you have listened, so "N% done" would be meaningless.
      if (map.spans.length === 0) {
        return (
          <Pill tone="neutral" icon="shield">
            Nothing so far
          </Pill>
        )
      }
      return (
        <Pill tone="ember" icon="asterisk">
          {map.spans.length} so far
        </Pill>
      )
    }
    case 'failed':
      return (
        <Pill tone="alarm" icon="warning">
          Failed
        </Pill>
      )
    case 'unsupported':
      return <Pill tone="muted">Unsupported</Pill>
    case 'ready':
      if (map.spans.length === 0) {
        return (
          <Pill tone="sage" icon="check">
            {compact ? 'Clean' : 'Nothing to cut'}
          </Pill>
        )
      }
      return (
        <Pill tone="sage" icon="asterisk">
          {map.spans.length} {compact ? '' : map.spans.length === 1 ? 'cut' : 'cuts'}
        </Pill>
      )
    default:
      return null
  }
}

export function Pill({
  children,
  tone = 'neutral',
  icon,
  pulse,
}: {
  children: ReactNode
  tone?: 'neutral' | 'ember' | 'sage' | 'alarm' | 'muted'
  icon?: IconName
  pulse?: boolean
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium whitespace-nowrap',
        'font-mono tracking-tight',
        tone === 'neutral' && 'bg-panel-800 text-ink-300 ring-1 ring-panel-700',
        tone === 'ember' && 'bg-ember-500/12 text-ember-300 ring-1 ring-ember-500/30',
        tone === 'sage' && 'bg-sage-500/12 text-sage-300 ring-1 ring-sage-500/25',
        tone === 'alarm' && 'bg-alarm-500/12 text-alarm-400 ring-1 ring-alarm-500/30',
        tone === 'muted' && 'bg-panel-850 text-ink-600 ring-1 ring-panel-800',
        pulse && 'animate-pulse-ember',
      )}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}

/** Section heading with the silkscreen label treatment. */
export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="silkscreen">{children}</h2>
      {action}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-panel-850 text-ink-600 ring-1 ring-panel-700">
        <Icon name={icon} size={24} />
      </div>
      <h3 className="mb-1.5 text-lg">{title}</h3>
      <p className="max-w-xs text-sm text-ink-500">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/** Thin determinate bar used for download and transcription progress. */
export function ProgressBar({ value, tone = 'ember' }: { value: number; tone?: 'ember' | 'sage' }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-panel-800">
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-300',
          tone === 'ember' ? 'bg-ember-500' : 'bg-sage-500',
        )}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  )
}

export function StorageMeter({ used, total }: { used: number; total: number }) {
  const ratio = total > 0 ? used / total : 0
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="silkscreen">Storage</span>
        <span className="tabular text-xs text-ink-300">
          {bytes(used)} <span className="text-ink-600">/ {bytes(total)}</span>
        </span>
      </div>
      <ProgressBar value={ratio} tone={ratio > 0.9 ? 'ember' : 'sage'} />
    </div>
  )
}
