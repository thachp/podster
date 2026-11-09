import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedPage, clearPageCache, PAGE_CACHE_MS, viewKey } from "./page-cache";

beforeEach(() => clearPageCache());

describe("the rendered page cache", () => {
  it("renders a view once for 30 seconds, then again", () => {
    const render = vi.fn(() => "<html>");
    cachedPage("k", render, 1_000);
    cachedPage("k", render, 1_000 + PAGE_CACHE_MS - 1);
    expect(render).toHaveBeenCalledTimes(1);
    cachedPage("k", render, 1_000 + PAGE_CACHE_MS);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("keys on the handle and the exact view, so any change renders afresh", async () => {
    const view = { handle: "pub_1", content: { name: "Reef" } };
    expect(await viewKey("pub_1", view)).toBe(await viewKey("pub_1", { ...view }));
    expect(await viewKey("pub_1", view)).not.toBe(await viewKey("pub_1", { ...view, content: { name: "Reef 2" } }));
    expect(await viewKey("pub_1", view)).not.toBe(await viewKey("pub_2", view));
    expect(await viewKey("pub_1", view)).toMatch(/^pub_1:[0-9a-f]{64}$/);
  });

  it("keeps a bounded number of pages, dropping the oldest", () => {
    for (let i = 0; i < 70; i++) cachedPage(`k${i}`, () => `page ${i}`, 0);
    const render = vi.fn(() => "again");
    expect(cachedPage("k0", render, 1)).toBe("again");
    expect(cachedPage("k69", render, 1)).toBe("page 69");
  });
});
