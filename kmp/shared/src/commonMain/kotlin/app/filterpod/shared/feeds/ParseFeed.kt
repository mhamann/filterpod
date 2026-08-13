package app.filterpod.shared.feeds

import app.filterpod.shared.data.episodeIdFor
import app.filterpod.shared.data.podcastIdFor
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.model.TranscriptRef
import kotlin.math.floor

/**
 * RSS parsing for podcast feeds, ported from src/features/feeds/parseFeed.ts.
 *
 * Covers RSS 2.0 plus the itunes namespace (the de-facto standard) and the parts of the
 * podcast namespace we actually use — chiefly `podcast:transcript`, which is what lets
 * the filter pipeline skip or narrow an expensive ASR pass.
 *
 * The TS parser was written against fast-xml-parser's document shapes, and the migrated
 * database's episode ids were minted from strings produced by those shapes. So this port
 * keeps a faithful mirror of them (see [Node]) rather than a tidier tree walk: the same
 * feed must yield the same guid string — down to the pathological cases — or ids diverge
 * and listening history orphans.
 */

/**
 * One parsed XML element. Platform tokenizers produce these; all interpretation
 * (trimming, entity cleanup, model assembly) happens here in common code.
 *
 * Contract for producers: [name] and attribute keys are the qualified names with any
 * namespace prefix kept ("itunes:duration"), [text] is the raw concatenation of the
 * element's direct character data (text and CDATA, in order, untrimmed), and attribute
 * values are raw except for XML-level entity decoding.
 */
class XmlElement(
    val name: String,
    val attributes: Map<String, String>,
    val children: List<XmlElement>,
    val text: String,
)

/** The tokenizer seam: platform code turns raw XML into an element tree. */
fun interface FeedXmlReader {
    /** Returns the document's root element. Throws on XML that cannot be parsed. */
    fun parse(xml: String): XmlElement
}

/**
 * Mirror of fast-xml-parser's value shapes: a child element is a bare string when it has
 * no attributes and no children, an object otherwise, and an array when repeated. The
 * helpers below reproduce the TS accessors (`text`, `attr`, `asArray`) over these shapes
 * exactly, JS stringification quirks included.
 */
private sealed interface Node
private class Scalar(val value: String) : Node
private class Element(val el: XmlElement) : Node
private class Many(val items: List<Node>) : Node

private fun nodeOf(el: XmlElement): Node =
    if (el.attributes.isEmpty() && el.children.isEmpty()) Scalar(el.text.trim()) else Element(el)

/** Feed elements are singular or repeated depending on count; [asArray] normalizes. */
private fun XmlElement.node(name: String): Node? {
    val matches = children.filter { it.name == name }
    return when (matches.size) {
        0 -> null
        1 -> nodeOf(matches[0])
        else -> Many(matches.map { nodeOf(it) })
    }
}

/** Child lookup that, like a JS property access, yields nothing on strings and arrays. */
private fun prop(node: Node?, name: String): Node? = (node as? Element)?.el?.node(name)

private fun asArray(node: Node?): List<Node> = when (node) {
    null -> emptyList()
    is Many -> node.items
    else -> listOf(node)
}

/**
 * The TS `text` helper: the string itself for a bare element, its text for an
 * attributed one. An attributed element with no text stringifies the way JS stringifies
 * an object, and a repeated element the way JS stringifies an array — preserved because
 * episode ids were minted from these strings (an empty `<guid isPermaLink="false">`
 * really did hash "[object Object]").
 */
private fun text(node: Node?): String = when (node) {
    null -> ""
    is Scalar -> node.value
    is Element -> node.el.text.trim().ifEmpty { "[object Object]" }
    is Many -> node.items.joinToString(",") { item ->
        if (item is Scalar) item.value else "[object Object]"
    }
}

/** Attribute access; fast-xml-parser's trimValues trimmed these, so trim here too. */
private fun attr(node: Node?, name: String): String? =
    (node as? Element)?.el?.attributes?.get(name)?.trim()

/** JS Number() over the forms feeds actually contain: '' is 0, junk is NaN. */
private val JS_NUMBER = Regex("""^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$""")

private fun jsNumber(raw: String): Double {
    val value = raw.trim()
    if (value.isEmpty()) return 0.0
    return if (JS_NUMBER.matches(value)) value.toDouble() else Double.NaN
}

/** `Number(x) || undefined`: NaN and 0 both collapse to null. */
private fun jsNumberOrNull(raw: String): Double? =
    jsNumber(raw).takeIf { !it.isNaN() && it != 0.0 }

private val SECONDS_ONLY = Regex("""^\d+(\.\d+)?$""")

/**
 * Accepts `HH:MM:SS`, `MM:SS`, or plain seconds — all three appear in the wild.
 * The plain-seconds form rounds half-up like JS Math.round; the colon forms carry any
 * fraction through the arithmetic (as the TS version did) and truncate only at the Int
 * model field.
 */
fun parseDuration(raw: String): Int? {
    val value = raw.trim()
    if (value.isEmpty()) return null
    if (SECONDS_ONLY.matches(value)) return floor(value.toDouble() + 0.5).toInt()

    val parts = value.split(":").map { jsNumber(it) }
    if (parts.any { it.isNaN() }) return null
    if (parts.size == 2) return (parts[0] * 60 + parts[1]).toInt()
    if (parts.size == 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]).toInt()
    return null
}

private fun parseDate(raw: String): Long = parseDateMillis(raw)

private fun parseExplicit(raw: String): Boolean {
    val value = raw.trim().lowercase()
    return value == "yes" || value == "true" || value == "explicit"
}

private val NAMED_ENTITIES: Map<String, String> = mapOf(
    "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ",
    "ndash" to "–", "mdash" to "—", "hellip" to "…",
    "lsquo" to "‘", "rsquo" to "’", "ldquo" to "“", "rdquo" to "”",
)

private val HEX_ENTITY = Regex("&#x([0-9a-f]+);", RegexOption.IGNORE_CASE)
private val DEC_ENTITY = Regex("&#(\\d+);")
private val NAMED_ENTITY = Regex("&([a-z]+);", RegexOption.IGNORE_CASE)

/**
 * Decodes HTML entities that survive XML parsing.
 *
 * They survive two ways, both rampant in podcast feeds: publishers double-encode
 * (`&amp;#39;` in the XML decodes to the literal text `&#39;`), and text inside CDATA is
 * exempt from XML entity rules entirely, so `&apos;` arrives verbatim. A real feed
 * showed "The King&#39;s Chapel" as its title because of the first. The XML parser is
 * behaving correctly in both cases — this is the app compensating for the wild, the way
 * every podcast client has to.
 *
 * `&amp;` is unfolded first on purpose: that is what turns the double-encoded form into
 * a decodable entity before the numeric and named passes run.
 */
fun decodeEntities(raw: String): String {
    var out = raw.replace("&amp;", "&")
    out = HEX_ENTITY.replace(out) { fromCodePoint(it.groupValues[1].toLongOrNull(16)) }
    out = DEC_ENTITY.replace(out) { fromCodePoint(it.groupValues[1].toLongOrNull()) }
    return NAMED_ENTITY.replace(out) { match ->
        NAMED_ENTITIES[match.groupValues[1].lowercase()] ?: match.value
    }
}

/** String.fromCodePoint, surrogate pairs and the out-of-range throw included. */
private fun fromCodePoint(codePoint: Long?): String {
    require(codePoint != null && codePoint in 0..0x10FFFF) { "Invalid code point $codePoint" }
    val cp = codePoint.toInt()
    if (cp < 0x10000) return cp.toChar().toString()
    val offset = cp - 0x10000
    return charArrayOf(
        (0xD800 + (offset shr 10)).toChar(),
        (0xDC00 + (offset and 0x3FF)).toChar(),
    ).concatToString()
}

private val HTML_TAG = Regex("<[^>]*>")

/** JS `\s`, which includes the Unicode spaces Java's `\s` leaves out. */
private val JS_WHITESPACE =
    Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

/** Strips markup from a description without pulling in a sanitizer dependency. */
private fun stripHtml(html: String): String =
    JS_WHITESPACE.replace(decodeEntities(HTML_TAG.replace(html, " ")), " ").trim()

private val TRANSCRIPT_TYPES: Map<String, String> = mapOf(
    "text/vtt" to "text/vtt",
    "application/x-subrip" to "application/x-subrip",
    "application/srt" to "application/x-subrip",
    "application/json" to "application/json",
    "text/plain" to "text/plain",
)

/**
 * The `podcast:chapters` URL, when the item carries one.
 *
 * The spec says type="application/json+chapters", but plain "application/json" is what
 * some hosts actually emit, so anything JSON-shaped is accepted. Non-JSON chapter
 * formats (PSC XML) exist but are rare enough not to carry a parser for.
 */
private fun parseChaptersUrl(item: Node): String? {
    for (node in asArray(prop(item, "podcast:chapters"))) {
        val url = attr(node, "url")
        val type = (attr(node, "type") ?: "").lowercase()
        if (!url.isNullOrEmpty() && type.contains("json")) return url
    }
    return null
}

private fun parseTranscripts(item: Node): List<TranscriptRef> {
    val refs = mutableListOf<TranscriptRef>()
    for (node in asArray(prop(item, "podcast:transcript"))) {
        val url = attr(node, "url")
        val type = TRANSCRIPT_TYPES[(attr(node, "type") ?: "").lowercase()]
        if (url.isNullOrEmpty() || type == null) continue
        refs.add(TranscriptRef(url = url, type = type, language = attr(node, "language")))
    }
    return refs
}

class ParsedFeed(
    val podcast: Podcast,
    val episodes: List<Episode>,
)

fun parseFeed(xml: String, feedUrl: String, reader: FeedXmlReader, nowMillis: Long): ParsedFeed {
    val root = reader.parse(xml)
    // fast-xml-parser hands back a document object keyed by root element name; the TS
    // code then walks `doc.rss ?? doc` and `rss.channel ?? rss`. A synthetic document
    // element reproduces both fallbacks (and their tolerance of channel-as-root feeds).
    val doc = XmlElement("#document", emptyMap(), listOf(root), "")
    val rss: Node = doc.node("rss") ?: Element(doc)
    val channelNode: Node = prop(rss, "channel") ?: rss
    val channel = (channelNode as? Element)?.el
        ?: throw IllegalArgumentException("not a podcast feed: no channel element")

    val id = podcastIdFor(feedUrl)

    val artworkUrl = attr(channel.node("itunes:image"), "href")
        ?: text(prop(channel.node("image"), "url"))

    val categories = asArray(channel.node("itunes:category"))
        .map { attr(it, "text") ?: "" }
        .filter { it.isNotEmpty() }

    val podcast = Podcast(
        id = id,
        feedUrl = feedUrl,
        title = decodeEntities(text(channel.node("title"))).ifEmpty { "Untitled podcast" },
        author = decodeEntities(
            text(channel.node("itunes:author")).ifEmpty { text(channel.node("managingEditor")) },
        ),
        description = stripHtml(
            text(channel.node("description")).ifEmpty { text(channel.node("itunes:summary")) },
        ),
        artworkUrl = artworkUrl,
        link = text(channel.node("link")).takeIf { it.isNotEmpty() },
        categories = categories,
        explicit = parseExplicit(text(channel.node("itunes:explicit"))),
        lastFetchedAt = nowMillis,
    )

    val episodes = mutableListOf<Episode>()
    for (item in asArray(channel.node("item"))) {
        val enclosure = prop(item, "enclosure")
        val audioUrl = attr(enclosure, "url")
        // An item without playable audio is not an episode.
        if (audioUrl.isNullOrEmpty()) continue

        val guid = text(prop(item, "guid")).ifEmpty { audioUrl }

        val durationSec = parseDuration(text(prop(item, "itunes:duration")))
        val lengthAttr = attr(enclosure, "length")

        episodes.add(
            Episode(
                id = episodeIdFor(id, guid),
                podcastId = id,
                guid = guid,
                title = decodeEntities(text(prop(item, "title"))).ifEmpty { "Untitled episode" },
                description = stripHtml(
                    text(prop(item, "content:encoded"))
                        .ifEmpty { text(prop(item, "description")) }
                        .ifEmpty { text(prop(item, "itunes:summary")) },
                ),
                audioUrl = audioUrl,
                audioType = attr(enclosure, "type"),
                audioLength = if (lengthAttr.isNullOrEmpty()) null else jsNumberOrNull(lengthAttr)?.toLong(),
                durationSec = durationSec,
                publishedAt = parseDate(text(prop(item, "pubDate"))),
                episodeNumber = jsNumberOrNull(text(prop(item, "itunes:episode")))?.toInt(),
                seasonNumber = jsNumberOrNull(text(prop(item, "itunes:season")))?.toInt(),
                explicit = parseExplicit(text(prop(item, "itunes:explicit"))) || podcast.explicit,
                artworkUrl = attr(prop(item, "itunes:image"), "href"),
                transcripts = parseTranscripts(item),
                chaptersUrl = parseChaptersUrl(item),
            ),
        )
    }

    return ParsedFeed(podcast, episodes)
}

// --- dates -------------------------------------------------------------------

private val MONTHS =
    listOf("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")

private val RFC2822_DATE = Regex(
    """^(?:[a-z]{3,}\s*,?\s*)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([a-z]{1,3}|[+-]\d{4})?\s*$""",
    RegexOption.IGNORE_CASE,
)

/** Offsets in minutes for the zone names JS Date.parse accepts. */
private val ZONE_OFFSETS_MIN = mapOf(
    "z" to 0, "ut" to 0, "utc" to 0, "gmt" to 0,
    "est" to -300, "edt" to -240, "cst" to -360, "cdt" to -300,
    "mst" to -420, "mdt" to -360, "pst" to -480, "pdt" to -420,
)

private val ISO_DATE = Regex(
    """^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[tT ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([zZ]|[+-]\d{2}:?\d{2})?)?$""",
)

/**
 * The TS parseDate was `Date.parse(raw)` with NaN mapped to 0. This covers the two
 * families feeds actually use — RFC 2822 pubDates and ISO 8601 — returning 0 for
 * anything else. One deliberate divergence: JS reads a missing timezone as device-local
 * time, which is neither reproducible nor desirable here, so a missing zone reads UTC.
 */
internal fun parseDateMillis(raw: String): Long {
    val value = raw.trim()
    if (value.isEmpty()) return 0

    RFC2822_DATE.matchEntire(value)?.let { m ->
        val day = m.groupValues[1].toInt()
        val monthIndex = MONTHS.indexOf(m.groupValues[2].lowercase())
        if (monthIndex < 0) return 0
        var year = m.groupValues[3].toInt()
        // Two-digit years per RFC 2822: 00-49 are 2000s, 50-99 are 1900s.
        if (year < 50) year += 2000 else if (year < 100) year += 1900
        val hour = m.groupValues[4].toIntOrNull() ?: 0
        val minute = m.groupValues[5].toIntOrNull() ?: 0
        val second = m.groupValues[6].toIntOrNull() ?: 0
        val zone = m.groupValues[7]
        val offsetMinutes = when {
            zone.isEmpty() -> 0
            zone[0] == '+' || zone[0] == '-' -> parseNumericOffsetMinutes(zone) ?: return 0
            else -> ZONE_OFFSETS_MIN[zone.lowercase()] ?: return 0
        }
        if (hour > 24 || minute > 59 || second > 60) return 0
        return utcMillis(year, monthIndex + 1, day, hour, minute, second, 0) - offsetMinutes * 60_000L
    }

    ISO_DATE.matchEntire(value)?.let { m ->
        val year = m.groupValues[1].toInt()
        val month = m.groupValues[2].toInt()
        val day = m.groupValues[3].toIntOrNull() ?: 1
        val hour = m.groupValues[4].toIntOrNull() ?: 0
        val minute = m.groupValues[5].toIntOrNull() ?: 0
        val second = m.groupValues[6].toIntOrNull() ?: 0
        val fraction = m.groupValues[7]
        val millis = if (fraction.isEmpty()) 0 else fraction.padEnd(3, '0').take(3).toInt()
        val zone = m.groupValues[8]
        val offsetMinutes = when {
            zone.isEmpty() || zone.equals("z", ignoreCase = true) -> 0
            else -> parseNumericOffsetMinutes(zone) ?: return 0
        }
        if (month !in 1..12 || day !in 1..31 || hour > 24 || minute > 59 || second > 60) return 0
        return utcMillis(year, month, day, hour, minute, second, millis) - offsetMinutes * 60_000L
    }

    return 0
}

/** "+HHMM", "-HH:MM" and friends, as minutes east of UTC. */
private fun parseNumericOffsetMinutes(zone: String): Int? {
    val digits = zone.substring(1).replace(":", "")
    if (digits.length != 4) return null
    val hours = digits.substring(0, 2).toIntOrNull() ?: return null
    val minutes = digits.substring(2, 4).toIntOrNull() ?: return null
    val magnitude = hours * 60 + minutes
    return if (zone[0] == '-') -magnitude else magnitude
}

/** Civil date to epoch millis (Howard Hinnant's days-from-civil), overflow-rolling like JS. */
private fun utcMillis(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int, millis: Int): Long {
    val y = if (month <= 2) year - 1 else year
    val era = y.floorDiv(400)
    val yoe = y - era * 400
    val mp = (month + 9) % 12
    val doy = (153 * mp + 2) / 5 + day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    val daysFromEpoch = era * 146097L + doe - 719468L
    return (daysFromEpoch * 86400 + hour * 3600L + minute * 60 + second) * 1000 + millis
}
