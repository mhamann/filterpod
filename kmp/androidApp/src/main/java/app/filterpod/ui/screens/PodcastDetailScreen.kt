package app.filterpod.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import app.filterpod.ui.Ember
import app.filterpod.ui.FeedRefresh
import app.filterpod.ui.NavState
import app.filterpod.ui.Screen
import app.filterpod.ui.components.Artwork
import app.filterpod.ui.components.EpisodeRow
import app.filterpod.ui.components.HairlineDivider
import app.filterpod.ui.components.linkified
import app.filterpod.ui.components.Pill
import app.filterpod.ui.components.PillTone
import app.filterpod.ui.components.RefreshBox
import app.filterpod.ui.components.SectionLabel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val PAGE_SIZE = 30

/** How long a feed must fail before the show page says so. One flaky refresh is not news. */
private const val STALE_FEED_MS = 24 * 60 * 60 * 1000L

/** Shortest term worth searching for: one letter matches most of a feed. */
private const val MIN_SEARCH_LEN = 2

/** Typing pause before a search runs, so a query is not run per keystroke. */
private const val SEARCH_DEBOUNCE_MS = 200L

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

    /*
     * Fetch only the page on screen. This used to pull a thousand episodes to show
     * thirty, and every row arrived as a JSON document to decode — measured on a
     * Pixel as the largest remaining source of dropped frames during the show
     * page's entrance animation.
     */
    val episodes by repo.observeEpisodes(podcastId, limit = limit.toLong())
        .collectAsState(initial = emptyList())

    /** The show's real episode count, counted in SQL rather than inferred from a page. */
    val totalEpisodes by produceState(0L, podcastId, episodes.size) {
        value = repo.countEpisodes(podcastId)
    }

    val progressRows by repo.observeProgress().collectAsState(initial = emptyList())
    val progressById = remember(progressRows) { progressRows.associateBy { it.episodeId } }

    /*
     * Finished episodes are hidden by default — a show page is for what is left to
     * hear — but never silently: a count-and-toggle row stands where they were, so a
     * hidden episode is one tap from findable and "where did it go" has an answer
     * on screen. The exception is the episode playing right now: hiding that from
     * under the listener would be disorienting.
     */
    var showPlayed by rememberSaveable { mutableStateOf(false) }
    val currentlyPlayingId = controller.state.collectAsState().value.episode?.id
    val unplayed = remember(episodes, progressById, currentlyPlayingId) {
        episodes.filter { progressById[it.id]?.played != true || it.id == currentlyPlayingId }
    }
    val playedCount = episodes.size - unplayed.size
    val shown = if (showPlayed) episodes else unplayed

    /** Rows opened for full-title/description reading. Tap toggles. Plain remember:
     * a Set is not Bundle-saveable, and expansion is not worth surviving process death. */
    var expandedIds by remember { mutableStateOf(setOf<String>()) }
    val queue by repo.observeQueue().collectAsState(initial = emptyList())
    val queuedIds = remember(queue) { queue.map { it.episodeId }.toSet() }
    val downloads by repo.observeDownloads().collectAsState(initial = emptyList())
    val downloadsById = remember(downloads) { downloads.associateBy { it.episodeId } }
    val playerState by controller.state.collectAsState()

    var searching by rememberSaveable { mutableStateOf(false) }
    var searchTerm by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()

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

    /*
     * One row, wired the same way wherever it appears — the paged list and the
     * search results are different ways of choosing which episodes to show, not
     * different kinds of episode.
     */
    val episodeRow: @Composable (Episode) -> Unit = { episode ->
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
            expanded = episode.id in expandedIds,
            onToggleExpand = {
                expandedIds =
                    if (episode.id in expandedIds) expandedIds - episode.id
                    else expandedIds + episode.id
            },
        )
    }

    if (searching) {
        EpisodeSearch(
            podcastId = podcastId,
            term = searchTerm,
            onTermChange = { searchTerm = it },
            onDismiss = { searching = false },
            episodeRow = episodeRow,
        )
        return
    }

    /*
     * Pull the next page as the list runs out, rather than making the reader find and
     * press a button to keep reading. The condition also fires when everything loaded
     * fits on screen without scrolling — which is what happens when a whole page turns
     * out to be played episodes and the list hides them all.
     */
    LaunchedEffect(listState, podcastId) {
        snapshotFlow {
            val info = listState.layoutInfo
            (info.visibleItemsInfo.lastOrNull()?.index ?: -1) to info.totalItemsCount
        }.collect { (lastVisible, count) ->
            // episodes.size >= limit means the current page really is full, so there
            // is a next one; without it a short feed would page forever.
            if (count > 0 && lastVisible >= count - 3 &&
                episodes.size >= limit && limit < totalEpisodes
            ) {
                limit += PAGE_SIZE
            }
        }
    }

    RefreshBox(onRefresh = {
        manualError = FeedRefresh.refresh(repo, app.http, current)
        podcastTick++
    }) {
        LazyColumn(Modifier.fillMaxSize(), state = listState) {
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
                        IconButton(onClick = { searching = true }) {
                            Icon(Icons.Filled.Search, "Search episodes")
                        }
                        // A gear that lands on a real screen, not a menu whose only
                        // item was Filtering.
                        IconButton(onClick = { nav.push(Screen.PodcastSettings(podcastId)) }) {
                            Icon(Icons.Filled.Settings, "Show settings")
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
                                Pill("$totalEpisodes episodes")
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


            item(key = "list-divider") { HairlineDivider(Modifier.padding(top = 16.dp)) }

            if (playedCount > 0) {
                item(key = "played-toggle") {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { showPlayed = !showPlayed }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            if (showPlayed) "Showing $playedCount played"
                            else "$playedCount played hidden",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            if (showPlayed) "Hide" else "Show",
                            style = MaterialTheme.typography.labelMedium,
                            color = Ember,
                        )
                    }
                    HairlineDivider()
                }
            }

            items(count = shown.size, key = { shown[it].id }) { index ->
                Column {
                    episodeRow(shown[index])
                    HairlineDivider()
                }
            }

            if (limit < totalEpisodes) {
                item(key = "more") {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(
                            Modifier.size(18.dp),
                            color = Ember,
                            strokeWidth = 2.dp,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Finding one episode in a show that has hundreds.
 *
 * A mode rather than a filter over the loaded page: the search runs against every
 * episode the feed has given us, and the episode being looked for is usually older
 * than anything the list has paged in. Played episodes are not hidden here — if you
 * are searching for something, having heard it before is not a reason to withhold it.
 */
@Composable
private fun EpisodeSearch(
    podcastId: String,
    term: String,
    onTermChange: (String) -> Unit,
    onDismiss: () -> Unit,
    episodeRow: @Composable (Episode) -> Unit,
) {
    val repo = FilterPodApp.instance.repo
    val focusRequester = remember { FocusRequester() }
    val trimmed = term.trim()

    BackHandler { onDismiss() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    // produceState cancels the previous run when the term changes, so the leading
    // delay debounces typing without a flow of its own. null means "not searched yet".
    val results by produceState<List<Episode>?>(null, podcastId, trimmed) {
        if (trimmed.length < MIN_SEARCH_LEN) {
            value = null
            return@produceState
        }
        delay(SEARCH_DEBOUNCE_MS)
        value = repo.searchEpisodes(podcastId, trimmed)
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 4.dp, end = 12.dp, top = 4.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onDismiss) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Close search")
            }
            OutlinedTextField(
                value = term,
                onValueChange = onTermChange,
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focusRequester),
                placeholder = { Text("Search this show's episodes") },
                trailingIcon = {
                    if (term.isNotEmpty()) {
                        IconButton(onClick = { onTermChange("") }) {
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
        }
        HairlineDivider()

        val found = results
        when {
            trimmed.length < MIN_SEARCH_LEN -> SearchNote("Type to search titles and show notes.")
            found == null -> Box(
                Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(Modifier.size(20.dp), color = Ember, strokeWidth = 2.dp)
            }
            found.isEmpty() -> SearchNote("No episodes match “$trimmed”.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                item(key = "count") {
                    Text(
                        if (found.size == 1) "1 episode" else "${found.size} episodes",
                        Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(count = found.size, key = { found[it].id }) { index ->
                    Column {
                        episodeRow(found[index])
                        HairlineDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchNote(text: String) {
    Text(
        text,
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 40.dp),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
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
            linkified(text),
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
