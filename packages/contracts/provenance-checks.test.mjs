// The provenance guards, checked on inputs of their own: each must find a name or a write however it is hidden, and pass
// what is allowed, so "no problems" in check.mjs means something.
import { promptWrites, provenanceInRequests, requestNames } from "./provenance-checks.mjs";

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const api = (schema, extra = {}) => ({
  paths: { "/v1/x": { post: { operationId: "makeX", requestBody: { content: { "application/json": { schema } } }, ...extra } } },
  components: {
    schemas: {
      Inner: { type: "object", properties: { author_org: { type: "string" } } },
      Outer: { type: "object", properties: { nested: { $ref: "#/components/schemas/Inner" } } },
      Loop: { type: "object", properties: { self: { $ref: "#/components/schemas/Loop" } } },
    },
    parameters: { who: { name: "author", in: "query", schema: { type: "string" } } },
  },
});
check(requestNames(api({ $ref: "#/components/schemas/Outer" }), "/v1/x", "post").has("author_org"), "a name nested behind two $refs is found");
check(requestNames(api({ allOf: [{ type: "object" }, { $ref: "#/components/schemas/Inner" }] }), "/v1/x", "post").has("author_org"), "a name inside allOf is found");
check(requestNames(api({ oneOf: [{ properties: { authors: { type: "array", items: { properties: { from: {} } } } } }] }), "/v1/x", "post").has("from"), "a name inside oneOf and an array's items is found");
check(requestNames(api({ anyOf: [{ additionalProperties: { properties: { external: {} } } }] }), "/v1/x", "post").has("external"), "a name inside anyOf and additionalProperties is found");
check(requestNames(api({ $ref: "#/components/schemas/Loop" }), "/v1/x", "post").has("self"), "a schema that refers to itself ends");
check(requestNames(api({ type: "object" }, { parameters: [{ $ref: "#/components/parameters/who" }] }), "/v1/x", "post").has("author"), "a parameter, by $ref, is found");
check(provenanceInRequests(api({ $ref: "#/components/schemas/Outer" })).join() === "makeX: no request may name author_org", "a command naming one is refused, by name");
check(provenanceInRequests(api({ properties: { title: {} } })).length === 0, "a command naming none passes");
const query = { paths: { "/v1/h": { parameters: [{ name: "from", in: "query" }], get: { operationId: "listH" } } }, components: {} };
check(provenanceInRequests(query).length === 0, "a query's filter isn't a request that writes");

const store = (body) => ({ path: "apps/api/src/store.rs", text: `const MIGRATIONS: &[&str] = &["\nCREATE TABLE task_input_author (x);\nINSERT INTO task_input_text (x) VALUES (1);\n"];\n${body}` });
const workspace = (create, command) => ({ path: "apps/api/src/workspace.rs", text: `fn handle_task_command_with() {\n    ${command}\n}\nfn handle_create_task() {\n    store::insert_task(sql);\n    ${create}\n}\n` });
const good = [
  store(`pub fn insert_task() {\n    exec(sql, "INSERT INTO task (id, title, instructions) VALUES (?)");\n}\npub fn save_task() {\n    exec(sql, "UPDATE task SET title = ?, instructions = ? WHERE id = ?");\n}\n`),
  workspace("provenance::record(sql);", "provenance::record(sql);"),
  { path: "apps/api/src/workspace/provenance.rs", text: `fn record() {\n    exec(sql, "INSERT INTO task_input_author (x) VALUES (?)");\n}\n` },
  { path: "apps/api/src/workspace/plan.rs", text: `fn plan() {\n    exec(sql, "UPDATE task SET duration_days = ? WHERE id = ?");\n}\n` },
];
check(promptWrites(good).length === 0, "the recorded paths, and a write of other columns, pass");
check(promptWrites([...good, { path: "apps/api/src/workspace/x.rs", text: `fn sneak() {\n    exec(sql, "UPDATE task SET instructions = ? WHERE id = ?");\n}\n` }]).some((p) => p.includes("sneak")), "prompt text written anywhere else is found");
check(promptWrites([...good, { path: "apps/api/src/workspace/x.rs", text: `fn sneak() {\n    exec(sql, "DELETE FROM task_input_author WHERE task_id = ?");\n}\n` }]).some((p) => p.includes("x.rs")), "a provenance table written outside its module is found");
check(promptWrites([...good, { path: "apps/api/src/workspace/x.rs", text: `fn sneak() {\n    store::insert_task(sql);\n}\n` }]).some((p) => p.includes("sneak")), "a task created outside handle_create_task is found");
check(promptWrites([good[0], workspace("", "provenance::record(sql);"), good[2]]).some((p) => p.includes("handle_create_task")), "a create path that records no provenance is found");
check(promptWrites([good[0], workspace("provenance::record(sql);", ""), good[2]]).some((p) => p.includes("handle_task_command_with")), "a command path that records no provenance is found");

// G4: whole statements, every write form, and SQL built from pieces.
const sneaks = {
  "a prompt column on a later line of a multi-line statement": `fn sneak() {\n    exec(sql, "UPDATE task\n      SET due_at = ?,\n          instructions = ? WHERE id = ?");\n}\n`,
  "INSERT OR REPLACE INTO task": `fn sneak() {\n    exec(sql, "INSERT OR REPLACE INTO task (id, title) VALUES (?, ?)");\n}\n`,
  "REPLACE INTO task": `fn sneak() {\n    exec(sql, "REPLACE INTO task (id, acceptance_criteria) VALUES (?, ?)");\n}\n`,
  "UPDATE OR REPLACE task": `fn sneak() {\n    exec(sql, "UPDATE OR REPLACE task SET title = ? WHERE id = ?");\n}\n`,
  "a task write whose columns are built with format!": `fn sneak() {\n    exec(sql, &format!("UPDATE task SET {} = ? WHERE id = ?", col));\n}\n`,
  "a task write whose columns are concatenated": `fn sneak() {\n    exec(sql, &("UPDATE task SET ".to_string() + col + " = ?"));\n}\n`,
  "INSERT OR REPLACE INTO a provenance table": `fn sneak() {\n    exec(sql, "INSERT OR REPLACE INTO task_input_text (task_id) VALUES (?)");\n}\n`,
  "an UPDATE of a provenance table across lines": `fn sneak() {\n    exec(sql, "UPDATE\n  task_requester_org SET org = NULL");\n}\n`,
  "a provenance table named in format!": `fn sneak() {\n    exec(sql, &format!("DELETE FROM {} WHERE task_id = ?", "task_input_author"));\n}\n`,
  "a provenance table named in a concatenation": `fn sneak() {\n    exec(sql, &("UPDATE ".to_string() + "task_input_text" + " SET written_at = 0"));\n}\n`,
};
for (const [what, text] of Object.entries(sneaks)) {
  check(promptWrites([...good, { path: "apps/api/src/workspace/x.rs", text }]).length > 0, `${what} is found`);
}
check(promptWrites([...good, { path: "apps/api/src/workspace/x.rs", text: `fn fine() {\n    exec(sql, "UPDATE task\n      SET duration_days = ? WHERE id = ?");\n}\n` }]).length === 0, "a multi-line write of other columns passes");

if (failed) { console.error(`provenance-checks selftest: ${failed} failed`); process.exit(1); }
console.log("provenance-checks selftest passed");
