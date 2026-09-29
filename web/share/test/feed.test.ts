import { describe, expect, it } from "vitest";
import { FeedScanner, guidOf, parseDuration } from "../src/feed";
import { fnv1a } from "../src/links";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Tom &amp; Jerry&#8217;s Show</title>
  <link>https://example.com/show</link>
  <atom:link href="https://example.com/feed.rss" rel="self" />
  <itunes:author>Tom Author</itunes:author>
  <description><![CDATA[<p>First para.</p><p>Second <b>para</b>.</p>]]></description>
  <image><url>https://example.com/small.png</url><title>Image title, not the show</title></image>
  <itunes:image href="https://example.com/art.jpg"/>
  <item>
    <title><![CDATA[Episode 2: <Angles> & things]]></title>
    <itunes:title>Short title</itunes:title>
    <guid isPermaLink="false">ep-2</guid>
    <link>https://example.com/ep2</link>
    <pubDate>Tue, 15 Sep 2026 10:00:00 +0000</pubDate>
    <itunes:duration>1:02:03</itunes:duration>
    <itunes:season>3</itunes:season>
    <itunes:episode>2</itunes:episode>
    <itunes:image href="https://example.com/ep2.jpg"/>
    <content:encoded><![CDATA[<p>Notes with <a href="https://x.com">a link</a></p><ul><li>One</li><li>Two</li></ul>]]></content:encoded>
    <description>Shorter description</description>
    <enclosure url="https://cdn.example.com/ep2.mp3" length="123" type="audio/mpeg"/>
  </item>
  <item>
    <title>Trailer with no audio</title>
    <guid>trailer</guid>
  </item>
  <item>
    <title>Episode 1</title>
    <enclosure type="audio/mpeg" url='https://cdn.example.com/ep1.mp3?a=1&amp;b=2' />
    <itunes:duration>754</itunes:duration>
  </item>
</channel>
</rss>`;

function scan(xml: string, chunk: number, opts = { maxItems: 100 }) {
  const scanner = new FeedScanner("https://example.com/feed.rss");
  let stopped = false;
  for (let i = 0; i < xml.length && !stopped; i += chunk) stopped = scanner.push(xml.slice(i, i + chunk), opts);
  return { feed: scanner.finish(), stopped };
}

describe("FeedScanner", () => {
  it("reads the show header", () => {
    const { show } = scan(FEED, FEED.length).feed;
    expect(show.title).toBe("Tom & Jerry’s Show");
    expect(show.author).toBe("Tom Author");
    expect(show.link).toBe("https://example.com/show");
    expect(show.artworkUrl).toBe("https://example.com/art.jpg");
    expect(show.description).toBe("First para.\n\nSecond para.");
  });

  it("reads items and skips ones without audio, like the app", () => {
    const { items } = scan(FEED, FEED.length).feed;
    expect(items.map((i) => i.guid)).toEqual(["ep-2", "https://cdn.example.com/ep1.mp3?a=1&b=2"]);
    const [ep2, ep1] = items;
    expect(ep2.title).toBe("Episode 2: <Angles> & things");
    expect(ep2.hash).toBe(fnv1a("ep-2"));
    expect(ep2.durationSec).toBe(3723);
    expect(ep2.season).toBe(3);
    expect(ep2.episode).toBe(2);
    expect(ep2.artworkUrl).toBe("https://example.com/ep2.jpg");
    expect(ep2.link).toBe("https://example.com/ep2");
    expect(ep2.publishedAt).toBe(Date.UTC(2026, 8, 15, 10));
    // content:encoded wins over description, as in ParseFeed.kt.
    expect(ep2.description).toContain("Notes with a link (https://x.com)");
    expect(ep2.description).toContain("• One");
    // The guid falls back to the enclosure URL, as in ParseFeed.kt.
    expect(ep1.hash).toBe(fnv1a("https://cdn.example.com/ep1.mp3?a=1&b=2"));
    expect(ep1.durationSec).toBe(754);
  });

  it("gives the same answer however the bytes arrive", () => {
    const whole = scan(FEED, FEED.length).feed;
    for (const chunk of [1, 7, 64]) expect(scan(FEED, chunk).feed).toEqual(whole);
  });

  it("stops reading once it has what it needs", () => {
    const scanner = new FeedScanner("https://example.com/feed.rss");
    const target = fnv1a("ep-2");
    const stopped = scanner.push(FEED + "<item>never parsed", {
      maxItems: 100,
      done: (i) => i.hash === target,
    });
    expect(stopped).toBe(true);
    expect(scanner.finish().items).toHaveLength(1);
  });

  it("refuses things that are not feeds", () => {
    const scanner = new FeedScanner("https://example.com/");
    scanner.push("<!doctype html><html><body>hi</body></html>", { maxItems: 5 });
    expect(() => scanner.finish()).toThrow();
  });
});

describe("guidOf", () => {
  it("reproduces the app's guid strings, quirks included", () => {
    expect(guidOf("<guid>  abc  </guid>")).toBe("abc");
    expect(guidOf("<guid><![CDATA[a &amp; b]]></guid>")).toBe("a &amp; b");
    expect(guidOf("<guid>a &amp;amp; b</guid>")).toBe("a &amp; b");
    expect(guidOf("<guid>keep &nbsp; literal</guid>")).toBe("keep &nbsp; literal");
    expect(guidOf("<guid>a  b</guid>")).toBe("a  b");
    expect(guidOf('<guid isPermaLink="false">x</guid>')).toBe("x");
    expect(guidOf('<guid isPermaLink="false"></guid>')).toBe("[object Object]");
    expect(guidOf('<guid isPermaLink="false"/>')).toBe("[object Object]");
    expect(guidOf("<guid></guid>")).toBe("");
    expect(guidOf("<guid/>")).toBe("");
    expect(guidOf('<guid>a</guid><guid isPermaLink="true">b</guid>')).toBe("a,[object Object]");
    expect(guidOf("<title>no guid</title>")).toBe("");
  });
});

describe("parseDuration", () => {
  it("handles the shapes feeds use", () => {
    expect(parseDuration("3600")).toBe(3600);
    expect(parseDuration("60:00")).toBe(3600);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
  });
});
