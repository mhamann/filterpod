package app.filterpod.ui.player

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.palette.graphics.Palette
import coil3.BitmapImage
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.size.Size
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The now-playing glow: a color pulled from the episode's artwork, washed softly
 * behind the sheet.
 *
 * The extraction runs on a small decode (Palette quantizes anyway, so feeding it the
 * full 3000px art is pure waste) with hardware bitmaps off — Palette reads pixels,
 * which hardware bitmaps do not allow. Preference order is vibrant first: podcast art
 * is usually one saturated brand color on a quiet field, and the vibrant swatch is
 * that color; dominant alone too often lands on the background.
 */
@Composable
fun rememberArtworkGlow(artworkUrl: String?): State<Color> {
    val context = LocalContext.current
    val extracted by produceState(initialValue = Color.Unspecified, artworkUrl) {
        value = withContext(Dispatchers.Default) {
            runCatching { extractGlowColor(context, artworkUrl) }.getOrNull() ?: Color.Unspecified
        }
    }
    // Ease the glow in when it lands, and cross-fade between episodes rather than snap.
    return animateColorAsState(
        targetValue = if (extracted == Color.Unspecified) Color.Transparent else extracted,
        animationSpec = tween(durationMillis = 900),
        label = "artGlow",
    )
}

private suspend fun extractGlowColor(
    context: android.content.Context,
    artworkUrl: String?,
): Color? {
    if (artworkUrl.isNullOrEmpty()) return null
    val result = SingletonImageLoader.get(context).execute(
        ImageRequest.Builder(context)
            .data(artworkUrl)
            .size(Size(96, 96))
            .allowHardware(false)
            .build(),
    ) as? SuccessResult ?: return null
    val bitmap = (result.image as? BitmapImage)?.bitmap ?: return null

    val palette = Palette.from(bitmap).clearFilters().generate()
    val swatch = palette.vibrantSwatch
        ?: palette.lightVibrantSwatch
        ?: palette.darkVibrantSwatch
        ?: palette.dominantSwatch
        ?: return null
    return Color(swatch.rgb)
}

/**
 * Draws the ambient half of the glow: one soft radial pool behind where the artwork
 * sits, and a barely-there wash over the whole sheet so the color reads as ambience
 * rather than a spotlight. Alphas are deliberately low — the art is the saturated
 * thing on this screen; the background only gets to hum along. The brighter half
 * lives in [artHaloGlow], anchored to the artwork itself.
 */
fun Modifier.artGlowBackground(color: Color): Modifier = drawBehind {
    if (color.alpha == 0f) return@drawBehind
    drawRect(color.copy(alpha = 0.05f * color.alpha))
    drawRect(
        Brush.radialGradient(
            colors = listOf(color.copy(alpha = 0.30f * color.alpha), Color.Transparent),
            center = Offset(size.width / 2f, size.height * 0.24f),
            radius = size.width * 0.95f,
        ),
    )
}

/**
 * The halo: an intense, tight rim of light hugging the artwork.
 *
 * Drawn as a blurred rounded rect at the art's own bounds rather than a radial
 * gradient — a circle cannot hug a square: its glow was widest at the edge midpoints
 * and gone at the corners. The blur ring is even all the way around, spills only
 * ~a tenth of the art's width past the edges, and the art itself covers the solid
 * middle, so what shows is a bright, close aura that reads as light escaping from
 * behind the cover.
 */
fun Modifier.artHaloGlow(color: Color, cornerRadius: Float = 14f): Modifier = drawBehind {
    if (color.alpha == 0f) return@drawBehind
    val blur = size.width * 0.09f
    drawIntoCanvas { canvas ->
        val paint = Paint()
        paint.asFrameworkPaint().apply {
            this.color = color.copy(alpha = 0.60f * color.alpha).toArgb()
            maskFilter = android.graphics.BlurMaskFilter(blur, android.graphics.BlurMaskFilter.Blur.NORMAL)
        }
        canvas.drawRoundRect(
            left = 0f, top = 0f, right = size.width, bottom = size.height,
            radiusX = cornerRadius, radiusY = cornerRadius,
            paint = paint,
        )
    }
}
