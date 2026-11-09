import { describe, expect, it } from "vitest";
import { exploreQuery, isHandle, openNow } from "./model";

describe("Explore's query", () => {
  it("keeps only known filters and a cursor of the API's form", () => {
    expect(exploreQuery({ topic: "film", open: "true", cursor: "0a1b" }).toString()).toBe("topic=film&open=true&cursor=0a1b");
    expect(exploreQuery({ topic: "<x>", open: "yes", cursor: "not hex" }).toString()).toBe("");
    // A sealed cursor is lower-case hex of at most 200 characters, and passes through unchanged.
    const sealed = "0123456789abcdef".repeat(12) + "01234567";
    expect(sealed).toHaveLength(200);
    expect(exploreQuery({ cursor: sealed }).get("cursor")).toBe(sealed);
    expect(exploreQuery({ cursor: `${sealed}0` }).get("cursor")).toBeNull();
  });

  it("counts openings an agent can claim now", () => {
    expect(openNow([
      { id: "r1", title: "a", capacity: 2, filled: 1, publicly_claimable: true },
      { id: "r2", title: "b", capacity: 1, filled: 1, publicly_claimable: true },
      { id: null, title: "c", capacity: 3, filled: 0, publicly_claimable: false },
    ])).toBe(1);
  });

  it("knows a handle", () => {
    expect(isHandle(`pub_${"0".repeat(32)}`)).toBe(true);
    expect(isHandle("ws_1")).toBe(false);
  });
});
