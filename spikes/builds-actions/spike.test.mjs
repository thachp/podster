import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import { test } from "node:test";
import { PINNED, appJwt, eventWorkflow, isFullSha, locationSummary, orgAllowed, parseSpikeLines, parseTokenPermissions, probeWorkflow, scrub } from "./lib.mjs";

test("runs only when both variables name podsterdev", () => {
  assert.equal(orgAllowed({ BUILDS_ORG: "podsterdev", BUILDS_CONFIRM_ORG: "podsterdev" }), true);
  assert.equal(orgAllowed({ BUILDS_ORG: "podsterdev" }), false);
  assert.equal(orgAllowed({ BUILDS_ORG: "other", BUILDS_CONFIRM_ORG: "other" }), false);
  assert.equal(orgAllowed({ BUILDS_ORG: "podsterdev", BUILDS_CONFIRM_ORG: "Podsterdev" }), false);
  assert.equal(orgAllowed(undefined), false);
});

test("app JWT is RS256 and verifies", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = appJwt(42, pem, 1000);
  const [h, b, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url")), { iat: 940, exp: 1540, iss: "42" });
  assert.equal(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(createPublicKey(privateKey), Buffer.from(s, "base64url")), true);
});

test("scrub removes tokens, query strings and auth headers", () => {
  assert.equal(scrub("x ghs_abcDEF123 y"), "x [token] y");
  assert.equal(scrub("see https://h.example/p?sig=1&se=2 now"), "see https://h.example/p?[query] now");
  assert.equal(scrub("AUTHORIZATION: basic eHg="), "AUTHORIZATION: [redacted]");
});

test("location summary keeps only host and expiry parameter names", () => {
  const s = locationSummary("https://productionresultssa1.blob.core.windows.net/a/b.zip?sv=1&se=2026-01-01&sig=zzz");
  assert.deepEqual(s, { host: "productionresultssa1.blob.core.windows.net", has_expiry: true, expiry_params: ["se"] });
  assert.equal(JSON.stringify(s).includes("zzz"), false);
  assert.deepEqual(locationSummary(null), { host: null, has_expiry: false, expiry_params: [] });
});

test("token permissions are read from the Set up job log", () => {
  const log = [
    "2026-11-21T00:00:00.0000000Z ##[group]GITHUB_TOKEN Permissions",
    "2026-11-21T00:00:00.0000000Z Contents: read",
    "2026-11-21T00:00:00.0000000Z Metadata: read",
    "2026-11-21T00:00:00.0000000Z ##[endgroup]",
    "2026-11-21T00:00:00.0000000Z Secret source: Actions",
  ].join("\n");
  assert.deepEqual(parseTokenPermissions(log), { Contents: "read", Metadata: "read" });
  assert.equal(parseTokenPermissions("nothing"), null);
});

test("SPIKE lines are read, the script's own printf lines are not", () => {
  const log = "Z   printf 'SPIKE status_write=%s\\n' \"$s\"\nZ SPIKE status_write=403\nZ SPIKE ref_write=201";
  assert.deepEqual(parseSpikeLines(log), { status_write: "403", ref_write: "201" });
});

test("probe workflows pin full shas and only the raised one has permissions", () => {
  assert.ok(isFullSha(PINNED.checkout.sha) && isFullSha(PINNED.upload.sha));
  const plain = probeWorkflow({ name: "d", permissions: null });
  const raised = probeWorkflow({ name: "r", permissions: { contents: "write" } });
  assert.equal(/^permissions:/m.test(plain), false);
  assert.match(raised, /^permissions:\n  contents: write$/m);
  for (const wf of [plain, raised]) {
    for (const m of wf.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.ok(isFullSha(m[1]), m[1]);
    assert.match(wf, /branches: \["podster\/\*\*"\]/);
  }
  assert.match(eventWorkflow({ name: "e", on: "  release:" }), /^permissions:\n  contents: read$/m);
});
