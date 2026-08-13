package app.filterpod

import org.json.JSONArray

/**
 * A stretch of audio to skip, on the original (unfiltered) timeline.
 * Mirrors `FilterSpan` in src/core/types.ts.
 */
data class FilterSpan(
    val startMs: Long,
    val endMs: Long,
    val severity: String,
    val category: String,
) {
    companion object {
        /**
         * Parses spans handed over from the web layer.
         *
         * Seconds cross the bridge as doubles; everything native works in milliseconds
         * because that is what ExoPlayer's clock uses.
         */
        fun fromJson(array: JSONArray): List<FilterSpan> {
            val spans = ArrayList<FilterSpan>(array.length())
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val start = (item.optDouble("startSec", 0.0) * 1000).toLong()
                val end = (item.optDouble("endSec", 0.0) * 1000).toLong()
                if (end <= start) continue
                spans.add(
                    FilterSpan(
                        startMs = start,
                        endMs = end,
                        severity = item.optString("severity", "moderate"),
                        category = item.optString("category", "profanity"),
                    )
                )
            }
            // Sorted so lookup during playback can binary search rather than scan.
            return spans.sortedBy { it.startMs }
        }
    }
}

/** Binary search for the span containing [positionMs], or null. */
fun List<FilterSpan>.spanAt(positionMs: Long): FilterSpan? {
    var lo = 0
    var hi = size - 1
    while (lo <= hi) {
        val mid = (lo + hi) ushr 1
        val span = this[mid]
        when {
            positionMs < span.startMs -> hi = mid - 1
            positionMs >= span.endMs -> lo = mid + 1
            else -> return span
        }
    }
    return null
}
