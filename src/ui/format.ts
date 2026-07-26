/** Timecode as `M:SS`, or `H:MM:SS` once an hour is reached. */
export function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Compact duration for list rows: `1h 12m`, `48m`, `40s`. */
export function duration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '--'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${m}m`
}

export function bytes(value: number): string {
  if (!value) return '0 MB'
  const mb = value / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb >= 10) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

/** Relative publish date, falling back to an absolute date past a fortnight. */
export function relativeDate(timestamp: number): string {
  if (!timestamp) return ''
  const deltaSec = (Date.now() - timestamp) / 1000
  const day = 86_400
  if (deltaSec < 3600) return 'Just now'
  if (deltaSec < day) return `${Math.floor(deltaSec / 3600)}h ago`
  if (deltaSec < day * 14) return `${Math.floor(deltaSec / day)}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
