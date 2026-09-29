import { describe, expect, it } from "vitest";
import { appLinks } from "../src/apps";
import type { Item, Show } from "../src/feed";
import { episodePage, podcastPage, privacyPage, timecode } from "../src/page";

const show: Show = {
  feedUrl: "https://example.com/feed.rss?a=1&b=2",
  title: `Show "<script>alert(1)</script>"`,
  author: "Author",
  description: "About the show.",
  artworkUrl: "http://example.com/art.jpg",
  link: null,
};

const item: Item = {
  guid: "g1",
  hash: "abc",
  title: "<img src=x onerror=alert(1)>",
  description: "Notes https://example.com/x?y=1&z=2 and <b>tags</b> javascript:alert(1)",
  link: null,
  audioUrl: "https://cdn.example.com/a.mp3",
  publishedAt: Date.UTC(2026, 8, 1),
  durationSec: 3600,
  artworkUrl: null,
  season: null,
  episode: 7,
};

const release = { version: "v1.0.1", downloadUrl: "https://github.com/x/y.apk", sizeBytes: 1 };

describe("episodePage", () => {
  const out = episodePage({
    show,
    item,
    startSec: 754,
    apps: appLinks({ show, item, apple: null }),
    release,
    url: "https://share.example/e/x/abc?t=754",
  });

  it("escapes everything that came from the feed", () => {
    expect(out).not.toContain("<script>alert");
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>tags</b>");
    expect(out).not.toMatch(/href="javascript:/);
  });

  it("links bare URLs in show notes, and only http(s) ones", () => {
    expect(out).toContain('<a href="https://example.com/x?y=1&amp;z=2" rel="nofollow noopener ugc"');
  });

  it("draws the shared position", () => {
    expect(out).toContain("Starts at 12:34");
    expect(out).toContain("−47:26");
  });

  it("upgrades show artwork to https for the page and the preview card", () => {
    expect(out).toContain('<meta property="og:image" content="https://example.com/art.jpg"');
  });

  it("points Get at the release", () => {
    expect(out).toContain('href="https://github.com/x/y.apk"');
  });
});

describe("podcastPage", () => {
  it("links recent episodes to their own share pages", () => {
    const out = podcastPage({ show, items: [item], apps: [], release, url: "https://share.example/p/x" });
    expect(out).toMatch(/href="\/e\/[A-Za-z0-9_-]+\/[a-z0-9]+"/);
  });
});

describe("appLinks", () => {
  it("offers feed-based apps even when Apple doesn't list the show", () => {
    const names = appLinks({ show, item, apple: null }).map((a) => a.name);
    expect(names).toEqual(["Spotify", "Pocket Casts", "Overcast", "AntennaPod", "Podcast Addict"]);
  });

  it("uses Apple's ids when there are some", () => {
    const links = appLinks({
      show,
      item,
      apple: { collectionId: 42, url: "https://podcasts.apple.com/podcast/id42" },
      appleEpisode: { trackId: 7, url: "https://podcasts.apple.com/podcast/id42?i=7" },
      castroUrl: "https://castro.fm/podcast/u",
    });
    const byName = Object.fromEntries(links.map((l) => [l.name, l.url]));
    expect(byName["Apple Podcasts"]).toBe("https://podcasts.apple.com/podcast/id42?i=7");
    expect(byName["Pocket Casts"]).toBe("https://pca.st/itunes/42");
    expect(byName["Castro"]).toBe("https://castro.fm/podcast/u");
  });
});

describe("timecode", () => {
  it("formats like the app", () => {
    expect(timecode(5)).toBe("0:05");
    expect(timecode(754)).toBe("12:34");
    expect(timecode(3723)).toBe("1:02:03");
  });
});

describe("privacyPage", () => {
  it("renders the repo's PRIVACY.md", async () => {
    const { PRIVACY_HTML } = await import("../src/privacy");
    const out = privacyPage(PRIVACY_HTML, "https://filterpod.app/privacy");
    expect(out).toContain("<h1>FilterPod Privacy Policy</h1>");
    expect(out).toContain("<h2>Share pages</h2>");
    expect(out).toContain('<a href="https://github.com/mhamann/filterpod/issues">');
  });
});
