package app.filterpod.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.filterpod.shared.model.Download
import app.filterpod.shared.model.DownloadState
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Progress
import app.filterpod.ui.Ember
import app.filterpod.ui.durationLabel
import app.filterpod.ui.relativeDate
import app.filterpod.ui.timecode

/**
 * One episode in a list — the Compose port of src/ui/EpisodeRow.tsx.
 *
 * Play is always the primary action; queueing and played-ness toggle, and toggling
 * says so by filling in. Listening progress shows once there is something to resume.
 */
@Composable
fun EpisodeRow(
    episode: Episode,
    progress: Progress?,
    queued: Boolean,
    isCurrent: Boolean,
    download: Download?,
    onPlay: () -> Unit,
    onToggleQueue: () -> Unit,
    onTogglePlayed: () -> Unit,
    /** Tap-to-expand: full title and description for rows that want reading room. */
    expanded: Boolean = false,
    onToggleExpand: (() -> Unit)? = null,
) {
    val played = progress?.played == true
    val listened =
        if (progress != null && progress.durationSec > 0) progress.positionSec / progress.durationSec
        else 0.0

    Box(
        Modifier
            .fillMaxWidth()
            .background(if (isCurrent) Ember.copy(alpha = 0.05f) else Color.Transparent)
            .then(
                if (onToggleExpand != null) {
                    Modifier
                        .clickable(onClick = onToggleExpand)
                        .animateContentSize()
                } else Modifier,
            ),
    ) {
        if (isCurrent) {
            Box(Modifier.matchParentSize()) {
                Box(
                    Modifier
                        .width(2.dp)
                        .fillMaxHeight()
                        .background(Ember),
                )
            }
        }
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionLabel(relativeDate(episode.publishedAt))
                Text("·", color = MaterialTheme.colorScheme.outline)
                Text(
                    durationLabel(episode.durationSec),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (played) {
                    Text("·", color = MaterialTheme.colorScheme.outline)
                    Icon(
                        Icons.Filled.Check, null,
                        Modifier.size(12.dp),
                        tint = MaterialTheme.colorScheme.secondary,
                    )
                    Text(
                        "Played",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
            }

            Text(
                episode.title,
                Modifier.padding(top = 6.dp),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = if (expanded) Int.MAX_VALUE else 2,
                overflow = TextOverflow.Ellipsis,
            )

            if (episode.description.isNotBlank()) {
                Text(
                    episode.description,
                    Modifier.padding(top = 4.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (expanded) Int.MAX_VALUE else 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            // Resume indicator, only once there is something to resume.
            if (!played && listened > 0.01 && progress != null) {
                Row(
                    Modifier.padding(top = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ThinProgressBar(
                        listened.toFloat(),
                        Modifier.weight(1f),
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    Text(
                        "${timecode(progress.durationSec - progress.positionSec)} left",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (download?.state == DownloadState.DOWNLOADING && download.bytesTotal > 0) {
                Box(Modifier.padding(top = 10.dp)) {
                    ThinProgressBar((download.bytesDownloaded.toDouble() / download.bytesTotal).toFloat())
                }
            }

            Row(
                Modifier.padding(top = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = onPlay,
                    contentPadding = ButtonDefaults.ButtonWithIconContentPadding,
                    colors = ButtonDefaults.buttonColors(containerColor = Ember, contentColor = Color(0xFF15100B)),
                ) {
                    Icon(Icons.Filled.PlayArrow, null, Modifier.size(16.dp))
                    Text("Play", Modifier.padding(start = 4.dp))
                }

                // Queueing toggles, and says so by filling in when queued.
                ToggleIconButton(
                    checked = queued,
                    icon = Icons.AutoMirrored.Filled.List,
                    label = if (queued) "Remove from queue" else "Add to queue",
                    onClick = onToggleQueue,
                )

                // Played toggles too: "played" can be wrong, and a state the user
                // cannot correct stops being trusted.
                ToggleIconButton(
                    checked = played,
                    icon = Icons.Filled.Check,
                    label = if (played) "Mark as unplayed" else "Mark as played",
                    onClick = onTogglePlayed,
                )

                when (download?.state) {
                    DownloadState.DOWNLOADED -> Pill("Saved", tone = PillTone.Sage)
                    DownloadState.DOWNLOADING -> Pill("Saving…", tone = PillTone.Neutral)
                    else -> {
                        // Downloading is a way to keep an episode offline, not a
                        // precondition for playing — streaming is the default.
                        val app = app.filterpod.FilterPodApp.instance
                        ToggleIconButton(
                            checked = false,
                            icon = Icons.Filled.KeyboardArrowDown,
                            label = "Download",
                            onClick = { app.downloader.start(episode.id, episode.audioUrl) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ToggleIconButton(
    checked: Boolean,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    OutlinedIconButton(
        onClick = onClick,
        colors = IconButtonDefaults.outlinedIconButtonColors(
            containerColor = if (checked) Ember else Color.Transparent,
            contentColor = if (checked) Color(0xFF15100B) else MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    ) {
        Icon(icon, label, Modifier.size(18.dp))
    }
}
