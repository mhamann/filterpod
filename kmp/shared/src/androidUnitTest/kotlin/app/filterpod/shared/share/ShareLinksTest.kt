package app.filterpod.shared.share

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Every expected value here was produced by web/share/src/links.ts. If one of these
 * fails, links from the app open a page that cannot find what was shared.
 */
class ShareLinksTest {

    @Test
    fun matchesTheSharePagesForAPlainFeed() {
        val feed = "https://feeds.simplecast.com/6HKOhNgS"
        assertEquals("https://filterpod.app/p/aHR0cHM6Ly9mZWVkcy5zaW1wbGVjYXN0LmNvbS82SEtPaE5nUw", ShareLinks.podcastUrl(feed))
        assertEquals(
            "https://filterpod.app/e/aHR0cHM6Ly9mZWVkcy5zaW1wbGVjYXN0LmNvbS82SEtPaE5nUw/xjv0so?t=2050",
            ShareLinks.episodeUrl(feed, "0270f621-aa0b-4262-90d5-b9cdc4604dee", 2050.0),
        )
    }

    @Test
    fun trimsTheFeedAndEncodesItAsUtf8() {
        val feed = "  https://ex.com/ünïcode?x=1&y=2 "
        assertEquals("https://filterpod.app/p/aHR0cHM6Ly9leC5jb20vw7xuw69jb2RlP3g9MSZ5PTI", ShareLinks.podcastUrl(feed))
        assertEquals(
            "https://filterpod.app/e/aHR0cHM6Ly9leC5jb20vw7xuw69jb2RlP3g9MSZ5PTI/73wl0m",
            ShareLinks.episodeUrl(feed, "guid-1"),
        )
    }

    @Test
    fun hashesNonBmpGuidsOverUtf16AndDropsFractionalSeconds() {
        assertEquals(
            "https://filterpod.app/e/aHR0cHM6Ly9leC5jb20vZi5yc3M/klqbi5?t=90",
            ShareLinks.episodeUrl("https://ex.com/f.rss", "🎧 episode", 90.7),
        )
    }

    @Test
    fun leavesOutPositionsThatAreNotOne() {
        val base = "https://filterpod.app/e/aHR0cHM6Ly9leC5jb20vZi5yc3M/klqbi5"
        assertEquals(base, ShareLinks.episodeUrl("https://ex.com/f.rss", "🎧 episode", 0.4))
        assertEquals(base, ShareLinks.episodeUrl("https://ex.com/f.rss", "🎧 episode", Double.NaN))
        assertEquals(base, ShareLinks.episodeUrl("https://ex.com/f.rss", "🎧 episode", null))
    }

    @Test
    fun recognizesPersonalFeeds() {
        val private = listOf(
            // Supporting Cast: the path is a base64 JSON token naming the subscriber.
            "https://verge.supportingcast.fm/content/eyJ0IjoicCIsImMiOiIyMDc1MCIsInUiOiIxMjM0NTY3In0.rss",
            "https://feeds.supercast.com/episodes/abc.rss",
            "https://www.patreon.com/rss/someshow?auth=AbCdEf123",
            "https://api.substack.com/feed/podcast/123456/private/0c6e5b2a-1d3f-4e8a-9b7c-2f1e0d9c8b7a.rss",
            "https://example.memberful.com/rss/feed",
            "https://user:hunter2@feeds.example.com/show.rss",
            "https://feeds.example.com/show.rss?token=abc",
            "https://feeds.example.com/show.rss?access_key=abc",
            "https://feeds.example.com/9f8e7d6c5b4a39281706f5e4d3c2b1a0ffee1234/feed.xml",
            "not a url",
        )
        for (url in private) assertEquals(true, ShareLinks.isPrivateFeed(url), url)
    }

    @Test
    fun leavesPublicFeedsShareable() {
        val public = listOf(
            "https://feeds.simplecast.com/6HKOhNgS",
            "https://feeds.megaphone.fm/HSW9029785234",
            "https://anchor.fm/s/b8d68e0/podcast/rss",
            "https://feeds.npr.org/510289/podcast.xml",
            "https://feeds.acast.com/public/shows/5e7b777ba085cbe7192b0607",
            "https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/8a94442e-5a74-4fa2-8b8d-ae27003a8d6b/982f5071-765c-403d-969d-ae27003a8d83/podcast.rss",
            "https://feeds.transistor.fm/the-show?utm_source=x",
            "http://feeds.feedburner.com/SomeShow",
        )
        for (url in public) assertEquals(false, ShareLinks.isPrivateFeed(url), url)
    }
}
