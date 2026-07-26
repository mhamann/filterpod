import { Capacitor } from '@capacitor/core'
import type { Platform } from './types'
import { createWebHttp } from './web/http'
import { createWebFiles } from './web/files'
import { createWebDownloads } from './web/downloads'
import { createWebPlayer } from './web/player'
import { createWebTranscriber } from './web/transcriber'
import { createNativePlatform } from './native'

export * from './types'

/**
 * Selects the platform implementation once, at startup.
 *
 * Nothing above this module should branch on the runtime again — if a capability
 * differs between browser and device, it belongs behind one of the platform
 * interfaces rather than in a call-site check.
 */
let platform: Platform | null = null

function createWebPlatform(): Platform {
  const files = createWebFiles()
  return {
    name: 'web',
    http: createWebHttp(),
    files,
    downloads: createWebDownloads(files),
    player: createWebPlayer(),
    transcriber: createWebTranscriber(files),
    // rAF is suspended with the screen off, so web skipping is foreground-only.
    supportsBackgroundPlayback: false,
  }
}

export function getPlatform(): Platform {
  if (!platform) {
    platform = Capacitor.isNativePlatform() ? createNativePlatform() : createWebPlatform()
  }
  return platform
}
