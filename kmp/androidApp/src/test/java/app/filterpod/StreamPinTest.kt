package app.filterpod

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Which stored analysis survives a change of audio.
 *
 * An ad-supported enclosure is assembled per request, so the same episode URL yields
 * copies that differ in length and in where everything after the first ad break sits.
 * Spans timed against one copy are wrong against another, and wrong silently: the skip
 * still fires, it just cuts audio that is not the flagged word.
 */
class StreamPinTest {

    @Test
    fun cacheEntriesAreScopedToOneAssembledCopy() {
        val first = StreamPin.Pin("https://host/a.mp3?session_id=abc", "len104952907.sabc")
        val second = StreamPin.Pin("https://host/a.mp3?session_id=xyz", "len102638247.sxyz")
        // Different copies cannot share an entry, which is what let one cache hold
        // bytes from two stitches and produce a file that existed on no server.
        assertTrue(first.cacheKey("e_1") != second.cacheKey("e_1"))
        // The same copy of two episodes stays distinct, and the same copy re-derives
        // the same key so cached bytes are actually reused.
        assertTrue(first.cacheKey("e_1") != first.cacheKey("e_2"))
        assertEquals(first.cacheKey("e_1"), StreamPin.Pin("other-url", first.identity).cacheKey("e_1"))
    }

    @Test
    fun onlyAKnownDisagreementDiscardsAMap() {
        assertTrue(StreamPin.isStale("len1", "len2"))
        assertFalse(StreamPin.isStale("len1", "len1"))
        // Unidentified on either side: a download, a stream that would not resolve, or a
        // map written before identity was recorded. Left alone rather than thrown away.
        assertFalse(StreamPin.isStale(null, "len2"))
        assertFalse(StreamPin.isStale("len1", null))
        assertFalse(StreamPin.isStale(null, null))
    }
}
