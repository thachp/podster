// The parts of m6-staging.mjs that touch nothing: its arguments, the one host it accepts, the plan of checks, which
// operations the contract says are M6's, and how two answers are compared. Kept apart so m6-staging-selftest.mjs can
// check them without a network, a secret or the e2e packages.
//
// M6 is switched off on staging (RELEASES is set nowhere). Today's checks show it can't be detected there and that the
// room schema step M6 build step 2 added harmed nothing. The checks that need release switched on come later.
export { scrub, secretProblem, stagingOnly, STAGING, Tally } from "./m5-staging-lib.mjs";
import { STAGING, stagingOnly } from "./m5-staging-lib.mjs";

/** The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. The agent is made under the owner and takes none. */
export const SIGN_UPS = [
  { who: "the room's owner", why: "owns the rooms, links the agent, and calls every M6 route as the owner, for a room that doesn't exist, and with a body that isn't JSON" },
  { who: "a second person", why: "is in no room of the run's, and calls every M6 route on the owner's room" },
];

/** Every check, in the order it runs. "S" for switched off: none of these needs release switched on. */
export const PLAN = [
  ["M6-S00", "the contract marks its M6 operations, each is listed person-only, and none is an agent capability"],
  ["M6-S01a", "switched off, each M6 route answers the room's owner exactly as an invented neighbouring path does: status, error code, body, content type and security headers"],
  ["M6-S01b", "the same for a second person who isn't in the room"],
  ["M6-S01c", "the same for a room that doesn't exist"],
  ["M6-S01d", "the same for a member sending a body that isn't JSON, on every M6 write"],
  ["M6-S01e", "an agent through /mcp lists no M6 tool, and calling an M6 operation's name answers exactly as an invented tool name does"],
  ["M6-S03", "a room made after the deploy works end to end for one ordinary task: create, assign to an agent, accept, submit, review"],
  ["M6-S02a", "the room read and the task read carry no M6 field"],
  ["M6-S02b", "capabilities discovery and the agent's tool list carry no M6 capability or tool"],
  ["M6-S02c", "no M6 event type is in the room's events after every call above"],
  ["M6-S04", "the same in a room that existed before the deploy"],
].map(([id, title]) => ({ id, title }));

export const USAGE = `node m6-staging.mjs --base-url ${STAGING} [--dry-run] [--contract FILE] [--capabilities FILE]

  --dry-run         check the configuration, read the contract and print the plan. Sends staging nothing.
  --contract        the OpenAPI contract the M6 operations are read from. Defaults to packages/contracts/openapi.yaml.
  --capabilities    the agent capability list. Defaults to packages/contracts/capabilities.yaml.

  PODSTER_E2E_SIGNUP_SECRET     staging's test sign-up secret. Needed, and passed by the runner. Never printed.

  It takes 2 test sign-ups, switches nothing on, and calls no Cloudflare API.`;

/** The arguments, or why they're refused. Nothing is guessed: an unknown flag or a missing value is an error. */
export function parseArgs(argv, env = {}) {
  const options = { base: undefined, dryRun: false, help: false, contract: undefined, capabilities: undefined };
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--base-url" || flag === "--contract" || flag === "--capabilities") {
      const value = argv[++at];
      if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
      options[{ "--base-url": "base", "--contract": "contract", "--capabilities": "capabilities" }[flag]] = value;
    } else return { error: `unknown argument ${flag}` };
  }
  if (options.help) return { options };
  options.base ??= env.PODSTER_E2E_BASE_URL;
  if (!options.base) return { error: "pass --base-url, or set PODSTER_E2E_BASE_URL" };
  const refusal = stagingOnly(options.base);
  if (refusal) return { error: refusal };
  options.base = STAGING;
  return { options };
}

const METHODS = ["get", "put", "post", "patch", "delete"];

/**
 * Every operation in the contract whose summary marks it M6's, `(M6, ADR 0010`, as `{ operation, method, path }`, in the
 * contract's order. Read from the file at run time, so the list can't go stale. The reader knows the contract's own
 * layout: a path at two spaces, a method at four, written either as a block or inline.
 */
export function m6Operations(openapi) {
  const lines = String(openapi).split("\n");
  const found = [];
  let path = null;
  let current = null;
  const close = () => {
    if (current && current.text.includes("(M6, ADR 0010")) {
      const id = current.text.match(/operationId:\s*([A-Za-z0-9_]+)/)?.[1];
      if (id) found.push({ operation: id, method: current.method.toUpperCase(), path: current.path });
    }
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

/** An operation's name as a tool would carry it: `getReleaseConfig` is `get_release_config`. */
export const snake = (operation) => operation.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** A release ID of the contract's shape that names nothing, a host label, and a host. */
export const FILL = { release: `rel_${"a1".repeat(16)}`, label: "k3v9q2", host: "app.example.com" };

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

/** The headers whose values are compared, beside the presence of every header but those that change on each request. */
export const SECURITY_HEADERS = ["content-type", "cache-control", "content-security-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "permissions-policy", "referrer-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "access-control-allow-origin", "vary", "allow", "www-authenticate", "set-cookie"];
const VOLATILE = new Set(["date", "cf-ray", "server", "alt-svc", "nel", "report-to", "server-timing", "content-length", "cf-cache-status", "retry-after", "ratelimit", "ratelimit-policy"]);

/** What one answer is, for comparing: status, error code, body, and its headers. `headers` is a list of [name, value]. */
export function answerShape(status, headers, text) {
  let code = null;
  try {
    code = JSON.parse(text)?.error?.code ?? null;
  } catch {
    // Not JSON: the body is compared as text.
  }
  const named = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    code,
    body: text,
    headerNames: [...named.keys()].filter((name) => !VOLATILE.has(name)).sort(),
    security: Object.fromEntries(SECURITY_HEADERS.filter((name) => named.has(name)).map((name) => [name, name === "set-cookie" ? "(set)" : named.get(name)])),
  };
}

/** How two answers differ, each as a short phrase, or an empty list. */
export function differences(real, unknown) {
  const out = [];
  if (real.status !== unknown.status) out.push(`status ${real.status}, not ${unknown.status}`);
  if (real.code !== unknown.code) out.push(`error code ${real.code}, not ${unknown.code}`);
  if (real.body !== unknown.body) out.push("a different body");
  const [a, b] = [real.headerNames, unknown.headerNames];
  const only = (x, y) => x.filter((name) => !y.includes(name));
  if (only(a, b).length) out.push(`headers only it has: ${only(a, b).join(", ")}`);
  if (only(b, a).length) out.push(`headers it lacks: ${only(b, a).join(", ")}`);
  for (const name of SECURITY_HEADERS) if ((real.security[name] ?? null) !== (unknown.security[name] ?? null)) out.push(`${name} differs`);
  return out;
}

/** A tool's answer with its own name taken out, so an M6 name and an invented one can be compared. */
export const toolAnswer = (text, name) => String(text ?? "").split(name).join("<tool>");

/**
 * Keys that are M6's, in a read: the release configuration, a release, an app's host or label, a hostname claim. The M5
 * release status's `release: { exists: false }` isn't one: it has said so since M5.
 */
export const M6_KEYS = ["release_config", "releases", "release_epoch", "release_id", "app", "app_label", "default_host", "custom_host", "app_hostname", "hostname", "serve_state", "serve_entry", "approval_policy", "environments", "deployment", "deploy"];
export function m6Fields(value, at = "") {
  const found = [];
  if (Array.isArray(value)) value.forEach((item, index) => found.push(...m6Fields(item, `${at}[${index}]`)));
  else if (value && typeof value === "object") {
    for (const [name, inner] of Object.entries(value)) {
      const here = at ? `${at}.${name}` : name;
      const m5Release = name === "release" && JSON.stringify(inner) === JSON.stringify({ exists: false });
      if (M6_KEYS.includes(name) || (name === "release" && !m5Release)) found.push(here);
      found.push(...m6Fields(inner, here));
    }
  }
  return found;
}

/** A capability or tool name that is M6's: one of the M6 operations, or anything about deploying or apps' hosts. */
export function m6Names(names, operations) {
  const ours = new Set(operations.map((op) => snake(op.operation)));
  return names.filter((name) => ours.has(name) || /deploy|release_config|app_hostname|app_report|content_domain|suspend_app|app_host/.test(name));
}

/** Event types that are M6's: a release, an app, a hostname, the content domain or an app's report. */
export const m6EventTypes = (events) => [...new Set(events.map((event) => event?.type).filter((type) => typeof type === "string" && /^(release|app|app_hostname|hostname|content_domain|app_report)[._]/.test(type)))];

/** A room ID of the API's shape that names nothing. */
export const ABSENT_ROOM = `ws_${"0".repeat(32)}`;
