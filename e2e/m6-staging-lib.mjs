// The parts of m6-staging.mjs that touch nothing: its arguments, the one host it accepts, the plan of checks and the
// run's exit code, which operations and fields the contract says are M6's, and how two answers are compared. Kept apart
// so m6-staging-selftest.mjs can check them without a network, a secret or the e2e packages.
//
// M6 is switched off on staging (RELEASES is set nowhere). Today's checks show it can't be detected there and that the
// room schema step M6 build step 2 added harmed nothing. The checks that need release switched on come later.
export { scrub, secretProblem, stagingOnly, STAGING, Tally } from "./m5-staging-lib.mjs";
import { join } from "node:path";
import { STAGING, stagingOnly } from "./m5-staging-lib.mjs";

/** The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. The agent is made under the owner and takes none. */
export const SIGN_UPS = [
  { who: "the room's owner", why: "owns the room, links the agent, and calls every M6 route as the owner, for a room that doesn't exist, and with a body that isn't JSON. Taken only after the signed-out preflight" },
  { who: "a second person", why: "is in no room of the run's, and calls every M6 route on the owner's room. Taken only once the owner's organization, room and agent are made" },
];

/**
 * The test sign-ups of M6-S04's two phases, around a deploy. Only the first phase signs anyone up; the second uses the
 * session the first kept, because the test sign-up can't sign a test person in again.
 */
export const PHASE_SIGN_UPS = {
  before: [{ who: "the older room's owner", why: "makes the organization, the room, an agent and a task before the deploy, and keeps this session for the second phase. Taken only after the signed-out preflight" }],
  after: [],
};

/**
 * Every check, in the order it runs. "S" for switched off: none needs release switched on. `offline` checks read only
 * this checkout, so a pass of theirs never counts as the run having shown anything on staging. `maySkip` is a check
 * that says SKIP, with why, when what it needs can't be reached; every other staging check must pass for exit 0.
 */
export const PLAN = [
  ["M6-S00", "the contract marks its M6 operations, each is listed person-only, and none is an agent capability", { offline: true }],
  ["M6-S01a", "switched off, each M6 route answers the room's owner with the API's own answer for a missing route, exactly as an invented neighbouring path does: status, error code, body and the compared headers"],
  ["M6-S01c", "the same for a room that doesn't exist"],
  ["M6-S01d", "the same for a member sending a body that isn't JSON, on every M6 write"],
  ["M6-S01b", "the same for a second person who isn't in the room, signed up only once the owner's room works"],
  ["M6-S01e", "an agent through /mcp: calling an M6 operation's name answers 200 with a JSON-RPC error, exactly as an invented tool name does, by HTTP and through the MCP SDK"],
  ["M6-S03", "a room made after the deploy runs one ordinary task end to end: create, assign to an agent, accept, submit, review. A fresh room only: the pre-deploy room is M6-S04"],
  ["M6-S02a", "the room read and the task read, as the owner and as the agent, carry no M6 field"],
  ["M6-S02b", "the agent's MCP tool list names tools, and no M6 tool"],
  ["M6-S02d", "capabilities discovery, every page of /api/auth/capability/list, names capabilities, and no M6 capability"],
  ["M6-S02c", "no M6 event type is in the room's events after every call above"],
  ["M6-S02e", "the operators' report list answers the run's test people, who aren't operators, 403 not_allowed as in M4, and the refusal carries none of step 9's keys (kind, host) and no reports. Test people can't show the operator's own view, which with release switched off must stay M4's: that is shown only by the API's tests"],
  ["M6-S04", "a room that existed before the deploy runs the same task: where the room schema step's migration could really harm a room", { maySkip: true }],
].map(([id, title, flags = {}]) => ({ id, title, offline: Boolean(flags.offline), maySkip: Boolean(flags.maySkip) }));

/**
 * M6-S04 in two phases, run apart, with a deploy between them. Each phase is a run of its own, with its own checks and
 * exit code, and none may say SKIP.
 */
const phasePlan = (rows) => rows.map(([id, title]) => ({ id, title, offline: false, maySkip: false }));
export const PHASE_PLANS = {
  before: phasePlan([
    ["M6-S04a", "before the deploy: a room with an agent, and a task offered to it and accepted; then the agent is disconnected, so by the departure rule the task is open again with no assignee, part-way through its life. The session is kept for the second phase"],
  ]),
  after: phasePlan([
    ["M6-S04b", "after the deploy, the room made before it: its task is still open with no assignee, and is offered to a new agent, accepted, submitted and completed, as M6-S03 does in a fresh room"],
    ["M6-S04c", "the older room's settings reads, the room, its visibility and its audit log, answer, and they and the task read, as the owner and as the agent, carry no M6 field"],
    ["M6-S04d", "every M6 read on the older room answers its owner with the API's own answer for a missing route, exactly as an invented neighbouring path does"],
    ["M6-S04e", "the older room's events still begin with the ones written before the deploy, and none is an M6 event type"],
  ]),
};

/** The plan a run follows: the usual one, or one phase's. */
export const planFor = (phase) => (phase ? PHASE_PLANS[phase] : PLAN);

/**
 * The run's exit code, and what it didn't show. 0 only when nothing failed and every check that needs staging passed,
 * except one that may say SKIP. An offline check's pass never counts as the run having shown something.
 */
export function runOutcome(tally, plan = PLAN) {
  const results = new Map(tally.results.map((r) => [r.id, r.status]));
  const failed = plan.filter((entry) => results.get(entry.id) === "fail").map((entry) => entry.id);
  const unshown = plan.filter((entry) => !entry.offline && !entry.maySkip && results.get(entry.id) !== "pass").map((entry) => entry.id);
  const shownOnStaging = plan.filter((entry) => !entry.offline && results.get(entry.id) === "pass").length;
  return { code: failed.length || unshown.length || shownOnStaging === 0 ? 1 : 0, failed, unshown, shownOnStaging };
}

// ---- M6-S04's kept file ----

/** A commit as git names it in full. */
export const FULL_COMMIT = /^[0-9a-f]{40}$/;
/** The gateway's TEST_SESSION_SECONDS: a test session ends by itself this long after its sign-up, and isn't renewed. */
export const SESSION_SECONDS = 2 * 60 * 60;
/** The kept file is stale this long before the session ends, so the second phase has time to run. */
export const KEPT_MARGIN_SECONDS = 15 * 60;
export const KEPT_KIND = "podster-m6-staging-s04";
/** Where the first phase keeps what the second needs: outside the repository, under the runner's home. */
export const keptFile = (home) => join(home, ".podster", "m6-staging", "s04.json");
const KEPT_FILE_SHOWN = "~/.podster/m6-staging/s04.json";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * What the first phase keeps: the owner's test session, the IDs, the commit staging was at, when it goes stale, and how
 * many of the room's events it read, up to which sequence number.
 */
export function keptRecord({ commit, signedUpAt, owner, org, room, task, eventsSeen, lastSeq }, session) {
  return { kind: KEPT_KIND, base: STAGING, deployed_commit: commit, signed_up_at: signedUpAt, stale_at: signedUpAt + (SESSION_SECONDS - KEPT_MARGIN_SECONDS) * 1000, owner, org, room, task, events_seen: eventsSeen, last_seq: lastSeq, session };
}

/**
 * Why the second phase can't use a kept record, or null. It must be this script's, for staging, not stale, with every ID
 * in shape and a session, and staging must be at another commit than the one the first phase saw.
 */
export function keptProblem(record, { now, commit }) {
  if (!record || typeof record !== "object" || record.kind !== KEPT_KIND) return "the kept file isn't M6-S04's";
  if (record.base !== STAGING) return "the kept file isn't for staging's gateway";
  if (!FULL_COMMIT.test(record.deployed_commit ?? "")) return "the kept file names no full commit";
  if (!Number.isSafeInteger(record.signed_up_at) || record.stale_at !== record.signed_up_at + (SESSION_SECONDS - KEPT_MARGIN_SECONDS) * 1000) return "the kept file's times aren't the ones this script writes";
  if (!["owner", "org", "room", "task"].every((name) => ID.test(record[name] ?? ""))) return "the kept file's IDs aren't in shape";
  if (!Number.isSafeInteger(record.events_seen) || record.events_seen < 1 || !Number.isSafeInteger(record.last_seq) || record.last_seq < record.events_seen) return "the kept file's count of the room's events isn't in shape";
  if (typeof record.session !== "string" || record.session.length < 16) return "the kept file has no session";
  if (record.signed_up_at > now) return "the kept file was written in the future";
  if (now >= record.stale_at) return `the kept file is stale: its test session ends ${SESSION_SECONDS / 3600} hours after its sign-up, and the second phase must start at least ${KEPT_MARGIN_SECONDS / 60} minutes before that`;
  if (record.deployed_commit === commit) return `staging is still at ${commit}, the commit the first phase saw: deploy first`;
  return null;
}

export const USAGE = `node m6-staging.mjs --base-url ${STAGING} [--dry-run] [--contract FILE] [--capabilities FILE]
node m6-staging.mjs --base-url ${STAGING} --before-deploy --deployed-commit SHA [--dry-run]
node m6-staging.mjs --base-url ${STAGING} --after-deploy --deployed-commit SHA [--dry-run]

  --dry-run         check the configuration, read the contract and print the plan. Sends staging nothing.
  --contract        the OpenAPI contract the M6 operations are read from. Defaults to packages/contracts/openapi.yaml.
  --capabilities    the agent capability list. Defaults to packages/contracts/capabilities.yaml.

  PODSTER_E2E_SIGNUP_SECRET     staging's test sign-up secret. Needed, and passed by the runner. Never printed.

  The usual run takes 2 test sign-ups, the first only after a signed-out preflight and the second only once the first's
  room works. It switches nothing on and calls no Cloudflare API. Exit 0 only when every check that needs staging
  passed. M6-S04, a room made before a deploy, says SKIP there: it needs the two phases below, around a deploy.

  --before-deploy   M6-S04's first phase, before a deploy: 1 test sign-up, a room, an agent and a task part-way
                    through its life. It keeps the owner's test session, the IDs and the commit staging is at in
                    ${KEPT_FILE_SHOWN}, mode 0600, until ${(SESSION_SECONDS - KEPT_MARGIN_SECONDS) / 60} minutes after the sign-up.
                    It refuses while an earlier kept file is still usable, and deletes one that is stale.
  --after-deploy    the second phase, after the deploy: no sign-up. It refuses unless the kept file is there, is
                    staging's, isn't stale and names another commit. It finishes the task in that older room, reads
                    its settings and M6's reads, then signs the session out and deletes the file, passed or not.
  --deployed-commit the full commit staging is at, as scripts/deploy-staging printed it ("deploying SHA"). Staging
                    doesn't say which commit it runs to a signed-out caller, so the person running the phases names it.`;

/** The arguments, or why they're refused. Nothing is guessed: an unknown flag or a missing value is an error. */
export function parseArgs(argv, env = {}) {
  const options = { base: undefined, dryRun: false, help: false, contract: undefined, capabilities: undefined, phase: null, deployedCommit: undefined };
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--before-deploy" || flag === "--after-deploy") {
      const phase = flag === "--before-deploy" ? "before" : "after";
      if (options.phase && options.phase !== phase) return { error: "--before-deploy and --after-deploy are two runs, apart: pass one" };
      options.phase = phase;
    } else if (flag === "--base-url" || flag === "--contract" || flag === "--capabilities" || flag === "--deployed-commit") {
      const value = argv[++at];
      if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
      options[{ "--base-url": "base", "--contract": "contract", "--capabilities": "capabilities", "--deployed-commit": "deployedCommit" }[flag]] = value;
    } else return { error: `unknown argument ${flag}` };
  }
  if (options.help) return { options };
  if (options.phase && options.deployedCommit === undefined) return { error: `--${options.phase}-deploy needs --deployed-commit, the full commit staging is at` };
  if (!options.phase && options.deployedCommit !== undefined) return { error: "--deployed-commit is for --before-deploy or --after-deploy only" };
  if (options.phase && !FULL_COMMIT.test(options.deployedCommit)) return { error: "--deployed-commit must be a full commit: 40 lowercase hex characters" };
  options.base ??= env.PODSTER_E2E_BASE_URL;
  if (!options.base) return { error: "pass --base-url, or set PODSTER_E2E_BASE_URL" };
  const refusal = stagingOnly(options.base);
  if (refusal) return { error: refusal };
  options.base = STAGING;
  return { options };
}

// ---- reading the contract ----

const METHODS = ["get", "put", "post", "patch", "delete"];
const M6_MARK = "(M6, ADR 0010";

/**
 * Every operation in the contract, as `{ operation, method, path, text, m6 }`, in the contract's order. `m6` is whether
 * its own summary marks it M6's. The reader knows the contract's layout: a path at two spaces, a method at four, written
 * either as a block or inline.
 */
export function allOperations(openapi) {
  const lines = String(openapi).split("\n");
  const found = [];
  let path = null;
  let current = null;
  const close = () => {
    const id = current?.text.match(/operationId:\s*([A-Za-z0-9_]+)/)?.[1];
    if (id) found.push({ operation: id, method: current.method.toUpperCase(), path: current.path, text: current.text, m6: current.text.includes(M6_MARK) });
    current = null;
  };
  for (const line of lines) {
    const pathLine = line.match(/^ {2}(\/[^\s:]*):\s*$/);
    if (pathLine) {
      close();
      path = pathLine[1];
      continue;
    }
    if (/^\S/.test(line)) {
      close();
      path = null;
      continue;
    }
    const methodLine = path && line.match(/^ {4}([a-z]+):(.*)$/);
    if (methodLine && METHODS.includes(methodLine[1])) {
      close();
      current = { method: methodLine[1], path, text: methodLine[2] };
      continue;
    }
    if (current && /^ {5,}/.test(line)) current.text += `\n${line}`;
    else if (current && /^ {4}\S/.test(line)) close();
  }
  close();
  return found;
}

/** The M6 operations alone, as `{ operation, method, path }`. Read from the file at run time, so the list can't go stale. */
export const m6Operations = (openapi) => allOperations(openapi).filter((op) => op.m6).map(({ operation, method, path }) => ({ operation, method, path }));

/** The keys at the top level of the flow mapping that starts at `text[open]`, which is `{`. */
function flowKeys(text, open) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let token = "";
  for (let at = open; at < text.length; at++) {
    const ch = text[at];
    if (quote) {
      if (ch === quote && text[at - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") {
      depth++;
      token = "";
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && ch === ":" && /^[A-Za-z0-9_]+$/.test(token.trim())) {
      keys.push(token.trim());
      token = "";
    } else if (depth === 1 && ch === ",") token = "";
    else if (depth === 1) token += ch;
  }
  return keys;
}

/** The contract's schemas, as `{ name, text, properties }`: each schema's own text and its properties' names. */
export function schemas(openapi) {
  const lines = String(openapi).split("\n");
  const start = lines.findIndex((line) => /^ {2}schemas:\s*$/.test(line));
  if (start < 0) return [];
  const found = [];
  let current = null;
  for (let at = start + 1; at < lines.length && !/^ {0,2}\S/.test(lines[at]); at++) {
    const head = lines[at].match(/^ {4}([A-Za-z0-9_]+):(.*)$/);
    if (head) {
      current = { name: head[1], text: head[2] };
      found.push(current);
    } else if (current) current.text += `\n${lines[at]}`;
  }
  return found.map(({ name, text }) => {
    const properties = new Set();
    const inline = text.indexOf("properties: {");
    if (inline >= 0) for (const key of flowKeys(text, inline + "properties: ".length)) properties.add(key);
    const block = text.split("\n");
    const at = block.findIndex((line) => /^ {6}properties:\s*$/.test(line));
    if (at >= 0) for (let i = at + 1; i < block.length && /^ {8}/.test(block[i]); i++) {
      const key = block[i].match(/^ {8}([A-Za-z0-9_]+):/)?.[1];
      if (key) properties.add(key);
    }
    return { name, text, properties: [...properties] };
  });
}

/** `ReleaseConfig` is `release_config`; `getReleaseConfig` is `get_release_config`. */
export const snake = (name) => name.replace(/^[A-Z]/, (letter) => letter.toLowerCase()).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The fields that are M6's, derived from the contract. A schema is M6's when its own description marks it, or when only
 * M6 operations (and M6 schemas) refer to it. Its name, as a field would carry it, is one; and so is each of its
 * properties whose name appears nowhere else in the contract. `release` is left to `m6Fields`, which tells M5's `release: { exists: false }`
 * from an M6 release.
 */
export function m6Keys(openapi) {
  const all = schemas(openapi);
  const ops = allOperations(openapi);
  const refersTo = (text, name) => text.includes(`#/components/schemas/${name}"`);
  const isM6 = (schema) => {
    if (schema.text.includes(M6_MARK)) return true;
    const users = ops.filter((op) => refersTo(op.text, schema.name));
    const viaSchemas = all.filter((other) => other.name !== schema.name && refersTo(other.text, schema.name));
    return users.length + viaSchemas.length > 0 && users.every((op) => op.m6) && viaSchemas.every((other) => other.text.includes(M6_MARK));
  };
  const ours = all.filter(isM6);
  // Everything of the contract's that isn't M6's: a property named anywhere in it isn't distinctive enough to count.
  let rest = String(openapi);
  for (const text of [...ours.map((schema) => schema.text), ...ops.filter((op) => op.m6).map((op) => op.text)]) rest = rest.split(text).join("");
  const elsewhere = (name) => new RegExp(`\\b${name}\\b`).test(rest);
  const keys = new Set(ours.map((schema) => snake(schema.name)));
  for (const schema of ours) for (const property of schema.properties) if (!elsewhere(property)) keys.add(property);
  keys.delete("release");
  return [...keys].sort();
}

/** The operations capabilities.yaml lists under `person_only:`: those no agent may be given. */
export function personOnly(capabilities) {
  const lines = String(capabilities).split("\n");
  const start = lines.findIndex((line) => /^person_only:\s*$/.test(line));
  if (start < 0) return [];
  const listed = [];
  for (let at = start + 1; at < lines.length && !/^\S/.test(lines[at]); at++) {
    const item = lines[at].match(/^\s*-\s*([A-Za-z0-9_]+)\s*$/);
    if (item) listed.push(item[1]);
  }
  return listed;
}

/** The capability names the agent capability list gives to agents, `name: { kind, operation }` at two spaces. */
export function agentCapabilities(capabilities) {
  return [...String(capabilities).matchAll(/^ {2}([a-z0-9_]+):\s*\{[^}]*operation:\s*([A-Za-z0-9_]+)/gm)].map(([, name, operation]) => ({ name, operation }));
}

/** Why the contract's M6 operations can't be trusted, or null: each must be person-only, and none an agent capability. */
export function operationsProblem(operations, personOnlyList, capabilities = []) {
  const ids = operations.map((op) => op.operation);
  if (ids.length === 0) return "the contract marks no operation as M6's";
  if (new Set(ids).size !== ids.length) return "the contract names an M6 operation twice";
  const unlisted = ids.filter((id) => !personOnlyList.includes(id));
  if (unlisted.length) return `capabilities.yaml doesn't list ${unlisted.join(", ")} under person_only`;
  const given = capabilities.filter((c) => ids.includes(c.operation)).map((c) => c.name);
  return given.length ? `capabilities.yaml gives agents ${given.join(", ")}, for M6 operations` : null;
}

// ---- paths, callers and the answers they must get ----

/** A release ID of the contract's shape that names nothing, a host label, a host, and an organization ID that names nothing. */
export const FILL = { release: `rel_${"a1".repeat(16)}`, label: "k3v9q2", host: "app.example.com", org: `org_${"0".repeat(32)}` };

/** The path with its parameters filled in: the room, and fixed values for the rest. An unknown parameter is refused. */
export function fillPath(path, room) {
  return path.replace(/\{([a-z]+)\}/g, (_, name) => {
    if (name === "ws") return room;
    if (name in FILL) return FILL[name];
    throw new Error(`the contract has a parameter the script doesn't know: {${name}}`);
  });
}

/** The invented neighbour: the same path with one more character on its last segment, which no route has. */
export const neighbour = (path) => `${path}x`;

/** A room ID of the API's shape that names nothing. */
export const ABSENT_ROOM = `ws_${"0".repeat(32)}`;

/**
 * The kinds of caller the comparison runs as, and the API's own answer each gets for a missing route in a room, from
 * apps/api/test/releases.spec.ts. Outside a room's routes an unknown path is the Worker's, `404 not_found`, for everyone.
 */
export const CALLERS = {
  owner: { label: "the room's owner", room: [404, "not_found"] },
  outsider: { label: "a second person outside the room", room: [404, "workspace_not_found"] },
  absent: { label: "the owner, for a room that doesn't exist", room: [404, "workspace_not_found"] },
  malformed: { label: "the owner, a member, with a body that isn't JSON", room: [400, "invalid_argument"] },
};

/** The answer the API gives this caller for a missing route at this operation's path. */
export function expectedAnswer(caller, op) {
  const kind = CALLERS[caller];
  if (!kind) throw new Error(`no such caller: ${caller}`);
  return op.path.startsWith("/v1/workspaces/{ws}") ? kind.room : [404, "not_found"];
}

/**
 * Whether an answer is a refusal by the gateway or Cloudflare's edge, before the API could answer: a sign-in, a limit,
 * an access refusal, an error of the edge's or the Worker's, or an answer that isn't JSON. Two of these alike show nothing.
 */
export function edgeRefusal(shape) {
  if (shape.status === 429 || shape.status === 401 || shape.status >= 500) return `HTTP ${shape.status}${shape.code ? ` ${shape.code}` : ""}`;
  if (shape.status === 403 && shape.code !== "access_revoked") return `HTTP 403${shape.code ? ` ${shape.code}` : ""}`;
  if (!/json/.test(shape.headers["content-type"] ?? "")) return `HTTP ${shape.status} that isn't JSON`;
  return null;
}

/**
 * The headers compared, by name: the ones that matter for telling a route apart. Anything else, such as an edge's
 * occasional header, isn't compared. `x-podster-*` headers are the product's, and compared too.
 */
export const COMPARED_HEADERS = [
  "content-type", "cache-control", "content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy",
  "cross-origin-opener-policy", "cross-origin-resource-policy", "cross-origin-embedder-policy", "access-control-allow-origin", "access-control-allow-credentials", "vary", "allow", "www-authenticate", "location", "set-cookie",
];

/** What one answer is, for comparing: status, error code, body, and the compared headers. `headers` is a list of [name, value]. */
export function answerShape(status, headers, text) {
  let code = null;
  try {
    code = JSON.parse(text)?.error?.code ?? null;
  } catch {
    // Not JSON: the body is compared as text.
  }
  const kept = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (COMPARED_HEADERS.includes(lower) || lower.startsWith("x-podster-")) kept[lower] = lower === "set-cookie" ? "(set)" : value;
  }
  return { status, code, body: text, headers: kept };
}

/** How two answers differ, each as a short phrase, or an empty list. */
export function differences(real, unknown) {
  const out = [];
  if (real.status !== unknown.status) out.push(`status ${real.status}, not ${unknown.status}`);
  if (real.code !== unknown.code) out.push(`error code ${real.code}, not ${unknown.code}`);
  if (real.body !== unknown.body) out.push("a different body");
  for (const name of [...new Set([...Object.keys(real.headers), ...Object.keys(unknown.headers)])].sort()) {
    if (!(name in unknown.headers)) out.push(`${name} only on the M6 route`);
    else if (!(name in real.headers)) out.push(`${name} only on the invented one`);
    else if (real.headers[name] !== unknown.headers[name]) out.push(`${name} differs`);
  }
  return out;
}

/**
 * What a pair of answers shows for one route and one caller, after any second asking: null when the M6 route answered
 * as the invented one did and that answer is the API's own for a missing route; otherwise why not.
 */
export function pairProblem(real, unknown, expected) {
  const diff = differences(real, unknown);
  if (diff.length) return diff.join("; ");
  if (real.status === expected[0] && real.code === expected[1]) return null;
  const refusal = edgeRefusal(real);
  if (refusal) return `both answered ${refusal}: a gateway or edge refusal before the API, which shows nothing`;
  return `both answered ${real.status} ${real.code}, not the API's ${expected[0]} ${expected[1]} for a missing route`;
}

// ---- MCP ----

/** A tool's answer with its own name taken out, so an M6 name and an invented one can be compared. */
export const toolAnswer = (text, name) => String(text ?? "").split(name).join("<tool>");

/** Why a raw /mcp answer to tools/call isn't a JSON-RPC "tool not found" error with HTTP 200, or null. Its body has been through toolAnswer. */
export function mcpErrorProblem(shape) {
  if (shape.status !== 200) return `HTTP ${shape.status}, not 200`;
  if (!/application\/json/.test(shape.headers["content-type"] ?? "")) return `content type ${shape.headers["content-type"] ?? "none"}, not JSON`;
  let body;
  try {
    body = JSON.parse(shape.body);
  } catch {
    return "a body that isn't JSON";
  }
  if (body?.jsonrpc !== "2.0") return "not a JSON-RPC answer";
  const rpcError = Number.isInteger(body?.error?.code);
  if (!rpcError && body?.result?.isError !== true) return "a JSON-RPC answer that isn't an error";
  const text = (rpcError ? body.error.message : body.result.content?.[0]?.text) ?? "";
  return toolNotFound(text) ? null : `an error other than "tool not found": ${String(text).slice(0, 80)}`;
}

/**
 * Whether an error's text, with the tool's own name taken out by toolAnswer, is the MCP SDK's "tool not found". The
 * SDK's server sends it as `MCP error -32602: Tool <name> not found`, in a result marked isError.
 */
export const toolNotFound = (text) => /^(MCP error -32602: )?Tool <tool> not found$/.test(String(text ?? "").trim());

// ---- what counts as M6's ----

/**
 * Tool names M6 will add that the contract doesn't list yet, by hand. Each is pinned by the self-test to the text of
 * capabilities.yaml and ADR 0010, so a renamed one fails there.
 */
export const PLANNED_TOOLS = ["deploy_release"];

/** The keys step 9 added to the operators' report list, which only release switched on shows (M6-S02e). */
export const QUEUE_KEYS = ["kind", "host"];

/**
 * Why a non-operator's answer from the operators' report list isn't M4's refusal, or null: it must be 403 with
 * `not_allowed`, and carry no report and none of step 9's keys, at any depth.
 */
export function queueRefusalProblem(answer) {
  if (answer?.status !== 403 || answer?.code !== "not_allowed") return `expected 403 not_allowed, as in M4, got HTTP ${answer?.status} ${answer?.code ?? "with no code"}`;
  const keys = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [name, inner] of Object.entries(value)) keys.push(name), walk(inner);
  };
  walk(answer.body);
  const found = [...new Set(keys.filter((name) => [...QUEUE_KEYS, "reports", "next_cursor"].includes(name)))];
  return found.length ? `the refusal carries ${found.join(", ")}` : null;
}

/** A capability or tool name that is M6's: one of the M6 operations, as a tool, or a planned one. */
export function m6Names(names, operations) {
  const ours = new Set([...operations.map((op) => snake(op.operation)), ...PLANNED_TOOLS]);
  return names.filter((name) => ours.has(name));
}

/** Keys that are M6's, anywhere in a read. M5's `release: { exists: false }` isn't one: it has said so since M5. */
export function m6Fields(value, keys, at = "") {
  const found = [];
  if (Array.isArray(value)) value.forEach((item, index) => found.push(...m6Fields(item, keys, `${at}[${index}]`)));
  else if (value && typeof value === "object") {
    for (const [name, inner] of Object.entries(value)) {
      const here = at ? `${at}.${name}` : name;
      const m5Release = name === "release" && JSON.stringify(inner) === JSON.stringify({ exists: false });
      if (keys.includes(name) || (name === "release" && !m5Release)) found.push(here);
      found.push(...m6Fields(inner, keys, here));
    }
  }
  return found;
}

/**
 * An event type that is M6's. By hand, since core names no M6 event yet: a release, a deploy, an app, a hostname, the
 * content domain or an app's report. The self-test pins it against every event type the API and core name today, none
 * of which it may match.
 */
export const M6_EVENT = /^(release|deploy|deployment|app|app_hostname|hostname|content_domain|app_report)[._]/;
export const m6EventTypes = (events) => [...new Set(events.map((event) => event?.type).filter((type) => typeof type === "string" && M6_EVENT.test(type)))];

// ---- each request's timing ----

/**
 * Where a request went, for the log: its path with the IDs in it as they are, and never its query, which can carry a
 * code or a token. A host other than staging's is named, without its query either.
 */
export function requestPath(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.origin === STAGING ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unreadable URL)";
  }
}

/** One request's line: when it started, its method and path, its status (or the error's name) and how long it took. */
export const requestLine = ({ at, method, path, status, error, ms }) => `req  ${at} ${method} ${path} ${status ?? error ?? "no answer"} ${ms} ms`;

/** The run's slowest requests, slowest first, on one line. */
export function slowestLine(requests, count = 5) {
  const slowest = [...requests].sort((a, b) => b.ms - a.ms).slice(0, count);
  if (!slowest.length) return "Slowest requests: none was sent.";
  return `Slowest ${slowest.length} of ${requests.length} requests: ${slowest.map(({ at, method, path, status, error, ms }) => `${method} ${path} ${status ?? error ?? "no answer"} ${ms} ms at ${at}`).join("; ")}.`;
}
