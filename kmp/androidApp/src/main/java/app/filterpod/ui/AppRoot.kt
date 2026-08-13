package app.filterpod.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.shared.discovery.Discovery
import app.filterpod.shared.model.Settings
import app.filterpod.ui.components.ThinProgressBar
import app.filterpod.ui.player.MiniPlayer
import app.filterpod.ui.player.NowPlayingScreen
import app.filterpod.ui.screens.DiscoverScreen
import app.filterpod.ui.screens.LibraryScreen
import app.filterpod.ui.screens.PodcastDetailScreen
import app.filterpod.ui.screens.QueueScreen
import app.filterpod.ui.screens.SettingsScreen
import kotlinx.coroutines.launch

/**
 * The shell: content, model-download banner, mini player, tab rail — and the
 * full-screen player as an overlay. Port of src/app/App.tsx.
 */
@Composable
fun AppRoot() {
    val app = FilterPodApp.instance
    val repo = app.repo
    val controller = app.controller
    val scope = rememberCoroutineScope()

    // Settings live here so the theme and the player's skip labels share one copy.
    // Loaded fire-and-forget: screens tolerate the defaults for a frame.
    var settings by remember { mutableStateOf(Settings()) }
    LaunchedEffect(Unit) { settings = repo.getSettings() }
    val updateSettings: ((Settings) -> Settings) -> Unit = { transform ->
        settings = transform(settings)
        scope.launch { repo.updateSettings(transform) }
    }

    val nav = rememberNavState()
    var playerOpen by remember { mutableStateOf(false) }

    val discovery = remember { Discovery(app.http) }
    val playerState by controller.state.collectAsState()
    val queue by repo.observeQueue().collectAsState(initial = emptyList())

    BackHandler(enabled = playerOpen || nav.canPop) {
        if (playerOpen) playerOpen = false else nav.pop()
    }

    FilterPodTheme(theme = settings.theme) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            bottomBar = {
                Column {
                    ModelBanner(playerState.modelProgress)
                    MiniPlayer(onExpand = { playerOpen = true })
                    TabRail(nav)
                }
            },
        ) { padding ->
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .statusBarsPadding(),
            ) {
                when (val screen = nav.current) {
                    is Screen.Library -> LibraryScreen(nav)
                    is Screen.Discover -> DiscoverScreen(nav, screen.initialTerm, discovery)
                    is Screen.Queue -> QueueScreen(nav)
                    is Screen.Settings -> SettingsScreen(settings, updateSettings)
                    is Screen.PodcastDetail -> PodcastDetailScreen(nav, screen.podcastId)
                }
            }
        }

        // The full player: mounted over everything, slid in and out rather than
        // switched, so closing it is an exit rather than a vanish.
        AnimatedVisibility(
            visible = playerOpen && playerState.episode != null,
            enter = slideInVertically(initialOffsetY = { it }),
            exit = slideOutVertically(targetOffsetY = { it }),
        ) {
            Box(Modifier.statusBarsPadding()) {
                NowPlayingScreen(
                    queueCount = queue.size,
                    skipBackSec = settings.skipBackSec,
                    skipForwardSec = settings.skipForwardSec,
                    onClose = { playerOpen = false },
                    onOpenQueue = { nav.selectTab(Screen.Queue) },
                )
            }
        }
    }
}

/**
 * Speech model download, shown while you browse. It is a large one-time fetch;
 * leaving it invisible would make the first press of play look broken.
 */
@Composable
private fun ModelBanner(fraction: Double?) {
    if (fraction == null) return
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text(
                "Getting the speech model…",
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "${(fraction * 100).toInt()}%",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box(Modifier.padding(top = 6.dp)) { ThinProgressBar(fraction.toFloat()) }
    }
}

@Composable
private fun TabRail(nav: NavState) {
    val tabs = listOf(
        Triple(Screen.Library as Screen, "Library", Icons.Filled.Home),
        Triple(Screen.Discover() as Screen, "Discover", Icons.Filled.Search),
        Triple(Screen.Queue as Screen, "Queue", Icons.AutoMirrored.Filled.List),
        Triple(Screen.Settings as Screen, "Settings", Icons.Filled.Settings),
    )
    val currentRoot = nav.stack.first().tabRoot()
    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        for ((tab, label, icon) in tabs) {
            NavigationBarItem(
                selected = currentRoot == tab.tabRoot(),
                onClick = { nav.selectTab(tab) },
                icon = { Icon(icon, null, Modifier.size(22.dp)) },
                label = { Text(label, style = MaterialTheme.typography.labelSmall) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = Ember,
                    selectedTextColor = Ember,
                    indicatorColor = Ember.copy(alpha = 0.12f),
                ),
            )
        }
    }
}
