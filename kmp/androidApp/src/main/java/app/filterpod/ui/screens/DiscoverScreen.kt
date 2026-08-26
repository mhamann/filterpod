package app.filterpod.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.data.podcastIdFor
import app.filterpod.shared.discovery.Discovery
import app.filterpod.shared.discovery.SearchResult
import app.filterpod.shared.model.Podcast
import app.filterpod.ui.Ember
import app.filterpod.ui.FeedRefresh
import app.filterpod.ui.NavState
import app.filterpod.ui.Screen
import app.filterpod.ui.components.Artwork
import app.filterpod.ui.components.EmptyState
import app.filterpod.ui.components.HairlineDivider
import app.filterpod.ui.components.ScreenHeader
import app.filterpod.ui.components.SectionLabel
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Search by name, paste a feed URL, or pick from the charts below.
 * Port of src/app/screens/Discover.tsx.
 */
@OptIn(FlowPreview::class)
@Composable
fun DiscoverScreen(nav: NavState, initialTerm: String, discovery: Discovery) {
    val app = FilterPodApp.instance
    val repo = app.repo
    val scope = rememberCoroutineScope()

    // A search started on the Library lands here with its term intact. The screen
    // instance survives tab flips, so a term handed later must also take effect —
    // but an empty hand-off (a plain tab tap) never clobbers what was typed.
    var term by rememberSaveable { mutableStateOf(initialTerm) }
    LaunchedEffect(initialTerm) {
        if (initialTerm.isNotEmpty()) term = initialTerm
    }
    var results by remember { mutableStateOf<List<SearchResult>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val subscriptions by repo.observeSubscriptions().collectAsState(initial = emptyList())
    val subscribedIds = remember(subscriptions) { subscriptions.map { it.podcastId }.toSet() }

    val looksLikeUrl = remember(term) { Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(term.trim()) }

    // Debounced search: iTunes rate-limits, and typing should not burn that budget.
    LaunchedEffect(Unit) {
        snapshotFlow { term.trim() }
            .debounce(350)
            .distinctUntilChanged()
            .collect { query ->
                if (query.length < 2 || Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(query)) {
                    results = emptyList()
                    return@collect
                }
                busy = true
                error = null
                try {
                    results = discovery.searchPodcasts(query)
                } catch (t: Throwable) {
                    error = t.message ?: "Search failed"
                } finally {
                    busy = false
                }
            }
    }

    /** Persists the show and subscribes; the feed refresh seam fills in episodes. */
    fun addPodcast(podcast: Podcast) {
        scope.launch {
            busy = true
            error = null
            try {
                repo.upsertPodcast(podcast)
                repo.subscribe(podcast.id, now = System.currentTimeMillis())
                FeedRefresh.refresh(repo, app.http, podcast)
                nav.push(Screen.PodcastDetail(podcast.id))
            } catch (t: Throwable) {
                error = t.message ?: "Could not add this show"
            } finally {
                busy = false
            }
        }
    }

    /** Opens a show without subscribing: the show page opens with a Subscribe button. */
    fun previewPodcast(podcast: Podcast) {
        scope.launch {
            busy = true
            error = null
            try {
                repo.upsertPodcast(podcast)
                FeedRefresh.refresh(repo, app.http, podcast)
                nav.push(Screen.PodcastDetail(podcast.id))
            } catch (t: Throwable) {
                error = t.message ?: "Could not open this show"
            } finally {
                busy = false
            }
        }
    }

    fun addRawFeed(feedUrl: String) {
        val host = runCatching { java.net.URI(feedUrl).host }.getOrNull() ?: feedUrl
        addPodcast(Podcast(id = podcastIdFor(feedUrl), feedUrl = feedUrl, title = host))
    }

    // Charts, shown while the search box is empty; session-cached inside Discovery.
    val chart by produceState<ChartState>(initialValue = ChartState.Loading) {
        value = try {
            ChartState.Loaded(discovery.fetchTopPodcasts())
        } catch (t: Throwable) {
            ChartState.Failed
        }
    }

    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        modifier = Modifier.fillMaxSize(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
    ) {
        item(key = "header", span = { GridItemSpan(maxLineSpan) }) {
            ScreenHeader("Discover", containerInset = 16.dp)
        }

        item(key = "search", span = { GridItemSpan(maxLineSpan) }) {
            Column {
                OutlinedTextField(
                    value = term,
                    onValueChange = { term = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Search shows, or paste an RSS URL") },
                    leadingIcon = { Icon(Icons.Filled.Search, null, Modifier.size(18.dp)) },
                    trailingIcon = {
                        if (term.isNotEmpty()) {
                            IconButton(onClick = { term = "" }) {
                                Icon(Icons.Filled.Close, "Clear search", Modifier.size(16.dp))
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

                if (looksLikeUrl) {
                    Button(
                        onClick = { addRawFeed(term.trim()) },
                        enabled = !busy,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Ember, contentColor = Color(0xFF15100B)),
                    ) {
                        Icon(Icons.Filled.Add, null, Modifier.size(16.dp))
                        Text(if (busy) "Loading feed…" else "Add this feed", Modifier.padding(start = 6.dp))
                    }
                }

                error?.let {
                    Text(
                        it,
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
            }
        }

        if (term.isEmpty()) {
            when (val state = chart) {
                ChartState.Loading -> item(key = "chart-loading", span = { GridItemSpan(maxLineSpan) }) {
                    SectionLabel("Loading popular shows…")
                }
                ChartState.Failed -> item(key = "chart-failed", span = { GridItemSpan(maxLineSpan) }) {
                    // Offline, or the chart is unreachable: fall back to the old prompt
                    // quietly rather than parking an error on a browse screen.
                    EmptyState(
                        icon = Icons.Filled.Search,
                        title = "Find something to listen to",
                        body = "Search by show name, or paste an RSS feed URL if you already have one.",
                    )
                }
                is ChartState.Loaded -> {
                    if (state.shows.isEmpty()) {
                        item(key = "chart-empty", span = { GridItemSpan(maxLineSpan) }) {
                            EmptyState(
                                icon = Icons.Filled.Search,
                                title = "Find something to listen to",
                                body = "Search by show name, or paste an RSS feed URL if you already have one.",
                            )
                        }
                    } else {
                        item(key = "popular-label", span = { GridItemSpan(maxLineSpan) }) {
                            SectionLabel("Popular")
                        }
                        items(count = state.shows.size, key = { "chart:${state.shows[it].id}" }) { index ->
                            val show = state.shows[index]
                            ChartTile(
                                show = show,
                                subscribed = show.id in subscribedIds,
                                enabled = !busy,
                                onOpen = { previewPodcast(show) },
                                onAdd = { addPodcast(show) },
                                onOpenSubscribed = { nav.push(Screen.PodcastDetail(show.id)) },
                            )
                        }
                    }
                }
            }
        }

        if (busy && !looksLikeUrl && term.isNotEmpty()) {
            item(key = "searching", span = { GridItemSpan(maxLineSpan) }) {
                SectionLabel("Searching…")
            }
        }

        items(count = results.size, key = { "result:${results[it].podcast.id}" }, span = { GridItemSpan(maxLineSpan) }) { index ->
            val result = results[index]
            val podcast = result.podcast
            Column {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !busy) { previewPodcast(podcast) }
                        .padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Artwork(podcast.artworkUrl, podcast.title, Modifier.size(56.dp))
                    Column(
                        Modifier
                            .weight(1f)
                            .padding(horizontal = 12.dp),
                    ) {
                        Text(
                            podcast.title,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            podcast.author,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (podcast.id in subscribedIds) {
                        OutlinedButton(onClick = { nav.push(Screen.PodcastDetail(podcast.id)) }) {
                            Icon(Icons.Filled.Check, null, Modifier.size(14.dp))
                            Text("Added", Modifier.padding(start = 4.dp))
                        }
                    } else {
                        OutlinedButton(onClick = { addPodcast(podcast) }, enabled = !busy) {
                            Icon(Icons.Filled.Add, null, Modifier.size(14.dp))
                            Text("Add", Modifier.padding(start = 4.dp))
                        }
                    }
                }
                HairlineDivider()
            }
        }
    }
}

private sealed interface ChartState {
    data object Loading : ChartState
    data object Failed : ChartState
    data class Loaded(val shows: List<Podcast>) : ChartState
}

/** A chart tile is a look, not a commitment: it opens the show page; the corner badge subscribes. */
@Composable
private fun ChartTile(
    show: Podcast,
    subscribed: Boolean,
    enabled: Boolean,
    onOpen: () -> Unit,
    onAdd: () -> Unit,
    onOpenSubscribed: () -> Unit,
) {
    Column(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onOpen),
    ) {
        Box {
            Artwork(
                show.artworkUrl,
                show.title,
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f),
            )
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(6.dp)
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(
                        if (subscribed) MaterialTheme.colorScheme.secondary
                        else Color.Black.copy(alpha = 0.65f),
                    )
                    .clickable(enabled = enabled) { if (subscribed) onOpenSubscribed() else onAdd() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (subscribed) Icons.Filled.Check else Icons.Filled.Add,
                    if (subscribed) "Open ${show.title}" else "Subscribe to ${show.title}",
                    Modifier.size(15.dp),
                    tint = if (subscribed) Color(0xFF0E1510) else Color.White,
                )
            }
        }
        Text(
            show.title,
            Modifier.padding(top = 6.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
