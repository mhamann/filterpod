/** Whisper is trained on 16kHz mono, so everything is resampled to that. */
export const TARGET_SAMPLE_RATE = 16_000

/**
 * Decodes compressed audio straight to 16kHz mono PCM.
 *
 * The important detail is that decoding happens on an OfflineAudioContext already
 * running at 16kHz: `decodeAudioData` resamples to the context's rate as it decodes,
 * so the full-rate signal is never materialised. Decoding at the source rate first and
 * resampling afterwards allocates roughly 800MB for a 38-minute stereo episode, which
 * on desktop stalls and on a phone would simply be killed.
 */
export async function decodeToMono16k(data: ArrayBuffer): Promise<Float32Array> {
  // Length is a required constructor argument but is irrelevant for decoding.
  const context = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE)
  const decoded = await context.decodeAudioData(data.slice(0))

  if (decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0)
  }

  // Downmix in place rather than through a second render pass.
  const left = decoded.getChannelData(0)
  const mono = new Float32Array(left.length)
  mono.set(left)
  for (let channel = 1; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel)
    for (let i = 0; i < mono.length; i++) mono[i] += samples[i]
  }
  const scale = 1 / decoded.numberOfChannels
  for (let i = 0; i < mono.length; i++) mono[i] *= scale

  return mono
}

/** Slices a window out of 16kHz PCM, clamped to the buffer. */
export function sliceWindow(pcm: Float32Array, startSec: number, endSec: number): Float32Array {
  const start = Math.max(0, Math.floor(startSec * TARGET_SAMPLE_RATE))
  const end = Math.min(pcm.length, Math.ceil(endSec * TARGET_SAMPLE_RATE))
  return pcm.slice(start, end)
}
