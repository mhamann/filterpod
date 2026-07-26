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
  seek(options: { positionSec: number }): Promise<void>
  setRate(options: { rate: number }): Promise<void>
  /** Spans are evaluated on a native handler, so skipping survives the screen going off. */
  setFilterSpans(options: { spans: FilterSpan[] }): Promise<void>
  release(): Promise<void>
  addListener(
    event: 'status',
    cb: (data: {
      state: string
      positionSec: number
      durationSec: number
      skippedSec: number
      buffered: number
      error?: string
    }) => void,
  ): Promise<PluginListenerHandle>
  addListener(event: 'skip', cb: (data: { span: FilterSpan }) => void): Promise<PluginListenerHandle>
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

export const FilterPlayer = registerPlugin<FilterPlayerPlugin>('FilterPlayer')
export const Downloader = registerPlugin<DownloaderPlugin>('Downloader')
export const Transcriber = registerPlugin<TranscriberPlugin>('Transcriber')
