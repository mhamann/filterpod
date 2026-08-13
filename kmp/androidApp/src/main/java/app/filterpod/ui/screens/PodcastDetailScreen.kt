package app.filterpod.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.model.Subscription
import app.filterpod.ui.Ember
import app.filterpod.ui.FeedRefresh
import app.filterpod.ui.NavState
import app.filterpod.ui.Screen
import app.filterpod.ui.components.Artwork
import app.filterpod.ui.components.EpisodeRow
import app.filterpod.ui.components.HairlineDivider
import app.filterpod.ui.components.PanelCard
import app.filterpod.ui.components.Pill
import app.filterpod.ui.components.PillTone
import app.filterpod.ui.components.RefreshBox
import app.filterpod.ui.components.SectionLabel
import app.filterpod.ui.components.ToggleRow
import kotlinx.coroutines.launch

private const val PAGE_SIZE = 30

/** How long a feed must fail before the show page says so. One flaky refresh is not news. */
private const val STALE_FEED_MS = 24 * 60 * 60 * 1000L

/**
 * The show page: header, subscribe, per-show controls, and the episode list.
 * Port of src/app/screens/PodcastDetail.tsx.
 */
@Composable
fun PodcastDetailScreen(nav: NavState, podcastId: String) {
    val app = FilterPodApp.instance
    val repo = app.repo
    val controller = app.controller
    val scope = rememberCoroutineScope()

    var limit by rememberSaveable { mutableIntStateOf(PAGE_SIZE) }
    var busy by remember { mutableStateOf(false) }

    /**
     * A failure from a refresh the user asked for, shown immediately — distinct from
     * podcast.lastFetchError, which only earns a banner after a day of failures.
     */
    var manualError by remember { mutableStateOf<String?>(null) }

    // The podcast row has no observe API; re-read after actions that change it.
    var podcastTick by remember { mutableIntStateOf(0) }
    val podcast by produceState<Podcast?>(initialValue = null, podcastId, podcastTick) {
        value = repo.getPodcast(podcastId)
    }

    val subscriptions by repo.observeSubscriptions().collectAsState(initial = emptyList())
    val subscription = remember(subscriptions) { subscriptions.firstOrNull { it.podcastId == podcastId } }

    val episodes by repo.observeEpisodes(podcastId, limit = 1000).collectAsState(initial = emptyList())
    val shown = remember(episodes, limit) { episodes.take(limit) }

    val progressRows by repo.observeProgress().collectAsState(initial = emptyList())
    val progressById = remember(progressRows) { progressRows.associateBy { it.episodeId } }
    val queue by repo.observeQueue().collectAsState(initial = emptyList())
    val queuedIds = remember(queue) { queue.map { it.episodeId }.toSet() }
    val downloads by repo.observeDownloads().collectAsState(initial = emptyList())
    val downloadsById = remember(downloads) { downloads.associateBy { it.episodeId } }
    val playerState by controller.state.collectAsState()

    val current = podcast
    if (current == null) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("This show is not in your library.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { nav.selectTab(Screen.Discover()) }) { Text("Search for it", color = Ember) }
        }
        return
    }

    val profiles by produceState(initialValue = emptyList<FilterProfile>()) {
        value = repo.listFilterProfiles()
    }
    var showFilteringDialog by remember { mutableStateOf(false) }

    RefreshBox(onRefresh = {
        manualError = FeedRefresh.refresh(repo, app.http, current)
        podcastTick++
    }) {
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "topbar") {
                Column {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 4.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { nav.pop() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                        }
                        SectionLabel(current.author, Modifier.weight(1f))
                        // The "More" menu: home of the per-show Filtering control —
                        // a set-once escape hatch, deliberately not inline.
                        var menuOpen by remember { mutableStateOf(false) }
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Filled.MoreVert, "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Filtering…") },
                                onClick = {
                                    menuOpen = false
                                    showFilteringDialog = true
                                },
                            )
                        }
                    }
                    HairlineDivider()
                }
            }

            item(key = "header") {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    Row(Modifier.padding(top = 16.dp)) {
                        Artwork(current.artworkUrl, current.title, Modifier.size(104.dp))
                        Column(Modifier.padding(start = 16.dp)) {
                            Text(current.title, style = MaterialTheme.typography.titleLarge)
                            Text(
                                current.author,
                                Modifier.padding(top = 4.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Row(
                                Modifier.padding(top = 10.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Pill("${episodes.size} episodes")
                                if (current.explicit) Pill("Explicit feed", tone = PillTone.Ember)
                            }
                        }
                    }

                    Row(Modifier.padding(top = 16.dp)) {
                        if (subscription != null) {
                            OutlinedButton(
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        try {
                                            repo.unsubscribe(podcastId)
                                        } finally {
                                            busy = false
                                        }
                                    }
                                },
                                enabled = !busy,
                            ) {
                                Icon(Icons.Filled.Check, null, Modifier.size(15.dp))
                                Text("Subscribed", Modifier.padding(start = 6.dp))
                            }
                        } else {
                            Button(
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        try {
                                            repo.subscribe(podcastId, now = System.currentTimeMillis())
                                            FeedRefresh.refresh(repo, app.http, current)
                                            podcastTick++
                                        } finally {
                                            busy = false
                                        }
                                    }
                                },
                                enabled = !busy,
                                colors = ButtonDefaults.buttonColors(containerColor = Ember, contentColor = Color(0xFF15100B)),
                            ) {
                                Icon(Icons.Filled.Add, null, Modifier.size(15.dp))
                                Text("Subscribe", Modifier.padding(start = 6.dp))
                            }
                        }
                    }

                    // Two tiers of refresh trouble: a failure from a pull the user just
                    // made is answered immediately; background failures only earn the
                    // banner after a full day without a successful fetch.
                    val staleBanner = manualError == null &&
                        current.lastFetchError != null &&
                        current.lastSuccessAt != null &&
                        System.currentTimeMillis() - current.lastSuccessAt!! > STALE_FEED_MS
                    if (manualError != null) {
                        ErrorBanner("Refresh failed: $manualError")
                    } else if (staleBanner) {
                        val since = java.text.DateFormat.getDateInstance(java.text.DateFormat.SHORT)
                            .format(java.util.Date(current.lastSuccessAt!!))
                        ErrorBanner("This feed has not refreshed successfully since $since: ${current.lastFetchError}")
                    }

                    if (current.description.isNotBlank()) {
                        Description(current.description)
                    }
                }
            }

            if (subscription != null) {
                item(key = "controls") {
                    // Queue-first, deliberately: the queue toggle is the one people mean.
                    NewEpisodeControls(
                        subscription = subscription,
                        onUpdate = { updated -> scope.launch { repo.putSubscription(updated) } },
                    )
                }
            }

            item(key = "list-divider") { HairlineDivider(Modifier.padding(top = 16.dp)) }

            items(count = shown.size, key = { shown[it].id }) { index ->
                val episode = shown[index]
                Column {
                    EpisodeRow(
                        episode = episode,
                        progress = progressById[episode.id],
                        queued = episode.id in queuedIds,
                        isCurrent = playerState.episode?.id == episode.id,
                        download = downloadsById[episode.id],
                        onPlay = { controller.openAsync(episode.id) },
                        onToggleQueue = {
                            scope.launch {
                                if (episode.id in queuedIds) repo.removeFromQueue(episode.id)
                                else repo.enqueueEpisode(episode.id, now = System.currentTimeMillis())
                            }
                        },
                        onTogglePlayed = {
                            scope.launch {
                                val next = progressById[episode.id]?.played != true
                                repo.setPlayed(episode.id, next, now = System.currentTimeMillis())
                                // Marking done is finishing by decree; it leaves the
                                // queue the same way a finished episode does.
                                if (next) repo.removeFromQueue(episode.id)
                            }
                        },
                    )
                    HairlineDivider()
                }
            }

            if (shown.size < episodes.size) {
                item(key = "more") {
                    OutlinedButton(
                        onClick = { limit += PAGE_SIZE },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) { Text("Show more") }
                }
            }
        }
    }

    if (showFilteringDialog) {
        FilteringDialog(
            profiles = profiles,
            overrideId = subscription?.filterProfileId,
            subscribed = subscription != null,
            onDismiss = { showFilteringDialog = false },
            onSelect = { profileId ->
                showFilteringDialog = false
                val sub = subscription ?: return@FilteringDialog
                scope.launch {
                    repo.putSubscription(sub.copy(filterProfileId = profileId))
                    // Re-tunes the live filter if this show is what's playing — a
                    // changed setting that quietly waited for the next episode would
                    // read as a broken one.
                    controller.applyProfileChange(podcastId)
                }
            },
        )
    }
}

@Composable
private fun ErrorBanner(text: String) {
    Text(
        text,
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.1f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
    )
}

/** Long show descriptions get a clamp with an expander. */
@Composable
private fun Description(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val isLong = text.length > 180
    Column(Modifier.padding(top = 16.dp)) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (expanded || !isLong) Int.MAX_VALUE else 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (isLong) {
            Text(
                if (expanded) "Less" else "More",
                Modifier
                    .clickable { expanded = !expanded }
                    .padding(vertical = 4.dp),
                style = MaterialTheme.typography.labelMedium,
                color = Ember,
            )
        }
    }
}

/**
 * What happens when this show publishes: join the queue, and/or download.
 * Queue first — that toggle is the distinction people actually mean by "subscribe".
 */
@Composable
private fun NewEpisodeControls(
    subscription: Subscription,
    onUpdate: (Subscription) -> Unit,
) {
    PanelCard(Modifier.padding(horizontal = 16.dp, vertical = 16.dp)) {
        ToggleRow(
            title = "Add new episodes to queue",
            detail = if (subscription.autoQueue == true) "New episodes join the end of your queue" else "Off",
            checked = subscription.autoQueue == true,
            onChange = { onUpdate(subscription.copy(autoQueue = it)) },
        )
        HairlineDivider()
        ToggleRow(
            title = "Download new episodes",
            detail = if (subscription.autoDownload) {
                "Keeps the latest ${subscription.autoDownloadLimit} filtered and ready"
            } else "Off",
            checked = subscription.autoDownload,
            onChange = { onUpdate(subscription.copy(autoDownload = it)) },
        )
    }
}

/**
 * Per-show filter level, overriding the app-wide setting — for shows where the
 * wordlist misfires on context. "Default" clears the override.
 */
@Composable
private fun FilteringDialog(
    profiles: List<FilterProfile>,
    overrideId: String?,
    subscribed: Boolean,
    onDismiss: () -> Unit,
    onSelect: (String?) -> Unit,
) {
    // Seeded order, not table order: strictest to off, with Default leading.
    val orderIds = listOf("family", "standard", "strong-only", "off")
    val ordered = remember(profiles) {
        profiles.sortedBy { orderIds.indexOf(it.id).let { i -> if (i < 0) orderIds.size else i } }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Filtering for this show") },
        text = {
            Column {
                if (!subscribed) {
                    Text(
                        "Subscribe to this show to set a per-show filter level.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    ProfileChoiceRow("Default (app setting)", overrideId == null) { onSelect(null) }
                    for (profile in ordered) {
                        ProfileChoiceRow(profile.name, overrideId == profile.id) { onSelect(profile.id) }
                    }
                    Text(
                        "Takes effect immediately, including anything playing now.",
                        Modifier.padding(top = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

@Composable
private fun ProfileChoiceRow(label: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onSelect)
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
        )
    }
}
