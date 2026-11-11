// The error codes Podster's API and gateway can answer, collected from their source text with no build step, so
// check.mjs can hold the contract's `Error.code` enum to exactly that set.
//
// What this covers: the REST error body, `{ "error": { "code": … } }`, and nothing else. Not OAuth's `error`, MCP or
// JSON-RPC errors, A2A's own errors, or a code built at run time (with `format!` or a template), which can't be read here.
//
// How the places that make an error are found:
//   - Roots. Rust: `ApiError::api(status, code)`, `ApiError::explained(status, code, …)` and the struct literals
//     `ApiError::Api { code, … }` and `ApiError::Explained { code, … }`. Gateway: an object literal with a `code` field
//     (anywhere in it, quoted or not, over any number of lines) under an `error` key or assigned to a variable `error`,
//     and `new AgentRefused(code)`.
//   - The code argument at each one must resolve to a string literal; a constant of the same file; a `.code()` call on a
//     type the collector can name (a type path, `self`, a binding typed in the function, an `Err(x)` from a function
//     whose `-> Result<_, T>` it reads, or a `// error-codes: type T` comment) whose `code()` is marked
//     `// codes: errors`; a parameter of the function it's in, which makes that function a constructor too, followed to
//     its callers (bare, through a module path such as `super::` or `crate::x::`, as `Type::f`/`Self::f`, or as a
//     method on any receiver; a private one in its file and its module's child files); a name bound by a match arm
//     `A::B(…, code, …) =>`, which makes `A::B` a constructor too; or a comment on that line, its argument's line, or
//     the line above either, naming its codes, `// error-codes: a, b`, or where they come from,
//     `// error-codes: from <constructor>`.
//   - An argument it can't resolve that way is a problem, and check.mjs fails.
//   - Every `fn code(` in any form must be marked, on the line directly above it, `// codes: errors` (a string it returns
//     can reach a caller as `error.code`) or `// codes: reasons` (it can't: it's data, such as a reason or an outcome).
//
// What it can still miss, known and not closed (a text scan, not a compiler):
//   - A wrapper reached through an alias (`use x::refuse as no;`, or a function stored in a variable), a code forwarded
//     through a second parameter of a wrapper that's already a constructor, `super("x")` in a subclass of AgentRefused,
//     and a parameter shadowed by a local of the same name, which is taken for the parameter.
//   - A typed binding is found by name, the latest one in the function, so a shadowed name can be tied to the wrong type.
//   - A `// error-codes:` comment is trusted: a wrong one is believed, and its codes aren't checked against the site.
//   - Files it doesn't read: `.tsx`, and anything under a folder named `test` or `tests`. Code inside an inline
//     `#[cfg(test)]` module is read, so a code only a test makes is counted as answered.
//   - `internal_error` is added by hand, not found.
//   - Other answer shapes: a code built at run time, an error object spread in from elsewhere with no `code` of its own
//     is a problem but one built by a helper returning a whole object isn't seen, and data flows it doesn't follow, such
//     as a code kept in a struct field and read later.
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

/** Index of the bracket that closes the one at `open`, skipping strings. */
function closing(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let at = open; at < text.length; at++) {
    const c = text[at];
    if (c === '"' || c === "`" || (c === "'" && /[\s(,=[{:]/.test(text[at - 1] ?? " ") && text[at + 2] === "'")) {
      const quote = c;
      for (at++; at < text.length && text[at] !== quote; at++) if (text[at] === "\\") at++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return at;
    }
  }
  return text.length;
}

/** The top-level comma-separated pieces of `inner`. */
function split(inner) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < inner.length; at++) {
    const c = inner[at];
    if (c === '"' || c === "`") {
      for (at++; at < inner.length && inner[at] !== c; at++) if (inner[at] === "\\") at++;
      continue;
    }
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

/** Every function in a file: its name (with `Type::` for a method in `impl Type`), parameter names, body span. */
function functions(text, lang) {
  const out = [];
  const pattern = lang === "rust"
    ? /\b(pub(?:\([a-z]+\))?\s+)?(?:const\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g
    : /(?:\b(export)\s+)?(?:async\s+)?(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\()/g;
  for (const found of text.matchAll(pattern)) {
    const name = found[2] ?? found[3];
    const open = found.index + found[0].length - 1;
    const close = closing(text, open);
    const params = split(text.slice(open + 1, close)).map(paramName).filter(Boolean);
    const brace = text.indexOf(lang === "rust" ? "{" : "", close);
    const bodyOpen = lang === "rust" ? brace : (() => {
      const arrow = text.slice(close, close + 200).match(/^\)\s*(?::[^=>{]*)?\s*(=>\s*)?(\{)?/);
      return arrow?.[2] ? close + arrow[0].length - 1 : close + (arrow?.[0].length ?? 1);
    })();
    const bodyClose = text[bodyOpen] === "{" ? closing(text, bodyOpen) : text.indexOf("\n", bodyOpen) === -1 ? text.length : (() => {
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
      if (impl && closing(text, text.indexOf("{", impl.index)) > found.index) owner = impl[1];
    }
    out.push({ name: owner ? `${owner}::${name}` : name, short: name, exported: Boolean(found[1]), params, start: found.index, bodyOpen, bodyClose });
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
 * `{ codes, problems, excluded, excludedBySurface, sitesBySurface, markedStrings, constructors }` from `sources` (see
 * readSources). `excludedSurfaces` names gateway files, or folders ending in "/", whose answers aren't the contract's
 * (see check.mjs); their codes are reported apart, per surface, and never required.
 */
export function collectErrorCodes(sources, excludedSurfaces = {}) {
  const codes = new Map();
  const excluded = new Map();
  const excludedBySurface = new Map(Object.keys(excludedSurfaces).map((surface) => [surface, new Map()]));
  const sitesBySurface = new Map(Object.keys(excludedSurfaces).map((surface) => [surface, 0]));
  const problems = [];
  const markers = new Map();
  const markedStrings = new Map();
  const surfaceOf = (path) => Object.keys(excludedSurfaces).find((surface) => (surface.endsWith("/") ? path.startsWith(surface) : path === surface));
  const add = (code, where, path) => {
    const surface = path && surfaceOf(path);
    if (surface) {
      if (!excluded.has(code)) excluded.set(code, where);
      excludedBySurface.get(surface).set(code, where);
    } else if (!codes.has(code)) codes.set(code, where);
  };

  // The code() methods: each marked on the line directly above it, and the strings of those marked `errors`.
  for (const { path, text } of sources.rust) {
    const fns = functions(text, "rust");
    const lines = text.split("\n");
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
        add(literal[1], `${path}:${line}`);
        markedStrings.set(literal[1], `${path}:${line}`);
      }
    }
  }

  // Constructors: key → { name, index, lang, visible: path → bool, self: called as a method on a receiver }.
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
    const { path, text, index, lang, fns, where, argAt = index } = context;
    const line = lineOf(text, index);
    const problem = (message) => (problems.push(`${path}:${line}: ${message}`), false);
    // A number is a JSON-RPC error's code, another shape than the REST body this covers.
    if (/^-?\d+$/.test(arg)) return true;
    const literal = arg.match(/^"([a-z][a-z0-9_]*)"$/) ?? arg.match(/^'([a-z][a-z0-9_]*)'$/);
    if (literal) return add(literal[1], where, path), true;
    const constant = arg.match(/^([A-Z][A-Z0-9_]*)$/);
    if (constant) {
      const value = text.match(new RegExp(`const ${constant[1]}\\s*(?::\\s*&(?:'static\\s+)?str)?\\s*=\\s*"([a-z][a-z0-9_]*)"`))?.[1];
      if (value) return add(value, where, path), true;
    }
    const note = annotation(text, line, lineOf(text, argAt));
    if (/\.code\(\)$/.test(arg)) {
      // A code() call gives the strings of its type's code(), so the type must be known and marked errors.
      const namedType = note?.match(/^type\s+(\w+)$/)?.[1];
      // A comment naming the type wins over what the collector infers, which a shadowed name can mislead.
      const type = namedType ?? receiverType(arg.slice(0, -".code()".length), context);
      if (!type) {
        if (note && !note.startsWith("type ") && !note.startsWith("from ")) return note.split(/[\s,]+/).filter(Boolean).forEach((code) => add(code, where, path)), true;
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
      if (!from) for (const code of note.split(/[\s,]+/).filter(Boolean)) add(code, where, path);
      return true;
    }
    const name = arg.match(/^(\w+)$/)?.[1];
    if (name) {
      const fn = fns.filter((f) => f.bodyOpen < index && f.bodyClose > index).at(-1);
      const param = fn?.params.indexOf(name) ?? -1;
      if (fn && param !== -1) {
        const k = `${path}#${fn.name}`;
        const self = lang === "rust" && fn.params[0] === "self";
        if (!constructors.has(k)) constructors.set(k, { name: lang === "ts" ? fn.short : fn.name, index: param, lang, visible: visibility(fn, path, lang), self });
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

  /** The regular expressions that find calls of a constructor, each with how far its arguments are shifted. */
  const callPatterns = ({ name, lang, self }) => {
    if (name.startsWith("new ")) return [[new RegExp(`${name.replace(" ", "\\s+")}\\s*\\(`, "g"), 0]];
    const short = name.split("::").at(-1);
    if (lang === "ts") return [[new RegExp(`(?<![\\w.:])${escape(short)}\\s*\\(`, "g"), 0]];
    if (name.includes("::")) {
      // A type's function: by its path or Self::, and a method also on any receiver, which takes the place of self.
      const [type] = name.split("::");
      const out = [[new RegExp(`\\b(?:${type}|Self)::${short}\\s*\\(`, "g"), 0]];
      if (self) out.push([new RegExp(`\\.\\s*${short}\\s*\\(`, "g"), -1]);
      return out;
    }
    // A free function: bare, or through a module path such as super::, crate::x:: or helpers::.
    return [[new RegExp(`(?<![\\w.:])(?:(?:crate|super|self|[a-z_][a-z0-9_]*)::)*${short}\\s*\\(`, "g"), 0]];
  };

  // Follows constructors to a fixed point: a wrapper found on one pass is a constructor on the next.
  for (let pass = 0, seen = -1; constructors.size !== seen && pass < 20; pass++) {
    seen = constructors.size;
    problems.splice(0, problems.length, ...problems.filter((p) => !/can't tell|error-codes:|is an error code|has no code\(\)|two types named/.test(p)));
    for (const surface of sitesBySurface.keys()) sitesBySurface.set(surface, 0);
    for (const [lang, files] of [["rust", sources.rust], ["ts", sources.gateway]]) {
      for (const { path, text } of files) {
        const fns = functions(text, lang);
        const context = { path, text, lang, fns, where: path };
        const surface = surfaceOf(path);
        const site = () => surface && sitesBySurface.set(surface, sitesBySurface.get(surface) + 1);
        // Calls of every constructor known so far.
        for (const constructor of constructors.values()) {
          if (constructor.lang !== lang || !constructor.visible(path)) continue;
          for (const [pattern, shift] of callPatterns(constructor)) {
            for (const call of text.matchAll(pattern)) {
              const before = text.slice(Math.max(0, call.index - 12), call.index);
              if (/fn\s+$|function\s+$|const\s+$/.test(before)) continue;
              const open = call.index + call[0].length - 1;
              const shut = closing(text, open);
              // A match arm's pattern names the variant without making one.
              if (lang === "rust" && /^\s*(=>|\|)/.test(text.slice(shut + 1))) continue;
              const arg = split(text.slice(open + 1, shut))[constructor.index + shift];
              if (arg === undefined) continue;
              site();
              resolve(arg, { ...context, index: call.index, argAt: text.indexOf(arg, open) });
            }
          }
        }
        // Struct literals and object literals that are errors themselves.
        const literals = lang === "rust"
          ? [/ApiError::(?:Api|Explained)\s*\{/g]
          : [/(?<![\w$])["']?error["']?\s*:\s*\{/g, /\b(?:const|let|var)\s+error\s*(?::[^=;{]+)?=\s*\{/g];
        for (const pattern of literals) {
          for (const found of text.matchAll(pattern)) {
            const open = found.index + found[0].length - 1;
            const close = closing(text, open);
            if (lang === "rust" && /^\s*(=>|\||\))/.test(text.slice(close + 1))) continue; // a pattern, not a value
            const fields = split(text.slice(open + 1, close));
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
      }
    }
  }
  // The API's own answer to an internal error, made in ApiError::status_and_code rather than by a constructor.
  add("internal_error", "apps/api/src/error.rs");
  const known = new Set([...sources.rust, ...sources.gateway].map(({ path }) => path));
  const missingSurfaces = Object.keys(excludedSurfaces).filter((surface) => ![...known].some((path) => (surface.endsWith("/") ? path.startsWith(surface) : path === surface)));
  return { codes, problems: [...new Set(problems)], excluded, excludedBySurface, sitesBySurface, missingSurfaces, markedStrings, constructors: [...constructors.values()].map((c) => c.name) };
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

/** The problems with an `Error.code` enum against what was collected: missing, unanswered, or wrongly internal. */
export function compareWithEnum(enumCodes, found, internalOnly) {
  const errorCodes = new Set(enumCodes);
  const problems = [];
  for (const [code, where] of found.codes) {
    if (!errorCodes.has(code) && !(code in internalOnly)) problems.push(`Error.code: missing ${code}, which ${where} answers`);
    if (errorCodes.has(code) && code in internalOnly) problems.push(`Error.code: lists ${code}, which only an internal route answers`);
  }
  for (const code of errorCodes) if (!found.codes.has(code)) problems.push(`Error.code: lists ${code}, which nothing in the API or the gateway answers`);
  for (const code of Object.keys(internalOnly)) if (!found.codes.has(code)) problems.push(`INTERNAL_ONLY: ${code} isn't answered anywhere any more, so take it off the list`);
  return problems;
}
