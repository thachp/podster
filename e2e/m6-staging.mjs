// M6's staging run, started at M6 build step 2 (docs/m6-plan.md, "Staging script"). Release is switched off on staging
// (`RELEASES` is set nowhere), so today it shows two things only:
//
// - M6 can't be detected there. Every M6 operation the contract lists, read from it at run time, answers each kind of
//   caller exactly as an invented neighbouring path does; an agent through /mcp has no M6 tool, and calling one answers
//   as an invented tool does; no read, capability list or event names anything of M6's.
// - The room schema step that build step 2 added harmed nothing: a room made after the deploy runs one ordinary task
//   end to end. A room made before the deploy isn't reachable with test people, who are new on every run, so that half
//   says SKIP and why.
//
//   node m6-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// Staging's gateway is the only base URL it accepts. People: two takes of staging's test sign-up, of its 6 a minute and
// 40 a day; the agent is made under the owner and takes none. It switches nothing on and calls no Cloudflare API. Output
// carries IDs, statuses and error codes only, and every credential it handles is scrubbed from it. Exit codes: 0 when
// nothing failed, 1 when a check failed or nothing passed, 2 for a refused configuration.
//
// Clean-up: the rooms, the task and the people stay, as every staging run's do. Every test session is signed out.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABSENT_ROOM, agentCapabilities, answerShape, differences, fillPath, m6EventTypes, m6Fields, m6Names, m6Operations, neighbour, operationsProblem, parseArgs, personOnly, PLAN, scrub, secretProblem, SIGN_UPS, snake, STAGING, Tally, toolAnswer, USAGE,
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
const contractProblem = !contractText ? "the contract couldn't be read" : !capabilitiesText ? "the capability list couldn't be read" : operationsProblem(operations, personOnly(capabilitiesText), agentCapabilities(capabilitiesText));
{
  const problems = [secretProblem(signupSecret), contractProblem].filter(Boolean);
  console.log(`M6's staging run, switched off, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${SIGN_UPS.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of SIGN_UPS) console.log(`  - ${who}: ${why}`);
  console.log(`\nM6 operations, read from the contract: ${operations.length}.`);
  for (const op of operations) console.log(`  ${op.method.padEnd(6)} ${op.path}  ${op.operation}`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const { id, title } of PLAN) console.log(`  ${id.padEnd(8)} ${title}`);
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
/** Between two requests of one person's: the gateway allows a person 120 a minute, and this keeps well under it. */
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

class Skip extends Error {}
const cause = (error) => [error?.code, error?.message].filter(Boolean).join(" ") || String(error);
async function check(id, run) {
  try {
    tally.add(id, "pass", (await run()) ?? "");
    return true;
  } catch (error) {
    tally.add(id, error instanceof Skip ? "skip" : "fail", cause(error));
    return false;
  }
}
const after = (...ids) => {
  const missing = ids.filter((id) => !tally.passed(id));
  if (missing.length) throw new Skip(`not run: it needs ${missing.join(" and ")} to have passed`);
};

// ---- people and the agent ----

const sessions = [];
const agents = [];
async function person(label) {
  const res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}` } });
  ok(res.status === 200, `the test sign-up for ${label} answered ${res.status}. A 404 means it's off on staging, or PODSTER_E2E_SIGNUP_SECRET is wrong.`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  for (const value of [cookie, ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)).filter((value) => value.length >= 16)]) secret(value);
  sessions.push(cookie);
  return Person.fromCookie(target, label, cookie);
}
async function agentOf(linker, label) {
  const made = await McpAgent.connect(target, linker, `${RUN} ${label}`);
  agents.push(made);
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

/**
 * One request of a person's through the gateway, exactly as the dashboard sends it, with `raw` as the body when given.
 * Answers its shape for comparing. Paced, so the person's limit is never what an answer shows.
 */
async function personAnswer(who, method, path, raw) {
  await sleep(PACE_MS);
  const hasBody = method !== "GET" && method !== "HEAD";
  const res = await target.http(`/api${path}`, {
    method,
    headers: { cookie: who.cookie, origin: target.base, ...(who.actingOrg ? { "x-podster-org": who.actingOrg } : {}), ...(hasBody ? { "content-type": "application/json", "idempotency-key": key() } : {}) },
    body: hasBody ? raw : undefined,
  });
  return answerShape(res.status, [...res.headers], await res.text());
}

/** One JSON-RPC call to /mcp with the agent's own access token, as any MCP client sends it. Answers its shape. */
async function mcpAnswer(caller, name) {
  await sleep(PACE_MS);
  const res = await target.http("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${caller.accessToken()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  return answerShape(res.status, [...res.headers], toolAnswer(await res.text(), name));
}

/**
 * Every M6 operation for one kind of caller, each against its invented neighbour. Answers the differences, each naming
 * the route and the caller, and the answers seen, as `status code` pairs.
 */
async function compareAll(label, who, where, { raw = '{"reason":"abuse"}', writesOnly = false } = {}) {
  const found = [];
  const seen = new Set();
  for (const op of operations) {
    if (writesOnly && op.method === "GET") continue;
    const path = fillPath(op.path, where);
    const real = await personAnswer(who, op.method, path, raw);
    const unknown = await personAnswer(who, op.method, neighbour(path), raw);
    const diff = differences(real, unknown);
    if (diff.length) found.push(`${op.method} ${op.path} (${op.operation}) for ${label}: ${diff.join("; ")}`);
    seen.add(`${real.status} ${real.code}`);
  }
  ok(found.length === 0, found.join("\n             "));
  return `${writesOnly ? operations.filter((op) => op.method !== "GET").length : operations.length} routes, each answered as its neighbour: ${[...seen].sort().join(", ")}`;
}

/** Every event in the room, from the start. */
async function roomEvents(reader, where) {
  const events = [];
  let afterSeq = 0;
  for (let pages = 0; pages < 100; pages++) {
    const page = await reader.must("GET", `/v1/workspaces/${where}/events?after=${afterSeq}`);
    if (!page.events?.length) return events;
    events.push(...page.events);
    afterSeq = page.events.at(-1).seq;
  }
  throw new Error("the room's events ran past 100 pages");
}

// ---- the run ----

let owner;
let outsider;
let agent;
let room;
let task;

async function main() {
  await check("M6-S00", async () => `${operations.length} operations: ${operations.map((op) => op.operation).join(", ")}`);

  say("\n## people, the room and the agent");
  try {
    owner = await person("the room's owner");
    outsider = await person("a second person");
    await owner.useNewOrg(`${RUN} team`);
    room = await owner.createRoom(`${RUN} room`);
    agent = await agentOf(owner, "worker");
    await owner.addAgent(room, agent);
    say(`     owner ${owner.id}; second person ${outsider.id}; room ${room}; agent ${agent.id}`);
  } catch (error) {
    say(`     setup failed: ${cause(error)}`);
    tally.skipRest("not run: the run's people, room or agent couldn't be set up");
    return;
  }

  say("\n## switched off: every M6 route, as an invented one");
  await check("M6-S01a", () => compareAll("the room's owner", owner, room));
  await check("M6-S01b", () => compareAll("a second person outside the room", outsider, room));
  await check("M6-S01c", () => compareAll("the owner, for a room that doesn't exist", owner, ABSENT_ROOM));
  await check("M6-S01d", () => compareAll("the owner, a member, with a body that isn't JSON", owner, room, { raw: "{", writesOnly: true }));
  await check("M6-S01e", async () => {
    const listed = m6Names(await agent.tools(), operations);
    ok(listed.length === 0, `the agent's tool list has M6 tools: ${listed.join(", ")}`);
    const found = [];
    for (const op of operations) {
      const name = snake(op.operation);
      const invented = `${name}_x`;
      const [real, unknown] = [await mcpAnswer(agent, name), await mcpAnswer(agent, invented)];
      const diff = differences(real, unknown);
      if (diff.length) found.push(`tools/call ${name} for an agent: ${diff.join("; ")}`);
      const [sdkReal, sdkUnknown] = [await agent.call(name, {}), await agent.call(invented, {})];
      if (sdkReal.ok || toolAnswer(sdkReal.code, name) !== toolAnswer(sdkUnknown.code, invented)) found.push(`tools/call ${name} through the MCP SDK answered other than an invented tool`);
    }
    ok(found.length === 0, found.join("\n             "));
    return `${operations.length} M6 names, each answered as an invented tool, by HTTP and through the SDK`;
  });

  say("\n## the room schema step harmed nothing");
  await check("M6-S03", async () => {
    const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} ordinary task`, instructions: "Write a short note.", assignee: agent.id }, { idempotencyKey: key() });
    const at = { workspace_id: room, task_id: made.id };
    const accepted = await agent.must("accept_task", { ...at, version: made.version });
    const submitted = await agent.must("submit_task", { ...at, version: accepted.version, note: "Done." });
    const reviewed = await owner.must("POST", `/v1/workspaces/${room}/tasks/${made.id}/verify`, { submission_no: 1 });
    const final = await owner.must("GET", `/v1/workspaces/${room}/tasks/${made.id}`);
    eq([made.status, accepted.status, submitted.status, reviewed.status ?? reviewed.task?.status, final.task.status], ["offered", "accepted", "submitted", "completed", "completed"], "the task's status at each step");
    task = made.id;
    return `task ${made.id}: offered, accepted, submitted, completed`;
  });

  say("\n## nothing new is visible");
  await check("M6-S02a", async () => {
    const reads = [["the owner's room read", await owner.must("GET", `/v1/workspaces/${room}`)], ["the agent's room read", await agent.must("get_workspace", { workspace_id: room }, false)]];
    if (task) reads.push(["the owner's task read", await owner.must("GET", `/v1/workspaces/${room}/tasks/${task}`)], ["the agent's task read", await agent.must("get_task", { workspace_id: room, task_id: task }, false)]);
    const found = reads.flatMap(([label, body]) => m6Fields(body).map((field) => `${label}: ${field}`));
    ok(found.length === 0, `M6 fields: ${found.join(", ")}`);
    return `${reads.length} reads${task ? "" : " (no task read: M6-S03 made no task)"}, no M6 field`;
  });
  await check("M6-S02b", async () => {
    const lists = [];
    const tools = await agent.tools();
    lists.push(["the agent's MCP tool list", tools]);
    for (const path of ["/.well-known/agent-configuration", "/api/auth/capability/list"]) {
      const res = await target.http(path, { headers: { accept: "application/json" } });
      let body = null;
      try {
        body = JSON.parse(await res.text());
      } catch {
        // Not JSON: no names from it.
      }
      const names = [];
      const walk = (value) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") for (const [name, inner] of Object.entries(value)) name === "capabilities" && Array.isArray(inner) ? names.push(...inner.map((c) => (typeof c === "string" ? c : c?.name)).filter((n) => typeof n === "string")) : walk(inner);
      };
      walk(body);
      lists.push([`${path} (HTTP ${res.status})`, names]);
    }
    const found = lists.flatMap(([label, names]) => m6Names(names, operations).map((name) => `${label}: ${name}`));
    ok(found.length === 0, `M6 names: ${found.join(", ")}`);
    const listing = lists.filter(([, names]) => names.length > 0);
    ok(listing.length > 0, "nothing listed any capability or tool, so the absence of M6's shows nothing");
    return lists.map(([label, names]) => `${label}: ${names.length} names`).join("; ");
  });
  await check("M6-S02c", async () => {
    const events = await roomEvents(owner, room);
    const types = m6EventTypes(events);
    ok(types.length === 0, `M6 event types: ${types.join(", ")}`);
    return `${events.length} events, types ${[...new Set(events.map((e) => e.type))].sort().join(", ")}`;
  });

  await check("M6-S04", async () => {
    throw new Skip("not shown: a room made before the deploy belongs to an earlier run's test people, whose sessions no run keeps, so no test person can reach one");
  });
}

const started = Date.now();
try {
  await main();
} catch (error) {
  say(`\nThe run stopped: ${cause(error)}`);
} finally {
  tally.skipRest("not run: the run stopped before it");
  for (const each of agents) await each.close().catch(() => null);
  for (const cookie of sessions) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
}
say(`\n${tally.summary()}, in ${Math.round((Date.now() - started) / 1000)} s. Sign-ups taken: ${sessions.length}.`);
process.exit(tally.exitCode());
