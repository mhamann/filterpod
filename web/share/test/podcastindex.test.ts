import { afterEach, describe, expect, it, vi } from "vitest";
import { findAppleShow } from "../src/apple";
import { authHeaders, itunesIdForShow } from "../src/podcastindex";

const creds = { PODCASTINDEX_API_KEY: "KEY", PODCASTINDEX_API_SECRET: "secret|x" };
const show = { feedUrl: "https://feeds.megaphone.fm/recodedecode", title: "Decoder with Nilay Patel", author: "The Verge", description: "", artworkUrl: "", link: null };

function answer(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("authHeaders", () => {
  it("signs key + secret + whole-second date with lowercase hex SHA-1", async () => {
    const h = await authHeaders("KEY", "secret|x", 1613713388.9);
    expect(h["X-Auth-Date"]).toBe("1613713388");
    expect(h["X-Auth-Key"]).toBe("KEY");
    // python3: hashlib.sha1(b"KEYsecret|x1613713388").hexdigest()
    expect(h.Authorization).toBe("72f4fa55d5fccacb6a62862294dc87c2aa98dced");
    expect(h["User-Agent"]).toMatch(/^FilterPodShare/);
  });
});

describe("itunesIdForShow", () => {
  it("asks by exact feed URL and returns the iTunes id", async () => {
    const calls = answer({ status: "true", feed: { id: 1, url: show.feedUrl, itunesId: 1011668648 } });
    expect(await itunesIdForShow(show, creds)).toBe(1011668648);
    expect(new URL(calls[0].url).searchParams.get("url")).toBe(show.feedUrl);
    expect(calls[0].headers.Authorization).toMatch(/^[0-9a-f]{40}$/);
  });

  it("finds the feed by title when Podcast Index knows it under another URL spelling", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new URL(url).pathname.endsWith("/podcasts/byfeedurl")
        ? new Response(JSON.stringify({ status: "false", description: "Feed url not found." }), { status: 400 })
        : new Response(JSON.stringify({ status: "true", feeds: [
            { url: "https://elsewhere.example/decoder", title: "Decoder with Nilay Patel", author: "Someone Else", itunesId: 1 },
            { url: "http://feeds.megaphone.fm/recodedecode/", title: "Decoder with Nilay Patel", author: "The Verge", itunesId: 1011668648 },
          ] })),
    );
    expect(await itunesIdForShow(show, creds)).toBe(1011668648);
  });

  it("falls back to the one feed with this exact title and author", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new URL(url).pathname.endsWith("/podcasts/byfeedurl")
        ? new Response(JSON.stringify({ status: "false" }), { status: 400 })
        : new Response(JSON.stringify({ status: "true", feeds: [
            { url: "https://moved.example/decoder", title: "Decoder with Nilay Patel", author: "The Verge", itunesId: 1011668648 },
            { url: "https://elsewhere.example/decoder", title: "Decoder with Nilay Patel", author: "Someone Else", itunesId: 1 },
          ] })),
    );
    expect(await itunesIdForShow(show, creds)).toBe(1011668648);
  });

  it("gives up on a tie between different shows", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new URL(url).pathname.endsWith("/podcasts/byfeedurl")
        ? new Response(JSON.stringify({ status: "false" }), { status: 400 })
        : new Response(JSON.stringify({ status: "true", feeds: [
            { url: "https://a.example/d", title: "Decoder with Nilay Patel", author: "The Verge", itunesId: 1 },
            { url: "https://b.example/d", title: "Decoder with Nilay Patel", author: "The Verge", itunesId: 2 },
          ] })),
    );
    expect(await itunesIdForShow(show, creds)).toBeNull();
  });

  it("returns null for unknown feeds, missing ids and errors", async () => {
    answer({ status: "false", feed: [] });
    expect(await itunesIdForShow(show, creds)).toBeNull();
    answer({ status: "true", feed: { itunesId: null } });
    expect(await itunesIdForShow(show, creds)).toBeNull();
    answer({}, 401);
    expect(await itunesIdForShow(show, creds)).toBeNull();
  });

  it("doesn't call out at all without credentials", async () => {
    const calls = answer({ status: "true", feed: { itunesId: 1 } });
    expect(await itunesIdForShow(show, {})).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("findAppleShow", () => {
  it("takes Podcast Index's answer without searching Apple", async () => {
    const calls = answer({ status: "true", feed: { itunesId: 1011668648 } });
    expect(await findAppleShow(show, creds)).toEqual({
      collectionId: 1011668648,
      url: "https://podcasts.apple.com/podcast/id1011668648",
    });
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["api.podcastindex.org"]);
  });

  it("falls back to Apple's title search, keeping only an exact feed match", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new URL(url).hostname === "api.podcastindex.org"
        ? new Response(JSON.stringify({ status: "false", feed: [] }))
        : new Response(JSON.stringify({ results: [
            { collectionId: 9, feedUrl: "https://elsewhere.example/feed", collectionName: "Decoder with Nilay Patel", artistName: "Someone" },
            { collectionId: 1011668648, feedUrl: "https://feeds.megaphone.fm/recodedecode/", collectionViewUrl: "https://podcasts.apple.com/us/podcast/decoder/id1011668648?uo=4" },
          ] })),
    );
    expect(await findAppleShow(show, creds)).toEqual({
      collectionId: 1011668648,
      url: "https://podcasts.apple.com/us/podcast/decoder/id1011668648",
    });
  });
});
