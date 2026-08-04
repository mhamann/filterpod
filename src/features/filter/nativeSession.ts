import type { AnalyzedRange, Episode, FilterMap, FilterProfile, FilterSpan } from '@/core/types'
import { analyzedSec, analyzedUntil, mergeRanges, totalSkippedSec } from '@/core/filterMath'
import { getPlatform } from '@/platform'
import type { LiveFilterPlatform, NativeFilterSession } from '@/platform/types'
import { db, type WordOverride } from '@/data/db'
import { ENGINE_VERSION, WORDLIST_VERSION } from '@/data/defaults'
import { getFilterMap, putFilterMap } from '@/data/repo'
import { compileWordlist, serializeCompiledWordlist } from './matcher'
import { computeTranscriptSeed, LIVE_FILTER_TUNING, type LiveFilterCallbacks } from './liveFilter'

/**
 * The web-side half of the native filter driver.
 *
 * The chunk pump itself lives in Kotlin, inside the playback service's process — the
 * same process, foreground standing and doze exemptions as the audio it guards, which
 * is what lets filtering continue after Android reclaims the WebView. What stays here
 * is everything that owns web-side state: compiling the wordlist, fetching publisher
 * transcripts, seeding the engine from the stored map, and mirroring the engine's
 * updates back into Dexie so the rest of the app never knows which driver ran.
 *
 * The mirror is best-effort by design: while the WebView is dead nothing persists here,
 * and the engine's own journal (live-session.json) carries the session across that gap.
 * The next start() re-adopts the running session and the first snapshot resyncs us.
 */

/**
 * Longest open() will block waiting for lead-in coverage before letting playback start.
 *
 * The TypeScript driver blocks unboundedly, but it also *is* the pump, so it knows the
 * wait ends. Here the pump is across a process boundary, and an unbounded wait on a
 * bridge event is a hang if anything eats the event. Past the cap, playback simply
 * starts against the frontier guard: the native side holds at the edge of coverage and
 * the normal catch-up machinery takes over, so the cap trades a rare longer "catching
 * up" state for the guarantee that open() always returns.
 */
const LEAD_WAIT_CAP_MS = 20_000

interface Mirror {
  episodeId: string
  profileId: string
  model: string
  spans: FilterSpan[]
  ranges: AnalyzedRange[]
  durationSec: number
  callbacks: LiveFilterCallbacks
}

let current: Mirror | null = null
let wired = false
/** Resolvers waiting for the next engine snapshot; see [waitForLeadIn]. */
let updateWaiters: Array<() => void> = []

function notifyUpdateWaiters(): void {
  const waiters = updateWaiters
  updateWaiters = []
  for (const wake of waiters) wake()
}

/** Subscribes to the engine's events once; the mirror decides what is still relevant. */
function wireListeners(liveFilter: LiveFilterPlatform): void {
  if (wired) return
  wired = true

  liveFilter.onUpdate((update) => {
    const mirror = current
    if (!mirror || mirror.episodeId !== update.episodeId) return
    mirror.spans = update.spans
    mirror.ranges = update.analyzedRanges
    if (update.durationSec > 1) mirror.durationSec = update.durationSec
    void persistFromUpdate(update)
    mirror.callbacks.onUpdate(update.spans, update.analyzedRanges)
    notifyUpdateWaiters()
  })

  liveFilter.onModelProgress((fraction) => {
    current?.callbacks.onModelProgress?.(fraction)
  })

  liveFilter.onError((message) => {
    current?.callbacks.onError(message)
  })
}

/**
 * Writes an engine snapshot to the stored filter map.
 *
 * Only `persistableRanges` — the engine reports playable coverage (which includes
 * abandoned stretches, so the playhead is not walled in) separately from honestly
 * analyzed coverage, and only the latter may outlive the session. Same rule, same
 * reasoning as the TypeScript driver's persist().
 */
async function persistFromUpdate(update: NativeFilterSession): Promise<void> {
  const existing = await db.filterMaps.get(update.episodeId)
  await putFilterMap({
    episodeId: update.episodeId,
    status: update.reachedEnd ? 'ready' : 'partial',
    spans: update.spans,
    analyzedRanges: update.persistableRanges,
    // A source label describes how the map was produced; ASR chunks must not relabel
    // a transcript-narrowed map as plain ASR.
    source:
      existing?.source && existing.source !== 'asr'
        ? existing.source
        : (update.source as FilterMap['source']),
    engineVersion: ENGINE_VERSION,
    wordlistVersion: WORDLIST_VERSION,
    profileId: update.profileId,
    progress: update.durationSec
      ? Math.min(1, analyzedSec(update.analyzedRanges) / update.durationSec)
      : 0,
    createdAt: existing?.createdAt ?? Date.now(),
    skippedSec: totalSkippedSec(update.spans),
  })
}

/** Resolves on the next engine snapshot, or after [timeoutMs] — whichever is first. */
function nextUpdate(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(timer)
      updateWaiters = updateWaiters.filter((w) => w !== done)
      resolve()
    }
    updateWaiters.push(done)
  })
}

/** Blocks until the lead-in beyond [startAtSec] is covered, bounded by the cap. */
async function waitForLeadIn(mirror: Mirror, startAtSec: number): Promise<void> {
  const target = startAtSec + LIVE_FILTER_TUNING.LEAD_IN_SEC
  const deadline = Date.now() + LEAD_WAIT_CAP_MS
  for (;;) {
    if (current !== mirror) return
    const covered = analyzedUntil(mirror.ranges, startAtSec)
    if (covered >= target) return
    if (mirror.durationSec > 0 && covered >= mirror.durationSec - 0.5) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    await nextUpdate(remaining)
  }
}

/**
 * Starts (or re-adopts) a native filter session for an episode.
 *
 * Resolves once the lead-in is covered (or the wait cap passes) and playback can begin;
 * the engine keeps working in its own process afterwards. Interface-compatible with
 * startLiveFilter, which is what lets the player store not care which driver runs.
 */
export async function startNativeSession(options: {
  episode: Episode
  fileKey: string
  profile: FilterProfile
  overrides: WordOverride[]
  model: string
  startAtSec: number
  callbacks: LiveFilterCallbacks
}): Promise<{ spans: FilterSpan[]; ranges: AnalyzedRange[] }> {
  const liveFilter = getPlatform().liveFilter
  if (!liveFilter) throw new Error('native filter driver is not available on this platform')
  wireListeners(liveFilter)

  const { episode, profile, startAtSec } = options
  const durationSec = episode.durationSec ?? 0

  if (profile.severities.length === 0) {
    // Filtering is off: no cuts, and playback unrestricted. Nothing may persist here —
    // a map claiming full coverage with no spans would be believed by the next profile
    // the show is switched to, vouching for audio nobody examined.
    current = null
    await liveFilter.stop().catch(() => {})
    return { spans: [], ranges: [{ startSec: 0, endSec: durationSec || Number.MAX_SAFE_INTEGER }] }
  }

  // Never tear down a session that is already filtering this episode under these rules.
  // The Kotlin engine enforces the same rule; going through retarget keeps the chunk
  // in flight instead of restarting it.
  if (
    current &&
    current.episodeId === episode.id &&
    current.profileId === profile.id &&
    current.model === options.model
  ) {
    current.callbacks = options.callbacks
    await liveFilter.retarget(startAtSec)
    return { spans: current.spans, ranges: current.ranges }
  }

  // Seed from the stored map, when it was built under the same rules. A map from an
  // older engine, wordlist or profile is a liability, not a head start — its coverage
  // vouches for audio these rules never examined. Discard rather than inherit.
  const stored = await getFilterMap(episode.id)
  const valid =
    stored &&
    stored.status !== 'failed' &&
    stored.engineVersion === ENGINE_VERSION &&
    stored.wordlistVersion === WORDLIST_VERSION &&
    stored.profileId === profile.id
      ? stored
      : undefined
  let seedSpans = valid?.spans ?? []
  let seedRanges = mergeRanges(valid?.analyzedRanges ?? [])
  let source: FilterMap['source'] = 'asr'

  // A publisher transcript can settle the whole episode before any ASR runs.
  const seed = await computeTranscriptSeed(episode, profile, options.overrides, durationSec).catch(
    () => null,
  )
  if (seed?.complete) {
    current = null
    await liveFilter.stop().catch(() => {})
    const existing = await db.filterMaps.get(episode.id)
    await putFilterMap({
      episodeId: episode.id,
      status: 'ready',
      spans: seed.spans,
      analyzedRanges: seed.ranges,
      source: seed.source,
      engineVersion: ENGINE_VERSION,
      wordlistVersion: WORDLIST_VERSION,
      profileId: profile.id,
      progress: 1,
      createdAt: existing?.createdAt ?? Date.now(),
      skippedSec: totalSkippedSec(seed.spans),
    })
    return { spans: seed.spans, ranges: seed.ranges }
  }
  if (seed) {
    seedRanges = mergeRanges([...seedRanges, ...seed.ranges])
    source = seed.source
  }

  const compiled = compileWordlist(profile, options.overrides)

  const mirror: Mirror = {
    episodeId: episode.id,
    profileId: profile.id,
    model: options.model,
    spans: seedSpans,
    ranges: seedRanges,
    durationSec,
    callbacks: options.callbacks,
  }
  current = mirror

  await liveFilter.start({
    episodeId: episode.id,
    fileKey: options.fileKey,
    // Used only when the episode is not on disk; the native side prefers the file.
    url: episode.audioUrl,
    model: options.model,
    profileId: profile.id,
    padBeforeSec: profile.padBeforeSec,
    padAfterSec: profile.padAfterSec,
    mergeGapSec: profile.mergeGapSec,
    wordlist: serializeCompiledWordlist(compiled),
    startAtSec,
    durationSec,
    engineVersion: ENGINE_VERSION,
    wordlistVersion: WORDLIST_VERSION,
    seedSpans,
    seedRanges,
    source,
  })

  // Block only until the lead-in is covered; the rest happens while audio plays.
  await waitForLeadIn(mirror, startAtSec)
  return { spans: mirror.spans, ranges: mirror.ranges }
}

export async function stopNativeSession(): Promise<void> {
  current = null
  const liveFilter = getPlatform().liveFilter
  if (liveFilter) await liveFilter.stop().catch(() => {})
}

export async function retargetNativeSession(positionSec: number): Promise<void> {
  if (!current) return
  await getPlatform().liveFilter?.retarget(positionSec)
}

/** Whether this page believes a native session is running. The prefilter yields to it. */
export function nativeSessionActive(): boolean {
  return current !== null
}

export function nativeSessionEpisodeId(): string | null {
  return current?.episodeId ?? null
}
