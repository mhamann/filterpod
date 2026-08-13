package app.filterpod.shared.filter

import app.filterpod.shared.model.TranscriptRef
import app.filterpod.shared.net.Http
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * Publisher transcripts from `podcast:transcript`.
 *
 * Ported from src/features/filter/transcript.ts with the same semantics.
 *
 * These are cue-level (2-5 seconds per cue), far too coarse to skip a single word. Their
 * value is different and considerable: a transcript can prove an episode contains no
 * profanity at all — skipping the ASR pass entirely — or narrow a 60-minute transcription
 * down to a handful of 10-second windows. Where transcripts exist, this turns minutes of
 * on-device compute into seconds.
 */

data class Cue(
    val startSec: Double,
    val endSec: Double,
    val text: String,
)

/** A word with its timing. Local to the transcript layer; not a persisted model. */
data class TimedWord(
    val word: String,
    val startSec: Double,
    val endSec: Double,
)

/**
 * JavaScript `Number(string)` for the subset that matters here: trimmed, empty maps to
 * zero, anything unparseable maps to NaN.
 */
private fun jsNumber(raw: String): Double {
    val value = raw.trim()
    if (value.isEmpty()) return 0.0
    return value.toDoubleOrNull() ?: Double.NaN
}

/** JavaScript `Number(x)` over a parsed JSON value; absent (null here) is `undefined`. */
private fun jsNumberOf(element: JsonElement?): Double = when {
    element == null -> Double.NaN
    element is JsonNull -> 0.0
    element is JsonPrimitive -> when {
        element.isString -> jsNumber(element.content)
        element.booleanOrNull != null -> if (element.booleanOrNull == true) 1.0 else 0.0
        else -> element.doubleOrNull ?: Double.NaN
    }
    else -> Double.NaN
}

/** `HH:MM:SS.mmm`, `MM:SS.mmm`, and the SRT comma variant. */
internal fun parseTimestamp(raw: String): Double {
    val value = raw.trim().replaceFirst(",", ".")
    val parts = value.split(":").map { jsNumber(it) }
    if (parts.any { it.isNaN() }) return 0.0
    if (parts.size == 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.size == 2) return parts[0] * 60 + parts[1]
    return parts.firstOrNull() ?: 0.0
}

private val CUE_TIMING =
    Regex("""(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}""")
private val INLINE_TAG = Regex("<[^>]*>")
private val SPEAKER_LABEL = Regex("""^[A-Z][A-Za-z .'-]{0,30}:\s*""")
private val WHITESPACE = Regex("""\s+""")

/** Parses WebVTT and SubRip, which differ little enough to share one path. */
fun parseCues(content: String): List<Cue> {
    val cues = mutableListOf<Cue>()
    val blocks = content.replace("\r\n", "\n").split(Regex("\n{2,}"))

    for (block in blocks) {
        val lines = block.split("\n").filter { it.isNotBlank() }
        if (lines.isEmpty()) continue

        val timingIndex = lines.indexOfFirst { CUE_TIMING.containsMatchIn(it) }
        if (timingIndex == -1) continue

        val timingParts = lines[timingIndex].split("-->")
        val startRaw = timingParts[0]
        val endRaw = timingParts.getOrElse(1) { "" }
        // Cue settings (align, position) trail the end timestamp; take the first token.
        val text = SPEAKER_LABEL.replaceFirst(
            // Speaker labels and inline VTT tags carry no words we care about.
            lines.drop(timingIndex + 1).joinToString(" ").replace(INLINE_TAG, ""),
            "",
        ).trim()

        if (text.isEmpty()) continue
        cues += Cue(
            startSec = parseTimestamp(startRaw),
            endSec = parseTimestamp(endRaw.trim().split(WHITESPACE)[0]),
            text = text,
        )
    }

    return cues
}

/** JavaScript truthiness for a parsed JSON value. */
private fun truthy(element: JsonElement?): Boolean = when {
    element == null || element is JsonNull -> false
    element is JsonPrimitive -> when {
        element.isString -> element.content.isNotEmpty()
        element.booleanOrNull != null -> element.booleanOrNull == true
        else -> element.doubleOrNull?.let { it != 0.0 && !it.isNaN() } ?: true
    }
    else -> true
}

/** The Podcasting 2.0 speech-to-text JSON format, which does carry word timings. */
internal fun parseJsonTranscript(content: String): List<TimedWord>? {
    val parsed = try {
        Json.parseToJsonElement(content)
    } catch (_: Exception) {
        return null
    }
    val segments = (parsed as? JsonObject)?.get("segments") as? JsonArray ?: return null

    val words = mutableListOf<TimedWord>()
    for (element in segments) {
        val segment = element as? JsonObject ?: continue
        val body = segment["body"]
        val startTime = segment["startTime"]
        if (!truthy(body) || startTime == null || startTime is JsonNull) continue

        val endTime = segment["endTime"]
        words += TimedWord(
            word = ((body as? JsonPrimitive)?.content ?: body.toString()).trim(),
            startSec = jsNumberOf(startTime),
            endSec = if (endTime == null || endTime is JsonNull) {
                jsNumberOf(startTime) + 0.3
            } else {
                jsNumberOf(endTime)
            },
        )
    }
    return words
}

class FetchedTranscript(
    /** Cue-level text, always present. */
    val cues: List<Cue>,
    /** Word-level timings, only when the publisher supplied the JSON format. */
    val words: List<TimedWord>?,
)

/** Fetches the best available transcript for an episode, or null if none work. */
suspend fun fetchTranscript(http: Http, refs: List<TranscriptRef>): FetchedTranscript? {
    // JSON carries word timings and is worth trying first; VTT is the most widely published.
    val ordered = refs.sortedBy { rank(it.type) }

    for (ref in ordered) {
        try {
            val response = http.get(ref.url)
            if (response.status != 200) continue
            val content = response.bodyText()

            if (ref.type == "application/json") {
                val words = parseJsonTranscript(content)
                if (!words.isNullOrEmpty()) {
                    return FetchedTranscript(cues = emptyList(), words = words)
                }
                continue
            }

            val cues = parseCues(content)
            if (cues.isNotEmpty()) return FetchedTranscript(cues = cues, words = null)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Try the next transcript rather than failing the whole pipeline.
        }
    }
    return null
}

private fun rank(type: String): Int = when (type) {
    "application/json" -> 0
    "text/vtt" -> 1
    "application/x-subrip" -> 2
    else -> 3
}
