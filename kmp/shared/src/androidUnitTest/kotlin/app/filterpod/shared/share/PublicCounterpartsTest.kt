package app.filterpod.shared.share

import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.Podcast
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Titles, authors, dates and durations here are Decoder's and the Vergecast's as the
 * two feeds actually published them (September 2026); feed URLs of member feeds are
 * made up, since the real ones are credentials.
 */
class PublicCounterpartsTest {

    private fun podcast(title: String, author: String, feedUrl: String) =
        Podcast(id = feedUrl, feedUrl = feedUrl, title = title, author = author)

    private fun episode(title: String, publishedAt: Long, guid: String = title) =
        Episode(id = guid, podcastId = "p", guid = guid, title = title, audioUrl = "https://a/$guid.mp3", publishedAt = publishedAt)

    private val memberDecoder = podcast(
        "Decoder: Ad-Free Edition", "The Verge",
        "https://verge.supportingcast.fm/content/eyJ0IjoicCIsImMiOiIyMDc1MCIsInUiOiIxMjM0In0.rss",
    )
    private val publicDecoder = podcast("Decoder with Nilay Patel", "The Verge", "https://feeds.megaphone.fm/recodedecode")
    private val vergecast = podcast("The Vergecast", "The Verge", "https://feeds.megaphone.fm/vergecast")
    private val versionHistory = podcast("Version History", "The Verge", "https://feeds.megaphone.fm/VMP1872211679")

    @Test
    fun stripsEditionMarkers() {
        assertEquals("Decoder", PublicCounterparts.coreTitle("Decoder: Ad-Free Edition"))
        assertEquals("The Vergecast", PublicCounterparts.coreTitle("The Vergecast: Ad-Free Edition"))
        assertEquals("Some Show", PublicCounterparts.coreTitle("Some Show (Ad-Free)"))
        assertEquals("Some Show", PublicCounterparts.coreTitle("Some Show - Premium Feed"))
        assertEquals("Some Show", PublicCounterparts.coreTitle("Some Show | Patreon Edition"))
        assertEquals("Some Show", PublicCounterparts.coreTitle("Some Show [Members Only]"))
        assertEquals("Some Show", PublicCounterparts.coreTitle("Some Show+"))
        assertEquals("Plus", PublicCounterparts.coreTitle("Plus")) // never down to nothing
        assertEquals("Nonplus", PublicCounterparts.coreTitle("Nonplus")) // only whole words
        assertEquals("Decoder with Nilay Patel", PublicCounterparts.coreTitle("Decoder with Nilay Patel"))
    }

    @Test
    fun findsDecoderAmongTheVergesShows() {
        val found = PublicCounterparts.pickShow(memberDecoder, listOf(vergecast, versionHistory, publicDecoder))
        assertEquals(publicDecoder, found)
    }

    @Test
    fun prefersAnExactNameOverALongerOne() {
        val member = podcast("The Vergecast: Ad-Free Edition", "The Verge", "https://verge.supportingcast.fm/x")
        val longer = podcast("The Vergecast Extras", "The Verge", "https://feeds.example.com/extras")
        assertEquals(vergecast, PublicCounterparts.pickShow(member, listOf(longer, vergecast)))
    }

    @Test
    fun refusesAnythingLessThanOneClearMatch() {
        // Another author's show with the right name.
        val impostor = podcast("Decoder", "Someone Else", "https://feeds.example.com/decoder")
        assertNull(PublicCounterparts.pickShow(memberDecoder, listOf(impostor)))
        // Two longer names from the same author: a tie.
        val other = podcast("Decoder Ring", "The Verge", "https://feeds.example.com/ring")
        assertNull(PublicCounterparts.pickShow(memberDecoder, listOf(publicDecoder, other)))
        // The member feed itself, or another member feed, is never the answer.
        val anotherMember = podcast("Decoder", "The Verge", "https://www.patreon.com/rss/decoder?auth=abc")
        assertNull(PublicCounterparts.pickShow(memberDecoder, listOf(memberDecoder, anotherMember)))
        // No author to check against.
        assertNull(PublicCounterparts.pickShow(memberDecoder.copy(author = ""), listOf(publicDecoder)))
    }

    @Test
    fun matchesEpisodesByTitleAndDateNotGuid() {
        val sep28 = 1790586000000L // Mon, 28 Sep 2026 09:00:00 GMT
        val member = episode("The SaaSpocalypse that wasn't, with Atlassian's CEO", sep28, "7bdd5ed2-b91e-11f1-94ea-8352fa03e0a4")
        val public = listOf(
            episode("The SaaSpocalypse that wasn’t, with Atlassian’s CEO", sep28, "ef63f164-cfc6-11f0-83c5-4b5ce81"),
            episode("Can Cloudflare save the web from AI?", sep28 - 2 * 86_400_000L),
        )
        assertEquals("ef63f164-cfc6-11f0-83c5-4b5ce81", PublicCounterparts.pickEpisode(member, public)?.guid)
    }

    @Test
    fun treatsARepeatedTitleOnADistantDateAsDifferent() {
        val day = 86_400_000L
        val member = episode("Mailbag", 100 * day)
        assertNull(PublicCounterparts.pickEpisode(member, listOf(episode("Mailbag", 93 * day))))
        assertEquals(
            "near",
            PublicCounterparts.pickEpisode(member, listOf(episode("Mailbag", 93 * day, "far"), episode("Mailbag", 100 * day + 3_600_000, "near")))?.guid,
        )
        // Two equally close copies: no answer.
        assertNull(
            PublicCounterparts.pickEpisode(
                member,
                listOf(episode("Mailbag", 100 * day - 3_600_000, "a"), episode("Mailbag", 100 * day + 3_600_000, "b")),
            ),
        )
    }

    @Test
    fun searchesByCoreTitleAndRemembersTheAnswer() = runTest {
        val terms = mutableListOf<String>()
        val counterparts = PublicCounterparts(
            search = { term -> terms += term; listOf(vergecast, publicDecoder) },
            episodesOf = { emptyList() },
        )
        assertEquals(publicDecoder, counterparts.show(memberDecoder))
        assertEquals(publicDecoder, counterparts.show(memberDecoder))
        assertEquals(listOf("Decoder", "Decoder The Verge"), terms)
    }
}
