package app.filterpod.ui

/**
 * Display formatting, ported from src/ui/format.ts so the two UIs read identically.
 */

/** Timecode as `M:SS`, or `H:MM:SS` once an hour is reached. */
fun timecode(seconds: Double): String {
    if (!seconds.isFinite() || seconds < 0) return "0:00"
    val total = seconds.toLong()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    fun pad(n: Long) = n.toString().padStart(2, '0')
    return if (h > 0) "$h:${pad(m)}:${pad(s)}" else "$m:${pad(s)}"
}

/** Compact duration for list rows: `1h 12m`, `48m`, `40s`. */
fun durationLabel(seconds: Int?): String {
    if (seconds == null || seconds <= 0) return "--"
    val h = seconds / 3600
    val m = Math.round((seconds % 3600) / 60.0).toInt()
    if (h > 0) return if (m > 0) "${h}h ${m}m" else "${h}h"
    if (seconds < 60) return "${seconds}s"
    return "${m}m"
}

/** Relative publish date, falling back to an absolute date past a fortnight. */
fun relativeDate(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    if (timestamp == 0L) return ""
    val deltaSec = (now - timestamp) / 1000
    val day = 86_400L
    if (deltaSec < 3600) return "Just now"
    if (deltaSec < day) return "${deltaSec / 3600}h ago"
    if (deltaSec < day * 14) return "${deltaSec / day}d ago"
    val fmt = java.text.SimpleDateFormat("MMM d", java.util.Locale.getDefault())
    return fmt.format(java.util.Date(timestamp))
}
