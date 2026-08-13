package app.filterpod.ui.screens

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import app.filterpod.FilterPodApp
import app.filterpod.shared.model.Episode
import app.filterpod.ui.Ember
import app.filterpod.ui.NavState
import app.filterpod.ui.components.EmptyState
import app.filterpod.ui.components.ScreenHeader
import app.filterpod.ui.durationLabel
import kotlinx.coroutines.launch

/**
 * The queue, in play order, rearranged by direct manipulation.
 * Port of src/app/screens/Queue.tsx + src/ui/QueueList.tsx.
 *
 * Position 0 is whatever is playing. That row is marked and cannot be dragged:
 * while it is playing it is first by definition. Reordering is a drag on the grip —
 * the grip specifically, because a whole-row drag would fight both scrolling and
 * the swipe. Removal is a horizontal swipe past [REMOVE_FRACTION] of the row's
 * width; anything short of that springs back.
 */
private const val REMOVE_FRACTION = 0.45f

@Composable
fun QueueScreen(nav: NavState) {
    val app = FilterPodApp.instance
    val repo = app.repo
    val controller = app.controller
    val scope = rememberCoroutineScope()
    val view = LocalView.current

    val queue by repo.observeQueue().collectAsState(initial = emptyList())
    val playerState by controller.state.collectAsState()
    val currentId = playerState.episode?.id

    // Episode rows for whatever is queued. Keyed off the id list, not the queue rows,
    // so a reorder does not refetch.
    val queuedIds = remember(queue) { queue.map { it.episodeId } }
    val episodesById by produceState(initialValue = emptyMap<String, Episode>(), queuedIds.toSet()) {
        value = queuedIds.mapNotNull { repo.getEpisode(it) }.associateBy { it.id }
    }

    Column(Modifier.fillMaxSize()) {
        ScreenHeader("Queue") {
            if (queue.isNotEmpty()) {
                TextButton(onClick = {
                    scope.launch { queue.forEach { repo.removeFromQueue(it.episodeId) } }
                }) {
                    Text("Clear all", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        if (queue.isEmpty()) {
            EmptyState(
                icon = Icons.AutoMirrored.Filled.List,
                title = "Nothing queued yet.",
                body = "Use the queue button on any episode to line it up. Whatever is playing sits at the top, and the rest follow it in order.",
            )
        } else {
            QueueList(
                queuedIds = queuedIds,
                episodesById = episodesById,
                currentId = currentId,
                onOpen = { controller.openAsync(it) },
                onRemove = { id -> scope.launch { repo.removeFromQueue(id) } },
                onReorder = { ids -> scope.launch { repo.reorderQueue(ids) } },
                haptic = { view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) },
            )
        }
    }
}

private data class DragState(val id: String, val from: Int, val to: Int, val dy: Float)

@Composable
private fun QueueList(
    queuedIds: List<String>,
    episodesById: Map<String, Episode>,
    currentId: String?,
    onOpen: (String) -> Unit,
    onRemove: (String) -> Unit,
    onReorder: (List<String>) -> Unit,
    haptic: () -> Unit,
) {
    // The local order the list renders; a drag rearranges this and commits on release.
    val localOrder = remember { mutableStateListOf<String>() }
    var drag by remember { mutableStateOf<DragState?>(null) }
    var rowHeightPx by remember { mutableIntStateOf(1) }

    // Sync from the store when no gesture is in flight.
    val dragging = drag != null
    androidx.compose.runtime.LaunchedEffect(queuedIds, dragging) {
        if (!dragging) {
            localOrder.clear()
            localOrder.addAll(queuedIds)
        }
    }

    // The playing episode holds the first slot; the row below it is as far up as
    // anything else can go.
    val firstMovable = if (localOrder.firstOrNull() == currentId) 1 else 0

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Column(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceContainer),
        ) {
            localOrder.forEachIndexed { index, episodeId ->
                val episode = episodesById[episodeId]
                if (episode != null) {
                    androidx.compose.runtime.key(episodeId) {
                        QueueRow(
                            episode = episode,
                            index = index,
                            isCurrent = episodeId == currentId,
                            drag = drag,
                            rowHeightPx = rowHeightPx,
                            onRowMeasured = { rowHeightPx = it },
                            onOpen = { onOpen(episodeId) },
                            onRemove = { onRemove(episodeId) },
                            haptic = haptic,
                            onGripDragStart = { drag = DragState(episodeId, index, index, 0f) },
                            onGripDrag = { dy ->
                                val d = drag ?: return@QueueRow
                                val newDy = d.dy + dy
                                val to = (d.from + Math.round(newDy / rowHeightPx))
                                    .coerceIn(firstMovable, localOrder.lastIndex)
                                // The detent: each slot the row snaps into is felt.
                                if (to != d.to) haptic()
                                drag = d.copy(dy = newDy, to = to)
                            },
                            onGripDragEnd = { cancelled ->
                                val d = drag
                                drag = null
                                if (d != null && !cancelled && d.to != d.from) {
                                    localOrder.add(d.to, localOrder.removeAt(d.from))
                                    onReorder(localOrder.toList())
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun QueueRow(
    episode: Episode,
    index: Int,
    isCurrent: Boolean,
    drag: DragState?,
    rowHeightPx: Int,
    onRowMeasured: (Int) -> Unit,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
    haptic: () -> Unit,
    onGripDragStart: () -> Unit,
    onGripDrag: (Float) -> Unit,
    onGripDragEnd: (cancelled: Boolean) -> Unit,
) {
    val isDragged = drag?.id == episode.id

    // Where a bystander row sits while another row is being dragged past it.
    val shiftTarget = when {
        drag == null || isDragged -> 0f
        drag.from < drag.to && index > drag.from && index <= drag.to -> -rowHeightPx.toFloat()
        drag.from > drag.to && index >= drag.to && index < drag.from -> rowHeightPx.toFloat()
        else -> 0f
    }
    val shift by animateFloatAsState(shiftTarget, animationSpec = tween(150), label = "queueShift")

    // Swipe-to-remove: tracked by an Animatable so the spring-back and slide-out are
    // the same mechanism as the finger-tracking.
    val offsetX = remember { Animatable(0f) }
    var rowWidth by remember { mutableIntStateOf(1) }
    var swiping by remember { mutableStateOf(false) }
    var armed by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    val swipeScope = rememberCoroutineScope()

    Box(
        Modifier
            .fillMaxWidth()
            .onSizeChanged {
                rowWidth = it.width
                if (it.height > 1) onRowMeasured(it.height)
            }
            .zIndex(if (isDragged) 1f else 0f)
            .graphicsLayer {
                translationY = if (isDragged) (drag?.dy ?: 0f) else shift
            },
    ) {
        // The reveal beneath a swiping row.
        if (swiping || leaving || offsetX.value != 0f) {
            Row(
                Modifier
                    .matchParentSize()
                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.15f))
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = if (offsetX.value < 0) androidx.compose.foundation.layout.Arrangement.End
                else androidx.compose.foundation.layout.Arrangement.Start,
            ) {
                Icon(Icons.Filled.Delete, "Remove", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .graphicsLayer { translationX = offsetX.value }
                .background(
                    if (isCurrent) Ember.copy(alpha = 0.06f)
                    else MaterialTheme.colorScheme.surfaceContainer,
                )
                .pointerInput(episode.id) {
                    // detectHorizontalDragGestures applies the horizontal slop for us:
                    // a vertical drift stays the scroller's, a tap stays a tap.
                    detectHorizontalDragGestures(
                        onDragStart = {
                            swiping = true
                            armed = false
                        },
                        onHorizontalDrag = { change, delta ->
                            change.consume()
                            swipeScope.launch { offsetX.snapTo(offsetX.value + delta) }
                            // Tick when the swipe arms (and again if it backs off), so
                            // the finger knows when release stops being harmless.
                            val nowArmed = kotlin.math.abs(offsetX.value + delta) >= rowWidth * REMOVE_FRACTION
                            if (nowArmed != armed) {
                                armed = nowArmed
                                haptic()
                            }
                        },
                        onDragEnd = {
                            swiping = false
                            val dx = offsetX.value
                            if (kotlin.math.abs(dx) >= rowWidth * REMOVE_FRACTION) {
                                leaving = true
                                swipeScope.launch {
                                    offsetX.animateTo(Math.signum(dx) * rowWidth, tween(170))
                                    onRemove()
                                    offsetX.snapTo(0f)
                                    leaving = false
                                }
                            } else {
                                swipeScope.launch { offsetX.animateTo(0f, tween(170)) }
                            }
                        },
                        onDragCancel = {
                            swiping = false
                            swipeScope.launch { offsetX.animateTo(0f, tween(170)) }
                        },
                    )
                }
                .clickable { onOpen() }
                .padding(start = 12.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) {
                if (isCurrent) {
                    Icon(Icons.Filled.PlayArrow, null, Modifier.size(13.dp), tint = Ember)
                } else {
                    Text(
                        "${index + 1}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Column(
                Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp),
            ) {
                Text(
                    episode.title,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (isCurrent) Ember else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    if (isCurrent) "Playing" else durationLabel(episode.durationSec),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (!isCurrent) {
                // The grip owns reordering; its drag must not also start a row swipe.
                Icon(
                    Icons.Filled.Menu,
                    "Drag to move ${episode.title}",
                    Modifier
                        .padding(8.dp)
                        .size(18.dp)
                        .pointerInput(episode.id) {
                            detectDragGestures(
                                onDragStart = { onGripDragStart() },
                                onDrag = { change, amount ->
                                    change.consume()
                                    onGripDrag(amount.y)
                                },
                                onDragEnd = { onGripDragEnd(false) },
                                onDragCancel = { onGripDragEnd(true) },
                            )
                        },
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
