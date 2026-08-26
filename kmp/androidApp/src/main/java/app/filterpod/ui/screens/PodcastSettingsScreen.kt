package app.filterpod.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.model.Subscription
import app.filterpod.ui.Ember
import app.filterpod.ui.NavState
import app.filterpod.ui.components.Artwork
import app.filterpod.ui.components.ChoiceChip
import app.filterpod.ui.components.HairlineDivider
import app.filterpod.ui.components.PanelCard
import app.filterpod.ui.components.SectionLabel
import app.filterpod.ui.components.ToggleRow
import kotlinx.coroutines.launch

/**
 * Everything that can differ for one show, in one place.
 *
 * This replaced a three-dots menu whose only item was Filtering. A gear that lands
 * somewhere real scales: per-show speed, intro/outro trims and notifications all
 * belong to the show rather than the app, and none of them wanted to be a menu item.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun PodcastSettingsScreen(nav: NavState, podcastId: String) {
    val app = FilterPodApp.instance
    // Asked for at the moment it is needed — flipping the toggle — rather than at
    // launch, where a permission prompt has no context to justify it.
    val askNotificationPermission = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { }
    val repo = app.repo
    val scope = rememberCoroutineScope()

    val podcast by produceState<Podcast?>(initialValue = null, podcastId) {
        value = repo.getPodcast(podcastId)
    }
    val subscriptions by repo.observeSubscriptions().collectAsState(initial = emptyList())
    val subscription = remember(subscriptions, podcastId) {
        subscriptions.firstOrNull { it.podcastId == podcastId }
    }
    val profiles by produceState(initialValue = emptyList<FilterProfile>()) {
        value = repo.listFilterProfiles()
    }
    val globalSettings by produceState(initialValue = null as app.filterpod.shared.model.Settings?) {
        value = repo.getSettings()
    }

    fun update(change: (Subscription) -> Subscription) {
        val current = subscription ?: return
        scope.launch {
            repo.putSubscription(change(current))
            // Filtering changes must reach anything playing from this show now.
            app.controller.applyProfileChange(podcastId)
        }
    }

    LazyColumn(Modifier.fillMaxSize()) {
        item(key = "topbar") {
            Column {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { nav.pop() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                    SectionLabel("Show settings", Modifier.weight(1f))
                }
                HairlineDivider()
            }
        }

        item(key = "header") {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Artwork(podcast?.artworkUrl, podcast?.title ?: "", Modifier.size(56.dp))
                Text(
                    podcast?.title ?: "",
                    Modifier.padding(start = 12.dp),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (subscription == null) {
            item(key = "unsubscribed") {
                Text(
                    "Subscribe to this show to give it its own settings.",
                    Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            return@LazyColumn
        }

        item(key = "new-episodes") {
            Group("When this show publishes") {
                PanelCard {
                    ToggleRow(
                        title = "Add new episodes to queue",
                        detail = if (subscription.autoQueue == true) {
                            "New episodes join the end of your queue"
                        } else "Off",
                        checked = subscription.autoQueue == true,
                        onChange = { on -> update { it.copy(autoQueue = on) } },
                    )
                    HairlineDivider()
                    ToggleRow(
                        title = "Download new episodes",
                        detail = if (subscription.autoDownload) {
                            "Keeps the latest ${subscription.autoDownloadLimit} filtered and ready"
                        } else "Off",
                        checked = subscription.autoDownload,
                        onChange = { on -> update { it.copy(autoDownload = on) } },
                    )
                    HairlineDivider()
                    ToggleRow(
                        title = "Notify me",
                        detail = if (subscription.notifyOnNew) {
                            "A quiet notification when an episode drops"
                        } else "Off",
                        checked = subscription.notifyOnNew,
                        onChange = { on ->
                            // Ask for the permission at the moment it is needed, not
                            // at launch: the request makes sense here and nowhere else.
                            if (on) app.notifier.ensureChannel()
                            update { it.copy(notifyOnNew = on) }
                            if (on && !app.notifier.canNotify()) {
                                askNotificationPermission.launch(
                                    android.Manifest.permission.POST_NOTIFICATIONS,
                                )
                            }
                        },
                    )
                }
            }
        }

        item(key = "playback") {
            Group("Playback") {
                PanelCard {
                    LabeledChips(
                        title = "Speed",
                        detail = subscription.playbackRate?.let { "${trimRate(it)}× for this show" }
                            ?: "Following the app setting (${trimRate(globalSettings?.playbackRate ?: 1.0)}×)",
                    ) {
                        ChoiceChip("Default", subscription.playbackRate == null, onSelect = {
                            update { it.copy(playbackRate = null) }
                        })
                        for (rate in listOf(0.8, 1.0, 1.2, 1.5, 2.0)) {
                            ChoiceChip("${trimRate(rate)}×", subscription.playbackRate == rate, onSelect = {
                                update { it.copy(playbackRate = rate) }
                            })
                        }
                    }
                    HairlineDivider()
                    LabeledChips(
                        title = "Skip intro",
                        detail = if (subscription.skipIntroSec > 0) {
                            "Starts ${subscription.skipIntroSec}s in, on episodes you have not started"
                        } else "Off",
                    ) {
                        for (sec in TRIM_CHOICES) {
                            ChoiceChip(trimLabel(sec), subscription.skipIntroSec == sec, onSelect = {
                                update { it.copy(skipIntroSec = sec) }
                            })
                        }
                    }
                    HairlineDivider()
                    LabeledChips(
                        title = "Skip outro",
                        detail = if (subscription.skipOutroSec > 0) {
                            "Counts as finished ${subscription.skipOutroSec}s early"
                        } else "Off",
                    ) {
                        for (sec in TRIM_CHOICES) {
                            ChoiceChip(trimLabel(sec), subscription.skipOutroSec == sec, onSelect = {
                                update { it.copy(skipOutroSec = sec) }
                            })
                        }
                    }
                }
            }
        }

        item(key = "filtering") {
            Group("Filtering") {
                PanelCard {
                    LabeledChips(
                        title = "Level",
                        detail = subscription.filterProfileId
                            ?.let { id -> profiles.firstOrNull { it.id == id }?.name }
                            ?.let { "$it for this show" }
                            ?: "Following the app setting",
                    ) {
                        ChoiceChip("Default", subscription.filterProfileId == null, onSelect = {
                            update { it.copy(filterProfileId = null) }
                        })
                        // Strictest first, ending at off — the order people reason in.
                        val order = listOf("family", "standard", "strong-only", "off")
                        for (id in order) {
                            val profile = profiles.firstOrNull { it.id == id } ?: continue
                            ChoiceChip(profile.name, subscription.filterProfileId == id, onSelect = {
                                update { it.copy(filterProfileId = id) }
                            })
                        }
                    }
                    Text(
                        "Takes effect immediately, including anything playing now.",
                        Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        item(key = "tail") { Column(Modifier.padding(bottom = 32.dp)) {} }
    }
}

private val TRIM_CHOICES = listOf(0, 5, 10, 15, 30, 60)

private fun trimLabel(sec: Int) = if (sec == 0) "Off" else "${sec}s"

/** 1.0 -> "1", 1.5 -> "1.5": speeds read better without a trailing zero. */
private fun trimRate(rate: Double): String =
    if (rate == rate.toInt().toDouble()) rate.toInt().toString() else rate.toString()

@Composable
private fun Group(label: String, content: @Composable () -> Unit) {
    Column(Modifier.padding(bottom = 8.dp)) {
        SectionLabel(label, Modifier.padding(start = 16.dp, top = 8.dp, bottom = 6.dp))
        content()
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun LabeledChips(
    title: String,
    detail: String,
    chips: @Composable () -> Unit,
) {
    Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
        Text(title, style = MaterialTheme.typography.bodyLarge)
        Text(
            detail,
            Modifier.padding(top = 2.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        androidx.compose.foundation.layout.FlowRow(
            Modifier.padding(top = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) { chips() }
    }
}
