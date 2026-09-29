import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("fetch", () => {
  it("sends www to the apex, keeping path and query", async () => {
    const response = await worker.fetch(
      new Request("https://www.filterpod.app/e/abc/def?t=90") as any,
      {} as any,
      {} as any,
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://filterpod.app/e/abc/def?t=90");
  });
});

describe("a feed that is gone", () => {
  it("says so instead of asking the visitor to retry", async () => {
    const { encodeFeed } = await import("../src/links");
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
    vi.stubGlobal("fetch", async () => new Response("<hash><status>404</status></hash>", { status: 404 }));
    try {
      const response = await worker.fetch(
        new Request(`https://filterpod.app/e/${encodeFeed("https://feeds.example.com/moved")}/abc`) as any,
        { CF_VERSION_METADATA: { id: "test" } } as any,
        { waitUntil() {} } as any,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("feed has moved or been taken down");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
