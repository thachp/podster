// Spike P1's offline checks: the stand-in gate's pure pieces do what the plan says, so a browser result can be read
// as the browser's and not the harness's. `node --test spikes/m8-preview-access/spike.test.mjs`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ENTER_CSP, ENTER_SCRIPT, SESSION, STATE, check, cookiePairs, gateCookies, newState, previewPolicy, productionPolicy, sameHostPath, sign, stateHash } from "./pure.mjs";

test("the gate reads exactly its two names and refuses duplicates, case variants and nameless pairs", () => {
  assert.deepEqual(gateCookies(`${SESSION}=s; ${STATE}=t; other=1`), { ok: true, session: "s", state: "t" });
  assert.deepEqual(gateCookies(null), { ok: true, session: undefined, state: undefined });
  assert.equal(gateCookies(`${SESSION}=s; ${SESSION}=evil`).why, "duplicate");
  assert.equal(gateCookies(`${STATE}=a; ${STATE}=b`).why, "duplicate");
  assert.equal(gateCookies(`__HOST-podster_preview=evil; ${SESSION}=s`).why, "case_variant");
  assert.equal(gateCookies("__host-podster_preview_state=evil").why, "case_variant");
  assert.equal(gateCookies(`${SESSION}=s; justavalue`).why, "nameless");
  // What a server can't see: a nameless cookie whose value is `__Host-podster_preview=x` is sent as exactly that.
  assert.deepEqual(cookiePairs("__Host-podster_preview=x"), [{ name: SESSION, value: "x" }]);
});

test("a token is refused for another type, host, state or time, and when altered", () => {
  const key = Buffer.alloc(32, 7);
  const state = newState();
  const now = 1000;
  const t = sign(key, { typ: "ticket", aud: "g.pv.test", st: stateHash(state), exp: now + 60 });
  assert.equal(check(key, t, { typ: "ticket", host: "g.pv.test", state, now }).ok, true);
  assert.equal(check(key, t, { typ: "session", host: "g.pv.test", state, now }).why, "typ");
  assert.equal(check(key, t, { typ: "ticket", host: "b.pv.test", state, now }).why, "aud");
  assert.equal(check(key, t, { typ: "ticket", host: "g.pv.test", state: newState(), now }).why, "st");
  assert.equal(check(key, t, { typ: "ticket", host: "g.pv.test", state, now: now + 60 }).why, "exp");
  assert.equal(check(key, `${t.slice(0, -2)}AA`, { typ: "ticket", host: "g.pv.test", state, now }).why, "signature");
  assert.equal(check(Buffer.alloc(32, 8), t, { typ: "ticket", host: "g.pv.test", state, now }).why, "signature");
});

test("the return path stays on the host", () => {
  for (const bad of ["//evil.test/", "https://evil.test/", "/\\evil", "evil", null]) assert.equal(sameHostPath(bad), "/");
  assert.equal(sameHostPath("/x?y=1"), "/x?y=1");
});

test("the preview policy is production's with allow-same-origin and nothing else", () => {
  const o = "https://a.pv.test";
  assert.equal(previewPolicy(o).replace(" allow-same-origin", ""), productionPolicy(o));
  assert.match(productionPolicy(o), /^sandbox allow-scripts;/);
  const hash = createHash("sha256").update(ENTER_SCRIPT).digest("base64");
  assert.ok(ENTER_CSP.includes(`'sha256-${hash}'`));
});
