// The error codes Podster's API and gateway can answer, collected from their source text with no build step, so
// check.mjs can hold the contract's `Error.code` enum to exactly that set.
//
// What this covers: the REST error body, `{ "error": { "code": … } }`, and nothing else. Not OAuth's `error`, MCP or
// JSON-RPC errors, A2A's own errors, or a code built at run time (with `format!` or a template), which can't be read here.
//
// How every place that makes an error is seen:
//   - Roots. Rust: `ApiError::api(status, code)`, `ApiError::explained(status, code, …)` and the struct literals
//     `ApiError::Api { code, … }` and `ApiError::Explained { code, … }`. Gateway: `{ error: { code: … } }` and
//     `new AgentRefused(code)`.
//   - The code argument at each one must resolve to a string literal; a constant of the same file; a `.code()` call
//     (whose strings come from the `code()` methods marked `// codes: errors`; on `Type::Variant.code()` or
//     `Type.code()` the type's own marker must be `errors`); a parameter of the function it's in, which makes that
//     function a constructor too, followed to its own callers; a name bound by a match arm `A::B(…, code, …) =>`, which
//     makes `A::B` a constructor too; or a comment on that line or the one above naming its codes,
//     `// error-codes: a, b`, or where they come from, `// error-codes: from <constructor>`.
//   - Anything else is a problem, and check.mjs fails: a site is either seen or loudly unseen, never silently missed.
//   - Every `fn code(` in any form must be marked `// codes: errors` (a string it returns can reach a caller as
//     `error.code`) or `// codes: reasons` (it can't: it's data, such as a reason or an outcome).
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
    const params = split(text.slice(open + 1, close)).map((p) => p.replace(/^(?:&|mut\s+|\.\.\.)/, "").match(/^(\w+)/)?.[1]).filter(Boolean);
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

/** The comment's codes for the call on `line`: `// error-codes: a, b` or `// error-codes: from X`. */
function annotation(text, line) {
  const lines = text.split("\n");
  for (const candidate of [lines[line - 1], lines[line - 2]]) {
    const found = candidate?.match(/\/\/\s*error-codes:\s*(.+)$/);
    if (found) return found[1].trim();
  }
  return null;
}

/**
 * `{ codes: Map<code, where>, problems: string[], excluded: Map<code, where> }` from `sources` (see readSources).
 * `excludedSurfaces` names gateway files, or folders ending in "/", whose answers aren't the contract's (see check.mjs);
 * their codes are reported apart and never required.
 */
export function collectErrorCodes(sources, excludedSurfaces = {}) {
  const codes = new Map();
  const excluded = new Map();
  const problems = [];
  const markers = new Map();
  const markedStrings = new Map();
  const isExcluded = (path) => Object.keys(excludedSurfaces).some((surface) => (surface.endsWith("/") ? path.startsWith(surface) : path === surface));
  const add = (code, where, path) => {
    const into = path && isExcluded(path) ? excluded : codes;
    if (!into.has(code)) into.set(code, where);
  };

  // The code() methods: each marked, and the strings of those marked `errors`.
  for (const { path, text } of sources.rust) {
    for (const found of text.matchAll(/\bfn\s+code\s*\(/g)) {
      const line = lineOf(text, found.index);
      const marker = text.split("\n").slice(Math.max(0, line - 12), line - 1).reverse().find((l) => /\/\/ codes: /.test(l))?.match(/\/\/ codes: (\w+)/)?.[1];
      const owner = functions(text, "rust").find((f) => f.start <= found.index && f.bodyOpen > found.index)?.name.split("::")[0];
      if (!["errors", "reasons"].includes(marker)) {
        problems.push(`${path}:${line}: a code() method needs "// codes: errors" or "// codes: reasons" above it`);
        continue;
      }
      markers.set(owner, marker);
      if (marker !== "errors") continue;
      const fn = functions(text, "rust").find((f) => f.start <= found.index && f.bodyOpen > found.index);
      for (const literal of text.slice(fn.bodyOpen, fn.bodyClose).matchAll(/"([a-z_]+)"/g)) {
        add(literal[1], `${path}:${line}`);
        markedStrings.set(literal[1], `${path}:${line}`);
      }
    }
  }

  // Constructors: name → { index (or "field" for a struct literal), scope (a path, or null for everywhere) }.
  const constructors = new Map([
    ["ApiError::api", { index: 1, scope: null }],
    ["ApiError::explained", { index: 1, scope: null }],
    ["new AgentRefused", { index: 0, scope: null }],
  ]);
  const key = (name, path, scope) => (scope ? `${path}#${name}` : name);
  const lookup = (name, path) => constructors.get(`${path}#${name}`) ?? constructors.get(name);

  /** Resolves one code argument found at `index` of `text`. Answers true when it's accounted for. */
  const resolve = (arg, { path, text, index, lang, fns, where }) => {
    const line = lineOf(text, index);
    // A number is a JSON-RPC error's code, another shape than the REST body this covers.
    if (/^-?\d+$/.test(arg)) return true;
    const literal = arg.match(/^"([a-z_]+)"$/) ?? arg.match(/^'([a-z_]+)'$/);
    if (literal) return add(literal[1], where, path), true;
    const constant = arg.match(/^([A-Z][A-Z0-9_]*)$/);
    if (constant) {
      const value = text.match(new RegExp(`const ${constant[1]}\\s*(?::\\s*&(?:'static\\s+)?str)?\\s*=\\s*"([a-z_]+)"`))?.[1];
      if (value) return add(value, where, path), true;
    }
    if (/\.code\(\)$/.test(arg)) {
      const typed = arg.match(/^(\w+)(?:::\w+)?(?:\([^)]*\))?\.code\(\)$/);
      if (typed && /^[A-Z]/.test(typed[1]) && markers.has(typed[1]) && markers.get(typed[1]) !== "errors") {
        problems.push(`${path}:${line}: ${arg} is an error code, but ${typed[1]}::code() is marked reasons`);
      }
      return true;
    }
    const note = annotation(text, line);
    if (note) {
      const from = note.match(/^from\s+(.+?)\s*$/);
      if (from && !lookup(from[1], path) && from[1] !== "the API") problems.push(`${path}:${line}: "// error-codes: ${note}" names ${from[1]}, which isn't a constructor the collector knows`);
      if (!from) for (const code of note.split(/[\s,]+/).filter(Boolean)) add(code, where, path);
      return true;
    }
    const name = arg.match(/^(\w+)$/)?.[1];
    if (name) {
      const fn = fns.filter((f) => f.bodyOpen < index && f.bodyClose > index).at(-1);
      const param = fn?.params.indexOf(name) ?? -1;
      if (fn && param !== -1) {
        const scope = fn.exported ? null : path;
        const k = key(lang === "ts" ? fn.short : fn.name, path, scope);
        if (!constructors.has(k)) constructors.set(k, { index: param, scope, from: where });
        return true;
      }
      const arm = text.slice(fn?.bodyOpen ?? 0, index).match(new RegExp(`(\\w+::\\w+)\\(([^()]*\\b${name}\\b[^()]*)\\)\\s*=>[^=>]*$`));
      if (arm) {
        const at = split(arm[2]).indexOf(name);
        if (!constructors.has(arm[1])) constructors.set(arm[1], { index: at, scope: null, from: where });
        return true;
      }
    }
    if (!isExcluded(path)) problems.push(`${path}:${line}: can't tell the error code ${arg} here; write a literal or a same-file constant, or name its codes in a "// error-codes:" comment`);
    return false;
  };

  // Follows constructors to a fixed point: a wrapper found on one pass is a constructor on the next.
  for (let pass = 0, seen = -1; constructors.size !== seen && pass < 20; pass++) {
    seen = constructors.size;
    problems.splice(0, problems.length, ...problems.filter((p) => !p.includes("can't tell the error code")));
    for (const [lang, files] of [["rust", sources.rust], ["ts", sources.gateway]]) {
      for (const { path, text } of files) {
        const fns = functions(text, lang);
        const where = path;
        const context = { path, text, lang, fns, where };
        // Calls of every constructor known so far.
        for (const [k, { index, scope }] of constructors) {
          if (scope && scope !== path) continue;
          const name = k.includes("#") ? k.split("#")[1] : k;
          const short = name.startsWith("new ") ? name : name.split("::").at(-1);
          const qualified = name.startsWith("new ") ? name.replace(" ", "\\s+") : name.includes("::") ? `(?:${name.replace("::", "::")}|Self::${short})` : `(?<![\\w.:])${short}`;
          for (const call of text.matchAll(new RegExp(`${qualified}\\s*\\(`, "g"))) {
            const before = text.slice(Math.max(0, call.index - 12), call.index);
            if (/fn\s+$|function\s+$|const\s+$/.test(before)) continue;
            const open = call.index + call[0].length - 1;
            const shut = closing(text, open);
            // A match arm's pattern names the variant without making one.
            if (lang === "rust" && /^\s*(=>|\|)/.test(text.slice(shut + 1))) continue;
            const args = split(text.slice(open + 1, shut));
            if (args[index] !== undefined) resolve(args[index], { ...context, index: call.index });
          }
        }
        // Struct literals and object literals that are errors themselves.
        const literals = lang === "rust" ? /ApiError::(?:Api|Explained)\s*\{/g : /\berror\s*:\s*\{\s*code\s*[:,}]/g;
        for (const found of text.matchAll(literals)) {
          const open = text.indexOf("{", found.index + (lang === "rust" ? 0 : found[0].indexOf("{")));
          const close = closing(text, open);
          if (lang === "rust" && /^\s*(=>|\||\))/.test(text.slice(close + 1))) continue; // a pattern, not a value
          const field = split(text.slice(open + 1, close)).find((f) => /^code\b/.test(f));
          if (!field) continue;
          resolve(field.includes(":") ? field.slice(field.indexOf(":") + 1).trim() : "code", { ...context, index: found.index });
        }
      }
    }
  }
  // The API's own answer to an internal error, made in ApiError::status_and_code rather than by a constructor.
  add("internal_error", "apps/api/src/error.rs");
  return { codes, problems: [...new Set(problems)], excluded, markedStrings, constructors: [...constructors.keys()] };
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
