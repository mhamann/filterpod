package app.filterpod

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Decodes compressed episode audio to the 16kHz mono float PCM Whisper expects.
 *
 * Everything here is sized up front and written into primitive `FloatArray`s. An earlier
 * version accumulated samples in an `ArrayList<Float>`, which boxes every sample into a
 * `java.lang.Float` — roughly 16 bytes each instead of 4, plus a full array copy on every
 * growth step. That reliably ran the app out of heap mid-transcription:
 *
 *     java.lang.OutOfMemoryError: Failed to allocate a 65610016 byte allocation
 *         at java.util.ArrayList.add(ArrayList.java:504)
 *         at app.filterpod.AudioDecoder.appendMonoFloats
 *
 * Decoding is also hard-bounded by the requested window. A decoder can emit slightly more
 * than asked for — `SEEK_TO_CLOSEST_SYNC` lands on the nearest sync frame, which may be
 * seconds earlier — so the bound cannot rely on the input loop stopping at the right
 * moment. It is enforced on the output side, by capacity.
 */
object AudioDecoder {

    const val TARGET_SAMPLE_RATE = 16_000

    /**
     * Ceiling on a single decode, so a bad or missing window can never exhaust the heap.
     *
     * Live filtering asks for 45s at a time, so this is generous headroom rather than a
     * constraint. Sizing matters: at 48kHz stereo this bounds the buffer at ~23MB, where
     * a ten-minute window would have been ~115MB — enough to OOM on its own.
     */
    private const val MAX_WINDOW_SEC = 120.0

    /**
     * Decodes the region of [file] between [startSec] and [endSec] to 16kHz mono PCM.
     * A null range decodes from the start, bounded by [MAX_WINDOW_SEC].
     */
    fun decodeWindow(file: File, startSec: Double?, endSec: Double?): FloatArray {
        val extractor = MediaExtractor()
        extractor.setDataSource(file.path)
        return decodeWindow(extractor, file.name, startSec, endSec)
    }

    /**
     * Same, for audio that is being streamed rather than downloaded.
     *
     * [source] is backed by the same cache the player streams through, so this decodes
     * bytes that have usually already been fetched, and blocks to fetch the ones that
     * have not — the caller sees an ordinary seekable file either way.
     */
    fun decodeWindow(
        source: android.media.MediaDataSource,
        label: String,
        startSec: Double?,
        endSec: Double?,
    ): FloatArray {
        val extractor = MediaExtractor()
        extractor.setDataSource(source)
        return decodeWindow(extractor, label, startSec, endSec)
    }

    private fun decodeWindow(
        extractor: MediaExtractor,
        label: String,
        startSec: Double?,
        endSec: Double?,
    ): FloatArray {
        val trackIndex = (0 until extractor.trackCount).firstOrNull { index ->
            extractor.getTrackFormat(index)
                .getString(MediaFormat.KEY_MIME)
                ?.startsWith("audio/") == true
        } ?: run {
            extractor.release()
            throw IllegalStateException("no audio track in $label")
        }

        extractor.selectTrack(trackIndex)
        val format = extractor.getTrackFormat(trackIndex)
        val sourceRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val mime = format.getString(MediaFormat.KEY_MIME)!!

        val from = startSec ?: 0.0
        val to = min(endSec ?: (from + MAX_WINDOW_SEC), from + MAX_WINDOW_SEC)
        val windowSec = (to - from).coerceAtLeast(0.0)
        if (windowSec <= 0.0) {
            extractor.release()
            return FloatArray(0)
        }

        val fromUs = (from * 1_000_000).toLong()
        val toUs = (to * 1_000_000).toLong()
        extractor.seekTo(fromUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

        // Sized from the window, with a little slack for decoder overshoot. This is the
        // whole memory budget for the decode: 45s at 48kHz is ~8.6MB, not hundreds.
        val capacity = ceil(windowSec * sourceRate).toInt() + sourceRate
        val decoded = FloatArray(capacity)
        var written = 0

        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(format, null, null, 0)
        codec.start()

        val bufferInfo = MediaCodec.BufferInfo()
        var sawInputEnd = false
        var sawOutputEnd = false

        try {
            while (!sawOutputEnd && written < capacity) {
                if (!sawInputEnd) {
                    val inputIndex = codec.dequeueInputBuffer(10_000)
                    if (inputIndex >= 0) {
                        val inputBuffer = codec.getInputBuffer(inputIndex)!!
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        if (sampleSize < 0 || extractor.sampleTime > toUs) {
                            codec.queueInputBuffer(
                                inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                            )
                            sawInputEnd = true
                        } else {
                            codec.queueInputBuffer(
                                inputIndex, 0, sampleSize, extractor.sampleTime, 0
                            )
                            extractor.advance()
                        }
                    }
                }

                val outputIndex = codec.dequeueOutputBuffer(bufferInfo, 10_000)
                if (outputIndex >= 0) {
                    if (bufferInfo.size > 0) {
                        written += appendMonoFloats(
                            buffer = codec.getOutputBuffer(outputIndex)!!,
                            info = bufferInfo,
                            channels = channels,
                            sourceRate = sourceRate,
                            fromUs = fromUs,
                            out = decoded,
                            offset = written,
                        )
                    }
                    codec.releaseOutputBuffer(outputIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                        sawOutputEnd = true
                    }
                }
            }
        } finally {
            codec.stop()
            codec.release()
            extractor.release()
        }

        val filled = if (written == capacity) decoded else decoded.copyOf(written)
        return resample(filled, sourceRate, TARGET_SAMPLE_RATE)
    }

    /**
     * Converts 16-bit PCM to float, downmixes to mono, and writes into [out] at [offset].
     * Returns how many frames were written.
     *
     * Frames before [fromUs] are discarded: the seek lands on the nearest sync frame,
     * which can be seconds ahead of where we actually want to start, and keeping them
     * would shift every word timing in the window.
     */
    private fun appendMonoFloats(
        buffer: ByteBuffer,
        info: MediaCodec.BufferInfo,
        channels: Int,
        sourceRate: Int,
        fromUs: Long,
        out: FloatArray,
        offset: Int,
    ): Int {
        buffer.position(info.offset)
        buffer.limit(info.offset + info.size)
        val shorts = buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()

        val frameCount = shorts.remaining() / channels
        // How many frames at the head of this buffer precede the requested start.
        val skipFrames = if (info.presentationTimeUs >= fromUs) {
            0
        } else {
            min(
                frameCount.toLong(),
                (fromUs - info.presentationTimeUs) * sourceRate / 1_000_000,
            ).toInt()
        }

        var written = 0
        val scale = 1f / channels
        for (frame in skipFrames until frameCount) {
            val target = offset + written
            if (target >= out.size) break
            var sum = 0f
            for (channel in 0 until channels) {
                sum += shorts.get(frame * channels + channel) / 32768f
            }
            out[target] = sum * scale
            written++
        }
        return written
    }

    /**
     * Linear resampling to the target rate.
     *
     * Linear rather than a windowed-sinc filter: Whisper's own front end is a mel
     * spectrogram that discards the high-frequency detail a better filter would
     * preserve, so the extra cost buys nothing measurable in word timings.
     */
    private fun resample(input: FloatArray, fromRate: Int, toRate: Int): FloatArray {
        if (input.isEmpty()) return FloatArray(0)
        if (fromRate == toRate) return input

        val ratio = fromRate.toDouble() / toRate
        val outputLength = (input.size / ratio).roundToInt()
        val output = FloatArray(outputLength)

        for (i in 0 until outputLength) {
            val exact = i * ratio
            val lower = exact.toInt()
            val upper = min(lower + 1, input.size - 1)
            val fraction = (exact - lower).toFloat()
            output[i] = input[lower] * (1 - fraction) + input[upper] * fraction
        }
        return output
    }
}
