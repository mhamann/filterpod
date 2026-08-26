package app.filterpod.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import app.filterpod.ui.Ember

/** `[label](https://…)`, as the feed parser writes anchors that had real text. */
private val MARKDOWN_LINK = Regex("""\[([^\]]+)]\((https?://[^)\s]+)\)""")

/** Bare addresses, as show notes write them — with or without a scheme. */
private val BARE_URL = Regex("""(https?://|www\.)[^\s<>"')\]]+""", RegexOption.IGNORE_CASE)

/**
 * Renders show notes: link labels become tappable, their markdown never shows.
 *
 * Styling is deliberately quiet — the app's accent color and nothing else. Show
 * notes are mostly links, and underlining every one of them turns a paragraph into
 * a fence; colour alone is enough to read as tappable without shouting.
 */
@Composable
fun linkified(text: String): AnnotatedString = remember(text) { buildShowNotes(text) }

private val LINK_STYLES = TextLinkStyles(
    style = SpanStyle(color = Ember),
    pressedStyle = SpanStyle(color = Ember, textDecoration = TextDecoration.Underline),
)

private fun buildShowNotes(text: String): AnnotatedString = buildAnnotatedString {
    var index = 0
    // Markdown links first: their labels may themselves contain a bare URL, and the
    // explicit href is always the better target.
    for (match in MARKDOWN_LINK.findAll(text)) {
        appendLinkedPlain(text.substring(index, match.range.first))
        withLink(LinkAnnotation.Url(match.groupValues[2], LINK_STYLES)) {
            append(match.groupValues[1])
        }
        index = match.range.last + 1
    }
    appendLinkedPlain(text.substring(index))
}

/** Appends a stretch that has no markdown links, autolinking any bare addresses. */
private fun AnnotatedString.Builder.appendLinkedPlain(text: String) {
    var index = 0
    for (match in BARE_URL.findAll(text)) {
        append(text.substring(index, match.range.first))
        // Trailing punctuation belongs to the sentence, not the address.
        val raw = match.value.trimEnd('.', ',', ';', ':', '!', '?')
        val href = if (raw.startsWith("www.", ignoreCase = true)) "https://$raw" else raw
        withLink(LinkAnnotation.Url(href, LINK_STYLES)) { append(raw) }
        append(match.value.substring(raw.length))
        index = match.range.last + 1
    }
    append(text.substring(index))
}
