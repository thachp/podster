import { beforeEach, describe, expect, it, vi } from "vitest";

const fetch = vi.fn<(url: string, init: { headers: Headers }) => Promise<Response>>();
vi.mock("./env", () => ({ webEnv: () => ({ GATEWAY: { fetch }, APP_URL: "https://app.test" }) }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
// The path middleware sets, which is the only way back the rate-limit page is given.
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current, cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));

const { RedirectSignal } = await import("@/test/next-navigation");
const { gatewayQuery, getSession, rateLimited, secondsToWait } = await import("./server");

const limited = (retryAfter: string | null) => new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
const redirectOf = async (pending: Promise<unknown>) => {
  const error = await pending.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RedirectSignal);
  return (error as Error).message;
};

describe("server reads", () => {
  beforeEach(() => fetch.mockReset());

  it("calls the gateway as the application host, with no origin", async () => {
    fetch.mockResolvedValue(Response.json({ id: "per_1" }));
    await expect(gatewayQuery("/api/v1/me")).resolves.toEqual({ ok: true, data: { id: "per_1" } });
    expect(fetch.mock.calls[0][0]).toBe("https://app.test/api/v1/me");
    expect(fetch.mock.calls[0][1].headers.get("origin")).toBeNull();
  });

  it("keeps a refusal's stable code", async () => {
    fetch.mockResolvedValue(Response.json({ error: { code: "not_allowed" } }, { status: 403 }));
    await expect(gatewayQuery("/api/v1/me")).resolves.toEqual({ ok: false, status: 403, code: "not_allowed" });
  });

  it("no session is null, and reading one doesn't slide it", async () => {
    fetch.mockResolvedValue(Response.json(null));
    await expect(getSession()).resolves.toBeNull();
    expect(fetch.mock.calls[0][0]).toBe("https://app.test/api/auth/get-session?disableRefresh=true");
  });

  it("an outage isn't a signed-out person", async () => {
    fetch.mockResolvedValue(new Response("down", { status: 503 }));
    await expect(getSession()).rejects.toThrow("gateway_unavailable");
  });
});

describe("the rate limit", () => {
  beforeEach(() => {
    fetch.mockReset();
    requestHeaders.current = new Headers({ "x-podster-path": "/w/ws_1/tasks?view=board" });
  });

  it("caps a long wait the gateway asked for", async () => {
    fetch.mockResolvedValue(limited("99999"));
    expect(new URL(await redirectOf(getSession()), "https://app.test").searchParams.get("after")).toBe("300");
  });

  it.each([
    ["30", 30],
    ["0", 0],
    ["99999", 300],
    ["1.5", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    ["-1", undefined],
    [null, undefined],
  ])("reads a retry-after of %s as %s seconds", (header, seconds) => {
    expect(secondsToWait(header)).toBe(seconds);
  });

  it("sends a refused session read to the rate-limit page, with the wait and the way back, not to sign-in or the error page", async () => {
    fetch.mockResolvedValue(limited("45"));
    const to = await redirectOf(getSession());
    const url = new URL(to, "https://app.test");
    expect(url.pathname).toBe("/too-many-requests");
    expect(url.searchParams.get("after")).toBe("45");
    expect(url.searchParams.get("next")).toBe("/w/ws_1/tasks?view=board");
  });

  it("leaves the wait out when the gateway didn't give one", async () => {
    fetch.mockResolvedValue(limited(null));
    expect(new URL(await redirectOf(getSession()), "https://app.test").searchParams.has("after")).toBe(false);
  });

  it.each([
    ["another host", "https://evil.example/x", "/attention"],
    ["the session routes", "/sign-in?next=/x", "/attention"],
    ["no path at all", null, "/attention"],
  ])("never sends the way back to %s", async (_name, path, expected) => {
    requestHeaders.current = new Headers(path === null ? {} : { "x-podster-path": path });
    expect(new URL(await redirectOf(rateLimited(10)), "https://app.test").searchParams.get("next")).toBe(expected);
  });

  it("never sends the way back to the rate-limit page itself", async () => {
    requestHeaders.current = new Headers({ "x-podster-path": "/too-many-requests?after=5" });
    expect(new URL(await redirectOf(rateLimited(10)), "https://app.test").searchParams.has("next")).toBe(false);
  });
});
