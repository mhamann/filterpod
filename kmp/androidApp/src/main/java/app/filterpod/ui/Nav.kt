package app.filterpod.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember

/**
 * State-driven navigation: a hand-rolled back stack, matching the React app's
 * hash-router behavior without a navigation library.
 *
 * Tabs are stack roots. Selecting a tab resets the stack to that root (the same
 * feel the HashRouter gave: tab bars never deep-stack). Show pages push.
 */
sealed interface Screen {
    data object Library : Screen
    data class Discover(val initialTerm: String = "") : Screen
    data object Queue : Screen
    data object Settings : Screen
    data class PodcastDetail(val podcastId: String) : Screen
    data class PodcastSettings(val podcastId: String) : Screen
}

/** The bottom-nav tab a screen belongs to, for highlighting while a detail is pushed. */
fun Screen.tabRoot(): Screen = when (this) {
    is Screen.Discover -> Screen.Discover()
    else -> this
}

class NavState internal constructor() {
    val stack = mutableStateListOf<Screen>(Screen.Library)

    /**
     * How the last move went: forward (deeper), back (up), or sideways (tab switch).
     * Screen transitions read this so a push slides in from the right and a pop
     * reverses it — motion that says which way you moved through the app.
     */
    var lastDirection by androidx.compose.runtime.mutableStateOf(Direction.SIDEWAYS)
        private set

    enum class Direction { FORWARD, BACK, SIDEWAYS }

    val current: Screen get() = stack.last()
    val canPop: Boolean get() = stack.size > 1

    fun selectTab(tab: Screen) {
        lastDirection = Direction.SIDEWAYS
        stack.clear()
        stack.add(tab)
    }

    fun push(screen: Screen) {
        lastDirection = Direction.FORWARD
        stack.add(screen)
    }

    fun pop() {
        if (stack.size > 1) {
            lastDirection = Direction.BACK
            stack.removeAt(stack.lastIndex)
        }
    }
}

@Composable
fun rememberNavState(): NavState = remember { NavState() }
