// Shows error-codes.mjs sees every way a code is made, and says so when it can't, on small sources held in memory.
//
//   node error-codes.test.mjs
import assert from "node:assert/strict";
import { collectErrorCodes, compareWithEnum } from "./error-codes.mjs";

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
};
const rust = (text, path = "apps/api/src/x.rs") => ({ rust: [{ path, text }], gateway: [] });
const gateway = (text, path = "apps/gateway/src/x.ts") => ({ rust: [], gateway: [{ path, text }] });
const codes = (found) => [...found.codes.keys()].filter((code) => code !== "internal_error").sort();

check("a literal code is collected", () => {
  assert.deepEqual(codes(collectErrorCodes(rust(`fn f() -> R<()> { Err(ApiError::api(409, "brand_new")) }`))), ["brand_new"]);
});

check("a same-file constant is followed, a non-numeric status doesn't hide the code", () => {
  const found = collectErrorCodes(rust(`const GONE: &str = "gone_here";\nfn f(s: u16) -> ApiError { ApiError::api(s, GONE) }`));
  assert.deepEqual(codes(found), ["gone_here"]);
  assert.deepEqual(found.problems, []);
});

check("a code it can't read is a problem, never silently missed", () => {
  for (const arg of ["code", "other::GONE", "format!(\"x_{}\", n)", "row.code"]) {
    const found = collectErrorCodes(rust(`fn f(n: u8) -> ApiError { let code = pick(); ApiError::api(403, ${arg}) }`));
    assert.equal(found.problems.length, 1, arg);
    assert.match(found.problems[0], /can't tell the error code/, arg);
  }
});

check("a comment names codes the collector can't read", () => {
  const found = collectErrorCodes(rust(`fn f() -> ApiError {\n    let code = pick();\n    // error-codes: picked_one, picked_two\n    ApiError::api(403, code)\n}`));
  assert.deepEqual(found.problems, []);
  assert.deepEqual(codes(found), ["picked_one", "picked_two"]);
});

check("a wrapper becomes a constructor, and its callers' codes are collected", () => {
  const found = collectErrorCodes(rust(`fn refuse(status: u16, code: &'static str) -> ApiError { ApiError::api(status, code) }\nfn g() -> ApiError { refuse(409, "wrapped_code") }`));
  assert.deepEqual(codes(found), ["wrapped_code"]);
  assert.deepEqual(found.problems, []);
});

check("a code carried through a match arm is followed to where the variant is made", () => {
  const found = collectErrorCodes(rust(`enum Outcome { Refused(u16, &'static str) }\nfn a() -> Outcome { Outcome::Refused(429, "carried_code") }\nfn b(o: Outcome) -> ApiError { match o { Outcome::Refused(status, code) => ApiError::api(status, code) } }`));
  assert.deepEqual(codes(found), ["carried_code"]);
  assert.deepEqual(found.problems, []);
});

check("a struct literal is a constructor, and a match pattern isn't", () => {
  const made = collectErrorCodes(rust(`fn f() -> ApiError { ApiError::Api { status: 400, code: "literal_struct" } }`));
  assert.deepEqual(codes(made), ["literal_struct"]);
  const pattern = collectErrorCodes(rust(`fn f(e: &ApiError) -> bool { match e { ApiError::Api { code, .. } => true, _ => false } }`));
  assert.deepEqual(pattern.problems, []);
});

check("every fn code( must be marked, in any form", () => {
  for (const sig of ["pub fn code(self)", "pub const fn code(self)", "pub(crate) fn code(self)", "fn code(&self)"]) {
    const found = collectErrorCodes(rust(`enum E { A }\nimpl E {\n    ${sig} -> &'static str {\n        match self { E::A => "unmarked_code" }\n    }\n}`));
    assert.equal(found.problems.length, 1, sig);
    assert.match(found.problems[0], /needs "\/\/ codes: errors" or "\/\/ codes: reasons"/, sig);
  }
});

check("a code() marked errors gives its strings, one marked reasons doesn't", () => {
  const errors = collectErrorCodes(rust(`enum E { A }\nimpl E {\n    // codes: errors\n    pub const fn code(self) -> &'static str {\n        match self { E::A => "from_marked" }\n    }\n}`));
  assert.deepEqual(codes(errors), ["from_marked"]);
  const reasons = collectErrorCodes(rust(`enum E { A }\nimpl E {\n    // codes: reasons\n    pub fn code(self) -> &'static str {\n        match self { E::A => "a_reason" }\n    }\n}`));
  assert.deepEqual(codes(reasons), []);
});

check("a reasons code() passed as an error code is a problem", () => {
  const found = collectErrorCodes(rust(`enum Why { A }\nimpl Why {\n    // codes: reasons\n    pub fn code(self) -> &'static str { "a_reason" }\n}\nfn f() -> ApiError { ApiError::api(409, Why::A.code()) }`));
  assert.match(found.problems.join("\n"), /marked reasons/);
});

check("gateway: denied, AgentRefused, error objects and helper wrappers are collected", () => {
  const found = collectErrorCodes(gateway([
    `export const denied = (code: string, status: number) => json({ error: { code, message: code } }, status);`,
    `function answer(code: string, status = 400) { return new Response(JSON.stringify({ error: { code, message: code } }), { status }); }`,
    `export function a() { return denied("denied_code", 403); }`,
    `export function b() { return answer("helper_code"); }`,
    `export function c() { throw new AgentRefused("refused_code"); }`,
    `export function d() { return json({ error: { code: "object_code", message: "x" } }); }`,
  ].join("\n")));
  assert.deepEqual(codes(found), ["denied_code", "helper_code", "object_code", "refused_code"]);
  assert.deepEqual(found.problems, []);
});

check("gateway: a variable code is a problem, unless a comment says where it comes from", () => {
  const unseen = collectErrorCodes(gateway(`export const denied = (code: string, status: number) => json({ error: { code, message: code } }, status);\nexport function a(e: Error) { return denied(e.message, 403); }`));
  assert.match(unseen.problems.join("\n"), /can't tell the error code e.message/);
  const named = collectErrorCodes(gateway(`export const denied = (code: string, status: number) => json({ error: { code, message: code } }, status);\nexport function a(e: Error) {\n  // error-codes: from denied\n  return denied(e.message, 403);\n}`));
  assert.deepEqual(named.problems, []);
});

check("an excluded surface's codes are listed apart, and its problems aren't raised", () => {
  const found = collectErrorCodes(gateway(`function refuse(code: string) { return json({ error: { code } }, 400); }\nexport function a() { return refuse("webhook_only"); }`, "apps/gateway/src/hook.ts"), { "apps/gateway/src/hook.ts": "another surface" });
  assert.deepEqual(codes(found), []);
  assert.deepEqual([...found.excluded.keys()], ["webhook_only"]);
});

check("the enum must equal what's collected: missing, unanswered and wrongly internal codes are each named", () => {
  const found = collectErrorCodes(rust(`fn f() -> ApiError { ApiError::api(409, "answered") }\nfn g() -> ApiError { ApiError::api(409, "internal_one") }`));
  const problems = compareWithEnum(["internal_error", "listed_but_unanswered", "internal_one"], found, { internal_one: "why", gone_internal: "why" });
  assert.deepEqual(problems.sort(), [
    "Error.code: lists internal_one, which only an internal route answers",
    "Error.code: lists listed_but_unanswered, which nothing in the API or the gateway answers",
    "Error.code: missing answered, which apps/api/src/x.rs answers",
    "INTERNAL_ONLY: gone_internal isn't answered anywhere any more, so take it off the list",
  ]);
});

console.log(failed ? `${failed} failed` : "error-codes selftest passed");
process.exit(failed ? 1 : 0);
