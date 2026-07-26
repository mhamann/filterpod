/**
 * Platform abstraction.
 *
 * Every capability that differs between the browser and the packaged Android app
 * sits behind one of these interfaces. Implementations are selected once at startup
 * (see `./index.ts`). Nothing above this layer may reference Capacitor or DOM audio
 * directly — that is what keeps the whole app developable in a browser.
 */

import type { FilterSpan, TimedWord } from '@/core/types'

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface HttpRequestInit {
  headers?: Record<string, string>
  /** Conditional request validators, so feed refresh is cheap. */
  etag?: string
  lastModified?: string
  signal?: AbortSignal
}

export interface HttpPlatform {
  /**
   * Fetches a third-party URL. On Android this goes through native HTTP and is not
   * subject to CORS; in browser dev it goes through the Vite passthrough middleware.
   */
  get(url: string, init?: HttpRequestInit): Promise<HttpResponse>
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface StoredFile {
  key: string
  size: number
}

export interface FilesPlatform {
  write(key: string, data: Blob | ArrayBuffer): Promise<StoredFile>
  /** A URL the player can load — an object URL in the browser, a file URI on device. */
  toPlayableUrl(key: string): Promise<string>
  read(key: string): Promise<ArrayBuffer>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  list(prefix?: string): Promise<StoredFile[]>
  usageBytes(): Promise<number>
  /** Ask the OS not to evict our storage. Best-effort. */
  requestPersistence(): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  episodeId: string
  bytesDownloaded: number
  bytesTotal: number
}

export interface DownloadHandle {
  cancel(): Promise<void>
}

export interface DownloadsPlatform {
  /**
   * Downloads `url` to storage under `fileKey`. On Android this is a WorkManager job
   * that survives the app being backgrounded; in the browser it is a streaming fetch.
   *
   * `onComplete` fires only once the bytes are durably written and readable. It is a
   * separate callback rather than something inferred from `onProgress` reaching the
   * total, because the last chunk arrives *before* the file is written — treating that
   * as completion marks an episode ready while its audio does not yet exist on disk.
   */
  start(opts: {
    episodeId: string
    url: string
    fileKey: string
    onProgress: (p: DownloadProgress) => void
    onComplete: (bytes: number) => void
    onError: (message: string) => void
  }): Promise<DownloadHandle>
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface PlayerTrack {
  episodeId: string
  /** Local playable URL when downloaded, otherwise the remote enclosure. */
  url: string
  /**
   * Storage key of the downloaded audio, when there is one.
   *
   * The native player resolves this to an absolute path itself rather than trusting a
   * URL from the web layer. Capacitor's `Filesystem.getUri` returns a `_capacitor_file_`
   * localhost URL meant for the WebView, which ExoPlayer cannot open — it fails with an
   * opaque "Source error". Passing the key keeps path resolution on the side that owns
   * the storage, matching how the transcriber already works.
   */
  fileKey?: string
  title: string
  artist: string
  artworkUrl?: string
  durationSec?: number
}

export interface PlayerStatus {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  /** Seconds on the ORIGINAL timeline. This is what gets persisted for resume. */
  positionSec: number
  durationSec: number
  /** Seconds of flagged audio skipped so far this session. */
  skippedSec: number
  buffered: number
  error?: string
}

export interface PlayerPlatform {
  load(track: PlayerTrack, startAtSec: number): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  /** Seeks on the original timeline. */
  seek(positionSec: number): Promise<void>
  setRate(rate: number): Promise<void>
  /**
   * Installs the spans to skip. On Android these are evaluated on a native handler
   * so skipping keeps working with the screen off; the web impl uses rAF and is
   * therefore foreground-only.
   */
  setFilterSpans(spans: FilterSpan[]): Promise<void>
  onStatus(cb: (s: PlayerStatus) => void): () => void
  /** Fired as each span is skipped, for the "skipped N" UI. */
  onSkip(cb: (span: FilterSpan) => void): () => void
  release(): Promise<void>
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export interface TranscribeRequest {
  episodeId: string
  /** Local file key of the downloaded audio. Transcription requires local audio. */
  fileKey: string
  model: string
  /**
   * When set, only these windows are transcribed rather than the whole episode.
   * Populated from a publisher transcript that told us where to look.
   */
  windows?: Array<{ startSec: number; endSec: number }>
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface TranscriberPlatform {
  isAvailable(): Promise<boolean>
  /**
   * Whether the weights are already on disk, without downloading anything.
   * Lets startup decide if a background fetch is needed instead of blindly re-running
   * a ~150MB download check on every launch.
   */
  isModelReady(model: string): Promise<boolean>
  /** Downloads and caches model weights. Reports 0..1. */
  ensureModel(model: string, onProgress?: (f: number) => void): Promise<void>
  transcribe(req: TranscribeRequest): Promise<TimedWord[]>
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface Platform {
  name: 'web' | 'android'
  http: HttpPlatform
  files: FilesPlatform
  downloads: DownloadsPlatform
  player: PlayerPlatform
  transcriber: TranscriberPlatform
  /** True when playback and skipping survive the screen being off. */
  supportsBackgroundPlayback: boolean
}
