import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { claimLinkMoved } from "./claim-link";

const LINK = "https://app.podster.dev/claim?agent_id=plugin_1&code=ABCD-EFGH";
const CLEARED = "__Host-podster-claim=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure";

describe("an approval link's code", () => {
  it("moves into a __Host- cookie, and the browser goes to the bare page", () => {
    const moved = claimLinkMoved(new URL(LINK), "GET")!;
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/claim");
    expect(moved.headers.get("referrer-policy")).toBe("no-referrer");
    expect(moved.headers.get("cache-control")).toBe("no-store");
    const set = moved.headers.get("set-cookie") ?? "";
    // The gateway reads exactly this (apps/gateway/test/gateway.spec.ts, "reads the link from the cookie").
    expect(set.split("; ")[0]).toBe(`__Host-podster-claim=${encodeURIComponent("agent_id=plugin_1&code=ABCD-EFGH")}`);
    expect(set.split("; ").slice(1).sort()).toEqual(["HttpOnly", "Max-Age=600", "Path=/", "SameSite=Lax", "Secure"]);
  });

  it("uses a plain name only for a browser on http://localhost, and no cookie on other plain HTTP", () => {
    for (const origin of ["http://localhost:3000", "http://app.localhost:3000", "http://127.0.0.1:3000"]) {
      const set = claimLinkMoved(new URL(`${origin}/claim?agent_id=a&code=b`), "GET")!.headers.get("set-cookie");
      expect(set, origin).toBe(`podster-claim-local=${encodeURIComponent("agent_id=a&code=b")}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`);
    }
    const plain = claimLinkMoved(new URL("http://app.podster.dev/claim?agent_id=a&code=b"), "GET")!;
    expect([plain.status, plain.headers.get("location"), plain.headers.get("set-cookie")]).toEqual([303, "/claim", null]);
  });

  it("leaves everything else alone, and clears the cookie for a link too long to be real", () => {
    expect(claimLinkMoved(new URL("https://app.podster.dev/claim"), "GET")).toBeNull();
    expect(claimLinkMoved(new URL("https://app.podster.dev/claim?agent_id=a"), "GET")).toBeNull();
    expect(claimLinkMoved(new URL(LINK), "POST")).toBeNull();
    expect(claimLinkMoved(new URL("https://app.podster.dev/claims?code=x"), "GET")).toBeNull();
    const huge = claimLinkMoved(new URL(`https://app.podster.dev/claim?agent_id=a&code=${"x".repeat(1000)}`), "GET")!;
    expect([huge.status, huge.headers.get("location"), huge.headers.get("set-cookie")]).toEqual([303, "/claim", CLEARED]);
  });

  it("is moved by middleware before the path reaches the page or sign-in", async () => {
    const moved = await middleware(new NextRequest(LINK));
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/claim");
    const page = await middleware(new NextRequest("https://app.podster.dev/claim"));
    expect(page.status).toBe(200);
    expect(page.headers.get("location")).toBeNull();
  });
});
