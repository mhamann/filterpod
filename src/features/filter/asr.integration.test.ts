import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILES } from '@/data/defaults'
import { normalizeSpans, padSpan, totalSkippedSec } from '@/core/filterMath'
import type { FilterSpan, TimedWord } from '@/core/types'
import { compileWordlist, matchWords } from './matcher'
import { sortAndDedupe } from './buildFilterMap'

/**
 * Opt-in integration test: runs the real Whisper model over real audio and pushes the
 * result through the app's matcher.
 *
 * Excluded from the default suite because it downloads ~100MB of model weights and
 * takes minutes. Its job is to check the one thing unit tests cannot: that Whisper's
 * output actually has the shape the matcher expects — one entry per word, with
 * monotonic per-word start/end times — rather than the sentence-level timings the
 * non-`_timestamped` model exports return.
 *
 *   FILTERPOD_ASR_AUDIO=/path/to/episode.mp3 pnpm test
 *
 * Optional: FILTERPOD_ASR_START (seconds, default 300)
 *           FILTERPOD_ASR_DURATION (seconds, default 120)
 *
 * Requires ffmpeg on PATH — Node has no Web Audio, so it stands in for the browser's
 * decode step. Everything downstream is the app's own code.
 */

const AUDIO = process.env.FILTERPOD_ASR_AUDIO
const START = process.env.FILTERPOD_ASR_START ?? '300'
const DURATION = process.env.FILTERPOD_ASR_DURATION ?? '120'
const MODEL = 'onnx-community/whisper-base.en_timestamped'

/** Decodes to the 16kHz mono float PCM the worker feeds Whisper. */
function decode(path: string): Float32Array {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-ss', START, '-t', DURATION, '-i', path,
     '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  )
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}

function toSpans(words: TimedWord[], profileId: string): FilterSpan[] {
  const profile = DEFAULT_PROFILES.find((p) => p.id === profileId)!
  const compiled = compileWordlist(profile)
  const matches = matchWords(words, compiled)
  // Printing what the ASR actually said next to what it matched is the only way to
  // tell a real hit from a lookalike; the span alone cannot show that.
  if (matches.length > 0) {
    console.log(
      `  ${profileId} matches:`,
      matches.map((m) => `"${m.word.word}"->${m.term}(${m.via})`).join(' '),
    )
  }
  return normalizeSpans(
    matches.map((match) => {
      const { startSec, endSec } = padSpan(
        match.word.startSec,
        match.word.endSec,
        profile.padBeforeSec,
        profile.padAfterSec,
      )
      return {
        startSec,
        endSec,
        severity: match.severity,
        category: match.category,
        terms: [match.term],
      }
    }),
    profile.mergeGapSec,
  )
}

describe.skipIf(!AUDIO)('real ASR through the matcher', () => {
  it(
    'produces word-level timings the matcher can turn into spans',
    async () => {
      const { pipeline } = await import('@huggingface/transformers')

      const pcm = decode(AUDIO!)
      const audioSec = pcm.length / 16_000
      expect(audioSec).toBeGreaterThan(10)

      const asr = await pipeline('automatic-speech-recognition', MODEL, {
        // The q8 decoder fails ONNX session creation; see transformers.js #1707.
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      })

      const started = Date.now()
      const output = (await asr(pcm, {
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
      })) as { chunks?: Array<{ text: string; timestamp: [number, number] }> }
      const elapsedSec = (Date.now() - started) / 1000

      const words: TimedWord[] = (output.chunks ?? [])
        .filter((chunk) => chunk.timestamp?.[0] != null)
        .map((chunk) => ({
          word: chunk.text.trim(),
          startSec: chunk.timestamp[0],
          endSec: chunk.timestamp[1] ?? chunk.timestamp[0] + 0.3,
        }))
        .filter((word) => word.word.length > 0)

      console.log(
        `\n${audioSec.toFixed(0)}s audio transcribed in ${elapsedSec.toFixed(1)}s ` +
        `(${(audioSec / elapsedSec).toFixed(1)}x realtime), ${words.length} words`,
      )
      console.log(
        'sample:',
        words.slice(0, 14).map((w) => `${w.word}@${w.startSec.toFixed(2)}`).join(' '),
      )

      // The core shape assertions.
      expect(words.length).toBeGreaterThan(20)
      // One entry per word, not per sentence: real speech runs well over 1 word/sec.
      expect(words.length / audioSec).toBeGreaterThan(0.5)
      // One token per word, not per phrase.
      for (const word of words) {
        expect(word.word).not.toContain(' ')
      }
      // No single entry may cover the clip, which is what sentence-level timings look
      // like. Individual tokens can still run long over music or a pause — that is why
      // toSpans caps how much audio one match may remove.
      const longest = Math.max(...words.map((w) => w.endSec - w.startSec))
      expect(longest).toBeLessThan(audioSec * 0.1)
      // Raw output is NOT ordered: Whisper's 30s chunks overlap by a 5s stride and the
      // overlap is re-emitted, so the stream jumps backwards by seconds at each seam
      // and repeats the words in between. That is what sortAndDedupe exists for, and
      // the invariants the rest of the pipeline relies on are asserted on its output.
      const cleaned = sortAndDedupe(words)
      console.log(`deduped ${words.length} -> ${cleaned.length} words`)

      for (let i = 1; i < cleaned.length; i++) {
        expect(cleaned[i].startSec).toBeGreaterThanOrEqual(cleaned[i - 1].startSec)
      }
      // Every word must be a positive-width range: the player's span lookup assumes it,
      // and DTW does occasionally return an inverted pair.
      for (const word of cleaned) {
        expect(word.endSec).toBeGreaterThan(word.startSec)
      }
      // Timestamps must be absolute across the whole clip, not per-chunk. If chunk
      // timings were relative, the last word would sit inside the first 30 seconds
      // and every cut after the first chunk would land on the wrong audio.
      expect(cleaned.at(-1)!.startSec).toBeGreaterThan(Math.min(60, audioSec * 0.5))
      // Dedupe must remove the overlap without eating the transcript.
      expect(cleaned.length).toBeGreaterThan(words.length * 0.6)

      for (const profileId of ['family', 'standard', 'strong-only']) {
        const spans = toSpans(words, profileId)
        console.log(
          `[${profileId}] ${spans.length} spans, ${totalSkippedSec(spans).toFixed(2)}s cut` +
          (spans.length ? ` — ${spans.slice(0, 6).map((s) => s.terms.join('/')).join(', ')}` : ''),
        )
        // Whatever the content, spans must be well-formed, inside the clip, and
        // bounded — a single mistimed token must never eat a chunk of the show.
        const profile = DEFAULT_PROFILES.find((p) => p.id === profileId)!
        const maxWidth = 1.5 + profile.padBeforeSec + profile.padAfterSec
        for (const span of spans) {
          expect(span.endSec).toBeGreaterThan(span.startSec)
          expect(span.startSec).toBeGreaterThanOrEqual(0)
          // Merged runs are legitimately wider, so allow for the merge gap per term.
          expect(span.endSec - span.startSec).toBeLessThanOrEqual(
            maxWidth * span.terms.length + profile.mergeGapSec * span.terms.length,
          )
        }
      }
    },
    20 * 60 * 1000,
  )
})
