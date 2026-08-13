package app.filterpod.shared.feeds

import app.filterpod.shared.data.Repo
import app.filterpod.shared.data.podcastIdFor
import app.filterpod.shared.model.Subscription

/**
 * Subscription lifecycle, ported from src/features/subscriptions/service.ts.
 *
 * Subscribing kicks off the work that makes episodes actually listenable — fetching the
 * feed, then downloading and filtering the most recent episodes — because on this app's
 * no-server design an episode is not playable until it has been processed.
 */

/** Download-enqueue side effect; the app module wires this to its download manager. */
fun interface DownloadRequester {
    suspend fun enqueueDownload(episodeId: String, auto: Boolean)
}

/** Deletes a stored download (row and file); wired to the same download manager. */
fun interface DownloadDeleter {
    suspend fun deleteDownload(episodeId: String)
}

class SubscribeResult(
    val podcastId: String,
    val episodeCount: Int,
    val queuedForDownload: List<String>,
)

class SubscriptionService(
    private val repo: Repo,
    private val refresher: FeedRefreshing,
    private val downloads: DownloadRequester,
    private val downloadDeleter: DownloadDeleter,
    private val now: () -> Long,
    /**
     * Fire-and-forget durable backup, the TS `void writeLibraryBackup().catch(() => {})`.
     * The caller decides how to make it asynchronous (typically `scope.launch`);
     * failures are swallowed here just as they were there.
     */
    private val writeLibraryBackup: () -> Unit = {},
) {

    suspend fun subscribeToFeed(
        feedUrl: String,
        autoDownload: Boolean = false,
        autoDownloadLimit: Int = 3,
    ): SubscribeResult {
        val result = refresher.fetchFeed(feedUrl, conditional = false)
        if (result.error != null) throw RuntimeException("Could not load feed: ${result.error}")

        val podcastId = podcastIdFor(feedUrl)
        val subscription = repo.subscribe(
            podcastId,
            Subscription(
                podcastId = podcastId,
                subscribedAt = now(),
                // Off by default. Subscribing to a show is not a request to fill the
                // phone with it: episodes stream, and downloading is for the ones
                // somebody deliberately wants offline. Still available per-show for
                // exactly that.
                autoDownload = autoDownload,
                autoDownloadLimit = autoDownloadLimit,
            ),
            now = now(),
        )

        val episodes = repo.listEpisodes(podcastId, maxOf(1, autoDownloadLimit).toLong())
        val queuedForDownload = mutableListOf<String>()

        if (subscription.autoDownload) {
            for (episode in episodes.take(autoDownloadLimit.coerceAtLeast(0))) {
                downloads.enqueueDownload(episode.id, auto = true)
                queuedForDownload.add(episode.id)
            }
        }

        val episodeCount = repo.listEpisodeIds(podcastId).size

        // Keep the durable mirror current, so a storage wipe can be healed. Done on the
        // subscription mutations specifically: they are what make an empty database
        // distinguishable from a deliberately emptied library.
        runCatching { writeLibraryBackup() }

        return SubscribeResult(podcastId, episodeCount, queuedForDownload)
    }

    /** Unsubscribes and reclaims the storage used by that feed's downloads. */
    suspend fun unsubscribeFromFeed(podcastId: String) {
        val episodeIds = repo.listEpisodeIds(podcastId)
        for (episodeId in episodeIds) {
            downloadDeleter.deleteDownload(episodeId)
        }
        repo.unsubscribe(podcastId)
        // Unsubscribing the last show must leave a backup that says "empty on purpose",
        // or the next launch would faithfully restore what was just removed.
        runCatching { writeLibraryBackup() }
    }

    /**
     * Refreshes every feed, then applies each subscription's new-episode behaviour:
     * auto-download and/or auto-queue. Returns the episodes queued for download, which
     * is what the UI reports as "N new episodes".
     */
    suspend fun refreshAndAutoDownload(): List<String> {
        val results = refresher.refreshAllSubscriptions()
        val byPodcast = repo.listSubscriptions().associateBy { it.podcastId }
        val queued = mutableListOf<String>()

        for (result in results) {
            val subscription = byPodcast[result.podcastId] ?: continue
            if (result.newEpisodeIds.isEmpty()) continue
            val autoQueue = subscription.autoQueue ?: false
            if (!subscription.autoDownload && !autoQueue) continue

            // Newest first, so a feed that dumps a backlog does not queue it oldest-first.
            val ordered = result.newEpisodeIds
                .mapNotNull { repo.getEpisode(it) }
                .sortedByDescending { it.publishedAt }

            if (subscription.autoDownload) {
                // A limit of 0 means unlimited, as it did in the TS `limit || length`.
                val limit = subscription.autoDownloadLimit.takeIf { it != 0 } ?: ordered.size
                for (episode in ordered.take(limit.coerceAtLeast(0))) {
                    downloads.enqueueDownload(episode.id, auto = true)
                    queued.add(episode.id)
                }
            }

            if (autoQueue) {
                // Appended oldest-first: the queue plays top-down, and Monday's episode
                // should play before Tuesday's. No limit — the queue is an intention
                // list, not storage, and anything unwanted is one swipe from gone.
                for (episode in ordered.reversed()) {
                    repo.enqueueEpisode(episode.id, now = now())
                }
            }
        }

        return queued
    }
}
