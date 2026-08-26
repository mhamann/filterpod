package app.filterpod.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.style.TextDecoration
import app.filterpod.ui.Ember

/** Bare URLs, as show notes write them — with or without a scheme. */
private val URL = Regex("""(https?://|www\.)[^\s<>"')\]]+""", RegexOption.IGNORE_CASE)

/**
 * Makes the links in show notes tappable.
 *
 * Podcast descriptions are mostly prose and links — the website, the socials, the
 * thing mentioned in the episode. The markup carrying those links is stripped at
 * parse time (no HTML should reach a Text composable), so the URLs arrive as plain
 * text; this hands them back their behavior.
 */
@Composable
fun linkified(text: String): AnnotatedString {
    val linkColor = Ember
    return remember(text, linkColor) {
        buildAnnotatedString {
            var index = 0
            for (match in URL.findAll(text)) {
                append(text.substring(index, match.range.first))
                // Trailing punctuation belongs to the sentence, not the address.
                val raw = match.value.trimEnd('.', ',', ';', ':', '!', '?')
                val href = if (raw.startsWith("www.", ignoreCase = true)) "https://$raw" else raw
                withLink(
                    LinkAnnotation.Url(
                        href,
                        TextLinkStyles(
                            style = SpanStyle(
                                color = linkColor,
                                textDecoration = TextDecoration.Underline,
                            ),
                        ),
                    ),
                ) { append(raw) }
                append(match.value.substring(raw.length))
                index = match.range.last + 1
            }
            append(text.substring(index))
        }
    }
}
