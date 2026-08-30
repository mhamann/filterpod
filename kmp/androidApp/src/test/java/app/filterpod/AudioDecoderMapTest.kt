package app.filterpod

import android.media.MediaDataSource
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The MP3 byte/time map, which decides where the analyzer starts reading.
 *
 * When it returns nothing the decode silently falls back to MediaExtractor's estimated
 * seeking, which on a real episode ran about two seconds off. The analyzer then wrote
 * spans two seconds late, the player cut exactly where it was told, and the flagged word
 * played anyway with clean audio removed just after it. Nothing about that failure is
 * visible from the outside — the cut count looks right — so the map returning a value at
 * all is the thing worth pinning.
 */
class AudioDecoderMapTest {

    private val sampleRate = 44_100
    private val bitrate = 192_000
    private val frameLength = 1152 / 8 * bitrate / sampleRate  // 626 bytes, MPEG1 L3
    private val bytesPerSec = bitrate / 8.0

    /** MPEG1 Layer III, 192kbps, 44.1kHz, stereo, no CRC — and no Xing header. */
    private fun cbrMp3(tagBytes: Int, frames: Int): ByteArray {
        val out = ByteArray(tagBytes + frames * frameLength)
        if (tagBytes > 0) {
            // ID3v2 header: the size is syncsafe and excludes the 10-byte header.
            val size = tagBytes - 10
            out[0] = 'I'.code.toByte(); out[1] = 'D'.code.toByte(); out[2] = '3'.code.toByte()
            out[3] = 3; out[4] = 0; out[5] = 0
            out[6] = ((size shr 21) and 0x7f).toByte()
            out[7] = ((size shr 14) and 0x7f).toByte()
            out[8] = ((size shr 7) and 0x7f).toByte()
            out[9] = (size and 0x7f).toByte()
        }
        for (f in 0 until frames) {
            val at = tagBytes + f * frameLength
            out[at] = 0xFF.toByte()
            out[at + 1] = 0xFB.toByte()   // MPEG1, Layer III, no CRC
            out[at + 2] = 0xB0.toByte()   // 192kbps, 44.1kHz, no padding
            out[at + 3] = 0x00            // stereo
        }
        return out
    }

    private fun source(data: ByteArray) = object : MediaDataSource() {
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (position >= data.size) return -1
            val n = minOf(size, data.size - position.toInt())
            System.arraycopy(data, position.toInt(), buffer, offset, n)
            return n
        }
        override fun getSize(): Long = data.size.toLong()
        override fun close() = Unit
    }

    @Test
    fun mapsCbrAudioBehindAnOversizeArtworkTag() {
        // 498KB of cover art is what the episode that exposed this actually carried —
        // comfortably past the 256KB the scan used to read, so the audio was never found.
        val tagBytes = 498_033
        val seconds = 300
        val data = cbrMp3(tagBytes, frames = seconds * sampleRate / 1152)
        val probe = AudioDecoder.mp3MapProbe(source(data), data.size.toLong(), 229.87)
        assertNotNull(probe, "no map: alignment would fall back to estimated seeking")

        val (byte, readBack) = probe
        assertEquals(tagBytes + (229.87 * bytesPerSec).toLong(), byte)
        // Round-trips: the second the slice is labelled with is the second it starts at.
        assertTrue(abs(readBack - 229.87) < 0.001, "byte $byte read back as ${readBack}s")
    }

    @Test
    fun mapIsExactAcrossTheFile() {
        val data = cbrMp3(tagBytes = 2_048, frames = 600 * sampleRate / 1152)
        val src = source(data)
        for (sec in listOf(1.0, 60.0, 233.0, 599.0)) {
            val (byte, readBack) = AudioDecoder.mp3MapProbe(src, data.size.toLong(), sec)!!
            assertEquals(2_048 + (sec * bytesPerSec).toLong(), byte, "byte for ${sec}s")
            assertTrue(abs(readBack - sec) < 0.001, "readback for ${sec}s was $readBack")
        }
    }

    @Test
    fun tinyOrHeaderlessInputYieldsNoMap() {
        assertEquals(null, AudioDecoder.mp3MapProbe(source(ByteArray(64)), 64, 0.0))
        // A tag that swallows the whole file leaves no audio to map.
        val allTag = cbrMp3(tagBytes = 4_096, frames = 0)
        assertEquals(null, AudioDecoder.mp3MapProbe(source(allTag), allTag.size.toLong(), 1.0))
    }
}
