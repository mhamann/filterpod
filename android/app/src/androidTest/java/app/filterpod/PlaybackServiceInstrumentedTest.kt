package app.filterpod

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Device-level coverage for the screen-off frontier hold and resume path. */
@RunWith(AndroidJUnit4::class)
class PlaybackServiceInstrumentedTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext

    @After
    fun tearDown() {
        PlaybackService.instance?.pause()
        context.stopService(Intent(context, PlaybackService::class.java))
    }

    @Test
    @UnstableApi
    fun nativeFrontierOwnsProtectionAndResumesWithoutTheActivity() {
        val audio = silenceWav(seconds = 12)
        context.startService(Intent(context, PlaybackService::class.java))
        val service = waitForService()
        // Production uses Media3's ten-minute default. A short timeout makes this test
        // exercise our interception of that exact demotion without taking ten minutes.
        service.setForegroundServiceTimeoutMs(1_000)

        service.load(
            Uri.fromFile(audio).toString(),
            "Frontier test",
            "FilterPod",
            null,
            0,
            "frontier-test",
        )
        service.setSpans(emptyList(), listOf(0L..3_000L))
        service.play()

        waitUntil("player to start") { snapshot(service)?.state == "playing" }
        waitUntil("native frontier hold") {
            snapshot(service)?.let { it.state == "paused" && it.positionMs >= 1_500 } == true
        }
        Thread.sleep(1_500)
        assertEquals("paused", snapshot(service)?.state)

        // This is the native counterpart of a completed transcription chunk. The
        // service must leave its own hold and resume; no Activity or WebView callback is
        // involved, which is the property screen-off playback depends on.
        service.setSpans(emptyList(), listOf(0L..12_000L))
        waitUntil("frontier release") { snapshot(service)?.state == "playing" }

        val resumed = snapshot(service)
        assertNotNull(resumed)
        assertEquals("frontier-test", resumed?.episodeId)
        assertTrue((resumed?.positionMs ?: 0) >= 1_500)
    }

    private fun waitForService(): PlaybackService {
        waitUntil("playback service") { PlaybackService.instance != null }
        return requireNotNull(PlaybackService.instance)
    }

    private fun snapshot(service: PlaybackService): PlaybackService.Snapshot? {
        val latch = CountDownLatch(1)
        var result: PlaybackService.Snapshot? = null
        service.snapshot {
            result = it
            latch.countDown()
        }
        assertTrue("snapshot callback timed out", latch.await(2, TimeUnit.SECONDS))
        return result
    }

    private fun waitUntil(label: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        throw AssertionError("timed out waiting for $label")
    }

    /** A small seekable PCM source, generated locally so the test needs no network. */
    private fun silenceWav(seconds: Int): File {
        val sampleRate = 16_000
        val bytesPerSample = 2
        val dataSize = sampleRate * bytesPerSample * seconds
        val file = File(context.cacheDir, "frontier-test.wav")
        file.outputStream().buffered().use { output ->
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray())
            header.putInt(36 + dataSize)
            header.put("WAVEfmt ".toByteArray())
            header.putInt(16)
            header.putShort(1.toShort())
            header.putShort(1.toShort())
            header.putInt(sampleRate)
            header.putInt(sampleRate * bytesPerSample)
            header.putShort(bytesPerSample.toShort())
            header.putShort(16)
            header.put("data".toByteArray())
            header.putInt(dataSize)
            output.write(header.array())

            val zeros = ByteArray(8 * 1024)
            var remaining = dataSize
            while (remaining > 0) {
                val count = minOf(remaining, zeros.size)
                output.write(zeros, 0, count)
                remaining -= count
            }
        }
        return file
    }
}
