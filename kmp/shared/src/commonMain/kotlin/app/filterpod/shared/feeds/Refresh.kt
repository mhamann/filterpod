package app.filterpod.shared.feeds

import app.filterpod.shared.data.Repo
import app.filterpod.shared.data.podcastIdFor
import app.filterpod.shared.net.Http
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Feed fetching and refresh, ported from src/features/feeds/refresh.ts.
 *
 * Refresh uses conditional requests (ETag / Last-Modified). Most feeds answer 304 on
 * most refreshes, so a library-wide refresh is usually a handful of empty responses
 * rather than megabytes of re-parsed XML.
 */

class RefreshResult(
    val podcastId: String,
    val newEpisodeIds: List<String>,
    val unchanged: Boolean,
    val error: String? = null,
)

/** The refresh operations the subscription service drives; a seam for tests. */
interface FeedRefreshing {
    suspend fun fetchFeed(feedUrl: String, conditional: Boolean = true): RefreshResult
    suspend fun refreshAllSubscriptions(concurrency: Int = 4): List<RefreshResult>
}

class FeedRefresher(
    private val http: Http,
    private val repo: Repo,
    private val xmlReader: FeedXmlReader,
    private val now: () -> Long,
) : FeedRefreshing {

    /** Fetches and stores a feed. Used both for first subscribe and for refresh. */
    override suspend fun fetchFeed(feedUrl: String, conditional: Boolean): RefreshResult {
        val podcastId = podcastIdFor(feedUrl)
        val existing = repo.getPodcast(podcastId)

        try {
            val headers = buildMap {
                if (conditional) {
                    existing?.etag?.let { put("If-None-Match", it) }
                    existing?.lastModified?.let { put("If-Modified-Since", it) }
                }
            }
            val response = http.get(feedUrl, headers)

            if (response.status == 304) {
                /*
                 * A 304 is only a success if we actually hold the episodes it vouches
                 * for. Validators can outlive their episodes — the migration backup
                 * restored podcast rows (etag and all) while episodes are rebuilt from
                 * feeds — and honoring the validator then leaves the show permanently
                 * empty: every refresh answers "nothing changed" about episodes we
                 * never had. Seen in the field as two shows with no episodes at all.
                 */
                if (repo.listEpisodeIds(podcastId).isEmpty()) {
                    return fetchFeed(feedUrl, conditional = false)
                }
                // The copy on disk is confirmed current.
                if (existing != null) {
                    repo.upsertPodcast(
                        existing.copy(
                            lastFetchedAt = now(),
                            lastSuccessAt = now(),
                            lastFetchError = null,
                        ),
                    )
                }
                return RefreshResult(podcastId, emptyList(), unchanged = true)
            }

            if (response.status != 200) {
                throw RuntimeException("HTTP ${response.status}")
            }

            val parsed = parseFeed(response.bodyText(), feedUrl, xmlReader, now())

            repo.upsertPodcast(
                parsed.podcast.copy(
                    etag = response.headers["etag"] ?: existing?.etag,
                    lastModified = response.headers["last-modified"] ?: existing?.lastModified,
                    lastSuccessAt = now(),
                    lastFetchError = null,
                ),
            )
            val newEpisodeIds = repo.upsertEpisodes(parsed.episodes)

            return RefreshResult(podcastId, newEpisodeIds, unchanged = false)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            val message = error.message ?: error.toString()
            // Record the failure without clobbering the cached feed; a transient network
            // error should never empty someone's library.
            if (existing != null) {
                repo.upsertPodcast(existing.copy(lastFetchError = message, lastFetchedAt = now()))
            }
            return RefreshResult(podcastId, emptyList(), unchanged = false, error = message)
        }
    }

    /** Refreshes every subscribed feed with bounded concurrency. */
    override suspend fun refreshAllSubscriptions(concurrency: Int): List<RefreshResult> {
        val subscriptions = repo.listSubscriptions()
        val feedUrls = subscriptions.mapNotNull { repo.getPodcast(it.podcastId)?.feedUrl }

        val results = mutableListOf<RefreshResult>()
        val lock = Mutex()
        var cursor = 0

        // A small pool rather than one coroutine per feed: refreshing 200 feeds at once
        // would swamp a phone's connection and get us rate-limited by the larger hosts.
        coroutineScope {
            val workers = List(minOf(concurrency, feedUrls.size)) {
                async {
                    while (true) {
                        val index = lock.withLock { cursor++ }
                        if (index >= feedUrls.size) return@async
                        val result = fetchFeed(feedUrls[index])
                        lock.withLock { results.add(result) }
                    }
                }
            }
            workers.awaitAll()
        }
        return results
    }
}
