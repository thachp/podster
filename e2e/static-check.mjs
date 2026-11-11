// A static check of every script in this folder, for the mistakes that only show when a line runs. Most of these
// scripts run against staging and nowhere else, so a line that throws is found by spending a staging run on it.
//
//   node static-check.mjs [--self-test] [file.mjs ...]
//
// It reports three things and nothing else:
//
// - an assignment to a constant;
// - a name used that nothing declares, or used before its declaration;
// - a declaration that hides an outer `let`, `var` or parameter which is assigned somewhere: the assignment a reader
//   takes for the outer one lands on the inner one, or throws if the inner one is a constant.
//
// The first two come from TypeScript's own checker reading each file as JavaScript: the `tsc` apps/gateway already
// installs, run as a child with child-env.mjs's allow-listed environment. Types aren't checked, since these files have
// none: only those diagnostics are kept, and Node's globals are declared as "anything", so no type package is needed.
// TypeScript has no rule for the third, so this file finds it itself, from acorn's parse of the file.
//
// With no file named it checks every `*.mjs` here. Exit 1 if anything is found, 2 if `tsc` isn't installed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { childEnv } from "./child-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TSC = join(here, "../apps/gateway/node_modules/.bin/tsc");

/** What the checker reports that this check keeps: its number, and what it means here. */
const KEPT = new Map([
  [2588, "assigns to a constant"],
  [2304, "uses a name nothing declares"],
  [2552, "uses a name nothing declares"],
  [18004, "uses a name nothing declares"],
  [2448, "uses a name before its declaration"],
  [2454, "uses a variable before it's assigned"],
  [2451, "declares a name twice"],
  [2300, "declares a name twice"],
]);

/** Node's and a page's globals, and any module, as "anything": only names are checked, never types. */
const GLOBALS = [
  "process", "Buffer", "console", "fetch", "URL", "URLSearchParams", "Headers", "Request", "Response", "AbortSignal", "AbortController", "TextEncoder", "TextDecoder", "crypto", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "structuredClone", "queueMicrotask", "performance", "WebSocket", "FormData", "Blob", "File", "ReadableStream", "WritableStream", "TransformStream",
  "CompressionStream", "DecompressionStream", "btoa", "atob", "document", "window", "navigator", "location", "getComputedStyle", "HTMLElement", "Element", "Node", "NodeFilter", "MutationObserver",
  "localStorage", "sessionStorage", "CSS", "history", "PerformanceObserver", "innerHeight", "innerWidth", "scrollY", "scrollX", "XMLHttpRequest", "indexedDB", "Event", "KeyboardEvent", "MouseEvent", "requestAnimationFrame", "CryptoKey", "EventSource", "MessageChannel", "BroadcastChannel", "DOMException",
];
const AMBIENT = `declare module "*";\n${GLOBALS.map((name) => `declare const ${name}: any;`).join("\n")}\n`;

/**
 * Hidden names this check found when it was added, on 2026-11-11, in scripts other work owns. Each was read: the inner
 * name is used only as itself, and no assignment meant for the outer one lands on it. They're printed on every run and
 * don't fail it. A new one anywhere, or any in a file not listed, does.
 */
export const KNOWN_SHADOWS = { "journey.mjs": ["second"], "m2-staging.mjs": ["room"], "run-local.mjs": ["code"] };

/** What `tsc` finds in these files, of the kinds kept. Null if it couldn't be run at all. */
function checked(files) {
  if (!existsSync(TSC)) return null;
  const work = mkdtempSync(join(tmpdir(), "static-check-"));
  try {
    writeFileSync(join(work, "ambient.d.ts"), AMBIENT);
    writeFileSync(join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "es2023", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, types: [], lib: ["es2023"], pretty: false }, files: [join(work, "ambient.d.ts"), ...files] }));
    const run = spawnSync(TSC, ["--project", join(work, "tsconfig.json")], { cwd: here, env: childEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    if (run.error || run.status === null) return null;
    const found = [];
    const wanted = new Set(files);
    for (const line of run.stdout.split("\n")) {
      const match = /^(.+?)\((\d+),\d+\): error TS(\d+): (.*)$/.exec(line);
      if (!match) continue;
      const [file, code] = [resolve(here, match[1]), Number(match[3])];
      const syntax = code >= 1000 && code < 2000;
      if (wanted.has(file) && (syntax || KEPT.has(code))) found.push({ file, line: Number(match[2]), text: `${syntax ? "doesn't parse" : KEPT.get(code)}: ${match[4]}` });
    }
    return found;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- declarations that hide an assigned outer one ----

const SCOPES = new Set(["Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause", "SwitchStatement", "StaticBlock"]);
const FUNCTIONS = new Set(["Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "StaticBlock"]);
const children = (node) => Object.entries(node).flatMap(([key, value]) => (key === "type" || !value || typeof value !== "object" ? [] : Array.isArray(value) ? value : [value])).filter((value) => value && typeof value.type === "string");
/** The names a pattern binds or writes: `x`, `[x, y]`, `{ a: x }`, `x = 1`, `...x`. A member such as `a.b` is none. */
function names(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(names);
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((property) => names(property.type === "RestElement" ? property.argument : property.value));
  if (pattern.type === "AssignmentPattern") return names(pattern.left);
  if (pattern.type === "RestElement") return names(pattern.argument);
  return [];
}

/**
 * Declarations that hide an outer `let`, `var` or parameter which is assigned somewhere, as `{ line, text }`. Scopes
 * are a module's: blocks, loops, functions and catch clauses.
 */
export function shadows(text) {
  const tree = parse(text, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const scopeOf = new Map();
  // First, every scope and what it declares.
  const declare = (scope, id, assignable) => {
    if (!scope.names.has(id.name)) scope.names.set(id.name, { id, assignable, assigned: false, scope });
  };
  const build = (node, scope) => {
    let inner = scope;
    if (SCOPES.has(node.type)) {
      inner = { parent: scope, names: new Map(), isFunction: FUNCTIONS.has(node.type) };
      scopeOf.set(node, inner);
    }
    const nearestFunction = () => {
      let at = inner;
      while (at.parent && !at.isFunction) at = at.parent;
      return at;
    };
    if (node.type === "VariableDeclaration") for (const declarator of node.declarations) for (const id of names(declarator.id)) declare(node.kind === "var" ? nearestFunction() : inner, id, node.kind !== "const");
    if (node.type === "FunctionDeclaration" && node.id) declare(scope, node.id, false);
    if (node.type === "ClassDeclaration" && node.id) declare(inner, node.id, false);
    if (FUNCTIONS.has(node.type) && node.params) for (const id of node.params.flatMap(names)) declare(inner, id, true);
    if (node.type === "CatchClause") for (const id of names(node.param)) declare(inner, id, true);
    if (node.type === "ImportDeclaration") for (const specifier of node.specifiers) declare(inner, specifier.local, false);
    for (const child of children(node)) build(child, inner);
  };
  build(tree, null);
  const lookup = (scope, name) => {
    for (let at = scope; at; at = at.parent) if (at.names.has(name)) return at.names.get(name);
    return null;
  };
  // Then, every write, resolved to the declaration it reaches.
  const mark = (node, scope) => {
    const inner = scopeOf.get(node) ?? scope;
    const written = node.type === "AssignmentExpression" ? names(node.left) : node.type === "UpdateExpression" ? names(node.argument) : (node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration" ? names(node.left) : [];
    for (const id of written) {
      const reached = lookup(inner, id.name);
      if (reached) reached.assigned = true;
    }
    for (const child of children(node)) mark(child, inner);
  };
  mark(tree, null);
  const found = [];
  for (const scope of scopeOf.values()) {
    for (const [name, declaration] of scope.names) {
      const outer = scope.parent && lookup(scope.parent, name);
      // The outer one is written somewhere, or a write meant for it lands here, on something that can't take it.
      if (outer && outer.assignable && (outer.assigned || (declaration.assigned && !declaration.assignable))) {
        found.push({ line: declaration.id.loc.start.line, text: `declares \`${name}\`, hiding the one declared on line ${outer.id.loc.start.line}, which is assigned elsewhere` });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Everything found in these files, as `{ file, line, text }`. Null if `tsc` couldn't be run. */
export function check(files) {
  const found = checked(files);
  if (found === null) return null;
  for (const file of files) {
    try {
      for (const shadow of shadows(readFileSync(file, "utf8"))) found.push({ file, ...shadow });
    } catch (error) {
      found.push({ file, line: error?.loc?.line ?? 0, text: `doesn't parse: ${String(error?.message ?? error).slice(0, 120)}` });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text));
}

function selfTest() {
  let failed = 0;
  // Each case is a file of its own beside this one, so its imports resolve as a real script's do. Removed afterwards.
  const cases = mkdtempSync(join(here, ".static-check-cases-"));
  let count = 0;
  const expect = (title, text, wanted) => {
    const file = join(cases, `case-${++count}.mjs`);
    writeFileSync(file, text);
    const got = [...new Set((check([file]) ?? [{ line: 0, text: "tsc couldn't be run" }]).map((problem) => `${problem.line}: ${problem.text.split(":")[0].replace(/`[^`]*`/g, "x").replace(/ on line \d+/, "")}`))];
    const passed = JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} ${title}${passed ? "" : `\n     wanted ${JSON.stringify(wanted)}\n     got    ${JSON.stringify(got)}`}`);
  };
  const hides = "declares x, hiding the one declared, which is assigned elsewhere";
  // The mistake this check was written for, as it was made: an outer flag, an inner constant of the same name, and an assignment.
  expect("an inner constant that hides an outer flag, then the flag's assignment, is found twice over", "let demoted = false;\nasync function run() {\n  const [revoked, demoted] = [1, 2];\n  if (revoked) demoted = true;\n}\nrun();\nconsole.log(demoted);\n", [`3: ${hides}`, "4: assigns to a constant"]);
  expect("an inner `let` that hides an outer one which is assigned is found, though nothing throws", "let state = 0;\nfunction step() {\n  let state = 1;\n  state = 2;\n  return state;\n}\nstate = step();\n", [`3: ${hides}`]);
  expect("a parameter that hides an outer variable which is assigned is found", "let owner;\nfunction agentOf(owner) {\n  return owner;\n}\nowner = agentOf(1);\n", [`2: ${hides}`]);
  expect("hiding a constant, or a variable nothing assigns, is left alone", "const made = new Map();\nlet never;\nfunction f() {\n  const made = 1;\n  const never = 2;\n  return made + never;\n}\nconsole.log(made, never, f());\n", []);
  expect("an assignment to a constant is found", "const limit = 1;\nlimit = 2;\n", ["2: assigns to a constant"]);
  expect("an increment of a constant is found", "const count = 1;\ncount++;\n", ["2: assigns to a constant"]);
  expect("a name nothing declares is found, in a branch that may never run", "export function f(flag) {\n  if (flag) return undeclaredHelper(1);\n  return 0;\n}\n", ["2: uses a name nothing declares"]);
  expect("a name used before its declaration is found", "console.log(later);\nconst later = 1;\n", ["1: uses a name before its declaration", "1: uses a variable before it's assigned"]);
  expect("Node's globals, imports, destructuring and closures are fine", 'import { readFileSync } from "node:fs";\nimport { helper } from "../child-env.mjs";\nlet total = 0;\nfor (const [key, value] of Object.entries(process.env)) total += helper(key, value, readFileSync, Buffer, fetch, URL, AbortSignal, setTimeout, crypto);\nconst add = (n) => {\n  total += n;\n};\nadd(1);\nconsole.log(total);\n', []);
  expect("the same name in two sibling scopes hides nothing", "function a() {\n  let n = 0;\n  n = 1;\n  return n;\n}\nfunction b() {\n  let n = 0;\n  n = 2;\n  return n;\n}\nconsole.log(a(), b());\n", []);
  expect("a file that doesn't parse is found", "const = ;\n", ["1: doesn't parse"]);
  rmSync(cases, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : "\nstatic-check self-test: all passed");
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest());
  const files = (argv.length ? argv : readdirSync(here).filter((name) => name.endsWith(".mjs")).sort()).map((name) => join(here, name));
  const all = check(files);
  if (all === null) {
    console.error("static-check needs `tsc` from apps/gateway: run `npm ci` in apps/gateway first.");
    process.exit(2);
  }
  const known = ({ file, text }) => (KNOWN_SHADOWS[relative(here, file)] ?? []).some((name) => text.startsWith(`declares \`${name}\`, hiding`));
  const found = all.filter((problem) => !known(problem));
  for (const { file, line, text } of found) console.log(`${relative(here, file)}:${line}: ${text}`);
  const listed = all.filter(known);
  if (listed.length) console.log(`known, and not failing: ${listed.length} hidden names in ${[...new Set(listed.map((problem) => relative(here, problem.file)))].join(", ")}`);
  console.log(found.length ? `\nstatic-check: ${found.length} found in ${new Set(found.map((problem) => problem.file)).size} of ${files.length} files` : `static-check: ${files.length} files, nothing found`);
  process.exit(found.length ? 1 : 0);
}
