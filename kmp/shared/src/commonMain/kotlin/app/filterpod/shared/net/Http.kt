package app.filterpod.shared.net

/**
 * The one HTTP seam in commonMain.
 *
 * Everything network-shaped in the domain layer — feed refresh, search, transcripts,
 * chapters — talks to this interface, and only the app module provides a real
 * implementation (HttpURLConnection today). That keeps commonMain runnable on any
 * future target and lets JVM tests hand in canned responses.
 */
interface Http {
    suspend fun get(url: String, headers: Map<String, String> = emptyMap()): HttpResponse
}

class HttpResponse(
    val status: Int,
    /** Lower-cased header names. */
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    fun bodyText(): String = body.decodeToString()
}
