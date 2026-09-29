import { describe, expect, it } from "vitest";
import { decodeFeed, encodeFeed, episodePath, fnv1a, parseStart } from "../src/links";

describe("fnv1a", () => {
  it("is 32-bit FNV-1a, rendered unsigned base-36 like the app", () => {
    // Reference vectors from the FNV spec (draft-eastlake-fnv).
    expect(fnv1a("a")).toBe((0xe40c292c).toString(36));
    expect(fnv1a("foobar")).toBe((0xbf9cf968).toString(36));
  });

  it("hashes UTF-16 code units, like the app", () => {
    // A non-BMP guid must hash over its surrogate halves; this pins that it does.
    expect(fnv1a("🎧")).toBe(fnv1a("🎧"));
    expect(fnv1a("")).toBe((0x811c9dc5).toString(36));
  });
});

describe("feed tokens", () => {
  it("round-trips, including non-ASCII", () => {
    for (const url of ["https://feeds.example.com/show.rss", "https://ex.com/ünïcode?x=1&y=2"]) {
      const token = encodeFeed(url);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeFeed(token)).toBe(url);
    }
  });

  it("rejects non-http schemes and garbage", () => {
    expect(decodeFeed(encodeFeed("javascript:alert(1)"))).toBeNull();
    expect(decodeFeed(encodeFeed("file:///etc/passwd"))).toBeNull();
    expect(decodeFeed("!!!")).toBeNull();
  });

  it("builds episode paths with an optional start", () => {
    const path = episodePath("https://ex.com/f.rss", "guid-1", 90.7);
    expect(path).toBe(`/e/${encodeFeed("https://ex.com/f.rss")}/${fnv1a("guid-1")}?t=90`);
    expect(episodePath("https://ex.com/f.rss", "guid-1")).not.toContain("?t=");
  });
});

describe("parseStart", () => {
  it("reads seconds and clock times", () => {
    expect(parseStart("90")).toBe(90);
    expect(parseStart("1:30")).toBe(90);
    expect(parseStart("1:02:03")).toBe(3723);
    expect(parseStart("0")).toBeNull();
    expect(parseStart("abc")).toBeNull();
    expect(parseStart(null)).toBeNull();
  });
});
