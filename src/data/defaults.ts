import type { FilterProfile, Settings } from '@/core/types'

/**
 * Built-in filter profiles.
 *
 * Padding is deliberately asymmetric and generous. whisper.cpp word timestamps carry
 * roughly 100-400ms of error, and the failure that matters is clipping the front of a
 * flagged word — so we pad more after than before and accept losing a sliver of clean
 * audio around each skip.
 */
export const DEFAULT_PROFILES: FilterProfile[] = [
  {
    id: 'family',
    name: 'Family',
    severities: ['mild', 'moderate', 'strong'],
    categories: ['profanity', 'sexual', 'slur', 'blasphemy', 'scatological', 'custom'],
    padBeforeSec: 0.22,
    padAfterSec: 0.32,
    mergeGapSec: 0.6,
  },
  {
    id: 'standard',
    name: 'Standard',
    // `scatological` belongs here: it covers "fuvg" and its compounds, which are the
    // most common moderate profanity in podcast speech. Omitting it would make the
    // default profile quietly useless. Only `blasphemy` is left to Family.
    severities: ['moderate', 'strong'],
    categories: ['profanity', 'sexual', 'slur', 'scatological', 'custom'],
    padBeforeSec: 0.2,
    padAfterSec: 0.3,
    mergeGapSec: 0.45,
  },
  {
    id: 'strong-only',
    name: 'Strong only',
    severities: ['strong'],
    categories: ['profanity', 'sexual', 'slur', 'scatological', 'custom'],
    padBeforeSec: 0.18,
    padAfterSec: 0.28,
    mergeGapSec: 0.35,
  },
  {
    id: 'off',
    name: 'Off',
    severities: [],
    categories: [],
    padBeforeSec: 0,
    padAfterSec: 0,
    mergeGapSec: 0,
  },
]

export const DEFAULT_SETTINGS: Settings = {
  activeFilterProfileId: 'standard',
  playbackRate: 1,
  skipForwardSec: 30,
  skipBackSec: 15,
  completionThresholdSec: 30,
  autoDownloadOnWifiOnly: true,
  maxStorageBytes: 4 * 1024 * 1024 * 1024,
  /**
   * base.en, measured at ~2.7x realtime on a Pixel 7 Pro — comfortably ahead of
   * playback, so the extra accuracy over tiny.en is free.
   *
   * It was not always: the same model ran at 0.56x until two changes landed together.
   * Quantized (q5_1) weights instead of fp16, and capping whisper at 4 threads instead
   * of 7 — ggml waits for every thread each layer, so scheduling work onto a phone's
   * little cores made it slower, not faster. Together, a 4.8x speedup.
   */
  whisperModel: 'base.en',
  theme: 'dark',
}

/**
 * Bumping either constant invalidates existing filter maps so they regenerate,
 * rather than silently serving results from an older model or wordlist.
 */
// v3: MP3 windows are byte-sliced from the Xing/Info map rather than extractor-seeked.
// Maps written by v1 (persisted abandonment) or v2 (mis-seeking decoder) can both claim
// coverage over audio that was never examined at the labeled position; regenerate all.
export const ENGINE_VERSION = '3'
export const WORDLIST_VERSION = '1'
