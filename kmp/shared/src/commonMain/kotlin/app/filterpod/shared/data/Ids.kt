package app.filterpod.shared.data

/**
 * Stable ids, ported bit-for-bit from src/data/db.ts.
 *
 * These MUST match the TypeScript implementation exactly: every episodeId in the
 * migrated backup (progress, queue) was minted by the TS version, and the importer's
 * feed refresh reconstructs episodes by recomputing the same ids from the same guids.
 * A divergence here silently orphans the user's entire listening history.
 */

fun podcastIdFor(feedUrl: String): String = "p_" + fnv1a(feedUrl.trim().lowercase())

fun episodeIdFor(podcastId: String, guid: String): String = "e_${podcastId}_" + fnv1a(guid)

/**
 * FNV-1a over UTF-16 code units (JavaScript's charCodeAt), rendered unsigned base-36.
 * Not UTF-8: a guid containing a non-BMP character hashes over its surrogate pair
 * halves in JS, and this must reproduce that.
 */
private fun fnv1a(input: String): String {
    var value = 0x811c9dc5.toInt()
    for (ch in input) {
        value = value xor ch.code
        value *= 0x01000193
    }
    return value.toUInt().toString(36)
}
