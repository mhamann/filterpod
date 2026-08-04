package app.filterpod

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Holds the Kotlin matcher and span math byte-identical to the TypeScript originals.
 *
 * The vectors in filter-fixtures.json are *computed by* the TS implementations
 * (exportParityFixtures.test.ts) — this test replays every input through the Kotlin
 * port and requires the same answer. Two matchers that drift is the port's worst
 * failure mode: a word cut on web and missed on device, discovered by a listener.
 * Regenerate fixtures with FILTER_FIXTURES=1 npx vitest run exportParityFixtures
 * whenever either side changes, and commit the JSON with the change.
 */
class FilterParityTest {

    private val fixtures: JSONObject by lazy {
        val stream = checkNotNull(javaClass.classLoader?.getResourceAsStream("filter-fixtures.json")) {
            "filter-fixtures.json missing — run FILTER_FIXTURES=1 npx vitest run exportParityFixtures"
        }
        JSONObject(stream.readBytes().decodeToString())
    }

    private val epsilon = 1e-9

    private fun wordsOf(array: JSONArray): List<TimedWord> = (0 until array.length()).map { i ->
        val item = array.getJSONObject(i)
        TimedWord(item.getString("word"), item.getDouble("startSec"), item.getDouble("endSec"))
    }

    private fun rangesOf(array: JSONArray): List<Range> = (0 until array.length()).map { i ->
        val item = array.getJSONObject(i)
        Range(item.getDouble("startSec"), item.getDouble("endSec"))
    }

    private fun spansOf(array: JSONArray): List<EngineSpan> = (0 until array.length()).map { i ->
        val item = array.getJSONObject(i)
        val terms = item.getJSONArray("terms")
        EngineSpan(
            startSec = item.getDouble("startSec"),
            endSec = item.getDouble("endSec"),
            severity = item.getString("severity"),
            category = item.getString("category"),
            terms = (0 until terms.length()).map { j -> terms.getString(j) },
        )
    }

    private fun assertRangesEqual(expected: List<Range>, actual: List<Range>) {
        assertEquals("range count", expected.size, actual.size)
        expected.zip(actual).forEach { (want, got) ->
            assertEquals(want.startSec, got.startSec, epsilon)
            assertEquals(want.endSec, got.endSec, epsilon)
        }
    }

    private fun assertSpansEqual(expected: List<EngineSpan>, actual: List<EngineSpan>) {
        assertEquals("span count", expected.size, actual.size)
        expected.zip(actual).forEach { (want, got) ->
            assertEquals(want.startSec, got.startSec, epsilon)
            assertEquals(want.endSec, got.endSec, epsilon)
            assertEquals(want.severity, got.severity)
            assertEquals(want.category, got.category)
            assertEquals(want.terms, got.terms)
        }
    }

    @Test
    fun normalizeWordMatchesTypeScript() {
        val cases = fixtures.getJSONArray("normalizeCases")
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            assertEquals(
                "normalizeWord(${case.getString("raw")})",
                case.getString("normalized"),
                WordMatcher.normalizeWord(case.getString("raw")),
            )
        }
    }

    @Test
    fun matchWordsMatchesTypeScript() {
        val wordlists = fixtures.getJSONObject("wordlists")
        val compiled = mapOf(
            "standard" to WordMatcher.Compiled.fromJson(wordlists.getJSONObject("standard")),
            "family" to WordMatcher.Compiled.fromJson(wordlists.getJSONObject("family")),
        )
        val cases = fixtures.getJSONArray("matchCases")
        assertTrue("no match cases", cases.length() > 0)

        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val words = SpanMath.sortAndDedupe(wordsOf(case.getJSONArray("words")))
            val matches = WordMatcher.matchWords(words, compiled.getValue(case.getString("wordlist")))
            val expected = case.getJSONArray("matches")

            assertEquals("$name: match count", expected.length(), matches.size)
            for (j in 0 until expected.length()) {
                val want = expected.getJSONObject(j)
                val got = matches[j]
                assertEquals("$name[$j].term", want.getString("term"), got.term)
                assertEquals("$name[$j].severity", want.getString("severity"), got.severity)
                assertEquals("$name[$j].category", want.getString("category"), got.category)
                assertEquals("$name[$j].via", want.getString("via"), got.via)
                assertEquals("$name[$j].start", want.getDouble("startSec"), got.word.startSec, epsilon)
                assertEquals("$name[$j].end", want.getDouble("endSec"), got.word.endSec, epsilon)
            }
        }
    }

    @Test
    fun spanPipelineMatchesTypeScript() {
        val case = fixtures.getJSONObject("spanCase")
        val compiled = WordMatcher.Compiled.fromJson(
            fixtures.getJSONObject("wordlists").getJSONObject("standard"),
        )
        val profile = case.getJSONObject("profile")
        val words = SpanMath.sortAndDedupe(wordsOf(case.getJSONArray("words")))
        val matches = WordMatcher.matchWords(words, compiled)
        val spans = SpanMath.spansFromMatches(
            matches,
            padBeforeSec = profile.getDouble("padBeforeSec"),
            padAfterSec = profile.getDouble("padAfterSec"),
            mergeGapSec = profile.getDouble("mergeGapSec"),
            durationSec = case.getDouble("durationSec"),
        )
        assertSpansEqual(spansOf(case.getJSONArray("spans")), spans)
    }

    @Test
    fun rangeAlgebraMatchesTypeScript() {
        val cases = fixtures.getJSONObject("rangeCases")

        val merge = cases.getJSONObject("merge")
        assertRangesEqual(
            rangesOf(merge.getJSONArray("output")),
            SpanMath.mergeRanges(rangesOf(merge.getJSONArray("input"))),
        )

        val subtract = cases.getJSONObject("subtract")
        assertRangesEqual(
            rangesOf(subtract.getJSONArray("output")),
            SpanMath.subtractRanges(
                rangesOf(subtract.getJSONArray("ranges")),
                rangesOf(subtract.getJSONArray("holes")),
            ),
        )

        val until = cases.getJSONObject("analyzedUntil")
        val ranges = rangesOf(until.getJSONArray("ranges"))
        val queries = until.getJSONArray("queries")
        for (i in 0 until queries.length()) {
            val query = queries.getJSONObject(i)
            assertEquals(
                "analyzedUntil(${query.getDouble("positionSec")})",
                query.getDouble("result"),
                SpanMath.analyzedUntil(ranges, query.getDouble("positionSec")),
                epsilon,
            )
        }

        val normalize = cases.getJSONObject("normalizeSpansMergesSeverity")
        assertSpansEqual(
            spansOf(normalize.getJSONArray("output")),
            SpanMath.normalizeSpans(
                spansOf(normalize.getJSONArray("input")),
                normalize.getDouble("mergeGapSec"),
            ),
        )

        val dedupe = cases.getJSONObject("sortAndDedupe")
        val expected = wordsOf(dedupe.getJSONArray("output"))
        val actual = SpanMath.sortAndDedupe(wordsOf(dedupe.getJSONArray("input")))
        assertEquals("dedupe count", expected.size, actual.size)
        expected.zip(actual).forEach { (want, got) ->
            assertEquals(want.word, got.word)
            assertEquals(want.startSec, got.startSec, epsilon)
            assertEquals(want.endSec, got.endSec, epsilon)
        }
    }
}
