import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";

// M8 step 7, `POST /v1/preview-access` (docs/m8-preview-plan.md, 5.3 to 5.7; decisions 252, 255 and 258): who gets a
// ticket for a preview host, what the API signs, where it sends the browser, the two limits, and the access epoch's
// raises. The room's preview is written into its rows directly, a slot and its label as step 6's request makes them, so
// nothing here uploads or serves; what serving does with a ticket is the content Worker's (M8 step 8).
//
// The ticket key is a throwaway per run (`PREVIEW_TICKET_KEY` in vitest.config.ts); its public half is
// `TEST_PREVIEW_TICKET_PUBLIC`, which these tests check every signature with, as the content Worker will.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
let ticketKey: CryptoKey;
type Who = { id: string; kind?: "agent" | "person"; org: string; orgs?: string[]; adminOrgs?: string[] };
const ORG = "org_pa";
const GUEST_ORG = "org_pa_guest";
const OWNER: Who = { id: "per_pa_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_pa_admin", kind: "person", org: ORG };
const MEMBER: Who = { id: "per_pa_member", kind: "person", org: ORG };
// A person from another organization with an accepted invitation: a role of their own here (decision 239).
const GUEST: Who = { id: "per_pa_Guest", kind: "person", org: GUEST_ORG };
const AGENT: Who = { id: "agt_pa_agent", kind: "agent", org: ORG };
const OUTSIDER: Who = { id: "per_pa_outsider", kind: "person", org: "org_pa_other" };
// The member, asserted as no longer in the organization their place is held in.
const MEMBER_LEFT: Who = { id: "per_pa_member", kind: "person", org: "org_pa_other" };

async function assertion(who: Who, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: 1 }
    : { kind: "person", org: who.org, orgs: who.orgs ?? [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...extra };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, raw?: string, extra?: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who, extra), "idempotency-key": `pa-key-${++counter}`, "x-test-public-rooms": "on" };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : raw ?? JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, retryAfter: res.headers.get("retry-after"), text };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (id: string, query: string, ...bindings: unknown[]) => inRoom(id, (sql) => sql.exec(query, ...bindings).toArray() as any[]);
const inPrincipal = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(id)), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;

async function switches(on: { releases?: boolean; previews?: boolean | string; keyOff?: boolean }) {
  for (const table of ["test_releases_on", "test_previews_on", "test_previews_setting", "test_preview_key_off"]) await BINDINGS.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  if (on.releases) await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  if (on.previews === true) await BINDINGS.DB.prepare("CREATE TABLE test_previews_on (x INTEGER)").run();
  if (typeof on.previews === "string") {
    await BINDINGS.DB.prepare("CREATE TABLE test_previews_setting (value TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_previews_setting (value) VALUES (?)").bind(on.previews).run();
  }
  if (on.keyOff) await BINDINGS.DB.prepare("CREATE TABLE test_preview_key_off (x INTEGER)").run();
}

// --- a room with people of every role, a production label, and a preview ---------------------------------------------
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const made: string[] = [];
type Room = { id: string; label: string; host: string; slot: string; prodHost: string };

async function room(opts: { epoch?: number; preview?: boolean; visibility?: "public" | "private" } = {}): Promise<Room> {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Preview access room" })).body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const label = `pa${hex(8)}`;
  const prodLabel = `pa${hex(8)}`;
  const slot = `pvw_${hex(16)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(id, (sql) => {
    for (const [who, role, org] of [[ADMIN, "admin", ORG], [MEMBER, "member", ORG], [GUEST, "guest", GUEST_ORG]] as const) {
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, OWNER.id);
    }
    sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, ORG, OWNER.id);
    if ((opts.visibility ?? "private") === "public") sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `pa-${label}`);
    sql.exec("INSERT INTO app_label (label, kind, current, created_at, indexed_at) VALUES (?, 'production', 1, 1, 1)", prodLabel);
    if (opts.preview ?? true) {
      sql.exec("INSERT INTO app_label (label, kind, created_at, indexed_at) VALUES (?, 'preview', 1, 1)", label);
      sql.exec("INSERT INTO preview_slot (id, label, current, access_epoch, created_at, updated_at) VALUES (?, ?, 1, ?, 1, 1)", slot, label, opts.epoch ?? 4);
      sql.exec("INSERT INTO preview_apply (host, slot_id, applied_value, confirmed, applied_at, attempts, next_attempt_at, updated_at) VALUES (?, ?, NULL, 1, 1, 3, 99999999999999, 1)", host, slot);
    }
  });
  for (const l of [label, prodLabel]) await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(l, id).run();
  return { id, label, host, slot, prodHost: `${prodLabel}.${FAKE.domain}` };
}

/** A canonical state hash: the SHA-256 of a random state, base64url with no padding. */
async function stateHash() {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", crypto.getRandomValues(new Uint8Array(32))));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const ask = async (who: Who, body: Record<string, unknown>) => api(who, "POST", "/v1/preview-access", body);

const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
/** A token's claims, once its signature checks out with the run's public key over the fixed label and its payload. */
async function verified(token: string) {
  const [payload, signature, ...rest] = token.split(".");
  expect(rest).toEqual([]);
  const message = new TextEncoder().encode(`podster-preview-token/v1.${payload}`);
  expect(await crypto.subtle.verify("Ed25519", ticketKey, fromB64url(signature), message), "signature").toBe(true);
  const tampered = new TextEncoder().encode(`podster-preview-token/v1.${payload}x`);
  expect(await crypto.subtle.verify("Ed25519", ticketKey, fromB64url(signature), tampered)).toBe(false);
  return { json: new TextDecoder().decode(fromB64url(payload)), claims: JSON.parse(new TextDecoder().decode(fromB64url(payload))) };
}
/** The redirect's parts: the host and path before `#`, and the fragment's three values. */
function location(redirect: string) {
  const [before, fragment] = redirect.split("#");
  const url = new URL(before);
  const params = new URLSearchParams(fragment);
  return { url, before, t: params.get("t") ?? "", s: params.get("s") ?? "", r: params.get("r"), keys: [...params.keys()] };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  ticketKey = await crypto.subtle.importKey("raw", fromB64url(BINDINGS.TEST_PREVIEW_TICKET_PUBLIC), { name: "Ed25519" }, false, ["verify"]);
  const registered = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: ORG, name: AGENT.id }) });
  if (registered.status !== 200) throw new Error(`register: ${registered.status}`);
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});
beforeEach(async () => {
  await switches({ releases: true, previews: true });
  // Each test starts with every person's 30 a minute unspent.
  for (const who of [OWNER, ADMIN, MEMBER, GUEST, OUTSIDER]) await inPrincipal(who.id, (sql) => sql.exec("DROP TABLE IF EXISTS preview_access_ask"));
});
afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
  await switches({});
});

describe("POST /v1/preview-access: who gets a ticket (M8 step 7)", () => {
  it("gives the owner, an admin, a member and a guest from another organization a ticket and a session, both signed, bound to the host, slot, epoch and state", async () => {
    const r = await room({ epoch: 4 });
    for (const who of [OWNER, ADMIN, MEMBER, GUEST]) {
      const st = await stateHash();
      const before = Date.now();
      const answer = await ask(who, { host: r.host, st, r: "/app/page?x=1&y=2" });
      expect(answer.status, `${who.id}: ${answer.text}`).toBe(200);
      expect(Object.keys(answer.body)).toEqual(["redirect"]);
      const at = location(answer.body.redirect);
      // The ticket and the session are only after `#`: nothing in the path or a query.
      expect(at.before).toBe(`https://${r.host}/__podster/enter`);
      expect(at.url.search).toBe("");
      expect(at.keys).toEqual(["t", "s", "r"]);
      expect(at.r).toBe("/app/page?x=1&y=2");
      const ticket = await verified(at.t);
      const session = await verified(at.s);
      expect(Object.keys(ticket.claims)).toEqual(["typ", "kid", "aud", "pvw", "sid", "ep", "iat", "exp", "st"]);
      expect(ticket.claims).toMatchObject({ typ: "ticket", kid: "test-run", aud: r.host, pvw: r.slot, ep: 4, st });
      expect(session.claims).toMatchObject({ typ: "session", kid: "test-run", aud: r.host, pvw: r.slot, ep: 4, st, sid: ticket.claims.sid });
      // 60 seconds for the ticket, an hour for the session, from now.
      expect(ticket.claims.iat).toBeGreaterThanOrEqual(before - 1000);
      expect(ticket.claims.iat).toBeLessThanOrEqual(Date.now() + 1000);
      expect(ticket.claims.exp - ticket.claims.iat).toBe(60_000);
      expect(session.claims.exp - session.claims.iat).toBe(3_600_000);
      expect(ticket.claims.sid).toMatch(/^pvs_[0-9a-f]{32}$/);
      // No person ID in either: the room maps the session to the person.
      expect(ticket.json).not.toContain(who.id);
      expect(session.json).not.toContain(who.id);
      const rows = await all(r.id, "SELECT person_id, created_at, expires_at FROM preview_session WHERE sid = ?", ticket.claims.sid);
      expect(rows).toEqual([{ person_id: who.id, created_at: ticket.claims.iat, expires_at: ticket.claims.iat + 3_600_000 }]);
    }
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_access_ask"))[0].n).toBe(4);
  });

  it("gives every ask a new session, and a public room's preview is gated the same way (decision 252)", async () => {
    const r = await room({ visibility: "public" });
    const st = await stateHash();
    const first = location((await ask(MEMBER, { host: r.host, st, r: "/" })).body.redirect);
    const second = location((await ask(MEMBER, { host: r.host, st, r: "/" })).body.redirect);
    expect((await verified(first.t)).claims.sid).not.toBe((await verified(second.t)).claims.sid);
    expect((await ask(OUTSIDER, { host: r.host, st, r: "/" })).code).toBe("preview_access_refused");
  });

  it("answers every refusal the same: wrong organization, a place that no longer holds, a production host, another room's host, an unknown or misspelt host, no preview", async () => {
    const r = await room();
    const other = await room();
    const bare = await room({ preview: false });
    const st = await stateHash();
    const refusals: [string, Who, string][] = [
      ["an outsider from another organization", OUTSIDER, r.host],
      ["a member asserted outside the organization their place is held in", MEMBER_LEFT, r.host],
      ["the room's production host", OWNER, r.prodHost],
      ["another room's preview host, to someone outside that room", MEMBER, other.host],
      ["an unknown label", OWNER, `pa${hex(8)}.${FAKE.domain}`],
      ["a host in upper case", OWNER, r.host.toUpperCase()],
      ["a host a level deeper", OWNER, `x.${r.host}`],
      ["a host off the content domain", OWNER, `${r.label}.example.com`],
      ["the content domain itself", OWNER, FAKE.domain],
      ["a room with no preview", OWNER, bare.host],
    ];
    await inRoom(other.id, (sql) => sql.exec("DELETE FROM member WHERE principal_id = ?", MEMBER.id));
    const bodies = new Set<string>();
    for (const [what, who, host] of refusals) {
      const answer = await ask(who, { host, st, r: "/" });
      expect([answer.status, answer.code], what).toEqual([404, "preview_access_refused"]);
      bodies.add(answer.text);
    }
    expect(bodies.size, "one body for every refusal").toBe(1);
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_session"))[0].n).toBe(0);
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_access_ask"))[0].n).toBe(0);
  });

  it("refuses a deleted slot's host, a retired label and a suspended or held preview, by the slot it names", async () => {
    const st = await stateHash();
    const deleted = await room();
    await inRoom(deleted.id, (sql) => sql.exec("UPDATE preview_slot SET current = NULL, deleted_at = 2 WHERE id = ?", deleted.slot));
    const retired = await room();
    await inRoom(retired.id, (sql) => sql.exec("UPDATE app_label SET retired_at = 2 WHERE label = ?", retired.label));
    const suspended = await room();
    await inRoom(suspended.id, (sql) => sql.exec("UPDATE app_label SET suspended_at = 2, suspension_reason = 'abuse' WHERE label = ?", suspended.label));
    // A later slot on the room: the old label's host is no longer its preview host.
    const replaced = await room();
    const newLabel = `pa${hex(8)}`;
    await inRoom(replaced.id, (sql) => {
      sql.exec("UPDATE preview_slot SET current = NULL, deleted_at = 2 WHERE id = ?", replaced.slot);
      sql.exec("UPDATE app_label SET retired_at = 2 WHERE label = ?", replaced.label);
      sql.exec("INSERT INTO app_label (label, kind, created_at, indexed_at) VALUES (?, 'preview', 3, 3)", newLabel);
      sql.exec("INSERT INTO preview_slot (id, label, current, access_epoch, created_at, updated_at) VALUES (?, ?, 1, 0, 3, 3)", `pvw_${hex(16)}`, newLabel);
    });
    for (const [what, r] of [["deleted", deleted], ["retired", retired], ["suspended", suspended], ["replaced", replaced]] as const) {
      expect((await ask(OWNER, { host: r.host, st, r: "/" })).code, what).toBe("preview_access_refused");
    }
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 3)").bind(newLabel, replaced.id).run();
    const fresh = location((await ask(OWNER, { host: `${newLabel}.${FAKE.domain}`, st, r: "/" })).body.redirect);
    const claims = (await verified(fresh.t)).claims;
    expect(claims.pvw).not.toBe(replaced.slot);
    expect(claims.ep).toBe(0);
  });

  it("refuses an agent by its kind, whatever role is stored for it (decision 253)", async () => {
    const r = await room();
    const answer = await ask(AGENT, { host: r.host, st: await stateHash(), r: "/" });
    expect([answer.status, answer.code]).toEqual([403, "not_allowed"]);
  });

  it("refuses a person here only through a public claim", async () => {
    const r = await room({ visibility: "public" });
    await inRoom(r.id, (sql) => sql.exec("UPDATE member SET role = 'guest', joined_via = 'public' WHERE principal_id = ?", MEMBER.id));
    expect((await ask(MEMBER, { host: r.host, st: await stateHash(), r: "/" })).code).toBe("preview_access_refused");
  });

  it("takes exactly host, st and r: no st, a state hash not of its form, a return path to another host, or anything more is invalid_argument", async () => {
    const r = await room();
    const st = await stateHash();
    const bad: [string, unknown][] = [
      ["no st", { host: r.host, r: "/" }],
      ["no host", { st, r: "/" }],
      ["no r", { host: r.host, st }],
      ["an extra field", { host: r.host, st, r: "/", ticket: "x" }],
      ["st too short", { host: r.host, st: st.slice(1), r: "/" }],
      ["st with padding", { host: r.host, st: `${st.slice(0, 42)}=`, r: "/" }],
      ["st not canonical", { host: r.host, st: `${st.slice(0, 42)}B`, r: "/" }],
      ["r to another host", { host: r.host, st, r: "//evil.example/" }],
      ["r with a backslash", { host: r.host, st, r: "/\\evil.example" }],
      ["r with a space", { host: r.host, st, r: "/a b" }],
      ["r not a path", { host: r.host, st, r: "https://evil.example/" }],
      ["a number for a host", { host: 7, st, r: "/" }],
      ["a host too long", { host: `${"a".repeat(250)}.${FAKE.domain}`, st, r: "/" }],
      ["a list", [r.host, st, "/"]],
    ];
    for (const [what, body] of bad) expect((await ask(OWNER, body as any)).code, what).toBe("invalid_argument");
    expect((await api(OWNER, "POST", "/v1/preview-access", undefined, "not json")).code).toBe("invalid_argument");
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_session"))[0].n).toBe(0);
  });
});

describe("POST /v1/preview-access while it isn't there", () => {
  it("is a path nobody defined while release or previews are off or undecided, or the owner's key isn't set, whoever asks", async () => {
    const r = await room();
    const st = await stateHash();
    for (const [what, on] of [
      ["release off", { previews: true }],
      ["previews off", { releases: true }],
      ["previews false", { releases: true, previews: "false" }],
      ["previews undecided", { releases: true, previews: "yes" }],
      ["the key absent", { releases: true, previews: true, keyOff: true }],
    ] as const) {
      await switches(on);
      for (const who of [OWNER, AGENT, OUTSIDER]) {
        const answer = await ask(who, { host: r.host, st, r: "/" });
        expect([answer.status, answer.code], `${what}, ${who.id}`).toEqual([404, "not_found"]);
      }
      // Nothing is counted and nothing is signed while it isn't there.
      expect((await all(r.id, "SELECT count(*) AS n FROM preview_session"))[0].n, what).toBe(0);
    }
    expect(await inPrincipal(OWNER.id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name = 'preview_access_ask'").toArray().length)).toBe(0);
  });

  it("answers only POST", async () => {
    await room();
    for (const method of ["GET", "PUT", "DELETE"]) expect((await api(OWNER, method, "/v1/preview-access", {})).code, method).toBe("not_found");
  });
});

describe("the limits (the plan's 5.3, step 2)", () => {
  it("refuses a person past 30 asks a minute, counted in their own Principal whether or not each was granted, with Retry-After", async () => {
    const r = await room();
    const st = await stateHash();
    for (let i = 0; i < 30; i++) {
      const host = i % 2 ? r.host : `pa${hex(8)}.${FAKE.domain}`;
      expect((await ask(MEMBER, { host, st, r: "/" })).status, `ask ${i}`).not.toBe(429);
    }
    const over = await ask(MEMBER, { host: r.host, st, r: "/" });
    expect([over.status, over.code]).toEqual([429, "preview_access_limit"]);
    expect(Number(over.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(over.retryAfter)).toBeLessThanOrEqual(60);
    // Someone else's minute is their own.
    expect((await ask(ADMIN, { host: r.host, st, r: "/" })).status).toBe(200);
    // A minute on, the asks have left the window.
    await inPrincipal(MEMBER.id, (sql) => sql.exec("UPDATE preview_access_ask SET at = at - 61000"));
    expect((await ask(MEMBER, { host: r.host, st, r: "/" })).status).toBe(200);
    expect(await inPrincipal(MEMBER.id, (sql) => sql.exec("SELECT count(*) AS n FROM preview_access_ask").one().n)).toBe(1);
  });

  it("refuses a room past 300 granted asks an hour, after who is asking, so an outsider is still refused and never spends it", async () => {
    const r = await room();
    const st = await stateHash();
    const now = Date.now();
    await inRoom(r.id, (sql) => { for (let i = 0; i < 300; i++) sql.exec("INSERT INTO preview_access_ask (at) VALUES (?)", now - i * 1000); });
    const over = await ask(MEMBER, { host: r.host, st, r: "/" });
    expect([over.status, over.code]).toEqual([429, "preview_access_limit"]);
    expect(Number(over.retryAfter)).toBeGreaterThan(3000);
    expect(Number(over.retryAfter)).toBeLessThanOrEqual(3600);
    expect((await ask(OUTSIDER, { host: r.host, st, r: "/" })).code).toBe("preview_access_refused");
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_access_ask"))[0].n).toBe(300);
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_session"))[0].n).toBe(0);
    // An hour on, the oldest have gone and the room is asked again; the stale rows are pruned as it counts.
    await inRoom(r.id, (sql) => sql.exec("UPDATE preview_access_ask SET at = at - 3601000 WHERE at <= ?", now - 299_000));
    expect((await ask(MEMBER, { host: r.host, st, r: "/" })).status).toBe(200);
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_access_ask"))[0].n).toBe(300);
  });

  it("refuses one person past 60 tickets an hour in one room, so no one viewer spends the room's 300; others still get theirs", async () => {
    const r = await room();
    const st = await stateHash();
    const now = Date.now();
    await inRoom(r.id, (sql) => {
      for (let i = 0; i < 60; i++) {
        sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)", `pvs_${hex(16)}`, GUEST.id, now - i * 1000, now - i * 1000 + 3_600_000);
        sql.exec("INSERT INTO preview_access_ask (at) VALUES (?)", now - i * 1000);
      }
    });
    const over = await ask(GUEST, { host: r.host, st, r: "/" });
    expect([over.status, over.code]).toEqual([429, "preview_access_limit"]);
    expect(Number(over.retryAfter)).toBeGreaterThan(3500);
    expect(Number(over.retryAfter)).toBeLessThanOrEqual(3600);
    // The refusal spends nothing of the room's, and every other viewer is still let in.
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_access_ask"))[0].n).toBe(60);
    for (const who of [OWNER, ADMIN, MEMBER]) expect((await ask(who, { host: r.host, st, r: "/" })).status, who.id).toBe(200);
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_access_ask"))[0].n).toBe(63);
    // An outsider asking is refused as always, whatever anyone's count.
    expect((await ask(OUTSIDER, { host: r.host, st, r: "/" })).code).toBe("preview_access_refused");
    // An hour on, the guest's own tickets have left the window.
    await inRoom(r.id, (sql) => sql.exec("UPDATE preview_session SET created_at = created_at - 3601000, expires_at = expires_at - 3601000 WHERE person_id = ?", GUEST.id));
    expect((await ask(GUEST, { host: r.host, st, r: "/" })).status).toBe(200);
  });

  it("prunes sessions past their hour as it records a new one", async () => {
    const r = await room();
    await inRoom(r.id, (sql) => sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, ?, 1000, 3601000)", `pvs_${hex(16)}`, MEMBER.id));
    expect((await ask(MEMBER, { host: r.host, st: await stateHash(), r: "/" })).status).toBe(200);
    expect((await all(r.id, "SELECT count(*) AS n FROM preview_session WHERE expires_at <= 3601000"))[0].n).toBe(0);
  });
});

describe("revocation: the access epoch (the plan's 5.6)", () => {
  const version = async (r: Room) => (await all(r.id, "SELECT policy_version FROM workspace"))[0].policy_version;
  async function expectRaised(r: Room, from: number, reason: string) {
    const [slot] = await all(r.id, "SELECT access_epoch FROM preview_slot WHERE id = ?", r.slot);
    expect(slot.access_epoch, reason).toBe(from + 1);
    // Every host's entry is owed again at once, so the applier writes the new epoch.
    expect(await all(r.id, "SELECT attempts, next_attempt_at FROM preview_apply WHERE slot_id = ?", r.slot)).toEqual([{ attempts: 0, next_attempt_at: null }]);
    const told = await all(r.id, "SELECT type, actor_id, reason FROM event WHERE type = 'preview.access_revoked' ORDER BY seq DESC LIMIT 1");
    expect(told[0]?.reason, reason).toBe(reason);
  }

  it("goes up when a person is removed, and the next ticket carries it; the removed person is refused", async () => {
    const r = await room({ epoch: 4 });
    const st = await stateHash();
    expect((await ask(MEMBER, { host: r.host, st, r: "/" })).status).toBe(200);
    const removed = await api(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${MEMBER.id}`, { policy_version: await version(r) });
    expect(removed.status, removed.text).toBe(200);
    await expectRaised(r, 4, "participant_removed");
    expect((await ask(MEMBER, { host: r.host, st, r: "/" })).code).toBe("preview_access_refused");
    const after = location((await ask(ADMIN, { host: r.host, st, r: "/" })).body.redirect);
    expect((await verified(after.t)).claims.ep).toBe(5);
    expect((await verified(after.s)).claims.ep).toBe(5);
  });

  it("goes up when a person's role is lowered, and not when an agent is removed", async () => {
    const r = await room({ epoch: 4 });
    const lowered = await api(OWNER, "POST", `/v1/workspaces/${r.id}/members/${ADMIN.id}/role`, { role: "member", policy_version: await version(r) }, undefined, { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } });
    expect(lowered.status, lowered.text).toBe(200);
    await expectRaised(r, 4, "role_lowered");
    const agentGone = await api(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${AGENT.id}`, { policy_version: await version(r) });
    expect(agentGone.status, agentGone.text).toBe(200);
    expect((await all(r.id, "SELECT access_epoch FROM preview_slot"))[0].access_epoch).toBe(5);
  });

  it("goes up when the room is made private, and the private room keeps its preview (decision 251)", async () => {
    const r = await room({ epoch: 4, visibility: "public" });
    const made = await api(OWNER, "PUT", `/v1/workspaces/${r.id}/visibility`, { visibility: "private" });
    expect(made.status, made.text).toBe(200);
    await expectRaised(r, 4, "visibility_changed");
    expect((await all(r.id, "SELECT current FROM preview_slot WHERE id = ?", r.slot))[0].current).toBe(1);
    expect((await ask(MEMBER, { host: r.host, st: await stateHash(), r: "/" })).status).toBe(200);
  });

  it("goes up when the owner hands the room over, and the former owner, now an admin, still gets a ticket at the new epoch", async () => {
    const r = await room({ epoch: 4 });
    const done = await api(OWNER, "POST", `/v1/workspaces/${r.id}/owner/transfer`, { to: ADMIN.id, policy_version: await version(r) }, undefined, { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } });
    expect(done.status, done.text).toBe(200);
    await expectRaised(r, 4, "owner_changed");
    const after = location((await ask(OWNER, { host: r.host, st: await stateHash(), r: "/" })).body.redirect);
    expect((await verified(after.t)).claims.ep).toBe(5);
  });

  it("goes up when the owner leaves the organization, which refuses them, and again when an organization admin names a new owner", async () => {
    const r = await room({ epoch: 4 });
    const left = await stub(r.id).fetch("https://workspace/internal/org-departure", { method: "POST", body: JSON.stringify({ person: OWNER.id, org: ORG, actor: "per_pa_orgadmin", left_at: Date.now() }) });
    expect(left.status, await left.text()).toBe(200);
    await expectRaised(r, 4, "organization_departure");
    expect((await ask(OWNER, { host: r.host, st: await stateHash(), r: "/" })).code).toBe("preview_access_refused");
    const orgAdmin: Who = { id: "per_pa_orgadmin", kind: "person", org: ORG, adminOrgs: [ORG] };
    const recovered = await api(orgAdmin, "POST", `/v1/workspaces/${r.id}/owner/recover`, { to: ADMIN.id, expected_owner: OWNER.id }, undefined, { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } });
    expect(recovered.status, recovered.text).toBe(200);
    const [slot] = await all(r.id, "SELECT access_epoch FROM preview_slot WHERE id = ?", r.slot);
    expect(slot.access_epoch).toBe(6);
    const told = await all(r.id, "SELECT reason FROM event WHERE type = 'preview.access_revoked' ORDER BY seq");
    expect(told.map((row) => row.reason)).toEqual(["organization_departure", "owner_changed"]);
  });

  it("raises nothing in a room with no preview", async () => {
    const r = await room({ preview: false });
    const removed = await api(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${MEMBER.id}`, { policy_version: await version(r) });
    expect(removed.status, removed.text).toBe(200);
    expect(await all(r.id, "SELECT type FROM event WHERE type = 'preview.access_revoked'")).toEqual([]);
  });
});
