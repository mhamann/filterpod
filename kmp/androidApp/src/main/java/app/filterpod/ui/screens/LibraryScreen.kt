package app.filterpod.ui.screens

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import app.filterpod.FilterPodApp
import app.filterpod.ui.FeedRefresh
import app.filterpod.ui.Screen
import app.filterpod.ui.NavState
import app.filterpod.ui.Ember
import app.filterpod.ui.components.Artwork
import app.filterpod.ui.components.EmptyState
import app.filterpod.ui.components.QueueBadgeButton
import app.filterpod.ui.components.RefreshBox
import app.filterpod.ui.components.ScreenHeader
import app.filterpod.ui.components.SectionLabel
import app.filterpod.ui.components.gridReorder
import app.filterpod.ui.components.rememberGridReorderState
import app.filterpod.ui.timecode
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import kotlinx.coroutines.launch

/**
 * Home: pick up where you left off, or pick a show. Nothing else.
 * Port of src/app/screens/Library.tsx.
 */
@Composable
fun LibraryScreen(nav: NavState) {
    val app = FilterPodApp.instance
    val repo = app.repo
    val controller = app.controller
    val scope = rememberCoroutineScope()
    val view = LocalView.current

    var query by rememberSaveable { mutableStateOf("") }
    val trimmed = query.trim().lowercase()

    val subscriptions by repo.observeSubscriptions().collectAsState(initial = emptyList())
    val queue by repo.observeQueue().collectAsState(initial = emptyList())
    val progressRows by repo.observeProgress().collectAsState(initial = emptyList())
    val playerState by controller.state.collectAsState()

    // Arranged rows first, in their arranged order; the rest by recency.
    val orderedSubs = remember(subscriptions) {
        subscriptions.sortedWith(
            compareBy<app.filterpod.shared.model.Subscription> { it.sortOrder ?: Int.MAX_VALUE }
                .thenByDescending { it.subscribedAt },
        )
    }
    val podcastsById by produceState(initialValue = emptyMap<String, Podcast>(), orderedSubs) {
        value = repo.listPodcasts().associateBy { it.id }
    }

    // The local visual order: what the grid renders, and what a drag rearranges.
    val localOrder = remember { mutableStateListOf<Podcast>() }
    val gridState = rememberLazyGridState()
    val reorder = rememberGridReorderState(
        gridState = gridState,
        keyForTile = { index -> "tile:${localOrder[index].id}" },
        tileIndexForKey = { key ->
            val id = (key as? String)?.removePrefix("tile:")?.takeIf { key.startsWith("tile:") }
            if (id == null) -1 else localOrder.indexOfFirst { it.id == id }
        },
        onMove = { from, to ->
            if (from in localOrder.indices && to in localOrder.indices) {
                localOrder.add(to, localOrder.removeAt(from))
            }
        },
        onDrop = {
            // Persist the arrangement: dense sortOrder in the order shown.
            val ids = localOrder.map { it.id }
            scope.launch { repo.setLibraryOrder(ids) }
        },
        haptic = { view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) },
    )
    LaunchedEffect(orderedSubs, podcastsById) {
        if (reorder.draggingKey == null) {
            localOrder.clear()
            localOrder.addAll(orderedSubs.mapNotNull { podcastsById[it.podcastId] })
        }
    }

    // The search filters what is already here; substring on title or author.
    val visibleShows by remember(trimmed) {
        derivedStateOf {
            if (trimmed.isEmpty()) localOrder.toList()
            else localOrder.filter {
                it.title.lowercase().contains(trimmed) || it.author.lowercase().contains(trimmed)
            }
        }
    }

    // Continue listening: recent unfinished rows, minus what the mini player shows.
    val currentEpisodeId = playerState.episode?.id
    val continueRows = remember(progressRows, currentEpisodeId) {
        progressRows
            .filter { !it.played && it.positionSec > 5 && it.episodeId != currentEpisodeId }
            .sortedByDescending { it.lastPlayedAt }
            .take(2)
    }
    val continueEpisodes by produceState(initialValue = emptyMap<String, Episode>(), continueRows) {
        value = continueRows.mapNotNull { repo.getEpisode(it.episodeId) }.associateBy { it.id }
    }

    val reorderEnabled = trimmed.isEmpty() && localOrder.size >= 2

    RefreshBox(onRefresh = { FeedRefresh.refreshAll(repo, app.http) }) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            state = gridState,
            modifier = Modifier
                .fillMaxSize()
                .gridReorder(reorder, enabled = reorderEnabled),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 16.dp, end = 16.dp, bottom = 24.dp,
            ),
        ) {
            item(key = "header", span = { GridItemSpan(maxLineSpan) }) {
                Box(Modifier.padding(start = 0.dp)) {
                    ScreenHeader("Library") {
                        QueueBadgeButton(queue.size) { nav.selectTab(Screen.Queue) }
                    }
                }
            }

            if (subscriptions.isNotEmpty()) {
                item(key = "search", span = { GridItemSpan(maxLineSpan) }) {
                    LibrarySearchField(query, onChange = { query = it })
                }
            }

            if (subscriptions.isEmpty()) {
                item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                    EmptyState(
                        icon = Icons.Filled.Home,
                        title = "Nothing here yet",
                        body = "Find a show and FilterPod will cut the language before you hear it.",
                    ) {
                        Button(
                            onClick = { nav.selectTab(Screen.Discover()) },
                            colors = ButtonDefaults.buttonColors(containerColor = Ember, contentColor = Color(0xFF15100B)),
                        ) {
                            Icon(Icons.Filled.Search, null, Modifier.size(16.dp))
                            Text("Find a podcast", Modifier.padding(start = 6.dp))
                        }
                    }
                }
            } else {
                if (trimmed.isEmpty() && continueRows.isNotEmpty()) {
                    item(key = "continue-label", span = { GridItemSpan(maxLineSpan) }) {
                        SectionLabel("Continue", Modifier.padding(top = 4.dp))
                    }
                    items(
                        count = continueRows.size,
                        key = { "continue:${continueRows[it].episodeId}" },
                        span = { GridItemSpan(maxLineSpan) },
                    ) { index ->
                        val row = continueRows[index]
                        val episode = continueEpisodes[row.episodeId]
                        if (episode != null) {
                            ContinueCard(
                                title = episode.title,
                                remainingSec = row.durationSec - row.positionSec,
                                onClick = { controller.openAsync(episode.id) },
                            )
                        }
                    }
                }

                item(key = "shows-label", span = { GridItemSpan(maxLineSpan) }) {
                    SectionLabel("Shows", Modifier.padding(top = 4.dp))
                }

                items(
                    count = visibleShows.size,
                    key = { "tile:${visibleShows[it].id}" },
                ) { index ->
                    val podcast = visibleShows[index]
                    val tileKey = "tile:${podcast.id}"
                    val dragging = reorder.draggingKey == tileKey
                    Column(
                        Modifier
                            .then(if (dragging) Modifier.zIndex(1f) else Modifier.animateItem())
                            .graphicsLayer {
                                val t = reorder.translationFor(tileKey)
                                if (t != null) {
                                    translationX = t.x
                                    translationY = t.y
                                    scaleX = 1.05f
                                    scaleY = 1.05f
                                    alpha = 0.92f
                                }
                            }
                            .clip(RoundedCornerShape(10.dp))
                            .clickable {
                                if (System.currentTimeMillis() > reorder.suppressClicksUntil) {
                                    nav.push(Screen.PodcastDetail(podcast.id))
                                }
                            },
                    ) {
                        Artwork(
                            podcast.artworkUrl,
                            podcast.title,
                            Modifier
                                .fillMaxWidth()
                                .aspectRatio(1f),
                        )
                        Text(
                            podcast.title,
                            Modifier.padding(top = 6.dp),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                if (trimmed.isNotEmpty()) {
                    item(key = "search-jump", span = { GridItemSpan(maxLineSpan) }) {
                        Column {
                            if (visibleShows.isEmpty()) {
                                Text(
                                    "Nothing in your library matches.",
                                    Modifier.padding(bottom = 8.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            OutlinedButton(
                                onClick = { nav.selectTab(Screen.Discover(initialTerm = query.trim())) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(Icons.Filled.Search, null, Modifier.size(16.dp))
                                Text(
                                    "Search everywhere for “${query.trim()}”",
                                    Modifier.padding(start = 6.dp),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LibrarySearchField(query: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = query,
        onValueChange = onChange,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp),
        placeholder = { Text("Find a show") },
        leadingIcon = { Icon(Icons.Filled.Search, null, Modifier.size(18.dp)) },
        trailingIcon = {
            if (query.isNotEmpty()) {
                IconButton(onClick = { onChange("") }) {
                    Icon(Icons.Filled.Close, "Clear", Modifier.size(16.dp))
                }
            }
        },
        singleLine = true,
        shape = RoundedCornerShape(50),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Ember.copy(alpha = 0.5f),
            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
        ),
    )
}

@Composable
private fun ContinueCard(title: String, remainingSec: Double, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(Ember),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.PlayArrow, "Play", Modifier.size(20.dp), tint = Color(0xFF15100B))
        }
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${timecode(remainingSec)} left",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
