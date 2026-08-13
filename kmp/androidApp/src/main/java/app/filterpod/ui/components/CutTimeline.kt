package app.filterpod.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import app.filterpod.ui.Ember
import app.filterpod.shared.model.FilterSpan

/**
 * The app's signature control: a scrub bar that shows where audio was cut.
 *
 * Filtered spans render as ember notches, analyzed coverage as a sage shading, and
 * chapter starts as faint ticks — a Compose port of src/ui/CutTimeline.tsx.
 */
@Composable
fun CutTimeline(
    positionSec: Double,
    durationSec: Double,
    spans: List<FilterSpan>,
    onSeek: (Double) -> Unit,
    modifier: Modifier = Modifier,
    analyzedUntilSec: Double? = null,
    chapterMarks: List<Double> = emptyList(),
    compact: Boolean = false,
) {
    val safeDuration = if (durationSec > 0) durationSec else 1.0
    val progress = (positionSec / safeDuration).coerceIn(0.0, 1.0).toFloat()

    val trackColor = MaterialTheme.colorScheme.surfaceContainerHighest
    val fillColor = MaterialTheme.colorScheme.onSurface
    val sage = MaterialTheme.colorScheme.secondary
    val density = LocalDensity.current

    if (compact) {
        Canvas(modifier.fillMaxWidth().height(3.dp)) {
            drawRoundRect(trackColor, cornerRadius = CornerRadius(size.height / 2))
            drawSpanMarks(spans, safeDuration, Ember.copy(alpha = 0.7f), size.height)
            drawRect(fillColor.copy(alpha = 0.85f), size = Size(size.width * progress, size.height))
        }
        return
    }

    val gesture = Modifier.pointerInput(safeDuration) {
        detectTapGestures { offset ->
            onSeek((offset.x / size.width).coerceIn(0f, 1f) * safeDuration)
        }
    }.pointerInput(safeDuration) {
        // Scrubbing tracks the pointer continuously, like the web slider did.
        detectDragGestures { change, _ ->
            change.consume()
            onSeek((change.position.x / size.width).coerceIn(0f, 1f) * safeDuration)
        }
    }

    Canvas(
        modifier
            .fillMaxWidth()
            .height(44.dp)
            .then(gesture),
    ) {
        val trackH = with(density) { 6.dp.toPx() }
        val top = (size.height - trackH) / 2f
        val corner = CornerRadius(trackH / 2)

        // Track.
        drawRoundRect(trackColor, topLeft = Offset(0f, top), size = Size(size.width, trackH), cornerRadius = corner)

        // How far filtering has checked; sits under everything else.
        if (analyzedUntilSec != null && analyzedUntilSec > 0) {
            val w = ((analyzedUntilSec / safeDuration).coerceAtMost(1.0) * size.width).toFloat()
            drawRoundRect(sage.copy(alpha = 0.25f), topLeft = Offset(0f, top), size = Size(w, trackH), cornerRadius = corner)
        }

        // Chapter boundaries: faint navigation hints.
        val tickW = with(density) { 2.dp.toPx() }
        for (sec in chapterMarks) {
            if (sec > 0 && sec < safeDuration) {
                val x = (sec / safeDuration * size.width).toFloat()
                drawRect(fillColor.copy(alpha = 0.2f), topLeft = Offset(x, top), size = Size(tickW, trackH))
            }
        }

        // Cuts, beneath the elapsed fill so passed cuts read as history.
        drawSpanMarks(spans, safeDuration, Ember, trackH, top)

        // Elapsed fill.
        drawRoundRect(
            fillColor.copy(alpha = 0.30f),
            topLeft = Offset(0f, top),
            size = Size(size.width * progress, trackH),
            cornerRadius = corner,
        )

        // Thumb, slightly translucent so cut marks stay readable through it.
        val thumbR = with(density) { 8.dp.toPx() }
        drawCircle(
            fillColor.copy(alpha = 0.9f),
            radius = thumbR,
            center = Offset((size.width * progress).coerceIn(thumbR, size.width - thumbR), size.height / 2f),
        )
    }
}

private fun DrawScope.drawSpanMarks(
    spans: List<FilterSpan>,
    safeDuration: Double,
    color: Color,
    trackH: Float,
    top: Float = 0f,
) {
    // Sub-second cuts would render sub-pixel, so every mark gets a visible floor.
    val minW = size.width * 0.0045f
    for (span in spans) {
        val left = (span.startSec / safeDuration * size.width).toFloat()
        val w = maxOf(minW, ((span.endSec - span.startSec) / safeDuration * size.width).toFloat())
        drawRect(color, topLeft = Offset(left, top), size = Size(w, trackH))
    }
}
