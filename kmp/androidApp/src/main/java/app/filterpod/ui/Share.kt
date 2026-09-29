package app.filterpod.ui

import android.content.Context
import android.content.Intent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.share.ShareLinks

/**
 * Hands a filterpod.app link to the system share sheet.
 *
 * The text is the title and the link on its own line: chat apps unfurl the link into
 * a card with the artwork, and anything that doesn't still gets a readable message.
 *
 * A members-only feed is never shared. Its URL is the subscriber's credential, and a
 * share link carries the feed URL — so for those, the listener is told why instead,
 * and offered the show's website when the feed names one.
 */
class Sharer internal constructor(
    private val context: Context,
    private val onPrivateFeed: (Podcast) -> Unit,
) {
    fun episode(podcast: Podcast, episode: Episode, atSec: Double? = null) {
        if (ShareLinks.isPrivateFeed(podcast.feedUrl)) return onPrivateFeed(podcast)
        val url = ShareLinks.episodeUrl(podcast.feedUrl, episode.guid, atSec)
        val from = atSec?.takeIf { it >= 1 }?.let { " (from ${timecode(it)})" } ?: ""
        context.shareText(
            subject = "${episode.title} · ${podcast.title}",
            text = "${episode.title}$from\n$url",
            chooserTitle = "Share episode",
        )
    }

    fun podcast(podcast: Podcast) {
        if (ShareLinks.isPrivateFeed(podcast.feedUrl)) return onPrivateFeed(podcast)
        context.shareText(
            subject = podcast.title,
            text = "${podcast.title}\n${ShareLinks.podcastUrl(podcast.feedUrl)}",
            chooserTitle = "Share podcast",
        )
    }
}

@Composable
fun rememberSharer(): Sharer {
    val context = LocalContext.current
    var privateFeed by remember { mutableStateOf<Podcast?>(null) }

    privateFeed?.let { podcast ->
        val website = podcast.link
        AlertDialog(
            onDismissRequest = { privateFeed = null },
            title = { Text("This feed is yours alone") },
            text = {
                Text(
                    "${podcast.title} comes from a members-only feed. Its address works like " +
                        "a password for your subscription, so FilterPod won't put it in a link.",
                )
            },
            confirmButton = {
                TextButton(onClick = { privateFeed = null }) { Text("OK") }
            },
            dismissButton = website?.let {
                {
                    TextButton(
                        onClick = {
                            privateFeed = null
                            context.shareText(podcast.title, "${podcast.title}\n$website", "Share website")
                        },
                    ) { Text("Share website") }
                }
            },
        )
    }

    return remember(context) { Sharer(context) { privateFeed = it } }
}

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
