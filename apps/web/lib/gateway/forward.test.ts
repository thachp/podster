import { describe, expect, it, vi } from "vitest";
import { forwardedHeaders, forwardToGateway, isForwardable } from "./forward";

const APP = "https://app.test";

function gateway(response = new Response("{}")) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response);
  return { fetch: fetch as unknown as Fetcher["fetch"], calls: fetch };
}

describe("isForwardable", () => {
  it.each(["/api/auth/sign-in/magic-link", "/api/auth/magic-link/verify", "/api/v1/me", "/api/v1/workspaces/ws_1/tasks", "/api/v1/agents/agt_1/inbox", "/api/orgs", "/api/orgs/org_1/members", "/api/orgs/org_1/members/per_1", "/api/orgs/org_1/invitations", "/api/orgs/org_1/invitations/oin_1", "/api/org-invitations/preview", "/api/org-invitations/accept", "/api/agents", "/api/agents/agt_1/disconnect", "/api/auth/get-session", "/api/auth/sign-out", "/api/auth/sign-in/social", "/api/auth/callback/github", "/api/consent", "/api/claim"])("forwards %s", (path) => expect(isForwardable(path)).toBe(true));

  it.each([
    "/api/auth/agent/register",
    "/api/auth/agent-configuration",
    "/api/auth/capability/execute",
    "/api/auth/agent/status",
    "/api/auth/host/create",
    "/api/internal",
    "/mcp",
    "/authorize",
    "/oauth/token",
    "/api/v1//inbox",
    "/api/v1/../../mcp",
    "/api/v1/%2e%2e/mcp",
    "/api/v1%2fme",
    "/api/agentsx",
    "/api/consent/x",
    "/api/claimx",
    "/api/orgsx",
    "/api/orgs/nope/members",
    "/api/orgs/org_1/other",
    "/api/orgs/org_1/members/per_1/x",
    "/api/org-invitations",
    "/api/org-invitations/other",
    "/api/v1/uploads",
    "/api/v1/uploads/ws_1",
    "/api/v1/uploads/ws_1/obj_1",
    "/api/v1/uploads/ws_1/obj_1/more",
  ])("refuses %s", (path) => expect(isForwardable(path)).toBe(false));
});

describe("forwardedHeaders", () => {
  it("passes on where a request came from, which using a sign-in link depends on", () => {
    expect(forwardedHeaders(new Headers({ "sec-fetch-site": "cross-site" })).get("sec-fetch-site")).toBe("cross-site");
  });

  const incoming = new Headers({ cookie: "better-auth.session_token=s; podster-org=org_1", origin: APP, "content-type": "application/json", "idempotency-key": "k", "cf-connecting-ip": "203.0.113.9", "x-podster-org": "org_chosen_by_client", "x-podster-assertion": "forged", "x-podster-caller": "{}", authorization: "Bearer x", "x-forwarded-for": "1.1.1.1" });
  const headers = forwardedHeaders(incoming);

  it("passes the browser's own origin, session and address on", () => {
    expect(headers.get("origin")).toBe(APP);
    expect(headers.get("cookie")).toContain("better-auth.session_token=s");
    expect(headers.get("idempotency-key")).toBe("k");
    expect(headers.get("cf-connecting-ip")).toBe("203.0.113.9");
  });

  it("takes the organization from the cookie, not a header the page could set", () => {
    expect(headers.get("x-podster-org")).toBe("org_1");
    expect(forwardedHeaders(new Headers({ "x-podster-org": "org_x" })).get("x-podster-org")).toBeNull();
  });

  it("drops anything that could pass for identity", () => {
    for (const name of ["x-podster-assertion", "x-podster-caller", "authorization", "x-forwarded-for"]) expect(headers.get(name), name).toBeNull();
  });
});

describe("forwardToGateway", () => {
  it("passes the referrer to the route that uses a sign-in link, and no other", async () => {
    const { fetch, calls } = gateway();
    const sent = (path: string) => forwardToGateway(new Request(`${APP}${path}`, { headers: { referer: `${APP}/sign-in/email?token=t` } }), { fetch }, APP);
    await sent("/api/auth/magic-link/verify?token=t&callbackURL=%2F");
    await sent("/api/v1/me");
    const headers = calls.mock.calls.map((call: unknown[]) => new Headers((call[1] as RequestInit).headers).get("referer"));
    expect(headers).toEqual([`${APP}/sign-in/email?token=t`, null]);
  });

  it("answers a refused path without calling the gateway", async () => {
    const { fetch, calls } = gateway();
    const response = await forwardToGateway(new Request(`${APP}/api/auth/agent/register`, { method: "POST" }), { fetch }, APP);
    expect(response.status).toBe(404);
    expect(calls).not.toHaveBeenCalled();
  });

  it("addresses the gateway as the application host, keeping the query", async () => {
    const { fetch, calls } = gateway();
    await forwardToGateway(new Request("https://elsewhere.test/api/v1/inbox?after=3"), { fetch }, APP);
    expect(calls.mock.calls[0][0]).toBe(`${APP}/api/v1/inbox?after=3`);
  });

  it("passes the body and method on", async () => {
    const { fetch, calls } = gateway();
    await forwardToGateway(new Request(`${APP}/api/v1/workspaces`, { method: "POST", body: '{"name":"x"}' }), { fetch }, APP);
    const init = calls.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"name":"x"}');
  });

  it("keeps every cookie and a redirect's location, and stops caching", async () => {
    const headers = new Headers({ location: "https://github.test/authorize" });
    headers.append("set-cookie", "a=1; HttpOnly");
    headers.append("set-cookie", "b=2; HttpOnly");
    const { fetch, calls } = gateway(new Response(null, { status: 302, headers }));
    const response = await forwardToGateway(new Request(`${APP}/api/auth/callback/github?code=x`), { fetch }, APP);
    expect(calls.mock.calls[0][1].redirect).toBe("manual");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.test/authorize");
    expect(response.headers.getSetCookie()).toEqual(["a=1; HttpOnly", "b=2; HttpOnly"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
