import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Runner pairing (M7 step 5(a), decision 222, RUNNER.md "Proposed one-agent pairing proof of concept"): the session on the
// new agent's Principal, its code verifier, attempt limits that fail closed, and single-outcome activation. The gateway's
// routes (step 5(b)) and screens (5(c)) aren't built, so these tests sign as the gateway would.

const BINDINGS = env as any;
let key: any;
type Person = { id: string; org: string; adminOrgs?: string[]; orgSince?: Record<string, number> };
const ORG = "org_pair";
const OTHER_ORG = "org_pair_other";
const LONG_AGO = 1_000;

let counter = 0;
/** A fresh admin of ORG, so each test's start limit is its own. */
function admin(extra: Partial<Person> = {}): Person {
  return { id: `per_pair_${++counter}_${crypto.randomUUID().slice(0, 8)}`, org: ORG, adminOrgs: [ORG], orgSince: { [ORG]: LONG_AGO }, ...extra };
}

async function personAssertion(who: Person) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: Object.keys(who.orgSince ?? { [who.org]: 0 }), admin_orgs: who.adminOrgs ?? [], org_since: who.orgSince ?? {} })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

async function agentAssertion(id: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "agent", org: ORG, gen: 1 })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Proof = { agent?: string; thumbprint?: string; proofJti?: string; proofExp?: number; bodyHash?: string; extra?: Record<string, unknown> };
/** The gateway's redemption assertion: it checked a proof signed by the key with this thumbprint, over this proof ID, for this session. */
async function redeemAssertion(body: string, proof: Proof = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    kind: "pairing_redeem",
    agent_id: proof.agent ?? "agt_unnamed",
    key_thumbprint: proof.thumbprint ?? KEY,
    proof_jti: proof.proofJti ?? crypto.randomUUID(),
    proof_exp: proof.proofExp ?? now + 60,
    body_sha256: proof.bodyHash ?? (await sha256Hex(body)),
    ...proof.extra,
  }).setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

async function call(assertion: string, method: string, path: string, body?: string) {
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers: { "x-podster-assertion": assertion, "content-type": "application/json" }, body });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

const person = async (who: Person, method: string, path: string, body?: unknown) =>
  call(await personAssertion(who), method, path, body === undefined ? undefined : JSON.stringify(body));

async function redeem(agent: string, code: string, proof: Proof = {}) {
  const body = JSON.stringify({ code });
  return call(await redeemAssertion(body, { agent, ...proof }), "POST", `/v1/pairing/${agent}/redeem`, body);
}

// Base64url, as the plugin's enrollment token and an RFC 7638 thumbprint are.
const KEY = "K".repeat(43);
const OTHER_KEY = "Q".repeat(43);
const newCode = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function start(who: Person, extra: Record<string, unknown> = {}) {
  const code = newCode();
  const res = await person(who, "POST", "/v1/pairing", { org_id: ORG, plugin_host_id: `host_${crypto.randomUUID().slice(0, 8)}`, code, name: "Runner on a Mac", ...extra });
  expect(res.status, res.text).toBe(200);
  return { agent: res.body.agent_id as string, code, answer: res.body, hostId: res.body.plugin_host_id as string };
}

const principal = (name: string) => BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(name));
const tables = (name: string) =>
  runInDurableObject(principal(name), (_: any, state: any) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => r.name));
/** Everything the object holds, as text, to show what it never keeps. */
const everything = (name: string) =>
  runInDurableObject(principal(name), (_: any, state: any) => {
    const sql = state.storage.sql;
    const names = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => r.name);
    return JSON.stringify(names.map((n: string) => sql.exec(`SELECT * FROM "${n}"`).toArray()));
  });
const expire = (agent: string) =>
  runInDurableObject(principal(agent), (_: any, state: any) => { state.storage.sql.exec("UPDATE pairing_session SET expires_at = ?", Date.now() - 1); });
const internalCheck = (agent: string) =>
  principal(agent).fetch("https://principal.internal/internal/check", { method: "POST", body: JSON.stringify({ gen: 1 }) });

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("starting a session", () => {
  it("is for a person who administers the organization, and makes a new agent's session with no code in its answer", async () => {
    const who = admin();
    const before = Date.now();
    const { agent, code, answer, hostId } = await start(who);
    expect(agent).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(answer).toMatchObject({ agent_id: agent, org_id: ORG, status: "pending", plugin_host_id: hostId, name: "Runner on a Mac" });
    // Ten minutes, inside the plugin's hour.
    expect(answer.expires_at).toBeGreaterThanOrEqual(before + 600_000);
    expect(answer.expires_at).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(JSON.stringify(answer)).not.toContain(code);
    // The object keeps a verifier, never the code.
    expect(await everything(agent)).not.toContain(code);
  });

  it("refuses someone who doesn't administer the organization, an agent, and a bad request", async () => {
    const member = admin({ adminOrgs: [] });
    expect((await person(member, "POST", "/v1/pairing", { org_id: ORG, plugin_host_id: "host_1", code: newCode() })).code).toBe("not_allowed");
    const other = admin({ adminOrgs: [OTHER_ORG] });
    expect((await person(other, "POST", "/v1/pairing", { org_id: ORG, plugin_host_id: "host_1", code: newCode() })).code).toBe("not_allowed");
    const asAgent = await call(await agentAssertion("agt_pair_someone"), "POST", "/v1/pairing", JSON.stringify({ org_id: ORG, plugin_host_id: "host_1", code: newCode() }));
    expect(asAgent.status).toBeGreaterThanOrEqual(400);
    const who = admin();
    for (const body of [
      { org_id: ORG, plugin_host_id: "host_1", code: "short" },
      { org_id: ORG, plugin_host_id: "host_1", code: `${newCode()}=` },
      { org_id: ORG, plugin_host_id: "host 1", code: newCode() },
      { org_id: ORG, code: newCode() },
      { org_id: ORG, plugin_host_id: "host_1" },
      { org_id: ORG, plugin_host_id: "host_1", code: newCode(), name: "x".repeat(201) },
      { org_id: ORG, plugin_host_id: "host_1", code: newCode(), name: 7 },
    ]) {
      const res = await person(who, "POST", "/v1/pairing", body);
      expect(res.code, JSON.stringify(body)).toBe("invalid_argument");
    }
    expect((await person(who, "POST", "/v1/pairing", "not json")).code).toBe("invalid_argument");
  });

  it("allows five an hour per person, counted before the session is made, and refuses the sixth", async () => {
    const who = admin();
    for (let n = 0; n < 5; n++) await start(who);
    const sixth = await person(who, "POST", "/v1/pairing", { org_id: ORG, plugin_host_id: "host_1", code: newCode() });
    expect(sixth.status).toBe(409);
    expect(sixth.code).toBe("limit_exceeded");
    // Another person isn't affected.
    await start(admin());
  });

  it("refuses when the person's count can't be read, rather than starting without one", async () => {
    const who = admin();
    // A count the object can't read stands for a store that's failing.
    await runInDurableObject(principal(who.id), (_: any, state: any) => { state.storage.sql.exec("CREATE TABLE pairing_start (broken TEXT)"); });
    const res = await person(who, "POST", "/v1/pairing", { org_id: ORG, plugin_host_id: "host_1", code: newCode() });
    expect(res.status).toBe(500);
  });
});

describe("while a session waits", () => {
  it("there's no agent: no connection, no reads, and no registration outside the session", async () => {
    const who = admin();
    const { agent } = await start(who);
    expect((await person(who, "GET", `/v1/agents/${agent}`)).code).toBe("agent_not_found");
    expect((await internalCheck(agent)).status).toBe(403);
    // An admin can't register the agent around the session.
    const around = await person(who, "PUT", `/v1/agents/${agent}`, { org_id: ORG, name: "sneaky" });
    expect(around.code).toBe("not_allowed");
    expect(await tables(agent)).not.toContain("connection");
    // A code for another of the person's sessions is a wrong code here, and makes nothing.
    expect((await redeem(agent, (await start(who)).code)).code).toBe("not_allowed");
    expect((await person(who, "GET", `/v1/agents/${agent}`)).code).toBe("agent_not_found");
  });

  it("only its starter reads it, and the read shows its state and history with IDs and reasons only", async () => {
    const who = admin();
    const { agent, code, hostId } = await start(who);
    const read = await person(who, "GET", `/v1/pairing/${agent}`);
    expect(read.status, read.text).toBe(200);
    expect(read.body).toMatchObject({ agent_id: agent, org_id: ORG, status: "pending", plugin_host_id: hostId, key_thumbprint: null, attempts_left: 5 });
    expect(read.body.history.map((e: any) => e.type)).toEqual(["pairing.started"]);
    // Another admin of the same organization, someone else, and an agent learn nothing, not even that it exists.
    expect((await person(admin(), "GET", `/v1/pairing/${agent}`)).code).toBe("not_found");
    expect((await call(await agentAssertion(agent), "GET", `/v1/pairing/${agent}`)).status).toBeGreaterThanOrEqual(400);
    expect((await person(who, "GET", `/v1/pairing/agt_${"0".repeat(32)}`)).code).toBe("not_found");
    expect(read.text).not.toContain(code);
  });
});

describe("redeeming the code", () => {
  it("binds the key whose proof the gateway checked, once", async () => {
    const who = admin();
    const { agent, code, hostId } = await start(who);
    const res = await redeem(agent, code);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ agent_id: agent, status: "redeemed", plugin_host_id: hostId, key_thumbprint: KEY });
    expect(res.text).not.toContain(code);
    const read = await person(who, "GET", `/v1/pairing/${agent}`);
    expect(read.body).toMatchObject({ status: "redeemed", key_thumbprint: KEY });
    // Still no agent: only the person's confirmation makes one.
    expect((await person(who, "GET", `/v1/agents/${agent}`)).code).toBe("agent_not_found");
  });

  it("answers a retry with the same code and key, on a fresh proof, the same way", async () => {
    const { agent, code } = await start(admin());
    expect((await redeem(agent, code)).status).toBe(200);
    const again = await redeem(agent, code);
    expect(again.status, again.text).toBe(200);
    expect(again.body.status).toBe("redeemed");
  });

  it("refuses a proof it has seen, even with the right code", async () => {
    const { agent, code } = await start(admin());
    const proofJti = crypto.randomUUID();
    expect((await redeem(agent, code, { proofJti })).status).toBe(200);
    const replay = await redeem(agent, code, { proofJti });
    // The same answer as every other refusal, so a replay tells nothing (L1).
    expect(replay.status).toBe(403);
    expect(replay.code).toBe("not_allowed");
    // A replay of a refused proof is refused the same way, and a replay to a session that doesn't exist too.
    const other = await start(admin());
    const wrongJti = crypto.randomUUID();
    expect((await redeem(other.agent, newCode(), { proofJti: wrongJti })).code).toBe("not_allowed");
    expect((await redeem(other.agent, newCode(), { proofJti: wrongJti })).code).toBe("not_allowed");
    const nobody = `agt_${"cd".repeat(16)}`;
    const ghostJti = crypto.randomUUID();
    for (let n = 0; n < 2; n++) {
      const ghost = await redeem(nobody, newCode(), { proofJti: ghostJti });
      expect(ghost.status).toBe(403);
      expect(ghost.code).toBe("not_allowed");
    }
    expect(await tables(nobody)).toEqual([]);
  });

  it("refuses a proof made for another session, even with that session's right code (M2)", async () => {
    const who = admin();
    const first = await start(who);
    const second = await start(who);
    const body = JSON.stringify({ code: second.code });
    // The proof names the first session; it's sent to the second, with the second's code.
    const crossed = await call(await redeemAssertion(body, { agent: first.agent }), "POST", `/v1/pairing/${second.agent}/redeem`, body);
    expect(crossed.status).toBe(403);
    expect(crossed.code).toBe("not_allowed");
    for (const agent of [first.agent, second.agent]) {
      expect((await person(who, "GET", `/v1/pairing/${agent}`)).body).toMatchObject({ status: "pending", key_thumbprint: null, attempts_left: 5 });
    }
    // Made for the second, it's taken.
    expect((await redeem(second.agent, second.code)).status).toBe(200);
  });

  it("forgets spent proofs once they expire, and refuses a proof that would live more than five minutes (L2)", async () => {
    const { agent, code } = await start(admin());
    await runInDurableObject(principal(agent), (_: any, state: any) => {
      state.storage.sql.exec("INSERT INTO pairing_proof (jti, expires_at) VALUES ('old-1', ?), ('old-2', ?)", Date.now() - 1, Date.now() - 60_000);
    });
    expect((await redeem(agent, newCode())).code).toBe("not_allowed");
    const kept = await runInDurableObject(principal(agent), (_: any, state: any) => state.storage.sql.exec("SELECT jti FROM pairing_proof").toArray().map((r: any) => r.jti));
    expect(kept).toHaveLength(1);
    expect(kept).not.toContain("old-1");
    expect(kept).not.toContain("old-2");
    const now = Math.floor(Date.now() / 1000);
    const tooLong = await redeem(agent, code, { proofExp: now + 360 });
    expect(tooLong.code).toBe("invalid_assertion");
    expect((await redeem(agent, code, { proofExp: now + 290 })).status).toBe(200);
  });

  it("never lets another key take a code that's spent", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    expect((await redeem(agent, code)).status).toBe(200);
    const other = await redeem(agent, code, { thumbprint: OTHER_KEY });
    expect(other.status).toBe(403);
    expect(other.code).toBe("not_allowed");
    expect((await person(who, "GET", `/v1/pairing/${agent}`)).body.key_thumbprint).toBe(KEY);
  });

  it("takes exactly one of two keys racing with the right code", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    const answers = await Promise.all([redeem(agent, code), redeem(agent, code, { thumbprint: OTHER_KEY })]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 403]);
    const winner = answers.find((a) => a.status === 200)!.body.key_thumbprint;
    expect((await person(who, "GET", `/v1/pairing/${agent}`)).body.key_thumbprint).toBe(winner);
  });

  it("counts wrong codes, locks for good on the fifth, and answers every refusal the same", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    for (let n = 1; n <= 5; n++) {
      const wrong = await redeem(agent, newCode());
      expect(wrong.status).toBe(403);
      expect(wrong.code).toBe("not_allowed");
      expect((await person(who, "GET", `/v1/pairing/${agent}`)).body.attempts_left).toBe(5 - n);
    }
    const right = await redeem(agent, code);
    expect(right.status).toBe(403);
    expect(right.code).toBe("not_allowed");
    const read = await person(who, "GET", `/v1/pairing/${agent}`);
    expect(read.body).toMatchObject({ status: "locked", key_thumbprint: null, attempts_left: 0 });
    expect(read.body.history.map((e: any) => [e.type, e.reason])).toEqual([
      ["pairing.started", null],
      ...[1, 2, 3, 4].map(() => ["pairing.refused", "wrong_code"]),
      ["pairing.refused", "locked"],
      ["pairing.refused", "locked"],
    ]);
    expect((await person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: KEY })).status).toBe(409);
  });

  it("refuses an expired session without counting, and a malformed code without reaching it", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    await expire(agent);
    expect((await redeem(agent, code)).code).toBe("not_allowed");
    const read = await person(who, "GET", `/v1/pairing/${agent}`);
    expect(read.body).toMatchObject({ status: "expired", key_thumbprint: null, attempts_left: 5 });
    const fresh = await start(who);
    for (const bad of ["short", `${fresh.code}=`, ""]) expect((await redeem(fresh.agent, bad)).code).toBe("invalid_argument");
    expect((await person(who, "GET", `/v1/pairing/${fresh.agent}`)).body.attempts_left).toBe(5);
  });

  it("refuses a session that doesn't exist the same way, and leaves no trace of the attempt", async () => {
    const nobody = `agt_${"ab".repeat(16)}`;
    const res = await redeem(nobody, newCode());
    expect(res.status).toBe(403);
    expect(res.code).toBe("not_allowed");
    expect(await tables(nobody)).toEqual([]);
    for (const bad of ["per_someone", "agt_has space", "x".repeat(200)]) {
      expect((await redeem(encodeURIComponent(bad), newCode())).status).toBeGreaterThanOrEqual(400);
    }
  });

  it("takes only the gateway's redemption assertion, for this exact body", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    const body = JSON.stringify({ code });
    // A person's or an agent's identity isn't a redemption.
    expect((await call(await personAssertion(who), "POST", `/v1/pairing/${agent}/redeem`, body)).code).toBe("invalid_assertion");
    expect((await call(await agentAssertion(agent), "POST", `/v1/pairing/${agent}/redeem`, body)).code).toBe("invalid_assertion");
    // A body other than the one the gateway hashed.
    const other = await call(await redeemAssertion(JSON.stringify({ code: newCode() })), "POST", `/v1/pairing/${agent}/redeem`, body);
    expect(other.code).toBe("invalid_assertion");
    // A redemption assertion reaches nothing else.
    expect((await call(await redeemAssertion(""), "GET", "/v1/me")).code).toBe("invalid_assertion");
    expect((await call(await redeemAssertion(""), "GET", `/v1/pairing/${agent}`)).code).toBe("invalid_assertion");
    // A forged field, such as a person, makes it malformed.
    expect((await call(await redeemAssertion(body, { extra: { sub: who.id } }), "POST", `/v1/pairing/${agent}/redeem`, body)).code).toBe("invalid_assertion");
    // None of that counted against the session.
    expect((await person(who, "GET", `/v1/pairing/${agent}`)).body).toMatchObject({ status: "pending", attempts_left: 5 });
  });
});

describe("confirming", () => {
  it("makes the agent, connected, in the session's organization, with one outcome", async () => {
    const who = admin();
    const { agent, code, hostId } = await start(who);
    await redeem(agent, code);
    const done = await person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: KEY });
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ agent_id: agent, org_id: ORG, status: "activated", key_thumbprint: KEY, plugin_host_id: hostId, connection: { id: agent, org_id: ORG, name: "Runner on a Mac", generation: 1, status: "active" } });
    expect((await person(who, "GET", `/v1/agents/${agent}`)).body).toMatchObject({ id: agent, org_id: ORG, status: "active" });
    expect((await internalCheck(agent)).status).toBe(200);
    // Again: the same answer, and still one connection at generation 1.
    const again = await person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: KEY });
    expect(again.status).toBe(200);
    expect(again.body.connection.generation).toBe(1);
    // Nothing reopens it.
    expect((await redeem(agent, code)).code).toBe("not_allowed");
    expect((await person(who, "POST", `/v1/pairing/${agent}/cancel`)).status).toBe(409);
    // The late redemption is audited as a refusal, with the key's thumbprint and a reason, and nothing else.
    const history = (await person(who, "GET", `/v1/pairing/${agent}`)).body.history.map((e: any) => [e.type, e.actor_id, e.reason]);
    expect(history).toEqual([["pairing.started", who.id, null], ["pairing.redeemed", `key:${KEY}`, null], ["pairing.activated", who.id, null], ["pairing.refused", `key:${KEY}`, "closed"]]);
    expect(await everything(agent)).not.toContain(code);
  });

  it("has one outcome under two confirmations at once", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    await redeem(agent, code);
    const both = await Promise.all([1, 2].map(() => person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: KEY })));
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both[0].body.connection).toEqual(both[1].body.connection);
    const events = (await person(who, "GET", `/v1/pairing/${agent}`)).body.history.filter((e: any) => e.type === "pairing.activated");
    expect(events).toHaveLength(1);
  });

  it("refuses a thumbprint other than the one redeemed, and changes nothing", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    await redeem(agent, code);
    const wrong = await person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: OTHER_KEY });
    expect(wrong.status).toBe(403);
    expect(wrong.code).toBe("not_allowed");
    expect((await person(who, "GET", `/v1/pairing/${agent}`)).body.status).toBe("redeemed");
    expect((await person(who, "GET", `/v1/agents/${agent}`)).code).toBe("agent_not_found");
    // And after activation, another thumbprint never replaces the key.
    await person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: KEY });
    expect((await person(who, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: OTHER_KEY })).code).toBe("not_allowed");
    expect((await person(who, "GET", `/v1/pairing/${agent}`)).body.key_thumbprint).toBe(KEY);
  });

  it("needs a redemption first, and a session that hasn't expired or been canceled", async () => {
    const who = admin();
    const waiting = await start(who);
    expect((await person(who, "POST", `/v1/pairing/${waiting.agent}/activate`, { key_thumbprint: KEY })).status).toBe(409);
    const late = await start(who);
    await redeem(late.agent, late.code);
    await expire(late.agent);
    expect((await person(who, "POST", `/v1/pairing/${late.agent}/activate`, { key_thumbprint: KEY })).status).toBe(409);
    const ended = await start(who);
    await redeem(ended.agent, ended.code);
    expect((await person(who, "POST", `/v1/pairing/${ended.agent}/cancel`)).status).toBe(200);
    expect((await person(who, "POST", `/v1/pairing/${ended.agent}/activate`, { key_thumbprint: KEY })).status).toBe(409);
    for (const agent of [waiting.agent, late.agent, ended.agent]) expect((await person(who, "GET", `/v1/agents/${agent}`)).code).toBe("agent_not_found");
    expect((await person(who, "POST", `/v1/pairing/${waiting.agent}/activate`, { key_thumbprint: "short" })).code).toBe("invalid_argument");
  });

  it("is the starter's alone, while they still administer the organization in a membership older than the session", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    await redeem(agent, code);
    const confirm = (as: Person) => person(as, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: KEY });
    // Another admin of the organization learns nothing.
    expect((await confirm(admin())).code).toBe("not_found");
    // The starter, no longer an admin.
    expect((await confirm({ ...who, adminOrgs: [] })).code).toBe("not_allowed");
    // The starter, who left and came back while it waited.
    expect((await confirm({ ...who, orgSince: { [ORG]: Date.now() } })).code).toBe("not_allowed");
    // Gone from the organization.
    expect((await confirm({ ...who, adminOrgs: [], orgSince: {} })).code).toBe("not_allowed");
    // None of that changed the session, and the starter can still confirm.
    expect((await person(who, "GET", `/v1/pairing/${agent}`)).body.status).toBe("redeemed");
    expect((await confirm(who)).status).toBe(200);
  });
});

describe("canceling", () => {
  it("is the starter's, ends the session for good, and is safe to repeat", async () => {
    const who = admin();
    const { agent, code } = await start(who);
    expect((await person(admin(), "POST", `/v1/pairing/${agent}/cancel`)).code).toBe("not_found");
    const canceled = await person(who, "POST", `/v1/pairing/${agent}/cancel`);
    expect(canceled.status, canceled.text).toBe(200);
    expect(canceled.body.status).toBe("canceled");
    expect((await person(who, "POST", `/v1/pairing/${agent}/cancel`)).status).toBe(200);
    expect((await redeem(agent, code)).code).toBe("not_allowed");
    // A starter who lost their role can still end it.
    const other = await start(who);
    expect((await person({ ...who, adminOrgs: [] }, "POST", `/v1/pairing/${other.agent}/cancel`)).status).toBe(200);
  });
});
