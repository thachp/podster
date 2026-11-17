import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, expectNoAlarmSooner, manualAlarms, nextAlarm, runtimeAlarms } from "./alarm";
import { txtData } from "./fake-resolver";

// M6 step 8, the first PR: a room's custom hostname, its challenge and the claim (ADR 0010's "Custom domains", steps
// 0 to 4; decisions 201 and 207). `getAppHostname`, `requestAppHostname` and `removeAppHostname`, the room's proof job
// and the hostname's object's two new paths: the ask for the claim, and a room's withdrawal of a request it never
// committed. Nothing here makes anything at Cloudflare, and nothing serves a custom hostname.
//
// Each room is given its rows through the test pool, as in `release-config.spec.ts`: a public room with release on, a
// ready repository and an app serving on its default host. Each room's content provider is switched off, so the
// release path's gate is open and nothing reaches the provider's stand-in. Each is opted in to custom hostname claims,
// which are closed everywhere else until 8b and 8d (`HOSTNAME_CLAIMS_COMPLETE`). The resolver is the stand-in in
// `fake-resolver.ts`.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[] };
const OPERATOR: Who = { id: "per_operator_one", org: "org_ah_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: 1 }
    : { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { key?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `ah-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const claimOf = (hostname: string) => BINDINGS.HOSTNAME_CLAIM.get(BINDINGS.HOSTNAME_CLAIM.idFromName(hostname));
const inClaim = <T>(hostname: string, fn: (sql: any) => T) => runInDurableObject(claimOf(hostname), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const claimState = async (hostname: string) => (await claimOf(hostname).fetch("https://claim/internal/state")).json() as Promise<any>;
/** The object's own path, as a room calls it. */
const toClaim = async (hostname: string, path: string, body: unknown) => {
  const res = await claimOf(hostname).fetch(`https://claim${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
const resolver = (body: unknown) => fetch("https://resolver-fake.example.com/set", { method: "POST", body: JSON.stringify(body) });
const asked = async () => (await (await fetch("https://resolver-fake.example.com/asked")).json()) as string[];
const answerWith = (name: string, ...values: string[]) => resolver({ name: `_podster-challenge.${name}`, answer: { body: { Status: 0, Answer: values.map((value) => ({ name: `_podster-challenge.${name}`, type: 16, data: txtData(value) })) } } });

/** Release switched on for the test Worker while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const AGENT: Who = { id: "agt_ah_agent", org: "org_ah_agents", kind: "agent" };
const PREV = `rel_${"6c".repeat(16)}`;
const SHA = "ee".repeat(20);
let rooms = 0;
const made: string[] = [];
let names = 0;
/** A custom hostname no other test has used. */
const newName = () => `h${(++names).toString(36)}${crypto.randomUUID().slice(0, 8)}.example.net`;

type Room = { room: string; owner: Who; admin: Who; member: Who; label: string; host: string };
/** A public room with release on, a ready repository and an app serving an earlier release on its default host. */
async function room(org: string): Promise<Room> {
  const owner: Who = { id: `per_ah_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Custom hostname" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  // The room's alarms are the test's from here: only its own passes run the job (review standard 1).
  await manualAlarms(stub(id));
  const n = ++rooms;
  const member: Who = { id: `per_ah_mem_${n}`, org };
  const admin: Who = { id: `per_ah_adm_${n}`, org };
  const label = `ah${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const handle = `pub_${crypto.randomUUID().replace(/-/g, "")}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", handle);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    // Test builds only: claims are opened for this room. Every build without the feature has them closed.
    sql.exec("CREATE TABLE test_hostname_claims_open (x INTEGER)");
    for (const [who, role] of [[member, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/hostname', 'public', 'main', 'ready', ?, 1, 1, 1)", 987650100 + n, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_ah_1', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", owner.id, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'served', ?, 3, 2, 'tsk_ah_1', ?, ?, ?, 1, ?, 1, 1, 1)`,
      PREV, SHA, label, `${label}.${PREV}`, PREV, owner.id, owner.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, `${label}.${PREV}`);
    // The kind a real upload records before its script is written (S3): static.
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state UNION SELECT flight_before FROM serve_state) WHERE s IS NOT NULL");
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${PREV}`);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner, admin, member, label, host };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/app-hostname`;
const get = (r: Room, who = r.owner) => api(who, "GET", path(r));
const ask = (r: Room, hostname: string, who = r.owner) => api(who, "PUT", path(r), { hostname });
const remove = (r: Room, who = r.owner) => api(who, "DELETE", path(r));
const requestRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT id, hostname, state, open, challenge, generation, proved_at, checked_at, claimed_at, end_reason FROM hostname_request ORDER BY requested_at DESC, id DESC LIMIT 1").toArray()[0] ?? null);
/** Moves the request's last look back by `ms`, so its next one is due now. */
const rewindLook = (r: Room, ms = 61_000) => inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = checked_at - ? WHERE checked_at IS NOT NULL", ms));
const pass = (r: Room) => switchedOn(() => alarmPass(stub(r.room)));
const events = (r: Room) => all(r.room, "SELECT type, actor_id FROM event WHERE type LIKE 'app_hostname.%' ORDER BY seq");
/** Asks for `name` with release switched on. The ask leaves the room's alarm due at once, and only the test's own
 *  passes run it, since `room` made the room's alarms the test's: nothing needs quieting before the rows it writes next. */
const askFor = async (r: Room, name: string) => (await switchedOn(() => ask(r, name))).body.request;
/** Removes the room's hostname with release switched on. */
const removed = (r: Room) => switchedOn(() => remove(r));
/** The proof job's clock (`test_hostname_clock`) stopped at `now`, or given back to real time with null. */
const jobClock = (r: Room, now: number | null) => inRoom(r.room, (sql) => {
  sql.exec("DROP TABLE IF EXISTS test_hostname_clock");
  if (now !== null) {
    sql.exec("CREATE TABLE test_hostname_clock (now INTEGER)");
    sql.exec("INSERT INTO test_hostname_clock (now) VALUES (?)", now);
  }
});
const refusedBy = (answer: { status: number; code?: string }) => [answer.status, answer.code];
/** The room's provider configured, as a deployment with one has it, while `run` runs. */
async function withProvider<T>(r: Room, run: () => Promise<T>): Promise<T> {
  await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
  try { return await run(); } finally { await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)")); }
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registrar: Who = { id: "per_ah_registrar", org: AGENT.org, adminOrgs: [AGENT.org] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

describe("a room's custom hostname: the request and its challenge (M6 step 8)", () => {
  it("is read, asked for and removed only by the room's owner or an admin, as a person", async () => {
    const r = await room("org_ah_who");
    await switchedOn(async () => {
      expect((await get(r)).body).toEqual({ request: null });
      expect((await get(r, r.admin)).status).toBe(200);
      for (const call of [() => get(r, r.member), () => ask(r, newName(), r.member), () => remove(r, r.member)]) expect((await call()).code).toBe("not_allowed");
      // An agent is refused by its kind before the room is asked.
      for (const method of ["GET", "PUT", "DELETE"]) expect((await api(AGENT, method, path(r), { hostname: newName() })).code, method).toBe("not_allowed");
      // An operator isn't in the room.
      expect((await get(r, OPERATOR)).code).toBe("workspace_not_found");
    });
    expect(await requestRow(r)).toBeNull();
  });

  it("commits a pending request with a value made for it alone, and the name stays free for others", async () => {
    const [a, b] = [await room("org_ah_ask_a"), await room("org_ah_ask_b")];
    const name = newName();
    await switchedOn(async () => {
      const first = await ask(a, `${name.toUpperCase()}.`);
      expect(first.status).toBe(200);
      const request = first.body.request;
      expect(request).toMatchObject({ hostname: name, state: "pending", challenge_name: `_podster-challenge.${name}`, requested_by: a.owner.id, end_reason: null });
      expect(request.id).toMatch(/^hnr_[0-9a-f]{32}$/);
      expect(request.challenge_value).toMatch(/^[0-9a-f]{64}$/);
      expect(request.expires_at - request.requested_at).toBe(72 * 60 * 60 * 1000);
      expect((await get(a)).body).toEqual({ request });
      // Pending holds nothing: another room asks for the same name, and gets its own value.
      const second = await ask(b, name);
      expect(second.status).toBe(200);
      expect(second.body.request.challenge_value).not.toBe(request.challenge_value);
      // One custom hostname a room, pending or claimed.
      expect((await ask(a, newName())).code).toBe("hostname_limit");
      expect((await ask(a, name)).code).toBe("hostname_limit");
    });
    // The name's object was only read: nothing is held for a pending request.
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 0 });
    expect(await events(a)).toEqual([{ type: "app_hostname.requested", actor_id: a.owner.id }]);
    expect(await all(a.room, "SELECT actor_id, new_json FROM audit_event WHERE action = 'app_hostname.requested'")).toEqual([
      { actor_id: a.owner.id, new_json: JSON.stringify({ request_id: (await requestRow(a)).id, state: "pending" }) },
    ]);
  });

  it("refuses what the rules refuse, by their codes, and records nothing", async () => {
    const r = await room("org_ah_refuse");
    const suspended = newName();
    await switchedOn(async () => {
      expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${suspended}/suspend`, { reason: "abuse" })).status).toBe(200);
      const cases: [unknown, number, string][] = [
        [{ hostname: "*.wild.example.net" }, 400, "hostname_wildcard"],
        [{ hostname: "192.0.2.7" }, 400, "hostname_ip_address"],
        [{ hostname: "intranet" }, 400, "hostname_single_label"],
        [{ hostname: "bad_name.example.net" }, 400, "hostname_invalid"],
        [{ hostname: "app.podster.dev" }, 409, "hostname_reserved"],
        [{ hostname: `other.${FAKE.domain}` }, 409, "hostname_reserved"],
        // Podster's other domains, the content domain first named and the one named since, and every name under them.
        [{ hostname: "opster.dev" }, 409, "hostname_reserved"],
        [{ hostname: "x.opster.dev" }, 409, "hostname_reserved"],
        [{ hostname: "podster.site" }, 409, "hostname_reserved"],
        [{ hostname: "app.podster.site" }, 409, "hostname_reserved"],
        [{ hostname: "co.uk" }, 409, "hostname_public_suffix"],
        [{ hostname: "anything.ck" }, 409, "hostname_public_suffix"],
        // No rule covers the name's top-level label: it can't be classified, which fails closed.
        [{ hostname: "app.example.zz" }, 409, "hostname_unavailable"],
        [{ hostname: suspended }, 409, "hostname_suspended"],
        [{ hostname: newName(), extra: 1 }, 400, "invalid_argument"],
        [{ hostname: 7 }, 400, "invalid_argument"],
        [{}, 400, "invalid_argument"],
      ];
      for (const [body, status, code] of cases) {
        const answer = await api(r.owner, "PUT", path(r), body);
        expect([answer.status, answer.code], JSON.stringify(body)).toEqual([status, code]);
      }
      expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${suspended}/lift`, { reason: "other" })).status).toBe(200);
    });
    expect(await requestRow(r)).toBeNull();
    expect(await events(r)).toEqual([]);
  });

  it("is asked for only where release may happen, and removed wherever", async () => {
    const r = await room("org_ah_where");
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    await switchedOn(async () => {
      expect((await ask(r, newName())).code).toBe("release_off");
      await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET enabled = 1"));
      await inRoom(r.room, (sql) => sql.exec("UPDATE workspace SET visibility = 'private'"));
      expect((await ask(r, newName())).code).toBe("release_needs_public_room");
      await inRoom(r.room, (sql) => sql.exec("UPDATE workspace SET visibility = 'public'"));
      expect((await ask(r, newName())).status).toBe(200);
      // Removing only takes down, so a room where release can't happen can still drop its request.
      await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
      expect((await remove(r)).body).toEqual({ request: null });
    });
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, end_reason: "hostname_unmapped" });
  });

  it("can't be told from a path nobody defined while release is switched off", async () => {
    const r = await room("org_ah_off");
    for (const [method, body] of [["GET", undefined], ["PUT", { hostname: newName() }], ["DELETE", undefined]] as const) {
      const [real, unknown] = [await api(r.owner, method, path(r), body), await api(r.owner, method, `${path(r)}x`, body)];
      expect([real.status, real.code], method).toEqual([unknown.status, unknown.code]);
      expect(real.code).toBe("not_found");
    }
    expect(await requestRow(r)).toBeNull();
  });

  it("is bound to no resolver and no list of public suffixes in any environment", () => {
    const wrangler: string = BINDINGS.TEST_API_WRANGLER;
    for (const name of ["HOSTNAME_RESOLVER_URL", "PUBLIC_SUFFIX_RULES"]) expect(wrangler.includes(name), name).toBe(false);
  });
});

describe("the proof job and the claim (M6 step 8)", () => {
  it("claims the name only once the room's own value is in DNS, and records the request's ID and generation with the claim", async () => {
    const r = await room("org_ah_claim");
    const name = newName();
    const request = await askFor(r, name);
    // Another value at the name proves nothing.
    await answerWith(name, "0".repeat(64), "v=spf1 -all");
    await rewindLook(r);
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "pending", proved_at: null });
    const looks = (await asked()).filter((line) => line.includes(name));
    expect(new Set(looks)).toEqual(new Set([`GET _podster-challenge.${name} TXT application/dns-json`]));
    // Not looked at again before its turn: the job's clock stopped at the moment of its last look, so no real time
    // the test takes can bring the turn round (review standard 1).
    await jobClock(r, (await requestRow(r)).checked_at);
    await pass(r);
    expect((await asked()).filter((line) => line.includes(name))).toHaveLength(looks.length);
    await jobClock(r, null);
    // The room's own value, among others, in two strings, as a long value comes: the claim is the room's.
    await answerWith(name, "unrelated", request.challenge_value);
    await rewindLook(r);
    await pass(r);
    const row = await requestRow(r);
    expect(row).toMatchObject({ state: "claimed", open: 1, end_reason: null, generation: 0 });
    expect(row.proved_at).not.toBeNull();
    expect(row.claimed_at).not.toBeNull();
    const held = await claimState(name);
    expect(held).toMatchObject({ suspended: false, generation: 0, claim: { workspace_id: r.room, request_id: request.id, state: "live" } });
    expect(await inClaim(name, (sql) => sql.exec("SELECT generation FROM claim").toArray())).toEqual([{ generation: 0 }]);
    await switchedOn(async () => {
      expect((await get(r)).body.request).toMatchObject({ id: request.id, state: "claimed" });
      expect((await api(r.owner, "GET", `/v1/workspaces/${r.room}/release-config`)).body.custom_host).toBe(name);
    });
    expect(await events(r)).toEqual([
      { type: "app_hostname.requested", actor_id: r.owner.id },
      { type: "app_hostname.claimed", actor_id: "podster" },
    ]);
    // A claim the room holds owes the job nothing before its turn (8b creates its custom hostname then), with the
    // job's clock stopped at the claim's last look.
    const claimed = await requestRow(r);
    await jobClock(r, claimed.checked_at);
    await pass(r);
    expect(await requestRow(r)).toEqual(claimed);
  });

  it("gives one hostname to one room: a second room's proof is refused while the claim lives", async () => {
    const [a, b] = [await room("org_ah_one_a"), await room("org_ah_one_b")];
    const name = newName();
    const [ra, rb] = await switchedOn(async () => [(await ask(a, name)).body.request, (await ask(b, name)).body.request]);
    // Each ask set its room's alarm, due at once, and only the passes below run either room's job, a's first.
    await answerWith(name, ra.challenge_value, rb.challenge_value);
    await rewindLook(a);
    await pass(a);
    await rewindLook(b);
    await pass(b);
    expect(await requestRow(a)).toMatchObject({ state: "claimed" });
    expect(await requestRow(b)).toMatchObject({ state: "refused", open: null, end_reason: "hostname_claimed" });
    expect((await claimState(name)).claim).toMatchObject({ workspace_id: a.room, request_id: ra.id });
    expect(await events(b)).toEqual([
      { type: "app_hostname.requested", actor_id: b.owner.id },
      { type: "app_hostname.refused", actor_id: "podster" },
    ]);
    // Refused is over: the room may ask again, for another name or this one.
    expect((await switchedOn(() => ask(b, newName()))).status).toBe(200);
  });

  it("with no resolver, looks nothing up, and the request waits until it expires", async () => {
    const r = await room("org_ah_noresolver");
    const name = newName();
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_hostname_resolver_off (x INTEGER)"));
    const request = await askFor(r, name);
    await answerWith(name, request.challenge_value);
    // A public room's first check of its discovery row comes at a random time within six hours, which can be sooner
    // than the hour below. Set past it, so the only wake left to read is the proof job's.
    await runInDurableObject(stub(r.room), (_: any, state: any) => state.storage.put("public_index_verify_next", Date.now() + 7 * 24 * 3600_000));
    await pass(r);
    expect(await asked()).not.toContain(`GET _podster-challenge.${name} TXT application/dns-json`);
    expect(await requestRow(r)).toMatchObject({ state: "pending", proved_at: null, checked_at: null });
    // It asks for no wake to look again: only its expiry, which is days away.
    await expectNoAlarmSooner(stub(r.room), 60 * 60 * 1000);
    // Past its 72 hours it reads as expired before the job records it, and the job records it.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET requested_at = requested_at - ?, expires_at = expires_at - ?", 72 * 3600_000, 72 * 3600_000));
    await switchedOn(async () => expect((await get(r)).body.request).toMatchObject({ state: "expired", end_reason: "hostname_request_expired" }));
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "expired", open: null, end_reason: "hostname_request_expired" });
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 0 });
  });

  it("while release is switched off, looks nothing up and asks for nothing", async () => {
    const r = await room("org_ah_jobsoff");
    const name = newName();
    const request = await askFor(r, name);
    await answerWith(name, request.challenge_value);
    // Each pass below is the test's own, and is shown to have looked: the look it records is past the rewound one.
    // The job's clock is set past the rewound look by a minute and a second, so its turn has come by the job's clock
    // alone, whatever real time the test takes.
    const looked = async (run: () => Promise<unknown>) => {
      const rewound = (await requestRow(r)).checked_at ?? 0;
      await jobClock(r, Math.max(rewound, Date.now()) + 61_000);
      await run();
      expect((await requestRow(r)).checked_at).toBeGreaterThan(rewound);
      await jobClock(r, null);
    };
    const before = (await asked()).filter((line) => line.includes(name)).length;
    await looked(() => alarmPass(stub(r.room)));
    expect((await asked()).filter((line) => line.includes(name)).length).toBe(before);
    expect(await requestRow(r)).toMatchObject({ state: "pending", proved_at: null });
    // Nor while release is switched off in the room, with the deployment's switch on.
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    await rewindLook(r);
    await looked(() => pass(r));
    expect((await asked()).filter((line) => line.includes(name)).length).toBe(before);
    expect(await requestRow(r)).toMatchObject({ state: "pending", proved_at: null });
    // An ask already out is finished whatever the switches say: only the object's answer settles it.
    // Its turn comes by the job's clock: an hour, the longest an ask waits, after the last look.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET proved_at = ?", Date.now()));
    await jobClock(r, (await requestRow(r)).checked_at + 3600_000);
    await alarmPass(stub(r.room));
    await jobClock(r, null);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    expect((await asked()).filter((line) => line.includes(name)).length).toBe(before);
  });

  it("proves nothing from a resolver that fails, or answers in any other form", async () => {
    const r = await room("org_ah_badresolver");
    const name = newName();
    const request = await askFor(r, name);
    const value = request.challenge_value;
    const at = `_podster-challenge.${name}`;
    const bad: unknown[] = [
      { httpStatus: 500 },
      { body: "{" },
      { body: { Status: 2, Answer: [{ name: at, type: 16, data: txtData(value) }] } },
      { body: { Answer: [{ name: at, type: 16, data: txtData(value) }] } },
      { body: { Status: 0, Answer: [{ name: at, type: "16", data: txtData(value) }] } },
      { body: { Status: 0, Answer: { name: at, type: 16, data: txtData(value) } } },
      // The value, unquoted and with something after it, isn't the value.
      { body: { Status: 0, Answer: [{ name: at, type: 16, data: `${value} x` }] } },
      // Another record type carrying the value isn't a TXT record.
      { body: { Status: 0, Answer: [{ name: at, type: 1, data: txtData(value) }] } },
      // A truncated answer may be missing records, so it is no answer, even with the value in it; and so is a `TC`
      // that isn't a boolean.
      { body: { Status: 0, TC: true, Answer: [{ name: at, type: 16, data: txtData(value) }] } },
      { body: { Status: 0, TC: "false", Answer: [{ name: at, type: 16, data: txtData(value) }] } },
    ];
    for (const answer of bad) {
      await resolver({ name: at, answer });
      await rewindLook(r, 3600_000);
      await pass(r);
      expect(await requestRow(r), JSON.stringify(answer)).toMatchObject({ state: "pending", proved_at: null });
    }
    // A CNAME the resolver followed: the TXT record at its target counts.
    await resolver({ name: at, answer: { body: { Status: 0, Answer: [{ name: at, type: 5, data: "proof.elsewhere.example.org." }, { name: "proof.elsewhere.example.org", type: 16, data: txtData(value) }] } } });
    await rewindLook(r, 3600_000);
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
  });

  it("ends a request whose proof was taken to the object only by the object's answer, expired among them", async () => {
    const r = await room("org_ah_lateask");
    const name = newName();
    const request = await askFor(r, name);
    // As if the job had recorded the proof and then lost the object's answer, 73 hours ago.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET requested_at = requested_at - ?, expires_at = expires_at - ?, proved_at = 1, checked_at = ?", 73 * 3600_000, 73 * 3600_000, Date.now()));
    // The room's own clock doesn't end it: the object may have given the claim.
    await switchedOn(async () => expect((await get(r)).body.request).toMatchObject({ id: request.id, state: "pending" }));
    await rewindLook(r);
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "expired", open: null, end_reason: "hostname_request_expired" });
    expect((await claimState(name)).claim).toBeNull();
  });
});

describe("removing a custom hostname, and withdrawing a request never committed (M6 step 8)", () => {
  it("drops a request nobody was asked about at once", async () => {
    const r = await room("org_ah_drop");
    const name = newName();
    await switchedOn(async () => {
      await ask(r, name);
      expect((await remove(r)).body).toEqual({ request: null });
      expect((await get(r)).body.request).toMatchObject({ hostname: name, state: "ended", end_reason: "hostname_unmapped" });
      // Asking again changes nothing.
      expect((await remove(r)).body).toEqual({ request: null });
    });
    expect(await events(r)).toEqual([
      { type: "app_hostname.requested", actor_id: r.owner.id },
      { type: "app_hostname.removed", actor_id: r.owner.id },
    ]);
  });

  it("withdraws a request whose ask was out, so the object never grants it, whichever arrives first", async () => {
    const r = await room("org_ah_withdraw");
    const name = newName();
    const request = await askFor(r, name);
    // The proof was recorded, and the ask is out.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET proved_at = ?, checked_at = ?", Date.now(), Date.now()));
    expect((await removed(r)).body.request).toMatchObject({ id: request.id, state: "ending", end_reason: "hostname_unmapped" });
    // The withdrawal reaches the object first, the next time the job runs: it is recorded, with nothing to free.
    await rewindLook(r);
    await alarmPass(stub(r.room));
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, end_reason: "hostname_unmapped" });
    expect(await inClaim(name, (sql) => sql.exec("SELECT workspace_id, request_id FROM withdrawn").toArray())).toEqual([{ workspace_id: r.room, request_id: request.id }]);
    // Then the ask arrives: refused, and nothing is held.
    const late = await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 });
    expect(late.body).toEqual({ decision: "hostname_request_withdrawn" });
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 0 });
  });

  it("frees a claim the object gave for a request the room removed before committing it", async () => {
    const r = await room("org_ah_free");
    const name = newName();
    const request = await askFor(r, name);
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET proved_at = ?, checked_at = ?", Date.now(), Date.now()));
    // The object granted the ask, and the answer never reached the room.
    const granted = await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 });
    expect(granted.body).toEqual({ decision: "granted" });
    await removed(r);
    await rewindLook(r);
    await alarmPass(stub(r.room));
    expect(await requestRow(r)).toMatchObject({ state: "ended", claimed_at: null });
    // Freed, and the generation moved, so every request made before is stale.
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 1 });
    expect(await inClaim(name, (sql) => sql.exec("SELECT state, held, end_reason FROM claim").toArray())).toEqual([{ state: "ended", held: null, end_reason: "hostname_request_withdrawn" }]);
    // The answer it lost, asked again, isn't given back.
    expect((await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 })).body.decision).toBe("hostname_request_withdrawn");
  });

  it("ends a committed claim the long way: the name stays held until its object has marked it ending and freed it", async () => {
    const r = await room("org_ah_committed");
    const name = newName();
    const request = await askFor(r, name);
    await answerWith(name, request.challenge_value);
    await rewindLook(r);
    await pass(r);
    // A removal now is of a committed claim, not a withdrawal.
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    expect((await removed(r)).body.request).toMatchObject({ state: "ending", end_reason: "hostname_unmapped" });
    // The name stays held while the claim ends, and the room can't ask for another.
    expect((await claimState(name)).claim).toMatchObject({ workspace_id: r.room, request_id: request.id, state: "live" });
    expect((await switchedOn(() => ask(r, newName()))).code).toBe("hostname_limit");
    // 8b: the object is told, then, with nothing ever made at Cloudflare for it, the claim is freed
    // (`custom-hostname.spec.ts` has the rest). Each step is the test's own pass, the only runs the room's job gets.
    await rewindLook(r);
    await alarmPass(stub(r.room));
    expect((await claimState(name)).claim).toMatchObject({ state: "ending" });
    expect(await requestRow(r)).toMatchObject({ state: "ending", open: 1 });
    await rewindLook(r);
    await alarmPass(stub(r.room));
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, end_reason: "hostname_unmapped" });
    expect((await claimState(name)).claim).toBeNull();
  });

  it("stops serving a committed claim's host in the same transaction as its removal", async () => {
    const r = await room("org_ah_close");
    const name = newName();
    const request = await askFor(r, name);
    await answerWith(name, request.challenge_value);
    await rewindLook(r);
    await pass(r);
    // Nothing in this PR serves a custom hostname. A host as a later PR will write one, to show the removal closes it.
    await inRoom(r.room, (sql) => sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'custom', ?, 1, ?, ?, 2, 1)", name, r.label, PREV, `${r.label}.${PREV}`));
    await switchedOn(() => remove(r));
    expect(await all(r.room, "SELECT script_name, closed, version FROM serve_state WHERE host = ?", name)).toEqual([{ script_name: null, closed: 1, version: 3 }]);
    // The default host is untouched.
    expect(await all(r.room, "SELECT script_name FROM serve_state WHERE host = ?", r.host)).toEqual([{ script_name: `${r.label}.${PREV}` }]);
  });

  it("withdraws a request a suspension's notice ended before the room committed its claim, and frees the name", async () => {
    const r = await room("org_ah_notice");
    const name = newName();
    const request = await askFor(r, name);
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET proved_at = ?, checked_at = ?", Date.now(), Date.now()));
    await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 });
    await switchedOn(async () => expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${name}/suspend`, { reason: "abuse" })).status).toBe(200));
    // The object tells the room, under the generation the claim was given under, which is the request's own.
    await alarmPass(claimOf(name));
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_suspended", claimed_at: null });
    await rewindLook(r);
    await alarmPass(stub(r.room));
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_suspended" });
    // Freed, still suspended: suspended, then freed, so the generation moved twice.
    expect(await claimState(name)).toEqual({ claim: null, suspended: true, generation: 2 });
    await switchedOn(async () => {
      expect((await ask(r, name)).code).toBe("hostname_suspended");
      expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${name}/lift`, { reason: "other" })).status).toBe(200);
    });
  });
});

describe("the reviews' rulings on the claim (M6 step 8)", () => {
  it("withdraws a request whose retried ask met the name's suspension before its notice did, so the name is free once lifted", async () => {
    const r = await room("org_ah_retry_first");
    const name = newName();
    const request = await askFor(r, name);
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET proved_at = ?, checked_at = ?", Date.now(), Date.now()));
    // The object granted the ask, and its answer never reached the room.
    const ask0 = { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 };
    expect((await toClaim(name, "/internal/claim", ask0)).body).toEqual({ decision: "granted" });
    // The room refuses the suspension's notice for now, so its retried ask reaches the object first, whenever the
    // object's own alarm runs.
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_refuse_hostname_notice (x INTEGER)"));
    await switchedOn(async () => expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${name}/suspend`, { reason: "abuse" })).status).toBe(200));
    await rewindLook(r);
    await alarmPass(stub(r.room));
    // Suspended may hide a claim given for this very request: not refused, but ending, never committed.
    expect(await requestRow(r)).toMatchObject({ state: "ending", open: 1, claimed_at: null, end_reason: "hostname_suspended" });
    await rewindLook(r);
    await alarmPass(stub(r.room));
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, claimed_at: null, end_reason: "hostname_suspended" });
    // Withdrawn, so freed: suspended, then freed, so the generation moved twice. Nothing is left held.
    expect(await claimState(name)).toEqual({ claim: null, suspended: true, generation: 2 });
    // The notice, once the room answers it, finds the request over and changes nothing.
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_refuse_hostname_notice"));
    await inClaim(name, (sql) => sql.exec("UPDATE notice SET next_attempt_at = 0"));
    await alarmPass(claimOf(name));
    expect(await inClaim(name, (sql) => sql.exec("SELECT count(*) AS n FROM notice WHERE answered_at IS NULL").toArray())).toEqual([{ n: 0 }]);
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_suspended" });
    // Lifted, the name is free again, and the room may ask for it.
    await switchedOn(async () => {
      expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${name}/lift`, { reason: "other" })).status).toBe(200);
      expect((await ask(r, name)).status).toBe(200);
    });
  });

  it("is closed everywhere until claims are complete: without the test build's opt-in nothing is asked for, looked up or claimed, provider or not", async () => {
    const r = await room("org_ah_gate");
    const name = newName();
    const request = await askFor(r, name);
    await answerWith(name, request.challenge_value);
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_hostname_claims_open"));
    const before = (await asked()).filter((line) => line.includes(name)).length;
    // No provider, release switched on, a resolver and a Public Suffix List bound: still closed.
    expect(refusedBy(await switchedOn(() => ask(r, newName())))).toEqual([409, "release_not_available"]);
    await rewindLook(r);
    await pass(r);
    // And with a provider configured too.
    await withProvider(r, async () => {
      expect(refusedBy(await switchedOn(() => ask(r, newName())))).toEqual([409, "release_not_available"]);
      await rewindLook(r);
      await pass(r);
    });
    expect((await asked()).filter((line) => line.includes(name)).length).toBe(before);
    expect(await requestRow(r)).toMatchObject({ id: request.id, state: "pending", proved_at: null });
    expect((await claimState(name)).claim).toBeNull();
    expect(await all(r.room, "SELECT count(*) AS n FROM hostname_request")).toEqual([{ n: 1 }]);
    // A proved request whose granted answer was lost isn't asked about again while the gate is closed: the object keeps
    // the claim, which fails closed, until a removal withdraws it, which the gate never holds back.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET proved_at = ?, checked_at = ?", Date.now(), Date.now()));
    await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 });
    await rewindLook(r);
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "pending", claimed_at: null });
    expect((await claimState(name)).claim).toMatchObject({ workspace_id: r.room, request_id: request.id });
    expect((await removed(r)).body.request).toMatchObject({ state: "ending" });
    await rewindLook(r);
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_unmapped" });
    expect((await claimState(name)).claim).toBeNull();
    // Opted in, as a test build lets a room be, the same path asks and claims.
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_hostname_claims_open (x INTEGER)"));
    const again = await askFor(r, newName());
    await answerWith(again.hostname, again.challenge_value);
    await rewindLook(r);
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ id: again.id, state: "claimed" });
    // One constant, false, set in one place, and the opt-in read only under the test build's feature.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(sources["workspace/hostname.rs"]).toContain("pub(crate) const HOSTNAME_CLAIMS_COMPLETE: bool = false;");
    expect(Object.values(sources).join("\n").match(/HOSTNAME_CLAIMS_COMPLETE: bool/g)).toHaveLength(1);
    // The room's method and the applier both read it through one function (8c).
    const method = sources["workspace/hostname.rs"].split("pub(super) fn hostname_claims_open")[1].split("\n    }\n")[0];
    expect(method).toMatch(/^\(&self\) -> bool \{\s*claims_open\(&self\.state\.storage\(\)\.sql\(\)\)\s*$/);
    const gate = sources["workspace/hostname.rs"].split("pub(super) fn claims_open")[1].split("\n}\n")[0];
    expect(gate).toMatch(/if HOSTNAME_CLAIMS_COMPLETE \{\s*return true;\s*\}\s*#\[cfg\(feature = "failpoints"\)\][\s\S]*test_hostname_claims_open[\s\S]*#\[cfg\(not\(feature = "failpoints"\)\)\]\s*\{\s*let _ = sql;\s*false\s*\}\s*$/);
  });

  it("refuses asking, and switching release on, where a provider is configured while the release path isn't complete", async () => {
    const r = await room("org_ah_path");
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    await withProvider(r, () => switchedOn(async () => {
      const on = await api(r.owner, "PUT", `/v1/workspaces/${r.room}/release-config`, { enabled: true, expected_version: 3 });
      expect(refusedBy(on)).toEqual([409, "release_not_available"]);
      expect(refusedBy(await ask(r, newName()))).toEqual([409, "release_not_available"]);
    }));
    expect(await all(r.room, "SELECT enabled, version FROM release_config")).toEqual([{ enabled: 0, version: 3 }]);
    expect(await requestRow(r)).toBeNull();
  });

  it("answers standing_unknown, and writes nothing, when the hostname's object can't be read", async () => {
    const r = await room("org_ah_unread");
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_hostname_object_unread (x INTEGER)"));
    expect(refusedBy(await switchedOn(() => ask(r, newName())))).toEqual([503, "standing_unknown"]);
    expect(await requestRow(r)).toBeNull();
    expect(await events(r)).toEqual([]);
    // Readable again, the same ask is answered.
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_hostname_object_unread"));
    expect((await switchedOn(() => ask(r, newName()))).status).toBe(200);
  });

  it("ends a request the room's own facts no longer allow before its next look, and withdraws one whose proof was out", async () => {
    // Archived: the request's proof was never taken anywhere, so it is over at once, and nothing is looked up.
    const a = await room("org_ah_facts_archived");
    const nameA = newName();
    const ra = await askFor(a, nameA);
    await answerWith(nameA, ra.challenge_value);
    await inRoom(a.room, (sql) => sql.exec("UPDATE workspace SET status = 'archived'"));
    await rewindLook(a);
    const before = (await asked()).filter((line) => line.includes(nameA)).length;
    await pass(a);
    expect(await requestRow(a)).toMatchObject({ state: "ended", open: null, proved_at: null, end_reason: "workspace_archived" });
    expect((await asked()).filter((line) => line.includes(nameA)).length).toBe(before);
    expect(await events(a)).toEqual([
      { type: "app_hostname.requested", actor_id: a.owner.id },
      { type: "app_hostname.refused", actor_id: "podster" },
    ]);
    // The app suspended while an ask was out: the object may have given the claim, so it is withdrawn there, never asked
    // again.
    const b = await room("org_ah_facts_app");
    const nameB = newName();
    const rb = await askFor(b, nameB);
    await inRoom(b.room, (sql) => {
      sql.exec("UPDATE hostname_request SET proved_at = ?, checked_at = ?", Date.now(), Date.now());
      sql.exec("UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse'");
    });
    await rewindLook(b);
    await pass(b);
    expect(await requestRow(b)).toMatchObject({ state: "ending", open: 1, claimed_at: null, end_reason: "app_suspended" });
    await rewindLook(b);
    await alarmPass(stub(b.room));
    expect(await requestRow(b)).toMatchObject({ state: "ended", open: null, end_reason: "app_suspended" });
    expect(await inClaim(nameB, (sql) => sql.exec("SELECT workspace_id, request_id FROM withdrawn").toArray())).toEqual([{ workspace_id: b.room, request_id: rb.id }]);
    expect((await claimState(nameB)).claim).toBeNull();
    // The organization's release switch, as the room applied it, can't be read: nothing is looked up, and nothing ends.
    const c = await room("org_ah_facts_unread");
    const nameC = newName();
    const rc = await askFor(c, nameC);
    await answerWith(nameC, rc.challenge_value);
    // Held at a generation its last take equals, which no set makes.
    await inRoom(c.room, (sql) => sql.exec("UPDATE release_switch_applied SET granted = 1, generation = 1, last_take = 1"));
    await rewindLook(c);
    const beforeC = (await asked()).filter((line) => line.includes(nameC)).length;
    await pass(c);
    expect((await asked()).filter((line) => line.includes(nameC)).length).toBe(beforeC);
    expect(await requestRow(c)).toMatchObject({ state: "pending", open: 1, proved_at: null });
  });

  it("lets a room make five new requests in an hour, whatever became of them, and refuses the sixth", async () => {
    const r = await room("org_ah_rate");
    await switchedOn(async () => {
      for (let n = 0; n < 5; n += 1) {
        expect((await ask(r, newName())).status, `${n}`).toBe(200);
        expect((await remove(r)).body).toEqual({ request: null });
      }
      expect(refusedBy(await ask(r, newName()))).toEqual([429, "hostname_rate_limited"]);
    });
    expect(await all(r.room, "SELECT count(*) AS n FROM hostname_request")).toEqual([{ n: 5 }]);
    // Once the five were made over an hour ago, the room may ask again.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET requested_at = requested_at - ?", 3600_000));
    expect((await switchedOn(() => ask(r, newName()))).status).toBe(200);
  });
});

describe("a room's alarms are the test's (review standard 1)", () => {
  /** The handler the runtime calls when the room's alarm comes due: here, forced to come at one chosen moment. */
  const runtimeFires = (r: Room) => runInDurableObject(stub(r.room), (instance: any) => instance.alarm());

  it("lets no run the test didn't start take the step its own pass asserts on", async () => {
    // main's CI run 43949493084, in the order that failed it. The ask leaves the room's alarm due at once, and nothing
    // here quiets the room: the runtime's own firing of that alarm comes between the test's rows and its pass, with
    // release switched off. Had it run the job, it would have recorded a look, so the test's pass found the next one a
    // minute away and the request stayed pending.
    const r = await room("org_ah_forced");
    const name = newName();
    const request = (await switchedOn(() => ask(r, name))).body.request;
    await answerWith(name, request.challenge_value);
    await rewindLook(r);
    await runtimeFires(r);
    expect(await requestRow(r)).toMatchObject({ state: "pending", checked_at: null });
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
  });

  it("runs the job on the runtime's firing again once the room is given back, so the switch is all that differs", async () => {
    // The reproduction's steps exactly, with the room given back to the runtime first: the forced firing runs the job,
    // records a look with release off, and the test's pass finds the next one a minute away.
    const r = await room("org_ah_runtime");
    const name = newName();
    const request = (await switchedOn(() => ask(r, name))).body.request;
    await runtimeAlarms(stub(r.room));
    await answerWith(name, request.challenge_value);
    await rewindLook(r);
    await runtimeFires(r);
    expect((await requestRow(r)).checked_at).not.toBeNull();
    await pass(r);
    expect(await requestRow(r)).toMatchObject({ state: "pending", proved_at: null });
  });

  it("still reports an alarm set due at once, which the runtime's firing took, until the test's own pass", async () => {
    const r = await room("org_ah_held");
    // A wake wrongly set due at once, then what the runtime does with it: it calls the handler, which runs nothing here,
    // and deletes the alarm it fired.
    await runInDurableObject(stub(r.room), (_: any, state: any) => state.storage.setAlarm(Date.now()));
    await runtimeFires(r);
    await runInDurableObject(stub(r.room), (_: any, state: any) => state.storage.deleteAlarm());
    // A check that no wake is set, or none soon, still fails on it.
    expect(await nextAlarm(stub(r.room))).not.toBeNull();
    await expect(expectNoAlarmSooner(stub(r.room), 60 * 1000)).rejects.toThrow(/sooner than/);
    // Quieted, it is gone: the pass ran the job it was owed.
    await alarmQuiet(stub(r.room));
    expect(await nextAlarm(stub(r.room))).toBeNull();
  });

  it("reports the alarm the room set after one the runtime's firing took, not the one taken", async () => {
    // As a pass that sets a wake due at once part way through and its own next wake at the end does (main's CI, PR 406's
    // release-uncertain run): the alarm set later is the room's next one, and the one taken is no longer reported.
    const r = await room("org_ah_superseded");
    await runInDurableObject(stub(r.room), (_: any, state: any) => state.storage.setAlarm(Date.now()));
    await runtimeFires(r);
    const later = Date.now() + 60 * 60 * 1000;
    await runInDurableObject(stub(r.room), async (_: any, state: any) => {
      await state.storage.deleteAlarm();
      await state.storage.setAlarm(later);
    });
    expect(await nextAlarm(stub(r.room))).toBe(later);
    await expectNoAlarmSooner(stub(r.room), 60 * 1000);
  });

  it("is read only by a test build: the route, the table and the flag are compiled only under the feature", () => {
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const files = Object.entries(sources);
    // The table and the route are named in one file, which a deployed build doesn't compile.
    expect(files.filter(([, text]) => text.includes("test_alarms_manual")).map(([file]) => file)).toEqual(["workspace/test_alarms.rs"]);
    expect(files.filter(([, text]) => text.includes("/internal/test-alarm-pass")).map(([file]) => file)).toEqual(["workspace/test_alarms.rs"]);
    expect(sources["workspace.rs"]).toMatch(/#\[cfg\(feature = "failpoints"\)\]\nmod test_alarms;/);
    // Each item in it is under the feature too.
    const module = sources["workspace/test_alarms.rs"];
    expect(module.match(/^pub\(\w+\) (const|fn|async fn) /gm)).toHaveLength(3);
    expect(module.match(/#\[cfg\(feature = "failpoints"\)\]\npub\(\w+\) (const|fn|async fn) /g)).toHaveLength(3);
    // Every use of it, and of the flag that marks the test's pass, sits just under the feature's attribute.
    const lines = sources["workspace.rs"].split("\n");
    const uses = lines.flatMap((line, i) => (/test_alarms::|test_pass/.test(line) ? [i] : []));
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const i of uses) expect(lines.slice(Math.max(0, i - 4), i).join("\n"), lines[i]).toContain('#[cfg(feature = "failpoints")]');
  });
});
