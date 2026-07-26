import type { HttpPlatform, HttpRequestInit, HttpResponse } from '../types'

/**
 * Browser HTTP, routed through the Vite dev passthrough.
 *
 * Podcast CDNs do not send CORS headers, so a direct fetch from the page origin fails.
 * The passthrough is dev-only middleware and never ships — on Android the native impl
 * talks to the network directly. See `vite.config.ts`.
 */
function viaPassthrough(url: string): string {
  return `/__passthrough?url=${encodeURIComponent(url)}`
}

/** Same-origin and already-CORS-enabled hosts can skip the passthrough. */
function needsPassthrough(url: string): boolean {
  try {
    const target = new URL(url, location.href)
    if (target.origin === location.origin) return false
    // iTunes Search sends permissive CORS headers.
    if (target.hostname === 'itunes.apple.com') return false
    return true
  } catch {
    return false
  }
}

export function createWebHttp(): HttpPlatform {
  return {
    async get(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
      const headers: Record<string, string> = { ...init.headers }
      if (init.etag) headers['if-none-match'] = init.etag
      if (init.lastModified) headers['if-modified-since'] = init.lastModified

      const response = await fetch(needsPassthrough(url) ? viaPassthrough(url) : url, {
        headers,
        signal: init.signal,
      })

      const headerMap: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headerMap[key.toLowerCase()] = value
      })

      return {
        status: response.status,
        headers: headerMap,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
      }
    },
  }
}

/** Exported so the download impl can reuse the same passthrough decision. */
export function resolveFetchUrl(url: string): string {
  return needsPassthrough(url) ? viaPassthrough(url) : url
}
