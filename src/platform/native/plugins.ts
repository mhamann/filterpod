import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type { FilterSpan, TimedWord } from '@/core/types'

/**
 * Bridge definitions for the custom Kotlin plugins.
 * Implementations live in `android/app/src/main/java/app/filterpod/`.
 */

export interface FilterPlayerPlugin {
  load(options: {
    episodeId: string
    url: string
    fileKey?: string
    title: string
    artist: string
    artworkUrl?: string
    startAtSec: number
  }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  /** Live snapshot of the service, or the last journaled position if it is gone. */
  getState(): Promise<{
    running: boolean
    episodeId?: string
    state?: string
    positionSec?: number
    durationSec?: number
    skippedSec?: number
    lastSaved?: { episodeId: string; positionSec: number; updatedAt: number }
    /** True while the in-service filter engine is pumping. */
    filtering?: boolean
    /** The engine's current snapshot, when `filtering` is set. */
    filterSession?: unknown
  }>
  seek(options: { positionSec: number }): Promise<void>
  setRate(options: { rate: number }): Promise<void>
  /** Increments for the notification and lock-screen skip buttons. */
  setSkipIncrements(options: { backSec: number; forwardSec: number }): Promise<void>
  /** One crisp EFFECT_TICK, for gesture detents. */
  hapticTick(): Promise<void>
  /** Starts the in-service filter driver; the wordlist arrives pre-compiled. */
  startNativeFilter(options: {
    episodeId: string
    fileKey: string
    url?: string
    model: string
    profileId: string
    padBeforeSec: number
    padAfterSec: number
    mergeGapSec: number
    wordlist: unknown
    startAtSec: number
    durationSec: number
    engineVersion: string
    wordlistVersion: string
    seedSpans: unknown[]
    seedRanges: unknown[]
    source: string
  }): Promise<void>
  stopNativeFilter(): Promise<void>
  retargetNativeFilter(options: { positionSec: number }): Promise<void>
  /** Holds the CPU awake during a catch-up pause, so analysis can end it. */
  setCatchupHold(options: { active: boolean }): Promise<void>
  /** Spans are evaluated on a native handler, so skipping survives the screen going off. */
  setFilterSpans(options: {
    spans: FilterSpan[]
    /** Analyzed coverage, arming the native pause-at-frontier backstop. */
    analyzed?: Array<{ startSec: number; endSec: number }>
  }): Promise<void>
  release(): Promise<void>
  addListener(
    event: 'status',
    cb: (data: {
      state: string
      positionSec: number
      durationSec: number
      skippedSec: number
      buffered: number
      /** The native guard paused at the coverage edge; catch-up must engage. */
      frontierHeld?: boolean
      error?: string
    }) => void,
  ): Promise<PluginListenerHandle>
  addListener(event: 'skip', cb: (data: { span: FilterSpan }) => void): Promise<PluginListenerHandle>
  addListener(
    event: 'filterUpdate',
    cb: (data: {
      episodeId: string
      profileId: string
      spans: FilterSpan[]
      analyzedRanges: Array<{ startSec: number; endSec: number }>
      persistableRanges: Array<{ startSec: number; endSec: number }>
      durationSec: number
      source: string
      reachedEnd: boolean
    }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'filterModelProgress',
    cb: (data: { fraction: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'filterError',
    cb: (data: { message: string }) => void,
  ): Promise<PluginListenerHandle>
}

export interface DownloaderPlugin {
  start(options: { episodeId: string; url: string; fileKey: string }): Promise<void>
  cancel(options: { episodeId: string }): Promise<void>
  addListener(
    event: 'progress',
    cb: (data: {
      episodeId: string
      bytesDownloaded: number
      bytesTotal: number
      state: string
      error?: string
    }) => void,
  ): Promise<PluginListenerHandle>
}

export interface TranscriberPlugin {
  isAvailable(): Promise<{ available: boolean }>
  isModelReady(options: { model: string }): Promise<{ ready: boolean }>
  ensureModel(options: { model: string }): Promise<void>
  transcribe(options: {
    requestId: string
    episodeId: string
    fileKey: string
    url?: string
    model: string
    windows?: Array<{ startSec: number; endSec: number }>
  }): Promise<{ words: TimedWord[] }>
  cancel(options: { requestId: string }): Promise<void>
  addListener(
    event: 'modelProgress',
    cb: (data: { fraction: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'progress',
    cb: (data: { requestId: string; fraction: number }) => void,
  ): Promise<PluginListenerHandle>
}

export interface BackupDocumentsPlugin {
  save(options: {
    fileName: string
    mimeType: string
    contents: string
  }): Promise<{ cancelled: boolean }>
  open(options: { mimeTypes: string[] }): Promise<{ cancelled: boolean; contents?: string }>
}

export const FilterPlayer = registerPlugin<FilterPlayerPlugin>('FilterPlayer')
export const Downloader = registerPlugin<DownloaderPlugin>('Downloader')
export const Transcriber = registerPlugin<TranscriberPlugin>('Transcriber')
export const BackupDocuments = registerPlugin<BackupDocumentsPlugin>('BackupDocuments')
