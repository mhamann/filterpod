import type { DownloadHandle, DownloadsPlatform, FilesPlatform } from '../types'
import { resolveFetchUrl } from './http'

/**
 * Browser downloads: a streaming fetch written into OPFS.
 *
 * Chunks are streamed rather than buffered whole, since episode audio commonly runs
 * to 50-100MB. Unlike the Android impl this does not survive the tab closing.
 */
export function createWebDownloads(files: FilesPlatform): DownloadsPlatform {
  return {
    async start({ episodeId, url, fileKey, onProgress, onComplete, onError }): Promise<DownloadHandle> {
      const controller = new AbortController()

      const run = async () => {
        const response = await fetch(resolveFetchUrl(url), { signal: controller.signal })
        if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
        if (!response.body) throw new Error('download failed: no response body')

        const bytesTotal = Number(response.headers.get('content-length') ?? 0)
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytesDownloaded = 0

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          bytesDownloaded += value.byteLength
          onProgress({ episodeId, bytesDownloaded, bytesTotal })
        }

        // Completion is signalled only after the write resolves, so a record is never
        // marked downloaded while the file is still missing.
        const stored = await files.write(fileKey, new Blob(chunks as BlobPart[]))
        onComplete(stored.size)
      }

      run().catch((error) => {
        if (controller.signal.aborted) return
        onError(error instanceof Error ? error.message : String(error))
      })

      return {
        async cancel() {
          controller.abort()
          await files.delete(fileKey)
        },
      }
    },
  }
}
