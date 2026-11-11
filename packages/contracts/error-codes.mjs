// The error codes a text scan finds in Podster's API and gateway, with no build step, so check.mjs can hold the
// contract's `Error.code` enum to that set. It's a scan, not a compiler: what it follows and what it can't see are below.
//
// What this covers: the REST error body, `{ "error": { "code": … } }`, and nothing else. Out of scope: OAuth's `error`,
// MCP and JSON-RPC errors (a numeric code is skipped), A2A's own errors, and Agent Auth's own error body, which Better
// Auth writes as `{ code, message }` for `new APIError(…, { message: "unknown_capability" })` and the other refusals in
// the gateway's capability execute (apps/gateway/src/index.ts, onExecute): it isn't `error.code` and isn't in `Error`.
//
// Before scanning, comments are blanked (strings, raw strings, char and regex literals are skipped as they are), so
// commented-out code isn't counted. `// codes:` and `// error-codes:` comments are read from the raw text.
//
// How the places that make an error are found:
//   - Roots. Rust: `ApiError::api(status, code)`, `ApiError::explained(status, code, …)`, the struct literals
//     `ApiError::Api { code, … }`, `ApiError::Explained { code, … }` and the same through `Self::`, and a `json!` body
//     with an `"error": { "code": … }` object. Gateway: an object literal with a `code` field (anywhere in it, quoted or
//     not, over any number of lines) under an `error` key, assigned to a variable `error`, or assigned as `x.error = {…}`
//     or `x["error"] = {…}`; and `new AgentRefused(code)`.
//   - The code argument at each one must resolve to a string literal; a constant of the same file; a `.code()` call on a
//     type the collector can name (a type path, `self`, a binding typed in the function, an `Err(x)` from a function
//     whose `-> Result<_, T>` it reads, or a `// error-codes: type T` comment) whose `code()` is marked
//     `// codes: errors`; a parameter of the function it's in, which makes that function a constructor too, followed to
//     its callers; a name bound by a match arm `A::B(…, code, …) =>`, which makes `A::B` a constructor too; or a comment
//     on that line, its argument's line, or the line above either, naming its codes, `// error-codes: a, b`, or where
//     they come from, `// error-codes: from <constructor>`.
//   - A constructor's callers are found bare; through a module path (`super::`, `crate::x::`); as `Type::f`/`Self::f`;
//     as a method on any receiver (Rust) or on a namespace or object (`h.denied(…)`); under a name it's imported or
//     `use`d as (`as no`); and, in the gateway, wherever an `export { f }` list makes it public. A Rust private one is
//     seen in its file and its module's child files. A call that leaves the code out answers the wrapper's default.
//   - A problem fails check.mjs: an argument it can't resolve that way; a constructor passed as a value
//     (`.map_err(refuse)`), whose codes are given where it can't see; an error that's a variable (`error: made`); an
//     error object whose code can only come from a spread; and wrappers not settled within the pass limit.
//   - Every `fn code(` in any form must be marked, on the line directly above it, `// codes: errors` (a string it returns
//     can reach a caller as `error.code`) or `// codes: reasons` (it can't: it's data, such as a reason or an outcome).
//   - `ApiError::into_response` (apps/api/src/error.rs), the one place every ApiError is written as a body, is skipped by
//     name; if it stops writing the body, that's a problem too.
//
// What it can still miss, known and not closed:
//   - A wrapper stored in a variable or a field; a code forwarded through a second parameter of a wrapper that's already
//     a constructor; `super("x")` in a subclass of AgentRefused; a parameter shadowed by a local of the same name, which
//     is taken for the parameter.
//   - A typed binding is found by name, the latest one in the function, so a shadowed name can be tied to the wrong type.
//   - `error: Something` with a capitalized name is taken for a type annotation and skipped, so a variable named that way
//     isn't seen. An error object returned whole by a helper isn't seen.
//   - A `// error-codes:` comment is trusted: a wrong one is believed, and its codes aren't checked against the site.
//   - INTERNAL_ONLY pins a code to `path#function` and a count of uses there, so moving a use within one function, or
//     swapping one use for another, isn't seen.
//   - Files it doesn't read: `.tsx`, and anything under a folder named `test` or `tests`. Code inside an inline
//     `#[cfg(test)]` module is read, so a code only a test makes is counted as answered.
//   - `internal_error` is added by hand, not found.
//   - A code built at run time, and data flows it doesn't follow, such as a code kept in a struct field and read later.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const walk = (dir, ext) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (["node_modules", "target", "test", "tests"].includes(name)) return [];
    return statSync(path).isDirectory() ? walk(path, ext) : path.endsWith(ext) && !path.endsWith(".test.ts") ? [path] : [];
  });

/** The source files the collector reads, as `{ rust: [{ path, text }], gateway: [{ path, text }] }`. */
export function readSources(root) {
  const read = (files) => files.map((file) => ({ path: relative(root, file), text: readFileSync(file, "utf8") }));
  return {
    rust: read([...walk(join(root, "apps/api/src"), ".rs"), ...walk(join(root, "crates"), ".rs")]),
    gateway: read(walk(join(root, "apps/gateway/src"), ".ts")),
  };
}

/**
 * If a string, char or regex literal starts at `at`, the index of its last character; otherwise -1. Rust: "…", raw
 * r"…" and r#"…"# (with b prefixes), and char literals such as '\'' or ')', told apart from lifetimes. TypeScript: "…",
 * '…', `…` and a regex literal where an expression starts.
 */
function literalEnd(text, at, lang) {
  const c = text[at];
  if (lang === "rust") {
    if ((c === "r" || c === "b") && !/\w/.test(text[at - 1] ?? "")) {
      const raw = text.slice(at, at + 300).match(/^b?r(#*)"/);
      if (raw) {
        const end = text.indexOf(`"${raw[1]}`, at + raw[0].length);
        return end === -1 ? text.length - 1 : end + raw[1].length;
      }
    }
    if (c === "'") {
      const char = text.slice(at, at + 14).match(/^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|[^\n])|[^\\'\n])'/u);
      return char ? at + char[0].length - 1 : -1; // otherwise a lifetime, such as 'static
    }
    if (c !== '"') return -1;
  } else {
    if (c === "/" && text[at + 1] !== "/" && text[at + 1] !== "*") {
      const before = text.slice(Math.max(0, at - 12), at);
      if (!/(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(before)) return -1; // division
      let inClass = false;
      for (let i = at + 1; i < text.length && text[i] !== "\n"; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        else if (text[i] === "/" && !inClass) return i;
      }
      return -1;
    }
    if (c !== '"' && c !== "'" && c !== "`") return -1;
  }
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === c) return i;
  }
  return text.length - 1;
}

/**
 * `text` with its comments blanked to spaces (newlines kept, so every index and line number still matches the raw
 * text). Strings are left as they are, so a quote or `//` inside one isn't taken for a comment. Rust block comments nest.
 */
function stripComments(text, lang) {
  const out = text.split("");
  for (let at = 0; at < text.length; at++) {
    const end = literalEnd(text, at, lang);
    if (end !== -1) {
      at = end;
      continue;
    }
    if (text[at] === "/" && text[at + 1] === "/") {
      for (; at < text.length && text[at] !== "\n"; at++) out[at] = " ";
    } else if (text[at] === "/" && text[at + 1] === "*") {
      let depth = 0;
      for (; at < text.length; at++) {
        // Rust's block comments nest; TypeScript's don't.
        if (text[at] === "/" && text[at + 1] === "*" && (lang === "rust" || depth === 0)) depth++;
        else if (text[at] === "*" && text[at + 1] === "/" && --depth === 0) {
          out[at] = out[at + 1] = " ";
          at++;
          break;
        }
        if (text[at] !== "\n") out[at] = " ";
      }
    }
  }
  return out.join("");
}

/** Index of the bracket that closes the one at `open`, skipping string, char and regex literals. */
function closing(text, open, lang = "rust") {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let at = open; at < text.length; at++) {
    const end = literalEnd(text, at, lang);
    if (end !== -1) {
      at = end;
      continue;
    }
    const c = text[at];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return at;
    }
  }
  return text.length;
}

/** The top-level comma-separated pieces of `inner`. */
function split(inner, lang = "rust") {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < inner.length; at++) {
    const end = literalEnd(inner, at, lang);
    if (end !== -1) {
      at = end;
      continue;
    }
    const c = inner[at];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, at).trim());
      start = at + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every function in a file: its name (with `Type::` for a method in `impl Type`), parameter names and defaults, and
 * body span. A TypeScript function is exported by `export` on it or by an `export { f }` list.
 */
function functions(text, lang) {
  const out = [];
  const pattern = lang === "rust"
    ? /\b(pub(?:\([a-z]+\))?\s+)?(?:const\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g
    : /(?:\b(export)\s+)?(?:async\s+)?(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\()/g;
  const listed = lang === "ts" ? new Set([...text.matchAll(/\bexport\s*\{([^}]*)\}/g)].flatMap((found) => found[1].split(",").map((piece) => piece.trim().split(/\s+as\s+/)[0]))) : new Set();
  for (const found of text.matchAll(pattern)) {
    const name = found[2] ?? found[3];
    const open = found.index + found[0].length - 1;
    const close = closing(text, open, lang);
    const pieces = split(text.slice(open + 1, close), lang);
    const params = pieces.map(paramName).filter(Boolean);
    const defaults = pieces.filter((piece) => paramName(piece)).map((piece) => {
      const at = split(piece.replace(/=/, ","), lang);
      return lang === "ts" && /=/.test(piece) ? at.at(-1) : undefined;
    });
    const brace = text.indexOf(lang === "rust" ? "{" : "", close);
    const bodyOpen = lang === "rust" ? brace : (() => {
      const arrow = text.slice(close, close + 200).match(/^\)\s*(?::[^=>{]*)?\s*(=>\s*)?(\{)?/);
      return arrow?.[2] ? close + arrow[0].length - 1 : close + (arrow?.[0].length ?? 1);
    })();
    const bodyClose = text[bodyOpen] === "{" ? closing(text, bodyOpen, lang) : text.indexOf("\n", bodyOpen) === -1 ? text.length : (() => {
      // An arrow with an expression body ends at the statement's end: the next line that starts at its own indent.
      const lineStart = text.lastIndexOf("\n", found.index) + 1;
      const indent = text.slice(lineStart).match(/^\s*/)[0];
      const rest = text.slice(bodyOpen);
      const end = rest.search(new RegExp(`\\n${indent}\\S`));
      return end === -1 ? text.length : bodyOpen + end;
    })();
    let owner = null;
    if (lang === "rust") {
      const before = text.slice(0, found.index);
      const impl = [...before.matchAll(/^impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?(\w+)/gm)].at(-1);
      if (impl && closing(text, text.indexOf("{", impl.index), lang) > found.index) owner = impl[1];
    }
    out.push({ name: owner ? `${owner}::${name}` : name, short: name, exported: Boolean(found[1]) || listed.has(name), params, defaults, start: found.index, bodyOpen, bodyClose });
  }
  return out;
}

/** The comment's codes for the call on `line`, or its argument on `argLine` (each on its line or the one above): `// error-codes: a, b`, `// error-codes: from X` or `// error-codes: type T`. */
function annotation(text, line, argLine = line) {
  const lines = text.split("\n");
  for (const candidate of [lines[argLine - 1], lines[argLine - 2], lines[line - 1], lines[line - 2]]) {
    const found = candidate?.match(/\/\/\s*error-codes:\s*(.+)$/);
    if (found) return found[1].trim();
  }
  return null;
}

/** The folder a Rust file's private items are visible in, besides the file: its own module's children. */
const moduleDir = (path) => (/(?:^|\/)(?:mod|lib|main)\.rs$/.test(path) ? path.replace(/\/[^/]+$/, "") : path.replace(/\.rs$/, ""));
/** A Rust parameter's name, with `&`, a lifetime and `mut` taken off. */
const paramName = (p) => p.replace(/^&\s*(?:'\w+\s+)?/, "").replace(/^mut\s+/, "").replace(/^\.\.\./, "").match(/^(\w+)/)?.[1];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `{ codes, sites, problems, excluded, excludedBySurface, sitesBySurface, missingSurfaces, markedStrings, constructors }`
 * from `sources` (see readSources). `sites` maps each code to the places that answer it, as `path#function`.
 * `excludedSurfaces` names gateway files, or folders ending in "/", whose answers aren't the contract's (see check.mjs);
 * their codes are reported apart, per surface, and never required. `maxPasses` bounds following wrappers, and a run
 * that hasn't settled within it is a problem.
 */
export function collectErrorCodes(input, excludedSurfaces = {}, { maxPasses = 20 } = {}) {
  // Comments are blanked before anything is scanned, so commented-out code isn't counted. Markers and `// error-codes:`
  // comments are read from the raw text, at the same indexes.
  const prepare = (files, lang) => files.map(({ path, text }) => ({ path, raw: text, text: stripComments(text, lang) }));
  const sources = { rust: prepare(input.rust, "rust"), gateway: prepare(input.gateway, "ts") };
  const codes = new Map();
  const sites = new Map();
  const excluded = new Map();
  const excludedBySurface = new Map(Object.keys(excludedSurfaces).map((surface) => [surface, new Map()]));
  const sitesBySurface = new Map(Object.keys(excludedSurfaces).map((surface) => [surface, 0]));
  const problems = [];
  const markers = new Map();
  const markedStrings = new Map();
  const surfaceOf = (path) => Object.keys(excludedSurfaces).find((surface) => (surface.endsWith("/") ? path.startsWith(surface) : path === surface));
  const add = (code, where, path, site = where, at = -1) => {
    const surface = path && surfaceOf(path);
    if (surface) {
      if (!excluded.has(code)) excluded.set(code, where);
      excludedBySurface.get(surface).set(code, where);
      return;
    }
    if (!codes.has(code)) codes.set(code, where);
    // Each distinct place, so a pinned site is held to how many times it answers the code, not only where.
    if (!sites.has(code)) sites.set(code, new Map());
    if (!sites.get(code).has(site)) sites.get(code).set(site, new Set());
    sites.get(code).get(site).add(at);
  };
  /** The one place every ApiError is written as a body. Its code is the error's own, already collected where it's made. */
  const SINKS = new Map([["apps/api/src/error.rs#ApiError::into_response", false]]);
  /** `path#function` for the function around `index`, the name INTERNAL_ONLY pins a site by. */
  const siteOf = (path, fns, index) => `${path}#${fns.filter((f) => f.start <= index && f.bodyClose > index).at(-1)?.name ?? "(top level)"}`;

  // The code() methods: each marked on the line directly above it, and the strings of those marked `errors`.
  for (const { path, text, raw } of sources.rust) {
    const fns = functions(text, "rust");
    const lines = raw.split("\n");
    for (const found of text.matchAll(/\bfn\s+code\s*\(/g)) {
      const line = lineOf(text, found.index);
      const marker = lines[line - 2]?.match(/^\s*\/\/ codes: (\w+)\s*$/)?.[1];
      const fn = fns.find((f) => f.start <= found.index && f.bodyOpen > found.index);
      const owner = fn?.name.split("::")[0];
      if (!["errors", "reasons"].includes(marker)) {
        problems.push(`${path}:${line}: a code() method needs "// codes: errors" or "// codes: reasons" on the line directly above it`);
        continue;
      }
      // Two types of one name marked differently can't be told apart by name, so neither is trusted.
      markers.set(owner, markers.has(owner) && markers.get(owner) !== marker ? "conflict" : marker);
      if (marker !== "errors") continue;
      for (const literal of text.slice(fn.bodyOpen, fn.bodyClose).matchAll(/"([a-z][a-z0-9_]*)"/g)) {
        add(literal[1], `${path}:${line}`, path, `${path}#${fn.name}`, fn.bodyOpen + literal.index);
        markedStrings.set(literal[1], `${path}:${line}`);
      }
    }
  }
  const settledProblems = problems.length;

  // Constructors: key → { name, index, lang, visible: path → bool, self: called as a method on a receiver, fallback: a
  // default argument for the code }.
  const everywhere = () => true;
  const constructors = new Map([
    ["ApiError::api", { name: "ApiError::api", index: 1, lang: "rust", visible: everywhere, self: false }],
    ["ApiError::explained", { name: "ApiError::explained", index: 1, lang: "rust", visible: everywhere, self: false }],
    ["new AgentRefused", { name: "new AgentRefused", index: 0, lang: "ts", visible: everywhere, self: false }],
  ]);
  const named = (name) => [...constructors.values()].some((c) => c.name === name || c.name.split("::").at(-1) === name);

  /** Where a new constructor `fn` of `path` can be called from. */
  const visibility = (fn, path, lang) => {
    if (fn.exported) return everywhere;
    if (lang === "ts") return (at) => at === path;
    const dir = `${moduleDir(path)}/`;
    return (at) => at === path || at.startsWith(dir);
  };

  /** The type whose code() `receiver.code()` calls, if the collector can tell: a type path, `self`, or a typed binding. */
  const receiverType = (receiver, { text, index, fns }) => {
    const typed = receiver.match(/^(?:[a-z_]\w*::)*([A-Z]\w*)(?:::\w+)?(?:\([^)]*\))?$/);
    if (typed) return typed[1];
    const fn = fns.filter((f) => f.start < index && f.bodyClose > index).at(-1);
    if (receiver === "self") return fn?.name.includes("::") ? fn.name.split("::")[0] : null;
    if (!/^\w+$/.test(receiver) || !fn) return null;
    const before = text.slice(fn.start, index);
    const binding = [...before.matchAll(new RegExp(`\\b${receiver}\\s*:\\s*&?\\s*(?:'\\w+\\s+)?(?:mut\\s+)?(?:\\w+::)*([A-Z]\\w*)\\b`, "g"))].at(-1);
    if (binding) return binding[1];
    // An error bound from a call: `match f(…) { … Err(x) => … }`, `if let Err(x) = f(…)` or `f(…).map_err(|x| …)`, typed
    // by f's own `-> Result<_, T>`. One function of that name with one error type, or nothing is inferred.
    const producer =
      before.match(new RegExp(`\\bif\\s+let\\s+Err\\(\\s*${receiver}\\s*\\)\\s*=\\s*(?:\\w+::)*(\\w+)\\s*\\([^;]*$`))?.[1] ??
      before.match(new RegExp(`\\bmatch\\s+(?:\\w+::)*(\\w+)\\s*\\([^;]*Err\\(\\s*${receiver}\\s*\\)\\s*=>[^;]*$`))?.[1] ??
      (() => {
        // f(…).map_err(|x| …): the call that ends right before `.map_err`, found by walking its brackets back.
        const at = [...before.matchAll(new RegExp(`\\)\\s*\\.map_err\\(\\s*\\|\\s*${receiver}\\s*\\|[^;]*$`, "g"))].at(-1)?.index;
        if (at === undefined) return null;
        let depth = 0;
        for (let i = at; i >= 0; i--) {
          if (before[i] === ")") depth++;
          else if (before[i] === "(" && --depth === 0) return before.slice(0, i).match(/(\w+)\s*$/)?.[1] ?? null;
        }
        return null;
      })();
    if (!producer) return null;
    const types = new Set(sources.rust.flatMap(({ text: other }) =>
      [...other.matchAll(new RegExp(`\\bfn\\s+${producer}\\s*(?:<[^>]*>)?\\s*\\(`, "g"))].map((found) => {
        const shut = closing(other, found.index + found[0].length - 1);
        return other.slice(shut + 1, shut + 300).match(/^\s*->\s*Result<[^{;]*,\s*(?:\w+::)*([A-Z]\w*)>\s*(?:where\b|\{)/)?.[1] ?? null;
      })));
    return types.size === 1 && !types.has(null) ? [...types][0] : null;
  };

  /** Resolves one code argument found at `index` of `text`. Answers true when it's accounted for. */
  const resolve = (arg, context) => {
    const { path, text, raw, index, lang, fns, where, argAt = index } = context;
    const line = lineOf(text, index);
    const site = siteOf(path, fns, index);
    const problem = (message) => (problems.push(`${path}:${line}: ${message}`), false);
    // A number is a JSON-RPC error's code, another shape than the REST body this covers.
    if (/^-?\d+$/.test(arg)) return true;
    const literal = arg.match(/^"([a-z][a-z0-9_]*)"$/) ?? arg.match(/^'([a-z][a-z0-9_]*)'$/);
    if (literal) return add(literal[1], where, path, site, index), true;
    const constant = arg.match(/^([A-Z][A-Z0-9_]*)$/);
    if (constant) {
      const value = text.match(new RegExp(`const ${constant[1]}\\s*(?::\\s*&(?:'static\\s+)?str)?\\s*=\\s*"([a-z][a-z0-9_]*)"`))?.[1];
      if (value) return add(value, where, path, site, index), true;
    }
    const note = annotation(raw, line, lineOf(text, argAt));
    if (/\.code\(\)$/.test(arg)) {
      // A code() call gives the strings of its type's code(), so the type must be known and marked errors.
      const namedType = note?.match(/^type\s+(\w+)$/)?.[1];
      // A comment naming the type wins over what the collector infers, which a shadowed name can mislead.
      const type = namedType ?? receiverType(arg.slice(0, -".code()".length), context);
      if (!type) {
        if (note && !note.startsWith("type ") && !note.startsWith("from ")) return note.split(/[\s,]+/).filter(Boolean).forEach((code) => add(code, where, path, site, index)), true;
        return problem(`can't tell which type's code() ${arg} calls; name it in a "// error-codes: type <Type>" comment`);
      }
      const marker = markers.get(type);
      if (marker === "errors") return true;
      if (marker === "reasons") return problem(`${arg} is an error code, but ${type}::code() is marked reasons`);
      if (marker === "conflict") return problem(`${arg}: two types named ${type} have code() marked differently, so name its codes in a "// error-codes:" comment`);
      return problem(`${arg}: ${type} has no code() marked "// codes: errors" that the collector reads`);
    }
    if (note) {
      const from = note.match(/^from\s+(.+?)\s*$/);
      if (from && !named(from[1])) return problem(`"// error-codes: ${note}" names ${from[1]}, which isn't a constructor the collector knows`);
      if (note.startsWith("type ")) return problem(`"// error-codes: ${note}" is only for a code() call`);
      if (!from) for (const code of note.split(/[\s,]+/).filter(Boolean)) add(code, where, path, site, index);
      return true;
    }
    if (context.shape) return problem(`can't tell the error code in ${context.shape} here; build the error with its code in it, or name its codes in a "// error-codes:" comment`);
    const name = arg.match(/^(\w+)$/)?.[1];
    if (name) {
      const fn = fns.filter((f) => f.bodyOpen < index && f.bodyClose > index).at(-1);
      const param = fn?.params.indexOf(name) ?? -1;
      if (fn && param !== -1) {
        const k = `${path}#${fn.name}`;
        const self = lang === "rust" && fn.params[0] === "self";
        if (!constructors.has(k)) constructors.set(k, { name: lang === "ts" ? fn.short : fn.name, index: param, lang, visible: visibility(fn, path, lang), self, fallback: fn.defaults[param] });
        return true;
      }
      const arm = text.slice(fn?.bodyOpen ?? 0, index).match(new RegExp(`(\\w+::\\w+)\\(([^()]*\\b${name}\\b[^()]*)\\)\\s*=>[^=>]*$`));
      if (arm) {
        const at = split(arm[2]).indexOf(name);
        if (!constructors.has(arm[1])) constructors.set(arm[1], { name: arm[1], index: at, lang, visible: everywhere, self: false });
        return true;
      }
    }
    return problem(`can't tell the error code ${arg} here; write a literal or a same-file constant, or name its codes in a "// error-codes:" comment`);
  };

  const MODULE_PATH = "(?:(?:crate|super|self|[a-z_][a-z0-9_]*)::)*";
  /** The regular expressions that find calls of a constructor, each with how far its arguments are shifted. */
  const callPatterns = ({ name, lang, self }) => {
    if (name.startsWith("new ")) return [[new RegExp(`${name.replace(" ", "\\s+")}\\s*\\(`, "g"), 0]];
    const short = escape(name.split("::").at(-1));
    // A gateway function: bare, or on a namespace or object, such as h.denied(…) after `import * as h`.
    if (lang === "ts") return [[new RegExp(`(?<![\\w.:$])${short}\\s*\\(`, "g"), 0], [new RegExp(`\\.\\s*${short}\\s*\\(`, "g"), 0]];
    if (name.includes("::")) {
      // A type's function: by its path or Self::, and a method also on any receiver, which takes the place of self.
      const [type] = name.split("::");
      const out = [[new RegExp(`\\b(?:${type}|Self)::${short}\\s*\\(`, "g"), 0]];
      if (self) out.push([new RegExp(`\\.\\s*${short}\\s*\\(`, "g"), -1]);
      return out;
    }
    // A free function: bare, or through a module path such as super::, crate::x:: or helpers::.
    return [[new RegExp(`(?<![\\w.:])${MODULE_PATH}${short}\\s*\\(`, "g"), 0]];
  };

  /** The regular expression that finds a constructor passed as a value, such as `.map_err(refuse)`, not called. */
  const valuePattern = ({ name, lang }) => {
    if (name.startsWith("new ")) return null;
    const short = escape(name.split("::").at(-1));
    const path = lang === "ts" ? "(?:[\\w$]+\\.)?" : name.includes("::") ? `(?:${name.split("::")[0]}|Self)::` : MODULE_PATH;
    return new RegExp(`[(,]\\s*(${path}${short})\\s*(?=[),])`, "g");
  };

  /** Spans of import and use statements and export lists, where a name is mentioned without being used. */
  const declarations = (text, lang) =>
    [...text.matchAll(lang === "ts" ? /\bimport\b[^;]*?\bfrom\s*["'][^"']*["']|\bexport\s*\{[^}]*\}/g : /\buse\s[^;]*;/g)].map((found) => [found.index, found.index + found[0].length]);

  /** `orig as alias` pairs from a file's imports (TypeScript) or `use` statements (Rust). */
  const aliases = (text, lang) =>
    [...text.matchAll(lang === "ts" ? /\bimport\s*\{([^}]*)\}/g : /\buse\s([^;]*);/g)].flatMap((found) =>
      [...found[1].matchAll(/\b(\w+)\s+as\s+(\w+)\b/g)].map((pair) => [pair[1], pair[2]]));

  // Follows constructors to a fixed point: a wrapper found on one pass is a constructor on the next.
  let settled = false;
  for (let pass = 0; pass < maxPasses && !settled; pass++) {
    const before = constructors.size;
    problems.length = settledProblems;
    for (const surface of sitesBySurface.keys()) sitesBySurface.set(surface, 0);
    for (const [lang, files] of [["rust", sources.rust], ["ts", sources.gateway]]) {
      for (const { path, text, raw } of files) {
        const fns = functions(text, lang);
        const context = { path, text, raw, lang, fns, where: path };
        const surface = surfaceOf(path);
        const site = () => surface && sitesBySurface.set(surface, sitesBySurface.get(surface) + 1);
        // A constructor imported or used under another name is a constructor in this file by that name.
        for (const [orig, alias] of aliases(text, lang)) {
          const source = [...constructors.values()].find((c) => c.lang === lang && c.name.split("::").at(-1) === orig && !c.name.includes("::") && c.visible(path));
          const k = `${path}#as ${alias}`;
          if (source && !constructors.has(k)) constructors.set(k, { ...source, name: alias, visible: (at) => at === path });
        }
        const skipped = declarations(text, lang);
        // Calls of every constructor known so far.
        for (const constructor of constructors.values()) {
          if (constructor.lang !== lang || !constructor.visible(path)) continue;
          for (const [pattern, shift] of callPatterns(constructor)) {
            for (const call of text.matchAll(pattern)) {
              const prefix = text.slice(Math.max(0, call.index - 12), call.index);
              if (/fn\s+$|function\s+$|const\s+$/.test(prefix)) continue;
              const open = call.index + call[0].length - 1;
              const shut = closing(text, open, lang);
              // A match arm's pattern names the variant without making one.
              if (lang === "rust" && /^\s*(=>|\|)/.test(text.slice(shut + 1))) continue;
              const arg = split(text.slice(open + 1, shut), lang)[constructor.index + shift];
              if (arg === undefined) {
                // A call that leaves the code out answers the wrapper's default, when it has one.
                if (constructor.fallback !== undefined) {
                  site();
                  resolve(constructor.fallback, { ...context, index: call.index });
                }
                continue;
              }
              site();
              resolve(arg, { ...context, index: call.index, argAt: text.indexOf(arg, open) });
            }
          }
          // A constructor passed as a value is called somewhere this can't see, with codes it can't read.
          const value = valuePattern(constructor);
          for (const found of value ? text.matchAll(value) : []) {
            const at = found.index + found[0].indexOf(found[1]);
            if (skipped.some(([from, to]) => at >= from && at < to)) continue;
            if (fns.some((f) => at > f.start && at < f.bodyOpen)) continue; // a parameter list, not a value
            site();
            const note = annotation(raw, lineOf(text, at));
            if (note && !/^(from|type)\s/.test(note)) {
              for (const code of note.split(/[\s,]+/).filter(Boolean)) add(code, path, path, siteOf(path, fns, at), at);
              continue;
            }
            problems.push(`${path}:${lineOf(text, at)}: ${found[1]} is passed as a function value, so the codes it's given can't be read here; call it, or name its codes in a "// error-codes:" comment`);
          }
        }
        // Struct literals and object literals that are errors themselves.
        const literals = lang === "rust"
          ? [/\b(?:ApiError|Self)::(?:Api|Explained)\s*\{/g, /"error"\s*:\s*\{/g]
          : [/(?<![\w$])["']?error["']?\s*:\s*\{/g, /\b(?:const|let|var)\s+error\s*(?::[^=;{]+)?=\s*\{/g, /(?:\.error|\[\s*["']error["']\s*\])\s*=\s*\{/g];
        for (const pattern of literals) {
          for (const found of text.matchAll(pattern)) {
            const open = found.index + found[0].length - 1;
            const close = closing(text, open, lang);
            if (lang === "rust" && /^\s*(=>|\||\))/.test(text.slice(close + 1))) continue; // a pattern, not a value
            const sink = siteOf(path, fns, found.index);
            if (SINKS.has(sink)) {
              SINKS.set(sink, true);
              continue;
            }
            const fields = split(text.slice(open + 1, close), lang);
            const field = fields.find((f) => /^(?:code|"code"|'code')\s*(?::|$)/.test(f));
            if (!field) {
              // An error object with no code of its own takes one from what it spreads, which can't be read here.
              if (fields.some((f) => f.startsWith("..."))) {
                site();
                resolve(fields.find((f) => f.startsWith("...")), { ...context, index: found.index });
              }
              continue;
            }
            site();
            resolve(field.includes(":") ? field.slice(field.indexOf(":") + 1).trim() : "code", { ...context, index: found.index });
          }
        }
        // An error that's a variable, `error: made`, holds a code this can't read. A type's `error: string` isn't one.
        if (lang === "ts") {
          for (const found of text.matchAll(/(?<![\w$.])["']?error["']?\s*:\s*([A-Za-z_$][\w$.]*)\s*(?=[,})\n])/g)) {
            if (/^(?:string|number|boolean|unknown|any|undefined|null|never|object|true|false|[A-Z]\w*)$/.test(found[1])) continue;
            site();
            resolve(found[1], { ...context, index: found.index, shape: `error: ${found[1]}` });
          }
        }
      }
    }
    settled = constructors.size === before;
  }
  if (!settled) problems.push(`the collector didn't settle after ${maxPasses} pass${maxPasses === 1 ? "" : "es"}: a chain of wrappers is longer than it follows, so its codes may be missing`);
  // The API's own answer to an internal error, made in ApiError::status_and_code rather than by a constructor.
  add("internal_error", "apps/api/src/error.rs", null, "apps/api/src/error.rs#ApiError::status_and_code");
  if (sources.rust.some(({ path }) => path === "apps/api/src/error.rs")) {
    for (const [sink, seen] of SINKS) if (!seen) problems.push(`${sink.split("#")[0]}: ${sink.split("#")[1]} no longer writes the error body, so the collector's SINKS entry for it is stale`);
  }
  const known = new Set([...sources.rust, ...sources.gateway].map(({ path }) => path));
  const missingSurfaces = Object.keys(excludedSurfaces).filter((surface) => ![...known].some((path) => (surface.endsWith("/") ? path.startsWith(surface) : path === surface)));
  const counted = new Map([...sites].map(([code, places]) => [code, new Map([...places].map(([site, at]) => [site, at.size]))]));
  return { codes, sites: counted, problems: [...new Set(problems)], excluded, excludedBySurface, sitesBySurface, missingSurfaces, markedStrings, constructors: [...constructors.values()].map((c) => c.name) };
}

/** The problems with the excluded surfaces: one that's gone, makes no error any more, or answers codes not pinned for it. */
export function compareExcluded(excludedSurfaces, found) {
  const problems = [];
  for (const [surface, { codes: pinned }] of Object.entries(excludedSurfaces)) {
    if (found.missingSurfaces.includes(surface)) {
      problems.push(`EXCLUDED_SURFACES: ${surface} doesn't exist any more, so take it off the list`);
      continue;
    }
    if (!found.sitesBySurface.get(surface)) problems.push(`EXCLUDED_SURFACES: ${surface} makes no error any more, so take it off the list`);
    const answered = new Set(found.excludedBySurface.get(surface)?.keys() ?? []);
    for (const code of answered) if (!pinned.includes(code)) problems.push(`EXCLUDED_SURFACES: ${surface} answers ${code}, which isn't pinned for it`);
    for (const code of pinned) if (!answered.has(code)) problems.push(`EXCLUDED_SURFACES: ${surface} is pinned to ${code}, which it doesn't answer any more`);
  }
  return problems;
}

/**
 * The problems with an `Error.code` enum against what was collected: missing, unanswered, or wrongly internal.
 * `internalOnly` maps a code to `{ why, sites }`, where `sites` maps each `path#function` allowed to answer it to how
 * many times it does. Any other site, or one more use in a pinned one, is a problem, so a new public use of an internal
 * code can't hide behind the old ones.
 */
export function compareWithEnum(enumCodes, found, internalOnly) {
  const errorCodes = new Set(enumCodes);
  const problems = [];
  for (const [code, where] of found.codes) {
    if (!errorCodes.has(code) && !(code in internalOnly)) problems.push(`Error.code: missing ${code}, which ${where} answers`);
    if (errorCodes.has(code) && code in internalOnly) problems.push(`Error.code: lists ${code}, which only an internal route answers`);
  }
  for (const code of errorCodes) if (!found.codes.has(code)) problems.push(`Error.code: lists ${code}, which nothing in the API or the gateway answers`);
  for (const [code, { sites: pinned }] of Object.entries(internalOnly)) {
    const answered = found.sites.get(code) ?? new Map();
    if (!found.codes.has(code)) problems.push(`INTERNAL_ONLY: ${code} isn't answered anywhere any more, so take it off the list`);
    for (const [site, times] of answered) {
      if (!(site in pinned)) problems.push(`INTERNAL_ONLY: ${code} is answered at ${site}, which isn't pinned for it; pin the site if it's internal, or list the code in Error.code`);
      else if (times !== pinned[site]) problems.push(`INTERNAL_ONLY: ${code} is answered ${times} time${times === 1 ? "" : "s"} at ${site}, which is pinned for ${pinned[site]}; pin the new count if every use is internal, or list the code in Error.code`);
    }
    for (const site of Object.keys(pinned)) if (!answered.has(site)) problems.push(`INTERNAL_ONLY: ${code} is pinned to ${site}, which doesn't answer it any more`);
  }
  return problems;
}
