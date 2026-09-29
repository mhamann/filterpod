package app.filterpod.shared.share

import app.filterpod.shared.data.fnv1a
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Links to filterpod.app's share pages, which web/share serves.
 *
 *   /p/<feed>                 a podcast
 *   /e/<feed>/<episode>?t=90  an episode, optionally from a position
 *
 * <feed> is the feed URL, trimmed, as unpadded base64url; <episode> is the same
 * FNV-1a of the guid that ends every episode id. Both sides must agree to the byte —
 * web/share/src/links.ts is the other half, and ShareLinksTest pins vectors that
 * were produced by it.
 */
object ShareLinks {
    const val ORIGIN = "https://filterpod.app"

    @OptIn(ExperimentalEncodingApi::class)
    private val base64Url = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT)

    @OptIn(ExperimentalEncodingApi::class)
    fun feedToken(feedUrl: String): String = base64Url.encode(feedUrl.trim().encodeToByteArray())

    fun podcastUrl(feedUrl: String): String = "$ORIGIN/p/${feedToken(feedUrl)}"

    /**
     * Whether a feed URL looks like a personal, paid one, which must never go into a
     * share link.
     *
     * Members-only feeds (Supporting Cast, Supercast, Patreon, Substack, Memberful…)
     * are one URL per subscriber, and the URL itself is the credential: whoever has
     * it gets the paid episodes, and the host may cut off the subscriber it leaks
     * from. So this errs toward private. A public feed misjudged here only loses its
     * share button; a private one misjudged the other way gives the subscription away.
     */
    fun isPrivateFeed(feedUrl: String): Boolean {
        val match = FEED_URL.matchEntire(feedUrl.trim()) ?: return true
        val (authority, path, query) = match.destructured
        if ('@' in authority) return true // user:password@host
        val host = authority.substringBefore(':').lowercase()
        if (PRIVATE_HOSTS.any { host == it || host.endsWith(".$it") }) return true
        val segments = path.split('/').filter { it.isNotEmpty() }
        if (segments.any { it.equals("private", ignoreCase = true) }) return true
        if (segments.any { looksLikeToken(it.substringBeforeLast('.')) }) return true
        val keys = query.split('&').map { it.substringBefore('=').lowercase() }
        return keys.any { key -> CREDENTIAL_KEYS.any { it in key } }
    }

    private val FEED_URL = Regex("""^https?://([^/?#]+)([^?#]*)(?:\?([^#]*))?.*$""", RegexOption.IGNORE_CASE)

    private val PRIVATE_HOSTS = listOf(
        "supportingcast.fm", "supercast.com", "patreon.com", "memberful.com", "glow.fm",
    )

    private val CREDENTIAL_KEYS = listOf("auth", "token", "key", "secret", "sig", "access", "session", "pass")

    private val UUID = Regex("""^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$""", RegexOption.IGNORE_CASE)

    /**
     * A long run of mixed letters and digits: an access token, not a show id. Public
     * hosts use short ids or slugs; Omny's are UUIDs, which are allowed through.
     */
    private fun looksLikeToken(segment: String): Boolean =
        segment.length >= 32 &&
            !UUID.matches(segment) &&
            segment.any { it.isDigit() } &&
            segment.any { it.isLetter() }

    /**
     * [atSec] is on the original, unfiltered timeline — the only one another player
     * shares. Fractions are dropped, and a position of zero means no position.
     */
    fun episodeUrl(feedUrl: String, guid: String, atSec: Double? = null): String {
        val start = atSec?.takeIf { it.isFinite() && it >= 1 }?.toLong()
        val query = if (start != null) "?t=$start" else ""
        return "$ORIGIN/e/${feedToken(feedUrl)}/${fnv1a(guid)}$query"
    }
}
