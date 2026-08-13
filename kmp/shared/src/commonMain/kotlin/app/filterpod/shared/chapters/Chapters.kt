package app.filterpod.shared.chapters

import app.filterpod.shared.data.Repo
import app.filterpod.shared.model.Chapter
import app.filterpod.shared.model.Episode
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
 * Podcasting 2.0 chapters (`podcast:chapters`).
 *
 * Ported from src/features/chapters/chapters.ts with the same semantics.
 *
 * A chapters file is a small JSON document the publisher hosts next to the audio:
 * `{ "chapters": [ { "startTime": 123, "title": "…" }, … ] }`. Fetched the first time an
 * episode with a chapters URL is opened, then cached through the Repo — chapters describe
 * a published episode and do not meaningfully change, and the cache is what keeps them
 * working offline alongside a downloaded episode.
 */

/** JavaScript `Number(x)` over a parsed JSON value; absent (null here) is `undefined`. */
private fun jsNumberOf(element: JsonElement?): Double = when {
    element == null -> Double.NaN
    element is JsonNull -> 0.0
    element is JsonPrimitive -> when {
        element.isString -> {
            val trimmed = element.content.trim()
            if (trimmed.isEmpty()) 0.0 else trimmed.toDoubleOrNull() ?: Double.NaN
        }
        element.booleanOrNull != null -> if (element.booleanOrNull == true) 1.0 else 0.0
        else -> element.doubleOrNull ?: Double.NaN
    }
    else -> Double.NaN
}

/**
 * Normalizes a fetched chapters document into clean, ordered markers.
 *
 * Defensive on purpose: chapter files are third-party data. Non-numeric or negative
 * start times are dropped rather than guessed at, entries marked `toc: false` are
 * honoured (the spec uses that for markers that should not appear in a chapter list),
 * and duplicate start times keep only the first — two chapters cannot begin at the
 * same instant, and rendering both would make the seek target ambiguous.
 */
fun normalizeChapters(raw: JsonElement?): List<Chapter> {
    val document = raw as? JsonObject ?: return emptyList()
    val list = document["chapters"] as? JsonArray ?: return emptyList()

    val out = mutableListOf<Chapter>()
    for (entry in list) {
        val chapter = entry as? JsonObject ?: continue
        // `toc === false` in the source: a real JSON boolean, not the string "false".
        val toc = chapter["toc"]
        if (toc is JsonPrimitive && !toc.isString && toc.booleanOrNull == false) continue
        val startSec = jsNumberOf(chapter["startTime"])
        if (!startSec.isFinite() || startSec < 0) continue
        val title = (chapter["title"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val img = (chapter["img"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        out += Chapter(
            startSec = startSec,
            title = title?.trim() ?: "",
            imageUrl = img?.takeIf { it.isNotEmpty() },
        )
    }

    out.sortBy { it.startSec }
    return out.filterIndexed { index, chapter ->
        index == 0 || chapter.startSec != out[index - 1].startSec
    }
}

/**
 * Chapters for an episode: cache first, network second, empty on any failure.
 *
 * Failure is silent by design — chapters are an enhancement, and an unreachable
 * chapters file should cost nothing more than the list not appearing.
 */
suspend fun getChapters(episode: Episode, repo: Repo, http: Http, now: Long): List<Chapter> {
    val chaptersUrl = episode.chaptersUrl ?: return emptyList()

    repo.getCachedChapters(episode.id)?.let { return it }

    return try {
        val response = http.get(chaptersUrl)
        if (response.status != 200) return emptyList()
        val chapters = normalizeChapters(Json.parseToJsonElement(response.bodyText()))
        // Empty results are cached too: a chapters URL that yields nothing will keep
        // yielding nothing, and refetching it on every open is pure waste.
        repo.putCachedChapters(episode.id, chapters, now)
        chapters
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        emptyList()
    }
}

/** The chapter the playhead is currently inside, or null before the first marker. */
fun chapterAt(chapters: List<Chapter>, positionSec: Double): Chapter? {
    var current: Chapter? = null
    for (chapter in chapters) {
        if (chapter.startSec <= positionSec) current = chapter
        else break
    }
    return current
}
