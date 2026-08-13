package app.filterpod.shared.feeds

import java.io.StringReader
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory

/**
 * XmlPullParser-backed tokenizer for feed XML.
 *
 * Produces the raw element tree; every interpretation rule (trimming, entity cleanup,
 * fast-xml-parser shape mirroring) lives in commonMain's ParseFeed.kt. Two settings
 * matter for fidelity with the TS parser:
 *
 * - Namespace processing stays OFF, so element and attribute names keep their literal
 *   prefixes ("itunes:duration", "podcast:transcript") — the common code matches on
 *   prefixed names exactly as the TS parser did with `removeNSPrefix: false`.
 * - HTML-style named entities (`&nbsp;` outside CDATA) must not abort the parse the way
 *   strict XML says they should: fast-xml-parser passed them through verbatim and left
 *   `decodeEntities` to clean up. Relaxed mode gets the same tolerance here, with
 *   literal replacement text for the known names as a fallback when the parser
 *   implementation doesn't support the relaxed feature.
 */
class XmlFeedReader : FeedXmlReader {

    override fun parse(xml: String): XmlElement {
        val parser = newPullParser()
        val relaxed = try {
            parser.setFeature("http://xmlpull.org/v1/doc/features.html#relaxed", true)
            true
        } catch (_: Exception) {
            false
        }
        parser.setInput(StringReader(xml.removePrefix("\uFEFF")))
        if (!relaxed) {
            for (name in listOf("nbsp", "ndash", "mdash", "hellip", "lsquo", "rsquo", "ldquo", "rdquo")) {
                parser.defineEntityReplacementText(name, "&$name;")
            }
        }

        var event = parser.eventType
        while (event != XmlPullParser.START_TAG) {
            if (event == XmlPullParser.END_DOCUMENT) {
                throw IllegalArgumentException("not a podcast feed: empty document")
            }
            event = parser.next()
        }
        return readElement(parser)
    }

    private fun newPullParser(): XmlPullParser = try {
        // Android's factory resolves its platform parser; kxml2's resolves KXmlParser.
        XmlPullParserFactory.newInstance().newPullParser()
    } catch (factoryFailure: Exception) {
        // Some xmlpull API jars ship a factory that can't locate an implementation via
        // resources. kxml2 is on the host-test classpath, so reach for it directly.
        try {
            Class.forName("org.kxml2.io.KXmlParser").getDeclaredConstructor().newInstance() as XmlPullParser
        } catch (_: Exception) {
            throw factoryFailure
        }
    }

    /** Parser is positioned on START_TAG; returns with the matching END_TAG consumed. */
    private fun readElement(parser: XmlPullParser): XmlElement {
        val name = parser.name
        val attributes = LinkedHashMap<String, String>()
        for (i in 0 until parser.attributeCount) {
            attributes[parser.getAttributeName(i)] = parser.getAttributeValue(i)
        }
        val children = mutableListOf<XmlElement>()
        val text = StringBuilder()
        while (true) {
            when (parser.next()) {
                XmlPullParser.START_TAG -> children.add(readElement(parser))
                // next() folds CDATA and resolved entities into TEXT events.
                XmlPullParser.TEXT, XmlPullParser.CDSECT -> text.append(parser.text)
                XmlPullParser.END_TAG, XmlPullParser.END_DOCUMENT ->
                    return XmlElement(name, attributes, children, text.toString())
            }
        }
    }
}
