import type { AnalyzedRange, Episode, FilterProfile, FilterSpan } from '@/core/types'
import { getPlatform } from '@/platform'
import type { WordOverride } from '@/data/db'
import {
  liveFilterActive,
  maybeResume,
  retargetLiveFilter,
  startLiveFilter,
  stopLiveFilter,
  updateDurationSec,
  type LiveFilterCallbacks,
} from './liveFilter'
import {
  nativeSessionActive,
  retargetNativeSession,
  startNativeSession,
  stopNativeSession,
} from './nativeSession'

/**
 * Picks the just-in-time filter driver for this platform.
 *
 * Two implementations exist: the TypeScript pump in liveFilter.ts (the original, and
 * still the browser's) and the Kotlin engine living inside the Android playback service
 * (which survives the WebView being reclaimed — the entire reason it exists). They obey
 * the same invariants and speak the same callback interface; everything above this
 * module calls one API and never learns which one ran.
 */

const nativeDriver = () => getPlatform().liveFilter != null

/** Starts (or re-adopts) filtering; resolves once the lead-in is covered. */
export function startFilter(options: {
  episode: Episode
  fileKey: string
  profile: FilterProfile
  overrides: WordOverride[]
  model: string
  startAtSec: number
  callbacks: LiveFilterCallbacks
}): Promise<{ spans: FilterSpan[]; ranges: AnalyzedRange[] }> {
  return nativeDriver() ? startNativeSession(options) : startLiveFilter(options)
}

export function stopFilter(): void {
  if (nativeDriver()) void stopNativeSession()
  else stopLiveFilter()
}

/** Called after a seek: work resumes from wherever coverage runs out at the new spot. */
export function retargetFilter(positionSec: number): void {
  if (nativeDriver()) void retargetNativeSession(positionSec)
  else retargetLiveFilter(positionSec)
}

/**
 * The player's periodic position report. Feeds the TypeScript pump's wake-up check;
 * the native engine gets position straight from the service's own ticker, so there is
 * nothing to forward — sending it across the bridge again would just be chatter.
 */
export function reportPosition(positionSec: number): void {
  if (!nativeDriver()) maybeResume(positionSec)
}

/** The player's measured duration, ground truth over what the feed claimed. */
export function reportDuration(durationSec: number): void {
  // The native engine measures duration off the same ExoPlayer the ticker reads.
  if (!nativeDriver()) updateDurationSec(durationSec)
}

/**
 * Whether either driver currently owns the transcriber. The prefilter yields to it.
 *
 * On the native driver this asks the engine itself, not just this page's mirror of it:
 * the engine outlives the WebView, so right after a reload there can be a session
 * pumping that no web-side state knows about yet — and the prefilter grabbing the
 * (serialized) transcription lane then would starve the frontier ahead of a listener.
 */
export async function filterPipelineActive(): Promise<boolean> {
  if (!nativeDriver()) return liveFilterActive()
  if (nativeSessionActive()) return true
  return getPlatform().liveFilter?.isEngineActive() ?? false
}
