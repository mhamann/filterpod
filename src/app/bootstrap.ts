import { liveQuery } from 'dexie'
import { getPlatform } from '@/platform'
import {
  getSettings,
  initializeStore,
  pruneStalePreviews,
  reconcileFilterMaps,
} from '@/data/repo'
import {
  enforceStorageBudget,
  reconcileDownloads,
  watchNetwork,
} from '@/features/downloads/downloadManager'
import { refreshAndAutoDownload } from '@/features/subscriptions/service'
import { prefetchModelInBackground } from '@/features/filter/modelStore'
import { usePlayerStore } from '@/features/player/playerStore'

/**
 * Startup sequence.
 *
 * Ordered so the app is interactive as early as possible: the store and the download
 * wiring are awaited, while feed refresh and storage cleanup are fire-and-forget.
 *
 * Nothing here starts transcription. Filtering is driven entirely by pressing play —
 * see `features/filter/liveFilter.ts`.
 */
/**
 * Evicts a service worker left behind by an earlier build.
 *
 * Packaged builds no longer ship one, but any device that ran an older APK still has it
 * installed and serving a cached app shell — which means a freshly installed APK keeps
 * running the previous bundle. Unregistering is not enough on its own; its caches hold
 * the stale assets, so those go too, and the page is reloaded to pick up the real ones.
 */
async function evictStaleServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    if (registrations.length === 0) return false

    await Promise.all(registrations.map((registration) => registration.unregister()))
    if (typeof caches !== 'undefined') {
      const names = await caches.keys()
      // The transformers.js model cache is expensive to refill and is not app code.
      await Promise.all(
        names.filter((name) => name !== 'transformers-cache').map((name) => caches.delete(name)),
      )
    }
    return true
  } catch {
    return false
  }
}

/**
 * Keeps the OS media controls' skip increments in step with the setting.
 *
 * The in-app buttons read the setting on every press, but the notification and
 * lock-screen buttons live in the playback service and are driven by the OS, so the value
 * has to be pushed to them. A live query rather than a push from the settings screen:
 * the service outlives the WebView, and this way it is correct after a restart too.
 */
function watchSkipIncrements(): void {
  liveQuery(() => getSettings()).subscribe((settings) => {
    void getPlatform().player.setSkipIncrements(settings.skipBackSec, settings.skipForwardSec)
  })
}

export async function bootstrap(): Promise<void> {
  // Spotify's OAuth redirect lands on a real path with ?code=...; the router lives in
  // the hash, so the code is relayed via sessionStorage and the URL cleaned up before
  // anything else runs. Android uses a custom scheme and never passes through here.
  if (location.pathname.includes('spotify-callback')) {
    const code = new URLSearchParams(location.search).get('code')
    if (code) sessionStorage.setItem('spotify_code', code)
    history.replaceState(null, '', '/')
    location.hash = '#/import'
  }

  if (getPlatform().name === 'android' && (await evictStaleServiceWorker())) {
    // Reload once so the WebView loads assets from the APK rather than the dead cache.
    location.reload()
    // Never resolves; the reload replaces this context.
    await new Promise(() => {})
  }

  await initializeStore()

  // Downloaded episodes are the app's real state; losing them to eviction would mean
  // re-downloading everything.
  void getPlatform().files.requestPersistence()

  watchNetwork()
  watchSkipIncrements()

  // Put back whatever was being listened to, so the app opens where it was left. This
  // only restores the display state — see restoreLast; nothing is loaded or transcribed
  // until play is pressed.
  void usePlayerStore.getState().restoreLast()

  // The speech model is the one prerequisite filtering cannot start without, so it is
  // fetched in the background here rather than becoming a wall on first play.
  void prefetchModelInBackground()

  // Download records can outlive their files (OPFS eviction, cache clearing), so
  // reconcile them against what is actually on disk before anything trusts them.
  await reconcileDownloads()
  await reconcileFilterMaps()

  void (async () => {
    try {
      await pruneStalePreviews()
      await refreshAndAutoDownload()
      await enforceStorageBudget()
    } catch {
      // A failed background refresh must never block the app from starting.
    }
  })()
}
