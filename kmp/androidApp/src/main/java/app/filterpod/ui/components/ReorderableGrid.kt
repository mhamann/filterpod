package app.filterpod.ui.components

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput

/**
 * Long-press drag-to-reorder for a LazyVerticalGrid — the Compose translation of
 * src/ui/ReorderableGrid.tsx.
 *
 * Long-press is what disambiguates: a tap opens the tile, a swipe scrolls (or pulls
 * to refresh), and only holding still lifts the tile out of the flow. Tiles are
 * identified by key (prefixed "tile:"), so header rows in the same grid are inert.
 *
 * "Which slot is the finger over" is a hit-test against the grid's own layout info
 * rather than column math, so it stays right whatever the span arrangement is.
 */
class GridReorderState(
    private val gridState: LazyGridState,
    private val keyForTile: (Int) -> Any,
    private val tileIndexForKey: (Any) -> Int,
    private val onMove: (from: Int, to: Int) -> Unit,
    private val onDrop: () -> Unit,
    private val haptic: () -> Unit,
) {
    var draggingKey by mutableStateOf<Any?>(null)
        private set

    private var dragStartOffset = Offset.Zero
    private var dragAccum by mutableStateOf(Offset.Zero)

    /** The release of a drag lands on a tile that opens a page; one drag must not also be one navigation. */
    var suppressClicksUntil = 0L
        private set

    fun startDrag(position: Offset) {
        val hit = gridState.layoutInfo.visibleItemsInfo.firstOrNull { item ->
            tileIndexForKey(item.key) >= 0 &&
                position.x >= item.offset.x && position.x < item.offset.x + item.size.width &&
                position.y >= item.offset.y && position.y < item.offset.y + item.size.height
        } ?: return
        draggingKey = hit.key
        dragStartOffset = Offset(hit.offset.x.toFloat(), hit.offset.y.toFloat())
        dragAccum = Offset.Zero
        haptic()
    }

    fun drag(amount: Offset) {
        val key = draggingKey ?: return
        dragAccum += amount
        val info = gridState.layoutInfo.visibleItemsInfo
        val dragged = info.firstOrNull { it.key == key } ?: return
        val center = Offset(
            dragStartOffset.x + dragged.size.width / 2f + dragAccum.x,
            dragStartOffset.y + dragged.size.height / 2f + dragAccum.y,
        )
        val target = info.firstOrNull { item ->
            item.key != key && tileIndexForKey(item.key) >= 0 &&
                center.x >= item.offset.x && center.x < item.offset.x + item.size.width &&
                center.y >= item.offset.y && center.y < item.offset.y + item.size.height
        } ?: return
        val from = tileIndexForKey(key)
        val to = tileIndexForKey(target.key)
        if (from >= 0 && to >= 0 && from != to) {
            onMove(from, to)
            haptic()
        }
    }

    fun endDrag(commit: Boolean) {
        if (draggingKey != null && commit) onDrop()
        suppressClicksUntil = System.currentTimeMillis() + 400
        draggingKey = null
        dragAccum = Offset.Zero
    }

    /** Visual translation for the dragged tile; null for everything else. */
    fun translationFor(key: Any): Offset? {
        if (key != draggingKey) return null
        val current = gridState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return null
        return Offset(
            dragStartOffset.x + dragAccum.x - current.offset.x,
            dragStartOffset.y + dragAccum.y - current.offset.y,
        )
    }
}

@Composable
fun rememberGridReorderState(
    gridState: LazyGridState,
    keyForTile: (Int) -> Any,
    tileIndexForKey: (Any) -> Int,
    onMove: (from: Int, to: Int) -> Unit,
    onDrop: () -> Unit,
    haptic: () -> Unit,
): GridReorderState = remember(gridState) {
    GridReorderState(gridState, keyForTile, tileIndexForKey, onMove, onDrop, haptic)
}

/** Attach to the grid itself. [enabled] is off while a search filter shows a subset. */
fun Modifier.gridReorder(state: GridReorderState, enabled: Boolean): Modifier =
    if (!enabled) this
    else pointerInput(state) {
        detectDragGesturesAfterLongPress(
            onDragStart = { offset -> state.startDrag(offset) },
            onDrag = { change, amount ->
                change.consume()
                state.drag(amount)
            },
            onDragEnd = { state.endDrag(commit = true) },
            onDragCancel = { state.endDrag(commit = false) },
        )
    }
