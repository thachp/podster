import { env } from "cloudflare:test";
import { decodeJwt } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { GITHUB_WEBHOOK_PATH, handleGithubWebhook, MAX_WEBHOOK_BYTES, normalize } from "../src/github-webhook";

// M5 step 5: GitHub's webhook deliveries. The gateway checks the signature and passes on IDs and a commit; it decides
// nothing. Most tests stand a fake in for the API to see exactly what's sent. The last ones go through the whole Worker to
// the real API.

const BASE = "https://gateway.test";
const SECRET = "a-webhook-secret-for-tests-only-0123456789";
const e = env as unknown as Env & { TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; API_DB: D1Database };
const REPO = 987654321;
const HEAD = "a1".repeat(20);
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
// Text a person or an agent typed at GitHub. None of it may go any further than the gateway's memory.
const TYPED = ["SECRET-TITLE", "secret body text", "feature/secret-branch", "octo-secret-login", "https://github.com/podsterdev/secret-name", "secret-name", "secret-check-name"];

const pullRequest = (over: object = {}) => ({
  action: "synchronize",
  number: 7,
  pull_request: {
    number: 7, title: "SECRET-TITLE", body: "secret body text", state: "open", merged: false, html_url: "https://github.com/podsterdev/secret-name/pull/7",
    user: { login: "octo-secret-login" },
    head: { sha: HEAD, ref: "feature/secret-branch", repo: { id: 111, full_name: "octo-secret-login/secret-name" } },
    base: { sha: "b2".repeat(20), ref: "main", repo: { id: REPO } },
  },
  repository: { id: REPO, name: "secret-name", full_name: "podsterdev/secret-name", html_url: "https://github.com/podsterdev/secret-name" },
  installation: { id: 55 },
  sender: { login: "octo-secret-login" },
  ...over,
});

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const DIGEST = "5e".repeat(32);

type Options = { secret?: string | undefined; event?: string | null; delivery?: string | null; signature?: string | null; method?: string; path?: string; api?: (r: Request) => Promise<Response>; headers?: Record<string, string> };
/** One delivery to the handler, with a fake API that records what it's sent. */
async function deliver(payload: unknown, options: Options & { noSecret?: boolean; raw?: BodyInit } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const seen: { url: string; method: string; headers: Headers; text: string }[] = [];
  const api = options.api ?? (async () => new Response('{"accepted":true}', { status: 202 }));
  const fetcher = { fetch: async (request: Request) => { seen.push({ url: request.url, method: request.method, headers: request.headers, text: await request.clone().text() }); return api(request); } } as unknown as Fetcher;
  const headers: Record<string, string> = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (options.event !== null) headers["x-github-event"] = options.event ?? "pull_request";
  if (options.delivery !== null) headers["x-github-delivery"] = options.delivery ?? DELIVERY;
  const signature = options.signature === undefined ? await sign(text) : options.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  const method = options.method ?? "POST";
  const request = new Request(`${BASE}${options.path ?? GITHUB_WEBHOOK_PATH}`, { method, headers, body: method === "GET" ? undefined : (options.raw ?? text), ...(options.raw instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
  const response = await handleGithubWebhook(request, new URL(request.url), { API: fetcher, ASSERTION_SIGNING_JWK: e.ASSERTION_SIGNING_JWK, GITHUB_WEBHOOK_SECRET: options.noSecret ? undefined : (options.secret ?? SECRET) });
  const body = response ? await response.json().catch(() => null) as any : null;
  return { response, status: response?.status, code: body?.error?.code as string | undefined, body, seen };
}

beforeAll(async () => {
  for (const sql of e.TEST_API_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await e.API_DB.prepare(sql).run();
});
afterEach(() => vi.restoreAllMocks());

describe("the webhook route", () => {
  it("leaves every other path alone", async () => {
    for (const path of ["/webhooks", "/webhooks/github/", "/webhooks/gitlab", "/api/webhooks/github", "/v1/provider/github/deliveries"]) {
      const { response, seen } = await deliver(pullRequest(), { path });
      expect(response, path).toBeNull();
      expect(seen).toEqual([]);
    }
  });

  it("refuses everything while no secret is set, as a path that isn't there", async () => {
    // Signed correctly under the secret another deployment would hold, and not at all.
    for (const signature of [await sign(JSON.stringify(pullRequest())), null]) {
      const { status, code, seen } = await deliver(pullRequest(), { noSecret: true, signature });
      expect([status, code]).toEqual([404, "not_found"]);
      expect(seen).toEqual([]);
    }
    // A secret too short to be one counts as none, even for a delivery signed with it.
    for (const secret of ["short", "x".repeat(31)]) {
      const text = JSON.stringify(pullRequest());
      const { status, seen } = await deliver(text, { secret, signature: await sign(text, secret) });
      expect(status, secret).toBe(404);
      expect(seen).toEqual([]);
    }
    expect((await deliver(pullRequest(), { secret: "", signature: null })).status).toBe(404);
    expect((await deliver(pullRequest(), { noSecret: true, method: "GET" })).status).toBe(404);
  });

  it("refuses a delivery with no signature, a malformed one, or one that isn't this body's under this secret", async () => {
    const text = JSON.stringify(pullRequest());
    const good = await sign(text);
    const refused: (string | null)[] = [
      null, "", good.slice("sha256=".length), `sha1=${"a".repeat(40)}`, `sha256=${"a".repeat(63)}`, `sha256=${"A".repeat(64)}`, `${good}00`, `sha256=${"0".repeat(64)}`,
      // Another body's signature, and this body's under another secret.
      await sign(`${text} `), await sign(text, "another-secret-of-a-plausible-length-000"),
      // One hex digit off.
      good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"),
    ];
    for (const signature of refused) {
      const { status, code, seen } = await deliver(text, { signature });
      expect([status, code], String(signature)).toEqual([401, "invalid_signature"]);
      expect(seen).toEqual([]);
    }
    expect((await deliver(text, { signature: good })).status).toBe(202);
  });

  it("refuses a delivery that carries two signatures, even when one of them is right", async () => {
    const text = JSON.stringify(pullRequest());
    const good = await sign(text);
    for (const pair of [[good, good], [good, `sha256=${"0".repeat(64)}`], [`sha256=${"0".repeat(64)}`, good]]) {
      const headers = new Headers({ "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": DELIVERY });
      for (const value of pair) headers.append("x-hub-signature-256", value);
      const seen: Request[] = [];
      const request = new Request(`${BASE}${GITHUB_WEBHOOK_PATH}`, { method: "POST", headers, body: text });
      const response = await handleGithubWebhook(request, new URL(request.url), { API: { fetch: async (r: Request) => { seen.push(r); return new Response("{}", { status: 202 }); } } as unknown as Fetcher, ASSERTION_SIGNING_JWK: e.ASSERTION_SIGNING_JWK, GITHUB_WEBHOOK_SECRET: SECRET });
      expect(response?.status, pair.join(" + ").slice(0, 40)).toBe(401);
      expect(seen).toEqual([]);
    }
  });

  it("takes only a JSON body: a form-encoded delivery is refused, signed or not", async () => {
    // GitHub can be set to send `payload=<json>` as a form. The App must be set to JSON, and this is what the other setting gets.
    const form = `payload=${encodeURIComponent(JSON.stringify(pullRequest()))}`;
    const { status, code, seen } = await deliver(form, { headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect([status, code]).toEqual([400, "invalid_payload"]);
    expect(seen).toEqual([]);
    // The content type itself decides nothing: JSON under a form's label is read as the JSON it is.
    expect((await deliver(pullRequest(), { headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(202);
  });

  it("passes a delivery ID on exactly as it came, upper case and all", async () => {
    const mixed = "72D3162E-cc78-11E3-81ab-4C9367DC0958";
    const { status, seen } = await deliver(pullRequest(), { delivery: mixed });
    expect(status).toBe(202);
    expect(JSON.parse(seen[0].text).delivery_id).toBe(mixed);
    expect(decodeJwt(seen[0].headers.get("x-podster-assertion")!).delivery).toBe(mixed);
  });

  it("only takes POST", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const { status, code, seen } = await deliver(pullRequest(), { method });
      expect([status, code], method).toEqual([405, "method_not_allowed"]);
      expect(seen).toEqual([]);
    }
  });

  it("refuses an oversized body without reading past the limit, whether or not it says how long it is", async () => {
    const big = JSON.stringify(pullRequest({ padding: "x".repeat(MAX_WEBHOOK_BYTES) }));
    const declared = await deliver(big);
    expect([declared.status, declared.code]).toEqual([413, "body_too_large"]);
    expect(declared.seen).toEqual([]);
    // Chunked, so there's no length to trust. The stream is cut off as soon as it's over.
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const stream = new ReadableStream({ pull(c) { pulled += chunk.length; if (pulled > 8 * MAX_WEBHOOK_BYTES) c.close(); else c.enqueue(chunk); } });
    const chunked = await deliver(big, { raw: stream });
    expect([chunked.status, chunked.code]).toEqual([413, "body_too_large"]);
    expect(chunked.seen).toEqual([]);
    expect(pulled).toBeLessThan(2 * MAX_WEBHOOK_BYTES);
    // Right at the limit is read, and then judged by its signature like any other.
    const edge = "x".repeat(MAX_WEBHOOK_BYTES);
    expect((await deliver(edge)).code).toBe("invalid_payload");
  });

  it("refuses an event M5 doesn't use, and answers a ping without passing it on", async () => {
    for (const event of ["push", "installation", "check_suite", "issues", "workflow_run", "Pull_Request", "", null]) {
      const { status, code, seen } = await deliver(pullRequest(), { event });
      expect([status, code], String(event)).toEqual([422, "event_not_used"]);
      expect(seen).toEqual([]);
    }
    const ping = await deliver({ zen: "Keep it logically awesome.", hook_id: 1 }, { event: "ping" });
    expect(ping.status).toBe(200);
    expect(ping.seen).toEqual([]);
    // An unsigned ping is still unsigned.
    expect((await deliver({ zen: "x" }, { event: "ping", signature: null })).status).toBe(401);
  });

  it("refuses a delivery ID that isn't a short plain one, and a payload that isn't a delivery", async () => {
    for (const delivery of [null, "", "a b", "a/b", "x".repeat(65), "délivery"]) {
      const { status, code, seen } = await deliver(pullRequest(), { delivery });
      expect([status, code], String(delivery)).toEqual([400, "invalid_delivery"]);
      expect(seen).toEqual([]);
    }
    for (const payload of ["not json", "[]", "null", "7", JSON.stringify({ pull_request: { number: 7 } }), JSON.stringify(pullRequest({ repository: { id: "987654321" } })), JSON.stringify({ repository: { id: REPO } })]) {
      const { status, code, seen } = await deliver(payload);
      expect([status, code], payload.slice(0, 40)).toEqual([400, "invalid_payload"]);
      expect(seen).toEqual([]);
    }
  });

  it("passes on IDs and one commit, and nothing a person typed", async () => {
    const { status, body, seen } = await deliver(pullRequest());
    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect([call.method, call.url]).toEqual(["POST", "https://api.internal/v1/provider/github/deliveries"]);
    // The hash is of the raw body GitHub signed, so the same body is known again under any delivery ID.
    expect(JSON.parse(call.text)).toEqual({ delivery_id: DELIVERY, body_sha256: await sha256(JSON.stringify(pullRequest())), event: "pull_request", repository_id: REPO, pull_requests: [7], head_sha: HEAD });
    const other = await deliver(pullRequest(), { delivery: "another-id" });
    expect(JSON.parse(other.seen[0].text).body_sha256).toBe(JSON.parse(call.text).body_sha256);
    expect(JSON.parse((await deliver(pullRequest({ number: 8 }))).seen[0].text).body_sha256).not.toBe(JSON.parse(call.text).body_sha256);
    for (const typed of [...TYPED, "main", "open", "synchronize"]) expect(call.text).not.toContain(typed);
    // Only the assertion and a content type go with it: no GitHub header, and no signature to replay.
    expect([...call.headers.keys()].sort()).toEqual(["content-type", "x-podster-assertion"]);
    // The assertion names no one, and is for exactly this body.
    const claims = decodeJwt(call.headers.get("x-podster-assertion")!);
    const digest = await sha256(call.text);
    expect(Object.keys(claims).sort()).toEqual(["aud", "body_sha256", "delivery", "exp", "iat", "iss", "jti", "kind", "provider"]);
    expect(claims).toMatchObject({ kind: "provider_delivery", provider: "github", delivery: DELIVERY, body_sha256: digest, iss: "podster-gateway", aud: "podster-api" });
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  it("logs the delivery ID and a fixed code, and never what the payload said", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    await deliver(pullRequest());
    await deliver(pullRequest(), { event: "push" });
    await deliver(pullRequest({ repository: {} }));
    await deliver(pullRequest(), { api: async () => new Response('{"error":{"code":"internal_error","message":"SECRET-TITLE"}}', { status: 500 }) });
    await deliver(pullRequest(), { api: async () => { throw new Error("SECRET-TITLE"); } });
    // Refused before the signature is known to be good: nothing is logged, so a flood of forgeries writes nothing.
    await deliver(pullRequest(), { signature: null });
    await deliver(pullRequest(), { signature: `sha256=${"0".repeat(64)}` });
    await deliver(pullRequest(), { delivery: "SECRET-TITLE with spaces" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { at: "github.webhook", delivery: DELIVERY, outcome: "accepted" },
      { at: "github.webhook", delivery: DELIVERY, outcome: "event_not_used" },
      { at: "github.webhook", delivery: DELIVERY, outcome: "invalid_payload" },
      { at: "github.webhook", delivery: DELIVERY, outcome: "upstream_refused" },
      { at: "github.webhook", delivery: DELIVERY, outcome: "upstream_unavailable" },
    ]);
    for (const typed of TYPED) expect(lines.join("\n")).not.toContain(typed);
  });

  it("says upstream is unavailable when the API doesn't take it, and gives back nothing of the API's answer", async () => {
    for (const [api, expected] of [
      [async () => new Response('{"error":{"code":"invalid_assertion","message":"detail"}}', { status: 401 }), 502],
      [async () => new Response('{"error":{"code":"room_unavailable"}}', { status: 504 }), 504],
      [async () => new Response('{"ok":true}', { status: 200 }), 502],
      [async () => { throw new Error("down"); }, 502],
      [async () => { throw new DOMException("timed out", "TimeoutError"); }, 504],
    ] as const) {
      const { status, body } = await deliver(pullRequest(), { api: api as never });
      expect(status).toBe(expected);
      expect(body).toEqual({ error: { code: "upstream_unavailable", message: "upstream_unavailable" } });
    }
  });
});

describe("what a delivery is about", () => {
  it("takes a pull request's number and head commit", () => {
    expect(normalize("d1", DIGEST, "pull_request", pullRequest())).toEqual({ delivery_id: "d1", body_sha256: DIGEST, event: "pull_request", repository_id: REPO, pull_requests: [7], head_sha: HEAD });
    // The top-level number stands in when the pull request's own is missing, and a head that isn't a full commit ID is left out.
    expect(normalize("d1", DIGEST, "pull_request", { number: 9, pull_request: { head: { sha: "main" } }, repository: { id: REPO } })).toEqual({ delivery_id: "d1", body_sha256: DIGEST, event: "pull_request", repository_id: REPO, pull_requests: [9] });
    expect(normalize("d1", DIGEST, "pull_request", { pull_request: { number: -1 }, repository: { id: REPO } })).toBeNull();
  });

  it("takes a check run's commit, and only pull requests into this repository", () => {
    const run = { check_run: { name: "secret-check-name", status: "completed", conclusion: "failure", head_sha: HEAD, pull_requests: [
      { number: 7, base: { repo: { id: REPO } }, head: { ref: "feature/secret-branch" } },
      { number: 8, base: { repo: { id: 111 } } },
      { number: 7, base: { repo: { id: REPO } } },
      { number: "9", base: { repo: { id: REPO } } },
      null,
    ] }, repository: { id: REPO } };
    const nudge = normalize("d2", DIGEST, "check_run", run);
    expect(nudge).toEqual({ delivery_id: "d2", body_sha256: DIGEST, event: "check_run", repository_id: REPO, pull_requests: [7], head_sha: HEAD });
    expect(JSON.stringify(nudge)).not.toMatch(/secret|failure|completed/);
    // No more than ten numbers go on.
    const many = { check_run: { head_sha: HEAD, pull_requests: Array.from({ length: 40 }, (_, i) => ({ number: i + 1, base: { repo: { id: REPO } } })) }, repository: { id: REPO } };
    expect(normalize("d2", DIGEST, "check_run", many)?.pull_requests).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(normalize("d2", DIGEST, "check_run", { check_run: { head_sha: HEAD }, repository: { id: REPO } })).toEqual({ delivery_id: "d2", body_sha256: DIGEST, event: "check_run", repository_id: REPO, pull_requests: [], head_sha: HEAD });
  });

  it("takes a status's commit and not its state", () => {
    const nudge = normalize("d3", DIGEST, "status", { sha: HEAD, state: "success", context: "podster/review", description: "secret body text", target_url: "https://example.test/x", branches: [{ name: "feature/secret-branch" }], repository: { id: REPO } });
    expect(nudge).toEqual({ delivery_id: "d3", body_sha256: DIGEST, event: "status", repository_id: REPO, pull_requests: [], head_sha: HEAD });
    expect(normalize("d3", DIGEST, "status", { sha: "abc", repository: { id: REPO } })).toBeNull();
  });

  it("is null for anything else", () => {
    for (const payload of [null, undefined, 7, "x", [], {}, { repository: {} }, { repository: { id: 0 } }, { repository: { id: 1.5 } }, { repository: { id: Number.MAX_SAFE_INTEGER + 2 } }]) {
      expect(normalize("d", DIGEST, "pull_request", payload)).toBeNull();
    }
    expect(normalize("d", DIGEST, "push", pullRequest())).toBeNull();
  });
});

describe("through the whole gateway, to the real API", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const post = async (payload: unknown, over: { env?: object; host?: string; signature?: string | null; delivery?: string } = {}) => {
    const text = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": over.delivery ?? crypto.randomUUID() };
    const signature = over.signature === undefined ? await sign(text) : over.signature;
    if (signature) headers["x-hub-signature-256"] = signature;
    const res = await worker.fetch(new Request(`${over.host ?? BASE}${GITHUB_WEBHOOK_PATH}`, { method: "POST", headers, body: text }), { ...e, BASE_URL: BASE, GITHUB_WEBHOOK_SECRET: SECRET, ...(over.env ?? {}) } as never, ctx);
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  it("has the API take a signed delivery, for a repository no room has and for one a lookup row points somewhere empty", async () => {
    expect(await post(pullRequest())).toEqual({ status: 202, body: { accepted: true } });
    // A row that points at a room that was never made: the room drops it, and the answer is the same.
    await e.API_DB.prepare("INSERT INTO repo_room_index (provider, provider_repo_id, workspace_id) VALUES ('github', ?, 'ws_never_made')").bind(REPO + 1).run();
    expect(await post(pullRequest({ repository: { id: REPO + 1 } }))).toEqual({ status: 202, body: { accepted: true } });
  });

  it("refuses an unsigned or badly signed delivery, and everything while the secret is unset", async () => {
    expect((await post(pullRequest(), { signature: null })).status).toBe(401);
    expect((await post(pullRequest(), { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect((await post(pullRequest(), { env: { GITHUB_WEBHOOK_SECRET: undefined } })).status).toBe(404);
    // The test configuration, like every deployment today, sets no secret.
    expect(e.GITHUB_WEBHOOK_SECRET).toBeUndefined();
  });

  it("sits behind the per-client rate limit, like every other route", async () => {
    let asked = 0;
    const closed = { limit: async () => { asked += 1; return { success: false }; } };
    const limited = await post(pullRequest(), { env: { RL_GENERAL: closed } });
    expect(limited.status).toBe(429);
    expect(asked).toBe(1);
    // Signed or not, and before the signature is looked at.
    expect((await post(pullRequest(), { env: { RL_GENERAL: closed }, signature: null })).status).toBe(429);
    const open = { limit: async () => ({ success: true }) };
    expect((await post(pullRequest(), { env: { RL_GENERAL: open } })).status).toBe(202);
  });

  it("isn't served on the application host", async () => {
    const APP = "https://app.test";
    const answered = await post(pullRequest(), { host: APP, env: { APP_URL: APP } });
    expect(answered.status).not.toBe(202);
    expect(answered.status).toBeGreaterThanOrEqual(400);
  });
});
