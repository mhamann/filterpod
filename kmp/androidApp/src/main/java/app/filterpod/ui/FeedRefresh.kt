package app.filterpod.ui

import app.filterpod.shared.data.Repo
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.net.Http

/**
 * Seam for feed refresh.
 *
 * TODO(feeds): app.filterpod.shared.feeds does not exist yet (it is being built
 * separately). When it lands, point [delegate] at its refresh entry point — the UI
 * call sites (pull-to-refresh on Library and PodcastDetail, post-subscribe refresh
 * on Discover) are already wired through here and need no changes.
 *
 * With the stub in place a refresh is a quiet no-op that reports success: the
 * cached episodes on screen are still perfectly good, and a "refresh is not built
 * yet" error would punish the user for the codebase's build order.
 */
object FeedRefresh {

    /** Fetches and persists one feed. Set by whoever wires the feeds module in. */
    @Volatile
    var delegate: (suspend (repo: Repo, http: Http, podcast: Podcast) -> Unit)? = null

    /** Refreshes one show. Returns an error message, or null on success/no-op. */
    suspend fun refresh(repo: Repo, http: Http, podcast: Podcast): String? = try {
        delegate?.invoke(repo, http, podcast)
        null
    } catch (t: Throwable) {
        t.message ?: "Refresh failed"
    }

    /** Refreshes every subscribed show; used by the Library pull. Errors stay quiet. */
    suspend fun refreshAll(repo: Repo, http: Http) {
        val subscribed = repo.listSubscriptions().mapNotNull { repo.getPodcast(it.podcastId) }
        for (podcast in subscribed) {
            refresh(repo, http, podcast)
        }
    }
}
