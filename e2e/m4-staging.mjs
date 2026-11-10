// M4's staging run (step 14): every acceptance test in docs/m4-plan.md, M4-01 to M4-17, against staging with public rooms
// switched on. Switching PUBLIC_ROOMS on is the owner's call at the gate, so this reads that first, and stops with exit code 3
// and a clear message while it's off, before making anything public.
//
//   node m4-staging.mjs --base-url <gateway> --app-url <web app>
//
// Only staging (https://gateway-staging.podster.dev and https://app-staging.podster.dev) or a local stack is accepted.
//
// People: on staging, PODSTER_E2E_SIGNUP_SECRET makes test people through the test sign-up, 22 new ones a run, and each
// session is signed out at the end. The sign-up allows 6 a minute and 40 a day across every run, so this waits out its limit
// as it goes, and one full run fits in a day. Locally, people sign up with a password.
//
// The operator: M4-14 signs in staging's one fixed test operator, the same person every run, through the same test sign-up.
// The script prints its ID; the owner names that ID in the API's OPERATORS once. Until then M4-14 fails on staging.
//
// Logs: on staging, the script runs `wrangler tail` itself for the API, the gateway and the web app, with the ambient wrangler
// login, and checks what the apps logged during the run (M4-16). No second terminal, and no secret on a command line.
//
// Exit codes: 0 when every check passed, and on staging with nothing skipped, printed as one line with the counts. 1 when any
// check failed, or on staging when any was skipped. 3 when public rooms are off. A limit this run can't check by design is
// printed "owed", doesn't fail it, and is listed as owed in docs/m4-plan.md's abuse review.
//
// Agents connect over MCP through the official SDK, and some over Agent Auth with the real signer. M4-17's A2A participant
// sends hand-written JSON-RPC to /a2a with its own OAuth token, since the A2A SDK has no call for the lifecycle extension.
// Every room this run makes public is made private again at the end, whatever happened.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthAgent, linkedA2aToken, McpAgent, ok, Person, sleep, Target } from "./lib.mjs";
import { RoomPublisher } from "./room-publisher.mjs";
import { JsonStream } from "./tail-stream.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
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
const STAGING = "https://gateway-staging.podster.dev";
const STAGING_APP = "https://app-staging.podster.dev";
const localHost = (url) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).hostname.endsWith(".test");
const isLocal = localHost(base) && localHost(app);
if (!isLocal && (new URL(base).origin !== STAGING || new URL(app).origin !== STAGING_APP)) {
  console.error(`Only staging (${STAGING} with ${STAGING_APP}) or a local stack. Refusing ${base} with ${app}.`);
  process.exit(2);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
if (!isLocal && !signupSecret) {
  console.error("A staging run needs PODSTER_E2E_SIGNUP_SECRET to make its test people.");
  process.exit(2);
}
if (isLocal && signupSecret) {
  console.error("PODSTER_E2E_SIGNUP_SECRET only works against staging. Unset it for a local run.");
  process.exit(2);
}

const target = new Target(base, { pollMs: isLocal ? 150 : 1000 });
// `--operator-id` signs the test operator in, prints its person ID for OPERATORS, signs out and stops: one take of the test
// sign-up, so the owner can name it before the first full run.
const operatorIdOnly = args.includes("--operator-id");
if (operatorIdOnly && isLocal) {
  console.error("--operator-id is for staging's test operator.");
  process.exit(2);
}
const RUN = `M4 staging ${new Date().toISOString().slice(0, 16)}`;

// ---- reporting ----

const results = [];
const record = (status, title, detail = "") => {
  results.push({ status, title });
  const mark = { ok: "ok  ", fail: "FAIL", skip: "skip", owed: "owed", note: "    " }[status];
  console.log(`${mark} ${title}${detail ? `: ${detail}` : ""}`);
};
const check = (passed, title, detail) => record(passed ? "ok" : "fail", title, detail);
/** Something this run couldn't check here. On staging, a skip fails the run. */
const skip = (title, why) => record("skip", title, why);
/** Something no run of this script can check, listed as owed in the abuse review. It doesn't fail the run. */
const owed = (title, why) => record("owed", title, why);
const note = (title, detail) => record("note", title, detail);
/** A refusal, with its status where the client reports one, and its code. */
const refusedWith = (result, status, code, title) => {
  const statusOk = status === undefined || result.status === undefined || result.status === status;
  check(!result.ok && statusOk && String(result.code ?? "").includes(code), title, `${result.status ?? ""} ${result.code ?? "accepted"}`.trim());
};
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
async function signUpCookie(body) {
  const res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  ok(res.status === 200, `the test sign-up answered ${res.status}. A 404 means it's off on this deployment, or PODSTER_E2E_SIGNUP_SECRET is wrong.`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function person(label) {
  if (isLocal) return Person.signUp(target, label);
  const cookie = await signUpCookie();
  sessions.push(cookie);
  return Person.fromCookie(target, label, cookie);
}
/** Staging's one fixed test operator, the same person every run. */
async function operatorPerson() {
  const cookie = await signUpCookie({ stable: "operator" });
  sessions.push(cookie);
  return Person.fromCookie(target, "Test operator", cookie);
}
/** A person's own name and email, as their session has them. */
async function identityOf(who) {
  const res = await target.http("/api/auth/get-session", { headers: { cookie: who.cookie, origin: target.base } });
  const body = await res.json().catch(() => null);
  return { name: body?.user?.name, email: body?.user?.email };
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
  agent.over = over;
  if (policy) await owner.must("PUT", `/agents/${agent.id}/participation-policy`, { policy });
  return agent;
}

const claim = (agent, handle, role, extra = {}) => agent.call("claim_public_opening", { idempotency_key: randomUUID(), handle, role_id: role, ...extra });

// ---- rooms ----

/**
 * Every room this run made public, and making each private again when it ends or is stopped (room-publisher.mjs). The
 * publish PUT has 30 seconds, inside clean-up's 60-second wait for publishes in flight.
 */
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });
/** IDs and handles only this run made, to find its own events in the tails. */
const runIds = new Set();

/** A new room. An organization holds at most 20, so the owner moves to a new one of its own every 18. */
const roomsMade = new Map();
async function newRoom(owner, name, extra = {}) {
  const made = roomsMade.get(owner) ?? 0;
  if (made > 0 && made % 18 === 0) await owner.useNewOrg(`${RUN} rooms ${made / 18}`);
  roomsMade.set(owner, made + 1);
  const id = await owner.createRoom(name, extra);
  runIds.add(id);
  return id;
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
  const done = await publisher.publish(owner, id);
  ok(done.ok, `publishing answered ${done.status} ${done.code ?? ""}`);
  runIds.add(done.body.public_handle);
  return done.body.public_handle;
}
async function unpublish(owner, id, extra = {}) {
  const done = await publisher.unpublish(owner, id, extra);
  ok(done.ok, `making it private answered ${done.status} ${done.code ?? ""}`);
  return done.body;
}
/** Every handle Explore lists for a person, following its cursor. Explore must answer. */
async function allExplore(who) {
  const handles = [];
  let cursor = null;
  for (let n = 0; n < 50; n++) {
    const res = await who.dash("GET", `/v1/public/explore${cursor ? `?cursor=${cursor}` : ""}`);
    ok(res.ok, `Explore answered ${res.status} ${res.code ?? ""}`);
    handles.push(...res.body.workrooms.map((w) => w.handle));
    cursor = res.body.next_cursor;
    if (!cursor) break;
  }
  return handles;
}

/** Every handle discover_workrooms lists for an agent, following its cursor, and every page as it came. It must answer. */
async function allDiscover(agent) {
  const handles = [];
  const pages = [];
  let cursor;
  for (let n = 0; n < 50; n++) {
    const res = await agent.call("discover_workrooms", cursor ? { cursor } : {});
    ok(res.ok, `discover_workrooms answered ${res.code ?? "nothing"}`);
    pages.push(res.data);
    handles.push(...(res.data?.workrooms ?? []).map((w) => w.handle));
    cursor = res.data?.next_cursor;
    if (!cursor) break;
  }
  return Object.assign(handles, { pages });
}

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
/** A GET with a Host header of its own, which fetch won't send. */
function getWithHost(url, hostHeader) {
  const parsed = new URL(url);
  const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send({ hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method: "GET", headers: { host: hostHeader, ...AS_BROWSER }, servername: parsed.hostname, timeout: 30_000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
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
// The public view is cached for 30 seconds (decision 150), so a change shows within that. This is the gateway's
// PUBLIC_VIEW_SECONDS (apps/gateway/src/public/reads.ts), written again here since the scripts import nothing from the apps.
const CACHE_SECONDS = 30;
// The bound a check holds the cache to: its 30 seconds, and the time one poll and its answer take.
const CACHE_BOUND_SECONDS = CACHE_SECONDS + 2.5;
// What a browser's navigation sends. Cloudflare's edge rewrites HTML only for a request that takes HTML, so the checks on the
// page's own bytes ask as a browser does, or an edge rewrite would go unseen.
const AS_BROWSER = { accept: "text/html" };
/** Where two bodies first differ, and their lengths, or "" when they're the same. */
function difference(a, b) {
  if (a === b) return "";
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  return `first differs at offset ${at}; ${b.length} characters against ${a.length}`;
}
const PUBLIC_HEADERS = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store, no-transform", "x-frame-options": "DENY", "referrer-policy": "same-origin" };
const publicHeadersOk = (headers) => Object.entries(PUBLIC_HEADERS).every(([name, value]) => headers.get(name) === value);
const strictCsp = (headers) => ["script-src 'none'", "form-action 'none'", "frame-ancestors 'none'"].every((part) => (headers.get("content-security-policy") ?? "").includes(part));
const randomHandle = () => `pub_${randomBytes(16).toString("hex")}`;

// ---- logs (M4-16, staging only) ----

/** `wrangler tail` for each app, started here with the ambient login, read as a stream of JSON values. */
const tails = [];
function startTails() {
  for (const appDir of ["api", "gateway", "web"]) {
    const cwd = join(repo, "apps", appDir);
    const tail = { app: appDir, stream: new JsonStream(), error: null, proc: null };
    tail.proc = spawn(join(cwd, "node_modules/.bin/wrangler"), ["tail", "--env", "staging", "--format", "json"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    // A missing wrangler, or one that can't start, fails the check rather than the whole run.
    tail.proc.on("error", (error) => (tail.error = error.code ?? "spawn_failed"));
    tail.proc.stdout.setEncoding("utf8");
    tail.proc.stdout.on("data", (chunk) => tail.stream.push(chunk));
    tails.push(tail);
  }
}
function stopTails() {
  for (const tail of tails) if (tail.proc && tail.proc.exitCode === null) tail.proc.kill("SIGINT");
}
/** Every event a tail has seen, as text, to search. */
const tailText = (tail) => tail.stream.values.map((value) => JSON.stringify(value));
/** Why a tail can't be trusted now: wrangler failed to start or has exited (its exit code only), or its stream overflowed. */
const tailProblem = (tail) =>
  tail.error ??
  (tail.proc?.exitCode !== null && tail.proc?.exitCode !== undefined ? `wrangler exited with code ${tail.proc.exitCode}` : null) ??
  (tail.proc?.signalCode ? `wrangler was stopped by ${tail.proc.signalCode}` : null) ??
  tail.stream.error;
/**
 * Sends requests of the run's own with a fresh marker in their paths until every tail holds an event naming it, bounded.
 * Used to show the tails are connected at the start, and still alive at the end. Wrangler's banner text isn't relied on,
 * and the marker isn't one of the run's own IDs, so it never counts as one of the run's events.
 */
async function markerSeenInEveryTail(owner, seconds) {
  const marker = randomBytes(16).toString("hex");
  const seen = await within(seconds, async () => {
    if (tails.some(tailProblem)) return true;
    await rawPage(`pub_${marker}`).then((res) => res.arrayBuffer()).catch(() => null);
    await owner.dash("GET", `/v1/workspaces/ws_${marker}`).catch(() => null);
    return tails.every((t) => tailText(t).some((text) => text.includes(marker)));
  }, 5000);
  const problems = tails.filter(tailProblem).map((t) => `${t.app}: ${tailProblem(t)}`);
  if (problems.length) return { ok: false, detail: problems.join(", ") };
  if (seen === null) return { ok: false, detail: `the marker never arrived in ${tails.filter((t) => !tailText(t).some((text) => text.includes(marker))).map((t) => t.app).join(", ")} within ${seconds} s` };
  return { ok: true, detail: "" };
}
/** What each app itself logged, apart from the platform's own record of the request. */
const appLogged = (tail) => tail.stream.values.map((value) => JSON.stringify([value?.logs ?? [], value?.exceptions ?? []])).join("\n");

// ---- the run ----

/** Stops the tails, makes every room this run made public private again, and signs everyone out. Runs once. */
let cleaned = null;
function cleanUp() {
  cleaned ??= (async () => {
    stopTails();
    // Waits for publishes in flight, then sweeps twice, so a publish landing during the first sweep is undone too.
    const { madePrivate, left } = await publisher.stop();
    console.log(`\n${madePrivate} rooms made private again${left ? `, ${left} couldn't be` : ""}`);
    if (left) results.push({ status: "fail", title: "rooms left public" });
    await signOutAll();
  })();
  return cleaned;
}
// Ctrl-C, or a stop from outside, still makes the run's rooms private, and the run fails.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`\nStopped by ${signal}. Making this run's rooms private again.`);
    cleanUp().finally(() => process.exit(130));
  });
}

if (operatorIdOnly) {
  const operator = await operatorPerson();
  console.log(`The test operator is ${operator.id}. Name it in the API's OPERATORS once, before the first full run.`);
  await signOutAll();
  process.exit(0);
}

const canaryPattern = /zq[a-z]+[0-9a-f]{12}/;
const roomIds = [];
let exitCode = 1;
try {
  const owner = await person("Room owner");
  await owner.useNewOrg(`${RUN} owners`);

  // Before anything else, and before anything is made public: public rooms must be on.
  section("public rooms are switched on");
  {
    const id = await newRoom(owner, `${RUN} preflight`);
    await owner.must("PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(id) });
    const state = await owner.must("GET", `/v1/workspaces/${id}/visibility`);
    if (state.public_rooms_enabled !== true) {
      console.error(`\nPUBLIC_ROOMS is off on ${new URL(base).hostname}, so no room can go public and nothing here can run.\nSwitching it on is the owner's call at the gate. Run this again once it's on.`);
      await signOutAll();
      process.exit(3);
    }
    const handle = await publish(owner, id);
    const served = await within(40, async () => (await page(handle)).status === 200);
    ok(served !== null, `the web app at ${app} didn't serve the public page within 40 seconds. Check --app-url.`);
    await unpublish(owner, id);
    check(true, "public rooms are on, and the web app serves a public page");
  }

  // The logs, needed on staging. A tail that can't connect stops the run here, before it spends the day's sign-ups.
  let operator = null;
  if (!isLocal) {
    section("staging's logs, and the test operator");
    startTails();
    const connected = await markerSeenInEveryTail(owner, 120);
    check(connected.ok, "wrangler tail is connected to the API, the gateway and the web app, shown by the run's own marker requests", connected.detail);
    if (!connected.ok) throw new Error(`stopping before any more sign-ups: a tail isn't connected (${connected.detail})`);
    operator = await operatorPerson().catch((error) => {
      record("fail", "the test operator signs in", cause(error));
      return null;
    });
    if (operator) console.log(`     The test operator is ${operator.id}. The owner names it in the API's OPERATORS once; M4-14 fails until then.`);
  }

  // People for the limits: 21, each with one MCP or Agent Auth agent. Their owners also play the run's other people.
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
    const orgOwner = pool[12].owner;
    await orgOwner.useNewOrg(seed("orgname"));
    const lead = await agentOf(orgOwner, seed("agentname"), { policy: null });
    const room = await publicRoom(orgOwner, `${RUN} canary room`, { openings: [{ title: "Open seat", responsibilities: "Help", preset: "public_participant", capacity: 2 }] });
    roomIds.push(room.id);
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
    // A file's name: the upload's record holds it, whether or not its bytes ever arrive.
    await orgOwner.must("POST", `/v1/workspaces/${room.id}/uploads`, { name: `${seed("filename")}.txt`, size: 5, sha256: "a".repeat(64) });
    const own = await identityOf(orgOwner);
    if (own.email) canaries.email = own.email;
    if (own.name) canaries.personname = own.name;
    for (const [name, value] of [["workspaceid", room.id], ["taskid", task.id], ["ownerid", orgOwner.id], ["agentid", lead.id], ["orgid", orgOwner.org]]) canaries[name] = value;
    check(Boolean(own.email && own.name), "the owner's email and name are among the canaries");
    const responses = [];
    const shown = await pageText(room.handle);
    check(shown.status === 200, "the public page answers");
    responses.push(["the public page", shown.body + JSON.stringify([...shown.headers])]);
    const json = await pool[0].call("get_public_workroom", { handle: room.handle });
    check(json.ok, "get_public_workroom answers", json.code);
    responses.push(["get_public_workroom", JSON.stringify(json.data)]);
    const discovered = await allDiscover(pool[0]);
    check(discovered.includes(room.handle), "discover_workrooms lists the canary room, so its entry is searched too");
    responses.push(["discover_workrooms, every page", JSON.stringify(discovered.pages)]);
    const listed = await allExplore(owner);
    check(listed.includes(room.handle), "Explore lists the canary room, so its card is searched too");
    responses.push(["Explore for a person", JSON.stringify(await owner.dash("GET", "/v1/public/explore"))]);
    let leaks = 0;
    for (const [where, text] of responses) {
      for (const [field, value] of Object.entries(canaries)) {
        if (value && text.includes(value)) {
          leaks += 1;
          record("fail", `${field} reached ${where}`);
        }
      }
    }
    check(leaks === 0, "no canary in any public response", `${Object.keys(canaries).length} canaries, ${responses.length} responses`);
    const schema = JSON.parse(readFileSync(join(repo, "packages/contracts/public-workroom-view.schema.json"), "utf8"));
    const keys = (value) => Object.keys(value ?? {}).sort().join(",");
    check(keys(json.data) === keys(schema.properties), "the public JSON's top-level fields are the contract's", `${keys(json.data)} vs ${keys(schema.properties)}`);
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
    await within(CACHE_SECONDS + 10, async () => (await pageText(privateRoom.handle)).status === 404 && (await pageText(republished.handle)).status === 404, 2000);
    const seen = [];
    for (const [label, handle] of cases) {
      const started = Date.now();
      const res = await pageText(handle);
      seen.push({ label, status: res.status, length: res.body.length, headers: [...res.headers.keys()].filter((h) => !["date", "cf-ray", "server", "content-length", "alt-svc", "nel", "report-to", "cf-cache-status", "server-timing"].includes(h)).sort().join(","), ms: Date.now() - started });
    }
    const first = seen[0];
    for (const one of seen) check(one.status === 404 && one.length === first.length && one.headers === first.headers, `${one.label} answers the one not-found`, `${one.status}, ${one.length} bytes, ${one.ms} ms`);
    owed("a deleted room's handle", "rooms have no delete route; a suspended room's handle is checked in M4-14");
    note("timing is recorded, not asserted", seen.map((s) => `${s.label}: ${s.ms} ms`).join("; "));
  });

  // ---- M4-03: going private ----
  await step("M4-03 the owner makes a public room private", async () => {
    const room = await publicRoom(owner, `${RUN} going private`);
    // The page as it was served while public, before the claim and after it: the only views a cache can hold a copy of.
    const whilePublic = [(await pageText(room.handle)).body];
    const claimant = pool[1];
    const claimed = await claim(claimant, room.handle, room.roles[0]);
    check(claimed.ok, "a public participant joins first", claimed.code);
    check((await allExplore(owner)).includes(room.handle), "it's in Explore while public");
    whilePublic.push((await pageText(room.handle)).body);
    await unpublish(owner, room.id);
    const unpublishedAt = Date.now();
    // Straight after, the page is either not-found already or a cached copy of the view from before (ADR 0008), nothing else.
    const atOnce = await pageText(room.handle);
    if (atOnce.status === 404) note("straight after the unpublish", "the page is already not-found");
    else if (atOnce.status === 200 && whilePublic.includes(atOnce.body)) note("straight after the unpublish", "a cached copy of the view from before it is served, as the 30-second cache allows");
    else record("fail", "straight after the unpublish, the page is not-found or a cached copy of the view from before", `HTTP ${atOnce.status}, ${atOnce.body.length} characters, matching no view from before`);
    // Two connections, each every 2 seconds and a second apart, which stays inside the per-client limit.
    const [a, b] = await Promise.all([0, 1].map(async (n) => {
      await sleep(n * 1000);
      return within(CACHE_SECONDS + 15, async () => (await pageText(room.handle, { headers: { connection: "close" } })).status === 404, 2000);
    }));
    check(a !== null && a <= CACHE_BOUND_SECONDS && b !== null && b <= CACHE_BOUND_SECONDS, "the page is not-found from two connections within the 30-second cache", `${a}s and ${b}s, polled every 2 seconds`);
    check(!(await allExplore(owner)).includes(room.handle), "it leaves Explore");
    const still = await claimant.call("get_workspace", { workspace_id: room.id });
    check(still.ok, "the public participant keeps its access", still.code);
    const again = await publish(owner, room.id);
    check(again !== room.handle, "republishing gives a new handle");
    // A cached copy of the old handle's view may be served for at most 30 seconds after the unpublish (ADR 0008), and one
    // answer of not-found doesn't show every copy is gone. So this waits only that bound out, and then reads several times: a
    // copy that outlives it fails.
    await sleep(Math.max(0, unpublishedAt + CACHE_BOUND_SECONDS * 1000 - Date.now()));
    const old = [];
    for (let n = 0; n < 5; n++) {
      old.push((await pageText(room.handle, { headers: { connection: "close" } })).status);
      await sleep(1000);
    }
    check(old.every((status) => status === 404), `and the old one stays not-found, from ${CACHE_BOUND_SECONDS} seconds after the unpublish`, `HTTP ${old.join(", ")} on 5 reads`);
  });

  // ---- M4-04: one of 20 takes the last place ----
  await step("M4-04 20 agents claim the last opening at once", async () => {
    const room = await publicRoom(owner, `${RUN} last seat`, { openings: [{ title: "Last seat", responsibilities: "Sit", preset: "public_participant", capacity: 1 }] });
    const twenty = pool.slice(0, 20);
    check(twenty.some((a) => a.over === "mcp") && twenty.some((a) => a.over === "auth"), "through MCP and Agent Auth both");
    const answers = await Promise.all(twenty.map((agent) => claim(agent, room.handle, room.roles[0])));
    const won = answers.filter((a) => a.ok).length;
    const full = answers.filter((a) => !a.ok && String(a.code).includes("role_full")).length;
    check(won === 1, "exactly one claim succeeds", `${won} succeeded`);
    check(full === 19, "the rest get role_full", answers.filter((a) => !a.ok).map((a) => a.code).join(", "));
    const invitations = await owner.must("GET", `/v1/workspaces/${room.id}/invitations`);
    check(Array.isArray(invitations.invitations) && invitations.invitations.length === 0, "no invitation was needed");
  });

  // ---- M4-05: the agent's owner decides ----
  await step("M4-05 the default participation policy, then the owner allows public claims", async () => {
    const room = await publicRoom(owner, `${RUN} policy`);
    const who = pool[13].owner;
    const agent = await agentOf(who, `${RUN} policy agent`, { policy: null });
    refusedWith(await claim(agent, room.handle, room.roles[0]), undefined, "public_claims_not_allowed", "invitations only, by default, refuses it");
    await who.must("PUT", `/agents/${agent.id}/participation-policy`, { policy: "public_claims" });
    const allowed = await claim(agent, room.handle, room.roles[0]);
    check(allowed.ok, "once its owner allows public claims, it joins", allowed.code);
    const audit = await owner.audit(room.id);
    check(audit.length > 0 && !audit.some((e) => e.actor_id === owner.id && /approve|invite/.test(e.action)), "the room's owner approved nothing", `${audit.length} entries`);
  });

  // ---- M4-06: removal and withdrawal hold ----
  await step("M4-06 a removed claimant, and a withdrawn agent", async () => {
    const room = await publicRoom(owner, `${RUN} removal`);
    const removed = pool[2];
    check((await claim(removed, room.handle, room.roles[0])).ok, "it claims");
    await owner.revoke(room.id, removed.id);
    refusedWith(await claim(removed, room.handle, room.roles[0]), undefined, "access_revoked", "removed, it can't claim again");
    await owner.must("POST", `/v1/workspaces/${room.id}/members/${removed.id}/clear-removal`, { policy_version: await owner.policyVersion(room.id) });
    check((await claim(removed, room.handle, room.roles[0])).ok, "once an owner clears the removal, it can");
    const withdrawn = pool[3];
    check((await claim(withdrawn, room.handle, room.roles[0])).ok, "another claims");
    await withdrawn.owner.must("POST", `/v1/workspaces/${room.id}/members/${withdrawn.id}/withdraw`, {});
    refusedWith(await claim(withdrawn, room.handle, room.roles[0]), undefined, "access_revoked", "withdrawn by its owner, it can't claim again");
    await withdrawn.owner.must("POST", `/v1/workspaces/${room.id}/members/${withdrawn.id}/owner-consent`, {});
    check((await claim(withdrawn, room.handle, room.roles[0])).ok, "once its owner consents again, it can");
  });

  // ---- M4-07: a claim gets its opening's preset and nothing more ----
  await step("M4-07 a claim asking for more", async () => {
    const room = await publicRoom(owner, `${RUN} preset`);
    const agent = pool[4];
    const greedy = await claim(agent, room.handle, room.roles[0], { scopes: { tasks: "all", review: "always" }, role: "admin" });
    if (greedy.ok) note("a claim with extra scopes and a role", "accepted, with the extra fields dropped; the grant below is the check");
    else {
      refusedWith(greedy, undefined, "invalid_argument", "a claim with extra scopes or a role is refused");
      check((await claim(agent, room.handle, room.roles[0])).ok, "and a plain one joins");
    }
    const member = (await owner.must("GET", `/v1/workspaces/${room.id}`)).members.find((m) => m.principal_id === agent.id);
    check(member?.role === "guest" && member?.access?.preset === "public_participant" && member?.access?.review === "none", "its grant is the opening's preset, as a guest, with no review", JSON.stringify(member?.access ?? {}));
    refusedWith(await owner.dash("POST", `/v1/workspaces/${room.id}/roles`, { title: "Member seat", responsibilities: "Do things", preset: "member", capacity: 1, publicly_claimable: true, policy_version: await owner.policyVersion(room.id) }), 400, "invalid_argument", "a Member opening can't be made claimable publicly");
    refusedWith(await owner.dash("POST", `/v1/workspaces/${room.id}/roles`, { title: "Lead", responsibilities: "Lead the room", is_lead: true, publicly_claimable: true, policy_version: await owner.policyVersion(room.id) }), 400, "invalid_argument", "nor a lead opening, sent otherwise valid");
    check((await owner.dash("POST", `/v1/workspaces/${room.id}/roles`, { title: "Lead", responsibilities: "Lead the room", is_lead: true, policy_version: await owner.policyVersion(room.id) })).ok, "the same lead opening, not claimable, is accepted");
    refusedWith(await agent.call("create_task", { idempotency_key: randomUUID(), workspace_id: room.id, title: "Mine", instructions: "x", acceptance_criteria: "x" }), undefined, "not_allowed", "the claimant can't create tasks");
    // Another public participant's task, which this one wasn't offered and can't review.
    check((await claim(pool[5], room.handle, room.roles[0])).ok, "another public participant joins");
    const other = await owner.must("POST", `/v1/workspaces/${room.id}/tasks`, { title: "Someone else's", instructions: "x", acceptance_criteria: "x", assignee: pool[5].id, reviewer: owner.id });
    refusedWith(await agent.call("accept_task", { idempotency_key: randomUUID(), workspace_id: room.id, task_id: other.id, version: other.version }), undefined, "task_not_found", "nor act on a task it wasn't offered");
    const accepted = await pool[5].must("accept_task", { workspace_id: room.id, task_id: other.id, version: other.version });
    await pool[5].must("submit_task", { workspace_id: room.id, task_id: other.id, version: accepted.version, note: "Done." });
    refusedWith(await agent.call("verify_task", { idempotency_key: randomUUID(), workspace_id: room.id, task_id: other.id, submission_no: 1 }), undefined, "task_not_found", "nor review one");
  });

  // ---- M4-08: private rooms stay hidden ----
  await step("M4-08 a private room is absent everywhere", async () => {
    const visible = await publicRoom(owner, `${RUN} visible`);
    const secretName = `zqprivate${randomBytes(6).toString("hex")}`;
    const id = await newRoom(owner, secretName);
    const stranger = pool[14].owner;
    const explored = await allExplore(stranger);
    check(explored.includes(visible.handle), "Explore answers and lists a public room");
    const discovered = await allDiscover(pool[6]);
    check(discovered.includes(visible.handle), "discover_workrooms answers and lists a public room");
    const both = JSON.stringify(explored) + JSON.stringify(discovered);
    check(!both.includes(secretName) && !both.includes(id), "the private room is absent from both");
    refusedWith(await pool[6].call("get_public_workroom", { handle: id }), undefined, "workspace_not_found", "not found by ID");
    check((await pageText(id)).status === 404, "and its ID as a page is not-found");
  });

  // ---- M4-09: the exact public claim limits ----
  await step("M4-09 the exact limits, invited claims, and an organization blocked", async () => {
    const rooms = [];
    for (let n = 0; n < 6; n++) rooms.push(await publicRoom(owner, `${RUN} limits ${n}`));
    const busy = pool[7];
    // An invited claim in a private room, between its public ones, which mustn't count toward either public limit.
    const invitedRoom = await newRoom(owner, `${RUN} invited`);
    const opening = await owner.must("POST", `/v1/workspaces/${invitedRoom}/roles`, { title: "Invited seat", responsibilities: "Help", preset: "guest", capacity: 1, policy_version: await owner.policyVersion(invitedRoom) });
    const invitation = await owner.invite(invitedRoom, busy.org, { work_role_id: opening.id });
    const accepted = await busy.owner.accept(invitation.token, busy.org, [busy]);
    check(accepted.ok, "the agent's owner accepts an invitation for it", accepted.code);
    const codes = [];
    for (const room of rooms.slice(0, 2)) codes.push((await claim(busy, room.handle, room.roles[0])).code ?? "ok");
    const invitedClaim = await busy.call("claim_role", { idempotency_key: randomUUID(), workspace_id: invitedRoom, role_id: opening.id });
    check(invitedClaim.ok, "it takes an invited claim", invitedClaim.code);
    for (const room of rooms.slice(2, 4)) codes.push((await claim(busy, room.handle, room.roles[0])).code ?? "ok");
    // Were the invited claim counted, the third public claim would already be refused.
    check(codes.slice(0, 3).every((c) => c === "ok") && String(codes[3]).includes("limit_exceeded"), "an agent holds at most 3 public claims at once, an invited one not counted", codes.join(", "));
    for (const room of rooms.slice(0, 3)) await busy.must("release_role", { workspace_id: room.id, role_id: room.roles[0] });
    const hourly = [];
    for (const room of rooms.slice(3, 6)) hourly.push((await claim(busy, room.handle, room.roles[0])).code ?? "ok");
    // Were the invited claim counted, the hour would end a claim sooner.
    check(hourly.filter((c) => c === "ok").length === 2 && String(hourly.at(-1)).includes("limit_exceeded"), "an agent makes at most 5 public claims an hour, an invited one not counted", hourly.join(", "));
    // The room's own hour: 20 claims, then limit_exceeded.
    const roomful = await publicRoom(owner, `${RUN} roomful`, { openings: [{ title: "Many seats", responsibilities: "Sit", preset: "public_participant", capacity: 50 }] });
    const extra = await agentOf(pool[15].owner, `${RUN} agent 21`);
    const roomCodes = [];
    for (const agent of pool.slice(8, 21).concat(pool.slice(0, 7)).concat([extra])) roomCodes.push((await claim(agent, roomful.handle, roomful.roles[0])).code ?? "ok");
    const taken = roomCodes.filter((c) => c === "ok").length;
    check(taken === 20 && String(roomCodes.at(-1)).includes("limit_exceeded"), "a room takes exactly 20 public claims an hour, then limit_exceeded", `${taken} accepted, the 21st ${roomCodes.at(-1)}`);
    const blockedRoom = await publicRoom(owner, `${RUN} blocked org`);
    const blockedAgent = pool[9];
    await owner.must("PUT", `/v1/workspaces/${blockedRoom.id}/public-claims/blocked-orgs/${blockedAgent.org}`, {});
    refusedWith(await claim(blockedAgent, blockedRoom.handle, blockedRoom.roles[0]), undefined, "not_allowed", "an organization the room blocked is refused");
    owed("a linking person's limits across organizations, and an organization's hour", "each needs one person's agents in several organizations, or 21 claims from one organization's agents; claims.spec.ts asserts them exactly");
  });

  // ---- M4-10 and M4-11: the per-client limit, and the public headers ----
  await step("M4-10 and M4-11 the per-client limit and the public headers", async () => {
    const room = await publicRoom(owner, `${RUN} headers`);
    const shown = await pageText(room.handle, { headers: AS_BROWSER });
    check(shown.status === 200 && publicHeadersOk(shown.headers) && strictCsp(shown.headers), "a public page carries the public headers and its strict CSP");
    const scriptAt = shown.body.search(/<script|\son\w+\s*=/i);
    check(scriptAt === -1, "asked for as a browser does, it has no script element or inline handler", scriptAt === -1 ? "" : `at offset ${scriptAt} of ${shown.body.length}`);
    const missing = await pageText(randomHandle(), { headers: AS_BROWSER });
    check(missing.status === 404 && publicHeadersOk(missing.headers) && strictCsp(missing.headers), "a not-found carries them too");
    check(!/<script/i.test(missing.body), "and has no script element either");
    const robots = await fetch(`${app}/robots.txt`);
    check(robots.status === 200 && (await robots.text()).includes("Allow: /"), "robots.txt allows crawling, so noindex is seen");
    const flood = async (headers = () => ({})) => {
      for (let n = 1; n <= 400; n++) {
        const res = await rawPage(room.handle, { headers: headers() });
        const body = await res.text();
        if (res.status === 429) return { n, res, body };
      }
      return null;
    };
    const limited = await flood(() => AS_BROWSER);
    if (limited) check(!/<script/i.test(limited.body), "a 429, asked for as a browser does, has no script element", `${limited.body.length} characters`);
    if (limited) check(publicHeadersOk(limited.res.headers) && strictCsp(limited.res.headers) && limited.res.headers.get("retry-after") === "60", "a 429 carries them, and Retry-After", `first refused at request ${limited.n}`);
    else record("fail", "one client is refused past the limit", "no 429 in 400 requests");
    owed("other clients keep working while one is limited", "one machine is one client; the web app's tests check the limit is keyed per client");
    if (limited) await sleep(61_000);
    // A forged address can't dodge it: Cloudflare's edge sets cf-connecting-ip itself.
    if (!isLocal) {
      // Either the edge refuses the request before the app sees it, or the app still counts the real client and limits it.
      // The edge's refusal is a 403 saying exactly "error code: 1000", marked as Cloudflare's own by its server or cf-ray
      // header, with none of the app's own public headers, so a 403 from the app itself isn't taken for it. Any other answer is named, by status only.
      const forged = () => rawPage(room.handle, { headers: { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250) + 1}` } });
      const edgeRefused = (res, body) => res.status === 403 && /^error code: 1000\n?$/.test(body) && !res.headers.has("content-security-policy") && !res.headers.has("x-robots-tag") && (res.headers.get("server") === "cloudflare" || res.headers.has("cf-ray"));
      let outcome = null;
      for (let n = 1; n <= 400 && !outcome; n++) {
        const res = await forged();
        const body = await res.text();
        if (res.status === 429) outcome = { kind: "limited", n };
        else if (edgeRefused(res, body)) outcome = { kind: "edge", n };
        else if (res.status !== 200) outcome = { kind: "other", n, status: res.status };
      }
      if (outcome?.kind === "other") record("fail", "a forged cf-connecting-ip got an answer other than the page, the limit or the edge's refusal", `HTTP ${outcome.status} at request ${outcome.n}`);
      else if (outcome?.kind === "edge") {
        // The refusal must be what every forged request gets, not one answer among pages.
        let refused = 0;
        for (let n = 0; n < 5; n++) {
          const res = await forged();
          if (edgeRefused(res, await res.text())) refused += 1;
        }
        check(outcome.n === 1 && refused === 5, "Cloudflare's edge refuses a forged cf-connecting-ip before the app, so it can't choose the client the limit counts", `403 error code: 1000 first at request ${outcome.n}, then on ${refused} of 5 more`);
      } else check(outcome?.kind === "limited", "a forged cf-connecting-ip doesn't dodge the limit", outcome ? `refused at request ${outcome.n}` : "no 429 in 400 requests");
      if (outcome?.kind === "limited") await sleep(61_000);
    } else owed("a forged cf-connecting-ip", "only Cloudflare's edge can show it overwrites the header; checked on staging");
  });

  // ---- M4-12: hostile text is inert ----
  await step("M4-12 the owner writes hostile Markdown", async () => {
    const hostile = ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "[x](javascript:alert(1))", "[d](data:text/html,<b>x</b>)", "![pixel](https://tracker.example/p.png)", "<iframe src='https://evil.example'></iframe>", "[podster.dev](https://evil.example/login)"].join("\n\n");
    // Very deep nesting has a field of its own, since it makes its whole field plain text.
    const room = await publicRoom(owner, `${RUN} hostile`, { goal: hostile, context: hostile, openings: [{ title: "<b>Seat</b>", responsibilities: `${"> ".repeat(200)}deep\n\n${hostile}`, preset: "public_participant", capacity: 1 }] });
    const html = (await pageText(room.handle)).body;
    check(!/<script|<iframe|<img/i.test(html), "no script, iframe or image element");
    check(!/<[^>]*\son\w+\s*=/i.test(html) && !/<[^>]*\sstyle\s*=/i.test(html), "no inline handler or style");
    check(!/href="(javascript|data):/i.test(html), "no javascript: or data: link");
    check(html.includes("(evil.example)"), "a link shows its real host");
    owed("the same in a real browser", "no headless browser in this run");
  });

  // ---- M4-13: one page for everyone ----
  await step("M4-13 the same bytes for every request", async () => {
    const room = await publicRoom(owner, `${RUN} same bytes`);
    // Every request asks as a browser does, and one doesn't, so a rewrite the edge makes only for browsers shows as a difference.
    const plain = (await pageText(room.handle, { headers: AS_BROWSER })).body;
    const variants = [
      ["the owner's own session", { headers: { ...AS_BROWSER, cookie: owner.cookie } }],
      ["an Authorization header", { headers: { ...AS_BROWSER, authorization: "Bearer not-a-token" } }],
      ["odd forwarding headers", { headers: { ...AS_BROWSER, "x-forwarded-host": "evil.example", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "http" } }],
      ["a client that asks for anything, not HTML", { headers: { accept: "*/*" } }],
    ];
    for (const [label, init] of variants) {
      const differs = difference(plain, (await pageText(room.handle, init)).body);
      check(!differs, `with ${label}`, differs);
    }
    const query = await page(`${room.handle}?utm_source=x&debug=1`, { headers: AS_BROWSER });
    const queryDiffers = difference(plain, await query.text());
    check(!queryDiffers, "with extra query strings", queryDiffers);
    // Locally any Host reaches the app; on staging an odd Host must still route to it, so it's the right name written oddly.
    const oddHost = isLocal ? "evil.example" : `${new URL(app).hostname.toUpperCase()}:443`;
    const odd = await getWithHost(`${app}/p/${room.handle}`, oddHost);
    check(odd.status === 200 && odd.body === plain, `with an odd Host, ${oddHost}`, [`HTTP ${odd.status}`, difference(plain, odd.body)].filter(Boolean).join("; "));
    const own = await fetch(`${app}/w/${room.id}/overview`, { headers: { cookie: owner.cookie }, redirect: "manual" });
    const ownBody = await own.text();
    check(own.status === 200 && !(own.headers.get("content-security-policy") ?? "").includes("script-src 'none'") && !ownBody.includes("Public workroom</p>"), "the owner's own room page is the dashboard's, not the public one", `${own.status}`);
  });

  // ---- M4-14: report, suspend, lift ----
  await step("M4-14 a report, an operator's suspension and its lift", async () => {
    const room = await publicRoom(owner, `${RUN} reported`);
    const reporter = pool[16].owner;
    const report = await reporter.dash("POST", "/v1/reports", { handle: room.handle, reason: "spam", note: "Staging run report." });
    check(report.ok && typeof report.body?.id === "string", "a signed-in person reports a public room", report.code);
    refusedWith(await reporter.dash("GET", "/v1/moderation/reports"), 403, "not_allowed", "a non-operator can't read the queue");
    refusedWith(await reporter.dash("POST", `/v1/moderation/reports/${report.body?.id}/suspend-room`, { reason: "spam" }), 403, "not_allowed", "nor suspend");
    owed("an operator's ID used by a caller that isn't a person", "an agent has no route to the operator API; moderation.spec.ts checks the kind");
    if (!operator) return skip("an operator suspends and lifts", isLocal ? "no operator is named locally" : "the test operator couldn't sign in");
    const queue = await operator.dash("GET", "/v1/moderation/reports");
    if (queue.status === 403) return record("fail", "the test operator can read the queue", `${operator.id} isn't in OPERATORS yet; the owner names it once`);
    check(queue.ok && (queue.body.reports ?? []).some((r) => r.id === report.body.id), "the report is in the operator's queue");
    await operator.must("POST", `/v1/moderation/reports/${report.body.id}/suspend-room`, { reason: "spam" });
    const gone = await within(CACHE_SECONDS + 15, async () => (await pageText(room.handle)).status === 404, 1000);
    check(gone !== null && gone <= CACHE_SECONDS + 1.5, "the page is not-found within the 30-second cache", `${gone}s, polled every second`);
    const suspendedPage = await pageText(room.handle);
    const random = await pageText(randomHandle());
    check(suspendedPage.status === 404 && suspendedPage.body.length === random.body.length, "a suspended room's handle answers the one not-found");
    refusedWith(await claim(pool[10], room.handle, room.roles[0]), undefined, "workspace_not_found", "claims are refused");
    const seen = await owner.must("GET", `/v1/workspaces/${room.id}/visibility`);
    check(seen.suspension?.reason === "spam", "the owner sees the suspension and its reason");
    await unpublish(owner, room.id);
    const { view_hash } = await owner.must("GET", `/v1/workspaces/${room.id}/visibility`);
    refusedWith(await owner.dash("PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "public", view_hash }), 403, "room_suspended", "and can't publish again");
    await operator.must("POST", `/v1/moderation/reports/${report.body.id}/lift-room`, { reason: "spam" });
    const back = await publish(owner, room.id);
    check((await within(40, async () => (await page(back)).status === 200)) !== null, "once lifted, it publishes again and its page is served");
  });

  // ---- M4-15: the public read isn't on the gateway's hostname ----
  await step("M4-15 the gateway's public hostname has no public read route", async () => {
    const room = await publicRoom(owner, `${RUN} gateway probe`);
    for (const path of [`/v1/public/workrooms/${room.handle}`, `/api/v1/public/workrooms/${room.handle}`, `/p/${room.handle}`, `/v1/public/explore`]) {
      const res = await target.http(path);
      const text = await res.text();
      check(res.status !== 200 && !text.includes(room.handle), `${path} on the gateway doesn't serve the view`, `HTTP ${res.status}`);
    }
    owed("the public assertion kind sent to every other API route", "a client can't mint that assertion; the API's route-list tests cover it");
  });

  // ---- M4-17: both protocols in one public room ----
  await step("M4-17 a public participant over A2A and another over MCP", async () => {
    const room = await publicRoom(owner, `${RUN} both protocols`);
    const lead = await agentOf(owner, `${RUN} lead`, { policy: null });
    await owner.addAgent(room.id, lead, "member");
    const overA2aOwner = pool[17].owner;
    const overA2a = await agentOf(overA2aOwner, `${RUN} a2a participant`);
    // A real MCP client, through the gateway's /mcp with its own OAuth, not Agent Auth.
    const overMcp = await agentOf(pool[18].owner, `${RUN} mcp participant`, { over: "mcp" });
    check(overMcp instanceof McpAgent, "the MCP participant is an MCP client");
    check((await claim(overA2a, room.handle, room.roles[0])).ok && (await claim(overMcp, room.handle, room.roles[0])).ok, "both claim publicly");
    const token = await linkedA2aToken(target, overA2aOwner, overA2a);
    // Hand-written JSON-RPC: the A2A SDK has no call for the lifecycle extension's methods.
    const rpc = async (method, params, requestId = randomUUID()) => {
      const res = await target.http("/a2a", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "1.0", "A2A-Extensions": "https://podster.dev/a2a/lifecycle/v1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `podster.lifecycle.v1.${method}`, params: { requestId, ...params } }) });
      return res.json();
    };
    const a2aTask = await lead.must("create_task", { workspace_id: room.id, title: "Brief over A2A", instructions: "Two paragraphs.", acceptance_criteria: "Dates.", assignee: overA2a.id, reviewer: owner.id });
    const accepted = await rpc("AcceptTask", { id: `${room.id}:${a2aTask.id}`, version: a2aTask.version });
    const version = accepted.result?.metadata?.["podster.dev/version"];
    check(version !== undefined, "it accepts over A2A", JSON.stringify(accepted.error ?? {}).slice(0, 160));
    const submitId = randomUUID();
    const submission = { id: `${room.id}:${a2aTask.id}`, version, note: "From the M4 staging run.", artifacts: [{ uri: "https://example.com/m4", label: "Brief" }] };
    const submitted = await rpc("SubmitTask", submission, submitId);
    check(!submitted.error, "and submits over A2A", JSON.stringify(submitted.error ?? {}).slice(0, 160));
    // The same submit delivered again, with the same requestId: the same answer, and no second effect.
    const historyOf = async (task) => (await owner.must("GET", `/v1/workspaces/${room.id}/tasks/${task.id}`)).history;
    const before = await historyOf(a2aTask);
    const redelivered = await rpc("SubmitTask", submission, submitId);
    check(!redelivered.error && JSON.stringify(redelivered.result) === JSON.stringify(submitted.result), "a redelivery with the same requestId gets the same answer", JSON.stringify(redelivered.error ?? {}).slice(0, 160));
    check(JSON.stringify(await historyOf(a2aTask)) === JSON.stringify(before), "and changes nothing");
    const mcpTask = await lead.must("create_task", { workspace_id: room.id, title: "Dates over MCP", instructions: "List them.", acceptance_criteria: "All.", assignee: overMcp.id, reviewer: owner.id });
    const mcpAccepted = await overMcp.must("accept_task", { workspace_id: room.id, task_id: mcpTask.id, version: mcpTask.version });
    await overMcp.must("submit_task", { workspace_id: room.id, task_id: mcpTask.id, version: mcpAccepted.version, note: "Listed." });
    for (const [label, task, actor] of [["A2A", a2aTask, overA2a], ["MCP", mcpTask, overMcp]]) {
      const history = await historyOf(task);
      const of = (type) => history.filter((e) => e.type === type);
      check(of("task.accepted").length === 1 && of("task.submitted").length === 1, `the ${label} task has one history`, `${of("task.accepted").length} accepted, ${of("task.submitted").length} submitted`);
      check(of("task.accepted")[0]?.actor_id === actor.id && of("task.submitted")[0]?.actor_id === actor.id, `and its participant is the actor`);
    }
    const tasks = await owner.must("GET", `/v1/workspaces/${room.id}/tasks`);
    check(tasks.tasks.length === 2, "two tasks, and no competing ones", `${tasks.tasks.length}`);
  });

  // ---- M4-16: the logs ----
  await step("M4-16 the apps' logs carry IDs only", async () => {
    if (isLocal) return skip("the logs during the run", "the local runner checks the Workers' own output instead");
    // Every tail must still be alive now: a closing marker has to reach each, and none may have exited.
    const closing = await markerSeenInEveryTail(owner, 60);
    check(closing.ok, "every tail is still connected at the end, shown by a closing marker", closing.detail);
    await sleep(3_000);
    stopTails();
    for (const tail of tails) {
      const ours = tailText(tail).filter((text) => [...runIds].some((id) => text.includes(id))).length;
      // Stopped by the run just now, so a signal isn't a problem here; an error, or an overflow in the last moments, is.
      const problem = tail.error ?? tail.stream.error;
      check(!problem && ours > 0, `the ${tail.app}'s tail holds this run's own requests`, problem ?? `${tail.stream.values.length} events, ${ours} of this run's`);
    }
    const logged = tails.map(appLogged).join("\n");
    check(!canaryPattern.test(logged), "no canary in what the apps logged");
    check(!logged.includes("Staging run report."), "no report note in what the apps logged");
    check(!/[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{24,}/.test(logged), "no access token in what the apps logged");
    // The address Cloudflare itself saw for this run, IPv4 or IPv6, from the same host the run used.
    const trace = await fetch(`${base}/cdn-cgi/trace`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    const ip = /^ip=(.+)$/m.exec(trace)?.[1]?.trim();
    check(Boolean(ip && /^[0-9a-f.:]+$/i.test(ip)), "the address Cloudflare saw for this run is known, to look for it");
    if (ip) check(!logged.includes(ip), "no client IP address in what the apps logged");
  });
} catch (error) {
  record("fail", "the run stopped", cause(error));
} finally {
  await cleanUp();
}

const tally = (status) => results.filter((r) => r.status === status).length;
const [passed, failed, skipped, owedCount] = ["ok", "fail", "skip", "owed"].map(tally);
if (failed === 0 && (skipped === 0 || isLocal)) {
  console.log(`\nM4 ${isLocal ? "local rehearsal" : "staging run"} PASSED: ${passed} checks passed, 0 failed, ${skipped} skipped, ${owedCount} owed by design.`);
  exitCode = 0;
} else {
  console.log(`\nM4 ${isLocal ? "local rehearsal" : "staging run"} FAILED: ${passed} passed, ${failed} failed, ${skipped} skipped${!isLocal && skipped ? " (a skip fails a staging run)" : ""}, ${owedCount} owed by design.`);
}
process.exit(exitCode);
