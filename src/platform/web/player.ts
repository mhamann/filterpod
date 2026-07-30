import type { FilterSpan } from '@/core/types'
import { normalizeSpans, spanAt } from '@/core/filterMath'
import type { PlayerPlatform, PlayerStatus, PlayerTrack } from '../types'
import { resolveFetchUrl } from './http'

/**
 * Browser playback on a plain HTMLAudioElement, with skipping driven by
 * requestAnimationFrame.
 *
 * This implementation is deliberately foreground-only. rAF is suspended and timers are
 * throttled once the screen is off, so flagged spans would sail straight through during
 * exactly the normal listening case. That is why the Android build puts playback in a
 * Media3 foreground service instead — see `../native/player.ts`. This impl exists so the
 * app is fully developable and testable in a browser.
 */

/** Look-ahead for a skip. Seeking slightly early beats letting a syllable through. */
const LOOKAHEAD_SEC = 0.05

export function createWebPlayer(): PlayerPlatform {
  const audio = new Audio()
  audio.preload = 'auto'
  // Not strictly needed for playback, but keeps the element usable by Web Audio later.
  audio.crossOrigin = 'anonymous'

  let spans: FilterSpan[] = []
  let statusListeners: Array<(s: PlayerStatus) => void> = []
  let skipListeners: Array<(s: FilterSpan) => void> = []
  let rafHandle = 0
  let skippedSec = 0
  let state: PlayerStatus['state'] = 'idle'
  let lastError: string | undefined
  let skipBackSec = 15
  let skipForwardSec = 30

  function status(): PlayerStatus {
    return {
      state,
      positionSec: audio.currentTime || 0,
      durationSec: Number.isFinite(audio.duration) ? audio.duration : 0,
      skippedSec,
      buffered: audio.buffered.length > 0 ? audio.buffered.end(audio.buffered.length - 1) : 0,
      error: lastError,
    }
  }

  function emit() {
    const snapshot = status()
    for (const listener of statusListeners) listener(snapshot)
  }

  /** Seeks past any span the playhead has entered. */
  function applySkips() {
    if (spans.length > 0) {
      const position = audio.currentTime + LOOKAHEAD_SEC
      const span = spanAt(spans, position)
      if (span && audio.currentTime < span.endSec) {
        skippedSec += span.endSec - audio.currentTime
        audio.currentTime = span.endSec
        for (const listener of skipListeners) listener(span)
      }
    }
    emit()
    rafHandle = requestAnimationFrame(applySkips)
  }

  /** Seeks, then resolves any span the new position lands inside. */
  function seekTo(positionSec: number) {
    audio.currentTime = Math.max(0, positionSec)
    // A scrub can land inside a flagged span; resolve it immediately rather than
    // waiting for the next frame.
    const span = spanAt(spans, audio.currentTime)
    if (span) audio.currentTime = span.endSec
    emit()
  }

  /*
   * Skip handlers for the OS media controls.
   *
   * Registered once rather than per track: the handlers read the current increments and
   * position when invoked, so re-registering on every load would only churn. Wrapped
   * because browsers throw NotSupportedError for actions they do not implement, and a
   * missing skip button is not worth failing playback over.
   */
  function installMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        seekTo(audio.currentTime - (details.seekOffset ?? skipBackSec))
      })
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        seekTo(audio.currentTime + (details.seekOffset ?? skipForwardSec))
      })
    } catch {
      // Unsupported in this browser; the in-app controls still work.
    }
  }

  installMediaSessionHandlers()

  function startLoop() {
    if (!rafHandle) rafHandle = requestAnimationFrame(applySkips)
  }

  function stopLoop() {
    if (rafHandle) cancelAnimationFrame(rafHandle)
    rafHandle = 0
  }

  audio.addEventListener('playing', () => {
    state = 'playing'
    startLoop()
    emit()
  })
  audio.addEventListener('pause', () => {
    if (state !== 'ended') state = 'paused'
    stopLoop()
    emit()
  })
  audio.addEventListener('waiting', () => {
    state = 'loading'
    emit()
  })
  audio.addEventListener('ended', () => {
    state = 'ended'
    stopLoop()
    emit()
  })
  audio.addEventListener('error', () => {
    state = 'error'
    lastError = audio.error?.message ?? 'playback failed'
    stopLoop()
    emit()
  })
  audio.addEventListener('loadedmetadata', emit)

  let loadedEpisodeId: string | undefined

  return {
    /**
     * The browser player lives and dies with the page, so a fresh page never finds it
     * running and there is no out-of-page journal to hand back — the reattach machinery
     * this serves is an Android concern.
     */
    async getState() {
      return loadedEpisodeId && state !== 'idle'
        ? { running: true, episodeId: loadedEpisodeId, ...status() }
        : { running: false }
    },

    async load(track: PlayerTrack, startAtSec: number) {
      lastError = undefined
      skippedSec = 0
      state = 'loading'
      loadedEpisodeId = track.episodeId
      // Local object URLs are already same-origin; only remote streams need the passthrough.
      audio.src = track.url.startsWith('blob:') ? track.url : resolveFetchUrl(track.url)
      audio.load()

      await new Promise<void>((resolve) => {
        const onReady = () => {
          audio.removeEventListener('loadedmetadata', onReady)
          audio.removeEventListener('error', onReady)
          resolve()
        }
        audio.addEventListener('loadedmetadata', onReady)
        audio.addEventListener('error', onReady)
      })

      if (startAtSec > 0) audio.currentTime = startAtSec

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          artwork: track.artworkUrl ? [{ src: track.artworkUrl }] : [],
        })
      }
      emit()
    },

    async play() {
      await audio.play()
      startLoop()
    },

    async pause() {
      audio.pause()
    },

    async seek(positionSec: number) {
      seekTo(positionSec)
    },

    async setRate(rate: number) {
      audio.playbackRate = rate
    },

    async setSkipIncrements(backSec: number, forwardSec: number) {
      skipBackSec = backSec
      skipForwardSec = forwardSec
    },

    async setFilterSpans(next: FilterSpan[]) {
      spans = normalizeSpans(next)
    },

    onStatus(cb) {
      statusListeners.push(cb)
      cb(status())
      return () => {
        statusListeners = statusListeners.filter((l) => l !== cb)
      }
    },

    onSkip(cb) {
      skipListeners.push(cb)
      return () => {
        skipListeners = skipListeners.filter((l) => l !== cb)
      }
    },

    async release() {
      stopLoop()
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      statusListeners = []
      skipListeners = []
      state = 'idle'
    },
  }
}
