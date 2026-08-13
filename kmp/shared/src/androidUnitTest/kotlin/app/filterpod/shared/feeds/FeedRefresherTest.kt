package app.filterpod.shared.feeds

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import app.filterpod.shared.data.Repo
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.net.Http
import app.filterpod.shared.net.HttpResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The refresh.ts semantics that matter: validators ride the conditional request, a 304
 * counts as success, and a failure is recorded without clobbering the cached feed.
 */
class FeedRefresherTest {

    private class FakeHttp : Http {
        var respond: (Map<String, String>) -> HttpResponse =
            { HttpResponse(500, emptyMap(), ByteArray(0)) }

        override suspend fun get(url: String, headers: Map<String, String>): HttpResponse =
            respond(headers)
    }

    private fun repo(): Repo {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        return Repo(FilterPodDb(driver), Dispatchers.Unconfined)
    }

    private val feedXml = """<rss><channel><title>Show</title>
        <item><guid>g1</guid><title>One</title><enclosure url="https://x/1.mp3"/></item>
        </channel></rss>"""

    @Test
    fun conditionalRefreshSendsValidatorsAndRecords304AsSuccess() = runTest {
        val repo = repo()
        val http = FakeHttp()
        var clock = 1_000L
        val refresher = FeedRefresher(http, repo, XmlFeedReader()) { clock }

        http.respond = {
            HttpResponse(
                200,
                mapOf("etag" to "\"v1\"", "last-modified" to "Mon, 01 Jan 2024 00:00:00 GMT"),
                feedXml.encodeToByteArray(),
            )
        }
        val first = refresher.fetchFeed("https://example.com/feed.xml")
        assertFalse(first.unchanged)
        assertNull(first.error)
        assertEquals(1, first.newEpisodeIds.size)

        val stored = repo.getPodcast(first.podcastId)!!
        assertEquals("Show", stored.title)
        assertEquals("\"v1\"", stored.etag)
        assertEquals(1_000L, stored.lastSuccessAt)

        clock = 2_000L
        var sentHeaders: Map<String, String> = emptyMap()
        http.respond = { headers ->
            sentHeaders = headers
            HttpResponse(304, emptyMap(), ByteArray(0))
        }
        val second = refresher.fetchFeed("https://example.com/feed.xml")
        assertTrue(second.unchanged)
        assertNull(second.error)
        assertTrue(second.newEpisodeIds.isEmpty())
        assertEquals("\"v1\"", sentHeaders["If-None-Match"])
        assertEquals("Mon, 01 Jan 2024 00:00:00 GMT", sentHeaders["If-Modified-Since"])

        val after = repo.getPodcast(first.podcastId)!!
        assertEquals(2_000L, after.lastSuccessAt) // 304 is a success
        assertEquals(2_000L, after.lastFetchedAt)
        assertEquals("\"v1\"", after.etag) // validators survive the 304
    }

    @Test
    fun aFailureIsRecordedWithoutClobberingTheCachedFeed() = runTest {
        val repo = repo()
        val http = FakeHttp()
        var clock = 1_000L
        val refresher = FeedRefresher(http, repo, XmlFeedReader()) { clock }

        http.respond = { HttpResponse(200, emptyMap(), feedXml.encodeToByteArray()) }
        val first = refresher.fetchFeed("https://example.com/feed.xml")
        assertNull(first.error)

        clock = 2_000L
        http.respond = { HttpResponse(500, emptyMap(), ByteArray(0)) }
        val failed = refresher.fetchFeed("https://example.com/feed.xml")
        assertEquals("HTTP 500", failed.error)
        assertTrue(failed.newEpisodeIds.isEmpty())

        val after = repo.getPodcast(first.podcastId)!!
        assertEquals("Show", after.title) // the cached feed survives
        assertEquals("HTTP 500", after.lastFetchError)
        assertEquals(2_000L, after.lastFetchedAt)
        assertEquals(1_000L, after.lastSuccessAt) // success stamp untouched by the failure

        // The next good fetch clears the error.
        clock = 3_000L
        http.respond = { HttpResponse(200, emptyMap(), feedXml.encodeToByteArray()) }
        refresher.fetchFeed("https://example.com/feed.xml")
        val healed = repo.getPodcast(first.podcastId)!!
        assertNull(healed.lastFetchError)
        assertEquals(3_000L, healed.lastSuccessAt)
    }

    @Test
    fun aFailedFirstFetchStoresNothing() = runTest {
        val repo = repo()
        val http = FakeHttp()
        val refresher = FeedRefresher(http, repo, XmlFeedReader()) { 1_000L }

        http.respond = { HttpResponse(404, emptyMap(), ByteArray(0)) }
        val result = refresher.fetchFeed("https://example.com/missing.xml")
        assertEquals("HTTP 404", result.error)
        // No cached row existed, so none is invented to carry the error.
        assertNull(repo.getPodcast(result.podcastId))
    }
}
