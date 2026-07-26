/**
 * Span math shared by the filter engine, the player and the UI.
 *
 * Two clocks matter throughout the app:
 *   - ORIGINAL position — where we are in the publisher's audio. Persisted for resume,
 *     and what the scrubber maps onto.
 *   - FILTERED position — elapsed listening time with flagged spans removed. What the
 *     user actually experiences, and what "time remaining" should reflect.
 */

import type { AnalyzedRange, FilterSpan } from './types'

// ---------------------------------------------------------------------------
// Analysis coverage
// ---------------------------------------------------------------------------

/**
 * Sorts and merges analyzed ranges, joining ones that touch.
 *
 * Coverage arrives out of order — a seek starts a new region ahead of the current one —
 * so this keeps the list canonical for the coverage queries below.
 */
export function mergeRanges(ranges: AnalyzedRange[]): AnalyzedRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec)
  const out: AnalyzedRange[] = [{ ...sorted[0] }]

  for (const range of sorted.slice(1)) {
    const last = out[out.length - 1]
    // Touching counts as contiguous: chunk N ends exactly where chunk N+1 begins.
    if (range.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, range.endSec)
    } else {
      out.push({ ...range })
    }
  }
  return out
}

/**
 * Removes `holes` from `ranges`.
 *
 * Used to carve the stretches that still need transcribing out of the regions a
 * publisher transcript already vouches for.
 */
export function subtractRanges(
  ranges: AnalyzedRange[],
  holes: AnalyzedRange[],
): AnalyzedRange[] {
  if (holes.length === 0) return mergeRanges(ranges)
  const cuts = mergeRanges(holes)
  let out = mergeRanges(ranges)

  for (const hole of cuts) {
    const next: AnalyzedRange[] = []
    for (const range of out) {
      // Disjoint: keep as-is.
      if (hole.endSec <= range.startSec || hole.startSec >= range.endSec) {
        next.push(range)
        continue
      }
      // Whatever survives on either side of the hole.
      if (hole.startSec > range.startSec) {
        next.push({ startSec: range.startSec, endSec: hole.startSec })
      }
      if (hole.endSec < range.endSec) {
        next.push({ startSec: hole.endSec, endSec: range.endSec })
      }
    }
    out = next
  }
  return out.filter((range) => range.endSec > range.startSec)
}

/** Whether a moment has been analyzed, and is therefore safe to play. */
export function isAnalyzed(ranges: AnalyzedRange[], positionSec: number): boolean {
  return ranges.some(
    (range) => positionSec >= range.startSec && positionSec < range.endSec,
  )
}

/**
 * How far playback can safely run from `positionSec` — the end of the contiguous
 * coverage containing it. Returns `positionSec` when that moment is not analyzed at
 * all, which is what the player treats as "cannot play yet".
 */
export function analyzedUntil(ranges: AnalyzedRange[], positionSec: number): number {
  for (const range of ranges) {
    if (positionSec >= range.startSec && positionSec < range.endSec) return range.endSec
  }
  return positionSec
}

/** Total analyzed audio, for progress display. */
export function analyzedSec(ranges: AnalyzedRange[]): number {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.endSec - range.startSec), 0)
}

/** Sorts by start and merges overlapping or near-adjacent spans into single skips. */
export function normalizeSpans(spans: FilterSpan[], mergeGapSec = 0.35): FilterSpan[] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a.startSec - b.startSec)
  const out: FilterSpan[] = [{ ...sorted[0], terms: [...sorted[0].terms] }]

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i]
    const last = out[out.length - 1]
    if (span.startSec - last.endSec <= mergeGapSec) {
      last.endSec = Math.max(last.endSec, span.endSec)
      // A merged span carries the strongest severity of its parts.
      if (severityRank(span.severity) > severityRank(last.severity)) {
        last.severity = span.severity
        last.category = span.category
      }
      for (const term of span.terms) {
        if (!last.terms.includes(term)) last.terms.push(term)
      }
    } else {
      out.push({ ...span, terms: [...span.terms] })
    }
  }
  return out
}

export function severityRank(severity: FilterSpan['severity']): number {
  return severity === 'strong' ? 3 : severity === 'moderate' ? 2 : 1
}

/** Total audio removed by a set of spans. */
export function totalSkippedSec(spans: FilterSpan[]): number {
  return spans.reduce((sum, s) => sum + Math.max(0, s.endSec - s.startSec), 0)
}

/**
 * The span containing `positionSec`, or null.
 * Spans are assumed normalized (sorted, non-overlapping), so this binary searches.
 */
export function spanAt(spans: FilterSpan[], positionSec: number): FilterSpan | null {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = spans[mid]
    if (positionSec < span.startSec) hi = mid - 1
    else if (positionSec >= span.endSec) lo = mid + 1
    else return span
  }
  return null
}

/** The first span starting at or after `positionSec`, or null. */
export function nextSpanFrom(spans: FilterSpan[], positionSec: number): FilterSpan | null {
  let lo = 0
  let hi = spans.length - 1
  let found: FilterSpan | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].startSec >= positionSec) {
      found = spans[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return found
}

/** Maps an original-timeline position to elapsed filtered listening time. */
export function toFilteredPosition(spans: FilterSpan[], originalSec: number): number {
  let removed = 0
  for (const span of spans) {
    if (span.startSec >= originalSec) break
    removed += Math.min(originalSec, span.endSec) - span.startSec
  }
  return Math.max(0, originalSec - removed)
}

/** Inverse of `toFilteredPosition` — used when the user scrubs a filtered timeline. */
export function toOriginalPosition(spans: FilterSpan[], filteredSec: number): number {
  let original = filteredSec
  for (const span of spans) {
    if (span.startSec >= original) break
    original += span.endSec - span.startSec
  }
  return original
}

/**
 * Applies padding to a raw word timing.
 *
 * whisper.cpp derives word timestamps by running DTW over decoder cross-attention,
 * which carries roughly 100-400ms of error. Padding generously costs a sliver of
 * surrounding audio but avoids the failure that actually matters: clipping the front
 * of a flagged word and letting it through.
 */
export function padSpan(
  startSec: number,
  endSec: number,
  padBeforeSec: number,
  padAfterSec: number,
  durationSec?: number,
): { startSec: number; endSec: number } {
  const start = Math.max(0, startSec - padBeforeSec)
  const end = durationSec ? Math.min(durationSec, endSec + padAfterSec) : endSec + padAfterSec
  return { startSec: start, endSec: end }
}
