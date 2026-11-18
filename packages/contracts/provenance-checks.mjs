// M7 step 4's guards on a task's provenance (decision 228; the architect's rulings F5 and F6 on #443's reviews), checked by
// check.mjs and self-tested by provenance-checks.test.mjs:
//
// - no command's request may name a provenance or an author, however deep its schema puts the name;
// - only the room's recorded command paths write a task's prompt text, and only the provenance module writes its record.

/** The names a request carries: every property name in its body's schema, followed through `$ref`, `allOf`, `oneOf`,
 * `anyOf`, `items` and `additionalProperties`, and every parameter's name, the path's own included. */
export function requestNames(api, path, method) {
  const names = new Set();
  const seen = new Set();
  const resolve = (node) => {
    while (node?.$ref) {
      if (seen.has(node.$ref)) return null;
      seen.add(node.$ref);
      const parts = node.$ref.replace(/^#\//, "").split("/");
      node = parts.reduce((at, part) => at?.[part], api);
    }
    return node;
  };
  const walk = (node) => {
    node = resolve(node);
    if (!node || typeof node !== "object") return;
    for (const name of Object.keys(node.properties ?? {})) names.add(name);
    for (const child of Object.values(node.properties ?? {})) walk(child);
    for (const key of ["allOf", "oneOf", "anyOf"]) for (const child of node[key] ?? []) walk(child);
    walk(node.items);
    if (typeof node.additionalProperties === "object") walk(node.additionalProperties);
  };
  const item = api.paths?.[path] ?? {};
  const op = item[method] ?? {};
  for (const content of Object.values(resolve(op.requestBody)?.content ?? {})) walk(content.schema);
  for (const parameter of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const found = resolve(parameter);
    if (found?.name) names.add(found.name);
  }
  return names;
}

/** The names no command may take: a provenance is the room's record, never a client's (decision 228). */
export const PROVENANCE_NAMES = ["provenance", "author", "author_id", "author_org", "authors", "from", "external"];

/** Each command whose request names one of `PROVENANCE_NAMES`. A query reads only, so its filters, such as the handoffs
 * read's `from`, can't write one, and only commands are held to this. */
export function provenanceInRequests(api) {
  const problems = [];
  for (const [path, item] of Object.entries(api.paths ?? {})) {
    for (const method of ["post", "put", "patch", "delete"]) {
      if (!item[method]) continue;
      const named = [...requestNames(api, path, method)].filter((name) => PROVENANCE_NAMES.includes(name));
      if (named.length) problems.push(`${item[method].operationId}: no request may name ${named.join(", ")}`);
    }
  }
  return problems;
}

const TEXT_COLUMNS = /\b(title|instructions|acceptance_criteria)\b/;
const PROVENANCE_TABLE = /\b(task_input_author|task_input_text|task_requester_org)\b/;
// Every SQL form that writes rows of `task`: INSERT, INSERT OR …, REPLACE, UPDATE and UPDATE OR ….
const TASK_WRITE = /\b(INSERT( OR \w+)? INTO|REPLACE INTO|UPDATE( OR \w+)?) task\b(?!_)/i;

/** The name of the function a position in Rust source is in: the last `fn name` before it. */
const enclosing = (text, at) => [...text.slice(0, at).matchAll(/\bfn (\w+)/g)].at(-1)?.[1];

/**
 * Every string literal in Rust source, as `{ at, text }` with its whitespace collapsed, so a statement split over lines
 * reads whole. Comments, char literals and raw strings are told apart from strings, so a quote in a comment or a `'"'`
 * can't pair with another.
 */
export function rustLiterals(source) {
  const found = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    const raw = (c === "r" || c === "b") && !/\w/.test(source[i - 1] ?? "") ? source.slice(i, i + 40).match(/^b?r(#*)"/) : null;
    if (raw) {
      const close = `"${raw[1]}`;
      const end = source.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? source.length : end;
      found.push({ at: i, text: source.slice(i + raw[0].length, stop).replace(/\s+/g, " ") });
      i = stop + close.length;
      continue;
    }
    if (c === "'") {
      const char = source.slice(i, i + 12).match(/^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'\n])'/);
      i += char ? char[0].length : 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      found.push({ at: i, text: source.slice(i + 1, j).replace(/\\\n\s*/g, "").replace(/\\n/g, " ").replace(/\s+/g, " ") });
      i = j + 1;
      continue;
    }
    i++;
  }
  return found;
}

/** Whether a task write's literal names its own columns, or is a piece of SQL built with `format!` or concatenation. */
const builtFromPieces = (statement) =>
  statement.includes("{") || /\bSET\s*$/i.test(statement) || (/\bSET\b/i.test(statement) && !/\bSET\s+\w+\s*=/i.test(statement)) || (/\bINTO task\b/i.test(statement) && !/\bINTO task\s*\([^)]*\)/i.test(statement));

/**
 * Where a task's prompt text is written, and where its provenance is recorded. `files` is `[{ path, text }]` of the API's
 * Rust sources, paths relative to the repository. Each string literal is read whole, across lines (G4). The text
 * columns are written, by any of INSERT, INSERT OR REPLACE, REPLACE or UPDATE, only by `store.rs`'s `insert_task` and
 * `save_task`; `insert_task` is called only by `handle_create_task`; that function and `handle_task_command_with`, the
 * only path that decides an update, each record the provenance; and only `workspace/provenance.rs` names its tables,
 * apart from their migration, so no SQL built with `format!` or concatenation elsewhere reaches them. A task write elsewhere
 * built from pieces is refused, since what it writes can't be read. `save_task` is called from other paths too, which change no prompt text; were one to, the
 * text's hash no longer matches and the input reads as unknown, so this guard and that one back each other up.
 */
export function promptWrites(files) {
  const problems = [];
  for (const { path, text } of files) {
    const migrationsEnd = path === "apps/api/src/store.rs" ? text.indexOf('"];') : -1;
    for (const { at, text: statement } of rustLiterals(text)) {
      const fn = enclosing(text, at);
      const inMigrations = migrationsEnd >= 0 && at < migrationsEnd;
      // A provenance table is named only by its module and its migration: no other SQL, whole or in pieces, reaches it.
      if (PROVENANCE_TABLE.test(statement) && path !== "apps/api/src/workspace/provenance.rs" && !inMigrations) problems.push(`${path}: ${fn ?? "?"} names a task's provenance table; only workspace/provenance.rs may`);
      if (!TASK_WRITE.test(statement)) continue;
      const allowed = path === "apps/api/src/store.rs" && ["insert_task", "save_task"].includes(fn);
      if (allowed) continue;
      if (TEXT_COLUMNS.test(statement)) problems.push(`${path}: ${fn ?? "?"} writes a task's prompt text outside store.rs's insert_task and save_task`);
      else if (builtFromPieces(statement)) problems.push(`${path}: ${fn ?? "?"} writes a task with SQL built from pieces, which this check can't read`);
    }
    for (const found of text.matchAll(/\binsert_task\(/g)) {
      // Its own definition isn't a call.
      if (text.slice(Math.max(0, found.index - 3), found.index) === "fn ") continue;
      const fn = enclosing(text, found.index);
      if (path !== "apps/api/src/workspace.rs" || fn !== "handle_create_task") problems.push(`${path}: ${fn ?? "?"} creates a task outside handle_create_task`);
    }
  }
  const workspace = files.find((f) => f.path === "apps/api/src/workspace.rs")?.text ?? "";
  for (const fn of ["handle_create_task", "handle_task_command_with"]) {
    const start = workspace.search(new RegExp(`\\bfn ${fn}\\(`));
    const body = start < 0 ? "" : workspace.slice(start, workspace.indexOf("\n}\n", start));
    if (!/provenance::record\(/.test(body)) problems.push(`workspace.rs: ${fn} must record the task's provenance`);
  }
  return problems;
}
