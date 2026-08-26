package app.filterpod.shared.feeds

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Show notes are written as HTML, and the structure in them is the difference
 * between readable notes and a wall of text. These cases are taken from the shape
 * real feeds use (Buzzsprout's paragraph-and-link-list being the reference).
 */
class DescriptionFormattingTest {

    private fun describe(body: String): String {
        val feed = """<rss xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel><title>Show</title>
            <item><guid>g1</guid><title>One</title>
            <enclosure url="https://x/1.mp3"/>
            <description><![CDATA[$body]]></description>
            </item></channel></rss>"""
        return parseFeed(feed, "https://example.com/feed.xml", XmlFeedReader(), 0)
            .episodes.first().description
    }

    @Test
    fun paragraphsBecomeParagraphs() {
        val text = describe("<p>First para.</p><p>Second para.</p>")
        assertEquals("First para.\n\nSecond para.", text)
    }

    @Test
    fun lineBreaksSurvive() {
        val text = describe("Website | site.com<br/>Facebook | fb.com<br />X | x.com")
        assertEquals("Website | site.com\nFacebook | fb.com\nX | x.com", text)
    }

    @Test
    fun listsBecomeBullets() {
        val text = describe("<ul><li>One</li><li>Two</li></ul>")
        assertTrue(text.contains("• One"), text)
        assertTrue(text.contains("• Two"), text)
    }

    @Test
    fun descriptiveLinksKeepTheirTarget() {
        // The "Further reading:" pattern: link text describes the article, so
        // dropping the href would leave a dead sentence.
        val text = describe("""<p>Further reading:</p><ul><li><a href="https://www.theverge.com/m6">Apple's new M6 chip</a></li></ul>""")
        assertTrue(text.contains("[Apple's new M6 chip](https://www.theverge.com/m6)"), text)
    }

    @Test
    fun selfNamingLinksStayBare() {
        // Anchor text that is already the address needs no markdown around it.
        assertEquals(
            "Website | thekingschapel.com",
            describe("""Website | <a href="https://thekingschapel.com">thekingschapel.com</a>"""),
        )
    }

    @Test
    fun nonHttpLinksDegradeToTheirText() {
        assertEquals("email us", describe("""<a href="mailto:a@b.com">email us</a>"""))
    }

    @Test
    fun inlineTagsDoNotSplitWords() {
        // Anchor text is kept; the tags around it must not leave stray spaces.
        assertEquals("Visit thekingschapel.com today", describe("Visit <a href='#'>thekingschapel.com</a> today"))
        assertEquals("bold text", describe("<b>bold</b> text"))
    }

    @Test
    fun runsOfBlankLinesAndSpacesCollapse() {
        val text = describe("<p>A</p><p></p><p></p><p>B</p>")
        assertEquals("A\n\nB", text)
        assertFalse(text.contains("\n\n\n"))
    }

    @Test
    fun entitiesStillDecodeAndMarkupNeverSurvives() {
        val text = describe("<p>Dr. Grant preaches &quot;Salt &amp; Light&quot;</p>")
        assertEquals("Dr. Grant preaches \"Salt & Light\"", text)
        assertFalse(text.contains("<"), text)
    }
}
