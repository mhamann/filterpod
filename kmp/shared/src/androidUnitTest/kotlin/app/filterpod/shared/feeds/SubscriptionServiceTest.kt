package app.filterpod.shared.feeds

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import app.filterpod.shared.data.Repo
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Subscription
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Port of src/features/subscriptions/service.test.ts.
 *
 * The auto-queue path: a subscription with autoQueue gets its new episodes appended to
 * the queue on refresh, oldest first, without disturbing what is already queued. Against
 * the real Repo because the property under test is queue order.
 */
class SubscriptionServiceTest {

    private class FakeRefresher(var results: List<RefreshResult> = emptyList()) : FeedRefreshing {
        override suspend fun fetchFeed(feedUrl: String, conditional: Boolean): RefreshResult =
            throw UnsupportedOperationException("not under test")

        override suspend fun refreshAllSubscriptions(concurrency: Int): List<RefreshResult> = results
    }

    private fun repo(): Repo {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        return Repo(FilterPodDb(driver), Dispatchers.Unconfined)
    }

    private fun episode(id: String, publishedAt: Long) = Episode(
        id = id, podcastId = "p1", guid = id, title = id,
        audioUrl = "https://a.example/$id.mp3", publishedAt = publishedAt,
    )

    private fun service(
        repo: Repo,
        refresher: FeedRefreshing,
        downloaded: MutableList<String> = mutableListOf(),
    ) = SubscriptionService(
        repo = repo,
        refresher = refresher,
        downloads = { episodeId, _ -> downloaded.add(episodeId) },
        downloadDeleter = { },
        now = { 100 },
    )

    @Test
    fun appendsNewEpisodesOldestFirstBehindTheExistingQueue() = runTest {
        val repo = repo()
        val refresher = FakeRefresher()
        val downloaded = mutableListOf<String>()
        val service = service(repo, refresher, downloaded)

        repo.subscribe(
            "p1",
            Subscription(podcastId = "p1", subscribedAt = 0, autoDownload = false, autoQueue = true),
            now = 0,
        )
        repo.upsertEpisodes(listOf(episode("monday", 1), episode("tuesday", 2)))
        repo.enqueueEpisode("already-there", now = 0)
        refresher.results = listOf(
            RefreshResult("p1", listOf("tuesday", "monday"), unchanged = false),
        )

        service.refreshAndAutoDownload()

        assertEquals(
            listOf("already-there", "monday", "tuesday"),
            repo.listQueue().map { it.episodeId },
        )
        // autoDownload is off; queueing must not have smuggled in downloads.
        assertTrue(downloaded.isEmpty())
    }

    @Test
    fun leavesTheQueueAloneForSubscriptionsThatOnlyFollow() = runTest {
        val repo = repo()
        val refresher = FakeRefresher()
        val service = service(repo, refresher)

        repo.subscribe(
            "p1",
            Subscription(podcastId = "p1", subscribedAt = 0, autoDownload = false),
            now = 0,
        )
        repo.upsertEpisodes(listOf(episode("monday", 1)))
        refresher.results = listOf(
            RefreshResult("p1", listOf("monday"), unchanged = false),
        )

        service.refreshAndAutoDownload()

        assertTrue(repo.listQueue().isEmpty())
    }

    @Test
    fun autoDownloadTakesTheNewestEpisodesUpToTheLimit() = runTest {
        val repo = repo()
        val refresher = FakeRefresher()
        val downloaded = mutableListOf<String>()
        val service = service(repo, refresher, downloaded)

        repo.subscribe(
            "p1",
            Subscription(
                podcastId = "p1", subscribedAt = 0,
                autoDownload = true, autoDownloadLimit = 2,
            ),
            now = 0,
        )
        repo.upsertEpisodes(
            listOf(episode("mon", 1), episode("tue", 2), episode("wed", 3)),
        )
        refresher.results = listOf(
            RefreshResult("p1", listOf("mon", "wed", "tue"), unchanged = false),
        )

        val queued = service.refreshAndAutoDownload()

        // Newest first, limited to two — a dumped backlog must not fill the phone.
        assertEquals(listOf("wed", "tue"), downloaded)
        assertEquals(listOf("wed", "tue"), queued)
        assertTrue(repo.listQueue().isEmpty()) // autoQueue not set
    }
}
