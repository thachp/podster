import { describe, expect, it, vi } from "vitest";
import { boundedBody, forwardedHeaders, forwardToGateway, isForwardable, MAX_FORWARDED_BODY_BYTES } from "./forward";

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
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"name":"x"}');
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

/**
 * A body with no length sending 64 KiB chunks, 4 MiB in all, counting what was asked of it. It ends so that a missing
 * limit fails an assertion instead of exhausting the test's memory.
 */
function endless() {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

const put = (body: BodyInit, headers: Record<string, string> = {}) => new Request(`${APP}/api/v1/workspaces`, { method: "POST", body, headers, duplex: "half" } as RequestInit);

describe("a body's size", () => {
  it("refuses a declared length over the limit before reading any of it", async () => {
    const { fetch, calls } = gateway();
    const body = endless();
    const response = await forwardToGateway(put(body.stream, { "content-length": String(MAX_FORWARDED_BODY_BYTES + 1) }), { fetch }, APP);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "body_too_large", message: "body_too_large" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).not.toHaveBeenCalled();
    expect(body.cancelled()).toBe(true);
    // A stream asks for its first chunk as it starts, before anyone reads it. Nothing past that is read.
    expect(body.pulled()).toBeLessThanOrEqual(1);
  });

  it("refuses a length that isn't a number", async () => {
    expect(await boundedBody(put("{}", { "content-length": "lots" }), MAX_FORWARDED_BODY_BYTES)).toBeNull();
  });

  it("stops reading a streamed body with no length once it passes the limit", async () => {
    const { fetch, calls } = gateway();
    const body = endless();
    const response = await forwardToGateway(put(body.stream), { fetch }, APP);
    expect(response.status).toBe(413);
    expect(calls).not.toHaveBeenCalled();
    expect(body.cancelled()).toBe(true);
    // 16 chunks reach the limit exactly and the 17th passes it. A couple more may be queued ahead of the reader.
    expect(body.pulled()).toBeGreaterThanOrEqual(17);
    expect(body.pulled()).toBeLessThanOrEqual(20);
  });

  it("takes a streamed body up to the limit itself, byte for byte", async () => {
    const { fetch, calls } = gateway();
    const bytes = new Uint8Array(MAX_FORWARDED_BODY_BYTES).map((_, i) => i % 251);
    const chunks = [bytes.subarray(0, 1000), bytes.subarray(1000)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const response = await forwardToGateway(put(stream), { fetch }, APP);
    expect(response.status).toBe(200);
    expect(new Uint8Array(calls.mock.calls[0][1].body as Uint8Array)).toEqual(bytes);
  });

  it("refuses a body one byte over the limit when its length is declared truthfully", async () => {
    expect(await boundedBody(put(new Uint8Array(MAX_FORWARDED_BODY_BYTES + 1), { "content-length": String(MAX_FORWARDED_BODY_BYTES + 1) }), MAX_FORWARDED_BODY_BYTES)).toBeNull();
  });

  it("doesn't trust a declared length that understates the body", async () => {
    expect(await boundedBody(put(new Uint8Array(MAX_FORWARDED_BODY_BYTES + 1), { "content-length": "10" }), MAX_FORWARDED_BODY_BYTES)).toBeNull();
  });

  it("reads a request with no body as empty", async () => {
    expect(await boundedBody(new Request(`${APP}/api/v1/workspaces`, { method: "POST" }), MAX_FORWARDED_BODY_BYTES)).toEqual(new Uint8Array(0));
  });
});
