package app.filterpod

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Does a decoded window start at the second it is labelled with?
 *
 * The analyzer names every word by adding a window's start second to a time inside the
 * decoded buffer. If the buffer begins somewhere else, every span is wrong by the
 * difference — the skip fires exactly on time and cuts the wrong audio, while the word
 * plays. Nothing about that is visible from outside: the spans still arrive and the cut
 * count still looks right.
 *
 * The reference is the decoder's own un-sliced path. A window starting before
 * SLICE_SLACK_SEC skips byte-slicing entirely and decodes sequentially from the first
 * frame, which is accurate by construction; a later window goes through the byte map and
 * is the thing under test. Decoding [0,120] and [100,120] and correlating the second
 * against the tail of the first measures the difference between them, with no reference
 * outside the decoder needed.
 *
 * EMULATOR ONLY — connectedAndroidTest uninstalls the app when it finishes, which
 * deletes its data. Never point it at a device holding a real library.
 */
@RunWith(AndroidJUnit4::class)
class DecodeAlignmentTest {

    private val rate = AudioDecoder.TARGET_SAMPLE_RATE

    @Test
    fun slicedWindowStartsWhereItSaysItDoes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val source = File(context.getExternalFilesDir(null), "align-source.mp3")
        assumeTrue("push align-source.mp3 into the app's external files dir first", source.exists())

        // Sequential from the first frame: no byte map involved, accurate by construction.
        val reference = AudioDecoder.decodeWindow(source, 0.0, 120.0)
        assumeTrue("reference decode too short", reference.size >= 110 * rate)

        var worst = 0.0
        for (start in listOf(20.0, 60.0, 100.0)) {
            val window = AudioDecoder.decodeWindow(source, start, start + 10.0)
            val offset = measureOffsetSec(reference, window, expectedSec = start)
            android.util.Log.i(
                "FilterPod",
                "align: window labelled ${start}s actually starts at " +
                    "${"%.3f".format(offset + start)}s (error ${"%+.3f".format(offset)}s)",
            )
            if (abs(offset) > abs(worst)) worst = offset
        }
        android.util.Log.i("FilterPod", "align: worst error ${"%+.3f".format(worst)}s")
    }

    /**
     * The same measurement through a source that behaves like the streaming one.
     *
     * When an episode is not downloaded the decoder reads through a MediaDataSource over
     * the player's cache: it re-opens on every backward jump and returns short reads,
     * because it is a network stream underneath. This mimics both, so a decode error that
     * only appears while streaming would show up here rather than only on a phone.
     */
    @Test
    fun streamingStyleSourceAlignsToo() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.getExternalFilesDir(null), "align-source.mp3")
        assumeTrue("push align-source.mp3 into the app's external files dir first", file.exists())

        val reference = AudioDecoder.decodeWindow(file, 0.0, 120.0)
        assumeTrue("reference decode too short", reference.size >= 110 * rate)

        for (start in listOf(20.0, 60.0, 100.0)) {
            val source = ChunkedSource(file)
            val window = AudioDecoder.decodeWindow(source, "streamed", start, start + 10.0)
            val offset = measureOffsetSec(reference, window, expectedSec = start)
            android.util.Log.i(
                "FilterPod",
                "align(stream): window labelled ${start}s actually starts at " +
                    "${"%.3f".format(offset + start)}s (error ${"%+.3f".format(offset)}s), " +
                    "reopens=${source.reopens} shortReads=${source.shortReads}",
            )
        }
    }

    /** Short reads and a re-open on every backward jump, like the cache-backed source. */
    private class ChunkedSource(file: File) : android.media.MediaDataSource() {
        private val raf = java.io.RandomAccessFile(file, "r")
        private var position = -1L
        var reopens = 0
        var shortReads = 0

        override fun readAt(at: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (at >= raf.length()) return -1
            if (at != position) {
                reopens++
                raf.seek(at)
                position = at
            }
            // A network read hands back what has arrived, not what was asked for.
            val capped = minOf(size, 32 * 1024)
            if (capped < size) shortReads++
            val read = raf.read(buffer, offset, capped)
            if (read > 0) position += read
            return read
        }

        override fun getSize(): Long = raf.length()
        override fun close() = raf.close()
    }

    /**
     * Where [window] sits inside [reference], to the millisecond.
     *
     * Correlated at 1kHz rather than 16: one sample per millisecond is far finer than the
     * error being looked for, and it keeps the search cheap enough to run over two
     * minutes of audio on a device.
     */
    private fun measureOffsetSec(reference: FloatArray, window: FloatArray, expectedSec: Double): Double {
        val factor = rate / 1000
        val ref = decimate(reference, factor)
        val probe = decimate(window, factor).copyOfRange(0, minOf(2000, window.size / factor))

        var bestLag = -1
        var bestScore = Double.NEGATIVE_INFINITY
        val probeNorm = sqrt(probe.sumOf { it.toDouble() * it })
        for (lag in 0..(ref.size - probe.size)) {
            var dot = 0.0
            var energy = 0.0
            for (i in probe.indices) {
                val r = ref[lag + i].toDouble()
                dot += r * probe[i]
                energy += r * r
            }
            val score = dot / (sqrt(energy) * probeNorm + 1e-9)
            if (score > bestScore) {
                bestScore = score
                bestLag = lag
            }
        }
        // bestLag is in milliseconds; the window claims to begin at expectedSec.
        return bestLag / 1000.0 - expectedSec
    }

    private fun decimate(samples: FloatArray, factor: Int): FloatArray {
        val out = FloatArray(samples.size / factor)
        for (i in out.indices) {
            var sum = 0f
            for (j in 0 until factor) sum += samples[i * factor + j]
            out[i] = sum / factor
        }
        return out
    }
}
