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
const PROVENANCE_TABLES = /\b(INSERT|UPDATE|REPLACE|DELETE)\b[^"]*\b(task_input_author|task_input_text|task_requester_org)\b/;
const TASK_WRITE = /\b(INSERT INTO task \(|UPDATE task SET)[^"]*/g;

/** The name of the function a position in Rust source is in: the last `fn name` before it. */
const enclosing = (text, at) => [...text.slice(0, at).matchAll(/\bfn (\w+)/g)].at(-1)?.[1];

/**
 * Where a task's prompt text is written, and where its provenance is recorded. `files` is `[{ path, text }]` of the API's
 * Rust sources, paths relative to the repository. The text columns are written only by `store.rs`'s `insert_task` and
 * `save_task`; `insert_task` is called only by `handle_create_task`; that function and `handle_task_command_with`, the
 * only path that decides an update, each record the provenance; and only `workspace/provenance.rs` writes its tables,
 * apart from their migration. `save_task` is called from other paths too, which change no prompt text; were one to, the
 * text's hash no longer matches and the input reads as unknown, so this guard and that one back each other up.
 */
export function promptWrites(files) {
  const problems = [];
  for (const { path, text } of files) {
    const migrationsEnd = path === "apps/api/src/store.rs" ? text.indexOf('"];') : -1;
    for (const found of text.matchAll(TASK_WRITE)) {
      if (!TEXT_COLUMNS.test(found[0])) continue;
      const fn = enclosing(text, found.index);
      if (path !== "apps/api/src/store.rs" || !["insert_task", "save_task"].includes(fn)) problems.push(`${path}: ${fn ?? "?"} writes a task's prompt text outside store.rs's insert_task and save_task`);
    }
    for (const line of text.split("\n").map((l, n) => [l, n])) {
      if (!PROVENANCE_TABLES.test(line[0])) continue;
      const at = text.split("\n").slice(0, line[1]).join("\n").length;
      if (path === "apps/api/src/workspace/provenance.rs" || (migrationsEnd >= 0 && at < migrationsEnd)) continue;
      problems.push(`${path}:${line[1] + 1}: only workspace/provenance.rs writes a task's provenance`);
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
