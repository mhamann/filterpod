import type { TimedWord } from '@/core/types'
import type { FilesPlatform, TranscribeRequest, TranscriberPlatform } from '../types'
import { decodeToMono16k, sliceWindow } from './audioDecode'
import { resolveFetchUrl } from './http'

/**
 * Browser transcription, driving the Whisper worker.
 *
 * Audio is processed in windows rather than one shot so progress is reportable and
 * memory stays bounded. When the caller supplies `windows` — meaning a publisher
 * transcript already told us where the suspect audio is — only those are transcribed,
 * which is the difference between minutes of compute and seconds.
 */

/** Window size for a full-episode pass. Large enough to amortize model overhead. */
const FULL_PASS_WINDOW_SEC = 120

/** Mirrors the worker's model map, for answering "is it cached?" without loading it. */
const MODEL_REPOS: Record<string, string> = {
  'tiny.en': 'whisper-tiny.en_timestamped',
  'base.en': 'whisper-base.en_timestamped',
  'small.en': 'whisper-small.en_timestamped',
}

type WorkerResponse =
  | { type: 'ready'; device: string }
  | { type: 'modelProgress'; fraction: number }
  | { type: 'result'; id: string; words: TimedWord[] }
  | { type: 'error'; id?: string; message: string }

export function createWebTranscriber(files: FilesPlatform): TranscriberPlatform {
  let worker: Worker | null = null
  let nextId = 0
  /** Model confirmed loaded this session, so the cache probe can be skipped. */
  let readyModel: string | null = null

  /**
   * One-entry decode cache.
   *
   * Live filtering calls transcribe() once per 45s chunk of the same episode, and
   * decoding is O(whole file) — without this, a 60-minute episode would be fully
   * decoded ~80 times over. Only one entry is kept because only one episode is ever
   * being filtered at a time, and the buffer is tens of megabytes.
   */
  let cache: { fileKey: string; pcm: Float32Array } | null = null
  let inflight: { fileKey: string; promise: Promise<Float32Array> } | null = null

  /** Reads the downloaded file, falling back to fetching the enclosure when streaming. */
  async function readLocalOrFetch(fileKey: string, url?: string): Promise<ArrayBuffer> {
    if (await files.exists(fileKey)) return files.read(fileKey)
    if (!url) throw new Error('no local audio and no stream url')
    const response = await fetch(resolveFetchUrl(url))
    if (!response.ok) throw new Error(`could not fetch audio: ${response.status}`)
    return response.arrayBuffer()
  }

  async function decodedPcm(fileKey: string, url?: string): Promise<Float32Array> {
    if (cache?.fileKey === fileKey) return cache.pcm
    // Chunks can overlap in flight; they must share one decode, not race it.
    if (inflight?.fileKey === fileKey) return inflight.promise

    const promise = (async () => {
      // Streamed episodes have nothing on disk. The browser has no equivalent of the
      // native shared cache, so this fetches the episode itself — acceptable because
      // this implementation exists to make the app developable in a browser, not to be
      // efficient on a phone.
      const data = await readLocalOrFetch(fileKey, url)
      const pcm = await decodeToMono16k(data)
      cache = { fileKey, pcm }
      return pcm
    })()

    inflight = { fileKey, promise }
    try {
      return await promise
    } finally {
      if (inflight?.fileKey === fileKey) inflight = null
    }
  }

  function getWorker(): Worker {
    if (!worker) {
      worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    }
    return worker
  }

  /** Resolves when the worker answers for this specific request id. */
  function request(
    payload: { model: string; pcm: Float32Array; offsetSec: number },
    signal?: AbortSignal,
  ): Promise<TimedWord[]> {
    const id = String(nextId++)
    const active = getWorker()

    return new Promise<TimedWord[]>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data
        if (message.type === 'result' && message.id === id) {
          cleanup()
          resolve(message.words)
        } else if (message.type === 'error' && message.id === id) {
          cleanup()
          reject(new Error(message.message))
        }
      }
      const onAbort = () => {
        cleanup()
        reject(new DOMException('transcription cancelled', 'AbortError'))
      }
      const cleanup = () => {
        active.removeEventListener('message', onMessage)
        signal?.removeEventListener('abort', onAbort)
      }

      active.addEventListener('message', onMessage)
      signal?.addEventListener('abort', onAbort)
      active.postMessage({ type: 'transcribe', id, ...payload }, [payload.pcm.buffer])
    })
  }

  return {
    async isAvailable() {
      return typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined'
    },

    async isModelReady(model) {
      // transformers.js stores weights in a Cache API bucket, so this can be answered
      // without constructing the pipeline (which would load the whole model into memory).
      if (readyModel === model) return true
      if (typeof caches === 'undefined') return false
      try {
        const cache = await caches.open('transformers-cache')
        const keys = await cache.keys()
        const repo = MODEL_REPOS[model]
        return keys.some((request) => request.url.includes(repo))
      } catch {
        return false
      }
    },

    async ensureModel(model, onProgress) {
      const active = getWorker()
      return new Promise<void>((resolve, reject) => {
        const onMessage = (event: MessageEvent<WorkerResponse>) => {
          const message = event.data
          if (message.type === 'modelProgress') onProgress?.(message.fraction)
          if (message.type === "ready") {
            readyModel = model
            active.removeEventListener("message", onMessage)
            resolve()
          }
          if (message.type === 'error' && !message.id) {
            active.removeEventListener('message', onMessage)
            reject(new Error(message.message))
          }
        }
        active.addEventListener('message', onMessage)
        active.postMessage({ type: 'ensureModel', model })
      })
    },

    async transcribe(req: TranscribeRequest): Promise<TimedWord[]> {
      const pcm = await decodedPcm(req.fileKey, req.url)
      const durationSec = pcm.length / 16_000

      const windows =
        req.windows && req.windows.length > 0
          ? req.windows
          : Array.from(
              { length: Math.ceil(durationSec / FULL_PASS_WINDOW_SEC) },
              (_, index) => ({
                startSec: index * FULL_PASS_WINDOW_SEC,
                endSec: Math.min(durationSec, (index + 1) * FULL_PASS_WINDOW_SEC),
              }),
            )

      const words: TimedWord[] = []
      for (let index = 0; index < windows.length; index++) {
        req.signal?.throwIfAborted()
        const window = windows[index]
        const chunk = sliceWindow(pcm, window.startSec, window.endSec)
        if (chunk.length === 0) continue
        const result = await request(
          { model: req.model, pcm: chunk, offsetSec: window.startSec },
          req.signal,
        )
        words.push(...result)
        req.onProgress?.((index + 1) / windows.length)
      }

      return words
    },
  }
}
