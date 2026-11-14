// M6's staging run, started at M6 build step 2 (docs/m6-plan.md, "Staging script"). Release is switched off on staging
// (`RELEASES` is set nowhere), so today it shows two things only:
//
// - M6 can't be detected there. Every M6 operation the contract lists, read from it at run time, answers each kind of
//   caller with the API's own answer for a missing route, exactly as an invented neighbouring path does. An agent
//   through /mcp gets the same JSON-RPC error for an M6 tool name as for an invented one. No read, tool list, capability
//   list or event names anything of M6's.
// - The room schema step that build step 2 added harmed nothing in a room made after the deploy: one ordinary task runs
//   end to end there. A room made before the deploy, where a migration could really harm one, isn't reachable with test
//   people, who are new on every run, so the usual run's M6-S04 says SKIP and how to show it instead.
//
//   node m6-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// M6-S04 is two runs of their own, around a deploy (docs/m6-plan.md, "Staging script"):
//
//   node m6-staging.mjs --base-url https://gateway-staging.podster.dev --before-deploy --deployed-commit SHA
//   (deploy with scripts/deploy-staging)
//   node m6-staging.mjs --base-url https://gateway-staging.podster.dev --after-deploy --deployed-commit SHA
//
// The first takes one test sign-up and makes a room with a task part-way through its life. The test sign-up can't sign a
// test person in again, so it keeps the owner's test session, with IDs only beside it, in ~/.podster/m6-staging/s04.json
// at mode 0600, never printed. The second takes no sign-up. It refuses unless that file is usable, isn't stale and names
// another commit than the one it's told staging is at now; staging doesn't say its commit to a signed-out caller, so
// --deployed-commit is what scripts/deploy-staging printed. It finishes the task in the older room, then signs the session
// out and deletes the file, whatever its checks found.
//
// Staging's gateway is the only base URL it accepts. Before any sign-up, two signed-out reads show staging answers as
// expected. People: two takes of staging's test sign-up, of its 6 a minute and 40 a day: the owner's first, and the
// second person's only once the owner's organization, room and agent are made. A sign-up is never sent twice: one whose
// answer is lost in transport may have been taken, so the run stops asking for sign-ups and fails, saying its outcome is
// unknown. The agent is made under the owner and takes none. It switches nothing on and calls no Cloudflare API. Output carries IDs, statuses and error codes only,
// and every credential it handles is scrubbed from it.
//
// Exit codes: 0 only when nothing failed and every check that needs staging passed (M6-S04 may say SKIP; M6-S00 reads
// this checkout only and never counts as shown); 1 otherwise, the output naming what wasn't shown; 2 for a refused
// configuration, a kept file that can't be used, or a failed preflight, with no sign-up taken. Each phase is the same,
// with its own checks, none of which may say SKIP.
//
// Left behind, as every staging run's are: the two test people, the owner's organization made for the run, the room,
// its task, and the agent. The agent is disconnected at the end, which ends its OAuth credential; the output says if
// that failed, and then its credential stays valid until it expires. An agent whose connect failed after the consent
// made it is found by name and disconnected then, or listed as left behind. Every test session is signed out. Ctrl-C stops
// the run at its next request and still cleans up.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABSENT_ROOM, agentCapabilities, answerShape, CALLERS, differences, expectedAnswer, fillPath, keptFile, KEPT_MARGIN_SECONDS, keptProblem, keptRecord, m6EventTypes, m6Fields, m6Keys, m6Names, m6Operations, mcpErrorProblem, neighbour, operationsProblem, pairProblem, parseArgs, personOnly, PHASE_SIGN_UPS, planFor, QUEUE_KEYS, queueRefusalProblem, runOutcome, scrub,
  requestLine, requestPath, secretProblem, SESSION_SECONDS, SIGN_UPS, slowestLine, snake, STAGING, Tally, toolAnswer, toolNotFound, USAGE,
} from "./m6-staging-lib.mjs";
import { keptDirectoryProblem, readKept, removeKept, sweepKept, writeKept } from "./m6-staging-kept.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
const options = parsed.options;
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
const phase = options.phase;
const PLAN = planFor(phase);
const signUpsPlanned = phase ? PHASE_SIGN_UPS[phase] : SIGN_UPS;
const keptAt = keptFile(homedir());
/** Shown in place of the kept file's path, which names the runner's home. */
const KEPT_SHOWN = "~/.podster/m6-staging/s04.json";

// ---- the contract, the plan and the configuration, before anything is sent ----

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const contractText = read(options.contract ?? join(here, "../packages/contracts/openapi.yaml"));
const capabilitiesText = read(options.capabilities ?? join(here, "../packages/contracts/capabilities.yaml"));
const operations = contractText ? m6Operations(contractText) : [];
const fieldKeys = contractText ? m6Keys(contractText) : [];
const contractProblem = !contractText ? "the contract couldn't be read" : !capabilitiesText ? "the capability list couldn't be read" : operationsProblem(operations, personOnly(capabilitiesText), agentCapabilities(capabilitiesText)) ?? (fieldKeys.length ? null : "the contract gives no M6 field to look for");
{
  const problems = [signUpsPlanned.length ? secretProblem(signupSecret) : null, contractProblem].filter(Boolean);
  const which = phase ? `, M6-S04's ${phase === "before" ? "first phase, before a deploy" : "second phase, after a deploy"}, with staging named at ${options.deployedCommit}` : "";
  console.log(`M6's staging run, switched off, against ${STAGING}${which}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${signUpsPlanned.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of signUpsPlanned) console.log(`  - ${who}: ${why}`);
  console.log(`\nM6 operations, read from the contract: ${operations.length}.`);
  for (const op of operations) console.log(`  ${op.method.padEnd(6)} ${op.path}  ${op.operation}`);
  console.log(`M6 fields, derived from the contract's M6 schemas: ${fieldKeys.join(", ") || "none"}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const { id, title, offline, maySkip } of PLAN) console.log(`  ${id.padEnd(8)} ${title}${offline ? " [reads this checkout only]" : ""}${maySkip ? " [may say SKIP]" : ""}`);
  }
  for (const problem of problems) console.error(`\nRefused: ${problem}.`);
  if (problems.length) process.exit(2);
  if (options.dryRun) {
    console.log(`\nThe configuration is complete. Nothing was sent to staging${phase ? `, and ${KEPT_SHOWN} wasn't read` : ""}.`);
    process.exit(0);
  }
}

// ---- each request's timing ----

/**
 * Every request the run sends, retries included, each logged as it ends: when it started, its method, its path with IDs
 * as they are, its status or error name, and its milliseconds. Never a body, a header, a cookie or a query. The slowest
 * are named again at the end.
 */
const requests = [];
function logRequest({ url, ...request }, hidden) {
  const entry = { ...request, path: requestPath(url) };
  requests.push(entry);
  console.log(scrub(requestLine(entry), hidden));
}

// ---- M6-S04's kept file: every local check, before anything is sent ----

/**
 * Signs a stale kept session out, before its file is deleted, so a session that hadn't quite ended ends now. The one
 * request it sends; it never prints the session. Says how that went.
 */
async function endStaleSession(session) {
  const url = `${STAGING}/api/auth/sign-out`;
  const at = new Date().toISOString();
  const begun = performance.now();
  const heard = (outcome) => logRequest({ url, method: "POST", at, ms: Math.round(performance.now() - begun), ...outcome }, [session]);
  try {
    const res = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie: session, origin: STAGING, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    heard({ status: res.status });
    return `its session's sign-out answered ${res.status}`;
  } catch (error) {
    heard({ error: error?.name ?? "Error" });
    return "its session's sign-out failed in transport";
  }
}

/** The second phase's record, once it's shown usable. */
let kept = null;
if (phase) {
  const refuse = (why, sent = "Nothing was sent to staging.") => {
    console.error(`\nRefused: ${why}.\n${sent}`);
    process.exit(2);
  };
  // The first phase proves its file can be written where it goes, with a probe written the same way, so a directory that
  // would refuse it never costs a sign-up. Either phase first sweeps temporary files a killed run left, which may hold a
  // session.
  const prepared = phase === "before" ? keptDirectoryProblem(keptAt) : sweepKept(keptAt);
  if (prepared.problem) refuse(`the kept file couldn't be ${phase === "before" ? "written" : "read"} safely: ${prepared.problem} (${KEPT_SHOWN})`);
  if (prepared.swept) console.log(`\n${prepared.swept} temporary file(s) a killed run left beside ${KEPT_SHOWN} were deleted.`);
  const found = readKept(keptAt);
  if (found.problem) refuse(`${found.problem} (${KEPT_SHOWN}). Look at it, and delete it if it isn't needed`);
  const now = Date.now();
  // Asked with a commit no record can name, so the answer is null for a usable file of this script's, the stale
  // refusal for a stale one, and anything else for a file that isn't this script's or is out of shape.
  const standing = found.missing ? null : keptProblem(found.record, { now, commit: null });
  const stale = typeof standing === "string" && standing.startsWith("the kept file is stale");
  if (phase === "before" && !found.missing) {
    if (standing && !stale) refuse(`a file is at ${KEPT_SHOWN} that isn't a kept file of this script's (${standing}). Look at it, and delete it if it isn't needed`);
    if (!stale) refuse(`an earlier first phase's kept file is still usable (${KEPT_SHOWN}): run --after-deploy after the deploy, or wait until it's stale`);
    const ended = await endStaleSession(found.record.session);
    if (!removeKept(keptAt)) refuse(`an earlier first phase's kept file is stale and couldn't be deleted (${KEPT_SHOWN}); ${ended}`, "Only that sign-out was sent to staging.");
    console.log(`\nAn earlier first phase's kept file was stale, so its test session had ended or was about to: ${ended}, and the file was deleted. Its room is left behind.`);
  }
  if (phase === "after") {
    if (found.missing) refuse(`no kept file at ${KEPT_SHOWN}: run --before-deploy before the deploy first`);
    if (stale) {
      const ended = await endStaleSession(found.record.session);
      const deleted = removeKept(keptAt);
      refuse(`${standing}. ${ended[0].toUpperCase()}${ended.slice(1)}, and ${deleted ? "the file was deleted" : `the file couldn't be deleted: delete ${KEPT_SHOWN} by hand`}; its room is left behind. Run both phases again`, "Only that sign-out was sent to staging.");
    }
    const problem = keptProblem(found.record, { now, commit: options.deployedCommit });
    if (problem) refuse(`${problem} (${KEPT_SHOWN})`);
    kept = found.record;
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, key, McpAgent, ok, Person, sleep, Target } = await import("./lib.mjs");

const POLL_MS = 2000;
/** Between two requests of one caller's: the gateway allows a person 120 a minute, and this keeps well under it. */
const PACE_MS = 600;
const target = new Target(STAGING, { pollMs: POLL_MS, onRequest: (request) => logRequest(request, secrets) });
const RUN = `M6 staging ${new Date().toISOString().slice(0, 16)}`;
const secrets = [signupSecret, kept?.session].filter(Boolean);
const secret = (value) => {
  if (typeof value === "string" && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
  return value;
};
const say = (line = "") => console.log(scrub(line, secrets));
/** A session cookie, and each value in it, are scrubbed from everything the run prints. */
const secretCookie = (cookie) => {
  for (const value of [cookie, ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)).filter((value) => value.length >= 16)]) secret(value);
};
if (kept) secretCookie(kept.session);
const tally = new Tally(PLAN, say);

/** A check that can't run here, with why. */
class Skip extends Error {}
/** The run was told to stop. Not a check's failure: it ends the flow. */
class Halt extends Error {}
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping at the next request; clean-up follows. Press Ctrl-C again to quit at once, without it.");
});
const cause = (error) => [error?.code, error?.message].filter(Boolean).join(" ") || String(error);
async function check(id, run) {
  if (stopping) throw new Halt("stopped by a signal");
  try {
    tally.add(id, "pass", (await run()) ?? "");
    return true;
  } catch (error) {
    if (error instanceof Halt) throw error;
    tally.add(id, error instanceof Skip ? "skip" : "fail", cause(error));
    return false;
  }
}
const pause = async (ms) => {
  if (stopping) throw new Halt("stopped by a signal");
  await sleep(ms);
};

/**
 * One request, retried once on a transport error, as the run's other staging scripts do, unless `retry` is false.
 * Target already waits out a 429 twice, after the wait the gateway names (at most 70 s), before it gives the 429 back.
 * Throws naming the request.
 */
async function send(label, path, init, { retry = true } = {}) {
  for (let attempt = 1; ; attempt++) {
    await pause(PACE_MS);
    try {
      return await target.http(path, init);
    } catch (error) {
      if (!retry) throw new Error(`${label}: the request failed in transport (${cause(error.cause ?? error)})`);
      if (attempt >= 2) throw new Error(`${label}: the request failed twice in transport (${cause(error.cause ?? error)})`);
    }
  }
}

// ---- people and the agent ----

const sessions = [];
const agents = [];
const leftBehind = [];
let signUpsAsked = 0;
let signUpsAnswered = 0;
let signedUpAt = 0;
/** The session the first phase keeps for the second, which the run then doesn't sign out. */
let keptSession = null;
let signUpUnknown = false;
/**
 * One take of the test sign-up. Never sent twice: a sign-up whose answer was lost in transport may have been taken, so
 * it isn't asked again, and no later sign-up is asked for either. The run then fails, saying the outcome is unknown.
 */
async function person(label) {
  ok(!signUpUnknown, `the test sign-up for ${label} wasn't asked for: an earlier sign-up's outcome is unknown`);
  signUpsAsked++;
  // Before the request, so a kept session's end is never later than this says.
  signedUpAt = Date.now();
  let res;
  try {
    res = await send(`the test sign-up for ${label}`, "/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}` } }, { retry: false });
  } catch (error) {
    if (error instanceof Halt) throw error;
    signUpUnknown = true;
    throw new Error(`${cause(error)}. Whether staging took that sign-up is unknown, so it wasn't asked again`);
  }
  ok(res.status === 200, `the test sign-up for ${label} answered ${res.status}. A 404 means it's off on staging, or PODSTER_E2E_SIGNUP_SECRET is wrong.`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  secretCookie(cookie);
  sessions.push(cookie);
  signUpsAnswered++;
  const made = await Person.fromCookie(target, label, cookie);
  leftBehind.push(`${label} ${made.id}`);
  return made;
}
/** Disconnects an agent, which ends its OAuth credential, and says how that went. */
async function disconnect(linker, id) {
  const res = await linker.dash("POST", `/agents/${id}/disconnect`, {}).catch((error) => ({ status: cause(error) }));
  say(`Agent ${id}: ${res.status === 200 ? "disconnected, so its OAuth credential no longer works" : `the disconnect answered ${res.status}: its OAuth credential stays valid until it expires`}.`);
}

/**
 * An agent under `linker`, through the MCP SDK and the consent form. If the connect fails midway, after the consent
 * made the agent, the agent is found by its name in the run's organization and disconnected, or listed as left behind.
 */
async function agentOf(linker, label) {
  const name = `${RUN} ${label}`;
  let made;
  try {
    made = await McpAgent.connect(target, linker, name);
  } catch (error) {
    const listed = await linker.dash("GET", "/agents").catch(() => null);
    const halfMade = listed?.ok && Array.isArray(listed.body?.agents) ? listed.body.agents.filter((each) => each.org_id === linker.actingOrg && each.name === name && !each.revoked_at) : null;
    if (!halfMade) leftBehind.push(`possibly an agent named "${name}", made before its connect failed: the agent list couldn't be read, so it wasn't disconnected`);
    for (const each of halfMade ?? []) {
      leftBehind.push(`agent ${each.id}, made before its connect failed`);
      await disconnect(linker, each.id);
    }
    throw error;
  }
  agents.push({ agent: made, linker });
  const keep = (held) => {
    secret(held?.access_token);
    secret(held?.refresh_token);
  };
  keep(made.provider?.tokens?.());
  const save = made.provider?.saveTokens;
  if (typeof save === "function") {
    made.provider.saveTokens = (held) => {
      keep(held);
      return save(held);
    };
  }
  return made;
}

/** One request of a person's through the gateway, exactly as the dashboard sends it, with `raw` as the body. Answers its shape. */
async function personAnswer(who, method, path, raw) {
  const hasBody = method !== "GET" && method !== "HEAD";
  const res = await send(`${method} ${path} as ${who.label}`, `/api${path}`, {
    method,
    headers: { cookie: who.cookie, origin: target.base, ...(who.actingOrg ? { "x-podster-org": who.actingOrg } : {}), ...(hasBody ? { "content-type": "application/json", "idempotency-key": key() } : {}) },
    body: hasBody ? raw : undefined,
  });
  return answerShape(res.status, [...res.headers], await res.text());
}

/** One JSON-RPC call to /mcp with the agent's own access token, as any MCP client sends it. Answers its shape. */
async function mcpAnswer(caller, name) {
  const res = await send(`tools/call ${name}`, "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${caller.accessToken()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  return answerShape(res.status, [...res.headers], toolAnswer(await res.text(), name));
}

/**
 * Every M6 operation for one kind of caller, each against its invented neighbour. A pair that differs is asked once
 * more, so one odd answer doesn't fail the run; a pair that still differs, or that is alike and isn't the API's own
 * answer for a missing route for that caller, fails, naming the route and the caller.
 */
async function compareAll(caller, who, where, { raw = '{"reason":"abuse"}', writesOnly = false, readsOnly = false } = {}) {
  const found = [];
  const seen = new Set();
  let asked = 0;
  let again = 0;
  for (const op of operations) {
    if ((writesOnly && op.method === "GET") || (readsOnly && op.method !== "GET")) continue;
    const path = fillPath(op.path, where);
    let real = await personAnswer(who, op.method, path, raw);
    let unknown = await personAnswer(who, op.method, neighbour(path), raw);
    if (differences(real, unknown).length) {
      again++;
      real = await personAnswer(who, op.method, path, raw);
      unknown = await personAnswer(who, op.method, neighbour(path), raw);
    }
    asked++;
    const problem = pairProblem(real, unknown, expectedAnswer(caller, op));
    if (problem) found.push(`${op.method} ${op.path} (${op.operation}) for ${CALLERS[caller].label}: ${problem}`);
    seen.add(`${real.status} ${real.code}`);
  }
  ok(asked > 0, "no route was asked");
  ok(found.length === 0, found.join("\n             "));
  return `${asked} routes, each the API's answer for a missing route and alike with its neighbour: ${[...seen].sort().join(", ")}${again ? `; ${again} pair(s) asked again after a first difference` : ""}`;
}

/** Every event in the room, from the start. Bounded at 100 pages. */
async function roomEvents(reader, where) {
  const events = [];
  let afterSeq = 0;
  for (let pages = 0; pages < 100; pages++) {
    await pause(PACE_MS);
    const page = await reader.must("GET", `/v1/workspaces/${where}/events?after=${afterSeq}`);
    if (!page.events?.length) return events;
    events.push(...page.events);
    afterSeq = page.events.at(-1).seq;
  }
  throw new Error("the room's events ran past 100 pages");
}

/** Every capability name capabilities discovery lists, page by page, bounded at 20 pages. */
async function discoveredCapabilities() {
  const names = [];
  let cursor = 0;
  for (let pages = 0; pages < 20; pages++) {
    const res = await send("capabilities discovery", `/api/auth/capability/list?limit=100&cursor=${cursor}`, { headers: { accept: "application/json" } });
    ok(res.status === 200, `capabilities discovery answered ${res.status}`);
    const body = JSON.parse(await res.text());
    ok(Array.isArray(body?.capabilities), "capabilities discovery answered without a list of capabilities");
    names.push(...body.capabilities.map((c) => c?.name).filter((name) => typeof name === "string"));
    if (!body.has_more) return names;
    ok(body.capabilities.length > 0, "capabilities discovery says there is more and gave an empty page");
    cursor += body.capabilities.length;
  }
  throw new Error("capabilities discovery ran past 20 pages");
}

// ---- the run ----

/** Two signed-out reads before any sign-up: staging is reachable, and the gateway answers as it should. */
async function preflight() {
  const card = await send("the agent configuration", "/.well-known/agent-configuration", { headers: { accept: "application/json" } });
  ok(card.status === 200 && /json/.test(card.headers.get("content-type") ?? ""), `staging's agent configuration answered ${card.status}, not 200 with JSON`);
  const signedOut = await send("a signed-out room list", "/api/v1/workspaces", { headers: { origin: target.base } });
  const body = await signedOut.json().catch(() => null);
  ok(signedOut.status === 401 && body?.error?.code === "sign_in_required", `a signed-out request answered ${signedOut.status} ${body?.error?.code ?? ""}, not 401 sign_in_required`);
}

let owner;
let outsider;
let agent;
let room;
let task;

async function main() {
  await check("M6-S00", async () => `${operations.length} operations: ${operations.map((op) => op.operation).join(", ")}. Read from this checkout: it shows nothing on staging`);

  say("\n## the owner, the room and the agent");
  try {
    owner = await person("the room's owner");
    await owner.useNewOrg(`${RUN} team`);
    leftBehind.push(`the run's organization ${owner.actingOrg}`);
    room = await owner.createRoom(`${RUN} room`);
    leftBehind.push(`room ${room}`);
    agent = await agentOf(owner, "worker");
    leftBehind.push(`agent ${agent.id}`);
    await owner.addAgent(room, agent);
    say(`     owner ${owner.id}; organization ${owner.actingOrg}; room ${room}; agent ${agent.id}`);
  } catch (error) {
    if (error instanceof Halt) throw error;
    say(`     setup failed: ${cause(error)}`);
    tally.skipRest("not run: the owner, the room or the agent couldn't be set up, so the second sign-up wasn't taken");
    return;
  }

  say("\n## switched off: every M6 route, as an invented one");
  await check("M6-S01a", () => compareAll("owner", owner, room));
  await check("M6-S01c", () => compareAll("absent", owner, ABSENT_ROOM));
  await check("M6-S01d", () => compareAll("malformed", owner, room, { raw: "{", writesOnly: true }));
  try {
    outsider = await person("a second person");
    say(`     second person ${outsider.id}`);
  } catch (error) {
    if (error instanceof Halt) throw error;
    say(`     the second sign-up failed: ${cause(error)}`);
  }
  await check("M6-S01b", async () => {
    if (!outsider) throw new Skip("not run: the second person's sign-up failed");
    return compareAll("outsider", outsider, room);
  });
  await check("M6-S01e", async () => {
    /** What's wrong with one M6 name's answers, by HTTP and through the SDK, beside an invented tool's. */
    const askTool = async (name) => {
      const invented = `${name}_x`;
      const problems = [];
      const [real, unknown] = [await mcpAnswer(agent, name), await mcpAnswer(agent, invented)];
      for (const [which, shape] of [["", real], [", an invented tool", unknown]]) {
        const problem = mcpErrorProblem(shape);
        if (problem) problems.push(`tools/call ${name} for an agent${which}: ${problem}`);
      }
      const diff = differences(real, unknown);
      if (diff.length) problems.push(`tools/call ${name} for an agent, beside an invented tool: ${diff.join("; ")}`);
      await pause(PACE_MS);
      const [sdkReal, sdkUnknown] = [await agent.call(name, {}), await agent.call(invented, {})];
      const [sdkRealText, sdkUnknownText] = [toolAnswer(sdkReal.code, name), toolAnswer(sdkUnknown.code, invented)];
      if (sdkReal.ok || sdkUnknown.ok || !toolNotFound(sdkRealText) || sdkRealText !== sdkUnknownText) problems.push(`tools/call ${name} through the MCP SDK wasn't "tool not found" alike with an invented tool`);
      return problems;
    };
    const found = [];
    let again = 0;
    for (const op of operations) {
      const name = snake(op.operation);
      let problems = await askTool(name);
      if (problems.length) {
        again++;
        problems = await askTool(name);
      }
      found.push(...problems);
    }
    ok(found.length === 0, found.join("\n             "));
    return `${operations.length} M6 names, each "tool not found" as a JSON-RPC error with HTTP 200, alike with an invented tool, by HTTP and through the SDK${again ? `; ${again} name(s) asked again after a first problem` : ""}`;
  });

  say("\n## the room schema step harmed nothing, in a room made after the deploy");
  await check("M6-S03", async () => {
    const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} ordinary task`, instructions: "Write a short note.", assignee: agent.id }, { idempotencyKey: key() });
    leftBehind.push(`task ${made.id}`);
    const at = { workspace_id: room, task_id: made.id };
    const accepted = await agent.must("accept_task", { ...at, version: made.version });
    const submitted = await agent.must("submit_task", { ...at, version: accepted.version, note: "Done." });
    const reviewed = await owner.must("POST", `/v1/workspaces/${room}/tasks/${made.id}/verify`, { submission_no: 1 });
    const final = await owner.must("GET", `/v1/workspaces/${room}/tasks/${made.id}`);
    eq([made.status, accepted.status, submitted.status, reviewed.status ?? reviewed.task?.status, final.task.status], ["offered", "accepted", "submitted", "completed", "completed"], "the task's status at each step");
    task = made.id;
    return `task ${made.id}: offered, accepted, submitted, completed. A fresh room only: a room made before the deploy is M6-S04`;
  });

  say("\n## nothing new is visible");
  await check("M6-S02a", async () => {
    const reads = [["the owner's room read", await owner.must("GET", `/v1/workspaces/${room}`)], ["the agent's room read", await agent.must("get_workspace", { workspace_id: room }, false)]];
    ok(task, "no task read: M6-S03 made no task");
    reads.push(["the owner's task read", await owner.must("GET", `/v1/workspaces/${room}/tasks/${task}`)], ["the agent's task read", await agent.must("get_task", { workspace_id: room, task_id: task }, false)]);
    const found = reads.flatMap(([label, body]) => m6Fields(body, fieldKeys).map((field) => `${label}: ${field}`));
    ok(found.length === 0, `M6 fields: ${found.join(", ")}`);
    return `${reads.length} reads, no M6 field of ${fieldKeys.length} looked for`;
  });
  await check("M6-S02b", async () => {
    const tools = await agent.tools();
    ok(tools.length > 0, "the agent's tool list is empty, so the absence of M6's shows nothing");
    const listed = m6Names(tools, operations);
    ok(listed.length === 0, `the agent's tool list has M6 tools: ${listed.join(", ")}`);
    return `${tools.length} tools, none M6's`;
  });
  await check("M6-S02d", async () => {
    const names = await discoveredCapabilities();
    ok(names.length > 0, "capabilities discovery listed nothing, so the absence of M6's shows nothing");
    const listed = m6Names(names, operations);
    ok(listed.length === 0, `capabilities discovery lists M6 capabilities: ${listed.join(", ")}`);
    return `${names.length} capabilities, none M6's`;
  });
  await check("M6-S02c", async () => {
    const events = await roomEvents(owner, room);
    ok(events.length > 0, "the room has no events, so the absence of M6's shows nothing");
    const types = m6EventTypes(events);
    ok(types.length === 0, `M6 event types: ${types.join(", ")}`);
    return `${events.length} events, types ${[...new Set(events.map((e) => e.type))].sort().join(", ")}`;
  });

  await check("M6-S02e", async () => {
    // Step 9 changed this list's shape for release switched on only. Test people aren't operators, so what they can show
    // is that they're still refused as in M4, with nothing of the new shape in the refusal. The operator's own view
    // isn't shown here: the run never uses the fixed test operator.
    const askers = [["the owner", owner], ...(outsider ? [["the second person", outsider]] : [])];
    const found = [];
    for (const [label, who] of askers) {
      const problem = queueRefusalProblem(await who.dash("GET", "/v1/moderation/reports"));
      if (problem) found.push(`${label}: ${problem}`);
    }
    ok(found.length === 0, found.join("; "));
    return `${askers.length} test ${askers.length === 1 ? "person" : "people"} refused with 403 not_allowed, none of ${QUEUE_KEYS.join(", ")} or a report in the refusal. Not shown: the operator's own view, which test people can't ask for`;
  });

  await check("M6-S04", async () => {
    throw new Skip("not shown in this run: a room made before the deploy, where the room schema step's migration could really harm one, needs a session kept across the deploy. Run --before-deploy before a deploy and --after-deploy after it, each with --deployed-commit; M6-S03 shows a fresh room only");
  });
}

// ---- M6-S04, in two phases around a deploy ----

/** A task's current read, as the owner. */
const taskRead = async (where, id) => (await owner.must("GET", `/v1/workspaces/${where}/tasks/${id}`)).task;

/**
 * The first phase, before a deploy: one sign-up, a room with an agent, and a task offered to it and accepted. The agent
 * is then disconnected, so by the departure rule the task is open again with no assignee: part-way through its life,
 * with state and events written by the commit staging is at now. The owner's session is kept for the second phase.
 */
async function beforeDeploy() {
  await check("M6-S04a", async () => {
    owner = await person("the older room's owner");
    await owner.useNewOrg(`${RUN} team`);
    leftBehind.push(`the run's organization ${owner.actingOrg}`);
    room = await owner.createRoom(`${RUN} older room`);
    leftBehind.push(`room ${room}`);
    const first = await agentOf(owner, "worker before the deploy");
    leftBehind.push(`agent ${first.id}`);
    await owner.addAgent(room, first);
    const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} task across a deploy`, instructions: "Write a short note.", assignee: first.id }, { idempotencyKey: key() });
    leftBehind.push(`task ${made.id}`);
    const accepted = await first.must("accept_task", { workspace_id: room, task_id: made.id, version: made.version });
    eq([made.status, accepted.status], ["offered", "accepted"], "the task's status before the disconnect");
    // The disconnect ends the agent's credential, and its removal from the room releases the task it accepted. Only once
    // it has answered 200 is the agent off the clean-up list; otherwise the clean-up disconnects it again.
    await first.close().catch(() => null);
    const gone = await owner.dash("POST", `/agents/${first.id}/disconnect`, {}).catch((error) => ({ status: cause(error) }));
    ok(gone.status === 200, `the disconnect of agent ${first.id} answered ${gone.status} ${gone.code ?? ""}`);
    const listed = agents.findIndex((each) => each.agent === first);
    if (listed >= 0) agents.splice(listed, 1);
    let released;
    for (let reads = 0; reads < 15; reads++) {
      released = await taskRead(room, made.id);
      if (released.status !== "accepted") break;
      await pause(POLL_MS);
    }
    eq([released.status, released.assignee ?? null], ["open", null], "the task after its agent was disconnected");
    const events = await roomEvents(owner, room);
    const types = events.filter((event) => event.task_id === made.id).map((event) => event.type);
    for (const type of ["task.offered", "task.accepted", "task.assignee_departed"]) ok(types.includes(type), `the room's events have no ${type} for the task`);
    // A stop asked for at any point of this check, even after its last request, keeps nothing: the session is signed out.
    if (stopping) throw new Halt("stopped by a signal");
    writeKept(keptAt, keptRecord({ commit: options.deployedCommit, signedUpAt, owner: owner.id, org: owner.actingOrg, room, task: made.id, eventsSeen: events.length, lastSeq: events.at(-1).seq }, owner.cookie));
    keptSession = owner.cookie;
    task = made.id;
    return `room ${room}, task ${made.id}: offered, accepted, then open with no assignee once agent ${first.id} was disconnected; ${events.length} events. Kept for --after-deploy until ${new Date(signedUpAt + (SESSION_SECONDS - KEPT_MARGIN_SECONDS) * 1000).toISOString().slice(0, 16)} UTC`;
  });
}

/**
 * The second phase, after the deploy: no sign-up. The kept session finishes the task in the room made before the deploy,
 * with a new agent, and reads the room's settings and M6's reads there.
 */
async function afterDeploy() {
  try {
    owner = await Person.fromCookie(target, "the older room's owner", kept.session);
    ok(owner.id === kept.owner, "the kept session is someone other than the first phase's owner");
  } catch (error) {
    if (error instanceof Halt) throw error;
    say(`     the kept session wasn't accepted: ${cause(error)}`);
    tally.skipRest("not run: the kept session wasn't accepted, so nothing in the older room could be read");
    return;
  }
  owner.org = owner.actingOrg = kept.org;
  room = kept.room;
  task = kept.task;
  say(`     owner ${owner.id}; organization ${owner.actingOrg}; room ${room}; task ${task}; staging was at ${kept.deployed_commit}, now at ${options.deployedCommit}`);
  leftBehind.push(`the first phase's test person ${owner.id}, organization ${owner.actingOrg}, room ${room} and task ${task}`);

  say("\n## the room made before the deploy");
  await check("M6-S04b", async () => {
    const before = await taskRead(room, task);
    eq([before.status, before.assignee ?? null], ["open", null], "the task as the first phase left it");
    agent = await agentOf(owner, "worker after the deploy");
    leftBehind.push(`agent ${agent.id}`);
    await owner.addAgent(room, agent);
    const at = { workspace_id: room, task_id: task };
    const offered = await owner.must("POST", `/v1/workspaces/${room}/tasks/${task}/assign`, { version: before.version, assignee: agent.id });
    const accepted = await agent.must("accept_task", { ...at, version: offered.version });
    const submitted = await agent.must("submit_task", { ...at, version: accepted.version, note: "Done." });
    const reviewed = await owner.must("POST", `/v1/workspaces/${room}/tasks/${task}/verify`, { submission_no: 1 });
    const final = await taskRead(room, task);
    eq([offered.status, accepted.status, submitted.status, reviewed.status ?? reviewed.task?.status, final.status], ["offered", "accepted", "submitted", "completed", "completed"], "the task's status at each step");
    return `task ${task}, made before the deploy: offered to agent ${agent.id}, accepted, submitted, completed`;
  });
  await check("M6-S04c", async () => {
    const audit = await owner.must("GET", `/v1/workspaces/${room}/audit?after=0`);
    ok(Array.isArray(audit?.audit) && audit.audit.length > 0, "the room's audit log answered with no entries");
    const reads = [
      ["the owner's room read", await owner.must("GET", `/v1/workspaces/${room}`)],
      ["the room's visibility", await owner.must("GET", `/v1/workspaces/${room}/visibility`)],
      ["the room's audit log", audit],
      ["the owner's task read", await owner.must("GET", `/v1/workspaces/${room}/tasks/${task}`)],
    ];
    ok(agent, "no agent read: M6-S04b connected no agent");
    reads.push(["the agent's room read", await agent.must("get_workspace", { workspace_id: room }, false)], ["the agent's task read", await agent.must("get_task", { workspace_id: room, task_id: task }, false)]);
    const found = reads.flatMap(([label, body]) => m6Fields(body, fieldKeys).map((field) => `${label}: ${field}`));
    ok(found.length === 0, `M6 fields: ${found.join(", ")}`);
    return `${reads.length} reads, no M6 field of ${fieldKeys.length} looked for`;
  });
  await check("M6-S04d", () => compareAll("owner", owner, room, { readsOnly: true }));
  await check("M6-S04e", async () => {
    const events = await roomEvents(owner, room);
    const older = events.filter((event) => event.seq <= kept.last_seq);
    ok(older.length === kept.events_seen, `the room has ${older.length} events up to ${kept.last_seq}, where the first phase read ${kept.events_seen}`);
    ok(events.some((event) => event.seq > kept.last_seq && event.task_id === task && event.type === "task.completed"), "no task.completed for the task after the deploy");
    const types = m6EventTypes(events);
    ok(types.length === 0, `M6 event types: ${types.join(", ")}`);
    return `${events.length} events, the first phase's ${kept.events_seen} still first; types ${[...new Set(events.map((e) => e.type))].sort().join(", ")}`;
  });
}

const started = Date.now();
try {
  await preflight();
} catch (error) {
  console.error(scrub(`\nRefused: the signed-out preflight failed: ${cause(error)}.\nNo sign-up was taken.`, secrets));
  say(slowestLine(requests));
  process.exit(2);
}
if (kept) sessions.push(kept.session);
let halted = false;
try {
  await (phase === "before" ? beforeDeploy : phase === "after" ? afterDeploy : main)();
} catch (error) {
  halted = error instanceof Halt;
  say(`\nThe run stopped: ${cause(error)}`);
} finally {
  tally.skipRest(stopping ? "not run: the run was stopped by a signal" : "not run: the run stopped before it");
  for (const { agent: each, linker } of agents) {
    await each.close().catch(() => null);
    await disconnect(linker, each.id);
  }
  for (const cookie of sessions) if (cookie !== keptSession) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  // The second phase is one try: its writes can't be repeated, so its file goes whatever its checks found.
  if (phase === "after") say(removeKept(keptAt) ? `The kept file ${KEPT_SHOWN} was deleted.` : `The kept file ${KEPT_SHOWN} couldn't be deleted: delete it by hand. Its session was signed out.`);
}
// A stop that arrived once every check had run cut nothing short: the outcome stands, and so does a kept file.
if (stopping && !halted) say("\nThe stop arrived after every check had run, so nothing was cut short. The outcome below stands.");
const outcome = runOutcome(tally, PLAN);
say(`\n${tally.summary()}, in ${Math.round((Date.now() - started) / 1000)} s. Sign-ups asked for: ${signUpsAsked}, answered with a session: ${signUpsAnswered}${kept ? "; the first phase's kept session was used instead" : ""}. Checks shown on staging: ${outcome.shownOnStaging}.`);
if (signUpUnknown) say("A sign-up's answer was lost in transport: whether staging took it is unknown, and it wasn't asked again.");
if (outcome.unshown.length) say(`Not shown on staging, so the run doesn't count as passed: ${outcome.unshown.join(", ")}.`);
say(`Left behind on staging: ${leftBehind.length ? leftBehind.join("; ") : "nothing"}. ${keptSession ? `Every test session was signed out but the owner's, kept in ${KEPT_SHOWN} for --after-deploy; it ends by itself ${SESSION_SECONDS / 3600} hours after its sign-up.` : "Every test session was signed out."}`);
say(slowestLine(requests));
process.exit(outcome.code);
