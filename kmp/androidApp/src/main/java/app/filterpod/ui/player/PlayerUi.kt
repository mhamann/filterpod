package app.filterpod.ui.player

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.filterpod.FilterPodApp
import app.filterpod.SpanMath
import app.filterpod.shared.chapters.chapterAt
import app.filterpod.shared.chapters.getChapters
import app.filterpod.shared.model.Chapter
import app.filterpod.toEngine
import app.filterpod.ui.Ember
import app.filterpod.ui.components.Artwork
import app.filterpod.ui.components.CutTimeline
import app.filterpod.ui.components.Pill
import app.filterpod.ui.components.PillTone
import app.filterpod.ui.components.QueueBadgeButton
import app.filterpod.ui.components.SectionLabel
import app.filterpod.ui.components.linkified
import app.filterpod.ui.components.ThinProgressBar
import app.filterpod.ui.timecode

private val RATES = listOf(0.8, 1.0, 1.2, 1.5, 2.0)

/** How far the panel must be dragged down before letting go dismisses it. */
private const val DISMISS_PX = 110f

/** Docked bar above the tab rail. Tapping it opens the full player. */
@Composable
fun MiniPlayer(onExpand: () -> Unit) {
    val controller = FilterPodApp.instance.controller
    val state by controller.state.collectAsState()
    val episode = state.episode ?: return

    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainer),
    ) {
        CutTimeline(
            positionSec = state.positionSec,
            durationSec = state.durationSec,
            spans = state.spans,
            onSeek = {},
            compact = true,
        )
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onExpand)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Artwork(
                episode.artworkUrl ?: state.podcast?.artworkUrl,
                null,
                Modifier.size(44.dp),
                corner = 8,
            )
            Column(
                Modifier
                    .weight(1f)
                    .padding(horizontal = 12.dp),
            ) {
                Text(
                    episode.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    state.podcast?.title ?: "",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                    .clickable { controller.toggle() },
                contentAlignment = Alignment.Center,
            ) {
                PlayPauseIcon(playing = state.state == "playing", size = 20.dp)
            }
        }
    }
}

/**
 * Full-screen player — the Compose port of src/app/NowPlaying.tsx.
 *
 * Shown/hidden by its host; a downward drag on the top half follows the finger and
 * dismisses past [DISMISS_PX], the same gesture the web panel taught.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NowPlayingScreen(
    queueCount: Int,
    skipBackSec: Int,
    skipForwardSec: Int,
    onClose: () -> Unit,
    onOpenQueue: () -> Unit,
) {
    val app = FilterPodApp.instance
    val controller = app.controller
    val state by controller.state.collectAsState()
    val episode = state.episode ?: return

    var dragY by remember { mutableFloatStateOf(0f) }
    var showChapters by remember { mutableStateOf(false) }
    var showNotes by remember { mutableStateOf(false) }

    // Chapters, when the feed pointed at a chapters file. Loaded per episode id, not
    // per state emission — status ticks replace the episode reference constantly.
    val chapters by produceState(initialValue = emptyList<Chapter>(), episode.id) {
        value = runCatching {
            getChapters(episode, app.repo, app.http, System.currentTimeMillis())
        }.getOrDefault(emptyList())
    }

    val frontier = remember(state.analyzedRanges, state.positionSec) {
        SpanMath.analyzedUntil(state.analyzedRanges.map { it.toEngine() }, state.positionSec)
    }
    val fullyAnalyzed = state.durationSec > 0 && frontier >= state.durationSec - 2
    val cutsPassed = remember(state.spans, state.positionSec) {
        state.spans.count { it.endSec <= state.positionSec }
    }
    val remaining = (state.durationSec - state.positionSec).coerceAtLeast(0.0)

    val dragDismiss = Modifier.pointerInput(Unit) {
        detectVerticalDragGestures(
            onVerticalDrag = { change, delta ->
                change.consume()
                // Downward only: dragging up should do nothing.
                dragY = (dragY + delta).coerceAtLeast(0f)
            },
            onDragEnd = {
                if (dragY > DISMISS_PX) onClose()
                dragY = 0f
            },
            onDragCancel = { dragY = 0f },
        )
    }

    // A hint of the artwork's own color behind everything, so each show tints the room.
    val glowColor by rememberArtworkGlow(episode.artworkUrl ?: state.podcast?.artworkUrl)
    val statusBarHeight = androidx.compose.foundation.layout.WindowInsets.statusBars
        .asPaddingValues().calculateTopPadding()

    Surface(
        Modifier
            .fillMaxSize()
            .graphicsLayer { translationY = dragY },
        color = MaterialTheme.colorScheme.background,
    ) {
        /*
         * Order matters: the glow and its scrim paint across the whole sheet, and the
         * status-bar inset is applied afterwards so only the content moves down. The
         * colour therefore runs behind the clock and fades, rather than being clipped
         * at the inset boundary.
         */
        Column(
            Modifier
                .fillMaxSize()
                .artGlowBackground(glowColor)
                .topShade(statusBarHeight + 72.dp)
                .statusBarsPadding(),
        ) {
            // Header strip: always drag-dismissable — the part people reach for.
            Row(
                Modifier
                    .fillMaxWidth()
                    .then(dragDismiss)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.KeyboardArrowDown, "Close")
                }
                SectionLabel("Now playing")
                QueueBadgeButton(queueCount) {
                    // The panel is an overlay: close on the way to the queue so the
                    // transition reads as going somewhere.
                    onClose()
                    onOpenQueue()
                }
            }

            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    Modifier
                        .padding(top = 44.dp)
                        .widthIn(max = 300.dp)
                        .artHaloGlow(glowColor)
                        .then(dragDismiss),
                ) {
                    Artwork(
                        episode.artworkUrl ?: state.podcast?.artworkUrl,
                        episode.title,
                        Modifier
                            .fillMaxWidth()
                            .aspectRatio(1f),
                        corner = 14,
                    )
                }

                SectionLabel(state.podcast?.title ?: "", Modifier.padding(top = 20.dp))
                Text(
                    episode.title,
                    Modifier.padding(top = 8.dp),
                    style = MaterialTheme.typography.titleLarge,
                    textAlign = TextAlign.Center,
                )

                // The cut readout — the app's core claim, stated plainly.
                Box(Modifier.padding(top = 20.dp)) {
                    val modelProgress = state.modelProgress
                    when {
                        modelProgress != null -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Pill(
                                "Getting speech model… ${(modelProgress * 100).toInt()}%",
                                tone = PillTone.Ember,
                            )
                            ThinProgressBar(
                                modelProgress.toFloat(),
                                Modifier
                                    .padding(top = 10.dp)
                                    .widthIn(max = 220.dp),
                            )
                        }
                        state.preparing -> Pill("Processing…", tone = PillTone.Ember)
                        state.spans.isEmpty() -> Pill(
                            if (fullyAnalyzed) "Nothing to cut" else "Nothing so far",
                            tone = PillTone.Sage,
                            icon = Icons.Filled.Check,
                        )
                        else -> Pill("$cutsPassed/${state.spans.size} cuts", tone = PillTone.Ember)
                    }
                }

                if (state.catchingUp) {
                    Text(
                        "Paused while the next stretch is checked.",
                        Modifier.padding(top = 10.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = Ember,
                    )
                }

                CutTimeline(
                    positionSec = state.positionSec,
                    durationSec = state.durationSec,
                    spans = state.spans,
                    onSeek = { controller.seek(it) },
                    modifier = Modifier.padding(top = 16.dp),
                    analyzedUntilSec = frontier,
                    chapterMarks = chapters.map { it.startSec },
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        timecode(state.positionSec),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "−${timecode(remaining)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                if (episode.description.isNotBlank()) {
                    // Show notes belong with the episode, not only on the show page:
                    // the links and timestamps are most wanted while it is playing.
                    Row(
                        Modifier
                            .padding(top = 10.dp)
                            .clip(RoundedCornerShape(50))
                            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                            .clickable { showNotes = true }
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Show notes", style = MaterialTheme.typography.labelMedium)
                    }
                }

                if (chapters.isNotEmpty()) {
                    // One quiet row instead of a list: the chapter you are in is the
                    // only one worth permanent screen space.
                    Row(
                        Modifier
                            .padding(top = 10.dp)
                            .clip(RoundedCornerShape(50))
                            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                            .clickable { showChapters = true }
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            chapterAt(chapters, state.positionSec)?.title ?: "Chapters",
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 220.dp),
                        )
                        Text(
                            chapters.size.toString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                // Transport: skip buttons labeled with the configured increments.
                Row(
                    Modifier.padding(top = 28.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(28.dp),
                ) {
                    SkipButton(seconds = skipBackSec, forward = false) { controller.skipBack() }
                    Box(
                        Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(Ember)
                            .clickable { controller.toggle() },
                        contentAlignment = Alignment.Center,
                    ) {
                        PlayPauseIcon(
                            playing = state.state == "playing",
                            size = 32.dp,
                            tint = Color(0xFF15100B),
                        )
                    }
                    SkipButton(seconds = skipForwardSec, forward = true) { controller.skipForward() }
                }

                // Rate control, cycling through the fixed steps.
                Row(
                    Modifier
                        .padding(top = 24.dp, bottom = 32.dp)
                        .clip(RoundedCornerShape(50))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .clickable {
                            val index = RATES.indexOfFirst { it == state.rate }
                            val next = RATES[(index + 1).mod(RATES.size)]
                            controller.setRate(next)
                        }
                        .padding(horizontal = 18.dp, vertical = 8.dp),
                ) {
                    Text(
                        "${formatRate(state.rate)}×",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }

                val error = state.error
                if (state.state == "error" || error != null) {
                    Text(
                        error ?: "Playback failed. Try re-downloading this episode.",
                        Modifier.padding(bottom = 24.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }

    if (showNotes) {
        ModalBottomSheet(onDismissRequest = { showNotes = false }) {
            Column(
                Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 32.dp),
            ) {
                SectionLabel("Show notes", Modifier.padding(vertical = 8.dp))
                Text(
                    episode.title,
                    Modifier.padding(bottom = 12.dp),
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    linkified(episode.description),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    if (showChapters) {
        ModalBottomSheet(onDismissRequest = { showChapters = false }) {
            Column(Modifier.padding(bottom = 24.dp)) {
                SectionLabel("Chapters", Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                val current = chapterAt(chapters, state.positionSec)
                for ((index, chapter) in chapters.withIndex()) {
                    val isCurrent = chapter === current
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(if (isCurrent) Ember.copy(alpha = 0.07f) else Color.Transparent)
                            .clickable {
                                controller.seek(chapter.startSec)
                                showChapters = false
                            }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            timecode(chapter.startSec),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isCurrent) Ember else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            chapter.title.ifBlank { "Chapter ${index + 1}" },
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (isCurrent) Ember else MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

private fun formatRate(rate: Double): String =
    if (rate == rate.toLong().toDouble()) rate.toLong().toString() else rate.toString()

/** Play triangle or hand-drawn pause bars (Pause is not in the core icon set). */
@Composable
fun PlayPauseIcon(
    playing: Boolean,
    size: androidx.compose.ui.unit.Dp,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    if (!playing) {
        Icon(Icons.Filled.PlayArrow, "Play", Modifier.size(size), tint = tint)
    } else {
        Canvas(Modifier.size(size)) {
            val barW = this.size.width * 0.22f
            val gap = this.size.width * 0.18f
            val left = (this.size.width - barW * 2 - gap) / 2f
            val top = this.size.height * 0.15f
            val barH = this.size.height * 0.7f
            drawRoundRect(
                tint,
                topLeft = Offset(left, top),
                size = androidx.compose.ui.geometry.Size(barW, barH),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW / 3),
            )
            drawRoundRect(
                tint,
                topLeft = Offset(left + barW + gap, top),
                size = androidx.compose.ui.geometry.Size(barW, barH),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW / 3),
            )
        }
    }
}

/** A skip control: circular arrow arc with the increment printed in the middle. */
@Composable
private fun SkipButton(seconds: Int, forward: Boolean, onClick: () -> Unit) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    val density = LocalDensity.current
    Box(
        Modifier
            .size(56.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        // 44dp, not 40: the arrowhead needs room outside the arc, and a head clipped
        // by the canvas edge was part of what made these unreadable.
        Canvas(Modifier.size(44.dp)) {
            val stroke = with(density) { 2.dp.toPx() }
            val inset = with(density) { 6.dp.toPx() }
            val arcSize = androidx.compose.ui.geometry.Size(size.width - inset * 2, size.height - inset * 2)
            /*
             * One arc for both directions, open at the top; only the head moves. The
             * gap is 65 degrees, which is the head's width plus breathing room.
             */
            drawArc(
                color = color,
                startAngle = -57.5f,
                sweepAngle = 295f,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
            /*
             * A filled triangle at the gap, pointing the way the audio moves: left to
             * rewind, right to advance. Horizontal rather than tangent to the arc —
             * at this size a tangent head reads as pointing up, which is what made
             * an earlier version ambiguous.
             *
             * It caps the end of the stroke and points back across the gap, so the
             * forward head sits at the gap's left edge and the rewind head at its
             * right. Putting each head at its own side instead left it pointing away
             * from the ring, floating outside the arc rather than finishing it.
             */
            val angle = Math.toRadians(if (forward) -122.5 else -57.5)
            val r = arcSize.width / 2f
            val tipX = size.width / 2f + r * kotlin.math.cos(angle).toFloat()
            val tipY = size.height / 2f + r * kotlin.math.sin(angle).toFloat()
            val headLen = with(density) { 11.dp.toPx() }
            val halfWidth = with(density) { 6.dp.toPx() }
            val dir = if (forward) 1f else -1f
            val back = tipX - dir * headLen * 0.15f
            val path = Path().apply {
                moveTo(tipX + dir * headLen * 0.85f, tipY)
                lineTo(back, tipY - halfWidth)
                lineTo(back, tipY + halfWidth)
                close()
            }
            drawPath(path, color)
        }
        Text(
            seconds.toString(),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = color,
        )
    }
}
