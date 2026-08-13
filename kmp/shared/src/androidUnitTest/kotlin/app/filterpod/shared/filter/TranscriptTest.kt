package app.filterpod.shared.filter

import app.filterpod.shared.model.TranscriptRef
import app.filterpod.shared.net.Http
import app.filterpod.shared.net.HttpResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TranscriptTest {

    private class FakeHttp(private val bodyByUrl: Map<String, String>) : Http {
        val requested = mutableListOf<String>()
        override suspend fun get(url: String, headers: Map<String, String>): HttpResponse {
            requested += url
            return bodyByUrl[url]
                ?.let { HttpResponse(200, emptyMap(), it.encodeToByteArray()) }
                ?: HttpResponse(404, emptyMap(), ByteArray(0))
        }
    }

    private fun vttRef(url: String) = TranscriptRef(url = url, type = "text/vtt")
    private fun srtRef(url: String) = TranscriptRef(url = url, type = "application/x-subrip")
    private fun jsonRef(url: String) = TranscriptRef(url = url, type = "application/json")

    @Test
    fun parsesVttWithHourTimestamps() = runTest {
        val vtt = """
            WEBVTT

            00:00:01.000 --> 00:00:03.500
            Hello there.

            01:02:03.250 --> 01:02:05.000
            An hour in.
        """.trimIndent()
        val http = FakeHttp(mapOf("https://example.com/t.vtt" to vtt))

        val transcript = fetchTranscript(http, listOf(vttRef("https://example.com/t.vtt")))

        assertNotNull(transcript)
        assertNull(transcript.words)
        assertEquals(2, transcript.cues.size)
        assertEquals(Cue(1.0, 3.5, "Hello there."), transcript.cues[0])
        assertEquals(3723.25, transcript.cues[1].startSec)
        assertEquals(3725.0, transcript.cues[1].endSec)
        assertEquals("An hour in.", transcript.cues[1].text)
    }

    @Test
    fun parsesVttWithoutHoursAndStripsTagsSpeakersAndCueSettings() = runTest {
        val vtt = """
            WEBVTT

            00:05.000 --> 00:07.250 align:start position:0%
            HOST: <v Host>So <b>anyway</b></v>
        """.trimIndent()
        val http = FakeHttp(mapOf("https://example.com/t.vtt" to vtt))

        val transcript = fetchTranscript(http, listOf(vttRef("https://example.com/t.vtt")))

        assertNotNull(transcript)
        assertEquals(1, transcript.cues.size)
        // MM:SS timestamps, cue settings trailing the end stamp, tags and label stripped.
        assertEquals(Cue(5.0, 7.25, "So anyway"), transcript.cues[0])
    }

    @Test
    fun parsesSrtWithCommaMillisecondsAndIndexLines() = runTest {
        val srt = """
            1
            00:00:01,500 --> 00:00:04,000
            First line
            still first cue

            2
            00:01:00,000 --> 00:01:02,750
            Second
        """.trimIndent()
        val http = FakeHttp(mapOf("https://example.com/t.srt" to srt))

        val transcript = fetchTranscript(http, listOf(srtRef("https://example.com/t.srt")))

        assertNotNull(transcript)
        assertEquals(
            listOf(
                Cue(1.5, 4.0, "First line still first cue"),
                Cue(60.0, 62.75, "Second"),
            ),
            transcript.cues,
        )
    }

    @Test
    fun jsonTranscriptYieldsWordTimingsWithTheDefaultEndOffset() = runTest {
        val json = """
            { "segments": [
                { "startTime": 1.0, "endTime": 1.4, "body": " hello " },
                { "startTime": 2.0, "body": "world" },
                { "body": "no timing, dropped" },
                { "startTime": 3.0 }
            ] }
        """.trimIndent()
        val http = FakeHttp(mapOf("https://example.com/t.json" to json))

        val transcript = fetchTranscript(http, listOf(jsonRef("https://example.com/t.json")))

        assertNotNull(transcript)
        assertTrue(transcript.cues.isEmpty())
        val words = assertNotNull(transcript.words)
        assertEquals(2, words.size)
        assertEquals(TimedWord("hello", 1.0, 1.4), words[0])
        assertEquals("world", words[1].word)
        assertEquals(2.0, words[1].startSec)
        // No endTime: 0.3 seconds after the start, exactly as the TS port computes it.
        assertEquals(2.3, words[1].endSec, absoluteTolerance = 1e-9)
    }

    @Test
    fun garbageContentReturnsNull() = runTest {
        val http = FakeHttp(
            mapOf(
                "https://example.com/t.vtt" to "just some prose with no timings at all",
                "https://example.com/t.json" to "also not a transcript",
            ),
        )

        val transcript = fetchTranscript(
            http,
            listOf(vttRef("https://example.com/t.vtt"), jsonRef("https://example.com/t.json")),
        )

        assertNull(transcript)
    }

    @Test
    fun prefersJsonThenVttThenSrtAndFallsThroughFailures() = runTest {
        val vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFrom VTT"
        val http = FakeHttp(
            mapOf(
                // The JSON ref 404s (absent from the map); the VTT one works.
                "https://example.com/t.vtt" to vtt,
                "https://example.com/t.srt" to "1\n00:00:01,000 --> 00:00:02,000\nFrom SRT",
            ),
        )

        val transcript = fetchTranscript(
            http,
            // Deliberately listed worst-first: rank ordering must reorder them.
            listOf(
                srtRef("https://example.com/t.srt"),
                vttRef("https://example.com/t.vtt"),
                jsonRef("https://example.com/t.json"),
            ),
        )

        assertNotNull(transcript)
        assertEquals("From VTT", transcript.cues.single().text)
        // JSON was tried first, then VTT satisfied the fetch; SRT was never needed.
        assertEquals(
            listOf("https://example.com/t.json", "https://example.com/t.vtt"),
            http.requested,
        )
    }

    @Test
    fun emptyJsonSegmentsFallThroughToTheNextRef() = runTest {
        val http = FakeHttp(
            mapOf(
                "https://example.com/t.json" to """{ "segments": [] }""",
                "https://example.com/t.vtt" to "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFallback",
            ),
        )

        val transcript = fetchTranscript(
            http,
            listOf(jsonRef("https://example.com/t.json"), vttRef("https://example.com/t.vtt")),
        )

        assertNotNull(transcript)
        assertNull(transcript.words)
        assertEquals("Fallback", transcript.cues.single().text)
    }
}
