import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The model is a ~150MB one-time download that both startup and the player can trigger.
 * The property that matters is that they share one download rather than racing.
 */

const isModelReady = vi.fn<() => Promise<boolean>>()
const ensureModelImpl = vi.fn<(model: string, onProgress?: (f: number) => void) => Promise<void>>()

vi.mock('@/platform', () => ({
  getPlatform: () => ({
    transcriber: {
      isModelReady: () => isModelReady(),
      ensureModel: (model: string, onProgress?: (f: number) => void) =>
        ensureModelImpl(model, onProgress),
    },
  }),
}))

const getSettings = vi.fn(async () => ({
  whisperModel: 'base.en',
  autoDownloadOnWifiOnly: false,
}))
vi.mock('@/data/repo', () => ({ getSettings: () => getSettings() }))

const networkStatus = vi.fn(async () => ({ connected: true, connectionType: 'wifi' }))
vi.mock('@capacitor/network', () => ({ Network: { getStatus: () => networkStatus() } }))

const { useModelStore, prefetchModelInBackground } = await import('./modelStore')

beforeEach(() => {
  useModelStore.setState({ state: 'unknown', fraction: 0, error: undefined })
  isModelReady.mockReset()
  ensureModelImpl.mockReset()
  ensureModelImpl.mockResolvedValue()
  getSettings.mockClear()
  networkStatus.mockReset()
  networkStatus.mockResolvedValue({ connected: true, connectionType: 'wifi' })
})

describe('ensure', () => {
  it('skips the download when the model is already on disk', async () => {
    isModelReady.mockResolvedValue(true)

    await useModelStore.getState().ensure('base.en')

    expect(ensureModelImpl).not.toHaveBeenCalled()
    expect(useModelStore.getState().state).toBe('ready')
  })

  it('downloads and reports progress when missing', async () => {
    isModelReady.mockResolvedValue(false)
    ensureModelImpl.mockImplementation(async (_model, onProgress) => {
      onProgress?.(0.5)
    })

    const promise = useModelStore.getState().ensure('base.en')
    await promise

    expect(useModelStore.getState().state).toBe('ready')
    expect(ensureModelImpl).toHaveBeenCalledOnce()
  })

  it('shares one download between concurrent callers', async () => {
    isModelReady.mockResolvedValue(false)
    let release: () => void = () => {}
    ensureModelImpl.mockImplementation(() => new Promise<void>((r) => (release = r)))

    // Startup and the player both ask at once.
    const a = useModelStore.getState().ensure('base.en')
    const b = useModelStore.getState().ensure('base.en')

    // The download only begins after an async readiness check, so wait for it to
    // actually start before releasing — otherwise `release` is still the no-op
    // placeholder and the promise never settles.
    await vi.waitFor(() => expect(ensureModelImpl).toHaveBeenCalled())
    release()
    await Promise.all([a, b])

    // One download, not two.
    expect(ensureModelImpl).toHaveBeenCalledOnce()
  })

  it('records failure and rejects, leaving a retry possible', async () => {
    isModelReady.mockResolvedValue(false)
    ensureModelImpl.mockRejectedValue(new Error('offline'))

    await expect(useModelStore.getState().ensure('base.en')).rejects.toThrow('offline')
    expect(useModelStore.getState().state).toBe('failed')

    // A later attempt is not blocked by the previous failure.
    ensureModelImpl.mockResolvedValue()
    await useModelStore.getState().ensure('base.en')
    expect(useModelStore.getState().state).toBe('ready')
  })
})

describe('background prefetch', () => {
  it('downloads on wifi', async () => {
    isModelReady.mockResolvedValue(false)
    await prefetchModelInBackground()
    await vi.waitFor(() => expect(ensureModelImpl).toHaveBeenCalled())
  })

  it('does nothing when the model is already present', async () => {
    isModelReady.mockResolvedValue(true)
    await prefetchModelInBackground()
    expect(ensureModelImpl).not.toHaveBeenCalled()
  })

  it('holds off on cellular when Wi-Fi-only is set', async () => {
    isModelReady.mockResolvedValue(false)
    getSettings.mockResolvedValue({ whisperModel: 'base.en', autoDownloadOnWifiOnly: true })
    networkStatus.mockResolvedValue({ connected: true, connectionType: 'cellular' })

    await prefetchModelInBackground()

    // 150MB unsolicited over cellular is exactly what that setting exists to prevent.
    expect(ensureModelImpl).not.toHaveBeenCalled()
  })

  it('downloads on cellular when Wi-Fi-only is off', async () => {
    isModelReady.mockResolvedValue(false)
    getSettings.mockResolvedValue({ whisperModel: 'base.en', autoDownloadOnWifiOnly: false })
    networkStatus.mockResolvedValue({ connected: true, connectionType: 'cellular' })

    await prefetchModelInBackground()
    await vi.waitFor(() => expect(ensureModelImpl).toHaveBeenCalled())
  })
})
