// The no-log check's self-test (M8 step 7): each kind of log line, planted, fails; comments and near misses don't.
import assert from "node:assert/strict";
import { logLines, previewAccessLogProblems, rustFunction } from "./no-log.mjs";

const cases = [];
const it = (name, fn) => cases.push([name, fn]);

for (const planted of ['console_log!("{}", id);', 'worker::console_error!("x");', "console_warn!(\"x\");", 'println!("{}", ticket);', 'eprintln!("x");', 'print!("x");', "dbg!(&key);", 'tracing::info!("x");', "use tracing::info;", 'info!("x");', 'log::warn!("x");', 'warn!("x");']) {
  it(`Rust: ${planted} fails`, () => assert.deepEqual(logLines(`fn f() {\n    ${planted}\n}\n`, true), [2]));
}
for (const planted of ["console.log(x);", 'console["log"](x);', "console?.error(x);", "globalThis.console.info(x);", "const say = console;", "const { log } = console;"]) {
  it(`TypeScript: ${planted} fails`, () => assert.deepEqual(logLines(`const a = 1;\n${planted}\n`, false), [2]));
}
it("a log call in a comment doesn't count", () => {
  assert.deepEqual(logLines("// console_log!(\"x\");\n/* println!(\"x\") */\nfn f() {}\n", true), []);
  assert.deepEqual(logLines("// console.log(x)\n/* console.error */\nconst a = 1;\n", false), []);
});
it("near misses don't count", () => assert.deepEqual(logLines("let catalog = 1;\nfn login() {}\nlet blog::x = 2;\nwarning_count += 1;\n", true), []));
it("finds the Rust function by name, to its closing brace", () => {
  const source = "fn other() { console_log!(\"x\"); }\nasync fn preview_access(&self) -> R<Value> {\n    if a { b() }\n    Ok(c)\n}\nfn after() {}\n";
  assert.equal(rustFunction(source, "preview_access"), "fn preview_access(&self) -> R<Value> {\n    if a { b() }\n    Ok(c)\n}");
  assert.equal(rustFunction(source, "missing"), null);
});
it("the repository's access path: clean files pass, a planted line in each file and in the room's handler fails", () => {
  const clean = { "apps/api/src/workspace.rs": "fn x() {}\nasync fn preview_access(&self) {\n    ok();\n}\n" };
  const read = (files) => (path) => files[path] ?? "fn clean() {}\nconst a = 1;\n";
  assert.deepEqual(previewAccessLogProblems(read(clean)), []);
  for (const file of ["apps/api/src/preview_access.rs", "apps/api/src/workspace/preview_access.rs", "crates/egress/src/preview_key.rs"]) {
    assert.equal(previewAccessLogProblems(read({ ...clean, [file]: 'fn f() { println!("x"); }' })).length, 1, file);
  }
  for (const file of ["apps/web/lib/preview-access.ts", "apps/web/app/preview-access/route.ts"]) {
    assert.equal(previewAccessLogProblems(read({ ...clean, [file]: 'console["log"](1);' })).length, 1, file);
  }
  const dirty = { "apps/api/src/workspace.rs": "fn x() { console_log!(\"elsewhere\"); }\nasync fn preview_access(&self) {\n    console_log!(\"{}\", st);\n}\n" };
  assert.deepEqual(previewAccessLogProblems(read(dirty)), ["apps/api/src/workspace.rs, fn preview_access, line 2 of it: the preview access path must log nothing"]);
  assert.equal(previewAccessLogProblems(read({ "apps/api/src/workspace.rs": "fn x() {}" })).length, 1, "a handler that can't be found is a problem");
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${error.message}`);
  }
}
if (failed) {
  console.log(`no-log selftest: ${failed} failed`);
  process.exit(1);
}
console.log("no-log selftest passed");
