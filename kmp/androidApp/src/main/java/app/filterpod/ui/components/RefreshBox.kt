package app.filterpod.ui.components

import androidx.compose.foundation.layout.BoxScope
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Material-style pull-to-refresh: the indicator descends from under the top edge and
 * the page itself never translates — the convention the React PullToRefresh hand-built.
 *
 * The least time the spinner shows after release is [MIN_SPIN_MS]: a conditional
 * refresh of one unchanged feed answers in a couple hundred milliseconds — faster
 * than the eye credits, so the gesture felt like it did nothing. The work is not
 * slowed; the acknowledgement is held long enough to be seen.
 */
private const val MIN_SPIN_MS = 700L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RefreshBox(
    onRefresh: suspend () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                val started = System.currentTimeMillis()
                try {
                    onRefresh()
                } catch (_: Throwable) {
                    // A feed that will not load is not worth interrupting browsing for;
                    // per-screen error UI (the manual-error banner) is the caller's job.
                }
                val elapsed = System.currentTimeMillis() - started
                if (elapsed < MIN_SPIN_MS) delay(MIN_SPIN_MS - elapsed)
                refreshing = false
            }
        },
        modifier = modifier,
        content = content,
    )
}
