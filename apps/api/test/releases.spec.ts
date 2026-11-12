import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// M6 step 2 (ADR 0010): release's contract and state, and nothing that deploys, routes or serves. Every M6 route answers
// as a missing one while release is switched off, which is everywhere, and `release_not_available` where a test switches
// it on. The room's tables and the hostname-claim object hold state that nothing writes yet, so rows are written
// straight in where a test needs one.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_rl_owner", kind: "person", org: "org_rl", adminOrgs: ["org_rl"] };
const AGENT: Who = { id: "agt_rl_agent", org: "org_rl" };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_rl_ops" };
const MEMBER: Who = { id: "agt_rl_member", org: "org_rl" };
const REVOKED: Who = { id: "agt_rl_revoked", org: "org_rl" };
const OUTSIDER: Who = { id: "per_rl_outsider", kind: "person", org: "org_rl_other", adminOrgs: ["org_rl_other"] };
/** An admin of the room's organization who was never put in the room. */
const ORG_ADMIN: Who = { id: "per_rl_org_admin", kind: "person", org: "org_rl", adminOrgs: ["org_rl"] };

async function assertion(who: Who | "public") {
  const now = Math.floor(Date.now() / 1000);
  if (who === "public") {
    return new SignJWT({ kind: "public" }).setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject("public").setAudience("podster-api")
      .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
  }
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who | "public" | null, method: string, path: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers["x-podster-assertion"] = await assertion(who);
  if (method !== "GET") headers["idempotency-key"] = `rl-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : raw ?? JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text, headers: [...res.headers.entries()].sort() };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, MEMBER, REVOKED]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const claimStub = (hostname: string) => BINDINGS.HOSTNAME_CLAIM.get(BINDINGS.HOSTNAME_CLAIM.idFromName(hostname));
const inClaim = <T>(hostname: string, fn: (sql: any) => T) => runInDurableObject(claimStub(hostname), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const refuses = (run: () => unknown) => { try { run(); return false; } catch { return true; } };

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const REL = `rel_${"a1".repeat(16)}`;
/** Every M6 operation the contract lists, with whose it is. */
const M6: Record<string, "person" | "operator"> = {
  getReleaseConfig: "person", setReleaseConfig: "person", approveRelease: "person", declineRelease: "person", getAppHostname: "person", requestAppHostname: "person", removeAppHostname: "person",
  createAppReport: "person", suspendApp: "operator", liftAppSuspension: "operator", suspendAppHost: "operator", liftAppHostSuspension: "operator",
  stopContentDomain: "operator", resumeContentDomain: "operator",
};
const contract = () => (JSON.parse(BINDINGS.TEST_API_ROUTES) as { path: string; method: string; operation: string }[]).filter((route) => route.operation in M6);
const fill = (path: string, room: string) => path.replace("{ws}", room).replace("{release}", REL).replace("{label}", "k3v9q2").replace("{host}", "app.example.com");

describe("M6's routes, none of them built", () => {
  it("are exactly the ones the contract lists, and name no capability an agent could be given", () => {
    expect(contract().map((route) => route.operation).sort()).toEqual(Object.keys(M6).sort());
    // No deploy_release and nothing new on the release status: each arrives with its step (AC-17).
    const all: { path: string; operation: string }[] = JSON.parse(BINDINGS.TEST_API_ROUTES);
    expect(all.filter((route) => /deploy/i.test(route.path + route.operation))).toEqual([]);
  });

  it("can't be told from a path nobody defined while release is switched off, by anyone", async () => {
    const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
    const version = async () => (await api(OWNER, "GET", `/v1/workspaces/${room}`)).body.policy_version;
    for (const who of [MEMBER, REVOKED]) expect((await api(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role: "member", policy_version: await version() })).status, who.id).toBe(200);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${room}/members/${REVOKED.id}`, { policy_version: await version() })).status).toBe(200);
    const missing = `ws_${"0".repeat(32)}`;
    // What an unknown path answers each of them, so the comparison below isn't of one answer with itself.
    const expected: [string, Who, string, string | undefined, [number, string]][] = [
      ["the owner", OWNER, room, undefined, [404, "not_found"]],
      ["a member", MEMBER, room, undefined, [404, "not_found"]],
      ["a member, with a body that isn't JSON", MEMBER, room, "{", [400, "invalid_argument"]],
      ["someone outside the room", OUTSIDER, room, undefined, [404, "workspace_not_found"]],
      ["a room that doesn't exist", OWNER, missing, undefined, [404, "workspace_not_found"]],
      ["a removed member", REVOKED, room, undefined, [403, "access_revoked"]],
      ["an operator", OPERATOR, room, undefined, [404, "workspace_not_found"]],
      ["an admin of the room's organization", ORG_ADMIN, room, undefined, [404, "workspace_not_found"]],
    ];
    const seen = new Set<string>();
    for (const route of contract()) {
      const roomRoute = route.path.startsWith("/v1/workspaces/");
      for (const [what, who, where, raw, roomAnswer] of expected) {
        const path = fill(route.path, where);
        // The neighbour: the same path with one more character on its last segment, which no route has.
        const [real, unknown] = [await api(who, route.method, path, { reason: "abuse" }, raw), await api(who, route.method, `${path}x`, { reason: "abuse" }, raw)];
        expect([real.status, real.text, real.headers], `${route.operation} for ${what}`).toEqual([unknown.status, unknown.text, unknown.headers]);
        // A GET sends no body, so a malformed one can't be told from none. Outside a room, an unknown path is the Worker's.
        const want = !roomRoute ? [404, "not_found"] : raw && route.method === "GET" ? [404, "not_found"] : roomAnswer;
        expect([real.status, real.code], `${route.operation} for ${what}`).toEqual(want);
        seen.add(`${real.status} ${real.code}`);
      }
      // No assertion, and the public page's assertion, are refused as on any route.
      expect((await api(null, route.method, fill(route.path, room))).code, route.operation).toBe("invalid_assertion");
      expect((await api("public", route.method, fill(route.path, room))).code, route.operation).toBe("invalid_assertion");
    }
    expect([...seen].sort()).toEqual(["400 invalid_argument", "403 access_revoked", "404 not_found", "404 workspace_not_found"]);
  });

  it("switched on, refuse an agent and a non-operator, and otherwise say release isn't available", async () => {
    const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
    await switchedOn(async () => {
      for (const route of contract()) {
        const path = fill(route.path, room);
        const as = async (who: Who) => { const answer = await api(who, route.method, path, { reason: "abuse" }); return [answer.status, answer.code]; };
        expect(await as(AGENT), `${route.operation} as an agent`).toEqual([403, "not_allowed"]);
        expect(await as(OPERATOR), `${route.operation} as an operator`).toEqual([409, "release_not_available"]);
        expect(await as(OWNER), `${route.operation} as the owner`).toEqual(M6[route.operation] === "operator" ? [403, "not_allowed"] : [409, "release_not_available"]);
      }
      // A neighbouring path the contract doesn't list is no M6 route: the room answers it as it always did.
      expect((await api(OWNER, "GET", `/v1/workspaces/${room}/releases`)).code).toBe("not_found");
      expect((await api(OPERATOR, "POST", "/v1/moderation/apps/k3v9q2/delete", { reason: "abuse" })).code).toBe("not_found");
    });
    // Off again once the test's table is gone.
    expect((await api(OWNER, "GET", `/v1/workspaces/${room}/release-config`)).code).toBe("not_found");
  });

  it("change nothing in the room, switched on or off", async () => {
    const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
    const counts = () => inRoom(room, (sql) => ["release_config", "release", "app_label", "serve_state", "hostname_request", "unpublish", "event", "outbox"].map((table) => sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n));
    const before = await counts();
    await switchedOn(async () => {
      await api(OWNER, "PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 });
      await api(OWNER, "PUT", `/v1/workspaces/${room}/app-hostname`, { hostname: "app.example.com" });
      await api(OWNER, "POST", `/v1/workspaces/${room}/releases/${REL}/approve`);
    });
    expect(await counts()).toEqual(before);
    expect(before.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("the room's release state (M6 step 2)", () => {
  const LABEL = "k3v9q2";
  const OLD = `rel_${"b2".repeat(16)}`;
  const scriptOf = (release: string, label = LABEL) => `${label}.${release}`;
  const newRoom = async () => (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id as string;
  const run = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => refuses(() => sql.exec(query, ...values)));
  const one = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).one());
  const label = (room: string, name = LABEL, current: number | null = 1, retired: number | null = null) => run(room, "INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, ?, 1, ?)", name, current, retired);
  const release = (room: string, id: string, extra: Record<string, unknown> = {}) => inRoom(room, (sql) => refuses(() => {
    const row = { id, commit_sha: "c".repeat(40), state: "awaiting_approval", label: LABEL, config_version: 1, release_epoch: 0, requested_by: "per_rl_owner", requested_at: 1, updated_at: 1, ...extra };
    sql.exec(`INSERT INTO release (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
  }));
  const config = (room: string) => run(room, "INSERT INTO release_config (singleton, set_by, set_at, updated_at) VALUES (1, 'per_rl_owner', 1, 1)");
  const id = (n: number) => `rel_${n.toString(16).padStart(32, "0")}`;

  it("holds one configuration: a person approves, one environment, and an epoch and version that only count up from 0 and 1", async () => {
    const room = await newRoom();
    expect(await config(room)).toBe(false);
    expect(await one(room, "SELECT * FROM release_config")).toMatchObject({ enabled: 0, approval_policy: "person", environments_json: '["production"]', version: 1, release_epoch: 0, kept_previous: null, in_flight_release: null, in_flight_script: null, in_flight_epoch: null });
    expect(await run(room, "INSERT INTO release_config (singleton, set_by, set_at, updated_at) VALUES (2, 'per_rl_owner', 1, 1)")).toBe(true);
    for (const bad of ["approval_policy = 'on_merge'", "enabled = 2", "release_epoch = -1", "version = 0", "version = -1", "in_flight_epoch = -1",
      `environments_json = '["preview","x"]'`, `environments_json = '["preview"]'`, "environments_json = '[]'", `environments_json = '["production","preview"]'`]) {
      expect(await run(room, `UPDATE release_config SET ${bad}`), bad).toBe(true);
    }
  });

  it("keeps a label to 26 lower-case letters and digits, one current at a time, never used twice, with the app's suspension", async () => {
    const room = await newRoom();
    expect(await label(room, "a".repeat(26))).toBe(false);
    for (const bad of ["a".repeat(27), "", "Abc", "a_b", "a.b", "a-b", "é"]) expect(await label(room, bad, null, 2), JSON.stringify(bad)).toBe(true);
    // A second current label is refused, and so is one that is neither current nor retired, or both.
    expect(await label(room, "second")).toBe(true);
    expect(await label(room, "neither", null, null)).toBe(true);
    expect(await label(room, "both", 1, 2)).toBe(true);
    // Retired, a label stays in the table, so the same room can't take it again.
    await inRoom(room, (sql) => sql.exec("UPDATE app_label SET current = NULL, retired_at = 2"));
    expect(await label(room, "a".repeat(26))).toBe(true);
    expect(await label(room, "second")).toBe(false);
    // An operator's suspension of the app is the room's state, kept with the label: a time and a reason, or neither.
    expect(await run(room, "UPDATE app_label SET suspended_at = 5 WHERE label = 'second'")).toBe(true);
    expect(await run(room, "UPDATE app_label SET suspension_reason = 'abuse' WHERE label = 'second'")).toBe(true);
    expect(await run(room, "UPDATE app_label SET suspended_at = 5, suspension_reason = 'abuse' WHERE label = 'second'")).toBe(false);
  });

  it("keeps a release's ID, commit and label in their forms, its label one of the room's own, and its counters from 0 and 1", async () => {
    const room = await newRoom();
    const LONG = "a".repeat(26);
    await label(room, LONG);
    // The longest name the rule allows: a 26-character label, a `.`, and the 36-character ID.
    expect(scriptOf(REL, LONG)).toHaveLength(63);
    expect(await release(room, REL, { label: LONG, script_name: scriptOf(REL, LONG), script_release_id: REL })).toBe(false);
    expect(await release(room, REL, { label: LONG })).toBe(true);
    for (const bad of [`rel_${"a1".repeat(15)}`, `rel_${"A1".repeat(16)}`, `rel_${"g1".repeat(16)}`, `tsk_${"a1".repeat(16)}`, `rel_${"a1".repeat(16)}0`]) expect(await release(room, bad, { label: LONG }), bad).toBe(true);
    expect(await release(room, OLD, { label: LONG, environment: "preview" })).toBe(true);
    for (const bad of ["c".repeat(39), "c".repeat(41), "C".repeat(40), "g".repeat(40), "main"]) expect(await release(room, OLD, { label: LONG, commit_sha: bad }), bad).toBe(true);
    // A label the room doesn't hold, and one out of form.
    expect(await release(room, OLD, { label: LABEL })).toBe(true);
    for (const bad of ["Abc", "a".repeat(27), "a.b", ""]) expect(await release(room, OLD, { label: bad }), JSON.stringify(bad)).toBe(true);
    for (const bad of [{ release_epoch: -1 }, { config_version: 0 }, { config_version: -1 }]) expect(await release(room, OLD, { label: LONG, ...bad }), JSON.stringify(bad)).toBe(true);
    expect((await one(room, "SELECT environment FROM release WHERE id = ?", REL)).environment).toBe("production");
  });

  it("names the script a release serves: its own, or for a rollback an earlier release's of this room, under the room's label", async () => {
    const room = await newRoom();
    await label(room);
    expect(await release(room, OLD, { script_name: scriptOf(OLD), script_release_id: OLD })).toBe(false);
    // A rollback is its own release, serving the kept script, which names the earlier release.
    expect(await release(room, REL, { script_name: scriptOf(OLD), script_release_id: OLD })).toBe(false);
    expect(await one(room, "SELECT id, script_name, script_release_id FROM release WHERE id = ?", REL)).toEqual({ id: REL, script_name: scriptOf(OLD), script_release_id: OLD });
    const other = id(7);
    // A script of a release this room never had, of another label, with another separator, or with only half of it said.
    expect(await release(room, other, { script_name: scriptOf(id(8)), script_release_id: id(8) })).toBe(true);
    expect(await release(room, other, { script_name: scriptOf(OLD, "other"), script_release_id: OLD })).toBe(true);
    expect(await release(room, other, { script_name: `${LABEL}_${OLD}`, script_release_id: OLD })).toBe(true);
    expect(await release(room, other, { script_name: `${scriptOf(OLD)}x`, script_release_id: OLD })).toBe(true);
    expect(await release(room, other, { script_name: scriptOf(OLD) })).toBe(true);
    expect(await release(room, other, { script_release_id: OLD })).toBe(true);
    expect(await release(room, other, { script_name: scriptOf(REL), script_release_id: OLD })).toBe(true);
  });

  it("won't call a release live or served without its script and its approver, and keeps who approved or declined it", async () => {
    const core = JSON.parse(BINDINGS.TEST_CORE_SETS) as { releaseStates: string[]; servingReleaseStates: string[] };
    expect(core.servingReleaseStates).toEqual(["live", "served"]);
    const room = await newRoom();
    await label(room);
    let n = 0;
    const scripted = (release_id: string) => ({ script_name: scriptOf(release_id), script_release_id: release_id });
    const approved = { approved_by: "per_rl_owner", approved_at: 2 };
    for (const state of core.releaseStates) {
      const serving = core.servingReleaseStates.includes(state);
      const [bare, noApprover, noScript, whole] = [id(++n), id(++n), id(++n), id(++n)];
      expect(await release(room, bare, { state }), `${state}, bare`).toBe(serving);
      expect(await release(room, noApprover, { state, ...scripted(noApprover) }), `${state}, no approver`).toBe(serving);
      expect(await release(room, noScript, { state, ...approved }), `${state}, no script`).toBe(serving);
      expect(await release(room, whole, { state, ...approved, ...scripted(whole) }), `${state}, whole`).toBe(false);
    }
    // Who and when go together, and a release is never both approved and declined.
    expect(await release(room, id(++n), { approved_by: "per_rl_owner" })).toBe(true);
    expect(await release(room, id(++n), { declined_at: 2 })).toBe(true);
    expect(await release(room, id(++n), { state: "declined", declined_by: "per_rl_owner", declined_at: 2 })).toBe(false);
    expect(await release(room, id(++n), { ...approved, declined_by: "per_rl_owner", declined_at: 3 })).toBe(true);
  });

  it("holds what each host should serve: one default host, never closed; a script of the room's own label and release, or nothing", async () => {
    const room = await newRoom();
    await label(room);
    await release(room, REL);
    const host = (name: string, kind: string, extra: Record<string, unknown> = {}) => inRoom(room, (sql) => refuses(() => {
      const row = { host: name, kind, updated_at: 1, ...extra };
      sql.exec(`INSERT INTO serve_state (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
    }));
    const serving = { label: LABEL, release_id: REL, script_name: scriptOf(REL) };
    expect(await host(LABEL, "default", serving)).toBe(false);
    expect(await host("app.example.com", "custom")).toBe(false);
    expect(await one(room, "SELECT version, closed, flight_version, flight_before FROM serve_state WHERE host = ?", LABEL)).toEqual({ version: 1, closed: 0, flight_version: null, flight_before: null });
    // One default host, and it is never closed.
    expect(await host("second", "default")).toBe(true);
    expect(await run(room, "UPDATE serve_state SET closed = 1 WHERE kind = 'default'")).toBe(true);
    expect(await host("other", "preview")).toBe(true);
    // A custom host can be closed, and then it names nothing.
    expect(await run(room, "UPDATE serve_state SET closed = 1 WHERE kind = 'custom'")).toBe(false);
    expect(await run(room, "UPDATE serve_state SET label = ?, release_id = ?, script_name = ? WHERE kind = 'custom'", LABEL, REL, scriptOf(REL))).toBe(true);
    expect(await run(room, "UPDATE serve_state SET closed = 2 WHERE kind = 'custom'")).toBe(true);
    await inRoom(room, (sql) => sql.exec("DELETE FROM serve_state WHERE kind = 'custom'"));
    // A script under a label the room doesn't own, of a release it never had, misnamed, or half said.
    expect(await host("c1.example.com", "custom", { label: "nolabel", release_id: REL, script_name: scriptOf(REL, "nolabel") })).toBe(true);
    expect(await host("c1.example.com", "custom", { label: LABEL, release_id: OLD, script_name: scriptOf(OLD) })).toBe(true);
    for (const bad of [`${LABEL}_${REL}`, scriptOf(OLD), `${scriptOf(REL)}x`, REL]) expect(await host("c1.example.com", "custom", { ...serving, script_name: bad }), bad).toBe(true);
    for (const missing of ["label", "release_id", "script_name"]) expect(await host("c1.example.com", "custom", { ...serving, [missing]: null }), missing).toBe(true);
    for (const bad of ["version = 0", "version = -1", "flight_version = 0", "flight_version = -3", "flight_before = 'k3v9q2'"]) expect(await run(room, `UPDATE serve_state SET ${bad}`), bad).toBe(true);
    expect(await host("c1.example.com", "custom", serving)).toBe(false);
  });

  it("can hold the one commit in flight: its release, its script and epoch with the room, and what it wrote and found on each host", async () => {
    const room = await newRoom();
    await label(room);
    await config(room);
    await release(room, OLD, { script_name: scriptOf(OLD), script_release_id: OLD });
    await release(room, REL, { script_name: scriptOf(REL), script_release_id: REL });
    await inRoom(room, (sql) => sql.exec("INSERT INTO serve_state (host, kind, label, release_id, script_name, updated_at) VALUES (?, 'default', ?, ?, ?, 1)", LABEL, LABEL, REL, scriptOf(REL)));
    const set = (assignments: string, ...values: unknown[]) => run(room, `UPDATE release_config SET ${assignments}`, ...values);
    // A flight has its release, its script and the epoch its commit wrote, or none of them.
    expect(await set("in_flight_script = ?", scriptOf(REL))).toBe(true);
    expect(await set("in_flight_epoch = 3")).toBe(true);
    expect(await set("in_flight_release = ?", REL)).toBe(true);
    expect(await set("in_flight_script = ?, in_flight_epoch = 3", scriptOf(REL))).toBe(true);
    expect(await set("in_flight_release = ?, in_flight_script = ?, in_flight_epoch = 3, kept_previous = ?", REL, scriptOf(REL), scriptOf(OLD))).toBe(false);
    // A rollback in flight: its own release, and the kept script, which names the earlier one.
    expect(await set("in_flight_release = ?, in_flight_script = ?", REL, scriptOf(OLD))).toBe(false);
    // The flight's release is one of the room's.
    expect(await set("in_flight_release = ?", id(9))).toBe(true);
    for (const bad of [LABEL, `${LABEL}_${REL}`, `K3.${REL}`, `${LABEL}.rel_${"zz".repeat(16)}`, `${"a".repeat(27)}.${REL}`]) {
      expect(await set("kept_previous = ?", bad), bad).toBe(true);
      expect(await set("in_flight_script = ?", bad), bad).toBe(true);
    }
    // The commit wrote version 2 to the default host, which served the earlier script.
    expect(await run(room, "UPDATE serve_state SET flight_version = 2, flight_before = ?", scriptOf(OLD))).toBe(false);
    // The flight ends: everything it held is cleared.
    expect(await set("in_flight_release = NULL, in_flight_script = NULL, in_flight_epoch = NULL")).toBe(false);
    expect(await run(room, "UPDATE serve_state SET flight_version = NULL, flight_before = NULL")).toBe(false);
  });

  it("records each unpublish with the epoch it raised to, once", async () => {
    const room = await newRoom();
    await label(room);
    const add = (epoch: number, of: string | null) => run(room, "INSERT INTO unpublish (cause, label, release_epoch, at) VALUES ('release_off', ?, ?, 1)", of, epoch);
    expect(await add(1, LABEL)).toBe(false);
    // A room with no app yet can still record a trigger, and each epoch has one. An unpublish raises the epoch, so never to 0.
    expect(await add(2, null)).toBe(false);
    expect(await add(2, LABEL)).toBe(true);
    expect(await add(3, "nolabel")).toBe(true);
    expect(await add(0, LABEL)).toBe(true);
    expect(await add(-1, LABEL)).toBe(true);
    expect((await one(room, "SELECT scripts_gone_at FROM unpublish WHERE release_epoch = 1")).scripts_gone_at).toBeNull();
  });

  const CHALLENGE = "5e".repeat(32);
  const request = (room: string, n: number, extra: Record<string, unknown> = {}) => inRoom(room, (sql) => refuses(() => {
    const row = { id: `hnr_${n}`, hostname: "app.example.com", state: "pending", open: 1, challenge: CHALLENGE, generation: 0, requested_by: "per_rl_owner", requested_at: 1, expires_at: 2, updated_at: 1, ...extra };
    sql.exec(`INSERT INTO hostname_request (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
  }));

  it("takes exactly the rules' own names for a release's state, a hostname request's state and an unpublish's cause", async () => {
    const core = JSON.parse(BINDINGS.TEST_CORE_SETS) as { releaseStates: string[]; servingReleaseStates: string[]; hostnameRequestStates: string[]; openHostnameRequestStates: string[]; unpublishCauses: string[] };
    expect(core.releaseStates).toContain("awaiting_approval");
    expect(core.unpublishCauses).toContain("repo_not_ready");
    const room = await newRoom();
    await label(room);
    let n = 0;
    const whole = (release_id: string) => ({ approved_by: "per_rl_owner", approved_at: 2, script_name: scriptOf(release_id), script_release_id: release_id });
    for (const state of core.releaseStates) { const at = id(++n); expect(await release(room, at, { state, ...whole(at) }), state).toBe(false); }
    // The names an earlier draft of the contract had, another casing, and nothing at all.
    for (const state of ["waiting_for_approval", "deploying", "ended", "Live", "LIVE", "", "pending"]) { const at = id(++n); expect(await release(room, at, { state, ...whole(at) }), JSON.stringify(state)).toBe(true); }
    for (const state of core.hostnameRequestStates) {
      const open = core.openHostnameRequestStates.includes(state);
      await inRoom(room, (sql) => sql.exec("DELETE FROM hostname_request"));
      // Open exactly in the states the rules call open: the other way round is refused.
      expect(await request(room, ++n, { state, open: open ? null : 1 }), `${state}, the other way`).toBe(true);
      expect(await request(room, ++n, { state, open: open ? 1 : null }), state).toBe(false);
    }
    await inRoom(room, (sql) => sql.exec("DELETE FROM hostname_request"));
    for (const state of ["active", "Pending", "", "live"]) expect(await request(room, ++n, { state, open: null }), JSON.stringify(state)).toBe(true);
    const unpublish = (epoch: number, cause: string) => run(room, "INSERT INTO unpublish (cause, release_epoch, at) VALUES (?, ?, 1)", cause, epoch);
    for (const cause of core.unpublishCauses) expect(await unpublish(++n, cause), cause).toBe(false);
    for (const cause of ["ReleaseOffInRoom", "release_off_in_room", "", "other"]) expect(await unpublish(++n, cause), JSON.stringify(cause)).toBe(true);
  });

  it("lets a room have one open hostname request, and keeps the ended ones", async () => {
    const room = await newRoom();
    expect(await request(room, 1)).toBe(false);
    expect(await request(room, 2)).toBe(true);
    expect(await request(room, 2, { open: 2 })).toBe(true);
    await inRoom(room, (sql) => sql.exec("UPDATE hostname_request SET state = 'expired', open = NULL"));
    expect(await request(room, 2)).toBe(false);
    expect(await request(room, 3, { state: "ended", open: null })).toBe(false);
    expect((await one(room, "SELECT COUNT(*) AS n FROM hostname_request")).n).toBe(3);
  });

  it("keeps a request's hostname and challenge in their forms, the generation it was made under, and its proof history", async () => {
    const room = await newRoom();
    let n = 0;
    const closed = { state: "ended", open: null };
    // The generation is the name's own when the request was made: a request can't be stored without one.
    expect(await inRoom(room, (sql) => refuses(() => sql.exec("INSERT INTO hostname_request (id, hostname, state, challenge, requested_by, requested_at, expires_at, updated_at) VALUES ('hnr_none', 'app.example.com', 'ended', ?, 'per_rl_owner', 1, 2, 1)", CHALLENGE)))).toBe(true);
    expect(await request(room, ++n, { ...closed, generation: -1 })).toBe(true);
    expect(await request(room, ++n, { ...closed, generation: 7 })).toBe(false);
    for (const bad of ["App.Example.com", "example", "a.b", ".example.com", "example.com.", "app..example.com", "*.example.com", "app_x.example.com", "app example.com", "", `${"a".repeat(250)}.com`]) expect(await request(room, ++n, { ...closed, hostname: bad }), JSON.stringify(bad)).toBe(true);
    for (const good of ["xn--bcher-kva.example", `${"a".repeat(249)}.com`, "a-1.b2.example.co.uk"]) expect(await request(room, ++n, { ...closed, hostname: good }), good).toBe(false);
    for (const bad of ["5e".repeat(31), "5e".repeat(33), "5E".repeat(32), "zz".repeat(32), ""]) expect(await request(room, ++n, { ...closed, challenge: bad }), JSON.stringify(bad)).toBe(true);
    // The recheck's history: the last match, when it was last checked, and the first definite no since the match.
    expect(await request(room, ++n, { state: "claimed", claimed_at: 5, proved_at: 5, checked_at: 9, definite_no_since: 9 })).toBe(false);
    expect(await one(room, "SELECT generation, proved_at, checked_at, definite_no_since FROM hostname_request WHERE open = 1")).toEqual({ generation: 0, proved_at: 5, checked_at: 9, definite_no_since: 9 });
  });
});

describe("the hostname-claim object (M6 step 2)", () => {
  const state = async (hostname: string) => (await claimStub(hostname).fetch("https://claim.internal/internal/state")).json() as Promise<any>;

  it("answers empty for a hostname nobody asked about, and leaves no state behind", async () => {
    expect(await state("unknown.example.com")).toEqual({ claim: null, suspended: false });
    expect(await inClaim("unknown.example.com", (sql) => sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").one().n)).toBe(0);
  });

  it("answers nothing else: no other path, and no write", async () => {
    for (const [method, path] of [["GET", "/internal/claim"], ["POST", "/internal/state"], ["PUT", "/internal/state"], ["DELETE", "/internal/state"], ["GET", "/"]] as const) {
      const res = await claimStub("paths.example.com").fetch(`https://claim.internal${path}`, { method });
      expect([res.status, ((await res.json()) as any).error.code], `${method} ${path}`).toEqual([404, "not_found"]);
    }
  });

  it("holds at most one claim that isn't ended, and a suspension apart from any claim", async () => {
    const hostname = "app.example.com";
    expect((await claimStub(hostname).fetch("https://claim.internal/internal/test-migrate", { method: "POST" })).status).toBe(200);
    // Applying it again changes nothing.
    expect((await claimStub(hostname).fetch("https://claim.internal/internal/test-migrate", { method: "POST" })).status).toBe(200);
    expect(await state(hostname)).toEqual({ claim: null, suspended: false });
    const add = (id: string, room: string, status: string, held: number | null) => inClaim(hostname, (sql) => refuses(() => sql.exec("INSERT INTO claim (id, workspace_id, request_id, state, held, claimed_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)", id, room, `hnr_${id}`, status, held)));
    expect(await add("clm_1", "ws_a", "live", 1)).toBe(false);
    expect(await state(hostname)).toEqual({ claim: { id: "clm_1", workspace_id: "ws_a", request_id: "hnr_clm_1", state: "live", claimed_at: 1 }, suspended: false });
    // Another room can't hold the name while the first does, live or ending.
    expect(await add("clm_2", "ws_b", "live", 1)).toBe(true);
    await inClaim(hostname, (sql) => sql.exec("UPDATE claim SET state = 'ending'"));
    expect(await add("clm_2", "ws_b", "live", 1)).toBe(true);
    expect((await state(hostname)).claim.state).toBe("ending");
    // A claim can't be ended and still hold the name, or hold it without being live or ending.
    expect(await inClaim(hostname, (sql) => refuses(() => sql.exec("UPDATE claim SET state = 'ended'")))).toBe(true);
    expect(await add("clm_3", "ws_b", "live", null)).toBe(true);
    expect(await add("clm_3", "ws_b", "claimed", 1)).toBe(true);
    // Ended, the name is free, and the old claim is kept.
    await inClaim(hostname, (sql) => sql.exec("UPDATE claim SET state = 'ended', held = NULL, ended_at = 2"));
    expect(await state(hostname)).toEqual({ claim: null, suspended: false });
    expect(await add("clm_2", "ws_b", "live", 1)).toBe(false);
    expect(await inClaim(hostname, (sql) => sql.exec("SELECT COUNT(*) AS n FROM claim").one().n)).toBe(2);
    // A suspension belongs to the name, not to a claim, and holds until it is lifted.
    await inClaim(hostname, (sql) => sql.exec("INSERT INTO suspension (singleton, reason, suspended_at) VALUES (1, 'abuse', 3)"));
    expect((await state(hostname)).suspended).toBe(true);
    await inClaim(hostname, (sql) => sql.exec("UPDATE suspension SET lifted_at = 4"));
    expect((await state(hostname)).suspended).toBe(false);
    // The name's generation, which a suspend, a lift and a free each advance, and never below 0.
    await inClaim(hostname, (sql) => sql.exec("INSERT INTO hostname (singleton, name, created_at) VALUES (1, ?, 1)", hostname));
    expect(await inClaim(hostname, (sql) => sql.exec("SELECT generation, last_freed_at, last_suspended_at, last_lifted_at FROM hostname").one())).toEqual({ generation: 0, last_freed_at: null, last_suspended_at: null, last_lifted_at: null });
    expect(await inClaim(hostname, (sql) => refuses(() => sql.exec("UPDATE hostname SET generation = -1")))).toBe(true);
    expect(await inClaim(hostname, (sql) => refuses(() => sql.exec("UPDATE hostname SET generation = generation + 1, last_suspended_at = 3, last_lifted_at = 4")))).toBe(false);
    // Its states are the rules' own.
    const core = JSON.parse(BINDINGS.TEST_CORE_SETS) as { hostnameClaimStates: string[]; holdingHostnameClaimStates: string[] };
    expect([core.hostnameClaimStates, core.holdingHostnameClaimStates]).toEqual([["live", "ending", "ended"], ["live", "ending"]]);
    // Another hostname is another object.
    expect(await state("other.example.com")).toEqual({ claim: null, suspended: false });
  });
});

describe("the Worker's configuration for M6", () => {
  it("binds the hostname-claim class in every environment, adds it in its own migration, and sets no release switch", () => {
    const config = JSON.parse(BINDINGS.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
    const binding = { name: "HOSTNAME_CLAIM", class_name: "HostnameClaim" };
    expect(config.durable_objects.bindings).toContainEqual(binding);
    expect(config.env.staging.durable_objects.bindings).toContainEqual(binding);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["Workspace", "Principal"] },
      { tag: "v2", new_sqlite_classes: ["Moderation"] },
      { tag: "v3", new_sqlite_classes: ["HostnameClaim"] },
    ]);
    // Release is switched on nowhere, and nothing of Workers for Platforms, KV or a content domain is bound.
    for (const vars of [config.vars, ...Object.values(config.env).map((environment: any) => environment.vars)]) expect(Object.keys(vars ?? {})).not.toContain("RELEASES");
    for (const name of ["dispatch_namespaces", "kv_namespaces", "routes"]) expect(BINDINGS.TEST_WRANGLER, name).not.toContain(`"${name}"`);
  });
});
