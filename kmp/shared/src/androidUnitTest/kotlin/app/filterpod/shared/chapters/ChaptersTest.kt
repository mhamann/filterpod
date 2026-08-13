package app.filterpod.shared.chapters

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import app.filterpod.shared.data.Repo
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.model.Episode
import app.filterpod.shared.net.Http
import app.filterpod.shared.net.HttpResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Ported from src/features/chapters/chapters.test.ts. The `podcast:chapters`-in-the-feed
 * cases live with the feed parser port, not here — they exercise parseFeed.
 *
 * Chapter files are third-party data, so the normalization is where the safety lives:
 * whatever a publisher ships, the player must end up with clean, ordered, seekable
 * markers or nothing.
 */
class ChaptersTest {

    private fun parse(text: String) = Json.parseToJsonElement(text)

    // --- normalizeChapters ---------------------------------------------------

    @Test
    fun ordersChaptersAndKeepsOnlyWhatIsRenderable() {
        val chapters = normalizeChapters(
            parse(
                """
                { "chapters": [
                    { "startTime": 300, "title": "Second" },
                    { "startTime": 0, "title": "Intro", "img": "https://example.com/a.jpg" },
                    { "startTime": "nonsense", "title": "dropped" },
                    { "startTime": -5, "title": "dropped too" },
                    { "startTime": 120, "title": "Hidden marker", "toc": false }
                ] }
                """,
            ),
        )

        assertEquals(
            listOf(0.0 to "Intro", 300.0 to "Second"),
            chapters.map { it.startSec to it.title },
        )
        assertEquals("https://example.com/a.jpg", chapters[0].imageUrl)
    }

    @Test
    fun keepsOneOfTwoChaptersStartingAtTheSameInstant() {
        val chapters = normalizeChapters(
            parse("""{ "chapters": [ { "startTime": 60, "title": "A" }, { "startTime": 60, "title": "B" } ] }"""),
        )
        assertEquals(1, chapters.size)
    }

    @Test
    fun returnsNothingForGarbageDocuments() {
        assertEquals(emptyList(), normalizeChapters(null))
        assertEquals(emptyList(), normalizeChapters(parse("null")))
        assertEquals(emptyList(), normalizeChapters(parse("\"chapters\"")))
        assertEquals(emptyList(), normalizeChapters(parse("""{ "chapters": "nope" }""")))
    }

    // --- chapterAt -----------------------------------------------------------

    private val chapters = normalizeChapters(
        parse(
            """
            { "chapters": [
                { "startTime": 0, "title": "Intro" },
                { "startTime": 100, "title": "Middle" },
                { "startTime": 200, "title": "End" }
            ] }
            """,
        ),
    )

    @Test
    fun findsTheChapterContainingThePlayhead() {
        assertEquals("Intro", chapterAt(chapters, 0.0)?.title)
        assertEquals("Middle", chapterAt(chapters, 150.0)?.title)
        assertEquals("End", chapterAt(chapters, 9999.0)?.title)
    }

    @Test
    fun isNullBeforeTheFirstMarker() {
        val late = normalizeChapters(parse("""{ "chapters": [ { "startTime": 30, "title": "Late start" } ] }"""))
        assertNull(chapterAt(late, 10.0))
    }

    // --- getChapters: cache first, network second, empty on any failure ------

    private class CountingHttp(private val bodyByUrl: Map<String, String>) : Http {
        var calls = 0
        override suspend fun get(url: String, headers: Map<String, String>): HttpResponse {
            calls++
            return bodyByUrl[url]
                ?.let { HttpResponse(200, emptyMap(), it.encodeToByteArray()) }
                ?: HttpResponse(404, emptyMap(), ByteArray(0))
        }
    }

    private fun repo(): Repo {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        return Repo(FilterPodDb(driver), Dispatchers.Unconfined)
    }

    private fun episode(chaptersUrl: String?) = Episode(
        id = "e1", podcastId = "p1", guid = "g1", title = "Ep",
        audioUrl = "https://example.com/ep.mp3", chaptersUrl = chaptersUrl,
    )

    @Test
    fun fetchesOnceThenServesFromTheCacheEvenWhenEmpty() = runTest {
        val repo = repo()
        val http = CountingHttp(
            mapOf("https://example.com/ch.json" to """{ "chapters": [ { "startTime": 0, "title": "Intro" } ] }"""),
        )
        val ep = episode("https://example.com/ch.json")

        assertEquals(listOf("Intro"), getChapters(ep, repo, http, now = 1).map { it.title })
        assertEquals(listOf("Intro"), getChapters(ep, repo, http, now = 2).map { it.title })
        assertEquals(1, http.calls)

        // Empty results are cached too: a chapters URL that yields nothing keeps yielding
        // nothing, and refetching it on every open is pure waste.
        val emptyHttp = CountingHttp(mapOf("https://example.com/empty.json" to """{ "chapters": [] }"""))
        val emptyEp = episode("https://example.com/empty.json").copy(id = "e2")
        assertEquals(emptyList(), getChapters(emptyEp, repo, emptyHttp, now = 1))
        assertEquals(emptyList(), getChapters(emptyEp, repo, emptyHttp, now = 2))
        assertEquals(1, emptyHttp.calls)
    }

    @Test
    fun failuresAreSilentAndNotCached() = runTest {
        val repo = repo()
        val http = CountingHttp(emptyMap())

        // No chapters URL: nothing to do, no request.
        assertEquals(emptyList(), getChapters(episode(null), repo, http, now = 1))
        assertEquals(0, http.calls)

        // Non-200: empty, and nothing written — the next open may retry.
        assertEquals(emptyList(), getChapters(episode("https://example.com/missing.json"), repo, http, now = 1))
        assertEquals(emptyList(), getChapters(episode("https://example.com/missing.json"), repo, http, now = 2))
        assertEquals(2, http.calls)

        // Unparseable body: empty rather than an exception.
        val garbage = CountingHttp(mapOf("https://example.com/bad.json" to "not json at all"))
        assertEquals(emptyList(), getChapters(episode("https://example.com/bad.json"), repo, garbage, now = 1))
    }
}
