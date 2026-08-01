import type { AnalyzedRange, Episode, FilterMap, FilterProfile, FilterSpan } from '@/core/types'
import {
  analyzedSec,
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

/**
 * Analyzed before playback is allowed to start. The wait the user actually feels.
 *
 * This is a latency budget, not an accuracy one: it is sized so that pressing play — or
 * jumping to a new spot — produces audio in a couple of seconds. Transcription runs at
 * roughly 5x realtime in the foreground on a Pixel 7 Pro, so fifteen seconds of audio
 * costs about three to transcribe. Ninety seconds here, which is what this was, cost
 * closer to thirty, and made every seek feel like the app had hung.
 *
 * A short lead-in is safe because it is only the starting cushion. The pump immediately
 * widens it toward [TARGET_LEAD_SEC] while the audio plays, and the player will not run
 * past analyzed audio in any case.
 */
const LEAD_IN_SEC = 15

/**
 * How far ahead of the playhead to stay. Work pauses once this much is buffered.
 *
 * Ten minutes, not the four it used to be, and the difference is thermal: sustained
 * whisper in a summer pocket throttles the SoC until ASR barely outruns playback
 * (measured 20x realtime cool, ~2x throttled, on the same device within an hour).
 * A thin lead under throttling means stutter at the frontier; a fat lead banked
 * while the chip is cool rides the hot stretches out entirely.
 */
const TARGET_LEAD_SEC = 600

/** Resume work when the cushion falls below this. Hysteresis, so it is not thrashing. */
const RESUME_LEAD_SEC = 150

/**
 * Largest step, used once there is a comfortable cushion. Long chunks are the most
 * efficient way to transcribe — per-call overhead is amortized over more audio — but a
 * long chunk is also the longest anyone can be made to wait for a single result.
 */
const CHUNK_SEC = 45

/**
 * Step used when there is no cushion: at a cold start, and immediately after a seek.
 *
 * Deliberately small. Nothing can play until the first chunk of a new region lands, so
 * its length *is* the time-to-first-audio; everything after it is absorbed by playback.
 */
const FIRST_CHUNK_SEC = 15

/** Step used while the cushion is still thin, trading some throughput for responsiveness. */
const RAMP_CHUNK_SEC = 30

/** Cushion above which [RAMP_CHUNK_SEC] gives way to full-size chunks. */
const RAMP_UNTIL_SEC = 60

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

/**
 * Attempts at a single chunk before the stretch is abandoned.
 *
 * There has to be a limit, and abandoning has to mean *marking it analyzed*, because the
 * player treats unanalyzed audio as impassable. A stretch that can never be transcribed
 * and is never given up on pins the playhead in front of it forever: the episode simply
 * stops, permanently, with no way for the listener to get past it.
 *
 * But abandonment is a lie told to the playhead, and it must stay contained. The first
 * shipped version retried twice with no delay — milliseconds apart, so one transient
 * network hiccup failed both — and then persisted the abandoned stretch as analyzed.
 * A real listener hit this: a streamed episode's flagged region was walled off as
 * "clean" forever and a profanity played, silently. Hence three rules now: retries are
 * spaced out so a transient has time to pass, the lie is never persisted (see
 * [persist]), and giving up is logged loudly rather than tucked into a store field the
 * UI may never show.
 */
const MAX_CHUNK_ATTEMPTS = 3

/** Wait between attempts at a failing chunk, multiplied by the attempt number. */
const RETRY_BACKOFF_MS = 2_000

/**
 * Hard ceiling on a single chunk's transcription.
 *
 * A streamed chunk's network read can hang without erroring — a dead connection just
 * blocks — and a hung chunk used to wedge the pump forever: no result, no failure, no
 * coverage updates, and the player waiting politely at the frontier for a check that
 * would never finish. The playhead looked frozen and play did nothing, which a listener
 * has no way to distinguish from a crash. Generous (a 45s chunk normally takes ~15s
 * even backgrounded), because firing early turns a slow network into false failures.
 */
const CHUNK_TIMEOUT_MS = 90_000

interface Session {
  episode: Episode
  fileKey: string
  profile: FilterProfile
  overrides: WordOverride[]
  model: string
  spans: FilterSpan[]
  ranges: AnalyzedRange[]
  positionSec: number
  controller: AbortController
  /**
   * The chunk being transcribed, so a seek can cancel it.
   *
   * Without this a jump had to wait out whatever was already running — up to fifteen
   * seconds of work on audio the listener had just navigated away from — before the new
   * position could even be started on.
   */
  chunk: { startSec: number; endSec: number; controller: AbortController } | null
  /** Failed attempts per chunk start, so a bad stretch is retried but not forever. */
  attempts: Map<number, number>
  /**
   * Stretches given up on. Included in [ranges] so the playhead is not walled in, but
   * subtracted before persisting — the next session must try them again rather than
   * inherit this session's bad luck as permanent fact.
   */
  abandoned: AnalyzedRange[]
  callbacks: LiveFilterCallbacks
  durationSec: number
}

/**
 * Where the next chunk starts: the end of contiguous coverage ahead of the playhead.
 *
 * Derived rather than carried. An independently advanced cursor could drift away from
 * the playhead — a chunk that failed advanced it past the gap it had just left behind —
 * and coverage then grew from the cursor while the playhead stayed pinned at a hole
 * nothing would ever come back to fill. Deriving it means the first thing transcribed is
 * always the audio immediately in front of the listener.
 */
function nextChunkStart(session: Session): number {
  return analyzedUntil(session.ranges, session.positionSec)
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
  const stored = await getFilterMap(episode.id)
  // A map from an older engine, wordlist or *profile* is not a head start, it is a
  // liability: v1 maps can claim coverage over audio that was never examined, and a
  // map built under another profile has different words flagged — its coverage would
  // vouch for audio this profile never looked at. Discard rather than inherit —
  // coverage rebuilds while the episode plays anyway.
  const existing =
    stored &&
    stored.engineVersion === ENGINE_VERSION &&
    stored.wordlistVersion === WORDLIST_VERSION &&
    stored.profileId === options.profile.id
      ? stored
      : undefined

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
    controller: new AbortController(),
    chunk: null,
    attempts: new Map(),
    abandoned: [],
    callbacks: options.callbacks,
    durationSec: episode.durationSec ?? 0,
  }
  active = session

  if (session.profile.severities.length === 0) {
    // Filtering is off: no cuts, and playback unrestricted. Checked before the
    // transcript shortcut, which persists — and nothing here may persist: a map
    // claiming full analyzed coverage with no spans would be believed by the next
    // profile the show is switched to, vouching for audio nobody examined.
    session.spans = []
    session.ranges = [{ startSec: 0, endSec: session.durationSec || Number.MAX_SAFE_INTEGER }]
    return { spans: session.spans, ranges: session.ranges }
  }

  // A publisher transcript can settle the whole episode before any ASR runs.
  const shortcut = await tryTranscriptShortcut(session)
  if (shortcut) return { spans: session.spans, ranges: session.ranges }

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
  console.log(`[filter] retarget position=${Math.round(positionSec)} active=${!!active}`)
  if (!active) return
  const session = active
  session.positionSec = positionSec

  // Cancel work the listener has just navigated away from. Whatever is in flight was
  // chosen for the old position; if it no longer sits in the window ahead of the new one
  // it is finishing purely to be thrown away, and nothing can start until it does.
  const chunk = session.chunk
  if (chunk && !(chunk.endSec > positionSec && chunk.startSec <= positionSec + TARGET_LEAD_SEC)) {
    chunk.controller.abort()
  }

  void pump(session)
}

export function stopLiveFilter(): void {
  active?.controller.abort()
  active = null
}

export function activeEpisodeId(): string | null {
  return active?.episode.id ?? null
}

/**
 * Corrects the session's idea of how long the episode is, from measured playback.
 *
 * Feeds lie about duration — one real episode's itunes:duration was 4.5% long. The
 * session's duration bounds where the pipeline stops and how end-of-episode is judged,
 * so a too-long value has it transcribing audio that does not exist (each attempt
 * failing, churning the retry path at the tail), and a too-short one would leave the
 * real tail unfiltered. The player's measured duration is ground truth once known.
 */
export function updateDurationSec(durationSec: number): void {
  if (!active) return
  if (durationSec > 1 && Math.abs(active.durationSec - durationSec) > 2) {
    active.durationSec = durationSec
  }
}

/** True when the episode is fully analyzed from the current playhead onward. */
function reachedEnd(session: Session): boolean {
  if (!session.durationSec) return false
  return nextChunkStart(session) >= session.durationSec - 0.5
}

let pumping = false

/**
 * Keeps the frontier `TARGET_LEAD_SEC` ahead of the playhead, then idles.
 *
 * Idling is the point: without it this walks the whole episode and we are back to
 * burning battery on audio the user may never reach.
 */
async function pump(session: Session): Promise<void> {
  // A pump already in flight will pick up the new position on its next iteration, so
  // that case is silent. A stale session is not: it means work was requested for an
  // episode nobody is listening to any more, which should not happen and is otherwise
  // indistinguishable from the pipeline simply having nothing to do.
  if (active !== session) {
    console.log('[filter] pump requested for a session that is no longer active')
    return
  }
  if (pumping) return
  pumping = true
  try {
    while (active === session && !session.controller.signal.aborted && !reachedEnd(session)) {
      const lead = analyzedUntil(session.ranges, session.positionSec) - session.positionSec
      console.log(
        `[filter] pump position=${Math.round(session.positionSec)} lead=${Math.round(lead)} ` +
          `next=${Math.round(nextChunkStart(session))} ranges=${JSON.stringify(session.ranges.map((r) => [Math.round(r.startSec), Math.round(r.endSec)]))}`,
      )
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

/**
 * How much audio to take next, scaled to the cushion already in hand.
 *
 * With no cushion the chunk length is exactly what the user is waiting through, so it
 * stays short; once playback has a comfortable buffer nobody is waiting on any single
 * result and longer chunks transcribe the same audio for less overhead. This is what
 * lets a seek into unexamined audio resume in a few seconds while steady-state playback
 * still runs at full-size chunks.
 */
function chunkLengthFor(session: Session): number {
  const lead = analyzedUntil(session.ranges, session.positionSec) - session.positionSec
  if (lead < FIRST_CHUNK_SEC) return FIRST_CHUNK_SEC
  if (lead < RAMP_UNTIL_SEC) return RAMP_CHUNK_SEC
  return CHUNK_SEC
}

async function transcribeNextChunk(session: Session): Promise<void> {
  // Starts at the frontier ahead of the playhead, so anything already covered — whether
  // transcribed earlier or vouched for by a publisher transcript — is stepped over, and
  // any hole in front of the listener is filled before work continues past it.
  const startSec = nextChunkStart(session)
  const length = chunkLengthFor(session)
  const endSec = session.durationSec
    ? Math.min(session.durationSec, startSec + length)
    : startSec + length
  if (endSec <= startSec) return

  // Chained to the session's, so stopping the session still cancels the chunk, while a
  // seek can cancel just this chunk without tearing the session down.
  const controller = new AbortController()
  const abortChunk = () => controller.abort()
  session.controller.signal.addEventListener('abort', abortChunk)
  session.chunk = { startSec, endSec, controller }

  try {
    const words = await withTimeout(
      getPlatform().transcriber.transcribe({
        episodeId: session.episode.id,
        fileKey: session.fileKey,
        // Used only when the episode is not on disk; the native side prefers the file.
        url: session.episode.audioUrl,
        model: session.model,
        windows: [{ startSec, endSec }],
        signal: controller.signal,
      }),
      CHUNK_TIMEOUT_MS,
      controller,
    )

    if (active !== session || controller.signal.aborted) return

    const compiled = compileWordlist(session.profile, session.overrides)
    const matches = matchWords(sortAndDedupe(words), compiled)
    const chunkSpans = spansFromMatches(matches, session.profile, session.durationSec || undefined)

    session.spans = normalizeSpans([...session.spans, ...chunkSpans], session.profile.mergeGapSec)
    session.ranges = mergeRanges([...session.ranges, { startSec, endSec }])
    session.attempts.delete(startSec)

    await persist(session, reachedEnd(session) ? 'ready' : 'partial')
    session.callbacks.onUpdate(session.spans, session.ranges)
  } catch (error) {
    // A chunk cancelled because the listener moved is not a failure, and must not count
    // against this stretch — the audio was never examined, and saying otherwise would
    // let a few seeks mark a region analyzed that nobody ever looked at. A watchdog
    // timeout also aborts (to discard the late result), but it IS a failure and must
    // reach the retry path, or a hung chunk would wedge silently all over again.
    const timedOut = error instanceof Error && error.message.startsWith('chunk timed out')
    if (controller.signal.aborted && !timedOut) return
    await abandonOrRetry(session, startSec, endSec, error)
  } finally {
    session.controller.signal.removeEventListener('abort', abortChunk)
    if (session.chunk?.controller === controller) session.chunk = null
  }
}

/**
 * Handles a chunk that failed to transcribe.
 *
 * Retries a couple of times — most failures here are transient — and then marks the
 * stretch analyzed so the playhead is not walled in behind it. See [MAX_CHUNK_ATTEMPTS]
 * for why giving up is the lesser evil; the error is reported either way so this is
 * never a silent hole in the filtering.
 */
async function abandonOrRetry(
  session: Session,
  startSec: number,
  endSec: number,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const attempts = (session.attempts.get(startSec) ?? 0) + 1
  session.attempts.set(startSec, attempts)
  session.callbacks.onError(message)

  if (attempts < MAX_CHUNK_ATTEMPTS) {
    // Spaced, not immediate. Back-to-back retries land inside the same transient —
    // a network blip fails all of them in milliseconds and the stretch is lost.
    await sleep(attempts * RETRY_BACKOFF_MS, session.controller.signal)
    return
  }

  console.error(
    `[filter] giving up on ${Math.round(startSec)}-${Math.round(endSec)}s after ` +
      `${attempts} attempts (${message}); it will play unfiltered this session`,
  )
  session.abandoned = mergeRanges([...session.abandoned, { startSec, endSec }])
  session.ranges = mergeRanges([...session.ranges, { startSec, endSec }])
  session.callbacks.onUpdate(session.spans, session.ranges)
}

/**
 * Rejects if [promise] outlives [ms], aborting the underlying request so a late result
 * is discarded rather than applied to a session that has moved on.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`chunk timed out after ${ms / 1000}s`))
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Abortable sleep, so stopping a session does not leave a retry timer running. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
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
  // Abandoned stretches are excluded: they are a per-session concession to keep the
  // playhead moving, not a fact about the audio. Persisting them once turned a single
  // transient failure into a region that was never examined again.
  const persistable = subtractRanges(session.ranges, session.abandoned)
  await putFilterMap({
    episodeId: session.episode.id,
    status,
    spans: session.spans,
    analyzedRanges: persistable,
    // A source label describes how the map was produced; the first ASR chunk must not
    // relabel a transcript-narrowed map as plain ASR.
    source: existing?.source && existing.source !== 'asr' ? existing.source : source,
    engineVersion: ENGINE_VERSION,
    wordlistVersion: WORDLIST_VERSION,
    profileId: session.profile.id,
    // Share of the episode actually examined, not how far the frontier has reached —
    // with cue-narrowing and abandoned stretches those are not the same number.
    progress: session.durationSec
      ? Math.min(1, analyzedSec(session.ranges) / session.durationSec)
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
  FIRST_CHUNK_SEC,
  RAMP_CHUNK_SEC,
  RAMP_UNTIL_SEC,
}
