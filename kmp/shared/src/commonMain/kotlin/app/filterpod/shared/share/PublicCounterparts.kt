package app.filterpod.shared.share

import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import kotlin.math.abs
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The public show behind a members-only feed, so it can be shared without the
 * subscriber's credential.
 *
 * Nothing in a member feed points at its public twin — Decoder's ad-free feed has no
 * podcast:guid, no new-feed-url, and a <link> that is just the publisher's homepage.
 * What does line up is observable: the same itunes:author, a title that is the public
 * show's name plus an edition suffix ("Decoder: Ad-Free Edition" / "Decoder with
 * Nilay Patel"), and episodes with identical titles on identical dates but unrelated
 * guids. So the show is found by searching Apple's directory and the episode by title
 * and date — and anything short of one clear answer is no answer. Sharing the wrong
 * show under someone's name is worse than not sharing.
 *
 * Positions do not survive the trip: the public copy carries ads the member copy
 * doesn't, so the same second is a different moment. Callers share episodes found
 * here without one.
 */
class PublicCounterparts(
    private val search: suspend (term: String) -> List<Podcast>,
    private val episodesOf: suspend (feedUrl: String) -> List<Episode>,
) {
    private val mutex = Mutex()

    /** By member podcast id. A miss is remembered too: the directory won't change mid-session. */
    private val shows = mutableMapOf<String, Podcast?>()

    suspend fun show(member: Podcast): Podcast? {
        mutex.withLock { if (member.id in shows) return shows[member.id] }
        val core = coreTitle(member.title)
        val candidates = listOf(core, "$core ${member.author}".trim())
            .distinct()
            .flatMap { search(it) }
            .distinctBy { it.feedUrl }
        val found = pickShow(member, candidates)
        mutex.withLock { shows[member.id] = found }
        return found
    }

    suspend fun episode(publicShow: Podcast, memberEpisode: Episode): Episode? =
        pickEpisode(memberEpisode, episodesOf(publicShow.feedUrl))

    companion object {
        private const val DAY_MS = 24 * 60 * 60 * 1000L

        /** Edition markers member feeds add to the public name, trailing or in brackets. */
        private val EDITION =
            "(?:\\b(?:ad[- ]?free|premium|plus|members?(?: only)?|subscribers?|supporters?|patreon|early access)|\\+)" +
                "(?: (?:edition|version|feed|only))?"
        private val TRAILING = Regex("""\s*[:|–—-]?\s*$EDITION\s*$""", RegexOption.IGNORE_CASE)
        private val BRACKETED = Regex("""\s*[(\[]\s*$EDITION\s*[)\]]\s*$""", RegexOption.IGNORE_CASE)

        /** "Decoder: Ad-Free Edition" → "Decoder". A title with no marker comes back as is. */
        fun coreTitle(title: String): String {
            var core = title.trim()
            while (true) {
                val next = core.replace(BRACKETED, "").replace(TRAILING, "").trim()
                if (next == core || next.isEmpty()) return core
                core = next
            }
        }

        /** Case, punctuation and spacing flattened, for comparing names across feeds. */
        fun normalize(text: String): String =
            text.lowercase()
                .replace(Regex("""['’‘`]"""), "")
                .replace(Regex("""[^\p{L}\p{N}]+"""), " ")
                .trim()

        /**
         * The public show among [candidates], or null unless exactly one qualifies.
         * It must be public, by the same author, and named either exactly the member
         * show's core title or that title followed by more words ("Decoder with Nilay
         * Patel"). An exact name beats a longer one; two of the same kind is a tie, and
         * a tie is no answer.
         */
        fun pickShow(member: Podcast, candidates: List<Podcast>): Podcast? {
            val author = normalize(member.author)
            if (author.isEmpty()) return null
            val core = normalize(coreTitle(member.title))
            if (core.isEmpty()) return null
            val eligible = candidates.filter {
                it.feedUrl != member.feedUrl &&
                    !ShareLinks.isPrivateFeed(it.feedUrl) &&
                    normalize(it.author) == author
            }
            val exact = eligible.filter { normalize(it.title) == core }
            if (exact.isNotEmpty()) return exact.singleOrNull()
            return eligible.filter { normalize(it.title).startsWith("$core ") }.singleOrNull()
        }

        /**
         * The public copy of [memberEpisode]: the same title, published within a day
         * of it. Dates are compared because shows reuse titles ("Mailbag", "Q&A").
         */
        fun pickEpisode(memberEpisode: Episode, candidates: List<Episode>): Episode? {
            val title = normalize(memberEpisode.title)
            if (title.isEmpty()) return null
            val sameTitle = candidates.filter { normalize(it.title) == title }
            val published = memberEpisode.publishedAt
            if (published == 0L) return sameTitle.singleOrNull()
            val near = sameTitle
                .filter { it.publishedAt != 0L && abs(it.publishedAt - published) <= DAY_MS }
                .sortedBy { abs(it.publishedAt - published) }
            return when {
                near.size <= 1 -> near.firstOrNull()
                // Two copies within a day: take the closer only if it is clearly closer.
                abs(near[0].publishedAt - published) < abs(near[1].publishedAt - published) -> near[0]
                else -> null
            }
        }
    }
}
