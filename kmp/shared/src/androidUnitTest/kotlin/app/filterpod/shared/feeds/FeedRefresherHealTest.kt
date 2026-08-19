package app.filterpod.shared.feeds

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import app.filterpod.shared.data.Repo
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.net.Http
import app.filterpod.shared.net.HttpResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The migration heal: a 304 is only a success if we actually hold the episodes it
 * vouches for. Imported podcast rows can carry validators for episodes the backup
 * deliberately omitted — honoring them left shows permanently empty in the field.
 */
class FeedRefresherHealTest {

    private val feedXml = """<rss><channel><title>Show</title>
        <item><guid>g1</guid><title>One</title><enclosure url="https://x/1.mp3"/></item>
        </channel></rss>"""

    @Test
    fun a304WithNoLocalEpisodesRefetchesUnconditionally() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        val repo = Repo(FilterPodDb(driver), Dispatchers.Unconfined)

        val feedUrl = "https://example.com/feed.xml"
        // The imported state: a podcast row with validators, and no episodes at all.
        repo.upsertPodcast(
            Podcast(
                id = app.filterpod.shared.data.podcastIdFor(feedUrl),
                feedUrl = feedUrl, title = "Show",
                etag = "\"stale\"", lastModified = "Wed, 15 Jul 2026 08:05:02 GMT",
            ),
        )

        val requests = mutableListOf<Map<String, String>>()
        val http = object : Http {
            override suspend fun get(url: String, headers: Map<String, String>): HttpResponse {
                requests += headers
                // The server honestly answers 304 to the conditional request, 200 otherwise.
                return if (headers.containsKey("If-None-Match")) {
                    HttpResponse(304, emptyMap(), ByteArray(0))
                } else {
                    HttpResponse(200, mapOf("etag" to "\"fresh\""), feedXml.encodeToByteArray())
                }
            }
        }

        val result = FeedRefresher(http, repo, XmlFeedReader()) { 1_000L }.fetchFeed(feedUrl)

        assertEquals(2, requests.size, "expected conditional then unconditional")
        assertTrue(requests[0].containsKey("If-None-Match"))
        assertFalse(requests[1].containsKey("If-None-Match"))
        assertFalse(result.unchanged)
        assertEquals(1, result.newEpisodeIds.size)
        assertEquals(1, repo.listEpisodeIds(result.podcastId).size)
        // The fresh validator is stored, so the NEXT refresh 304s normally.
        assertEquals("\"fresh\"", repo.getPodcast(result.podcastId)!!.etag)
    }

    @Test
    fun a304WithEpisodesPresentStaysA304() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        val repo = Repo(FilterPodDb(driver), Dispatchers.Unconfined)
        val feedUrl = "https://example.com/feed.xml"

        var calls = 0
        val http = object : Http {
            override suspend fun get(url: String, headers: Map<String, String>): HttpResponse {
                calls++
                return if (headers.containsKey("If-None-Match")) {
                    HttpResponse(304, emptyMap(), ByteArray(0))
                } else {
                    HttpResponse(200, mapOf("etag" to "\"v1\""), feedXml.encodeToByteArray())
                }
            }
        }
        val refresher = FeedRefresher(http, repo, XmlFeedReader()) { 1_000L }
        refresher.fetchFeed(feedUrl) // 200: stores the episode + validator
        val second = refresher.fetchFeed(feedUrl)

        assertTrue(second.unchanged)
        assertEquals(2, calls, "no unconditional retry when episodes exist")
    }
}
