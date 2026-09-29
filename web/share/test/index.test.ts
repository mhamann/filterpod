import { describe, expect, it } from "vitest";
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
