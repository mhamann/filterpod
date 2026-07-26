import { create } from 'zustand'
import { Network } from '@capacitor/network'
import { getPlatform } from '@/platform'
import { getSettings } from '@/data/repo'

/**
 * The speech model's download state, shared across the app.
 *
 * The model is ~150MB and is the one thing filtering cannot start without. Left to load
 * lazily on first play it becomes a multi-minute wall at exactly the wrong moment, so it
 * is fetched in the background at startup instead — you can subscribe, browse and
 * download while it lands.
 *
 * Everything funnels through `ensure()`, which de-duplicates: if startup began the
 * download and you then press play, the player awaits the same in-flight promise rather
 * than starting a second one.
 */

export type ModelState = 'unknown' | 'missing' | 'downloading' | 'ready' | 'failed'

interface ModelStore {
  state: ModelState
  /** 0..1 while downloading. */
  fraction: number
  error?: string
  /** Resolves once the model is on disk. Safe to call repeatedly. */
  ensure(model: string): Promise<void>
  refresh(model: string): Promise<void>
}

let inflight: { model: string; promise: Promise<void> } | null = null

export const useModelStore = create<ModelStore>((set, get) => ({
  state: 'unknown',
  fraction: 0,

  async refresh(model) {
    const ready = await getPlatform().transcriber.isModelReady(model)
    // Do not clobber a download that is already running.
    if (get().state === 'downloading') return
    set({ state: ready ? 'ready' : 'missing' })
  },

  async ensure(model) {
    if (get().state === 'ready') return
    if (inflight?.model === model) return inflight.promise

    const promise = (async () => {
      try {
        if (await getPlatform().transcriber.isModelReady(model)) {
          set({ state: 'ready', fraction: 1 })
          return
        }
        set({ state: 'downloading', fraction: 0, error: undefined })
        await getPlatform().transcriber.ensureModel(model, (fraction) =>
          set({ fraction }),
        )
        set({ state: 'ready', fraction: 1 })
      } catch (error) {
        set({
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      } finally {
        if (inflight?.model === model) inflight = null
      }
    })()

    inflight = { model, promise }
    return promise
  },
}))

/**
 * Fetches the model in the background at startup.
 *
 * Respects the Wi-Fi-only preference: a 150MB unsolicited download over cellular is
 * exactly the kind of thing that setting exists to prevent. The manual button in
 * Settings ignores it, because that is an explicit request.
 */
export async function prefetchModelInBackground(): Promise<void> {
  const settings = await getSettings()
  const store = useModelStore.getState()

  await store.refresh(settings.whisperModel)
  if (useModelStore.getState().state === 'ready') return

  if (settings.autoDownloadOnWifiOnly) {
    try {
      const status = await Network.getStatus()
      const metered =
        !status.connected ||
        (status.connectionType !== 'wifi' && status.connectionType !== 'unknown')
      if (metered) return
    } catch {
      // Connection type unknown: treat as safe rather than blocking setup forever.
    }
  }

  // Fire and forget — a failure here must never block startup, and the player will
  // retry on demand.
  void store.ensure(settings.whisperModel).catch(() => {})
}
