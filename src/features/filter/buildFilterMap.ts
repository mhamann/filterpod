import type { Episode, FilterMap, FilterProfile, FilterSpan, TimedWord } from '@/core/types'
import { normalizeSpans, padSpan, totalSkippedSec } from '@/core/filterMath'
import { ENGINE_VERSION, WORDLIST_VERSION } from '@/data/defaults'
import { getPlatform } from '@/platform'
import { compileWordlist, matchWords, type CompiledWordlist } from './matcher'
import { fetchTranscript, type Cue } from './transcript'
import type { WordOverride } from '@/data/db'

/**
 * Builds an episode's filter map.
 *
 * Strategy, cheapest path first:
 *   1. Publisher transcript in JSON form  -> word timings for free, no ASR at all
 *   2. Publisher transcript in VTT/SRT    -> if it contains no flagged term anywhere,
 *                                            the episode is clean and we stop; otherwise
 *                                            ASR runs only over the suspect cue windows
 *   3. No transcript                      -> full ASR pass
 */

/** Padding around a suspect cue when narrowing ASR, absorbing cue timing slop. */
const CUE_WINDOW_PAD_SEC = 4

export interface BuildOptions {
  episode: Episode
  fileKey: string
  profile: FilterProfile
  overrides: WordOverride[]
  model: string
  /**
   * Cap on any single ASR window. Without it a no-transcript episode becomes one
   * monolithic native call that cancellation cannot interrupt — the whisper run checks
   * its abort flag only *between* windows — which let a background prefilter starve a
   * live listener for the length of an entire episode. Sliced, the transcriber changes
   * hands within one window of a cancel.
   */
  maxWindowSec?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Extra audio sliced beyond the feed's claimed duration, because feeds lie by minutes. */
const DURATION_SLACK_SEC = 300

export interface BuildResult {
  spans: FilterSpan[]
  source: FilterMap['source']
}

/** Splits cue text into words with timings interpolated across the cue. */
function cueToWords(cue: Cue): TimedWord[] {
  const tokens = cue.text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const duration = Math.max(0.1, cue.endSec - cue.startSec)
  const per = duration / tokens.length
  return tokens.map((token, index) => ({
    word: token,
    startSec: cue.startSec + index * per,
    endSec: cue.startSec + (index + 1) * per,
  }))
}

/**
 * Ceiling on how much audio a single matched word may remove.
 *
 * Whisper sometimes assigns one token a multi-second range — over intro music or a long
 * pause it has been observed at seven seconds. No spoken word lasts that long, and the
 * worst failure this app can have is silently deleting a chunk of the show, so a
 * mistimed token is capped rather than trusted.
 */
const MAX_MATCH_SEC = 1.5

/**
 * Turns matched words into padded, merged skip spans.
 * Shared with the live pipeline, which builds spans one chunk at a time.
 */
export function spansFromMatches(
  matches: ReturnType<typeof matchWords>,
  profile: FilterProfile,
  durationSec?: number,
): FilterSpan[] {
  const spans = matches.map((match) => {
    const cappedEnd = Math.min(match.word.endSec, match.word.startSec + MAX_MATCH_SEC)
    const { startSec, endSec } = padSpan(
      match.word.startSec,
      cappedEnd,
      profile.padBeforeSec,
      profile.padAfterSec,
      durationSec,
    )
    return {
      startSec,
      endSec,
      severity: match.severity,
      category: match.category,
      terms: [match.term],
    } satisfies FilterSpan
  })
  return normalizeSpans(spans, profile.mergeGapSec)
}

/** Merges overlapping suspect windows so ASR never transcribes the same audio twice. */
function mergeWindows(
  windows: Array<{ startSec: number; endSec: number }>,
): Array<{ startSec: number; endSec: number }> {
  if (windows.length === 0) return []
  const sorted = [...windows].sort((a, b) => a.startSec - b.startSec)
  const out = [{ ...sorted[0] }]
  for (const window of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (window.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, window.endSec)
    } else {
      out.push({ ...window })
    }
  }
  return out
}

export async function buildFilterMap(options: BuildOptions): Promise<BuildResult> {
  const { episode, fileKey, profile, overrides, model, onProgress, signal } = options
  const compiled = compileWordlist(profile, overrides)

  if (profile.severities.length === 0) {
    return { spans: [], source: 'none' }
  }

  const transcript =
    episode.transcripts.length > 0 ? await fetchTranscript(episode.transcripts) : null

  // --- 1. Word-level transcript: no ASR needed at all -----------------------
  if (transcript?.words && transcript.words.length > 0) {
    onProgress?.(1)
    const matches = matchWords(transcript.words, compiled)
    return { spans: spansFromMatches(matches, profile, episode.durationSec), source: 'transcript-only' }
  }

  // --- 2. Cue-level transcript: prove clean, or narrow the ASR pass ---------
  let windows: Array<{ startSec: number; endSec: number }> | undefined
  if (transcript?.cues && transcript.cues.length > 0) {
    const suspectCues = transcript.cues.filter(
      (cue) => matchWords(cueToWords(cue), compiled).length > 0,
    )

    if (suspectCues.length === 0) {
      // The transcript covers the episode and contains nothing flagged. Trusting it
      // here is what makes transcript-bearing feeds essentially free to process.
      onProgress?.(1)
      return { spans: [], source: 'transcript-only' }
    }

    windows = mergeWindows(
      suspectCues.map((cue) => ({
        startSec: Math.max(0, cue.startSec - CUE_WINDOW_PAD_SEC),
        endSec: cue.endSec + CUE_WINDOW_PAD_SEC,
      })),
    )
  }

  // --- 3. ASR, either narrowed or full --------------------------------------
  if (!windows && options.maxWindowSec && episode.durationSec) {
    // Slice the full pass into bounded windows; see maxWindowSec. The slack window
    // past the claimed duration covers feeds that under-report; decoding past the
    // real end just returns nothing.
    windows = []
    const end = episode.durationSec + DURATION_SLACK_SEC
    for (let start = 0; start < end; start += options.maxWindowSec) {
      windows.push({ startSec: start, endSec: Math.min(start + options.maxWindowSec, end) })
    }
  }

  const words = await getPlatform().transcriber.transcribe({
    episodeId: episode.id,
    fileKey,
    model,
    windows,
    onProgress,
    signal,
  })

  const matches = matchWords(sortAndDedupe(words), compiled)
  return {
    spans: spansFromMatches(matches, profile, episode.durationSec),
    source: windows ? 'transcript-narrowed-asr' : 'asr',
  }
}

/** Two emissions of the same word closer than this are the same utterance. */
const DUPLICATE_WINDOW_SEC = 0.35

/** Floor for a word whose ASR timings are inverted or zero-width. */
const MIN_WORD_SEC = 0.12

/**
 * Normalizes raw ASR output into the ordered, well-formed sequence the rest of the
 * pipeline assumes. Two real defects in Whisper's output are handled here.
 *
 * Chunk overlap: Whisper transcribes in 30s chunks with a 5s stride and re-emits the
 * overlap rather than merging it, so the raw stream jumps backwards by seconds at every
 * seam and repeats the words in between. Timestamps stay absolute, so filtering still
 * lands in the right place, but leaving the repeats in would double-count matches and
 * let a seam split a phrase that is actually contiguous.
 *
 * Inverted timings: DTW over cross-attention occasionally returns a word whose end
 * precedes its start. Left alone that becomes a negative-width span, which the player's
 * span lookup — which assumes sorted, positive-width ranges — would simply never skip.
 */
export function sortAndDedupe(words: TimedWord[]): TimedWord[] {
  const sorted = [...words]
    .map((word) => ({
      ...word,
      endSec: word.endSec > word.startSec ? word.endSec : word.startSec + MIN_WORD_SEC,
    }))
    .sort((a, b) => a.startSec - b.startSec)

  const out: TimedWord[] = []
  for (const word of sorted) {
    const previous = out[out.length - 1]
    if (
      previous &&
      previous.word === word.word &&
      Math.abs(previous.startSec - word.startSec) < DUPLICATE_WINDOW_SEC
    ) {
      // Keep the wider of the two, so padding is never based on a clipped copy.
      previous.endSec = Math.max(previous.endSec, word.endSec)
      continue
    }
    out.push(word)
  }

  return out
}

/**
 * Wraps a build result into a storable record.
 * This is the whole-episode path, so coverage is the entire duration.
 */
export function toFilterMapRecord(
  episodeId: string,
  result: BuildResult,
  durationSec: number | undefined,
  profileId: string,
): FilterMap {
  return {
    episodeId,
    status: 'ready',
    spans: result.spans,
    analyzedRanges: [{ startSec: 0, endSec: durationSec || Number.MAX_SAFE_INTEGER }],
    source: result.source,
    engineVersion: ENGINE_VERSION,
    wordlistVersion: WORDLIST_VERSION,
    // Spans are profile-dependent; a record that omitted this would be discarded by
    // the live pipeline's mismatch check the moment anyone pressed play.
    profileId,
    progress: 1,
    createdAt: Date.now(),
    skippedSec: totalSkippedSec(result.spans),
  }
}

/** True when a stored map predates the current engine or wordlist and must regenerate. */
export function isStale(map: FilterMap): boolean {
  return map.engineVersion !== ENGINE_VERSION || map.wordlistVersion !== WORDLIST_VERSION
}

export type { CompiledWordlist }
