package app.filterpod.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.share.ShareLinks
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Hands a filterpod.app link to the system share sheet.
 *
 * The text is the title and the link on its own line: chat apps unfurl the link into
 * a card with the artwork, and anything that doesn't still gets a readable message.
 *
 * A members-only feed is never put in a link — its URL is the subscriber's
 * credential. Instead the public show behind it is looked up (see
 * PublicCounterparts) and that is shared; the episode goes without a position, since
 * the public copy's ads put the same second somewhere else. When there is no one
 * clear public match, the listener is told why nothing was shared.
 */
class Sharer internal constructor(
    private val context: Context,
    private val scope: CoroutineScope,
    private val show: (ShareDialog?) -> Unit,
) {
    private var lookup: Job? = null

    fun episode(podcast: Podcast, episode: Episode, atSec: Double? = null) {
        if (!ShareLinks.isPrivateFeed(podcast.feedUrl)) {
            return context.shareEpisode(podcast, episode, atSec)
        }
        resolve(podcast) { public ->
            val match = runCatching { FilterPodApp.instance.publicCounterparts.episode(public, episode) }
                .getOrElse { if (it is CancellationException) throw it else null }
            if (match != null) {
                show(null)
                context.shareEpisode(public, match)
            } else {
                show(ShareDialog.EpisodeNotPublic(public))
            }
        }
    }

    fun podcast(podcast: Podcast) {
        if (!ShareLinks.isPrivateFeed(podcast.feedUrl)) return context.sharePodcast(podcast)
        resolve(podcast) { public ->
            show(null)
            context.sharePodcast(public)
        }
    }

    internal fun sharePodcast(podcast: Podcast) = context.sharePodcast(podcast)

    internal fun shareWebsite(podcast: Podcast, website: String) =
        context.shareText(podcast.title, "${podcast.title}\n$website", "Share website")

    internal fun cancel() {
        lookup?.cancel()
        show(null)
    }

    private fun resolve(member: Podcast, then: suspend (Podcast) -> Unit) {
        lookup?.cancel()
        show(ShareDialog.Looking(member))
        lookup = scope.launch {
            val public = runCatching { FilterPodApp.instance.publicCounterparts.show(member) }
                .getOrElse { if (it is CancellationException) throw it else null }
            if (public == null) show(ShareDialog.NoPublicShow(member)) else then(public)
        }
    }
}

sealed interface ShareDialog {
    data class Looking(val member: Podcast) : ShareDialog
    data class NoPublicShow(val member: Podcast) : ShareDialog
    data class EpisodeNotPublic(val public: Podcast) : ShareDialog
}

@Composable
fun rememberSharer(): Sharer {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var dialog by remember { mutableStateOf<ShareDialog?>(null) }
    val sharer = remember(context, scope) { Sharer(context, scope) { dialog = it } }

    when (val current = dialog) {
        null -> Unit
        is ShareDialog.Looking -> AlertDialog(
            onDismissRequest = sharer::cancel,
            text = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 3.dp)
                    Text("Finding the public version of ${current.member.title}…")
                }
            },
            confirmButton = { TextButton(onClick = sharer::cancel) { Text("Cancel") } },
        )
        is ShareDialog.NoPublicShow -> {
            val website = current.member.link
            AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text("This feed is yours alone") },
                text = {
                    Text(
                        "${current.member.title} comes from a members-only feed. Its address works " +
                            "like a password for your subscription, so FilterPod won't put it in a " +
                            "link, and it couldn't find a public version of the show to share instead.",
                    )
                },
                confirmButton = { TextButton(onClick = { dialog = null }) { Text("OK") } },
                dismissButton = website?.let {
                    {
                        TextButton(onClick = { dialog = null; sharer.shareWebsite(current.member, website) }) {
                            Text("Share website")
                        }
                    }
                },
            )
        }
        is ShareDialog.EpisodeNotPublic -> AlertDialog(
            onDismissRequest = { dialog = null },
            title = { Text("Members only") },
            text = {
                Text(
                    "This episode isn't in ${current.public.title}'s public feed, so there's " +
                        "nothing to link to that wouldn't give your subscription away.",
                )
            },
            confirmButton = {
                TextButton(onClick = { dialog = null; sharer.sharePodcast(current.public) }) { Text("Share the show") }
            },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
        )
    }

    return sharer
}

private fun Context.shareEpisode(podcast: Podcast, episode: Episode, atSec: Double? = null) {
    val url = ShareLinks.episodeUrl(podcast.feedUrl, episode.guid, atSec)
    val from = atSec?.takeIf { it >= 1 }?.let { " (from ${timecode(it)})" } ?: ""
    shareText(
        subject = "${episode.title} · ${podcast.title}",
        text = "${episode.title}$from\n$url",
        chooserTitle = "Share episode",
    )
}

private fun Context.sharePodcast(podcast: Podcast) = shareText(
    subject = podcast.title,
    text = "${podcast.title}\n${ShareLinks.podcastUrl(podcast.feedUrl)}",
    chooserTitle = "Share podcast",
)

private fun Context.shareText(subject: String, text: String, chooserTitle: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, text)
        // The share sheet's preview headline.
        putExtra(Intent.EXTRA_TITLE, subject)
    }
    startActivity(
        Intent.createChooser(send, chooserTitle).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}
