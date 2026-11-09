// M4's staging run (step 14): every acceptance test in docs/m4-plan.md, M4-01 to M4-17, against a deployment with public rooms
// switched on. Switching PUBLIC_ROOMS on is the owner's call at the gate, so this script checks that first and stops at once,
// with a clear message, when it's off.
//
//   node m4-staging.mjs --base-url <gateway> --app-url <web app> [--allow-host <host>] [--tail-log <file>]
//
// People: on staging, PODSTER_E2E_SIGNUP_SECRET makes test people through the test sign-up, as m2-staging.mjs does, and each
// session is signed out at the end. Locally, people sign up with a password. M4-04 and M4-09 need 21 people, because one
// person's agents share a limit of 3 claims at once and 5 an hour.
//
// The operator: M4-14 needs a Podster operator's session, PODSTER_E2E_OPERATOR_COOKIE, from someone the API's OPERATORS names.
// Without it, M4-14's operator half is skipped and says so.
//
// Logs: M4-16 reads a file of the Workers' logs taken during the run, such as `wrangler tail podster-api-staging --format json`
// written to a file, passed as --tail-log. Without it, M4-16 is skipped and says so.
//
// Agents connect over MCP through the official SDK, and some over Agent Auth with the real signer. M4-17's A2A participant
// works over the gateway's /a2a with its own OAuth token. Staging has no delete route, so rooms are named "M4 staging <time>".
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthAgent, linkedA2aToken, McpAgent, ok, Person, sleep, Target } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const base = (option("--base-url") ?? process.env.PODSTER_E2E_BASE_URL)?.replace(/\/$/, "");
const app = (option("--app-url") ?? process.env.PODSTER_E2E_APP_URL)?.replace(/\/$/, "");
if (!base || !app) {
  console.error("Pass --base-url <gateway> and --app-url <web app>, or set PODSTER_E2E_BASE_URL and PODSTER_E2E_APP_URL.");
  process.exit(2);
}
const host = new URL(base).hostname;
const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".test");
const STAGING = "https://gateway-staging.podster.dev";
if (!isLocal && new URL(base).origin !== STAGING && option("--allow-host") !== host) {
  console.error(`Refusing to write test data to ${host}. Pass --allow-host ${host} if that's really intended.`);
  process.exit(2);
}
for (const url of [base, app]) {
  if (!isLocal && new URL(url).protocol !== "https:") {
    console.error(`Refusing to send session cookies or tokens to ${url} without HTTPS.`);
    process.exit(2);
  }
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
if (signupSecret && new URL(base).origin !== STAGING) {
  console.error(`PODSTER_E2E_SIGNUP_SECRET only works against ${STAGING}. Unset it to run against ${host}.`);
  process.exit(2);
}
const operatorCookie = process.env.PODSTER_E2E_OPERATOR_COOKIE;
const tailLog = option("--tail-log");

const target = new Target(base, { pollMs: isLocal ? 150 : 1000 });
const RUN = `M4 staging ${new Date().toISOString().slice(0, 16)}`;

// ---- reporting ----

const results = [];
const record = (status, title, detail = "") => {
  results.push({ status, title });
  const mark = { ok: "ok  ", fail: "FAIL", skip: "skip", note: "    " }[status];
  console.log(`${mark} ${title}${detail ? `: ${detail}` : ""}`);
};
const check = (passed, title, detail) => record(passed ? "ok" : "fail", title, detail);
const skip = (title, why) => record("skip", title, why);
const note = (title, detail) => record("note", title, detail);
const section = (name) => console.log(`\n## ${name}`);
const cause = (error) => {
  const parts = [];
  for (let at = error, depth = 0; at && depth < 4; at = at.cause, depth++) {
    const said = [at.code, at.name, at.message].filter(Boolean).join(" ");
    if (said && !parts.includes(said)) parts.push(said);
  }
  return parts.join(": ") || String(error);
};
async function step(title, run) {
  section(title);
  try {
    await run();
  } catch (error) {
    record("fail", title, cause(error));
  }
}

// ---- people and agents ----

const sessions = [];
async function person(label) {
  if (signupSecret) {
    const cookie = await Person.testSessionCookie(target, label, signupSecret);
    sessions.push(cookie);
    return Person.fromCookie(target, label, cookie);
  }
  ok(isLocal, "A deployed run needs PODSTER_E2E_SIGNUP_SECRET to make its test people.");
  return Person.signUp(target, label);
}
async function signOutAll() {
  for (const cookie of sessions.splice(0)) {
    await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  }
}

/** A person's agent over MCP or Agent Auth, with its owner's participation policy set. */
async function agentOf(owner, label, { over = "mcp", policy = "public_claims" } = {}) {
  const agent = over === "auth" ? await AuthAgent.connect(target, owner, label) : await McpAgent.connect(target, owner, label);
  agent.owner = owner;
  if (policy) await owner.must("PUT", `/agents/${agent.id}/participation-policy`, { policy });
  return agent;
}

const claim = (agent, handle, role, extra = {}) => agent.call("claim_public_opening", { idempotency_key: randomUUID(), handle, role_id: role, ...extra });

// ---- rooms ----

/** A new room. An organization holds at most 20, so the owner moves to a new one of its own every 18. */
const roomsMade = new Map();
async function newRoom(owner, name, extra = {}) {
  const made = roomsMade.get(owner) ?? 0;
  if (made > 0 && made % 18 === 0) await owner.useNewOrg(`${RUN} rooms ${made / 18}`);
  roomsMade.set(owner, made + 1);
  return owner.createRoom(name, extra);
}

/**
 * A room made public, with person review on and the openings given, and served on its page, which comes a moment after
 * publishing, once the room's index row is written. Returns its ID, handle and openings' IDs.
 */
async function publicRoom(owner, name, { openings = [{ title: "Surveyor", responsibilities: "Count fish", preset: "public_participant", capacity: 5 }], goal, context, topic } = {}) {
  const id = await newRoom(owner, name, { ...(goal ? { goal } : {}), ...(context ? { context } : {}) });
  await owner.must("PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(id) });
  if (topic) await owner.must("PUT", `/v1/workspaces/${id}/topic`, { topic });
  const roles = [];
  for (const opening of openings) {
    roles.push((await owner.must("POST", `/v1/workspaces/${id}/roles`, { publicly_claimable: true, ...opening, policy_version: await owner.policyVersion(id) })).id);
  }
  const handle = await publish(owner, id);
  ok((await within(40, async () => (await page(handle)).status === 200)) !== null, `${name}'s public page wasn't served within 40 seconds`);
  return { id, handle, roles };
}
async function publish(owner, id) {
  const { view_hash } = await owner.must("GET", `/v1/workspaces/${id}/visibility`);
  const done = await owner.dash("PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash });
  ok(done.ok, `publishing answered ${done.status} ${done.code ?? ""}`);
  return done.body.public_handle;
}
const unpublish = (owner, id, extra = {}) => owner.must("PUT", `/v1/workspaces/${id}/visibility`, { visibility: "private", ...extra });

/** The public page as anyone sees it, signed out, with nothing about who asks: exactly what came back, 429 included. */
const rawPage = (handle, init = {}) => fetch(`${app}/p/${handle}`, { redirect: "manual", ...init, signal: AbortSignal.timeout(30_000) });
/**
 * The same, for every check but M4-10's: this one machine is one client of the per-client limit, 120 pages a minute, so a
 * refusal is waited out as Retry-After says, and asked again, rather than read as the page's answer.
 */
async function page(handle, init = {}) {
  for (let tries = 0; ; tries++) {
    const res = await rawPage(handle, init);
    if (res.status !== 429 || tries >= 2) return res;
    await res.arrayBuffer();
    await sleep(Math.min(Number(res.headers.get("retry-after")) || 60, 65) * 1000);
  }
}
async function pageText(handle, init) {
  const res = await page(handle, init);
  return { status: res.status, headers: res.headers, body: await res.text() };
}
/** Polls until `done`, up to `seconds`, every `stepMs`, and answers how many seconds it took, or null if it never did. */
async function within(seconds, done, stepMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    if (await done()) return (Date.now() - start) / 1000;
    await sleep(stepMs);
  }
  return null;
}
// The public view is cached for 30 seconds (decision 150), so a change shows within that, measured to a quarter second.
const CACHE_SECONDS = 30;
const PUBLIC_HEADERS = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin" };
const publicHeadersOk = (headers) => Object.entries(PUBLIC_HEADERS).every(([name, value]) => headers.get(name) === value);
const strictCsp = (headers) => ["script-src 'none'", "form-action 'none'", "frame-ancestors 'none'"].every((part) => (headers.get("content-security-policy") ?? "").includes(part));
const randomHandle = () => `pub_${randomBytes(16).toString("hex")}`;

// ---- the run ----

let exitCode = 0;
try {
  const owner = await person("Room owner");
  await owner.useNewOrg(`${RUN} owners`);

  // Before anything else: public rooms must be on, or nothing below can run.
  section("public rooms are switched on");
  {
    const id = await newRoom(owner, `${RUN} preflight`);
    await owner.must("PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(id) });
    const { view_hash, public_rooms_enabled } = await owner.must("GET", `/v1/workspaces/${id}/visibility`);
    const tried = await owner.dash("PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash });
    if (public_rooms_enabled === false || tried.code === "public_rooms_disabled") {
      console.error(`\nPUBLIC_ROOMS is off on ${host}, so no room can go public and nothing here can run.\nSwitching it on is the owner's call at the gate. Run this again once it's on.`);
      process.exit(3);
    }
    ok(tried.ok, `the preflight publish answered ${tried.status} ${tried.code ?? ""}`);
    // The room's index row is written by its alarm a moment after publishing.
    const served = await within(40, async () => (await page(tried.body.public_handle)).status === 200);
    ok(served !== null, `the web app at ${app} didn't serve the public page within 40 seconds. Check --app-url.`);
    await unpublish(owner, id);
    check(true, "public rooms are on, and the web app serves a public page");
  }

  // People for the limits: 21, each with one MCP or Agent Auth agent.
  const pool = [];
  await step("21 test people, each with an agent allowed public claims", async () => {
    for (let n = 0; n < 21; n++) {
      const who = await person(`Claimant owner ${n}`);
      pool.push(await agentOf(who, `${RUN} agent ${n}`, { over: n % 2 ? "auth" : "mcp" }));
    }
    check(pool.length === 21, "21 agents, MCP and Agent Auth alternately");
  });

  // ---- M4-01: no private field reaches any public response ----
  await step("M4-01 canaries in every private field", async () => {
    const canary = (field) => `zq${field}${randomBytes(6).toString("hex")}`;
    const canaries = {};
    const seed = (field) => (canaries[field] = canary(field));
    const orgOwner = await person("Canary owner");
    await orgOwner.useNewOrg(seed("orgname"));
    const lead = await agentOf(orgOwner, seed("agentname"), { policy: null });
    const room = await publicRoom(orgOwner, `${RUN} canary room`, { openings: [{ title: "Open seat", responsibilities: "Help", preset: "public_participant", capacity: 2 }] });
    await orgOwner.addAgent(room.id, lead, "member");
    const task = await orgOwner.must("POST", `/v1/workspaces/${room.id}/tasks`, { title: seed("tasktitle"), instructions: seed("instructions"), acceptance_criteria: seed("criteria"), assignee: lead.id, reviewer: orgOwner.id });
    await orgOwner.must("POST", `/v1/workspaces/${room.id}/tasks/${task.id}/messages`, { body: seed("message") });
    const accepted = await lead.must("accept_task", { workspace_id: room.id, task_id: task.id, version: task.version });
    await lead.must("submit_task", { workspace_id: room.id, task_id: task.id, version: accepted.version, note: seed("note"), artifacts: [{ uri: `https://example.com/${seed("link")}`, label: seed("label") }] });
    const invitation = await orgOwner.invite(room.id, `org_${seed("invitedorg")}`);
    canaries.invitationtoken = invitation.token;
    const output = await orgOwner.must("POST", `/v1/workspaces/${room.id}/outputs`, { title: seed("removedoutput"), description: seed("removeddescription") });
    await orgOwner.must("DELETE", `/v1/workspaces/${room.id}/outputs/${output.id}`);
    const closed = await orgOwner.must("POST", `/v1/workspaces/${room.id}/roles`, { title: seed("closedopening"), responsibilities: seed("closedduty"), preset: "public_participant", capacity: 1, policy_version: await orgOwner.policyVersion(room.id) });
    await orgOwner.must("DELETE", `/v1/workspaces/${room.id}/roles/${closed.id}`, { policy_version: await orgOwner.policyVersion(room.id) });
    for (const [name, value] of [["workspaceid", room.id], ["taskid", task.id], ["ownerid", orgOwner.id], ["agentid", lead.id], ["orgid", orgOwner.org]]) canaries[name] = value;
    // What the public sees, after the change has reached the page.
    await within(40, async () => (await pageText(room.handle)).status === 200);
    const responses = [];
    const shown = await pageText(room.handle);
    responses.push(["the public page", shown.body + JSON.stringify([...shown.headers])]);
    const json = await pool[0].call("get_public_workroom", { handle: room.handle });
    responses.push(["get_public_workroom", JSON.stringify(json)]);
    responses.push(["discover_workrooms", JSON.stringify(await pool[0].call("discover_workrooms", {}))]);
    responses.push(["Explore for a person", JSON.stringify(await owner.dash("GET", "/v1/public/explore"))]);
    let leaks = 0;
    for (const [where, text] of responses) {
      for (const [field, value] of Object.entries(canaries)) {
        if (text.includes(value)) {
          leaks += 1;
          record("fail", `${field} reached ${where}`);
        }
      }
    }
    check(leaks === 0, `no canary in any public response`, `${Object.keys(canaries).length} canaries, ${responses.length} responses`);
    // The JSON's field names are exactly the contract's.
    const schema = JSON.parse(readFileSync(join(here, "../packages/contracts/public-workroom-view.schema.json"), "utf8"));
    const keys = (value) => Object.keys(value ?? {}).sort().join(",");
    const expected = keys(schema.properties);
    check(json.ok && keys(json.data) === expected, "the public JSON's top-level fields are the contract's", `${keys(json.data)} vs ${expected}`);
    const contentSchema = schema.properties?.content?.properties ?? schema.$defs?.content?.properties;
    if (contentSchema) check(keys(json.data?.content) === keys(contentSchema), "its content fields are the contract's", keys(json.data?.content));
  });

  // ---- M4-02: every not-found looks the same ----
  await step("M4-02 one not-found for every kind of handle", async () => {
    const live = await publicRoom(owner, `${RUN} not-found room`);
    const privateRoom = await publicRoom(owner, `${RUN} gone private`);
    await unpublish(owner, privateRoom.id);
    const republished = await publicRoom(owner, `${RUN} republished`);
    await unpublish(owner, republished.id);
    await publish(owner, republished.id);
    const cases = [
      ["a private room's handle", privateRoom.handle],
      ["a random handle", randomHandle()],
      ["a handle from before a republish", republished.handle],
      ["a room's internal ID", live.id],
      ["a malformed handle", "pub_not-a-handle"],
    ];
    await within(40, async () => (await pageText(privateRoom.handle)).status === 404 && (await pageText(republished.handle)).status === 404);
    const seen = [];
    for (const [label, handle] of cases) {
      const started = Date.now();
      const res = await pageText(handle);
      seen.push({ label, status: res.status, length: res.body.length, headers: [...res.headers.keys()].filter((h) => !["date", "cf-ray", "server", "content-length", "alt-svc", "nel", "report-to", "cf-cache-status"].includes(h)).sort().join(","), ms: Date.now() - started });
    }
    const first = seen[0];
    for (const one of seen) check(one.status === 404 && one.length === first.length && one.headers === first.headers, `${one.label} answers the one not-found`, `${one.status}, ${one.length} bytes, ${one.ms} ms`);
    skip("a deleted room's and a suspended room's handle", "rooms have no delete route; the suspended case runs in M4-14");
    note("timing is recorded, not asserted", seen.map((s) => `${s.label}: ${s.ms} ms`).join("; "));
  });

  // ---- M4-03: going private ----
  await step("M4-03 the owner makes a public room private", async () => {
    const room = await publicRoom(owner, `${RUN} going private`);
    const claimant = pool[1];
    const claimed = await claim(claimant, room.handle, room.roles[0]);
    check(claimed.ok, "a public participant joins first", claimed.code);
    await within(40, async () => (await pageText(room.handle)).status === 200);
    await unpublish(owner, room.id);
    // Two connections, each every 2 seconds and a second apart, which stays inside the per-client limit.
    const [a, b] = await Promise.all([0, 1].map(async (n) => {
      await sleep(n * 1000);
      return within(45, async () => (await pageText(room.handle, { headers: { connection: "close" } })).status === 404, 2000);
    }));
    check(a !== null && a <= CACHE_SECONDS + 2.5 && b !== null && b <= CACHE_SECONDS + 2.5, "the page is not-found from two connections within the 30-second cache", `${a}s and ${b}s, polled every 2 seconds`);
    const explore = await owner.dash("GET", "/v1/public/explore");
    check(!JSON.stringify(explore.body).includes(room.handle), "it leaves Explore");
    const still = await claimant.call("get_workspace", { workspace_id: room.id });
    check(still.ok, "the public participant keeps its access", still.code);
    const again = await publish(owner, room.id);
    check(again !== room.handle, "republishing gives a new handle");
    check((await pageText(room.handle)).status === 404, "and the old one stays not-found");
  });

  // ---- M4-04: one of 20 takes the last place ----
  await step("M4-04 20 agents claim the last opening at once", async () => {
    const room = await publicRoom(owner, `${RUN} last seat`, { openings: [{ title: "Last seat", responsibilities: "Sit", preset: "public_participant", capacity: 1 }] });
    const twenty = pool.slice(0, 20);
    const answers = await Promise.all(twenty.map((agent) => claim(agent, room.handle, room.roles[0])));
    const won = answers.filter((a) => a.ok).length;
    const full = answers.filter((a) => !a.ok && String(a.code).includes("role_full")).length;
    check(won === 1, "exactly one claim succeeds", `${won} succeeded`);
    check(full === 19, "the rest get role_full", answers.filter((a) => !a.ok).map((a) => a.code).join(", "));
    const invitations = await owner.must("GET", `/v1/workspaces/${room.id}/invitations`);
    check((invitations.invitations ?? []).length === 0, "no invitation was needed");
  });

  // ---- M4-05: the agent's owner decides ----
  await step("M4-05 the default participation policy, then the owner allows public claims", async () => {
    const room = await publicRoom(owner, `${RUN} policy`);
    const who = await person("Policy owner");
    const agent = await agentOf(who, `${RUN} policy agent`, { policy: null });
    const refused = await claim(agent, room.handle, room.roles[0]);
    check(!refused.ok && String(refused.code).includes("public_claims_not_allowed"), "invitations only, by default, refuses it", refused.code);
    await who.must("PUT", `/agents/${agent.id}/participation-policy`, { policy: "public_claims" });
    const allowed = await claim(agent, room.handle, room.roles[0]);
    check(allowed.ok, "once its owner allows public claims, it joins", allowed.code);
    const audit = await owner.audit(room.id);
    check(!audit.some((e) => e.actor_id === owner.id && /approve|invite/.test(e.action)), "the room's owner approved nothing");
  });

  // ---- M4-06: removal and withdrawal hold ----
  await step("M4-06 a removed claimant, and a withdrawn agent", async () => {
    const room = await publicRoom(owner, `${RUN} removal`);
    const removed = pool[2];
    check((await claim(removed, room.handle, room.roles[0])).ok, "it claims");
    await owner.revoke(room.id, removed.id);
    const back = await claim(removed, room.handle, room.roles[0]);
    check(!back.ok, "removed, it can't claim again", back.code);
    await owner.must("POST", `/v1/workspaces/${room.id}/members/${removed.id}/clear-removal`, { policy_version: await owner.policyVersion(room.id) });
    check((await claim(removed, room.handle, room.roles[0])).ok, "once an owner clears the removal, it can");
    const withdrawn = pool[3];
    check((await claim(withdrawn, room.handle, room.roles[0])).ok, "another claims");
    await withdrawn.owner.must("POST", `/v1/workspaces/${room.id}/members/${withdrawn.id}/withdraw`, {});
    const again = await claim(withdrawn, room.handle, room.roles[0]);
    check(!again.ok, "withdrawn by its owner, it can't claim again", again.code);
    await withdrawn.owner.must("POST", `/v1/workspaces/${room.id}/members/${withdrawn.id}/owner-consent`, {});
    check((await claim(withdrawn, room.handle, room.roles[0])).ok, "once its owner consents again, it can");
  });

  // ---- M4-07: a claim gets its opening's preset and nothing more ----
  await step("M4-07 a claim asking for more", async () => {
    const room = await publicRoom(owner, `${RUN} preset`);
    const agent = pool[4];
    const greedy = await claim(agent, room.handle, room.roles[0], { scopes: { tasks: "all", review: "always" }, role: "admin" });
    if (!greedy.ok) check(true, "a claim with extra scopes or role is refused outright", greedy.code);
    if (!greedy.ok) check((await claim(agent, room.handle, room.roles[0])).ok, "and a plain one joins");
    const member = (await owner.must("GET", `/v1/workspaces/${room.id}`)).members.find((m) => m.principal_id === agent.id);
    check(member?.role === "guest" && member?.access?.preset === "public_participant", "its grant is the opening's preset, as a guest", JSON.stringify(member ?? {}).slice(0, 200));
    const memberSeat = await owner.dash("POST", `/v1/workspaces/${room.id}/roles`, { title: "Member seat", responsibilities: "x", preset: "member", capacity: 1, publicly_claimable: true, policy_version: await owner.policyVersion(room.id) });
    check(!memberSeat.ok, "a Member opening can't be made claimable publicly", memberSeat.code);
    const lead = await owner.dash("POST", `/v1/workspaces/${room.id}/roles`, { title: "Lead", responsibilities: "x", is_lead: true, publicly_claimable: true, policy_version: await owner.policyVersion(room.id) });
    check(!lead.ok, "nor a lead opening", lead.code);
    const create = await agent.call("create_task", { idempotency_key: randomUUID(), workspace_id: room.id, title: "Mine", instructions: "x", acceptance_criteria: "x" });
    check(!create.ok, "the claimant can't create tasks", create.code);
    // Another public participant's task, which this one wasn't offered.
    check((await claim(pool[5], room.handle, room.roles[0])).ok, "another public participant joins");
    const other = await owner.must("POST", `/v1/workspaces/${room.id}/tasks`, { title: "Someone else's", instructions: "x", acceptance_criteria: "x", assignee: pool[5].id, reviewer: owner.id });
    const touch = await agent.call("accept_task", { idempotency_key: randomUUID(), workspace_id: room.id, task_id: other.id, version: other.version });
    check(!touch.ok, "nor act on a task it wasn't offered", touch.code);
  });

  // ---- M4-08: private rooms stay hidden ----
  await step("M4-08 a private room is absent everywhere", async () => {
    const secretName = `zqprivate${randomBytes(6).toString("hex")}`;
    const id = await newRoom(owner, secretName);
    const stranger = await person("Stranger");
    const explored = JSON.stringify(await stranger.dash("GET", "/v1/public/explore"));
    const discovered = JSON.stringify(await pool[6].call("discover_workrooms", {}));
    check(!explored.includes(secretName) && !discovered.includes(secretName), "absent from Explore and discover_workrooms");
    const byId = await pool[6].call("get_public_workroom", { handle: id });
    check(!byId.ok, "not found by ID", byId.code);
    check((await pageText(id)).status === 404, "and its ID as a page is not-found");
  });

  // ---- M4-09: the exact public claim limits ----
  await step("M4-09 the exact limits, and an organization blocked", async () => {
    const rooms = [];
    for (let n = 0; n < 6; n++) rooms.push(await publicRoom(owner, `${RUN} limits ${n}`));
    const busy = pool[7];
    const codes = [];
    for (const room of rooms.slice(0, 4)) codes.push((await claim(busy, room.handle, room.roles[0])).code ?? "ok");
    check(codes.slice(0, 3).every((c) => c === "ok") && String(codes[3]).includes("limit_exceeded"), "an agent holds at most 3 public claims at once", codes.join(", "));
    // Releasing frees a place now, but the hour still counts every claim: the 6th in the hour is refused.
    for (const room of rooms.slice(0, 3)) await busy.call("release_role", { idempotency_key: randomUUID(), workspace_id: room.id, role_id: room.roles[0] });
    const hourly = [];
    for (const room of rooms.slice(3, 6)) hourly.push((await claim(busy, room.handle, room.roles[0])).code ?? "ok");
    check(hourly.filter((c) => c === "ok").length === 2 && String(hourly.at(-1)).includes("limit_exceeded"), "an agent makes at most 5 public claims an hour", hourly.join(", "));
    // The room's own hour: 20 claims, then limit_exceeded.
    const roomful = await publicRoom(owner, `${RUN} roomful`, { openings: [{ title: "Many seats", responsibilities: "Sit", preset: "public_participant", capacity: 50 }] });
    // 21 distinct agents, each well inside its own and its person's limits.
    const extra = await agentOf(await person("Twenty-first claimant"), `${RUN} agent 21`);
    const roomCodes = [];
    for (const agent of pool.slice(8, 21).concat(pool.slice(0, 7)).concat([extra])) roomCodes.push((await claim(agent, roomful.handle, roomful.roles[0])).code ?? "ok");
    const accepted = roomCodes.filter((c) => c === "ok").length;
    note("claims into one room in an hour", roomCodes.join(", "));
    check(accepted === 20 && String(roomCodes.at(-1)).includes("limit_exceeded"), "a room takes exactly 20 public claims an hour, then limit_exceeded", `${accepted} accepted, the 21st ${roomCodes.at(-1)}`);
    // An organization the room blocks.
    const blockedRoom = await publicRoom(owner, `${RUN} blocked org`);
    const blockedAgent = pool[9];
    await owner.must("PUT", `/v1/workspaces/${blockedRoom.id}/public-claims/blocked-orgs/${blockedAgent.org}`, {});
    const blocked = await claim(blockedAgent, blockedRoom.handle, blockedRoom.roles[0]);
    check(!blocked.ok, "an organization the room blocked is refused", blocked.code);
    skip("a linking person's limits across organizations, and an organization's hour", "each needs one person's agents in several organizations, or 21 claims from one organization; the API tests (claims.spec.ts) assert them exactly");
  });

  // ---- M4-10 and M4-11: the per-client limit, and the public headers ----
  await step("M4-10 and M4-11 the per-client limit and the public headers", async () => {
    const room = await publicRoom(owner, `${RUN} headers`);
    await within(40, async () => (await pageText(room.handle)).status === 200);
    const ok200 = await pageText(room.handle);
    check(publicHeadersOk(ok200.headers) && strictCsp(ok200.headers), "a public page carries the public headers and its strict CSP");
    check(!/<script|\son\w+\s*=/i.test(ok200.body), "it has no script element or inline handler");
    const missing = await pageText(randomHandle());
    check(missing.status === 404 && publicHeadersOk(missing.headers) && strictCsp(missing.headers), "a not-found carries them too");
    const robots = await fetch(`${app}/robots.txt`);
    check(robots.status === 200 && (await robots.text()).includes("Allow: /"), "robots.txt allows crawling, so noindex is seen");
    let first = null;
    let limited = null;
    for (let n = 1; n <= 400 && !limited; n++) {
      const res = await rawPage(room.handle);
      await res.arrayBuffer();
      if (res.status === 429) {
        first = n;
        limited = res;
      }
    }
    if (limited) {
      check(publicHeadersOk(limited.headers) && strictCsp(limited.headers) && limited.headers.get("retry-after") === "60", "a 429 carries them, and Retry-After", `first refused at request ${first}`);
    } else record("fail", "one client is refused past the limit", "no 429 in 400 requests");
    skip("other clients keep working while one is limited", "one machine is one client; the limit is keyed per client, which the web app's tests check");
    // The checks after this read pages again, so the minute's limit is let run out first.
    if (limited) await sleep(61_000);
  });

  // ---- M4-12: hostile text is inert ----
  await step("M4-12 the owner writes hostile Markdown", async () => {
    const hostile = ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "[x](javascript:alert(1))", "[d](data:text/html,<b>x</b>)", "![pixel](https://tracker.example/p.png)", "<iframe src='https://evil.example'></iframe>", "[podster.dev](https://evil.example/login)"].join("\n\n");
    // Very deep nesting has a field of its own, since it makes its whole field plain text.
    const room = await publicRoom(owner, `${RUN} hostile`, { goal: hostile, context: hostile, openings: [{ title: "<b>Seat</b>", responsibilities: `${"> ".repeat(200)}deep\n\n${hostile}`, preset: "public_participant", capacity: 1 }] });
    await within(40, async () => (await pageText(room.handle)).status === 200);
    const html = (await pageText(room.handle)).body;
    check(!/<script|<iframe|<img/i.test(html), "no script, iframe or image element");
    check(!/<[^>]*\son\w+\s*=/i.test(html) && !/<[^>]*\sstyle\s*=/i.test(html), "no inline handler or style");
    check(!/href="(javascript|data):/i.test(html), "no javascript: or data: link");
    check(html.includes("(evil.example)"), "a link shows its real host");
    skip("the same in a real browser", "no headless browser in this run");
  });

  // ---- M4-13: one page for everyone ----
  await step("M4-13 the same bytes for every request", async () => {
    const room = await publicRoom(owner, `${RUN} same bytes`);
    await within(40, async () => (await pageText(room.handle)).status === 200);
    const plain = (await pageText(room.handle)).body;
    const variants = [
      ["the owner's own session", { headers: { cookie: owner.cookie } }],
      ["an Authorization header", { headers: { authorization: "Bearer not-a-token" } }],
      ["odd forwarding headers", { headers: { "x-forwarded-host": "evil.example", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "http" } }],
    ];
    for (const [label, init] of variants) check((await pageText(room.handle, init)).body === plain, `with ${label}`);
    const query = await fetch(`${app}/p/${room.handle}?utm_source=x&debug=1`, { redirect: "manual" });
    check((await query.text()) === plain, "with extra query strings");
    const own = await fetch(`${app}/w/${room.id}/overview`, { headers: { cookie: owner.cookie }, redirect: "manual" });
    const ownBody = await own.text();
    check(own.status === 200 && !(own.headers.get("content-security-policy") ?? "").includes("script-src 'none'") && !ownBody.includes("Public workroom</p>"), "the owner's own room page is the dashboard's, not the public one");
  });

  // ---- M4-14: report, suspend, lift ----
  await step("M4-14 a report, an operator's suspension and its lift", async () => {
    const room = await publicRoom(owner, `${RUN} reported`);
    const reporter = await person("Reporter");
    const report = await reporter.dash("POST", "/v1/reports", { handle: room.handle, reason: "spam", note: "Staging run report." });
    check(report.ok, "a signed-in person reports a public room", report.code);
    const notOperator = await reporter.dash("GET", "/v1/moderation/reports");
    check(notOperator.status === 403, "a non-operator can't read the queue", notOperator.code);
    const notOperatorSuspend = await reporter.dash("POST", `/v1/moderation/reports/${report.body?.id}/suspend-room`, { reason: "spam" });
    check(notOperatorSuspend.status === 403, "nor suspend", notOperatorSuspend.code);
    if (!operatorCookie) return skip("an operator suspends and lifts", "set PODSTER_E2E_OPERATOR_COOKIE to an operator's session");
    const operator = await Person.fromCookie(target, "Operator", operatorCookie);
    const queue = await operator.must("GET", "/v1/moderation/reports");
    check((queue.reports ?? []).some((r) => r.id === report.body.id), "the report is in the operator's queue");
    await operator.must("POST", `/v1/moderation/reports/${report.body.id}/suspend-room`, { reason: "spam" });
    const gone = await within(45, async () => (await pageText(room.handle)).status === 404, 1000);
    check(gone !== null && gone <= CACHE_SECONDS + 1.5, "the page is not-found within the 30-second cache", `${gone}s, polled every second`);
    const refused = await claim(pool[10], room.handle, room.roles[0]);
    check(!refused.ok, "claims are refused", refused.code);
    const seen = await owner.must("GET", `/v1/workspaces/${room.id}/visibility`);
    check(seen.suspension?.reason === "spam", "the owner sees the suspension and its reason");
    await unpublish(owner, room.id);
    const { view_hash } = await owner.must("GET", `/v1/workspaces/${room.id}/visibility`);
    const republish = await owner.dash("PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "public", view_hash });
    check(!republish.ok && republish.code === "room_suspended", "and can't publish again", republish.code);
    await operator.must("POST", `/v1/moderation/reports/${report.body.id}/lift-room`, { reason: "spam" });
    check((await owner.dash("PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "public", view_hash: (await owner.must("GET", `/v1/workspaces/${room.id}/visibility`)).view_hash })).ok, "once lifted, it can publish again");
    skip("an operator's ID used by an agent", "an agent has no route to the operator API; the API tests check the kind");
  });

  // ---- M4-15: the public read isn't on the gateway's hostname ----
  await step("M4-15 the gateway's public hostname has no public read route", async () => {
    const room = await publicRoom(owner, `${RUN} gateway probe`);
    for (const path of [`/v1/public/workrooms/${room.handle}`, `/api/v1/public/workrooms/${room.handle}`, `/p/${room.handle}`, `/v1/public/explore`]) {
      const res = await target.http(path);
      const text = await res.text();
      check(res.status !== 200 || !text.includes(room.handle), `${path} on the gateway doesn't serve the view`, `HTTP ${res.status}`);
    }
    skip("the public assertion kind sent to every other API route", "the API's route-list tests cover it; a client can't mint that assertion");
  });

  // ---- M4-17: both protocols in one public room ----
  await step("M4-17 a public participant over A2A and another over MCP", async () => {
    const room = await publicRoom(owner, `${RUN} both protocols`);
    const lead = await agentOf(owner, `${RUN} lead`, { policy: null });
    await owner.addAgent(room.id, lead, "member");
    const overA2aOwner = await person("A2A participant owner");
    const overA2a = await agentOf(overA2aOwner, `${RUN} a2a participant`);
    const overMcp = pool[11];
    check((await claim(overA2a, room.handle, room.roles[0])).ok && (await claim(overMcp, room.handle, room.roles[0])).ok, "both claim publicly");
    const token = await linkedA2aToken(target, overA2aOwner, overA2a);
    const rpc = async (method, params) => {
      const res = await target.http("/a2a", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "1.0", "A2A-Extensions": "https://podster.dev/a2a/lifecycle/v1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `podster.lifecycle.v1.${method}`, params: { requestId: randomUUID(), ...params } }) });
      return res.json();
    };
    const a2aTask = await lead.must("create_task", { workspace_id: room.id, title: "Brief over A2A", instructions: "Two paragraphs.", acceptance_criteria: "Dates.", assignee: overA2a.id, reviewer: owner.id });
    const accepted = await rpc("AcceptTask", { id: `${room.id}:${a2aTask.id}`, version: a2aTask.version });
    const version = accepted.result?.metadata?.["podster.dev/version"];
    check(version !== undefined, "it accepts over A2A", JSON.stringify(accepted.error ?? {}).slice(0, 160));
    const submitted = await rpc("SubmitTask", { id: `${room.id}:${a2aTask.id}`, version, note: "From the M4 staging run.", artifacts: [{ uri: "https://example.com/m4", label: "Brief" }] });
    check(!submitted.error, "and submits over A2A", JSON.stringify(submitted.error ?? {}).slice(0, 160));
    // The same submit again, as a redelivery, adds nothing.
    await rpc("SubmitTask", { id: `${room.id}:${a2aTask.id}`, version, note: "From the M4 staging run.", artifacts: [{ uri: "https://example.com/m4", label: "Brief" }] });
    const mcpTask = await lead.must("create_task", { workspace_id: room.id, title: "Dates over MCP", instructions: "List them.", acceptance_criteria: "All.", assignee: overMcp.id, reviewer: owner.id });
    const mcpAccepted = await overMcp.must("accept_task", { workspace_id: room.id, task_id: mcpTask.id, version: mcpTask.version });
    await overMcp.must("submit_task", { workspace_id: room.id, task_id: mcpTask.id, version: mcpAccepted.version, note: "Listed." });
    for (const [label, task] of [["A2A", a2aTask], ["MCP", mcpTask]]) {
      const read = await owner.must("GET", `/v1/workspaces/${room.id}/tasks/${task.id}`);
      const count = (type) => read.history.filter((e) => e.type === type).length;
      check(count("task.accepted") === 1 && count("task.submitted") === 1, `the ${label} task has one history`, `${count("task.accepted")} accepted, ${count("task.submitted")} submitted`);
    }
    const tasks = await owner.must("GET", `/v1/workspaces/${room.id}/tasks`);
    check(tasks.tasks.length === 2, "two tasks, and no competing ones", `${tasks.tasks.length}`);
  });

  // ---- M4-16: the logs ----
  await step("M4-16 the Workers' logs carry IDs only", async () => {
    if (!tailLog) return skip("the logs during the run", "pass --tail-log with the run's `wrangler tail` output");
    const logged = readFileSync(tailLog, "utf8");
    const myIp = await fetch("https://api.ipify.org").then((r) => r.text()).catch(() => null);
    check(!/zq[a-z]+[0-9a-f]{12}/.test(logged), "no canary in the logs");
    if (myIp) check(!logged.includes(myIp), "no client IP address in the logs");
    check(!/Staging run report\./.test(logged), "no report note in the logs");
    check(!/[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{24,}/.test(logged), "no access token in the logs");
  });
} catch (error) {
  record("fail", "the run stopped", cause(error));
} finally {
  await signOutAll();
}

const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log(`\n${results.filter((r) => r.status === "ok").length} passed, ${failed} failed, ${skipped} skipped`);
exitCode = failed ? 1 : 0;
process.exit(exitCode);
