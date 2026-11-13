// A static check of the API's and the gateway's specs for tests that depend on wall-clock time or on what another
// test left running: rule 1 of docs/review-standards.md. Four such tests reached review or main in one week.
//
//   node test-timing-check.mjs [--self-test] [--json] [file.spec.ts ...]
//
// It reports three things:
//
// - sleep: a timer used as a wait.
//   - `setTimeout` or `setInterval` inside a `new Promise(...)`, or awaited. That includes reaching it as
//     `globalThis.setTimeout`, `globalThis["setTimeout"]` (and `window`, `self`, `global`), or through a name bound to
//     any of those (`const later = setTimeout`).
//   - `promisify` of a timer; any timer from `timers/promises`, imported by name, as a namespace or dynamically.
//   - `scheduler.wait`; a call to a function named like a sleep (`sleep`, `delay`, `pause`, `wait`), including one
//     imported under another name.
// - margin: a wall-clock bound in an expectation that real time can use up. A clock reading is `Date.now()`,
//   `performance.now()`, `new Date().getTime()` or `.valueOf()`, `+new Date()`, `Number(new Date())`, or a call through
//   a name bound to `Date.now`. Inside `expect(...)` and its matcher's arguments, it reports:
//   - the difference of two readings, written there or held by a name;
//   - a lower bound read now plus or minus a number (`toBeGreaterThan(Date.now() + 500)`);
//   - an upper bound from an earlier reading plus a number (`toBeLessThan(before + 9_000)`);
//   - an exact match on a reading read now plus a number;
//   - the same bounds inside a comparison, or held by a name that is only ever asserted (`const soon = Date.now() +
//     500`). A name that is also given to the code under test (`far`, set as a due time) holds a value the test set,
//     and comparing with it is no margin.
//   An upper bound read now and a lower bound read earlier only loosen with time, and pass.
// - unquieted: an API spec that makes a room and has no `alarmQuiet` call inside an `afterEach`, an `afterAll` or a
//   `finally`, so a room's alarm can reach a later test. Making a room is a call whose static strings say POST to a
//   path ending `/v1/workspaces` (a literal, a template's fixed tail, or a constant), a `fetch` of that path with
//   `method: "POST"`, or a call to a function, in the file or in a helper file it imports, that does one of those.
//   This is per file: it doesn't follow which rooms reach the quieting call.
//
// Besides the specs, it reads the helper files they import from their own folders (rules 1 and 2 only).
//
// How it reads TypeScript: esbuild (pinned in e2e/package.json, so a bump elsewhere can't change it) strips the types
// with a source map. acorn parses what is left, as static-check.mjs does, and each finding is mapped back to its line.
// So a comment never trips it and a string is only ever a string. Names are resolved by scope: a `const` of the same
// name in another test is another name. Bindings are followed when simple: `const a = b`, never through an object, an
// array, a parameter, a reassignment or another module's export.
//
// KNOWN GAPS, which it doesn't follow and doesn't pretend to:
// - a timer passed as a value (`retry(fn, setTimeout)`), taken by destructuring (`const { setTimeout: t } =
//   globalThis`), reached by a computed name that isn't a literal, or wrapped with `.bind`/`.call`;
// - a sleep inside a package's code, or in a helper file outside the specs' folders;
// - a clock read inside a helper function and returned to the test;
// - a room made through a Durable Object's own routes (`stub.fetch("https://workspace/internal/...")`), through a
//   `Request` object, or with the method or path computed at run time;
// - a shared counter or limit key that other tests also spend, and a rate limit's wall-clock window. Two are known:
//   test-timing-allow.json lists them under `known_gaps`.
//
// test-timing-allow.json lists the findings that stay. Each entry has its category (the file's header defines them),
// its reason, `owed: true` where it is a debt rather than right, and `count`, how many findings it covers. It is
// reviewed like code, and the check keeps it honest: an entry matches by file, rule, `where` (the enclosing test's
// title path, or the enclosing function's name) and the text of its line, and must match exactly `count` findings. So
// a new copy of an allowed line fails, an entry can't be re-pointed at the same text in another test or function, and
// an entry whose line changed or went away fails. An entry with no reason, no category or no `owed` fails. Every run
// prints how many entries are owed.
//
// With no file named it checks apps/api/test/**/*.spec.ts and apps/gateway/test/**/*.spec.ts, and what they import.
// Exit 1 if anything is found that isn't allowed, or an entry doesn't match; 2 if esbuild isn't installed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ALLOW = join(here, "test-timing-allow.json");
const ROOTS = ["apps/api/test", "apps/gateway/test"];

let build;
/** The esbuild e2e/package.json pins; null if it isn't installed. */
async function esbuild() {
  if (build === undefined) build = await import("esbuild").catch(() => null);
  return build;
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

/** Maps a generated line and column to the original line, from a version 3 source map. */
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

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const TIMERS = new Set(["setTimeout", "setInterval"]);
const SLEEPY = /^(sleep|delay|pause|nap)(ms|millis|for|seconds)?$|^wait(ms|millis)?$/i;
const TESTS = new Set(["it", "test", "describe", "suite"]);
const SIDES = { toBeGreaterThan: "lower", toBeGreaterThanOrEqual: "lower", toBeLessThan: "upper", toBeLessThanOrEqual: "upper", toBe: "exact", toEqual: "exact", toStrictEqual: "exact", toBeCloseTo: "exact" };
const ROOM_PATH = /(^|\/)v1\/workspaces\/?(\?[^/]*)?$/;
const PROMISES = /^(node:)?timers\/promises$/;

/** A member's property name when it is fixed: `a.b` or `a["b"]`. */
const propertyName = (m) => (!m.computed ? m.property.name : m.property.type === "Literal" && typeof m.property.value === "string" ? m.property.value : null);
const calleeName = (call) => (call.callee.type === "Identifier" ? call.callee.name : call.callee.type === "MemberExpression" ? propertyName(call.callee) : null);
const isMember = (node, object, property) => node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === object && propertyName(node) === property;
const isNewDate = (n) => n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Date" && n.arguments.length === 0;

/**
 * Reads one file. `helpers` maps an import's resolved path to what that helper file exports: `{ sleepers, rooms }`,
 * the names of its functions that sleep and that make rooms. Returns `{ found, rooms, sleepers }`, `found` as
 * `{ line, rule, text, where }`. Null without esbuild.
 */
export async function analyze(source, { api = false, file = "spec.ts", path = null, helpers = new Map() } = {}) {
  const tool = await esbuild();
  if (!tool) return null;
  const out = tool.transformSync(source, { loader: "ts", sourcemap: "external", sourcefile: file, format: "esm", target: "esnext" });
  const at = lines(JSON.parse(out.map));
  const tree = parse(out.code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  link(tree);
  const found = [];

  // Where a node is: the titles of the tests and describes around it, or else the function it's in.
  const where = (node) => {
    const titles = [];
    let named = null;
    for (let up = node.parent, from = node; up; from = up, up = up.parent) {
      if (up.type === "CallExpression" && up.arguments.includes(from) && up.arguments[0] !== from) {
        const base = up.callee.type === "MemberExpression" ? up.callee.object : up.callee;
        const name = base.type === "Identifier" ? base.name : base.type === "CallExpression" && base.callee.type === "MemberExpression" && base.callee.object.type === "Identifier" ? base.callee.object.name : null;
        const title = up.arguments[0];
        if (TESTS.has(name) && title && (title.type === "Literal" || (title.type === "TemplateLiteral" && title.expressions.length === 0))) titles.unshift(title.type === "Literal" ? String(title.value) : title.quasis[0].value.cooked);
      }
      if (!named && FUNCTIONS.has(up.type)) {
        if (up.id) named = up.id.name;
        else if (up.parent?.type === "VariableDeclarator" && up.parent.id.type === "Identifier") named = up.parent.id.name;
        else if (up.parent?.type === "Property" && !up.parent.computed) named = up.parent.key.name ?? up.parent.key.value;
      }
    }
    return titles.length ? titles.join(" > ") : named ? `function ${named}` : "(module)";
  };
  const report = (node, rule, text) => found.push({ line: at(node.loc.start.line, node.loc.start.column), rule, text, where: where(node) });

  // What a name is given where it's declared: the nearest enclosing block, function or module that declares it.
  // `undefined` for a name declared nowhere in the file (a global), null for one that is but can't be followed.
  const declaration = (id) => {
    for (let up = id.parent; up; up = up.parent) {
      const body = up.type === "Program" || up.type === "BlockStatement" || up.type === "StaticBlock" ? up.body : up.type === "ForStatement" && up.init?.type === "VariableDeclaration" ? [up.init] : null;
      if (body) {
        for (const statement of body) {
          const d = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (d?.type === "VariableDeclaration") for (const v of d.declarations) if (v.id.type === "Identifier" && v.id.name === id.name) return { init: v.init ?? null, kind: d.kind, scope: up, id: v.id };
          if (d?.type === "FunctionDeclaration" && d.id?.name === id.name) return { init: null, kind: "function", scope: up, id: d.id };
          if (d?.type === "ImportDeclaration") for (const s of d.specifiers) if (s.local.name === id.name) return { init: null, kind: "import", scope: up, id: s.local, from: d.source.value, imported: s.type === "ImportSpecifier" ? (s.imported.name ?? s.imported.value) : s.type === "ImportNamespaceSpecifier" ? "*" : "default" };
        }
      }
      if (FUNCTIONS.has(up.type) && up.params.some((p) => [...every(p)].some((n) => n.type === "Identifier" && n.name === id.name))) return { init: null, kind: "param", scope: up };
    }
    return undefined;
  };
  const declared = (id) => {
    const d = declaration(id);
    return d && d.kind === "const" ? d.init : null;
  };
  const through = (node, test, seen = new Set()) => {
    if (!node) return false;
    if (test(node)) return true;
    if (node.type === "Identifier" && !seen.has(node.name)) {
      seen.add(node.name);
      return through(declared(node), test, seen);
    }
    return false;
  };

  // Rule 1's references.
  const isTimer = (node) =>
    through(node, (n) => (n.type === "Identifier" && TIMERS.has(n.name) && declaration(n) === undefined) || (n.type === "MemberExpression" && n.object.type === "Identifier" && GLOBAL_OBJECTS.has(n.object.name) && TIMERS.has(propertyName(n))));
  const promisedName = (id) => {
    const d = declaration(id);
    return d?.kind === "import" && PROMISES.test(d.from);
  };
  const sleepyImport = (id) => {
    const d = declaration(id);
    if (d?.kind !== "import") return false;
    if (SLEEPY.test(d.imported)) return true;
    const helper = path && d.from.startsWith(".") ? helpers.get(resolveImport(path, d.from)) : null;
    return Boolean(helper?.sleepers.has(d.imported));
  };
  const isDateNow = (n) => isMember(n, "Date", "now") || isMember(n, "performance", "now");
  const isNow = (node) =>
    (node.type === "CallExpression" && (isDateNow(node.callee) || (node.callee.type === "Identifier" && through(node.callee, (m) => m !== node.callee && isDateNow(m))))) ||
    (node.type === "CallExpression" && node.callee.type === "MemberExpression" && ["getTime", "valueOf"].includes(propertyName(node.callee)) && isNewDate(node.callee.object)) ||
    (node.type === "UnaryExpression" && node.operator === "+" && isNewDate(node.argument)) ||
    (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "Number" && node.arguments.length === 1 && isNewDate(node.arguments[0]));

  const insidePromise = (node) => {
    for (let up = node.parent, fn = null; up; up = up.parent) {
      if (up.type === "ArrowFunctionExpression" || up.type === "FunctionExpression") fn = up;
      if (up.type === "NewExpression" && up.callee.type === "Identifier" && up.callee.name === "Promise" && fn && up.arguments[0] === fn) return true;
    }
    return false;
  };

  // Rule 2's pieces.
  const numeric = (node) => through(node, (n) => (n.type === "Literal" && typeof n.value === "number" && n.value !== 0) || (n.type === "UnaryExpression" && n.operator === "-" && numeric(n.argument)) || (n.type === "BinaryExpression" && "+-*/".includes(n.operator) && numeric(n.left) && numeric(n.right)));
  const plusMinus = (n, kind) => n.type === "BinaryExpression" && (n.operator === "+" || n.operator === "-") && ((kind(n.left) && numeric(n.right)) || (n.operator === "+" && numeric(n.left) && kind(n.right)));
  /** A reading of the clock taken here, plus or minus numbers. */
  const fresh = (n) => isNow(n) || plusMinus(n, fresh);
  /** A name that holds a reading and nothing else, taken earlier (`before`, `started`), plus or minus numbers. */
  const earlier = (n) => (n.type === "Identifier" && through(n, (m) => m !== n && isNow(m))) || plusMinus(n, earlier);
  const holdsReading = (node) => [...every(node)].some((n) => isNow(n) || (n.type === "Identifier" && through(n, (m) => m !== n && [...every(m)].some(isNow))));
  const difference = (n) => n.type === "BinaryExpression" && n.operator === "-" && holdsReading(n.left) && holdsReading(n.right) && !earlier(n) && !fresh(n);

  // Every expectation's arguments, with the side its matcher bounds (null for expect's own), found first so a name can
  // be told apart: one only ever asserted, or one also given to the code under test.
  const expectations = [];
  for (const node of every(tree)) {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "expect") continue;
    for (const arg of node.arguments) expectations.push([arg, null]);
    for (let up = node; up.parent?.type === "MemberExpression" && up.parent.object === up && up.parent.parent?.type === "CallExpression" && up.parent.parent.callee === up.parent; up = up.parent.parent) {
      for (const arg of up.parent.parent.arguments) expectations.push([arg, SIDES[propertyName(up.parent)] ?? "other"]);
    }
  }
  const asserted = new Set();
  for (const [arg] of expectations) for (const n of every(arg)) asserted.add(n);
  /** A const that is only ever read inside expectations: what it holds is part of the assertion. */
  const onlyAsserted = (id) => {
    const d = declaration(id);
    if (!d || d.kind !== "const" || !d.init) return false;
    for (const n of every(d.scope)) {
      if (n.type !== "Identifier" || n.name !== id.name || n === d.id) continue;
      if (n.parent?.type === "MemberExpression" && n.parent.property === n && !n.parent.computed) continue;
      if (n.parent?.type === "Property" && n.parent.key === n && !n.parent.shorthand) continue;
      if (!asserted.has(n)) return false;
    }
    return true;
  };
  // Where an expected value meets the clock, is it a bound that real time can use up? A lower bound from a reading
  // taken now shrinks as the test runs late; an upper bound from one taken earlier does too.
  const usedUp = (bound, side) => {
    if (bound.type === "Identifier" && onlyAsserted(bound)) {
      const init = declared(bound);
      if (init && init.type === "BinaryExpression") return usedUp(init, side);
    }
    return ((side === "lower" || side === "exact") && plusMinus(bound, fresh)) || (side === "upper" && plusMinus(bound, earlier));
  };
  const compared = function* (node) {
    yield node;
    if (["BinaryExpression", "LogicalExpression", "UnaryExpression", "ConditionalExpression"].includes(node.type)) for (const child of children(node)) yield* compared(child);
  };
  for (const [arg, side] of expectations) {
    for (const inner of compared(arg)) {
      if (difference(inner)) report(inner, "margin", "the difference of two clock readings in an expectation");
      else if (inner.type === "Identifier" && difference(declared(inner) ?? { type: "None" })) report(inner, "margin", `${inner.name}, the difference of two clock readings, in an expectation`);
      else if (inner === arg && side && side !== "other" && usedUp(inner, side)) report(inner, "margin", `a clock bound that real time can use up, in a ${side === "exact" ? "match" : `${side} bound`}`);
      else if (inner.type === "BinaryExpression" && [">", ">=", "<", "<="].includes(inner.operator)) {
        // In `a > bound` the right side is a's lower bound; in `bound > a` the left is its upper bound.
        const [lowerOfOther, upperOfOther] = inner.operator[0] === ">" ? [inner.right, inner.left] : [inner.left, inner.right];
        if (usedUp(lowerOfOther, "lower") || usedUp(upperOfOther, "upper")) report(inner, "margin", "a comparison with a clock bound that real time can use up");
      }
    }
  }

  // Rule 1.
  const sleeping = new Set();
  for (const node of every(tree)) {
    let what = null;
    if (node.type === "ImportExpression" && node.source.type === "Literal" && PROMISES.test(String(node.source.value))) what = "a dynamic import of timers/promises";
    else if (node.type !== "CallExpression") continue;
    else if (isTimer(node.callee) && (insidePromise(node) || node.parent?.type === "AwaitExpression")) what = "a timer used as a wait";
    else if (node.callee.type === "Identifier" && promisedName(node.callee)) what = `${node.callee.name} from timers/promises`;
    else if (node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier" && promisedName(node.callee.object)) what = `${node.callee.object.name}.${propertyName(node.callee)} from timers/promises`;
    else if (calleeName(node) === "promisify" && node.arguments[0] && isTimer(node.arguments[0])) what = "promisify of a timer";
    else if (isMember(node.callee, "scheduler", "wait")) what = "scheduler.wait";
    else if (node.callee.type === "Identifier" && node.arguments.length && (SLEEPY.test(node.callee.name) || sleepyImport(node.callee))) what = `a call to ${node.callee.name}(), named like a sleep or imported as one`;
    else if (node.callee.type === "MemberExpression" && node.arguments.length && SLEEPY.test(propertyName(node.callee) ?? "")) what = `a call to ${propertyName(node.callee)}(), named like a sleep`;
    if (!what) continue;
    report(node, "sleep", what);
    const fn = enclosingName(node);
    if (fn) sleeping.add(fn);
  }

  // Rule 3's room-making calls, and the functions here that make one.
  const staticString = (n) => {
    if (!n) return undefined;
    if (n.type === "Literal" && typeof n.value === "string") return n.value;
    if (n.type === "TemplateLiteral") return n.quasis.at(-1).value.cooked;
    if (n.type === "Identifier") return staticString(declared(n));
    return undefined;
  };
  const strings = (args) => args.flatMap((a) => (a.type === "ObjectExpression" ? a.properties.filter((p) => p.type === "Property").map((p) => staticString(p.value)) : [staticString(a)])).filter((s) => s !== undefined);
  const directRoom = (n) => {
    if (n.type !== "CallExpression") return false;
    const found = strings(n.arguments);
    return found.includes("POST") && found.some((s) => ROOM_PATH.test(s));
  };
  const makers = new Set();
  for (const node of every(tree)) if (directRoom(node)) makers.add(enclosingName(node));
  const importedMaker = (id) => {
    const d = declaration(id);
    if (d?.kind !== "import" || !path || !d.from.startsWith(".")) return false;
    return Boolean(helpers.get(resolveImport(path, d.from))?.rooms.has(d.imported));
  };
  const roomCall = (n) => directRoom(n) || (n.type === "CallExpression" && n.callee.type === "Identifier" && ((makers.has(n.callee.name) && declaration(n.callee) !== undefined) || importedMaker(n.callee)));
  // A helper that calls a helper that makes a room makes one too.
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of every(tree)) {
      if (!roomCall(node)) continue;
      const fn = enclosingName(node);
      if (fn && !makers.has(fn)) {
        makers.add(fn);
        grew = true;
      }
    }
  }
  if (api) {
    const makes = [...every(tree)].filter(roomCall);
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

  makers.delete(null);
  const seen = new Set();
  return {
    found: found.filter((f) => !seen.has(`${f.line}|${f.rule}|${f.text}|${f.where}`) && seen.add(`${f.line}|${f.rule}|${f.text}|${f.where}`)).sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)),
    rooms: makers,
    sleepers: sleeping,
  };
}

/** The name of the outermost-named function a node is in, as another file would import it; null at the top. */
function enclosingName(node) {
  let name = null;
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === "FunctionDeclaration" && up.id) name = up.id.name;
    else if (FUNCTIONS.has(up.type) && up.parent?.type === "VariableDeclarator" && up.parent.id.type === "Identifier") name = up.parent.id.name;
  }
  return name;
}

function resolveImport(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, join(base, "index.ts")]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return base;
}

/** The findings in one file's text, as `{ line, rule, text, where }`. For the self-test and a single file. */
export async function findings(source, options = {}) {
  const result = await analyze(source, options);
  return result && result.found;
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
const relativeImports = (source) => [...source.matchAll(/^\s*import\s[^;]*?from\s+["'](\.[^"']+)["']/gm), ...source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm)].map((m) => m[1]);

/**
 * Every finding in these specs and in the helper files they import from the specs' folders, as `{ file, line, rule,
 * text, where, code }`, `file` relative to the repository. Null without esbuild.
 */
export async function check(files) {
  const folders = ROOTS.map((dir) => join(root, dir));
  const inFolders = (path) => folders.some((dir) => path.startsWith(dir + sep));
  const results = new Map();
  const visit = async (path, stack = new Set()) => {
    if (results.has(path) || stack.has(path)) return results.get(path);
    stack.add(path);
    const source = readFileSync(path, "utf8");
    const helpers = new Map();
    for (const specifier of relativeImports(source)) {
      const target = resolveImport(path, specifier);
      if (inFolders(target) && existsSync(target) && !target.endsWith(".spec.ts")) helpers.set(target, await visit(target, stack));
    }
    const file = relative(root, path).split(sep).join("/");
    let result;
    try {
      result = await analyze(source, { api: file.startsWith("apps/api/") && file.endsWith(".spec.ts"), file, path, helpers: new Map([...helpers].filter(([, v]) => v)) });
    } catch (error) {
      result = { found: [{ line: error?.loc?.line ?? 0, rule: "parse", text: `doesn't parse: ${String(error?.message ?? error).slice(0, 120)}`, where: "(module)" }], rooms: new Set(), sleepers: new Set() };
    }
    if (result === null) return null;
    results.set(path, { ...result, file, source });
    return results.get(path);
  };
  for (const path of files) if ((await visit(path)) === null) return null;
  const all = [];
  for (const { found, file, source } of results.values()) for (const f of found) all.push({ file, ...f, code: lineText(source, f.line) });
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Splits findings into those an entry allows and those it doesn't. `stale` names each entry that doesn't match exactly
 * its `count` (1 if absent) of findings; `unreasoned`, each without a reason, a known category, `owed` or `where`.
 */
export function judge(all, allow, categories = null) {
  const matches = (entry, f) => entry.file === f.file && entry.rule === f.rule && entry.where === f.where && entry.code === f.code;
  const allowed = all.filter((f) => allow.some((entry) => matches(entry, f)));
  const failing = all.filter((f) => !allowed.includes(f));
  const stale = allow.filter((entry) => all.filter((f) => matches(entry, f)).length !== (entry.count ?? 1));
  const unreasoned = allow.filter((entry) => typeof entry.reason !== "string" || entry.reason.trim().length < 20 || typeof entry.owed !== "boolean" || typeof entry.where !== "string" || typeof entry.category !== "string" || (categories && !(entry.category in categories)));
  return { allowed, failing, stale, unreasoned };
}

async function selfTest() {
  let failed = 0;
  const expect = async (title, text, wanted, options = { api: true }) => {
    const got = ((await findings(text, options)) ?? [{ line: 0, rule: "esbuild isn't installed" }]).map((f) => `${f.line}: ${f.rule}`);
    const passed = JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} ${title}${passed ? "" : `\n     wanted ${JSON.stringify(wanted)}\n     got    ${JSON.stringify(got)}`}`);
  };
  const quiet = 'import { afterEach } from "vitest";\nimport { alarmQuiet } from "./alarm.ts";\nconst made: string[] = [];\nafterEach(async () => { for (const id of made.splice(0)) await alarmQuiet(stub(id)); });\n';
  // Rule 1, each form found, then the fixed form: wait for the thing itself.
  await expect("sleep: a timer wrapped in a Promise and awaited", 'it("x", async () => {\n  await go();\n  await new Promise((r) => setTimeout(r, 50));\n  expect(await seen()).toBe(true);\n});\n', ["3: sleep"]);
  await expect("sleep: a helper whose body is a timer Promise is found where the timer is", "const waitForRun = (): Promise<void> => new Promise((done) => setTimeout(done, 700));\nawait waitForRun();\n", ["1: sleep"]);
  await expect("sleep: a poll with a timer between tries", "for (let i = 0; i < 100 && !(await ready()); i++) await new Promise<void>((next) => setTimeout(next, 2));\n", ["1: sleep"]);
  await expect("sleep: timers/promises, scheduler.wait and a helper named like a sleep", 'import { setTimeout as later } from "node:timers/promises";\nawait later(10);\nawait scheduler.wait(10);\nawait sleep(10);\nawait delay(5);\n', ["2: sleep", "3: sleep", "4: sleep", "5: sleep"]);
  await expect("sleep: globalThis.setTimeout and globalThis[\"setTimeout\"]", 'await new Promise((r) => globalThis.setTimeout(r, 50));\nawait new Promise((r) => globalThis["setTimeout"](r, 50));\nawait new Promise((r) => window.setInterval(r, 50));\n', ["1: sleep", "2: sleep", "3: sleep"]);
  await expect("sleep: a timer under another name, through simple bindings", "const later = setTimeout;\nconst again = later;\nconst fromGlobal = globalThis.setTimeout;\nawait new Promise((r) => again(r, 50));\nawait new Promise((r) => fromGlobal(r, 50));\n", ["4: sleep", "5: sleep"]);
  await expect("sleep: a local function named setTimeout is not the timer", "const setTimeout = (f: () => void) => f();\nawait new Promise<void>((r) => setTimeout(r));\n", []);
  await expect("sleep: sleep imported under another name", 'import { sleep as nap2 } from "./helpers";\nimport { delay as soon } from "some-package";\nawait nap2(10);\nawait soon(10);\n', ["3: sleep", "4: sleep"]);
  await expect("sleep: timers/promises as a namespace, or imported dynamically", 'import * as timers from "node:timers/promises";\nawait timers.setTimeout(10);\nconst { setTimeout: later } = await import("timers/promises");\n', ["2: sleep", "3: sleep"]);
  await expect("sleep: promisify of a timer", 'import { promisify } from "node:util";\nconst later = promisify(setTimeout);\nconst also = util.promisify(globalThis.setTimeout);\n', ["2: sleep", "3: sleep"]);
  await expect("sleep: the fixed form waits for the thing itself, and a timer that isn't a wait is fine", 'it("x", async () => {\n  const held = hold();\n  await go();\n  await held.arrived;\n  const timer = setTimeout(() => controller.abort(), 1000);\n  clearTimeout(timer);\n  await vi.waitFor(() => expect(seen()).toBe(true));\n});\n', []);
  await expect("sleep: a comment or a string that names a timer isn't one", '// await new Promise((r) => setTimeout(r, 50));\nconst text = "await sleep(100)";\nexpect(text).toContain("sleep");\n', []);
  // Rule 2.
  await expect("margin: the difference of two readings in an expectation", "const started = Date.now();\nawait go();\nexpect(Date.now() - started).toBeLessThan(1000);\n", ["3: margin"]);
  await expect("margin: a difference stored in a name, then asserted", "const start = Date.now();\nawait go();\nconst took = Date.now() - start;\nexpect(took).toBeLessThan(1000);\n", ["4: margin"]);
  await expect("margin: a reading plus a number in a matcher", "expect(row.next_at).toBeGreaterThan(Date.now() + 60_000);\n", ["1: margin"]);
  await expect("margin: now plus a margin stored in a name that is only asserted", "it(\"x\", async () => {\n  await go();\n  const soon = Date.now() + 500;\n  expect(row.at).toBeGreaterThan(soon);\n});\n", ["4: margin"]);
  await expect("margin: a value the test gives to the code under test is no margin", "it(\"x\", async () => {\n  const far = Date.now() + 3_600_000;\n  await setDue(far);\n  expect(await due()).toBe(far);\n  expect(await next()).toBeGreaterThan(far);\n});\n", []);
  await expect("margin: new Date().getTime(), +new Date() and Number(new Date()) are readings", "expect(a).toBeGreaterThan(new Date().getTime() + 500);\nexpect(b).toBeGreaterThan(+new Date() + 500);\nexpect(c).toBeGreaterThan(Number(new Date()) + 500);\nconst started = new Date().valueOf();\nexpect(+new Date() - started).toBeLessThan(5);\n", ["1: margin", "2: margin", "3: margin", "5: margin"]);
  await expect("margin: a call through a name bound to Date.now is a reading", "const now = Date.now;\nexpect(a).toBeGreaterThan(now() + 500);\n", ["2: margin"]);
  await expect("margin: an upper bound from an earlier reading plus a named number", "const HOUR = 60 * 60 * 1000;\nconst before = performance.now();\nawait go();\nexpect(row.at).toBeLessThan(before + HOUR);\n", ["4: margin"]);
  await expect("margin: a comparison inside expect against a lower bound read now", "expect(next === null || next > Date.now() + 30 * 60_000).toBe(true);\n", ["1: margin"]);
  await expect("margin: the safe directions only loosen with time: an upper bound read now, a lower bound read earlier", "const before = Date.now();\nawait go();\nexpect(row.at).toBeGreaterThanOrEqual(before + 60_000);\nexpect(row.at).toBeLessThanOrEqual(Date.now() + 60_000);\n", []);
  await expect("margin: a name that is a count in one test isn't a reading because another test's is", 'it("a", () => {\n  const before = Date.now();\n  expect(at()).toBeGreaterThanOrEqual(before);\n});\nit("b", async () => {\n  const before = (await reads()).length;\n  expect((await reads()).length).toBe(before + 1);\n});\n', []);
  await expect("margin: a time built as an input inside expect(...) is no expectation of time", 'expect((await depart({ left_at: Date.now() - 600_000 })).status).toBe(200);\nexpect(await send(a, { org_a: Date.now() + 60_000 })).toBe("not_in_organization");\n', []);
  await expect("margin: a reading plus a number outside any expectation is fine", 'await sql("UPDATE t SET at = ?", Date.now() - 1);\nconst far = Date.now() + 60_000;\nawait setDue(far);\n', []);
  // Rule 3.
  await expect("unquieted: an API spec that makes rooms and never quiets one", 'it("a", async () => {\n  const id = (await api(OWNER, "POST", "/v1/workspaces", { name: "A" })).body.id;\n  await alarmQuiet(stub(id));\n});\n', ["2: unquieted"]);
  await expect("unquieted: through a local helper, a constant path, a template's tail, or fetch", 'const ROOMS = "/v1/workspaces";\nconst newRoom = async () => (await api(OWNER, "POST", ROOMS, {})).body.id;\nit("a", async () => { await newRoom(); });\n', ["2: unquieted"]);
  await expect("unquieted: fetch with method POST", 'it("a", async () => {\n  await fetch(`${BASE}/v1/workspaces`, { method: "POST", body: "{}" });\n});\n', ["2: unquieted"]);
  await expect("unquieted: a helper imported from a helper file that makes rooms", 'import { room } from "./rooms.ts";\nit("a", async () => { await room(); });\n', ["2: unquieted"], { api: true, path: "/t/x.spec.ts", helpers: new Map([["/t/rooms.ts", { rooms: new Set(["room"]), sleepers: new Set() }]]) });
  await expect("unquieted: quieted in afterEach", `${quiet}it("a", async () => {\n  const id = (await api(OWNER, "POST", "/v1/workspaces", { name: "A" })).body.id;\n  made.push(id);\n});\n`, []);
  await expect("unquieted: quieted in finally", 'it("a", async () => {\n  const id = (await api(OWNER, "POST", `/v1/workspaces`, {})).body.id;\n  try {\n    await go(id);\n  } finally {\n    await alarmQuiet(stub(id));\n  }\n});\n', []);
  await expect("unquieted: another path under /v1/workspaces doesn't make a room", 'await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, {});\nawait api(OWNER, "GET", "/v1/workspaces");\nawait fetch("https://x/v1/workspaces");\n', []);
  await expect("unquieted: a gateway spec is outside the room rule", 'await api(OWNER, "POST", "/v1/workspaces", {});\n', [], { api: false });
  // Where a finding is, for the allow-list's key.
  const wheres = ((await findings('describe("rooms", () => {\n  it("waits", async () => {\n    await new Promise((r) => setTimeout(r, 5));\n  });\n});\nconst poll = async () => {\n  await new Promise((r) => setTimeout(r, 5));\n};\n')) ?? []).map((f) => f.where);
  const whereOk = JSON.stringify(wheres) === JSON.stringify(["rooms > waits", "function poll"]);
  if (!whereOk) failed++;
  console.log(`${whereOk ? "ok  " : "FAIL"} a finding's where is its test's title path, or its function's name${whereOk ? "" : `: got ${JSON.stringify(wheres)}`}`);
  // The allow-list.
  const categories = { A: "a poll", B: "a sleep before asserting nothing happened" };
  const entry = (more) => ({ file: "a.spec.ts", rule: "sleep", where: "function poll", code: "await x();", category: "A", reason: "a bound that only detects a failure", owed: false, ...more });
  const all = [{ file: "a.spec.ts", line: 3, rule: "sleep", where: "function poll", code: "await x();" }, { file: "a.spec.ts", line: 9, rule: "margin", where: "t", code: "expect(y);" }];
  const allowCase = (title, allow, wanted, findingsHere = all) => {
    const v = judge(findingsHere, allow, categories);
    const got = { allowed: v.allowed.length, failing: v.failing.length, stale: v.stale.length, unreasoned: v.unreasoned.length };
    const passed = JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} allow-list: ${title}${passed ? "" : `\n     wanted ${JSON.stringify(wanted)}\n     got    ${JSON.stringify(got)}`}`);
  };
  allowCase("an entry allows the finding it names and nothing else", [entry()], { allowed: 1, failing: 1, stale: 0, unreasoned: 0 });
  allowCase("an entry whose line changed or went away fails", [entry(), entry({ code: "gone();" })], { allowed: 1, failing: 1, stale: 1, unreasoned: 0 });
  allowCase("an entry with no reason fails", [entry({ reason: "" })], { allowed: 1, failing: 1, stale: 0, unreasoned: 1 });
  allowCase("an entry with no owed, no where, no category, or one the header doesn't define, fails", [entry({ owed: undefined }), entry({ where: undefined }), entry({ category: undefined }), entry({ category: "Z" })], { allowed: 1, failing: 1, stale: 1, unreasoned: 4 });
  allowCase("a new copy of an allowed line fails: the entry covers exactly its count", [entry()], { allowed: 2, failing: 1, stale: 1, unreasoned: 0 }, [...all, { ...all[0], line: 5 }]);
  allowCase("an entry with count 2 covers two copies of a line", [entry({ count: 2 })], { allowed: 2, failing: 1, stale: 0, unreasoned: 0 }, [...all, { ...all[0], line: 5 }]);
  allowCase("an entry can't be re-pointed: the allowed poll gone, the same text in a test fails", [entry()], { allowed: 0, failing: 2, stale: 1, unreasoned: 0 }, [{ ...all[0], where: "rooms > waits" }, all[1]]);
  console.log(failed ? `\n${failed} failed` : "\ntest-timing-check self-test: all passed");
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(await selfTest());
  const json = argv.includes("--json");
  const named = argv.filter((a) => !a.startsWith("--"));
  const files = named.length ? named.map((name) => resolve(process.cwd(), name)) : ROOTS.flatMap((dir) => specs(join(root, dir)));
  const all = await check(files);
  if (all === null) {
    console.error("test-timing-check needs esbuild: run `npm ci` in e2e first.");
    process.exit(2);
  }
  const list = JSON.parse(readFileSync(ALLOW, "utf8"));
  const allow = list.entries;
  const { allowed, failing, stale, unreasoned } = judge(all, named.length ? allow.filter((e) => all.some((f) => f.file === e.file)) : allow, list.categories);
  if (json) {
    console.log(JSON.stringify(failing, null, 1));
    process.exit(failing.length ? 1 : 0);
  }
  for (const f of failing) console.log(`${f.file}:${f.line}: ${f.rule}: ${f.text} [${f.where}]\n    ${f.code}`);
  for (const entry of stale) console.log(`test-timing-allow.json: an entry doesn't match exactly ${entry.count ?? 1} finding(s): ${entry.file} ${entry.rule} [${entry.where}] ${JSON.stringify(entry.code)}`);
  for (const entry of unreasoned) console.log(`test-timing-allow.json: an entry needs a reason, a where, a category the header defines, and owed true or false: ${entry.file} ${entry.rule} ${JSON.stringify(entry.code)}`);
  const owed = allow.filter((entry) => entry.owed);
  const owedFindings = owed.reduce((n, entry) => n + (entry.count ?? 1), 0);
  const scanned = new Set(all.map((f) => f.file)).size;
  console.log(`\n${files.length} specs and the helpers they import (${scanned} files with findings); ${all.length} found, ${allowed.length} allowed by test-timing-allow.json: OWED ${owed.length} of its ${allow.length} entries, covering ${owedFindings} findings`);
  if (failing.length || stale.length || unreasoned.length) process.exit(1);
  console.log("test-timing-check: passed");
}
