import { beforeEach, describe, expect, it, vi } from "vitest";

const env: Record<string, any> = {};
vi.mock("@/lib/gateway/env", () => ({ webEnv: () => env }));
const { GET } = await import("./route");
const { GET: style } = await import("../../p-assets/style/route");

const HANDLE = `pub_${"a".repeat(32)}`;
const VIEW = { handle: HANDLE, published_on: "2026-11-09", content: { name: "Reef", goal: null, context: null, topic: null, workflow: "general", openings: [], outputs: [], participant_count: 1, person_review: true, archived: false } };
const get = (handle: string, init: RequestInit = {}) => GET(new Request(`https://app.test/p/${handle}`, init), { params: Promise.resolve({ handle }) });
const EXPECTED = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin" };

function expectPublicHeaders(response: Response) {
  for (const [name, value] of Object.entries(EXPECTED)) expect(response.headers.get(name), name).toBe(value);
  const csp = response.headers.get("content-security-policy") ?? "";
  for (const part of ["default-src 'none'", "script-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "style-src 'self'", "base-uri 'none'"]) expect(csp).toContain(part);
}

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  env.PUBLIC_READS = { getWorkroom: vi.fn(async (handle: string) => (handle === HANDLE ? { status: 200, view: VIEW } : { status: 404 })) };
  env.PUBLIC_PAGE_LIMIT = { limit: vi.fn(async () => ({ success: true })) };
});

describe("GET /p/{handle}", () => {
  it("serves the page with no script and the public headers", async () => {
    const response = await get(HANDLE);
    expect(response.status).toBe(200);
    expectPublicHeaders(response);
    const body = await response.text();
    expect(body).toContain("<h1>Reef</h1>");
    expect(body).not.toMatch(/<script/i);
  });

  it("is byte for byte the same with cookies, a session, or other headers (M4-13)", async () => {
    const bodies = await Promise.all([
      get(HANDLE).then((r) => r.text()),
      get(HANDLE, { headers: { cookie: "better-auth.session_token=abc; podster-org=org_1" } }).then((r) => r.text()),
      get(HANDLE, { headers: { authorization: "Bearer x", "x-forwarded-host": "evil.example", host: "evil.example" } }).then((r) => r.text()),
    ]);
    expect(new Set(bodies).size).toBe(1);
  });

  it("answers one not-found page, with the same headers, for every way a handle fails (M4-02)", async () => {
    // The real room's read fails, a stranger's handle and an internal ID aren't public.
    env.PUBLIC_READS.getWorkroom = vi.fn(async (handle: string) => {
      if (handle === HANDLE) throw new Error("down");
      return { status: 404 };
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers = await Promise.all([get(`pub_${"b".repeat(32)}`), get("ws_1234"), get(HANDLE)]);
    const bodies = await Promise.all(answers.map((r) => r.text()));
    for (const r of answers) {
      expect(r.status).toBe(404);
      expectPublicHeaders(r);
    }
    expect(new Set(bodies).size).toBe(1);
    quiet.mockRestore();
  });

  it("refuses a view for another handle", async () => {
    env.PUBLIC_READS.getWorkroom = vi.fn(async () => ({ status: 200, view: { ...VIEW, handle: `pub_${"c".repeat(32)}` } }));
    expect((await get(HANDLE)).status).toBe(404);
  });

  it("limits each client address, says 429 with the same headers, and lets others through (M4-10)", async () => {
    env.PUBLIC_PAGE_LIMIT.limit = vi.fn(async ({ key }: { key: string }) => ({ success: key !== "203.0.113.9" }));
    const limited = await get(HANDLE, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(limited.status).toBe(429);
    expectPublicHeaders(limited);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(env.PUBLIC_READS.getWorkroom).not.toHaveBeenCalled();
    expect((await get(HANDLE, { headers: { "cf-connecting-ip": "198.51.100.1" } })).status).toBe(200);
  });

  it("fails open when the limiter fails", async () => {
    env.PUBLIC_PAGE_LIMIT.limit = vi.fn(async () => { throw new Error("limiter down"); });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await get(HANDLE, { headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);
    // Only that it failed: no address, key or handle.
    expect(quiet.mock.calls.flat().join(" ")).not.toMatch(/203\.0\.113\.9|pub_/);
    quiet.mockRestore();
  });

  it("serves its stylesheet under the same headers", async () => {
    const css = style();
    expect(css.headers.get("content-type")).toContain("text/css");
    expectPublicHeaders(css);
  });
});
