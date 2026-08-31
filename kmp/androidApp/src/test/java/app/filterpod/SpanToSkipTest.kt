package app.filterpod

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Choosing which span to cut, and when.
 *
 * The decision runs ahead of the playhead because audio handed to the output cannot be
 * taken back, so by the time a seek lands the listener has already heard whatever was
 * in those buffers. Getting the rule wrong here is not a missed cut in the abstract —
 * it is the word played out loud with a cut recorded for it.
 */
class SpanToSkipTest {

    private fun span(start: Long, end: Long) = FilterSpan(start, end, "moderate", "profanity")

    private val spans = listOf(span(1_000, 1_660), span(5_000, 5_500))

    @Test
    fun takesASpanStartingInsideTheLookaheadWindow() {
        assertEquals(spans[0], spans.spanToSkip(positionMs = 700, lookaheadMs = 400))
        assertEquals(spans[0], spans.spanToSkip(positionMs = 600, lookaheadMs = 400))
    }

    @Test
    fun leavesSpansBeyondTheWindowAlone() {
        assertNull(spans.spanToSkip(positionMs = 500, lookaheadMs = 400))
        assertNull(spans.spanToSkip(positionMs = 2_000, lookaheadMs = 400))
    }

    @Test
    fun doesNotStepOverASpanShorterThanTheLookahead() {
        // 500ms span, 700ms lookahead: the point 700ms ahead is already past the end of
        // it. Probing that point alone finds nothing and the word plays.
        assertEquals(spans[1], spans.spanToSkip(positionMs = 4_500, lookaheadMs = 700))
        assertEquals(spans[1], spans.spanToSkip(positionMs = 4_900, lookaheadMs = 700))
    }

    @Test
    fun cutsLateRatherThanNotAtAllWhenAlreadyInside() {
        // Seeking into the middle of a flagged span: the start is unrecoverable, but the
        // rest of the word is not.
        assertEquals(spans[0], spans.spanToSkip(positionMs = 1_200, lookaheadMs = 400))
        assertEquals(spans[1], spans.spanToSkip(positionMs = 5_400, lookaheadMs = 400))
    }

    @Test
    fun picksTheNearestOfSeveralInRange() {
        val close = listOf(span(1_000, 1_200), span(1_300, 1_500))
        assertEquals(close[0], close.spanToSkip(positionMs = 900, lookaheadMs = 700))
        // Once the first is behind, the second is next.
        assertEquals(close[1], close.spanToSkip(positionMs = 1_250, lookaheadMs = 700))
    }

    @Test
    fun emptyMapNeverSkips() {
        assertNull(emptyList<FilterSpan>().spanToSkip(positionMs = 1_000, lookaheadMs = 400))
    }
}
