import { CapacitorHttp } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import type { FilterSpan, TimedWord } from '@/core/types'
import { normalizeSpans } from '@/core/filterMath'
import type {
  DownloadHandle,
  DownloadsPlatform,
  FilesPlatform,
  HttpPlatform,
  Platform,
  PlayerPlatform,
  PlayerStatus,
  StoredFile,
  TranscriberPlatform,
} from '../types'
import { Downloader, FilterPlayer, Transcriber } from './plugins'

/** Episode audio and model weights live under this directory in app storage. */
const DATA_DIR = Directory.Data

function createNativeHttp(): HttpPlatform {
  return {
    async get(url, init = {}) {
      const headers: Record<string, string> = { ...init.headers }
      if (init.etag) headers['If-None-Match'] = init.etag
      if (init.lastModified) headers['If-Modified-Since'] = init.lastModified

      // Native HTTP is not subject to CORS, which is why no proxy ships with the app.
      const response = await CapacitorHttp.get({ url, headers, responseType: 'text' })
      const normalized: Record<string, string> = {}
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        normalized[key.toLowerCase()] = String(value)
      }

      return {
        status: response.status,
        headers: normalized,
        text: async () => String(response.data ?? ''),
        arrayBuffer: async () => new TextEncoder().encode(String(response.data ?? '')).buffer,
      }
    },
  }
}

function createNativeFiles(): FilesPlatform {
  const path = (key: string) => `filterpod/${key}`

  return {
    async write(key, data) {
      const blob = data instanceof Blob ? data : new Blob([data])
      const base64 = await blobToBase64(blob)
      await Filesystem.writeFile({
        path: path(key),
        data: base64,
        directory: DATA_DIR,
        recursive: true,
      })
      return { key, size: blob.size }
    },

    async toPlayableUrl(key) {
      // A plain file:// URI, NOT Capacitor.convertFileSrc().
      //
      // convertFileSrc rewrites paths to a localhost scheme served by Capacitor's
      // internal server for the WebView. The only consumer here is ExoPlayer, which is
      // native and cannot fetch that — it fails with "Source error" while the metadata
      // still loads, so playback looks broken for no visible reason. ExoPlayer reads
      // file:// directly.
      const { uri } = await Filesystem.getUri({ path: path(key), directory: DATA_DIR })
      return uri
    },

    async read(key) {
      const { data } = await Filesystem.readFile({ path: path(key), directory: DATA_DIR })
      return base64ToArrayBuffer(String(data))
    },

    async delete(key) {
      try {
        await Filesystem.deleteFile({ path: path(key), directory: DATA_DIR })
      } catch {
        // Already gone is fine.
      }
    },

    async exists(key) {
      try {
        await Filesystem.stat({ path: path(key), directory: DATA_DIR })
        return true
      } catch {
        return false
      }
    },

    async list(prefix = '') {
      // Files live one level down (filterpod/audio/..., filterpod/models/...), so a
      // flat readdir of `filterpod` returns *directories*, whose reported size is a few
      // KB of metadata. That made the storage meter report kilobytes for gigabytes of
      // episodes, and left the cleanup policy with nothing to act on.
      const walk = async (path: string): Promise<StoredFile[]> => {
        try {
          const { files } = await Filesystem.readdir({ path, directory: DATA_DIR })
          const out: StoredFile[] = []
          for (const entry of files) {
            const childPath = `${path}/${entry.name}`
            if (entry.type === 'directory') {
              out.push(...(await walk(childPath)))
            } else {
              // Keys are relative to `filterpod/`, matching what callers pass in.
              out.push({
                key: childPath.replace(/^filterpod\//, ''),
                size: entry.size ?? 0,
              })
            }
          }
          return out
        } catch {
          return []
        }
      }

      const all = await walk('filterpod')
      return prefix ? all.filter((file) => file.key.startsWith(prefix)) : all
    },

    async usageBytes() {
      // Episode audio only. Model weights are a fixed one-time cost the user did not
      // choose per-episode, so counting them would make the storage meter misleading.
      const files = await this.list('audio/')
      return files.reduce((sum, file) => sum + file.size, 0)
    },

    async requestPersistence() {
      // App-private storage on Android is not subject to eviction.
      return true
    },
  }
}

function createNativeDownloads(): DownloadsPlatform {
  return {
    async start({
      episodeId,
      url,
      fileKey,
      onProgress,
      onComplete,
      onError,
    }): Promise<DownloadHandle> {
      const listener = await Downloader.addListener('progress', (data) => {
        if (data.episodeId !== episodeId) return

        // The plugin emits its terminal state only after the partial file has been
        // renamed into place, so this is safe to treat as durably written.
        if (data.state === 'downloaded') {
          onComplete(data.bytesDownloaded)
          return
        }
        if (data.state === 'failed') {
          onError(data.error ?? 'download failed')
          return
        }

        onProgress({
          episodeId,
          bytesDownloaded: data.bytesDownloaded,
          bytesTotal: data.bytesTotal,
        })
      })

      await Downloader.start({ episodeId, url, fileKey })

      return {
        async cancel() {
          await Downloader.cancel({ episodeId })
          await listener.remove()
        },
      }
    },
  }
}

function createNativePlayer(): PlayerPlatform {
  let statusListeners: Array<(s: PlayerStatus) => void> = []
  let skipListeners: Array<(s: FilterSpan) => void> = []

  void FilterPlayer.addListener('status', (data) => {
    const status: PlayerStatus = {
      state: data.state as PlayerStatus['state'],
      positionSec: data.positionSec,
      durationSec: data.durationSec,
      skippedSec: data.skippedSec,
      buffered: data.buffered,
      error: data.error,
    }
    for (const listener of statusListeners) listener(status)
  })

  void FilterPlayer.addListener('skip', (data) => {
    for (const listener of skipListeners) listener(data.span)
  })

  return {
    load: (track, startAtSec) =>
      FilterPlayer.load({
        episodeId: track.episodeId,
        url: track.url,
        fileKey: track.fileKey,
        title: track.title,
        artist: track.artist,
        artworkUrl: track.artworkUrl,
        startAtSec,
      }),
    play: () => FilterPlayer.play(),
    pause: () => FilterPlayer.pause(),
    seek: (positionSec) => FilterPlayer.seek({ positionSec }),
    setRate: (rate) => FilterPlayer.setRate({ rate }),
    setFilterSpans: (spans) => FilterPlayer.setFilterSpans({ spans: normalizeSpans(spans) }),
    onStatus(cb) {
      statusListeners.push(cb)
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
    release: () => FilterPlayer.release(),
  }
}

function createNativeTranscriber(): TranscriberPlatform {
  let nextId = 0

  return {
    async isAvailable() {
      const { available } = await Transcriber.isAvailable()
      return available
    },

    async isModelReady(model) {
      const { ready } = await Transcriber.isModelReady({ model })
      return ready
    },

    async ensureModel(model, onProgress) {
      const listener = onProgress
        ? await Transcriber.addListener('modelProgress', (data) => onProgress(data.fraction))
        : null
      try {
        await Transcriber.ensureModel({ model })
      } finally {
        await listener?.remove()
      }
    },

    async transcribe(req): Promise<TimedWord[]> {
      const requestId = `t${nextId++}`
      const listener = req.onProgress
        ? await Transcriber.addListener('progress', (data) => {
            if (data.requestId === requestId) req.onProgress?.(data.fraction)
          })
        : null

      const onAbort = () => void Transcriber.cancel({ requestId })
      req.signal?.addEventListener('abort', onAbort)

      try {
        const { words } = await Transcriber.transcribe({
          requestId,
          episodeId: req.episodeId,
          fileKey: req.fileKey,
          model: req.model,
          windows: req.windows,
        })
        return words
      } finally {
        await listener?.remove()
        req.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function createNativePlatform(): Platform {
  return {
    name: 'android',
    http: createNativeHttp(),
    files: createNativeFiles(),
    downloads: createNativeDownloads(),
    player: createNativePlayer(),
    transcriber: createNativeTranscriber(),
    supportsBackgroundPlayback: true,
  }
}
