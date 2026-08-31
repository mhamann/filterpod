package app.filterpod

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import java.net.HttpURLConnection
import java.net.URL

/**
 * Pins a streamed episode to one stitched copy of itself.
 *
 * Podcast enclosures for ad-supported shows are not files; they are assembled per
 * request. The URL in the feed is a measurement prefix that redirects, and the host at
 * the end of the chain splices ads into the content and hands back a session-scoped URL
 * for the copy it just built. This episode's chain runs
 * pscrb.fm -> prefix-v4.pscrb.fm -> traffic.megaphone.fm -> dcs-spotify.megaphone.fm,
 * and the length of what comes back changed four times in a day: 105,380,390 then
 * 102,638,247 then 102,898,425 then 104,952,907 bytes.
 *
 * The content between ad breaks is the same recording every time, so two copies agree
 * until the first break and then differ by however much the ads differ. A second is
 * therefore only meaningful against one copy. Analysis timed against one and playback
 * reading another disagree by the accumulated difference — measured here at about two
 * seconds — which is enough for the skip to fire exactly on time and cut the wrong audio
 * while the flagged word plays.
 *
 * Resolving the chain once and holding the final URL fixes it: within a resolved session
 * the bytes are stable, and the same range fetched twice comes back byte-identical. The
 * identity of that copy also becomes part of the cache key, so bytes from two different
 * stitches can never end up in one entry — the failure that produced a file which never
 * existed on any server.
 */
object StreamPin {

    /** A resolved copy: where to read it, and which copy it is. */
    data class Pin(
        /** The session URL at the end of the redirect chain. Read everything from this. */
        val url: String,
        /** Identifies the stitch. A change means the audio is not the same audio. */
        val identity: String,
    ) {
        /** Cache entries are per stitch, so two of them cannot be spliced together. */
        fun cacheKey(episodeId: String) = "$episodeId@$identity"
    }

    /**
     * Whether spans timed against [mapIdentity] may be used while reading [pinIdentity].
     *
     * Only a known disagreement disqualifies a map. A null on either side means the copy
     * is unidentified — a download, an unresolvable stream, or a map written before
     * identity was recorded — and those are left alone: they are no worse than they were,
     * and discarding every one of them would re-analyse a whole library at once.
     */
    fun isStale(mapIdentity: String?, pinIdentity: String?): Boolean =
        mapIdentity != null && pinIdentity != null && mapIdentity != pinIdentity

    private const val PREFS = "stream-pins"
    private const val MAX_REDIRECTS = 6

    /**
     * The pin for an episode, resolving and storing one if there is none.
     *
     * Returns null for local files and whenever the network will not answer — the caller
     * then behaves exactly as it did before, reading the feed URL directly. That is worse
     * (it is the state that allowed mixing) but it is not a reason to refuse to play.
     */
    suspend fun forEpisode(context: Context, episodeId: String, audioUrl: String): Pin? {
        if (audioUrl.startsWith("file://") || audioUrl.startsWith("/")) return null
        stored(context, episodeId)?.let { return it }
        val resolved = runCatching { resolve(audioUrl) }
            .onFailure { android.util.Log.i("FilterPod", "stream pin failed for $episodeId: ${it.message}") }
            .getOrNull() ?: return null
        android.util.Log.i("FilterPod", "stream pinned $episodeId -> ${resolved.identity}")
        store(context, episodeId, resolved)
        return resolved
    }

    /** The pin already held for an episode, without touching the network. */
    fun stored(context: Context, episodeId: String): Pin? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val url = prefs.getString("$episodeId.url", null) ?: return null
        val identity = prefs.getString("$episodeId.identity", null) ?: return null
        return Pin(url, identity)
    }

    /**
     * Drops the pin so the next open resolves a fresh copy. For when the session URL has
     * stopped answering — they do expire — and the bytes behind it are no longer readable.
     */
    fun clear(context: Context, episodeId: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("$episodeId.url").remove("$episodeId.identity").apply()
    }

    private fun store(context: Context, episodeId: String, pin: Pin) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("$episodeId.url", pin.url)
            .putString("$episodeId.identity", pin.identity)
            .apply()
    }

    /**
     * Walks the redirect chain by hand and asks for a single byte.
     *
     * One byte rather than a HEAD: a HEAD is allowed to be answered differently from the
     * GET that follows, and on a stitching host that can mean it describes a copy nobody
     * will serve. A ranged GET is answered by the same machinery that will serve the
     * audio, and its Content-Range carries the total length of the copy just built.
     */
    private suspend fun resolve(audioUrl: String): Pin = runInterruptible(Dispatchers.IO) {
        var current = audioUrl
        var redirects = 0
        while (true) {
            val connection = (URL(current).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("User-Agent", "FilterPod")
                setRequestProperty("Range", "bytes=0-0")
            }
            try {
                val status = connection.responseCode
                if (status in 301..308) {
                    val location = connection.getHeaderField("Location")
                        ?: error("redirect without a location at $current")
                    if (++redirects > MAX_REDIRECTS) error("too many redirects from $audioUrl")
                    current = URL(URL(current), location).toString()
                    continue
                }
                if (status != 200 && status != 206) error("HTTP $status resolving $audioUrl")
                return@runInterruptible Pin(current, identityOf(connection))
            } finally {
                connection.disconnect()
            }
        }
        @Suppress("UNREACHABLE_CODE") error("unreachable")
    }

    /**
     * What distinguishes one stitch from another.
     *
     * Total length is the reliable part: every copy differs in it, because the ads differ
     * in length. The session token, when the host puts one in the URL, is added because
     * two stitches can coincidentally weigh the same.
     */
    private fun identityOf(connection: HttpURLConnection): String {
        val range = connection.getHeaderField("Content-Range")      // "bytes 0-0/104952907"
        val total = range?.substringAfter('/', "")?.toLongOrNull()
            ?: connection.getHeaderField("Content-Length")?.toLongOrNull()
            ?: -1L
        val session = Regex("[?&]session_id=([^&]+)").find(connection.url.toString())?.groupValues?.get(1)
        return if (session != null) "len$total.s${session.take(12)}" else "len$total"
    }
}
