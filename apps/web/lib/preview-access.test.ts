import { describe, expect, it, vi } from "vitest";

// The page is handed its gateway and origin; nothing here reads the Worker's own bindings.
vi.mock("./gateway/env", () => ({ webEnv: () => ({}) }));
const { default: nextConfig } = await import("../next.config");
const { enterAddressOk, previewAccess } = await import("./preview-access");

// M8 step 7: the application host's `/preview-access` page. It asks the gateway, and the API decides; this page only
// signs a person in, passes `host`, `st` and `r` on, and sends the browser to the address the API returned, whose
// ticket and session are only after `#`. Every refusal looks the same.

const APP = "https://app.test";
const HOST = "pv7q2.podster.site";
const ST = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
const ENTER = `https://${HOST}/__podster/enter#t=p.s&s=q.t&r=%2Fa%3Fb%3D1`;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function gateway(answers: { session?: Response; access?: Response } = {}) {
  const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: (init.body as string) ?? null });
    if (url.includes("/api/auth/get-session")) return answers.session ?? json(200, { user: { id: "u1", name: "P", email: "p@example.test" } });
    return answers.access ?? json(200, { redirect: ENTER });
  });
  return { fetch: fetch as unknown as Fetcher["fetch"], calls };
}
const query = (params: Record<string, string>) => `${APP}/preview-access?${new URLSearchParams(params)}`;
const visit = (g: ReturnType<typeof gateway>, params: Record<string, string> = { host: HOST, st: ST, r: "/a?b=1" }, headers: Record<string, string> = { cookie: "session=abc; podster-org=org_1", "sec-fetch-site": "cross-site" }) =>
  previewAccess(new Request(query(params), { headers }), g, APP);

function expectOwnHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

describe("GET /preview-access", () => {
  it("asks the gateway for the signed-in person and sends the browser on with 303 to the API's address, the ticket only after #", async () => {
    const g = gateway();
    const response = await visit(g);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ENTER);
    expectOwnHeaders(response);
    const location = response.headers.get("location") ?? "";
    expect(location.split("#")[0]).toBe(`https://${HOST}/__podster/enter`);
    const ask = g.calls.find((c) => c.method === "POST");
    expect(ask?.url).toBe(`${APP}/api/v1/preview-access`);
    expect(JSON.parse(ask?.body ?? "")).toEqual({ host: HOST, st: ST, r: "/a?b=1" });
    // The person's own session, and this application's own origin, since a navigation from a preview carries none.
    expect(ask?.headers.get("cookie")).toBe("session=abc; podster-org=org_1");
    expect(ask?.headers.get("origin")).toBe(APP);
    expect(ask?.headers.get("sec-fetch-site")).toBeNull();
  });

  it("sends a signed-out person to sign in and back here, asking for nothing", async () => {
    const g = gateway({ session: json(200, null) });
    const response = await visit(g);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/sign-in?next=")).toBe(true);
    expect(decodeURIComponent(location.slice("/sign-in?next=".length))).toBe(`/preview-access?${new URLSearchParams({ host: HOST, st: ST, r: "/a?b=1" })}`);
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expectOwnHeaders(response);
  });

  it("refuses a request with no st, or one whose host, st or r isn't of its form, before asking anyone: only a preview host starts a flow", async () => {
    const cases: Record<string, string>[] = [
      { host: HOST, r: "/" },
      { st: ST, r: "/" },
      { host: HOST, st: ST.slice(1), r: "/" },
      { host: HOST, st: `${ST.slice(0, 42)}=`, r: "/" },
      { host: "PV.podster.site", st: ST, r: "/" },
      { host: "evil.example/x", st: ST, r: "/" },
      { host: HOST, st: ST, r: "//evil.example" },
      { host: HOST, st: ST, r: "/\\evil.example" },
      { host: HOST, st: ST, r: "https://evil.example" },
      { host: HOST, st: ST, r: "/a b" },
    ];
    for (const params of cases) {
      const g = gateway();
      const response = await visit(g, params);
      expect(response.status, JSON.stringify(params)).toBe(400);
      expect(g.calls, JSON.stringify(params)).toHaveLength(0);
      expectOwnHeaders(response);
    }
  });

  it("serves only a top-level navigation: a frame, a fetch or a script loading it is refused before anyone is asked", async () => {
    for (const [dest, mode] of [["iframe", "navigate"], ["empty", "cors"], ["empty", "no-cors"], ["script", "no-cors"], ["document", "cors"], ["frame", "navigate"]]) {
      const g = gateway();
      const response = await visit(g, undefined, { cookie: "session=abc", "sec-fetch-dest": dest, "sec-fetch-mode": mode });
      expect(response.status, `${dest} ${mode}`).toBe(400);
      expect(g.calls, `${dest} ${mode}`).toHaveLength(0);
    }
    const g = gateway();
    expect((await visit(g, undefined, { cookie: "session=abc", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" })).status).toBe(303);
  });

  it("shows one page for every refusal the API gives, previews off included", async () => {
    const bodies = new Set<string>();
    for (const [status, code] of [[404, "preview_access_refused"], [404, "not_found"], [403, "not_allowed"], [400, "invalid_argument"]] as const) {
      const response = await visit(gateway({ access: json(status, { error: { code, message: code } }) }));
      expect(response.status, code).toBe(404);
      expect(response.headers.get("location"), code).toBeNull();
      expectOwnHeaders(response);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("sends a person past the limit to wait, with how long", async () => {
    const response = await visit(gateway({ access: json(429, { error: { code: "preview_access_limit", message: "preview_access_limit" } }, { "retry-after": "17" }) }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/too-many-requests?after=17");
  });

  it("never sends the browser anywhere but the exchange page on the host asked for, with no query", async () => {
    for (const redirect of [
      `https://evil.example/__podster/enter#t=p.s&s=q.t&r=%2F`,
      `https://${HOST}/__podster/enter?t=p.s#t=p.s&s=q.t&r=%2F`,
      `https://${HOST}/other#t=p.s&s=q.t&r=%2F`,
      `http://${HOST}/__podster/enter#t=p.s&s=q.t&r=%2F`,
      `https://${HOST}/__podster/enter`,
      `https://${HOST}/__podster/enter#t=&s=q.t&r=%2F`,
      `https://${HOST}/__podster/enter#t=p.s&s=q.t&r=%2F&x=1`,
      `https://${HOST}.evil.example/__podster/enter#t=p.s&s=q.t&r=%2F`,
    ]) {
      const response = await visit(gateway({ access: json(200, { redirect }) }));
      expect(response.status, redirect).toBe(404);
      expect(response.headers.get("location"), redirect).toBeNull();
      expect(enterAddressOk(redirect, HOST), redirect).toBe(false);
    }
    expect(enterAddressOk(ENTER, HOST)).toBe(true);
    expect(enterAddressOk(42, HOST)).toBe(false);
  });

  it("is left out of next.config's header rule, so its own no-referrer and no-store stand", async () => {
    const rules = await nextConfig.headers!();
    const pattern = new RegExp(`^${rules[0].source}$`);
    expect(pattern.test("/preview-access")).toBe(false);
    expect(pattern.test("/attention")).toBe(true);
    expect(pattern.test("/preview-access/x")).toBe(true);
  });
});
