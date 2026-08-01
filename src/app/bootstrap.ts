import { liveQuery } from 'dexie'
import { getPlatform } from '@/platform'
import { restoreLibraryBackupIfEmpty, writeLibraryBackup } from '@/data/backup'
import {
  getSettings,
  healEncodedTitles,
  initializeStore,
  pruneStalePreviews,
  reconcileFilterMaps,
} from '@/data/repo'
import {
  enforceStorageBudget,
  reconcileDownloads,
  setDownloadCompletionHandler,
  watchNetwork,
} from '@/features/downloads/downloadManager'
import { prefilterDownloadedBacklog, prefilterEpisode } from '@/features/filter/prefilter'
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

  // Stale service workers from old builds are evicted natively, before the WebView even
  // starts (MainActivity.evictServiceWorker) — the right side of the fence, since JS
  // running under a stale worker is the wrong bundle already. A JS-side eviction used to
  // live here too and reloaded the page when it thought it saw a registration; on some
  // launches that turned into a reload loop wearing the startup screen.

  await initializeStore()

  // Downloaded episodes are the app's real state; losing them to eviction would mean
  // re-downloading everything.
  void getPlatform().files.requestPersistence()

  watchNetwork()
  watchSkipIncrements()

  // Downloaded episodes are filtered ahead of time — at download, indoors and cool —
  // so playing one later needs no live transcription at all. See prefilter.ts for why
  // this matters (thermal throttling in a summer pocket).
  setDownloadCompletionHandler(prefilterEpisode)

  // Reconnect to playback that survived the WebView (the service outlives the page),
  // or put the last-listened episode back on screen if nothing is running. Restoring is
  // display-only — nothing is loaded or transcribed until play is pressed.
  void usePlayerStore.getState().reconnect()

  // The speech model is the one prerequisite filtering cannot start without, so it is
  // fetched in the background here rather than becoming a wall on first play.
  void prefetchModelInBackground()

  // Download records can outlive their files (OPFS eviction, cache clearing), so
  // reconcile them against what is actually on disk before anything trusts them.
  await reconcileDownloads()
  await reconcileFilterMaps()

  void (async () => {
    try {
      // WebView IndexedDB is evictable — a full phone had Chromium delete the whole
      // database. If that happened, the native-file backup puts the library back
      // before anything else runs; the refresh below then repopulates episodes.
      if (await restoreLibraryBackupIfEmpty()) {
        console.info('FilterPod: library restored from native backup')
      }
      // Old rows may hold entity-encoded titles that a 304-answering feed will never
      // re-deliver decoded; heal them in place. No-op after the first pass.
      await healEncodedTitles()
      await pruneStalePreviews()
      await refreshAndAutoDownload()
      await enforceStorageBudget()
      // After refresh, so freshly auto-downloaded episodes are already queued by the
      // completion handler and this only picks up the pre-existing backlog.
      await prefilterDownloadedBacklog()
    } catch {
      // A failed background refresh must never block the app from starting.
    } finally {
      // Mirror the (possibly just-refreshed) library back to durable storage.
      void writeLibraryBackup().catch(() => {})
    }
  })()
}
