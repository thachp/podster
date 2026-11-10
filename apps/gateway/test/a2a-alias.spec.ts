import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { type Env, type RateLimit } from "../src/index";
import { MAX_A2A_BODY_BYTES } from "../src/a2a/profile";
import { A2A, MCP, connect, setUpSchemas, signUp } from "./oauth-helpers";

/**
 * Decision 190: `/a2a/` is `/a2a`, for clients that join the card's interface URL with a slash, as the A2A compatibility kit's
 * does. Every answer, refusals included, must be the same on both, and no other path is aliased.
 */

const BASE = "https://gateway.test";
const e = env as unknown as Env;
let a2a = "";
let mcp = "";

beforeAll(async () => {
  await setUpSchemas();
  const person = await signUp();
  a2a = (await connect(person, A2A, "a2a")).access;
  mcp = (await connect(person, MCP, "mcp")).access;
});

const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 7, method, params });
const headers = (token?: string, more: Record<string, string> = {}) => ({
  "content-type": "application/json", "A2A-Version": "1.0", ...(token ? { authorization: `Bearer ${token}` } : {}), ...more,
});
/** What a client can tell apart: the status, the body, and the headers that carry meaning. */
async function seen(res: Response) {
  const keep = ["content-type", "www-authenticate", "retry-after", "a2a-version", "allow"];
  const out: Record<string, string | null> = {};
  for (const name of keep) out[name] = res.headers.get(name);
  return { status: res.status, headers: out, body: await res.text() };
}
const both = async (init: () => RequestInit, via: (path: string, init: RequestInit) => Promise<Response> = (path, i) => SELF.fetch(`${BASE}${path}`, i)) => {
  const exact = await seen(await via("/a2a", init()));
  const slash = await seen(await via("/a2a/", init()));
  return { exact, slash };
};

describe("/a2a/ answers exactly as /a2a", () => {
  const cases: [string, () => RequestInit][] = [
    ["an authenticated read", () => ({ method: "POST", headers: headers(a2a), body: rpc("GetTask", { id: "tsk_" + "0".repeat(32) }) })],
    ["no credential", () => ({ method: "POST", headers: headers(), body: rpc("GetTask", { id: "tsk_x" }) })],
    ["an /mcp token, the wrong audience", () => ({ method: "POST", headers: headers(mcp), body: rpc("GetTask", { id: "tsk_x" }) })],
    ["junk for a token", () => ({ method: "POST", headers: headers("not-a-token"), body: rpc("GetTask", { id: "tsk_x" }) })],
    ["the wrong content type", () => ({ method: "POST", headers: headers(a2a, { "content-type": "text/plain" }), body: rpc("GetTask", { id: "tsk_x" }) })],
    ["a body over 64 KB", () => ({ method: "POST", headers: headers(a2a), body: "x".repeat(MAX_A2A_BODY_BYTES + 1) })],
    ["the wrong A2A version", () => ({ method: "POST", headers: headers(a2a, { "A2A-Version": "0.3" }), body: rpc("GetTask", { id: "tsk_x" }) })],
    ["GET", () => ({ method: "GET", headers: headers(a2a) })],
  ];
  for (const [name, init] of cases) {
    it(name, async () => {
      const { exact, slash } = await both(init);
      expect(slash).toEqual(exact);
    });
  }

  it("over the client's general rate limit", async () => {
    const refuse: RateLimit = { limit: async () => ({ success: false }) };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    const via = (path: string, init: RequestInit) => worker.fetch(new Request(`${BASE}${path}`, init), { ...e, RL_GENERAL: refuse } as never, ctx);
    const { exact, slash } = await both(() => ({ method: "POST", headers: headers(a2a, { "cf-connecting-ip": "203.0.113.77" }), body: rpc("GetTask", { id: "tsk_x" }) }), via);
    expect(exact.status).toBe(429);
    expect(slash).toEqual(exact);
  });

  it("aliases no other path", async () => {
    for (const path of ["/a2a//", "/a2a/x", "/A2A/", "/a2a/?x=1"]) {
      const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers: headers(a2a), body: rpc("GetTask", { id: "tsk_x" }) });
      const text = await res.text();
      // `/a2a/?x=1` is the same path with a query, which is `/a2a`'s too. Everything else isn't A2A at all.
      if (path === "/a2a/?x=1") expect(res.status, path).toBe(200);
      else expect(text, path).not.toContain('"jsonrpc"');
    }
  });
});
