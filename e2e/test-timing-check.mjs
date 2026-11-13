// A static check of the API's and the gateway's specs for tests that depend on wall-clock time or on what another
// test left running: rule 1 of docs/review-standards.md. Four such tests reached review or main in one week.
//
//   node test-timing-check.mjs [--self-test] [file.spec.ts ...]
//
// It reports three things:
//
// - sleep: a timer used as a wait. `setTimeout` or `setInterval` inside a `new Promise(...)` or awaited, a timer from
//   `timers/promises`, `scheduler.wait`, and a call to a helper named like a sleep (`sleep`, `delay`, `pause`, `wait`).
// - margin: a wall-clock margin in an expectation. Inside `expect(...)` or its matcher's arguments: the difference of
//   two clock readings, or a reading of `Date.now()` or `performance.now()` with a number added or taken away, directly
//   or through a name that holds one.
// - unquieted: an API spec that makes a room (`POST /v1/workspaces`) and has no `alarmQuiet` call inside an
//   `afterEach`, an `afterAll` or a `finally`, so a room's alarm can reach a later test. This is per file: it doesn't
//   follow which rooms reach the quieting call.
//
// How it reads TypeScript: esbuild, the one wrangler installs in apps/gateway, strips the types and nothing else, with
// a source map. acorn parses what is left, as static-check.mjs does, and each finding is mapped back to its line in the
// spec. So a comment never trips it and a string is only ever a string. Names are matched within the file, not by
// scope: a `const` of the same name in two tests is read as one.
//
// test-timing-allow.json lists the findings that stay. Each entry has its category (the file's header defines them),
// its reason, `owed: true` where it is a debt rather than right, and `count`, how many findings it covers. It is
// reviewed like code, and the check keeps it honest: an entry matches by file, rule and the text of its line, and must
// match exactly `count` findings, so a new copy of an allowed line fails, and so does an entry whose line changed or
// went away. An entry with no reason, no category or no `owed` fails. Every run prints how many entries are owed.
//
// With no file named it checks apps/api/test/**/*.spec.ts and apps/gateway/test/**/*.spec.ts. Exit 1 if anything
// is found that isn't allowed, or an entry matches nothing; 2 if esbuild isn't installed.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ALLOW = join(here, "test-timing-allow.json");
const ROOTS = ["apps/api/test", "apps/gateway/test"];

/** wrangler's esbuild, from apps/gateway; null if it isn't installed. */
function esbuild() {
  try {
    return createRequire(join(root, "apps/gateway/package.json"))("esbuild");
  } catch {
    return null;
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = B64.indexOf(char);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/** For each generated line, its segments as [generated column, original line], from a version 3 source map. */
function lines(map) {
  const out = [];
  let original = 0;
  for (const line of map.mappings.split(";")) {
    const segments = [];
    let column = 0;
    if (line) {
      for (const segment of line.split(",")) {
        const values = vlq(segment);
        column += values[0];
        if (values.length >= 4) {
          original += values[2];
          segments.push([column, original]);
        }
      }
    }
    out.push(segments);
  }
  return (generatedLine, generatedColumn) => {
    for (let at = generatedLine - 1; at >= 0; at--) {
      const segments = out[at] ?? [];
      if (!segments.length) continue;
      let best = segments[0];
      if (at === generatedLine - 1) for (const segment of segments) if (segment[0] <= generatedColumn) best = segment;
      return best[1] + 1;
    }
    return 1;
  };
}

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc") continue;
    if (Array.isArray(value)) for (const item of value) item && typeof item.type === "string" && out.push(item);
    else if (value && typeof value.type === "string") out.push(value);
  }
  return out;
}
function* every(node) {
  yield node;
  for (const child of children(node)) yield* every(child);
}
function link(node, parent = null) {
  node.parent = parent;
  for (const child of children(node)) link(child, node);
}

const calleeName = (call) => (call.callee.type === "Identifier" ? call.callee.name : call.callee.type === "MemberExpression" && !call.callee.computed ? call.callee.property.name : null);
const isMember = (node, object, property) => node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" && node.object.name === object && node.property.name === property;
const isNow = (node) => node.type === "CallExpression" && (isMember(node.callee, "Date", "now") || isMember(node.callee, "performance", "now"));
const SLEEPY = /^(sleep|delay|pause|nap)(ms|millis|for|seconds)?$|^wait(ms|millis)?$/i;
const TIMERS = new Set(["setTimeout", "setInterval"]);

/** Findings in one file's text, as `{ line, rule, text }`. `api` turns on the room rule. */
export function findings(source, { api = false, file = "spec.ts" } = {}) {
  const build = esbuild();
  if (!build) return null;
  const out = build.transformSync(source, { loader: "ts", sourcemap: "external", sourcefile: file, format: "esm", target: "esnext" });
  const at = lines(JSON.parse(out.map));
  const tree = parse(out.code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  link(tree);
  const found = [];
  const report = (node, rule, text) => found.push({ line: at(node.loc.start.line, node.loc.start.column), rule, text });

  // What a name is given where it's declared: the nearest enclosing block, function or module that declares it.
  const declared = (id) => {
    for (let up = id.parent; up; up = up.parent) {
      const body = up.type === "Program" || up.type === "BlockStatement" || up.type === "StaticBlock" ? up.body : up.type === "ForStatement" && up.init?.type === "VariableDeclaration" ? [up.init] : null;
      if (body) {
        for (const statement of body) {
          const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type !== "VariableDeclaration") continue;
          for (const d of declaration.declarations) if (d.id.type === "Identifier" && d.id.name === id.name) return d.init ?? null;
        }
      }
      if ((up.type === "ArrowFunctionExpression" || up.type === "FunctionExpression" || up.type === "FunctionDeclaration") && up.params.some((p) => [...every(p)].some((n) => n.type === "Identifier" && n.name === id.name))) return null;
    }
    return null;
  };
  const through = (node, test, seen = new Set()) => {
    if (test(node)) return true;
    if (node.type === "Identifier" && !seen.has(node.name)) {
      seen.add(node.name);
      const init = declared(node);
      return init ? through(init, test, seen) : false;
    }
    return false;
  };
  const numeric = (node) => through(node, (n) => (n.type === "Literal" && typeof n.value === "number" && n.value !== 0) || (n.type === "UnaryExpression" && n.operator === "-" && numeric(n.argument)) || (n.type === "BinaryExpression" && "+-*/".includes(n.operator) && numeric(n.left) && numeric(n.right)));
  /** A reading of the clock taken here: Date.now() itself, or that plus or minus numbers. */
  const fresh = (n) => isNow(n) || (n.type === "BinaryExpression" && (n.operator === "+" || n.operator === "-") && ((fresh(n.left) && numeric(n.right)) || (n.operator === "+" && numeric(n.left) && fresh(n.right))));
  /** A name that holds a reading and nothing else, taken earlier (`before`, `started`), plus or minus numbers. */
  const earlier = (n) => (n.type === "Identifier" && through(n, (m) => m !== n && isNow(m))) || (n.type === "BinaryExpression" && (n.operator === "+" || n.operator === "-") && ((earlier(n.left) && numeric(n.right)) || (n.operator === "+" && numeric(n.left) && earlier(n.right))));
  const withNumber = (n, kind) => n.type === "BinaryExpression" && (n.operator === "+" || n.operator === "-") && kind(n) && !(isNow(n) || n.type === "Identifier");
  const holdsReading = (node) => [...every(node)].some((n) => isNow(n) || (n.type === "Identifier" && through(n, (m) => m !== n && isNow(m))));
  // Where an expected value meets the clock, is it a bound that real time can use up? A lower bound from a reading
  // taken now (`> Date.now() + 500`) shrinks as the test runs late; an upper bound from one taken earlier
  // (`< before + 5_000`) does too. The other two only loosen, and a value the test itself set (`far`) is no margin.
  const usedUp = (bound, side) => (side === "lower" && withNumber(bound, fresh)) || (side === "upper" && withNumber(bound, earlier)) || (side === "exact" && withNumber(bound, fresh));
  const SIDES = { toBeGreaterThan: "lower", toBeGreaterThanOrEqual: "lower", toBeLessThan: "upper", toBeLessThanOrEqual: "upper", toBe: "exact", toEqual: "exact", toStrictEqual: "exact", toBeCloseTo: "exact" };
  /** The parts of an expectation's argument that are compared, not built: no call, object, array or function between. */
  const compared = function* (node) {
    yield node;
    if (["BinaryExpression", "LogicalExpression", "UnaryExpression", "ConditionalExpression"].includes(node.type)) for (const child of children(node)) yield* compared(child);
  };

  // The timers that `timers/promises` gives under any local name.
  const promised = new Set();
  for (const node of every(tree)) if (node.type === "ImportDeclaration" && /^(node:)?timers\/promises$/.test(node.source.value)) for (const specifier of node.specifiers) promised.add(specifier.local.name);

  const insidePromise = (node) => {
    for (let up = node.parent, fn = null; up; up = up.parent) {
      if (up.type === "ArrowFunctionExpression" || up.type === "FunctionExpression") fn = up;
      if (up.type === "NewExpression" && up.callee.type === "Identifier" && up.callee.name === "Promise" && fn && up.arguments[0] === fn) return true;
    }
    return false;
  };

  for (const node of every(tree)) {
    if (node.type !== "CallExpression") continue;
    const name = calleeName(node);
    // Rule 1: a sleep.
    if (node.callee.type === "Identifier" && TIMERS.has(name) && (insidePromise(node) || node.parent?.type === "AwaitExpression")) report(node, "sleep", `${name} used as a wait`);
    else if (node.callee.type === "Identifier" && promised.has(name)) report(node, "sleep", `${name} from timers/promises`);
    else if (isMember(node.callee, "scheduler", "wait")) report(node, "sleep", "scheduler.wait");
    else if (name && SLEEPY.test(name) && node.arguments.length) report(node, "sleep", `a call to ${name}(), named like a sleep`);
    // Rule 2: a margin in an expectation, from `expect(...)` out along its matcher chain.
    if (node.callee.type === "Identifier" && name === "expect") {
      // Each argument with the side its matcher bounds: null for expect's own, whose comparisons are read below.
      const args = node.arguments.map((arg) => [arg, null]);
      for (let up = node; up.parent?.type === "MemberExpression" && up.parent.object === up && up.parent.parent?.type === "CallExpression" && up.parent.parent.callee === up.parent; up = up.parent.parent) args.push(...up.parent.parent.arguments.map((arg) => [arg, SIDES[up.parent.property.name] ?? "other"]));
      for (const [arg, side] of args) {
        for (const inner of compared(arg)) {
          if (inner.type === "BinaryExpression" && inner.operator === "-" && holdsReading(inner.left) && holdsReading(inner.right) && !earlier(inner)) report(inner, "margin", "the difference of two clock readings in an expectation");
          else if (inner === arg && side && side !== "other" && usedUp(inner, side)) report(inner, "margin", `a clock bound that real time can use up, in a ${side === "exact" ? "match" : `${side} bound`}`);
          else if (inner.type === "BinaryExpression" && [">", ">=", "<", "<="].includes(inner.operator)) {
            // In `a > bound` the right side is a's lower bound; in `bound > a` the left is its upper bound.
            const [lowerOfOther, upperOfOther] = inner.operator[0] === ">" ? [inner.right, inner.left] : [inner.left, inner.right];
            if (usedUp(lowerOfOther, "lower") || usedUp(upperOfOther, "upper")) report(inner, "margin", "a comparison with a clock bound that real time can use up");
          }
        }
      }
    }
  }

  // Rule 3: an API spec that makes a room and never quiets one where every test's end reaches it.
  if (api) {
    const literal = (n) => (n.type === "Literal" ? n.value : n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked : undefined);
    const makes = [...every(tree)].filter((n) => n.type === "CallExpression" && n.arguments.some((a) => literal(a) === "POST") && n.arguments.some((a) => literal(a) === "/v1/workspaces"));
    const quieted = [...every(tree)].some((n) => {
      if (n.type !== "CallExpression" || calleeName(n) !== "alarmQuiet") return false;
      for (let up = n; up.parent; up = up.parent) {
        if (up.parent.type === "TryStatement" && up.parent.finalizer === up) return true;
        if (up.parent.type === "CallExpression" && up.parent.arguments.includes(up) && ["afterEach", "afterAll"].includes(calleeName(up.parent))) return true;
      }
      return false;
    });
    if (makes.length && !quieted) report(makes[0], "unquieted", `makes a room${makes.length > 1 ? ` (and ${makes.length - 1} more calls do)` : ""} and quiets none with alarmQuiet in afterEach, afterAll or finally`);
  }

  const seen = new Set();
  return found.filter((f) => !seen.has(`${f.line}|${f.rule}|${f.text}`) && seen.add(`${f.line}|${f.rule}|${f.text}`)).sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function specs(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(path).isDirectory()) out.push(...specs(path));
    else if (name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

const lineText = (source, line) => (source.split("\n")[line - 1] ?? "").trim().replace(/\s+/g, " ").slice(0, 200);

/** Every finding in these files, as `{ file, line, rule, text, code }`, `file` relative to the repository. Null without esbuild. */
export function check(files) {
  const all = [];
  for (const path of files) {
    const file = relative(root, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    let found;
    try {
      found = findings(source, { api: file.startsWith("apps/api/"), file });
    } catch (error) {
      found = [{ line: error?.loc?.line ?? 0, rule: "parse", text: `doesn't parse: ${String(error?.message ?? error).slice(0, 120)}` }];
    }
    if (found === null) return null;
    for (const f of found) all.push({ file, ...f, code: lineText(source, f.line) });
  }
  return all;
}

/**
 * Splits findings into those an entry allows and those it doesn't. `stale` names each entry that doesn't match exactly
 * its `count` (1 if absent) of findings; `unreasoned`, each without a reason, a known category, or `owed`.
 */
export function judge(all, allow, categories = null) {
  const matches = (entry, f) => entry.file === f.file && entry.rule === f.rule && entry.code === f.code;
  const allowed = all.filter((f) => allow.some((entry) => matches(entry, f)));
  const failing = all.filter((f) => !allowed.includes(f));
  const stale = allow.filter((entry) => all.filter((f) => matches(entry, f)).length !== (entry.count ?? 1));
  const unreasoned = allow.filter((entry) => typeof entry.reason !== "string" || entry.reason.trim().length < 20 || typeof entry.owed !== "boolean" || typeof entry.category !== "string" || (categories && !(entry.category in categories)));
  return { allowed, failing, stale, unreasoned };
}

function selfTest() {
  let failed = 0;
  const expect = (title, text, wanted, api = true) => {
    const got = (findings(text, { api }) ?? [{ line: 0, rule: "esbuild isn't installed" }]).map((f) => `${f.line}: ${f.rule}`);
    const passed = JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} ${title}${passed ? "" : `\n     wanted ${JSON.stringify(wanted)}\n     got    ${JSON.stringify(got)}`}`);
  };
  const quiet = 'import { afterEach } from "vitest";\nimport { alarmQuiet } from "./alarm.ts";\nconst made: string[] = [];\nafterEach(async () => { for (const id of made.splice(0)) await alarmQuiet(stub(id)); });\n';
  // Rule 1, each form found, then the fixed form: wait for the thing itself.
  expect("sleep: a timer wrapped in a Promise and awaited", 'it("x", async () => {\n  await go();\n  await new Promise((r) => setTimeout(r, 50));\n  expect(await seen()).toBe(true);\n});\n', ["3: sleep"]);
  expect("sleep: a helper whose body is a timer Promise is found where the timer is", "const waitForRun = (): Promise<void> => new Promise((done) => setTimeout(done, 700));\nawait waitForRun();\n", ["1: sleep"]);
  expect("sleep: a poll with a timer between tries", "for (let i = 0; i < 100 && !(await ready()); i++) await new Promise<void>((next) => setTimeout(next, 2));\n", ["1: sleep"]);
  expect("sleep: timers/promises, scheduler.wait and a helper named like a sleep", 'import { setTimeout as later } from "node:timers/promises";\nawait later(10);\nawait scheduler.wait(10);\nawait sleep(10);\nawait delay(5);\n', ["2: sleep", "3: sleep", "4: sleep", "5: sleep"]);
  expect("sleep: the fixed form waits for the thing itself, and a timer that isn't a wait is fine", 'it("x", async () => {\n  const held = hold();\n  await go();\n  await held.arrived;\n  const timer = setTimeout(() => controller.abort(), 1000);\n  clearTimeout(timer);\n  await vi.waitFor(() => expect(seen()).toBe(true));\n});\n', []);
  expect("sleep: a comment or a string that names a timer isn't one", '// await new Promise((r) => setTimeout(r, 50));\nconst text = "await sleep(100)";\nexpect(text).toContain("sleep");\n', []);
  // Rule 2.
  expect("margin: the difference of two readings in an expectation", "const started = Date.now();\nawait go();\nexpect(Date.now() - started).toBeLessThan(1000);\n", ["3: margin"]);
  expect("margin: a reading plus a number in a matcher", "expect(row.next_at).toBeGreaterThan(Date.now() + 60_000);\n", ["1: margin"]);
  expect("margin: an upper bound from an earlier reading plus a named number", "const HOUR = 60 * 60 * 1000;\nconst before = performance.now();\nawait go();\nexpect(row.at).toBeLessThan(before + HOUR);\n", ["4: margin"]);
  expect("margin: a comparison inside expect against a lower bound read now", "expect(next === null || next > Date.now() + 30 * 60_000).toBe(true);\n", ["1: margin"]);
  expect("margin: the safe directions only loosen with time: an upper bound read now, a lower bound read earlier", "const before = Date.now();\nawait go();\nexpect(row.at).toBeGreaterThanOrEqual(before + 60_000);\nexpect(row.at).toBeLessThanOrEqual(Date.now() + 60_000);\n", []);
  expect("margin: a name that is a count in one test isn't a reading because another test's is", 'it("a", () => {\n  const before = Date.now();\n  expect(at()).toBeGreaterThanOrEqual(before);\n});\nit("b", async () => {\n  const before = (await reads()).length;\n  expect((await reads()).length).toBe(before + 1);\n});\n', []);
  expect("margin: a time built as an input inside expect(...) is no expectation of time", 'expect((await depart({ left_at: Date.now() - 600_000 })).status).toBe(200);\nexpect(await send(a, { org_a: Date.now() + 60_000 })).toBe("not_in_organization");\n', []);
  expect("margin: the fixed forms bracket the value between readings, or set it far ahead first", "const before = Date.now();\nawait go();\nexpect(row.at).toBeGreaterThanOrEqual(before);\nexpect(row.at).toBeLessThanOrEqual(Date.now());\nconst far = Date.now() + 3_600_000;\nawait setDue(far);\nexpect(await due()).toBe(far);\n", []);
  expect("margin: a reading with a number outside any expectation is fine", "await sql(\"UPDATE t SET at = ?\", Date.now() - 1);\nconst far = Date.now() + 60_000;\nawait setDue(far);\n", []);
  // Rule 3.
  expect("unquieted: an API spec that makes rooms and never quiets one", 'it("a", async () => {\n  const id = (await api(OWNER, "POST", "/v1/workspaces", { name: "A" })).body.id;\n  await alarmQuiet(stub(id));\n});\n', ["2: unquieted"]);
  expect("unquieted: quieted in afterEach", `${quiet}it("a", async () => {\n  const id = (await api(OWNER, "POST", "/v1/workspaces", { name: "A" })).body.id;\n  made.push(id);\n});\n`, []);
  expect("unquieted: quieted in finally", 'it("a", async () => {\n  const id = (await api(OWNER, "POST", `/v1/workspaces`, {})).body.id;\n  try {\n    await go(id);\n  } finally {\n    await alarmQuiet(stub(id));\n  }\n});\n', []);
  expect("unquieted: another path under /v1/workspaces doesn't make a room", 'await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, {});\nawait api(OWNER, "GET", "/v1/workspaces");\n', []);
  expect("unquieted: a gateway spec is outside the room rule", 'await api(OWNER, "POST", "/v1/workspaces", {});\n', [], false);
  // The allow-list.
  const categories = { A: "a poll", B: "a sleep before asserting nothing happened" };
  const entry = (more) => ({ file: "a.spec.ts", rule: "sleep", code: "await x();", category: "A", reason: "a bound that only detects a failure", owed: false, ...more });
  const all = [{ file: "a.spec.ts", line: 3, rule: "sleep", code: "await x();" }, { file: "a.spec.ts", line: 9, rule: "margin", code: "expect(y);" }];
  const allowCase = (title, allow, wanted, findings = all) => {
    const v = judge(findings, allow, categories);
    const got = { allowed: v.allowed.length, failing: v.failing.length, stale: v.stale.length, unreasoned: v.unreasoned.length };
    const passed = JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} allow-list: ${title}${passed ? "" : `\n     wanted ${JSON.stringify(wanted)}\n     got    ${JSON.stringify(got)}`}`);
  };
  allowCase("an entry allows the finding it names and nothing else", [entry()], { allowed: 1, failing: 1, stale: 0, unreasoned: 0 });
  allowCase("an entry whose line changed or went away fails", [entry(), entry({ code: "gone();" })], { allowed: 1, failing: 1, stale: 1, unreasoned: 0 });
  allowCase("an entry with no reason fails", [entry({ reason: "" })], { allowed: 1, failing: 1, stale: 0, unreasoned: 1 });
  allowCase("an entry with no owed, or no category, or one the header doesn't define, fails", [entry({ owed: undefined }), entry({ category: undefined }), entry({ category: "Z" })], { allowed: 1, failing: 1, stale: 0, unreasoned: 3 });
  allowCase("a new copy of an allowed line fails: the entry covers exactly its count", [entry()], { allowed: 2, failing: 1, stale: 1, unreasoned: 0 }, [...all, { ...all[0], line: 5 }]);
  allowCase("an entry with count 2 covers two copies of a line", [entry({ count: 2 })], { allowed: 2, failing: 1, stale: 0, unreasoned: 0 }, [...all, { ...all[0], line: 5 }]);
  console.log(failed ? `\n${failed} failed` : "\ntest-timing-check self-test: all passed");
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest());
  const json = argv.includes("--json");
  const named = argv.filter((a) => !a.startsWith("--"));
  const files = named.length ? named.map((name) => join(process.cwd(), name)) : ROOTS.flatMap((dir) => specs(join(root, dir)));
  const all = check(files);
  if (all === null) {
    console.error("test-timing-check needs esbuild from apps/gateway: run `npm ci` in apps/gateway first.");
    process.exit(2);
  }
  const list = JSON.parse(readFileSync(ALLOW, "utf8"));
  const allow = list.entries;
  const { allowed, failing, stale, unreasoned } = judge(all, named.length ? allow.filter((e) => all.some((f) => f.file === e.file)) : allow, list.categories);
  if (json) {
    console.log(JSON.stringify(failing, null, 1));
    process.exit(failing.length ? 1 : 0);
  }
  for (const f of failing) console.log(`${f.file}:${f.line}: ${f.rule}: ${f.text}\n    ${f.code}`);
  for (const entry of stale) console.log(`test-timing-allow.json: an entry doesn't match exactly ${entry.count ?? 1} finding(s): ${entry.file} ${entry.rule} ${JSON.stringify(entry.code)}`);
  for (const entry of unreasoned) console.log(`test-timing-allow.json: an entry needs a reason, a category the header defines, and owed true or false: ${entry.file} ${entry.rule} ${JSON.stringify(entry.code)}`);
  const owed = allow.filter((entry) => entry.owed);
  const owedFindings = owed.reduce((n, entry) => n + (entry.count ?? 1), 0);
  console.log(`\n${files.length} specs; ${all.length} found, ${allowed.length} allowed by test-timing-allow.json: OWED ${owed.length} of its ${allow.length} entries, covering ${owedFindings} findings`);
  if (failing.length || stale.length || unreasoned.length) process.exit(1);
  console.log("test-timing-check: passed");
}
