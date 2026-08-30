package app.filterpod.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The handful of icons the app needs that Material's core set does not carry.
 *
 * Core ships about fifty glyphs; the rest live in material-icons-extended, which is
 * some six thousand of them. Minification is off for the release build, so that
 * dependency would land whole in the APK to supply two shapes. These are the same
 * paths Material draws, transcribed.
 */
object FilterPodIcons {

    /** A list with a plus: add this to the queue. */
    val PlaylistAdd: ImageVector by lazy {
        icon(
            name = "PlaylistAdd",
            autoMirror = true,
            pathData = "M14,10H2v2h12V10z M14,6H2v2h12V6z M18,14v-4h-2v4h-4v2h4v4h2v-4h4v-2H18z " +
                "M2,16h8v-2H2V16z",
        )
    }

    /** The same list, ticked: already queued. */
    val PlaylistAddCheck: ImageVector by lazy {
        icon(
            name = "PlaylistAddCheck",
            autoMirror = true,
            pathData = "M14,10H2v2h12V10z M14,6H2v2h12V6z M2,16h8v-2H2V16z " +
                "M21.5,11.5L23,13l-6.99,7l-4.51-4.5L13,14l3.01,3L21.5,11.5z",
        )
    }

    /** Arrow into a tray — the download glyph everything else uses. */
    val Download: ImageVector by lazy {
        icon(
            name = "Download",
            autoMirror = false,
            pathData = "M19,9h-4V3H9v6H5l7,7L19,9z M5,18v2h14v-2H5z",
        )
    }

    private fun icon(name: String, pathData: String, autoMirror: Boolean): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
            autoMirror = autoMirror,
        ).apply {
            // Black is the convention for icon assets: Icon() tints over it.
            addPath(
                pathData = PathParser().parsePathString(pathData).toNodes(),
                fill = SolidColor(Color.Black),
            )
        }.build()
}
