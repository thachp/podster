// M6's staging run, started at M6 build step 2 (docs/m6-plan.md, "Staging script"). Release is switched off on staging
// (`RELEASES` is set nowhere), so today it shows two things only:
//
// - M6 can't be detected there. Every M6 operation the contract lists, read from it at run time, answers each kind of
//   caller with the API's own answer for a missing route, exactly as an invented neighbouring path does. An agent
//   through /mcp gets the same JSON-RPC error for an M6 tool name as for an invented one. No read, tool list, capability
//   list or event names anything of M6's.
// - The room schema step that build step 2 added harmed nothing in a room made after the deploy: one ordinary task runs
//   end to end there. A room made before the deploy, where a migration could really harm one, isn't reachable with test
//   people, who are new on every run, so M6-S04 says SKIP and why.
//
//   node m6-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
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
// configuration or a failed preflight, with no sign-up taken.
//
// Left behind, as every staging run's are: the two test people, the owner's organization made for the run, the room,
// its task, and the agent. The agent is disconnected at the end, which ends its OAuth credential; the output says if
// that failed, and then its credential stays valid until it expires. An agent whose connect failed after the consent
// made it is found by name and disconnected then, or listed as left behind. Every test session is signed out. Ctrl-C stops
// the run at its next request and still cleans up.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABSENT_ROOM, agentCapabilities, answerShape, CALLERS, differences, expectedAnswer, fillPath, m6EventTypes, m6Fields, m6Keys, m6Names, m6Operations, mcpErrorProblem, neighbour, operationsProblem, pairProblem, parseArgs, personOnly, PLAN, runOutcome, scrub, secretProblem, SIGN_UPS, snake, STAGING, Tally, toolAnswer, toolNotFound, USAGE,
} from "./m6-staging-lib.mjs";

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
  const problems = [secretProblem(signupSecret), contractProblem].filter(Boolean);
  console.log(`M6's staging run, switched off, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${SIGN_UPS.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of SIGN_UPS) console.log(`  - ${who}: ${why}`);
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
    console.log("\nThe configuration is complete. Nothing was sent to staging.");
    process.exit(0);
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, key, McpAgent, ok, Person, sleep, Target } = await import("./lib.mjs");

const POLL_MS = 2000;
/** Between two requests of one caller's: the gateway allows a person 120 a minute, and this keeps well under it. */
const PACE_MS = 600;
const target = new Target(STAGING, { pollMs: POLL_MS });
const RUN = `M6 staging ${new Date().toISOString().slice(0, 16)}`;
const secrets = [signupSecret];
const secret = (value) => {
  if (typeof value === "string" && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
  return value;
};
const say = (line = "") => console.log(scrub(line, secrets));
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
let signUpUnknown = false;
/**
 * One take of the test sign-up. Never sent twice: a sign-up whose answer was lost in transport may have been taken, so
 * it isn't asked again, and no later sign-up is asked for either. The run then fails, saying the outcome is unknown.
 */
async function person(label) {
  ok(!signUpUnknown, `the test sign-up for ${label} wasn't asked for: an earlier sign-up's outcome is unknown`);
  signUpsAsked++;
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
  for (const value of [cookie, ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)).filter((value) => value.length >= 16)]) secret(value);
  sessions.push(cookie);
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
async function compareAll(caller, who, where, { raw = '{"reason":"abuse"}', writesOnly = false } = {}) {
  const found = [];
  const seen = new Set();
  let asked = 0;
  let again = 0;
  for (const op of operations) {
    if (writesOnly && op.method === "GET") continue;
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

  await check("M6-S04", async () => {
    throw new Skip("not shown: a room made before the deploy, where the room schema step's migration could really harm one, belongs to an earlier run's test people, whose sessions no run keeps. M6-S03 shows a fresh room only");
  });
}

const started = Date.now();
try {
  await preflight();
} catch (error) {
  console.error(scrub(`\nRefused: the signed-out preflight failed: ${cause(error)}.\nNo sign-up was taken.`, secrets));
  process.exit(2);
}
try {
  await main();
} catch (error) {
  say(`\nThe run stopped: ${cause(error)}`);
} finally {
  tally.skipRest(stopping ? "not run: the run was stopped by a signal" : "not run: the run stopped before it");
  for (const { agent: each, linker } of agents) {
    await each.close().catch(() => null);
    await disconnect(linker, each.id);
  }
  for (const cookie of sessions) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
}
const outcome = runOutcome(tally);
say(`\n${tally.summary()}, in ${Math.round((Date.now() - started) / 1000)} s. Sign-ups asked for: ${signUpsAsked}, answered with a session: ${sessions.length}. Checks shown on staging: ${outcome.shownOnStaging}.`);
if (signUpUnknown) say("A sign-up's answer was lost in transport: whether staging took it is unknown, and it wasn't asked again.");
if (outcome.unshown.length) say(`Not shown on staging, so the run doesn't count as passed: ${outcome.unshown.join(", ")}.`);
say(`Left behind on staging: ${leftBehind.length ? leftBehind.join("; ") : "nothing"}. Every test session was signed out.`);
process.exit(outcome.code);
