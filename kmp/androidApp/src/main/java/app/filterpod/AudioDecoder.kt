package app.filterpod

import android.media.MediaCodec
import android.media.MediaDataSource
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
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
     * Slack decoded before the requested start when byte-slicing, absorbing the frame
     * snap and the decoder warming up. Trimmed off the output by the ordinary path.
     */
    private const val SLICE_SLACK_SEC = 1.0

    /**
     * Decodes the region of [file] between [startSec] and [endSec] to 16kHz mono PCM.
     * A null range decodes from the start, bounded by [MAX_WINDOW_SEC].
     */
    fun decodeWindow(file: File, startSec: Double?, endSec: Double?): FloatArray {
        val raf = RandomAccessFile(file, "r")
        return raf.use {
            decodeWindowAligned(FileSource(raf), file.length(), file.name, startSec, endSec)
        }
    }

    /**
     * Same, for audio that is being streamed rather than downloaded.
     *
     * [source] is backed by the same cache the player streams through, so this decodes
     * bytes that have usually already been fetched, and blocks to fetch the ones that
     * have not — the caller sees an ordinary seekable file either way.
     */
    fun decodeWindow(
        source: MediaDataSource,
        label: String,
        startSec: Double?,
        endSec: Double?,
    ): FloatArray = decodeWindowAligned(source, source.size, label, startSec, endSec)

    /**
     * Window decode with sample-accurate alignment for MP3.
     *
     * MediaExtractor seeks MP3 by byte estimation and ignores the Xing/Info header, so
     * `seekTo(t)` can land seconds away from t — on a real 94-minute episode it landed
     * eight seconds late, the analyzer transcribed the wrong stretch, and a flagged word
     * played unfiltered while its region was recorded as clean. Playback does not drift
     * this way (a sequential decode is sample-accurate), so the analyzer and the player
     * disagreed about where in the audio a given second was.
     *
     * So for MP3 the extractor never seeks at all. The Xing/Info header is parsed here —
     * exact frame and byte counts — a byte offset is computed for the requested start,
     * and the extractor is handed a slice that begins at that byte. Its timeline then
     * starts at a position we know precisely, to within one frame (~26ms). Formats with
     * real sample tables (M4A) keep the extractor's own seeking, which is accurate.
     */
    private fun decodeWindowAligned(
        source: MediaDataSource,
        sizeBytes: Long,
        label: String,
        startSec: Double?,
        endSec: Double?,
    ): FloatArray {
        val from = startSec ?: 0.0
        val to = min(endSec ?: (from + MAX_WINDOW_SEC), from + MAX_WINDOW_SEC)

        val map = if (sizeBytes > 0) Mp3Map.parse(source, sizeBytes) else null
        if (map == null || from < SLICE_SLACK_SEC) {
            // Not MP3, unparseable, or a window at the very start (where estimated
            // seeking cannot be far off because there is nowhere to drift to).
            val extractor = MediaExtractor()
            extractor.setDataSource(source)
            return decodeWindow(extractor, label, startSec, endSec)
        }

        val sliceStartByte = map.byteAt(from - SLICE_SLACK_SEC)
        val sliceEndByte = min(sizeBytes, map.byteAt(to + SLICE_SLACK_SEC))
        // The exact second the slice begins at, from the same map that chose the byte.
        val sliceStartSec = map.secAt(sliceStartByte)

        val extractor = MediaExtractor()
        extractor.setDataSource(SlicedSource(source, sliceStartByte, sliceEndByte - sliceStartByte))
        return decodeWindow(extractor, label, from - sliceStartSec, to - sliceStartSec)
    }

    /** A byte-range view of another source, so the extractor's timeline starts inside it. */
    private class SlicedSource(
        private val inner: MediaDataSource,
        private val startByte: Long,
        private val length: Long,
    ) : MediaDataSource() {
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (position >= length) return -1
            val clamped = min(size.toLong(), length - position).toInt()
            return inner.readAt(startByte + position, buffer, offset, clamped)
        }
        override fun getSize(): Long = length
        override fun close() {
            // The inner source outlives the slice; its owner closes it.
        }
    }

    /** A file as a MediaDataSource, so local and streamed audio share one decode path. */
    private class FileSource(private val raf: RandomAccessFile) : MediaDataSource() {
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            raf.seek(position)
            return raf.read(buffer, offset, size)
        }
        override fun getSize(): Long = raf.length()
        override fun close() {
            // Owned by the caller's `use` block.
        }
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
     * The exact byte-to-time mapping of an MP3, from its Xing/Info header.
     *
     * A LAME-style header carries the total frame and byte counts of the audio, which
     * gives the true duration (frames x samples-per-frame / sample rate) and an exact
     * average byte rate. For CBR files — which podcasts overwhelmingly are — the linear
     * map is then accurate to within a frame. This is the same data ffprobe trusts, and
     * the data MediaExtractor ignores when it seeks.
     */
    private class Mp3Map(
        private val musicStartByte: Long,
        private val musicBytes: Long,
        val durationSec: Double,
    ) {
        fun byteAt(sec: Double): Long =
            musicStartByte + ((sec.coerceIn(0.0, durationSec) / durationSec) * musicBytes).toLong()

        fun secAt(byte: Long): Double =
            ((byte - musicStartByte).toDouble() / musicBytes) * durationSec

        companion object {
            private val MPEG1_BITRATES =
                intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
            private val MPEG2_BITRATES =
                intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
            private val MPEG1_RATES = intArrayOf(44100, 48000, 32000)

            fun parse(source: MediaDataSource, sizeBytes: Long): Mp3Map? {
                val head = ByteArray(256 * 1024)
                val read = source.readAt(0, head, 0, head.size)
                if (read < 128) return null

                // Skip an ID3v2 tag: 'ID3' + version + flags + syncsafe size.
                var offset = 0
                if (head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() &&
                    head[2] == '3'.code.toByte()
                ) {
                    val size = ((head[6].toInt() and 0x7f) shl 21) or
                        ((head[7].toInt() and 0x7f) shl 14) or
                        ((head[8].toInt() and 0x7f) shl 7) or
                        (head[9].toInt() and 0x7f)
                    offset = 10 + size
                }
                if (offset >= read - 4) return null

                // Find the first real frame header, verified by a second frame where the
                // first says it should be — a lone sync pattern happens by chance in tags.
                var frameStart = -1
                var i = offset
                while (i < min(read - 4, offset + 64 * 1024)) {
                    val header = frameHeaderAt(head, i)
                    if (header != null) {
                        val next = i + header.frameLength
                        if (next + 4 > read || frameHeaderAt(head, next) != null) {
                            frameStart = i
                            break
                        }
                    }
                    i++
                }
                if (frameStart < 0) return null
                val frame = frameHeaderAt(head, frameStart)!!

                // Xing/Info sits after the side info of that first frame.
                val tagOffset = frameStart + 4 + frame.sideInfoBytes
                if (tagOffset + 16 > read) return null
                val tag = String(head, tagOffset, 4, Charsets.US_ASCII)
                if (tag != "Xing" && tag != "Info") return null

                val flags = beInt(head, tagOffset + 4)
                var cursor = tagOffset + 8
                var frames = -1L
                var bytes = -1L
                if (flags and 1 != 0) {
                    frames = beInt(head, cursor).toLong(); cursor += 4
                }
                if (flags and 2 != 0) {
                    bytes = beInt(head, cursor).toLong()
                }
                if (frames <= 0) return null

                val durationSec = frames * frame.samplesPerFrame.toDouble() / frame.sampleRate
                if (durationSec < 1) return null
                val musicBytes = if (bytes > 0) bytes else sizeBytes - frameStart
                return Mp3Map(frameStart.toLong(), musicBytes, durationSec)
            }

            private fun beInt(data: ByteArray, at: Int): Int =
                ((data[at].toInt() and 0xff) shl 24) or
                    ((data[at + 1].toInt() and 0xff) shl 16) or
                    ((data[at + 2].toInt() and 0xff) shl 8) or
                    (data[at + 3].toInt() and 0xff)

            private class FrameHeader(
                val frameLength: Int,
                val samplesPerFrame: Int,
                val sampleRate: Int,
                val sideInfoBytes: Int,
            )

            private fun frameHeaderAt(data: ByteArray, at: Int): FrameHeader? {
                if (at + 4 > data.size) return null
                val b1 = data[at].toInt() and 0xff
                val b2 = data[at + 1].toInt() and 0xff
                val b3 = data[at + 2].toInt() and 0xff
                val b4 = data[at + 3].toInt() and 0xff
                if (b1 != 0xff || (b2 and 0xe0) != 0xe0) return null

                val version = (b2 shr 3) and 3       // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
                val layer = (b2 shr 1) and 3         // 1 = Layer III
                if (version == 1 || layer != 1) return null

                val bitrateIndex = (b3 shr 4) and 15
                val rateIndex = (b3 shr 2) and 3
                if (bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3) return null

                val mpeg1 = version == 3
                val bitrate = (if (mpeg1) MPEG1_BITRATES else MPEG2_BITRATES)[bitrateIndex] * 1000
                val sampleRate = MPEG1_RATES[rateIndex] / when (version) {
                    3 -> 1
                    2 -> 2
                    else -> 4
                }
                val samplesPerFrame = if (mpeg1) 1152 else 576
                val padding = (b3 shr 1) and 1
                val frameLength = samplesPerFrame / 8 * bitrate / sampleRate + padding
                if (frameLength < 24) return null

                val mono = ((b4 shr 6) and 3) == 3
                val sideInfoBytes = when {
                    mpeg1 && mono -> 17
                    mpeg1 -> 32
                    mono -> 9
                    else -> 17
                }
                return FrameHeader(frameLength, samplesPerFrame, sampleRate, sideInfoBytes)
            }
        }
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
