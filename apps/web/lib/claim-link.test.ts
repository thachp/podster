import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { claimLinkMoved } from "./claim-link";

const LINK = "https://app.podster.dev/claim?agent_id=plugin_1&code=ABCD-EFGH";

describe("an approval link's code", () => {
  it("moves into a cookie only the claim page gets, and the browser goes to the bare page", () => {
    const moved = claimLinkMoved(new URL(LINK), "GET")!;
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/claim");
    expect(moved.headers.get("referrer-policy")).toBe("no-referrer");
    expect(moved.headers.get("cache-control")).toBe("no-store");
    const set = moved.headers.get("set-cookie") ?? "";
    // The gateway reads exactly this (apps/gateway/test/gateway.spec.ts, "reads the link from the cookie").
    expect(set.split("; ")[0]).toBe(`podster-claim=${encodeURIComponent("agent_id=plugin_1&code=ABCD-EFGH")}`);
    for (const attribute of ["Path=/claim", "Max-Age=600", "HttpOnly", "SameSite=Lax", "Secure"]) expect(set.split("; "), attribute).toContain(attribute);
  });

  it("leaves everything else alone, and sets no cookie for a link too long to be real", () => {
    expect(claimLinkMoved(new URL("https://app.podster.dev/claim"), "GET")).toBeNull();
    expect(claimLinkMoved(new URL("https://app.podster.dev/claim?agent_id=a"), "GET")).toBeNull();
    expect(claimLinkMoved(new URL(LINK), "POST")).toBeNull();
    expect(claimLinkMoved(new URL("https://app.podster.dev/claims?code=x"), "GET")).toBeNull();
    const huge = claimLinkMoved(new URL(`https://app.podster.dev/claim?agent_id=a&code=${"x".repeat(1000)}`), "GET")!;
    expect([huge.status, huge.headers.get("location"), huge.headers.get("set-cookie")]).toEqual([303, "/claim", null]);
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
