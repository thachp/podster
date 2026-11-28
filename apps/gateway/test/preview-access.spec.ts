import { env } from "cloudflare:test";
import { decodeJwt } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import worker, { allowedPassthrough, type Env } from "../src/index";
import { BASE, call, setUpSchemas, signUp, type Person } from "./oauth-helpers";

/**
 * M8 step 7: `POST /api/v1/preview-access`, the application host's ask for a preview host's ticket. **The gateway
 * translates only:** it authenticates the person, refuses a cross-site write as every dashboard command, and passes the
 * body to the API and the API's answer back exactly, never cached and never sent on as a `Referer`. Who gets a ticket is
 * the API's (`apps/api/test/preview-access.spec.ts`). A stand-in API records what reached it; the real API, which has
 * neither previews on nor a ticket key in this suite, shows the route answering as one nobody defined.
 */

const e = env as unknown as Env & { TEST_CAPABILITIES: string };
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const PREVIEW_ACCESS_PATH = "/v1/preview-access";
const BODY = { host: "pv7q2.podster.site", st: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU", r: "/a?b=1" };
const REDIRECT = "https://pv7q2.podster.site/__podster/enter#t=p.s&s=q.t&r=%2Fa%3Fb%3D1";

function standIn(answer: () => Response) {
  const seen: { method: string; path: string; body: string; sub: string | undefined; kind: unknown; key: string | null }[] = [];
  const api = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const assertion = request.headers.get("x-podster-assertion");
      const claims = assertion ? decodeJwt(assertion) : undefined;
      seen.push({ method: request.method, path: url.pathname + url.search, body: await request.text(), sub: claims?.sub, kind: claims?.kind, key: request.headers.get("idempotency-key") });
      return answer();
    },
  } as unknown as Fetcher;
  return { seen, env: { ...e, API: api } };
}
const ask = (who: Person | null, environment: object, init: { origin?: string | null; body?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.cookie = who.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? BASE;
  return worker.fetch(new Request(`${BASE}/api${PREVIEW_ACCESS_PATH}`, { method: "POST", headers, body: init.body ?? JSON.stringify(BODY) }), environment as never, ctx);
};

let person: Person;
beforeAll(async () => {
  await setUpSchemas();
  person = await signUp();
});

describe("POST /api/v1/preview-access through the gateway (M8 step 7)", () => {
  it("passes the person's ask to the API as it is, with their assertion, and the API's answer back exactly, never cached", async () => {
    const api = standIn(() => reply(200, { redirect: REDIRECT }, { "x-other": "1", "set-cookie": "a=b" }));
    const res = await ask(person, api.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: REDIRECT });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-other")).toBeNull();
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]).toMatchObject({ method: "POST", path: "/v1/preview-access", body: JSON.stringify(BODY), kind: "person", key: null });
    expect(api.seen[0].sub).toMatch(/^per_/);
  });

  it("passes the API's refusals through unchanged: one refusal for every host, the limit with its Retry-After, an agent's refusal", async () => {
    for (const [status, code, headers] of [[404, "preview_access_refused", {}], [429, "preview_access_limit", { "retry-after": "17" }], [400, "invalid_argument", {}], [404, "not_found", {}]] as const) {
      const api = standIn(() => reply(status, { error: { code, message: code } }, headers));
      const res = await ask(person, api.env);
      expect(res.status, code).toBe(status);
      expect((await res.json<any>()).error.code, code).toBe(code);
      expect(res.headers.get("cache-control"), code).toBe("no-store");
      expect(res.headers.get("retry-after"), code).toBe(status === 429 ? "17" : null);
    }
  });

  it("refuses a signed-out ask and a cross-site one before the API is asked", async () => {
    const api = standIn(() => reply(200, { redirect: REDIRECT }));
    expect((await ask(null, api.env)).status).toBe(401);
    expect((await ask(person, api.env, { origin: "https://pv7q2.podster.site" })).status).toBe(403);
    expect((await ask(person, api.env, { origin: null })).status).toBe(403);
    expect(api.seen).toHaveLength(0);
  });

  it("is answered by the real API as a path nobody defined while previews are off and no key is set", async () => {
    const res = await call(`/api${PREVIEW_ACCESS_PATH}`, { method: "POST", headers: { cookie: person.cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(BODY) });
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe("not_found");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is a dashboard path only: no capability, MCP tool or A2A method reaches it", () => {
    expect(allowedPassthrough(PREVIEW_ACCESS_PATH)).toBe(true);
    const contract = parse(e.TEST_CAPABILITIES);
    const operations = Object.values(contract.capabilities ?? {}).map((c: any) => c.operation);
    expect(operations.length).toBeGreaterThan(10);
    expect(operations).not.toContain("requestPreviewAccess");
    expect(contract.person_only).toContain("requestPreviewAccess");
  });
});
