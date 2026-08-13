package app.filterpod.shared.discovery

import app.filterpod.shared.data.podcastIdFor
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.net.Http
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * Podcast discovery via the iTunes Search API and Apple's marketing-tools chart.
 *
 * Ported from src/features/discovery/search.ts and charts.ts with the same endpoints,
 * defaults, and error behavior; results map into the shared [Podcast] model.
 *
 * iTunes is chosen because it is public, needs no key and no account, and returns
 * `feedUrl` directly — which is what satisfies the no-server constraint. Podcast Index
 * offers richer data but requires an API key and HMAC secret, and a secret embedded in
 * a distributed APK is not a secret.
 */

private const val SEARCH_ENDPOINT = "https://itunes.apple.com/search"

// The canonical host — applemarketingtools.com now 301s here, and there is no reason
// to spend a round trip on the redirect.
private const val CHART_URL =
    "https://rss.marketingtools.apple.com/api/v2/us/podcasts/top/30/podcasts.json"
private const val LOOKUP_URL = "https://itunes.apple.com/lookup"

/** A search hit: the podcast itself, plus iTunes' episode count (no home on [Podcast]). */
data class SearchResult(
    val podcast: Podcast,
    val episodeCount: Int? = null,
)

class Discovery(private val http: Http) {

    /**
     * Cached for the session. The chart moves daily at most, and refetching two requests
     * every time the tab is flipped to would be pure waste on a phone.
     */
    private var chartCache: List<Podcast>? = null

    suspend fun searchPodcasts(term: String, limit: Int = 25): List<SearchResult> {
        val query = term.trim()
        if (query.isEmpty()) return emptyList()

        val url = SEARCH_ENDPOINT + "?" + formUrlEncode(
            listOf(
                "media" to "podcast",
                "entity" to "podcast",
                "term" to query,
                "limit" to limit.toString(),
            ),
        )

        val response = http.get(url)
        if (response.status != 200) {
            throw RuntimeException("search failed: HTTP ${response.status}")
        }

        val body = Json.parseToJsonElement(response.bodyText())
        val rawResults = (body as? JsonObject)?.get("results") as? JsonArray ?: JsonArray(emptyList())

        val results = mutableListOf<SearchResult>()
        // iTunes lists the same feed more than once (regional storefronts, renamed
        // collections). Since a feed URL is the app's identity for a podcast, duplicates
        // would collide on id — dedupe here rather than papering over it in the UI.
        val seen = mutableSetOf<String>()

        for (element in rawResults) {
            val result = element as? JsonObject ?: continue
            // A result without a feed URL is useless to us — we cannot subscribe to it.
            val feedUrl = result.stringField("feedUrl")?.takeIf { it.isNotEmpty() } ?: continue
            val id = podcastIdFor(feedUrl)
            if (!seen.add(id)) continue

            results += SearchResult(
                podcast = Podcast(
                    id = id,
                    feedUrl = feedUrl,
                    title = result.stringField("collectionName")
                        ?: result.stringField("trackName")
                        ?: "Untitled",
                    author = result.stringField("artistName") ?: "",
                    artworkUrl = result.stringField("artworkUrl600")
                        ?: result.stringField("artworkUrl100")
                        ?: "",
                    categories = (result["genres"] as? JsonArray)
                        ?.mapNotNull { genre -> (genre as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content }
                        ?: emptyList(),
                ),
                episodeCount = (result["trackCount"] as? JsonPrimitive)?.intOrNull,
            )
        }

        return results
    }

    suspend fun fetchTopPodcasts(): List<Podcast> {
        chartCache?.let { return it }

        val chartResponse = http.get(CHART_URL)
        if (chartResponse.status != 200) {
            throw RuntimeException("chart failed: HTTP ${chartResponse.status}")
        }
        val chart = Json.parseToJsonElement(chartResponse.bodyText())
        val rawEntries = ((chart as? JsonObject)?.get("feed") as? JsonObject)
            ?.get("results") as? JsonArray ?: JsonArray(emptyList())
        val entries = rawEntries.mapNotNull { element ->
            val entry = element as? JsonObject ?: return@mapNotNull null
            val id = entry.primitiveContent("id")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            id to entry
        }
        if (entries.isEmpty()) return emptyList()

        val lookupResponse = http.get(
            LOOKUP_URL + "?" + formUrlEncode(
                listOf(
                    "id" to entries.joinToString(",") { it.first },
                    "entity" to "podcast",
                ),
            ),
        )
        if (lookupResponse.status != 200) {
            throw RuntimeException("lookup failed: HTTP ${lookupResponse.status}")
        }
        val lookup = Json.parseToJsonElement(lookupResponse.bodyText())
        val lookupResults = (lookup as? JsonObject)?.get("results") as? JsonArray ?: JsonArray(emptyList())
        val byId = buildMap {
            for (element in lookupResults) {
                val result = element as? JsonObject ?: continue
                val collectionId = result.primitiveContent("collectionId")
                    ?.takeIf { it.isNotEmpty() && it != "0" } ?: continue
                if (result.stringField("feedUrl").isNullOrEmpty()) continue
                if (collectionId !in this) put(collectionId, result)
            }
        }

        // Walk the chart order, not the lookup order — the lookup endpoint returns results
        // in whatever order it likes, and the chart ranking is the whole point.
        val out = mutableListOf<Podcast>()
        val seen = mutableSetOf<String>()
        for ((entryId, entry) in entries) {
            val detail = byId[entryId] ?: continue
            val feedUrl = detail.stringField("feedUrl")?.takeIf { it.isNotEmpty() } ?: continue
            val id = podcastIdFor(feedUrl)
            if (!seen.add(id)) continue
            out += Podcast(
                id = id,
                feedUrl = feedUrl,
                title = detail.stringField("collectionName") ?: entry.stringField("name") ?: "",
                author = detail.stringField("artistName") ?: entry.stringField("artistName") ?: "",
                artworkUrl = detail.stringField("artworkUrl600")
                    ?: detail.stringField("artworkUrl100")
                    ?: "",
            )
        }

        chartCache = out
        return out
    }
}

/** A field that is present as a JSON string, mirroring the TS optional-string reads. */
private fun JsonObject.stringField(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A field's raw content when it is any non-null primitive (chart ids, collection ids). */
private fun JsonObject.primitiveContent(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

/**
 * `URLSearchParams` serialization: application/x-www-form-urlencoded, so spaces become
 * `+` and everything outside `[A-Za-z0-9*\-._]` is percent-encoded UTF-8.
 */
internal fun formUrlEncode(params: List<Pair<String, String>>): String =
    params.joinToString("&") { (key, value) ->
        urlEncodeComponent(key) + "=" + urlEncodeComponent(value)
    }

private const val HEX = "0123456789ABCDEF"

private fun urlEncodeComponent(value: String): String {
    val out = StringBuilder()
    for (byte in value.encodeToByteArray()) {
        val code = byte.toInt() and 0xff
        val ch = code.toChar()
        when {
            ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' ||
                ch == '*' || ch == '-' || ch == '.' || ch == '_' -> out.append(ch)
            ch == ' ' -> out.append('+')
            else -> out.append('%').append(HEX[code shr 4]).append(HEX[code and 0xf])
        }
    }
    return out.toString()
}
