/// <reference lib="webworker" />
/**
 * In-browser Whisper, running off the main thread.
 *
 * Uses transformers.js with the WebGPU execution provider when available and WASM
 * otherwise. WebGPU is worth the feature detection: it runs roughly 5-10x faster than
 * WASM, which is the difference between a usable background job and an unusable one.
 */

import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers'
import type { TimedWord } from '@/core/types'

type InboundMessage =
  | { type: 'ensureModel'; model: string }
  | { type: 'transcribe'; id: string; model: string; pcm: Float32Array; offsetSec: number }

type OutboundMessage =
  | { type: 'ready'; device: string }
  | { type: 'modelProgress'; fraction: number }
  | { type: 'result'; id: string; words: TimedWord[] }
  | { type: 'error'; id?: string; message: string }

const post = (message: OutboundMessage) => (self as DedicatedWorkerGlobalScope).postMessage(message)

/**
 * The `_timestamped` exports, not the plain ones.
 *
 * Word-level timestamps come from running DTW over decoder cross-attention, which
 * requires the alignment heads these variants expose. The plain exports silently
 * return segment-level timings instead — far too coarse to cut a single word.
 */
const MODEL_IDS: Record<string, string> = {
  'tiny.en': 'onnx-community/whisper-tiny.en_timestamped',
  'base.en': 'onnx-community/whisper-base.en_timestamped',
  'small.en': 'onnx-community/whisper-small.en_timestamped',
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let loadedModel: string | null = null

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

async function ensureModel(model: string) {
  if (transcriber && loadedModel === model) return

  const modelId = MODEL_IDS[model] ?? MODEL_IDS['base.en']
  const device = (await hasWebGPU()) ? 'webgpu' : 'wasm'

  transcriber = await pipeline('automatic-speech-recognition', modelId, {
    device: device as 'webgpu' | 'wasm',
    // Per-module dtypes, not a single one. A q8 decoder fails ONNX session creation
    // outright ("Subgraph output is an outer scope value") — transformers.js #1707 —
    // so the decoder is q4 while the encoder stays at full precision for accuracy.
    dtype:
      device === 'webgpu'
        ? { encoder_model: 'fp16', decoder_model_merged: 'q4f16' }
        : { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    progress_callback: (progress: { status: string; progress?: number }) => {
      if (progress.status === 'progress' && typeof progress.progress === 'number') {
        post({ type: 'modelProgress', fraction: progress.progress / 100 })
      }
    },
  })
  loadedModel = model
  post({ type: 'ready', device })
}

self.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const message = event.data
  try {
    if (message.type === 'ensureModel') {
      await ensureModel(message.model)
      return
    }

    if (message.type === 'transcribe') {
      await ensureModel(message.model)
      if (!transcriber) throw new Error('transcriber failed to initialize')

      const output = await transcriber(message.pcm, {
        // Word-level granularity is the whole point — cue-level timing is far too
        // coarse to skip a single word.
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
      })

      const chunks =
        (output as { chunks?: Array<{ text: string; timestamp: [number, number] }> }).chunks ?? []

      const words: TimedWord[] = chunks
        .filter((chunk) => chunk.timestamp?.[0] != null)
        .map((chunk) => ({
          word: chunk.text.trim(),
          startSec: chunk.timestamp[0] + message.offsetSec,
          endSec: (chunk.timestamp[1] ?? chunk.timestamp[0] + 0.3) + message.offsetSec,
        }))
        .filter((word) => word.word.length > 0)

      post({ type: 'result', id: message.id, words })
    }
  } catch (error) {
    post({
      type: 'error',
      id: message.type === 'transcribe' ? message.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
