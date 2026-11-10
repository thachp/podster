import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// M5 step 5: a provider's webhook delivery, from the API's one route for it to the room. The gateway has verified GitHub's
// signature by the time anything arrives here, and says so with an assertion that names no one. A delivery is a nudge: it
// marks a task's change as due a read of the provider and changes nothing else. Rows are written straight into the room
// where a test needs a link or a change, because nothing in the API can make one yet (steps 4 and 6 to 8).

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_pd_owner", kind: "person", org: "org_pd", adminOrgs: ["org_pd"] };
const ASSIGNEE: Who = { id: "agt_pd_assignee", org: "org_pd" };
const ROUTE = "/v1/provider/github/deliveries";
const HEAD = "a1".repeat(20);
const REVIEWED = "c3".repeat(20);
const DAY = 24 * 60 * 60 * 1000;

const now = () => Math.floor(Date.now() / 1000);
const signed = (claims: object, at = now()) => new SignJWT({ ...claims }).setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setAudience("podster-api").setIssuedAt(at).setExpirationTime(at + 60).setJti(crypto.randomUUID());
const identity = (who: Who) => {
  const isAgent = (who.kind ?? "agent") === "agent";
  return signed({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) }).setSubject(who.id).sign(key);
};
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await identity(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `pd-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

type Nudge = { delivery_id: string; body_sha256?: string; event: string; repository_id: number; pull_requests?: number[]; head_sha?: string | null; [extra: string]: unknown };
/** A body hash no other delivery has, as two different payloads would give. */
const bodyHash = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
const deliveryId = () => crypto.randomUUID();
let repoCounter = 500_000_000;
/** A repository ID no other test uses, so one test's routing row never points at another's room. */
const newRepo = () => ++repoCounter;

/** Sends what the gateway would: the nudge, and an assertion for exactly that body. `claims` and `assertion` let a test lie. */
async function deliver(nudge: Nudge | string, options: { claims?: object; assertion?: string | null; method?: string } = {}) {
  const text = typeof nudge === "string" ? nudge : JSON.stringify({ body_sha256: bodyHash(), ...nudge });
  const delivery = typeof nudge === "string" ? "d-raw" : nudge.delivery_id;
  const assertion = options.assertion === undefined
    ? await signed({ kind: "provider_delivery", provider: "github", delivery, body_sha256: await sha256(text), ...(options.claims ?? {}) }).sign(key)
    : options.assertion;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (assertion !== null) headers["x-podster-assertion"] = assertion;
  const res = await SELF.fetch(`https://api.internal${ROUTE}`, { method: options.method ?? "POST", headers, body: (options.method ?? "POST") === "GET" ? undefined : text });
  const answer = await res.text();
  const parsed = answer ? JSON.parse(answer) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${ASSIGNEE.id}`, { method: "PUT", headers: { "x-podster-assertion": await identity({ id: "per_pd_admin", kind: "person", org: ASSIGNEE.org, adminOrgs: [ASSIGNEE.org] }) }, body: JSON.stringify({ org_id: ASSIGNEE.org, name: ASSIGNEE.id }) });
  if (res.status !== 200) throw new Error(`register: ${res.status}`);
});
afterEach(() => vi.restoreAllMocks());

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const lookup = async (repo: number) => (await BINDINGS.DB.prepare("SELECT workspace_id FROM repo_room_index WHERE provider = 'github' AND provider_repo_id = ?").bind(repo).first())?.workspace_id ?? null;
const route = (repo: number, id: string) => BINDINGS.DB.prepare("INSERT OR REPLACE INTO repo_room_index (provider, provider_repo_id, workspace_id) VALUES ('github', ?, ?)").bind(repo, id).run();

/** A room with one task. `repo` gives it a linked repository, a change on that task for pull request 7, and its routing row. */
async function room(repo?: number, options: { routed?: boolean; change?: boolean } = {}) {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  const policy = (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
  expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: ASSIGNEE.id, kind: "agent", org_id: ASSIGNEE.org, role: "member", policy_version: policy })).status).toBe(200);
  const task: string = (await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Add the parser", instructions: "Write it.", assignee: ASSIGNEE.id })).body.id;
  if (repo !== undefined) {
    await inRoom(id, (sql) => {
      // Already marked as in the lookup, so the room's alarm leaves the row to the test.
      sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at, indexed_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterdev/engineering', 'public', 'main', 'ready', ?, 1000, 2000, 2000, 2000)", repo, OWNER.id);
      if (options.change !== false) sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, reviewed_commit_sha, created_at, updated_at) VALUES (?, ?, 7, 1, ?, 1000, 1000)", task, repo, REVIEWED);
    });
    if (options.routed !== false) await route(repo, id);
  }
  return { id, task };
}

const change = (id: string) => inRoom(id, (sql) => sql.exec("SELECT * FROM task_change").toArray()[0] ?? null);
const deliveries = (id: string) => inRoom(id, (sql) => sql.exec("SELECT delivery_id, body_sha256, received_at, expires_at FROM provider_delivery ORDER BY received_at, delivery_id").toArray() as { delivery_id: string; body_sha256: string; received_at: number; expires_at: number }[]);
/** Everything a command would have left behind. A nudge leaves none of it. The outbox empties on its own, and holds nothing without an event. */
const footprint = (id: string) => inRoom(id, (sql) => ({
  events: sql.exec("SELECT count(*) AS n FROM event").one().n,
  stored: sql.exec("SELECT count(*) AS n FROM idempotency").one().n,
  audit: sql.exec("SELECT count(*) AS n FROM audit_event").one().n,
}));
const UNTOUCHED = { observed_head_sha: null, head_observed_at: null, checks_state: null, checks_json: null, checks_observed_at: null, merge_state: "not_requested", merge_reason: null, merge_sha: null, merge_observed_at: null, pr_state: null, pr_observed_at: null, head_repo_id: null, base_ref: null, reviewed_commit_sha: REVIEWED, updated_at: 1000 };

describe("the delivery route's assertion", () => {
  it("takes only the gateway's delivery assertion, for exactly the body sent", async () => {
    const nudge = { delivery_id: deliveryId(), body_sha256: bodyHash(), event: "pull_request", repository_id: newRepo(), pull_requests: [7], head_sha: HEAD };
    expect(await deliver(nudge)).toEqual({ status: 202, body: { accepted: true }, code: undefined });
    // No assertion, an identity's, the public page's, one signed by another key, and one that has expired.
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const text = JSON.stringify(nudge);
    const claims = { kind: "provider_delivery", provider: "github", delivery: nudge.delivery_id, body_sha256: await sha256(text) };
    const refused: (string | null)[] = [
      null, "", "not.a.token",
      await identity(OWNER), await identity(ASSIGNEE),
      await signed({ kind: "public" }).sign(key),
      await signed(claims).sign(other.privateKey),
      await signed(claims, now() - 600).sign(key),
      // A subject or an organization doesn't belong on it.
      await signed(claims).setSubject(OWNER.id).sign(key),
      await signed({ ...claims, org: "org_pd" }).sign(key),
    ];
    for (const assertion of refused) {
      const answer = await deliver(nudge, { assertion });
      expect([answer.status, answer.code], String(assertion).slice(0, 30)).toEqual([401, "invalid_assertion"]);
    }
    // For another body, another provider, or no body hash at all.
    for (const lie of [{ body_sha256: await sha256(`${text} `) }, { body_sha256: "0".repeat(64) }, { provider: "gitlab" }, { provider: "" }, { body_sha256: undefined }]) {
      const answer = await deliver(nudge, { claims: lie });
      expect([answer.status, answer.code], JSON.stringify(lie)).toEqual([401, "invalid_assertion"]);
    }
  });

  it("is no use anywhere else", async () => {
    const text = "{}";
    const assertion = await signed({ kind: "provider_delivery", provider: "github", delivery: "d-1", body_sha256: await sha256(text) }).sign(key);
    for (const [method, path] of [["GET", "/v1/me"], ["GET", "/v1/workspaces"], ["POST", "/v1/workspaces"], ["GET", ROUTE], ["PUT", ROUTE], ["POST", `${ROUTE}/x`], ["POST", "/v1/provider/gitlab/deliveries"], ["POST", "/internal/provider-delivery"]] as const) {
      const res = await SELF.fetch(`https://api.internal${path}`, { method, headers: { "x-podster-assertion": assertion, "content-type": "application/json" }, body: method === "GET" ? undefined : text });
      expect([res.status, (await res.json() as any)?.error?.code], `${method} ${path}`).toEqual([401, "invalid_assertion"]);
    }
  });

  it("refuses a body that isn't a nudge, even with an assertion for it", async () => {
    const good = { delivery_id: "d-shape", body_sha256: bodyHash(), event: "pull_request", repository_id: newRepo(), pull_requests: [7], head_sha: HEAD };
    const bad: (object | string)[] = [
      "not json", "[]", "{}",
      // Anything beyond the six fields: a title can't ride along.
      { ...good, title: "Add the parser" }, { ...good, base_ref: "main" }, { ...good, state: "success" }, { ...good, merged: true },
      { ...good, event: "push" }, { ...good, event: "ping" }, { ...good, event: "" },
      { ...good, repository_id: 0 }, { ...good, repository_id: -5 }, { ...good, repository_id: "5" }, { ...good, repository_id: 1.5 },
      { ...good, pull_requests: [0] }, { ...good, pull_requests: Array.from({ length: 11 }, (_, i) => i + 1) }, { ...good, pull_requests: ["7"] },
      { ...good, head_sha: "main" }, { ...good, head_sha: HEAD.toUpperCase() }, { ...good, head_sha: HEAD.slice(1) },
      { ...good, pull_requests: [], head_sha: null },
      { ...good, delivery_id: "has spaces" }, { ...good, delivery_id: "x".repeat(65) },
      { ...good, body_sha256: "5E".repeat(32) }, { ...good, body_sha256: "5e".repeat(31) }, { ...good, body_sha256: undefined }, { ...good, body_sha256: 5 },
    ];
    for (const body of bad) {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const delivery = typeof body === "string" ? "d-shape" : (body as any).delivery_id;
      const answer = await deliver(text, { claims: { delivery } });
      expect([answer.status, answer.code], text.slice(0, 80)).toEqual([400, "invalid_argument"]);
    }
    // The assertion's delivery ID has to be the body's.
    expect((await deliver(good, { claims: { delivery: "d-other" } })).code).toBe("invalid_argument");
    // Too long to be a nudge at all: refused before it's parsed.
    const long = JSON.stringify({ ...good, pull_requests: [7], padding: "x".repeat(4000) });
    expect((await deliver(long, { claims: { delivery: "d-shape" } })).status).toBe(401);
  });
});

describe("a delivery as a nudge", () => {
  it("marks the change it names as due a read, records the delivery once, and takes nothing else from it", async () => {
    const repo = newRepo();
    const { id, task } = await room(repo);
    const before = await footprint(id);
    const first = deliveryId();
    const hash = bodyHash();
    const started = Date.now();
    expect(await deliver({ delivery_id: first, body_sha256: hash, event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD })).toEqual({ status: 202, body: { accepted: true }, code: undefined });
    const nudged = await change(id) as any;
    expect(nudged.task_id).toBe(task);
    expect(nudged.nudged_at).toBeGreaterThanOrEqual(started);
    expect(nudged.nudged_at).toBeLessThanOrEqual(Date.now());
    // The delivery's commit isn't recorded as the head, and nothing is marked merged, passing, open or closed.
    expect(nudged).toMatchObject(UNTOUCHED);
    // The delivery ID is kept for seven days.
    const [kept] = await deliveries(id);
    expect([kept.delivery_id, kept.body_sha256]).toEqual([first, hash]);
    expect(kept.expires_at - kept.received_at).toBe(7 * DAY);
    // No event, nobody told, no stored answer, no audit entry: nothing a participant sees has changed.
    expect(await footprint(id)).toEqual(before);
    // And the task is as it was.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${task}`)).body.task).toMatchObject({ id: task, status: "offered" });
  });

  it("changes nothing when a delivery ID comes again, or the same body under a new ID", async () => {
    const repo = newRepo();
    const { id } = await room(repo);
    const again = deliveryId();
    const hash = bodyHash();
    const nudge = { delivery_id: again, body_sha256: hash, event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD };
    expect((await deliver(nudge)).status).toBe(202);
    // As if a read had happened since, and the mark were older.
    await inRoom(id, (sql) => sql.exec("UPDATE task_change SET nudged_at = 5"));
    const kept = await deliveries(id);
    const replays = [
      nudge,
      // The same ID with other contents.
      { ...nudge, body_sha256: bodyHash(), pull_requests: [7, 8] },
      { delivery_id: again, body_sha256: bodyHash(), event: "status", repository_id: repo, head_sha: REVIEWED },
      // The signature doesn't cover the ID, so a captured body can come back under any number of new ones. It's the same delivery.
      { ...nudge, delivery_id: deliveryId() }, { ...nudge, delivery_id: deliveryId() }, { ...nudge, delivery_id: deliveryId() },
    ];
    for (const replay of replays) expect(await deliver(replay)).toEqual({ status: 202, body: { accepted: true }, code: undefined });
    expect((await change(id) as any).nudged_at).toBe(5);
    expect(await deliveries(id)).toEqual(kept);
    // A new delivery, with its own ID and body, about the same change is a new nudge.
    expect((await deliver({ ...nudge, delivery_id: deliveryId(), body_sha256: bodyHash() })).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(5);
    expect(await deliveries(id)).toHaveLength(2);
  });

  it("drops a delivery for a repository that isn't the room's, whatever the lookup says", async () => {
    const repo = newRepo();
    const other = newRepo();
    const { id } = await room(repo);
    // The lookup is wrong: it sends another repository's deliveries here.
    await route(other, id);
    expect(await deliver({ delivery_id: deliveryId(), event: "pull_request", repository_id: other, pull_requests: [7], head_sha: REVIEWED })).toEqual({ status: 202, body: { accepted: true }, code: undefined });
    expect((await change(id) as any).nudged_at).toBeNull();
    expect(await deliveries(id)).toEqual([]);
    // A room with no repository at all keeps nothing either.
    const bare = await room();
    await route(newRepo(), bare.id);
    const stray = repoCounter;
    expect((await deliver({ delivery_id: deliveryId(), event: "status", repository_id: stray, head_sha: HEAD })).status).toBe(202);
    expect(await deliveries(bare.id)).toEqual([]);
    // And a repository nothing points to reaches no room.
    expect((await deliver({ delivery_id: deliveryId(), event: "status", repository_id: newRepo(), head_sha: HEAD })).status).toBe(202);
    // A room that was never made stays empty: no state is created for it.
    const ghost = newRepo();
    await route(ghost, "ws_pd_never_made");
    expect((await deliver({ delivery_id: deliveryId(), event: "status", repository_id: ghost, head_sha: HEAD })).status).toBe(202);
    expect(await runInDurableObject(stub("ws_pd_never_made"), (_: any, state: any) => state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").one().n)).toBe(0);
  });

  it("keeps nothing of a delivery about a pull request or commit the room doesn't know", async () => {
    const repo = newRepo();
    const { id } = await room(repo);
    const sent: Nudge[] = [];
    for (const unknown of [
      { event: "pull_request", pull_requests: [8], head_sha: HEAD },
      { event: "check_run", pull_requests: [], head_sha: HEAD },
      { event: "status", head_sha: "d4".repeat(20) },
    ]) {
      const nudge = { delivery_id: deliveryId(), body_sha256: bodyHash(), repository_id: repo, ...unknown };
      sent.push(nudge);
      expect((await deliver(nudge)).status).toBe(202);
    }
    expect((await change(id) as any).nudged_at).toBeNull();
    // Not even its ID: a busy repository's checks and statuses for other commits can't fill the room.
    expect(await deliveries(id)).toEqual([]);
    // So when the room later holds that commit for a change, the same delivery coming again does nudge, once.
    await inRoom(id, (sql) => sql.exec("UPDATE task_change SET observed_head_sha = ?", HEAD));
    expect((await deliver(sent[1])).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(0);
    expect((await deliveries(id)).map((d) => d.delivery_id)).toEqual([sent[1].delivery_id]);
    // A room whose repository has no change on any task yet is the same.
    const fresh = newRepo();
    const empty = await room(fresh, { change: false });
    expect((await deliver({ delivery_id: deliveryId(), event: "pull_request", repository_id: fresh, pull_requests: [7], head_sha: HEAD })).status).toBe(202);
    expect(await change(empty.id)).toBeNull();
    expect(await deliveries(empty.id)).toEqual([]);
  });

  it("finds a change by a commit the room already holds for it, when the delivery names no pull request", async () => {
    const repo = newRepo();
    const { id } = await room(repo);
    // A status on the reviewed commit.
    expect((await deliver({ delivery_id: deliveryId(), event: "status", repository_id: repo, head_sha: REVIEWED })).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(0);
    // A check run on the head Podster last read, with no pull request listed.
    await inRoom(id, (sql) => sql.exec("UPDATE task_change SET nudged_at = NULL, observed_head_sha = ?", HEAD));
    expect((await deliver({ delivery_id: deliveryId(), event: "check_run", repository_id: repo, pull_requests: [], head_sha: HEAD })).status).toBe(202);
    const nudged = await change(id) as any;
    expect(nudged.nudged_at).toBeGreaterThan(0);
    expect(nudged.observed_head_sha).toBe(HEAD);
  });

  it("forgets a delivery after seven days", async () => {
    const repo = newRepo();
    const { id } = await room(repo);
    const old = deliveryId();
    const nudge = { delivery_id: old, body_sha256: bodyHash(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD };
    expect((await deliver(nudge)).status).toBe(202);
    // One second short of seven days, it's still a replay.
    await inRoom(id, (sql) => sql.exec("UPDATE provider_delivery SET received_at = received_at - ?, expires_at = expires_at - ?", 7 * DAY - 60_000, 7 * DAY - 60_000));
    await inRoom(id, (sql) => sql.exec("UPDATE task_change SET nudged_at = 5"));
    expect((await deliver(nudge)).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBe(5);
    // Seven days on. The next delivery clears it, and the same one is then new again: it costs one nudge and changes nothing else.
    await inRoom(id, (sql) => sql.exec("UPDATE provider_delivery SET received_at = received_at - 60000, expires_at = expires_at - 60000"));
    expect((await deliver(nudge)).status).toBe(202);
    const held = await deliveries(id);
    expect(held.map((d) => d.delivery_id)).toEqual([old]);
    expect(held[0].received_at).toBeGreaterThan(Date.now() - 60_000);
    expect(held[0].expires_at - held[0].received_at).toBe(7 * DAY);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(5);
    // The alarm clears old ones too, with no delivery arriving.
    await inRoom(id, (sql) => sql.exec("UPDATE provider_delivery SET expires_at = 1"));
    await runDurableObjectAlarm(stub(id));
    expect(await deliveries(id)).toEqual([]);
  });

  it("still nudges when it remembers as many deliveries as it keeps, and just doesn't remember that one", async () => {
    const repo = newRepo();
    const { id } = await room(repo);
    const count = () => inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM provider_delivery").one().n as number);
    await inRoom(id, (sql) => {
      sql.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO provider_delivery (delivery_id, body_sha256, received_at, expires_at) SELECT 'held-' || i, printf('%064x', i), ?, ? FROM n", Date.now(), Date.now() + 7 * DAY);
      sql.exec("UPDATE task_change SET nudged_at = 5");
    });
    const nudge = { delivery_id: deliveryId(), body_sha256: bodyHash(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD };
    // Full: the change is marked all the same. A nudge is never lost for want of room.
    expect((await deliver(nudge)).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(5);
    expect(await count()).toBe(10000);
    // It wasn't remembered, so it nudges again if it comes again. That costs at most one more read.
    await inRoom(id, (sql) => sql.exec("UPDATE task_change SET nudged_at = 5"));
    expect((await deliver(nudge)).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(5);
    // One the room does remember is still a replay, by its ID or by its body.
    await inRoom(id, (sql) => sql.exec("UPDATE task_change SET nudged_at = 5"));
    expect((await deliver({ ...nudge, delivery_id: "held-1", body_sha256: bodyHash() })).status).toBe(202);
    expect((await deliver({ ...nudge, delivery_id: deliveryId(), body_sha256: "0".repeat(63) + "2" })).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBe(5);
    // And one about nothing here is dropped as ever.
    expect((await deliver({ ...nudge, delivery_id: deliveryId(), body_sha256: bodyHash(), pull_requests: [99], head_sha: "d4".repeat(20) })).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBe(5);
    expect(await count()).toBe(10000);
    // One fewer, and the next is remembered.
    await inRoom(id, (sql) => sql.exec("DELETE FROM provider_delivery WHERE delivery_id = 'held-3'"));
    const next = deliveryId();
    expect((await deliver({ ...nudge, delivery_id: next, body_sha256: bodyHash() })).status).toBe(202);
    expect(await count()).toBe(10000);
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM provider_delivery WHERE delivery_id = ?", next).one().n)).toBe(1);
  });

  it("logs the delivery ID, the room's ID and a fixed code", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const repo = newRepo();
    const { id } = await room(repo);
    lines.length = 0;
    const first = deliveryId();
    const nudge = { delivery_id: first, body_sha256: bodyHash(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD };
    await deliver(nudge);
    await deliver(nudge);
    const unknown = deliveryId();
    await deliver({ ...nudge, delivery_id: unknown, body_sha256: bodyHash(), pull_requests: [9], head_sha: "e5".repeat(20) });
    const nowhere = deliveryId();
    await deliver({ ...nudge, delivery_id: nowhere, body_sha256: bodyHash(), repository_id: newRepo() });
    await deliver({ ...nudge, title: "SECRET-TITLE", delivery_id: deliveryId() });
    await deliver(nudge, { assertion: "SECRET-TITLE" });
    const logged = lines.filter((line) => line.includes("provider.delivery")).map((line) => JSON.parse(line));
    expect(logged).toEqual([
      { at: "provider.delivery", delivery: first, room: id, outcome: "nudged" },
      { at: "provider.delivery", delivery: first, room: id, outcome: "replayed" },
      { at: "provider.delivery", delivery: unknown, room: id, outcome: "unknown_change" },
      { at: "provider.delivery", delivery: nowhere, outcome: "no_room" },
    ]);
    // Nothing else these requests logged says more: no commit, no repository name, no body.
    for (const line of lines) for (const text of ["SECRET-TITLE", HEAD, "e5".repeat(20), "podsterdev", "Add the parser", nudge.body_sha256]) expect(line).not.toContain(text);
  });
});

/** As provisioning will leave a new link: not in the lookup yet. A command arms the room's alarm, as provisioning's will, and the alarm writes the row. */
async function indexed(id: string) {
  await inRoom(id, (sql) => sql.exec("UPDATE repo_link SET indexed_at = NULL"));
  const policy = (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
  expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/name`, { name: "Engineering two", policy_version: policy })).status).toBe(200);
  for (let i = 0; i < 40; i++) {
    await runDurableObjectAlarm(stub(id));
    const at = await inRoom(id, (sql) => sql.exec("SELECT indexed_at FROM repo_link").one().indexed_at as number | null);
    if (at !== null) return at;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the room never wrote its routing row");
}

describe("the routing lookup", () => {
  it("gets a room's row once its link exists, from the room's alarm, and never authorizes", async () => {
    const repo = newRepo();
    const { id } = await room(repo, { routed: false });
    expect(await lookup(repo)).toBeNull();
    // Unrouted, a delivery reaches no room.
    expect((await deliver({ delivery_id: deliveryId(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD })).status).toBe(202);
    expect(await deliveries(id)).toEqual([]);
    expect(await indexed(id)).toBeGreaterThan(0);
    expect(await lookup(repo)).toBe(id);
    expect((await deliver({ delivery_id: deliveryId(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD })).status).toBe(202);
    expect((await change(id) as any).nudged_at).toBeGreaterThan(0);
    // The row holds IDs and nothing else.
    expect(await BINDINGS.DB.prepare("SELECT * FROM repo_room_index WHERE provider_repo_id = ?").bind(repo).first()).toEqual({ provider: "github", provider_repo_id: repo, workspace_id: id });
  });

  it("leaves a repository with the room that has it, when a second room says it's theirs", async () => {
    const repo = newRepo();
    const first = await room(repo, { routed: false });
    expect(await indexed(first.id)).toBeGreaterThan(0);
    const second = await room(repo, { routed: false });
    // Marked as refused, with a zero, so the alarm doesn't try forever.
    expect(await indexed(second.id)).toBe(0);
    expect(await lookup(repo)).toBe(first.id);
    expect((await deliver({ delivery_id: deliveryId(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD })).status).toBe(202);
    expect((await change(first.id) as any).nudged_at).toBeGreaterThan(0);
    expect((await change(second.id) as any).nudged_at).toBeNull();
  });
});

describe("the delivery migration", () => {
  it("adds the delivery table and two columns to a room made before it, and keeps what the room held", async () => {
    const repo = newRepo();
    const { id, task } = await room(repo);
    const version = () => inRoom(id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    const columns = (table: string) => inRoom(id, (sql) => sql.exec(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).toArray().map((c: any) => c.name));
    const newest = await version();
    // Back to the release before this one.
    await inRoom(id, (sql) => {
      sql.exec("DROP TABLE provider_delivery");
      sql.exec("ALTER TABLE task_change DROP COLUMN nudged_at");
      sql.exec("ALTER TABLE repo_link DROP COLUMN indexed_at");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect(await columns("provider_delivery")).toEqual([]);
    // A delivery migrates the room, as any request does.
    expect((await deliver({ delivery_id: deliveryId(), event: "pull_request", repository_id: repo, pull_requests: [7], head_sha: HEAD })).status).toBe(202);
    expect(await version()).toBe(newest);
    expect(await columns("provider_delivery")).toEqual(["delivery_id", "body_sha256", "received_at", "expires_at"]);
    expect((await columns("task_change")).at(-1)).toBe("nudged_at");
    expect((await columns("repo_link")).at(-1)).toBe("indexed_at");
    // The link and the change are as they were, and the delivery that migrated it was taken.
    const kept = await change(id) as any;
    expect(kept).toMatchObject({ task_id: task, provider_repo_id: repo, pr_number: 7, reviewed_commit_sha: REVIEWED });
    expect(kept.nudged_at).toBeGreaterThan(0);
    // The new column starts empty, and the room's alarm may already have written its routing row and filled it in.
    expect(await inRoom(id, (sql) => sql.exec("SELECT provider_repo_id, status FROM repo_link").one())).toEqual({ provider_repo_id: repo, status: "ready" });
    // It doesn't run twice.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect(await version()).toBe(newest);
    expect(await deliveries(id)).toHaveLength(1);
  });
});
