import type { TimedWord, TranscriptRef } from '@/core/types'
import { getPlatform } from '@/platform'

/**
 * Publisher transcripts from `podcast:transcript`.
 *
 * These are cue-level (2-5 seconds per cue), far too coarse to skip a single word. Their
 * value is different and considerable: a transcript can prove an episode contains no
 * profanity at all — skipping the ASR pass entirely — or narrow a 60-minute transcription
 * down to a handful of 10-second windows. Where transcripts exist, this turns minutes of
 * on-device compute into seconds.
 */

export interface Cue {
  startSec: number
  endSec: number
  text: string
}

/** `HH:MM:SS.mmm`, `MM:SS.mmm`, and the SRT comma variant. */
function parseTimestamp(raw: string): number {
  const value = raw.trim().replace(',', '.')
  const parts = value.split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

const CUE_TIMING = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/

/** Parses WebVTT and SubRip, which differ little enough to share one path. */
export function parseCues(content: string): Cue[] {
  const cues: Cue[] = []
  const blocks = content.replace(/\r\n/g, '\n').split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue

    const timingIndex = lines.findIndex((line) => CUE_TIMING.test(line))
    if (timingIndex === -1) continue

    const [startRaw, endRaw] = lines[timingIndex].split('-->')
    // Cue settings (align, position) trail the end timestamp; take the first token.
    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      // Speaker labels and inline VTT tags carry no words we care about.
      .replace(/<[^>]*>/g, '')
      .replace(/^[A-Z][A-Za-z .'-]{0,30}:\s*/, '')
      .trim()

    if (!text) continue
    cues.push({
      startSec: parseTimestamp(startRaw),
      endSec: parseTimestamp(endRaw.trim().split(/\s+/)[0]),
      text,
    })
  }

  return cues
}

/** The Podcasting 2.0 speech-to-text JSON format, which does carry word timings. */
function parseJsonTranscript(content: string): TimedWord[] | null {
  try {
    const parsed = JSON.parse(content) as {
      segments?: Array<{ startTime?: number; endTime?: number; body?: string }>
    }
    if (!Array.isArray(parsed.segments)) return null
    return parsed.segments
      .filter((segment) => segment.body && segment.startTime != null)
      .map((segment) => ({
        word: String(segment.body).trim(),
        startSec: Number(segment.startTime),
        endSec: Number(segment.endTime ?? Number(segment.startTime) + 0.3),
      }))
  } catch {
    return null
  }
}

export interface FetchedTranscript {
  /** Cue-level text, always present. */
  cues: Cue[]
  /** Word-level timings, only when the publisher supplied the JSON format. */
  words: TimedWord[] | null
}

/** Fetches the best available transcript for an episode, or null if none work. */
export async function fetchTranscript(
  refs: TranscriptRef[],
): Promise<FetchedTranscript | null> {
  // JSON carries word timings and is worth trying first; VTT is the most widely published.
  const ordered = [...refs].sort((a, b) => rank(a.type) - rank(b.type))

  for (const ref of ordered) {
    try {
      const response = await getPlatform().http.get(ref.url)
      if (response.status !== 200) continue
      const content = await response.text()

      if (ref.type === 'application/json') {
        const words = parseJsonTranscript(content)
        if (words && words.length > 0) {
          return { cues: [], words }
        }
        continue
      }

      const cues = parseCues(content)
      if (cues.length > 0) return { cues, words: null }
    } catch {
      // Try the next transcript rather than failing the whole pipeline.
    }
  }
  return null
}

function rank(type: TranscriptRef['type']): number {
  if (type === 'application/json') return 0
  if (type === 'text/vtt') return 1
  if (type === 'application/x-subrip') return 2
  return 3
}
