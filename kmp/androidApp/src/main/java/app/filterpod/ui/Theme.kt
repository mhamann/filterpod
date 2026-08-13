package app.filterpod.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * FilterPod's Material theme, dark by default, following Settings.theme.
 *
 * The palette keeps the React app's temperament — an ember accent on near-black
 * panels, with sage for the "verified clean" tones — mapped onto Material roles.
 */

val Ember = Color(0xFFF97316)
val EmberDim = Color(0xFFE05E10)
val Sage = Color(0xFF86C68C)
val Alarm = Color(0xFFF06A5A)

private val DarkColors = darkColorScheme(
    primary = Ember,
    onPrimary = Color(0xFF15100B),
    primaryContainer = Color(0xFF3A2412),
    onPrimaryContainer = Color(0xFFFFC59E),
    secondary = Sage,
    onSecondary = Color(0xFF0E1510),
    secondaryContainer = Color(0xFF203526),
    onSecondaryContainer = Color(0xFFB9E3BC),
    background = Color(0xFF0D0F13),
    onBackground = Color(0xFFE9E5DF),
    surface = Color(0xFF0D0F13),
    onSurface = Color(0xFFE9E5DF),
    surfaceVariant = Color(0xFF1B1E24),
    onSurfaceVariant = Color(0xFF9BA0A8),
    surfaceContainer = Color(0xFF14171C),
    surfaceContainerHigh = Color(0xFF1B1E24),
    surfaceContainerHighest = Color(0xFF23262E),
    outline = Color(0xFF3A3E48),
    outlineVariant = Color(0xFF262A32),
    error = Alarm,
    onError = Color(0xFF1A0E0C),
)

private val LightColors = lightColorScheme(
    primary = EmberDim,
    onPrimary = Color.White,
    secondary = Color(0xFF3E7A45),
    background = Color(0xFFFBF8F4),
    onBackground = Color(0xFF1C1B18),
    surface = Color(0xFFFBF8F4),
    onSurface = Color(0xFF1C1B18),
    surfaceVariant = Color(0xFFEBE6DF),
    onSurfaceVariant = Color(0xFF5B5850),
    outline = Color(0xFFB9B3A9),
    error = Color(0xFFBA3A28),
)

@Composable
fun FilterPodTheme(theme: String, content: @Composable () -> Unit) {
    val dark = when (theme) {
        "light" -> false
        "system" -> isSystemInDarkTheme()
        else -> true // "dark" is the default, and unknown values fail dark.
    }
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        content = content,
    )
}
