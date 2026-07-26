import type { AnalyzedRange, Episode, FilterMap, FilterProfile, FilterSpan } from '@/core/types'
import {
  analyzedUntil,
  mergeRanges,
  normalizeSpans,
  subtractRanges,
  totalSkippedSec,
} from '@/core/filterMath'
import { getPlatform } from '@/platform'
import { db, type WordOverride } from '@/data/db'
import { ENGINE_VERSION, WORDLIST_VERSION } from '@/data/defaults'
import { getFilterMap, putFilterMap } from '@/data/repo'
import { useModelStore } from './modelStore'
import { compileWordlist, matchWords } from './matcher'
import { fetchTranscript } from './transcript'
import { sortAndDedupe, spansFromMatches } from './buildFilterMap'

/**
 * Just-in-time filtering, driven by the playhead.
 *
 * Filtering an episode means transcribing it, which is by far the most expensive thing
 * this app does. Doing that eagerly for every download burns CPU and battery on episodes
 * that may never be played, and makes time-to-play minutes rather than seconds. So
 * instead: transcribe a short lead-in, start playing, and keep transcribing ahead of the
 * playhead while the audio plays.
 *
 * Two properties matter for this to be safe:
 *
 *  - **Unanalyzed is not clean.** Playback may never run past the end of analyzed
 *    coverage, because a stretch nobody has looked at might contain anything. The
 *    player enforces this; this module's job is to keep the frontier ahead.
 *  - **It stops when it is far enough ahead.** Staying a bounded distance in front of
 *    the playhead is what keeps this from quietly becoming the eager pipeline again.
 */

/** Analyzed before playback is allowed to start. The wait the user actually feels. */
const LEAD_IN_SEC = 90

/** How far ahead of the playhead to stay. Work pauses once this much is buffered. */
const TARGET_LEAD_SEC = 240

/** Resume work when the cushion falls below this. Hysteresis, so it is not thrashing. */
const RESUME_LEAD_SEC = 150

/**
 * Audio transcribed per step. Large enough to amortize model setup, small enough that
 * the lead-in is not dominated by one oversized chunk.
 */
const CHUNK_SEC = 45

/** Padding around a flagged cue, absorbing cue timing slop before ASR looks closer. */
const CUE_WINDOW_PAD_SEC = 4

/** Gaps between cues this small are pauses, not unexamined audio. */
const CUE_GAP_TOLERANCE_SEC = 3

export interface LiveFilterHandle {
  /** Tells the pipeline where playback is, so it knows how far ahead to work. */
  setPosition(positionSec: number): void
  /** Restarts work at a new position after a seek. */
  retarget(positionSec: number): void
  stop(): void
  readonly episodeId: string
}

export interface LiveFilterCallbacks {
  /** Fires whenever new spans or coverage land. */
  onUpdate(spans: FilterSpan[], ranges: AnalyzedRange[]): void
  /**
   * Fires while the speech model is being fetched, 0..1.
   *
   * This matters more than it looks: the model is ~150MB, and the first time anyone
   * presses play it must be downloaded before a single second can be analyzed. Without
   * this the UI sits on "preparing" for minutes and is indistinguishable from a hang.
   */
  onModelProgress?(fraction: number): void
  onError(message: string): void
}

interface Session {
  episode: Episode
  fileKey: string
  profile: FilterProfile
  overrides: WordOverride[]
  model: string
  spans: FilterSpan[]
  ranges: AnalyzedRange[]
  positionSec: number
  /** Where the next chunk will be taken from. */
  cursorSec: number
  controller: AbortController
  callbacks: LiveFilterCallbacks
  durationSec: number
}

let active: Session | null = null

/**
 * Starts (or restarts) live filtering for an episode.
 *
 * Resolves once `LEAD_IN_SEC` beyond `startAtSec` is analyzed and playback can begin;
 * work continues in the background afterwards.
 */
export async function startLiveFilter(options: {
  episode: Episode
  fileKey: string
  profile: FilterProfile
  overrides: WordOverride[]
  model: string
  startAtSec: number
  callbacks: LiveFilterCallbacks
}): Promise<{ spans: FilterSpan[]; ranges: AnalyzedRange[] }> {
  const { episode, startAtSec } = options

  /**
   * Never tear down a session that is already filtering this episode.
   *
   * Restarting aborts the in-flight chunk and resumes from the last *completed* one, so
   * a chunk that takes ~45s is lost entirely if anything re-opens the episode first.
   * Tapping play twice was enough to livelock it: cancel, restart at 0, cancel, restart
   * at 0, forever, with the UI showing no progress the whole time.
   */
  if (
    active &&
    active.episode.id === episode.id &&
    active.profile.id === options.profile.id &&
    active.model === options.model &&
    !active.controller.signal.aborted
  ) {
    active.callbacks = options.callbacks
    retargetLiveFilter(startAtSec)
    return { spans: active.spans, ranges: active.ranges }
  }

  stopLiveFilter()
  const existing = await getFilterMap(episode.id)

  // Reuse work from a previous session; only the gaps need transcribing.
  const spans = existing?.status === 'failed' ? [] : (existing?.spans ?? [])
  const ranges = existing?.status === 'failed' ? [] : mergeRanges(existing?.analyzedRanges ?? [])

  const session: Session = {
    episode,
    fileKey: options.fileKey,
    profile: options.profile,
    overrides: options.overrides,
    model: options.model,
    spans,
    ranges,
    positionSec: startAtSec,
    cursorSec: analyzedUntil(ranges, startAtSec),
    controller: new AbortController(),
    callbacks: options.callbacks,
    durationSec: episode.durationSec ?? 0,
  }
  active = session

  // A publisher transcript can settle the whole episode before any ASR runs.
  const shortcut = await tryTranscriptShortcut(session)
  if (shortcut) return { spans: session.spans, ranges: session.ranges }

  if (session.profile.severities.length === 0) {
    // Filtering is off: mark the episode fully analyzed so playback is unrestricted.
    session.ranges = [{ startSec: 0, endSec: session.durationSec || Number.MAX_SAFE_INTEGER }]
    await persist(session, 'ready')
    return { spans: session.spans, ranges: session.ranges }
  }

  // Goes through the shared store so this joins the startup download rather than
  // racing it, and so progress is reported from one place.
  const unsubscribeModel = useModelStore.subscribe((state) => {
    if (state.state === 'downloading') session.callbacks.onModelProgress?.(state.fraction)
  })
  try {
    await useModelStore.getState().ensure(session.model)
  } finally {
    unsubscribeModel()
    session.callbacks.onModelProgress?.(1)
  }

  // Block only until the lead-in is covered; the rest happens while audio plays.
  const leadTarget = startAtSec + LEAD_IN_SEC
  while (
    active === session &&
    !session.controller.signal.aborted &&
    analyzedUntil(session.ranges, startAtSec) < leadTarget &&
    !reachedEnd(session)
  ) {
    await transcribeNextChunk(session)
  }

  void pump(session)
  return { spans: session.spans, ranges: session.ranges }
}

export function updatePosition(positionSec: number): void {
  if (!active) return
  active.positionSec = positionSec
  void pump(active)
}

/** Called after a seek: work resumes from wherever coverage runs out at the new spot. */
export function retargetLiveFilter(positionSec: number): void {
  if (!active) return
  active.positionSec = positionSec
  active.cursorSec = analyzedUntil(active.ranges, positionSec)
  void pump(active)
}

export function stopLiveFilter(): void {
  active?.controller.abort()
  active = null
}

export function activeEpisodeId(): string | null {
  return active?.episode.id ?? null
}

/** True when the episode is fully analyzed from the current playhead onward. */
function reachedEnd(session: Session): boolean {
  if (!session.durationSec) return false
  return session.cursorSec >= session.durationSec - 0.5
}

let pumping = false

/**
 * Keeps the frontier `TARGET_LEAD_SEC` ahead of the playhead, then idles.
 *
 * Idling is the point: without it this walks the whole episode and we are back to
 * burning battery on audio the user may never reach.
 */
async function pump(session: Session): Promise<void> {
  if (pumping || active !== session) return
  pumping = true
  try {
    while (active === session && !session.controller.signal.aborted && !reachedEnd(session)) {
      const lead = analyzedUntil(session.ranges, session.positionSec) - session.positionSec
      if (lead >= TARGET_LEAD_SEC) break
      await transcribeNextChunk(session)
    }
  } finally {
    pumping = false
  }
}

/** Rate limit for `maybeResume`. The native player reports status every 20ms. */
const RESUME_CHECK_INTERVAL_MS = 1000
let lastResumeCheck = 0

/**
 * Re-entry point for the player's periodic position updates.
 *
 * Throttled because the native player emits status roughly fifty times a second, and
 * re-evaluating the work queue at that rate is pure overhead — the cushion is measured
 * in minutes, so once a second is ample.
 */
export function maybeResume(positionSec: number): void {
  if (!active) return
  active.positionSec = positionSec

  const now = Date.now()
  if (now - lastResumeCheck < RESUME_CHECK_INTERVAL_MS) return
  lastResumeCheck = now

  const lead = analyzedUntil(active.ranges, positionSec) - positionSec
  if (lead < RESUME_LEAD_SEC) void pump(active)
}

async function transcribeNextChunk(session: Session): Promise<void> {
  // Jump over anything already covered — either transcribed earlier this session, or
  // vouched for by a publisher transcript. This is what makes cue-narrowing pay off.
  const startSec = analyzedUntil(session.ranges, session.cursorSec)
  const endSec = session.durationSec
    ? Math.min(session.durationSec, startSec + CHUNK_SEC)
    : startSec + CHUNK_SEC
  if (endSec <= startSec) {
    session.cursorSec = startSec
    return
  }

  try {
    const words = await getPlatform().transcriber.transcribe({
      episodeId: session.episode.id,
      fileKey: session.fileKey,
      model: session.model,
      windows: [{ startSec, endSec }],
      signal: session.controller.signal,
    })

    if (active !== session || session.controller.signal.aborted) return

    const compiled = compileWordlist(session.profile, session.overrides)
    const matches = matchWords(sortAndDedupe(words), compiled)
    const chunkSpans = spansFromMatches(matches, session.profile, session.durationSec || undefined)

    session.spans = normalizeSpans([...session.spans, ...chunkSpans], session.profile.mergeGapSec)
    session.ranges = mergeRanges([...session.ranges, { startSec, endSec }])
    session.cursorSec = endSec

    await persist(session, reachedEnd(session) ? 'ready' : 'partial')
    session.callbacks.onUpdate(session.spans, session.ranges)
  } catch (error) {
    if (session.controller.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    // Advance past the failed chunk rather than retrying forever; a single undecodable
    // stretch should not wedge the whole episode.
    session.cursorSec = endSec
    session.callbacks.onError(message)
  }
}

/**
 * Uses a publisher transcript when one exists.
 *
 * Word-level transcripts settle the episode outright. Cue-level ones can prove it clean,
 * which is the best possible outcome: no ASR, no wait, no battery.
 */
async function tryTranscriptShortcut(session: Session): Promise<boolean> {
  if (session.episode.transcripts.length === 0) return false

  const transcript = await fetchTranscript(session.episode.transcripts)
  if (!transcript) return false

  const compiled = compileWordlist(session.profile, session.overrides)
  const fullRange = { startSec: 0, endSec: session.durationSec || Number.MAX_SAFE_INTEGER }

  if (transcript.words && transcript.words.length > 0) {
    const matches = matchWords(sortAndDedupe(transcript.words), compiled)
    session.spans = spansFromMatches(matches, session.profile, session.durationSec || undefined)
    session.ranges = [fullRange]
    await persist(session, 'ready', 'transcript-only')
    session.callbacks.onUpdate(session.spans, session.ranges)
    return true
  }

  if (transcript.cues.length === 0) return false

  // Cue timing is far too coarse to cut a single word, but it is plenty to tell which
  // stretches are worth transcribing. Everything the transcript covers and does not
  // flag can be marked analyzed outright — no ASR, no wait, no battery.
  const flagged = transcript.cues.filter((cue) => {
    const tokens = cue.text.split(/\s+/).filter(Boolean)
    return (
      matchWords(
        tokens.map((token, index) => ({
          word: token,
          startSec: cue.startSec + index * 0.1,
          endSec: cue.startSec + (index + 1) * 0.1,
        })),
        compiled,
      ).length > 0
    )
  })

  if (flagged.length === 0) {
    session.spans = []
    session.ranges = [fullRange]
    await persist(session, 'ready', 'transcript-only')
    session.callbacks.onUpdate(session.spans, session.ranges)
    return true
  }

  // Cues do not tile the timeline exactly; small gaps between them are silence, not
  // unexamined audio, so they are absorbed rather than left as holes to transcribe.
  const covered = mergeRanges(
    transcript.cues.map((cue) => ({
      startSec: cue.startSec,
      endSec: cue.endSec + CUE_GAP_TOLERANCE_SEC,
    })),
  )
  const suspect = mergeRanges(
    flagged.map((cue) => ({
      startSec: Math.max(0, cue.startSec - CUE_WINDOW_PAD_SEC),
      endSec: cue.endSec + CUE_WINDOW_PAD_SEC,
    })),
  )

  // Analyzed = vouched for by the transcript, minus the bits that need a closer look.
  session.ranges = mergeRanges([...session.ranges, ...subtractRanges(covered, suspect)])
  await persist(session, 'partial', 'transcript-narrowed-asr')
  session.callbacks.onUpdate(session.spans, session.ranges)

  // Not done — the suspect windows still need ASR — but the chunk pump will now skip
  // straight to them, because it starts wherever coverage runs out.
  return false
}

async function persist(
  session: Session,
  status: FilterMap['status'],
  source: FilterMap['source'] = 'asr',
): Promise<void> {
  const existing = await db.filterMaps.get(session.episode.id)
  await putFilterMap({
    episodeId: session.episode.id,
    status,
    spans: session.spans,
    analyzedRanges: session.ranges,
    source: existing?.source === 'transcript-only' ? existing.source : source,
    engineVersion: ENGINE_VERSION,
    wordlistVersion: WORDLIST_VERSION,
    progress: session.durationSec
      ? Math.min(1, session.cursorSec / session.durationSec)
      : 0,
    createdAt: existing?.createdAt ?? Date.now(),
    skippedSec: totalSkippedSec(session.spans),
  })
}

export const LIVE_FILTER_TUNING = {
  LEAD_IN_SEC,
  TARGET_LEAD_SEC,
  RESUME_LEAD_SEC,
  CHUNK_SEC,
}
