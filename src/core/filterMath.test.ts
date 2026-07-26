import { describe, expect, it } from 'vitest'
import type { FilterSpan } from './types'
import {
  analyzedSec,
  analyzedUntil,
  isAnalyzed,
  mergeRanges,
  nextSpanFrom,
  normalizeSpans,
  padSpan,
  spanAt,
  subtractRanges,
  toFilteredPosition,
  toOriginalPosition,
  totalSkippedSec,
} from './filterMath'

function span(startSec: number, endSec: number, extra: Partial<FilterSpan> = {}): FilterSpan {
  return {
    startSec,
    endSec,
    severity: 'moderate',
    category: 'profanity',
    terms: ['x'],
    ...extra,
  }
}

describe('normalizeSpans', () => {
  it('sorts by start time', () => {
    const result = normalizeSpans([span(10, 11), span(2, 3)])
    expect(result.map((s) => s.startSec)).toEqual([2, 10])
  })

  it('merges spans closer than the gap', () => {
    const result = normalizeSpans([span(1, 2), span(2.2, 3)], 0.35)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ startSec: 1, endSec: 3 })
  })

  it('keeps spans further apart than the gap', () => {
    expect(normalizeSpans([span(1, 2), span(5, 6)], 0.35)).toHaveLength(2)
  })

  it('merges overlapping spans', () => {
    const result = normalizeSpans([span(1, 4), span(2, 3)])
    expect(result).toHaveLength(1)
    expect(result[0].endSec).toBe(4)
  })

  it('a merged span takes the strongest severity of its parts', () => {
    const result = normalizeSpans(
      [span(1, 2, { severity: 'mild' }), span(2.1, 3, { severity: 'strong' })],
      0.35,
    )
    expect(result[0].severity).toBe('strong')
  })

  it('a merged span unions its terms', () => {
    const result = normalizeSpans(
      [span(1, 2, { terms: ['a'] }), span(2.1, 3, { terms: ['b'] })],
      0.35,
    )
    expect(result[0].terms).toEqual(['a', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [span(1, 2), span(2.1, 3)]
    normalizeSpans(input, 0.35)
    expect(input[0].endSec).toBe(2)
  })
})

describe('span lookup', () => {
  const spans = normalizeSpans([span(10, 11), span(20, 22), span(30, 31)])

  it('finds the span containing a position', () => {
    expect(spanAt(spans, 20.5)?.startSec).toBe(20)
  })

  it('returns null between spans', () => {
    expect(spanAt(spans, 15)).toBeNull()
  })

  it('treats the end of a span as outside it', () => {
    // The player seeks to endSec, so that position must not re-trigger the same skip.
    expect(spanAt(spans, 22)).toBeNull()
  })

  it('finds the next upcoming span', () => {
    expect(nextSpanFrom(spans, 12)?.startSec).toBe(20)
    expect(nextSpanFrom(spans, 31)).toBeNull()
  })
})

describe('position mapping', () => {
  const spans = normalizeSpans([span(10, 12), span(20, 23)])

  it('reports total skipped audio', () => {
    expect(totalSkippedSec(spans)).toBe(5)
  })

  it('filtered position equals original before any span', () => {
    expect(toFilteredPosition(spans, 5)).toBe(5)
  })

  it('subtracts fully-passed spans', () => {
    expect(toFilteredPosition(spans, 25)).toBe(20)
  })

  it('subtracts only the elapsed part of a span in progress', () => {
    expect(toFilteredPosition(spans, 11)).toBe(10)
  })

  it('round-trips through the inverse mapping', () => {
    for (const original of [5, 15, 25, 40]) {
      expect(toOriginalPosition(spans, toFilteredPosition(spans, original))).toBeCloseTo(original)
    }
  })
})

describe('analysis coverage', () => {
  it('merges contiguous chunks into one range', () => {
    // Chunk boundaries touch exactly; they must not stay separate or playback would
    // stall at every seam.
    expect(mergeRanges([{ startSec: 0, endSec: 60 }, { startSec: 60, endSec: 120 }])).toEqual([
      { startSec: 0, endSec: 120 },
    ])
  })

  it('keeps a gap left by a seek', () => {
    const ranges = mergeRanges([
      { startSec: 0, endSec: 60 },
      { startSec: 600, endSec: 660 },
    ])
    expect(ranges).toHaveLength(2)
  })

  it('merges out-of-order and overlapping ranges', () => {
    expect(mergeRanges([{ startSec: 60, endSec: 120 }, { startSec: 0, endSec: 90 }])).toEqual([
      { startSec: 0, endSec: 120 },
    ])
  })

  it('reports whether a moment is analyzed', () => {
    const ranges = [{ startSec: 0, endSec: 60 }]
    expect(isAnalyzed(ranges, 30)).toBe(true)
    expect(isAnalyzed(ranges, 90)).toBe(false)
    // The end is exclusive: playback must stop there, not run one sample past it.
    expect(isAnalyzed(ranges, 60)).toBe(false)
  })

  it('reports how far playback may safely run', () => {
    const ranges = mergeRanges([
      { startSec: 0, endSec: 120 },
      { startSec: 600, endSec: 660 },
    ])
    expect(analyzedUntil(ranges, 30)).toBe(120)
    expect(analyzedUntil(ranges, 620)).toBe(660)
  })

  it('returns the position itself when unanalyzed, meaning zero headroom', () => {
    expect(analyzedUntil([{ startSec: 0, endSec: 60 }], 300)).toBe(300)
  })

  it('sums analyzed audio', () => {
    expect(analyzedSec([{ startSec: 0, endSec: 60 }, { startSec: 600, endSec: 690 }])).toBe(150)
  })

  it('handles no coverage at all', () => {
    expect(mergeRanges([])).toEqual([])
    expect(isAnalyzed([], 0)).toBe(false)
    expect(analyzedUntil([], 42)).toBe(42)
  })
})

describe('subtractRanges', () => {
  it('punches a hole in the middle, leaving both sides', () => {
    expect(
      subtractRanges([{ startSec: 0, endSec: 100 }], [{ startSec: 40, endSec: 60 }]),
    ).toEqual([
      { startSec: 0, endSec: 40 },
      { startSec: 60, endSec: 100 },
    ])
  })

  it('trims from the front and the back', () => {
    expect(subtractRanges([{ startSec: 0, endSec: 100 }], [{ startSec: 0, endSec: 30 }])).toEqual([
      { startSec: 30, endSec: 100 },
    ])
    expect(subtractRanges([{ startSec: 0, endSec: 100 }], [{ startSec: 80, endSec: 200 }])).toEqual(
      [{ startSec: 0, endSec: 80 }],
    )
  })

  it('removes a range entirely when fully covered', () => {
    expect(subtractRanges([{ startSec: 10, endSec: 20 }], [{ startSec: 0, endSec: 100 }])).toEqual(
      [],
    )
  })

  it('ignores holes that do not overlap', () => {
    expect(subtractRanges([{ startSec: 0, endSec: 10 }], [{ startSec: 50, endSec: 60 }])).toEqual([
      { startSec: 0, endSec: 10 },
    ])
  })

  it('applies several holes at once', () => {
    const result = subtractRanges(
      [{ startSec: 0, endSec: 100 }],
      [
        { startSec: 10, endSec: 20 },
        { startSec: 50, endSec: 60 },
      ],
    )
    expect(result).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 20, endSec: 50 },
      { startSec: 60, endSec: 100 },
    ])
  })

  it('returns the input when there are no holes', () => {
    expect(subtractRanges([{ startSec: 0, endSec: 10 }], [])).toEqual([
      { startSec: 0, endSec: 10 },
    ])
  })

  // The safety direction that matters: a hole must never be swallowed, because the
  // holes are exactly the stretches that still need transcribing.
  it('never reports a subtracted stretch as still covered', () => {
    const result = subtractRanges([{ startSec: 0, endSec: 100 }], [{ startSec: 40, endSec: 60 }])
    expect(isAnalyzed(result, 50)).toBe(false)
  })
})

describe('padSpan', () => {
  it('widens a span on both sides', () => {
    const padded = padSpan(10, 10.4, 0.2, 0.3)
    expect(padded.startSec).toBeCloseTo(9.8)
    expect(padded.endSec).toBeCloseTo(10.7)
  })

  it('never produces a negative start', () => {
    expect(padSpan(0.1, 0.4, 0.2, 0.3).startSec).toBe(0)
  })

  it('clamps to the episode duration when known', () => {
    expect(padSpan(59.8, 60, 0.2, 0.3, 60).endSec).toBe(60)
  })
})
