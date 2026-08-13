package app.filterpod.shared.feeds

import app.filterpod.shared.data.episodeIdFor
import app.filterpod.shared.data.podcastIdFor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of src/features/feeds/parseFeed.test.ts, with added cases for the pieces whose
 * porting was the riskiest: duration forms, pubDate parsing, and the itunes/podcast
 * namespace fields.
 */
class ParseFeedTest {

    private fun parse(xml: String, feedUrl: String = "https://example.com/feed.xml") =
        parseFeed(xml, feedUrl, XmlFeedReader(), nowMillis = 1_000)

    // --- decodeEntities ------------------------------------------------------
    // Entity handling for the feeds that exist rather than the feeds the spec describes.
    // A real subscription rendered its own name as "The King&#39;s Chapel" — publisher
    // double-encoding — and its episode descriptions carried literal "&apos;" from CDATA.

    @Test
    fun decodesTheDoubleEncodedApostropheThatStartedThis() {
        // In the XML this was &amp;#39; — the parser correctly yields the literal below.
        assertEquals("The King's Chapel", decodeEntities("The King&#39;s Chapel"))
    }

    @Test
    fun decodesNamedNumericAndHexForms() {
        assertEquals(
            "Lord's Day — a \"service\"",
            decodeEntities("Lord&apos;s Day &#8212; a &quot;service&quot;"),
        )
        assertEquals("café", decodeEntities("caf&#xe9;"))
        assertEquals("A ’B’", decodeEntities("A &rsquo;B&rsquo;"))
    }

    @Test
    fun leavesUnknownEntitiesAndBareAmpersandsAlone() {
        assertEquals(
            "Q&A with &unknown; people & friends",
            decodeEntities("Q&A with &unknown; people & friends"),
        )
    }

    // --- parseFeed entity handling: same sample XML as the TS test ----------

    private val entityFeed = """<?xml version="1.0" encoding="utf-8"?>
    <rss><channel>
      <title>The King&amp;#39;s Chapel</title>
      <item>
        <title><![CDATA[The Lord&apos;s Day]]></title>
        <description><![CDATA[Preaching at The King&apos;s Chapel]]></description>
        <enclosure url="https://example.com/ep.mp3" type="audio/mpeg"/>
      </item>
    </channel></rss>"""

    @Test
    fun rendersHumanApostrophesForBothEncodingPathologies() {
        val (podcast, episodes) = parse(entityFeed).let { it.podcast to it.episodes }
        assertEquals("The King's Chapel", podcast.title)
        assertEquals("The Lord's Day", episodes[0].title)
        assertEquals("Preaching at The King's Chapel", episodes[0].description)
    }

    // --- durations -----------------------------------------------------------

    @Test
    fun parsesAllThreeDurationForms() {
        assertEquals(3723, parseDuration("1:02:03"))
        assertEquals(2700, parseDuration("45:00"))
        assertEquals(90, parseDuration("90"))
        assertEquals(91, parseDuration("90.5")) // JS Math.round on the seconds form
        assertEquals(83, parseDuration(" 1:23 "))
    }

    @Test
    fun rejectsDurationsThatAreNotDurations() {
        assertNull(parseDuration(""))
        assertNull(parseDuration("   "))
        assertNull(parseDuration("abc"))
        assertNull(parseDuration("1:xx"))
        assertNull(parseDuration("1:2:3:4"))
    }

    // --- dates ---------------------------------------------------------------

    @Test
    fun parsesRfc2822AndIsoPubDates() {
        val expected = 1_655_289_000_000L // 2022-06-15T10:30:00Z
        assertEquals(expected, parseDateMillis("Wed, 15 Jun 2022 10:30:00 GMT"))
        assertEquals(expected, parseDateMillis("Wed, 15 Jun 2022 06:30:00 -0400"))
        assertEquals(expected, parseDateMillis("Wed, 15 Jun 2022 05:30:00 EST"))
        assertEquals(expected, parseDateMillis("15 Jun 2022 10:30:00 +0000"))
        assertEquals(expected, parseDateMillis("2022-06-15T10:30:00Z"))
        assertEquals(expected, parseDateMillis("2022-06-15T10:30:00.000+00:00"))
        assertEquals(0L, parseDateMillis(""))
        assertEquals(0L, parseDateMillis("not a date"))
    }

    // --- the full field map --------------------------------------------------

    private val fullFeed = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test &amp; Learn</title>
    <link>https://example.com/show</link>
    <description>A show about &lt;b&gt;tests&lt;/b&gt;</description>
    <itunes:author>Jane Doe</itunes:author>
    <itunes:explicit>yes</itunes:explicit>
    <itunes:image href="https://example.com/art.jpg"/>
    <itunes:category text="Technology"/>
    <itunes:category text="Education"/>
    <item>
      <title>Episode 1</title>
      <guid isPermaLink="false">ep-1-guid</guid>
      <pubDate>Wed, 15 Jun 2022 10:30:00 GMT</pubDate>
      <itunes:duration>01:02:03</itunes:duration>
      <itunes:episode>1</itunes:episode>
      <itunes:season>2</itunes:season>
      <content:encoded><![CDATA[<p>Rich &amp; formatted</p>]]></content:encoded>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="12345678"/>
      <podcast:transcript url="https://example.com/ep1.vtt" type="text/vtt" language="en"/>
      <podcast:transcript url="https://example.com/ep1.srt" type="application/srt"/>
      <podcast:transcript url="https://example.com/ep1.pdf" type="application/pdf"/>
      <podcast:chapters url="https://example.com/ep1.chapters.json" type="application/json+chapters"/>
    </item>
    <item>
      <title>No guid falls back to enclosure URL</title>
      <itunes:duration>3600</itunes:duration>
      <enclosure url="https://example.com/ep2.mp3" type="audio/mpeg" length="0"/>
    </item>
    <item>
      <title>Not an episode: no enclosure</title>
    </item>
  </channel>
</rss>"""

    @Test
    fun mapsChannelFieldsOntoThePodcast() {
        val podcast = parse(fullFeed).podcast
        assertEquals(podcastIdFor("https://example.com/feed.xml"), podcast.id)
        assertEquals("https://example.com/feed.xml", podcast.feedUrl)
        assertEquals("Test & Learn", podcast.title)
        assertEquals("Jane Doe", podcast.author)
        assertEquals("A show about tests", podcast.description) // markup stripped
        assertEquals("https://example.com/art.jpg", podcast.artworkUrl)
        assertEquals("https://example.com/show", podcast.link)
        assertEquals(listOf("Technology", "Education"), podcast.categories)
        assertTrue(podcast.explicit)
        assertEquals(1_000L, podcast.lastFetchedAt)
    }

    @Test
    fun mapsItemFieldsOntoEpisodes() {
        val parsed = parse(fullFeed)
        assertEquals(2, parsed.episodes.size) // the enclosure-less item is not an episode

        val first = parsed.episodes[0]
        assertEquals("ep-1-guid", first.guid)
        assertEquals(episodeIdFor(parsed.podcast.id, "ep-1-guid"), first.id)
        assertEquals("Episode 1", first.title)
        assertEquals("Rich & formatted", first.description) // content:encoded wins
        assertEquals("https://example.com/ep1.mp3", first.audioUrl)
        assertEquals("audio/mpeg", first.audioType)
        assertEquals(12_345_678L, first.audioLength)
        assertEquals(3723, first.durationSec)
        assertEquals(1_655_289_000_000L, first.publishedAt)
        assertEquals(1, first.episodeNumber)
        assertEquals(2, first.seasonNumber)
        assertTrue(first.explicit) // inherited from the channel
        assertEquals("https://example.com/ep1.chapters.json", first.chaptersUrl)

        // Transcripts: vtt kept, srt normalized to x-subrip, pdf dropped.
        assertEquals(2, first.transcripts.size)
        assertEquals("text/vtt", first.transcripts[0].type)
        assertEquals("en", first.transcripts[0].language)
        assertEquals("application/x-subrip", first.transcripts[1].type)
        assertEquals("https://example.com/ep1.srt", first.transcripts[1].url)

        val second = parsed.episodes[1]
        assertEquals("https://example.com/ep2.mp3", second.guid) // guid falls back to audio URL
        assertEquals(episodeIdFor(parsed.podcast.id, "https://example.com/ep2.mp3"), second.id)
        assertEquals(3600, second.durationSec)
        assertNull(second.audioLength) // length="0" is Number(x) || undefined
        assertNull(second.episodeNumber)
        assertEquals(0L, second.publishedAt) // no pubDate parses as 0, as Date.parse('') did
        assertNull(second.chaptersUrl)
        assertTrue(second.transcripts.isEmpty())
    }

    @Test
    fun rejectsAFeedWhoseChannelIsNotAnElement() {
        // Mirrors the TS guard: a bare-text or empty channel resolved to a string in
        // fast-xml-parser and threw "not a podcast feed".
        assertFailsWith<IllegalArgumentException> { parse("<rss><channel>oops</channel></rss>") }
        assertFailsWith<IllegalArgumentException> { parse("<rss></rss>") }
    }
}
