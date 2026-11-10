// Offline checks only. Nothing here calls GitHub.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appJwt, argsProblem, looksLikeTestOrg, orgAllowed, restrictionRuleset } from "./spike.mjs";

test("a restriction ruleset names the merge App as the only bypass actor and targets the default branch", () => {
  const full = restrictionRuleset({ name: "x", statusAppId: 7, pullRequest: true, update: true, bypassAppId: 7 });
  assert.deepEqual(full.rules.map((r) => r.type), ["pull_request", "required_status_checks", "update"]);
  assert.deepEqual(full.bypass_actors, [{ actor_id: 7, actor_type: "Integration", bypass_mode: "always" }]);
  assert.deepEqual(full.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assert.equal(full.enforcement, "active");
  assert.equal(full.rules[1].parameters.required_status_checks[0].integration_id, 7);
  assert.deepEqual(full.rules[2].parameters, { update_allows_fetch_and_merge: false });

  const reviewOnly = restrictionRuleset({ name: "y", statusAppId: 7, pullRequest: true });
  assert.deepEqual(reviewOnly.rules.map((r) => r.type), ["pull_request", "required_status_checks"]);
  assert.deepEqual(reviewOnly.bypass_actors, []);

  const noStatus = restrictionRuleset({ name: "z", pullRequest: true, update: true, bypassAppId: 7 });
  assert.deepEqual(noStatus.rules.map((r) => r.type), ["pull_request", "update"]);
});

test("the App JWT verifies with the key's public half and carries the App ID", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = appJwt(42, pem, 1_000_000);
  const [head, body, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, sig, "base64url"));
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.deepEqual(claims, { iat: 999_940, exp: 1_000_540, iss: "42" });
});

test("only organizations that look like test ones are accepted", () => {
  for (const ok of ["podster-spike", "podster-test", "test-podster", "podster-sandbox", "spike"]) {
    assert.ok(looksLikeTestOrg(ok), ok);
  }
  for (const bad of ["podster", "podster-rooms", "contest", "testimony", "podster_test", "test/../podster", "", undefined]) {
    assert.ok(!looksLikeTestOrg(bad), String(bad));
  }
});

test("another organization runs only when the owner repeats its name exactly", () => {
  assert.ok(orgAllowed("podster-spike", undefined));
  assert.ok(orgAllowed("podsterx", "podsterx"));
  for (const [org, confirm] of [["podsterx", undefined], ["podsterx", ""], ["podsterx", "Podsterx"], ["podster", "podsterx"], [undefined, undefined], ["", ""], ["a/b", "a/b"]]) {
    assert.ok(!orgAllowed(org, confirm), `${org} ${confirm}`);
  }
});

test("unknown arguments are refused, and the merge-restriction mode runs alone", () => {
  assert.equal(argsProblem([]), null);
  assert.equal(argsProblem(["--merge-restriction"]), null);
  assert.equal(argsProblem(["--cleanup", "--public-only"]), null);
  assert.match(argsProblem(["--bogus"]), /Unknown argument: --bogus/);
  for (const other of ["--allow-public", "--public-only", "--cleanup"]) {
    assert.match(argsProblem(["--merge-restriction", other]), new RegExp(`can't be combined with ${other}`));
  }
});
