import { useEffect, useState } from 'react'
import { getPlatform } from '@/platform'

/**
 * Artwork, cached to native files.
 *
 * Cover images were refetched from their CDNs constantly: the WebView's HTTP cache is
 * quota-managed storage, which on a full phone is evicted as casually as the IndexedDB
 * was — so tiles placeholder-flickered on every visit while a few hundred kilobytes
 * re-downloaded. Native files are durable, so each distinct artwork URL is fetched once
 * ever and served from disk after that.
 *
 * The hook resolves in three steps: an in-memory hit is synchronous (no flicker at
 * all), a disk hit swaps in after one async round-trip, and a miss shows the remote
 * URL immediately while the bytes land in the background for every later render.
 */

const resolved = new Map<string, string>()
const inflight = new Set<string>()

/**
 * djb2, hex — collisions across a few dozen artwork URLs are not a concern. The "2-"
 * versions the namespace: v1 entries were written through a text-typed fetch that
 * mangled the bytes, so every one of them is corrupt and must never be served again.
 */
function keyFor(url: string): string {
  let hash = 5381
  for (let i = 0; i < url.length; i++) hash = ((hash * 33) ^ url.charCodeAt(i)) >>> 0
  return `artwork/2-${hash.toString(36)}`
}

/** Drops a cache entry that turned out to be unrenderable, so it refills next time. */
export function invalidateArtwork(src: string): void {
  resolved.delete(src)
  void getPlatform()
    .files.delete(keyFor(src))
    .catch(() => {})
}

export function useCachedArtwork(src?: string): string | undefined {
  const [url, setUrl] = useState(() => (src ? (resolved.get(src) ?? src) : undefined))

  useEffect(() => {
    if (!src) {
      setUrl(undefined)
      return
    }
    const hit = resolved.get(src)
    setUrl(hit ?? src)
    if (hit) return

    let alive = true
    void (async () => {
      const platform = getPlatform()
      const key = keyFor(src)
      try {
        if (!(await platform.files.exists(key))) {
          if (inflight.has(src)) return
          inflight.add(src)
          try {
            const response = await platform.http.get(src)
            if (response.status !== 200) return
            await platform.files.write(key, await response.arrayBuffer())
          } finally {
            inflight.delete(src)
          }
        }
        const local = await platform.files.toWebUrl(key)
        resolved.set(src, local)
        if (alive) setUrl(local)
      } catch {
        // The remote URL is already showing; a failed cache fill costs nothing.
      }
    })()
    return () => {
      alive = false
    }
  }, [src])

  return url
}
