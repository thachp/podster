import { env, SELF } from "cloudflare:test";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it, vi } from "vitest";
import { mintPublicAssertion } from "../src/assertion";
import { CAPABILITIES } from "../src/capabilities";
import { allowedPassthrough } from "../src/index";
import { contractView, filterPublicRead, normalizeHandle, publicPassthrough, publicView, PUBLIC_READ_CAPABILITIES, PUBLIC_VIEW_SECONDS, VIEW_FIELDS, viewFetcher } from "../src/public/reads";

// The gateway's side of the public read (M4 step 7, ADR 0008): the public assertion, the 30-second cache keyed by the
// handle alone, the contract's fields copied as a second filter, and the two agent capabilities.

const e = env as unknown as { API: Fetcher; ASSERTION_SIGNING_JWK: string; TEST_PUBLIC_VIEW_SCHEMA: string };
const HANDLE = `pub_${"ab".repeat(16)}`;
const view = (handle = HANDLE) => ({
  handle,
  published_on: "2026-11-08",
  content: {
    name: "Reef", goal: null, context: null, topic: null, workflow: "general", participant_count: 2, person_review: true, archived: false,
    openings: [{ id: null, title: "Diver", responsibilities: "Dive", capacity: 1, filled: 0, preset: "guest", lead: false, publicly_claimable: false }],
    outputs: [{ title: "Map", description: null, ready: false }],
  },
});

/** A cache in memory, as the Cache API would act within its 30 seconds. */
function memoryCache() {
  const kept = new Map<string, string>();
  return {
    kept,
    match: async (key: RequestInfo | URL) => {
      const body = kept.get(new Request(key).url);
      return body === undefined ? undefined : new Response(body);
    },
    put: async (key: RequestInfo | URL, response: Response) => {
      expect(response.headers.get("cache-control")).toBe(`max-age=${PUBLIC_VIEW_SECONDS}`);
      kept.set(new Request(key).url, await response.text());
    },
  };
}

describe("the public assertion", () => {
  it("names no one: kind public, and only the claims every assertion has", async () => {
    const token = await mintPublicAssertion(e.ASSERTION_SIGNING_JWK);
    expect(Object.keys(decodeJwt(token)).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "kind"]);
    expect(decodeJwt(token)).toMatchObject({ kind: "public", iss: "podster-gateway", aud: "podster-api" });
    expect(decodeProtectedHeader(token).alg).toBe("EdDSA");
  });

  it("is taken by the real API's room page, which answers the one not-found while public rooms are off", async () => {
    const answer = await viewFetcher(e)(HANDLE);
    expect(answer.status).toBe(404);
    expect(((await answer.json()) as any).error.code).toBe("workspace_not_found");
  });

  it("is refused by every other route, Explore included", async () => {
    const token = await mintPublicAssertion(e.ASSERTION_SIGNING_JWK);
    for (const path of ["/v1/public/explore", "/v1/me", "/v1/workspaces", "/v1/inbox"]) {
      const answer = await e.API.fetch(new Request(`https://api.internal${path}`, { headers: { "x-podster-assertion": token } }));
      expect(answer.status, path).toBe(401);
    }
  });
});

describe("the cached view", () => {
  it("keeps only a successful view, for 30 seconds, under the handle alone", async () => {
    const cache = memoryCache();
    let asked = 0;
    const fetchView = async (handle: string) => { asked++; return Response.json(view(handle)); };
    expect(await publicView(HANDLE, fetchView, cache)).toEqual({ status: 200, view: view() });
    expect(await publicView(HANDLE, fetchView, cache)).toEqual({ status: 200, view: view() });
    expect(asked).toBe(1);
    expect([...cache.kept.keys()]).toEqual([`https://public-view.podster.internal/workrooms/${HANDLE}`]);
  });

  it("never keeps a not-found, an error or a view for another handle", async () => {
    const cache = memoryCache();
    for (const answer of [new Response("{}", { status: 404 }), new Response("{}", { status: 500 }), new Response("{}", { status: 429 }), Response.json(view(`pub_${"cd".repeat(16)}`))]) {
      expect(await publicView(HANDLE, async () => answer.clone(), cache)).toEqual({ status: 404 });
    }
    expect(cache.kept.size).toBe(0);
  });

  it("answers not-found for anything that can't be a handle, without asking the API", async () => {
    let asked = 0;
    // Matching is exact, as in the API: upper case or padding is the same not-found, not another spelling of the handle.
    for (const handle of ["", "pub_", `${HANDLE}0`, "ws_123", `pub_${"g".repeat(32)}`, HANDLE.toUpperCase(), `PUB_${HANDLE.slice(4)}`, ` ${HANDLE}`, `${HANDLE} `, `${HANDLE}\n`, null, 7, { handle: HANDLE }]) {
      expect(await publicView(handle, async () => { asked++; return Response.json(view()); }, null), JSON.stringify(handle)).toEqual({ status: 404 });
    }
    expect(asked).toBe(0);
    expect(normalizeHandle(HANDLE)).toBe(HANDLE);
    expect(normalizeHandle(HANDLE.toUpperCase())).toBeNull();
  });

  it("treats a corrupt cache entry as a miss, and a 200 that isn't JSON as not-found", async () => {
    const cache = memoryCache();
    cache.kept.set(`https://public-view.podster.internal/workrooms/${HANDLE}`, "{not json");
    let asked = 0;
    expect(await publicView(HANDLE, async () => { asked++; return Response.json(view()); }, cache)).toEqual({ status: 200, view: view() });
    expect(asked).toBe(1);
    const fresh = memoryCache();
    expect(await publicView(HANDLE, async () => new Response("<html>oops</html>", { status: 200 }), fresh)).toEqual({ status: 404 });
    expect(fresh.kept.size).toBe(0);
    // A cached view for another handle isn't served either.
    const crossed = memoryCache();
    crossed.kept.set(`https://public-view.podster.internal/workrooms/${HANDLE}`, JSON.stringify(view(`pub_${"cd".repeat(16)}`)));
    expect(await publicView(HANDLE, async () => new Response("{}", { status: 404 }), crossed)).toEqual({ status: 404 });
  });

  it("treats a cache that throws as a miss, and logs it once with no handle", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { match: async () => { throw new Error(`boom ${HANDLE}`); }, put: async () => { throw new Error(`boom ${HANDLE}`); } };
    try {
      for (let n = 0; n < 3; n++) expect(await publicView(HANDLE, async () => Response.json(view()), broken)).toEqual({ status: 200, view: view() });
      const lines = errors.mock.calls.map((call) => call.map(String).join(" "));
      expect(lines.length).toBeLessThanOrEqual(1);
      for (const line of lines) expect(line).not.toContain("pub_");
    } finally {
      errors.mockRestore();
    }
  });

  it("copies only the contract's fields, at every level", async () => {
    const extra = view() as any;
    extra.workspace_id = "ws_secret";
    extra.content.owner = "per_secret";
    extra.content.openings[0].created_by = "per_secret";
    extra.content.outputs[0].current_task_id = "t_secret";
    const copied = contractView(extra);
    expect(JSON.stringify(copied)).not.toContain("secret");
    expect(copied).toEqual(view());
  });

  it("names the same fields as the contract's schema", () => {
    const schema = JSON.parse(e.TEST_PUBLIC_VIEW_SCHEMA);
    expect([...VIEW_FIELDS.top].sort()).toEqual(Object.keys(schema.properties).sort());
    expect([...VIEW_FIELDS.content].sort()).toEqual(Object.keys(schema.properties.content.properties).sort());
    expect([...VIEW_FIELDS.opening].sort()).toEqual(Object.keys(schema.properties.content.properties.openings.items.properties).sort());
    expect([...VIEW_FIELDS.output].sort()).toEqual(Object.keys(schema.properties.content.properties.outputs.items.properties).sort());
  });
});

describe("one field filter for every caller", () => {
  const planted = () => {
    const extra = view() as any;
    extra.workspace_id = "ws_secret";
    extra.content.owner = "per_secret";
    extra.content.openings[0].created_by = "per_secret";
    extra.content.outputs[0].current_task_id = "t_secret";
    return extra;
  };

  it("strips a planted field at every level from a signed-in person's room page and Explore, and says no-store", async () => {
    const workroom = await publicPassthrough(`/v1/public/workrooms/${HANDLE}`, Response.json(planted()));
    expect(workroom!.status).toBe(200);
    expect(workroom!.headers.get("cache-control")).toBe("no-store");
    const workroomText = await workroom!.text();
    expect(workroomText).not.toContain("secret");
    expect(JSON.parse(workroomText)).toEqual(view());
    const page = await publicPassthrough("/v1/public/explore", Response.json({ workrooms: [planted(), planted()], next_cursor: "ab", total: 99, workspace_ids: ["ws_secret"] }));
    expect(page!.headers.get("cache-control")).toBe("no-store");
    const pageText = await page!.text();
    expect(pageText).not.toContain("secret");
    expect(JSON.parse(pageText)).toEqual({ workrooms: [view(), view()], next_cursor: "ab" });
  });

  it("passes refusals on, marked no-store, and leaves every other path alone", async () => {
    const refused = await publicPassthrough("/v1/public/explore", new Response(JSON.stringify({ error: { code: "invalid_argument" } }), { status: 400 }));
    expect([refused!.status, refused!.headers.get("cache-control")]).toEqual([400, "no-store"]);
    expect(await publicPassthrough("/v1/workspaces/ws_1", Response.json({ ok: true }))).toBeNull();
    expect(await publicPassthrough(`/v1/public/workrooms/${HANDLE}/more`, Response.json({}))).toBeNull();
    const broken = await publicPassthrough("/v1/public/explore", new Response("not json", { status: 200 }));
    expect(broken!.status).toBe(502);
  });

  it("is the same filter the agents' capabilities use", () => {
    expect(PUBLIC_READ_CAPABILITIES).toEqual({ get_public_workroom: "workroom", discover_workrooms: "explore" });
    expect(filterPublicRead("workroom", planted())).toEqual(view());
  });
});

describe("the gateway's own hostname", () => {
  it("has no public read route signed out", async () => {
    for (const path of [`/v1/public/workrooms/${HANDLE}`, `/api/v1/public/workrooms/${HANDLE}`, "/api/v1/public/explore", "/v1/public/explore"]) {
      const answer = await SELF.fetch(`https://gateway.test${path}`);
      expect([401, 404], path).toContain(answer.status);
    }
  });

  it("passes a signed-in person's Explore and room page through to the API, which decides", () => {
    expect(allowedPassthrough("/v1/public/explore")).toBe(true);
    expect(allowedPassthrough(`/v1/public/workrooms/${HANDLE}`)).toBe(true);
  });

  it("gives agents get_public_workroom and discover_workrooms as queries", () => {
    const named = CAPABILITIES.filter((c) => c.name === "get_public_workroom" || c.name === "discover_workrooms");
    expect(named.map((c) => [c.name, c.kind, c.method, c.path])).toEqual([
      ["get_public_workroom", "query", "GET", "/v1/public/workrooms/{handle}"],
      ["discover_workrooms", "query", "GET", "/v1/public/explore"],
    ]);
  });
});
