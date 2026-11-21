// The transport and the start checks (S-54): only the transport holds the key, the key's provider and file are
// checked, and the environment can't point the client elsewhere. Synthetic keys only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerTransport, keyRefusal, readKeyFile, envRefusals } from "../lib/transport.mjs";
import { OPENAI_PROFILE } from "../lib/profile.mjs";
import { fakeUpstream, TEST_KEY } from "./fake-upstream.mjs";

const fwd = (over = {}) => ({ url: "https://api.openai.com/v1/responses", headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}"), ...over });

test("the transport adds the key last as a bearer token and never follows a redirect", async () => {
  const up = fakeUpstream([{}]);
  const t = providerTransport({ profile: OPENAI_PROFILE, key: TEST_KEY, fetchImpl: up.fetchImpl });
  await t.send(fwd());
  assert.equal(up.calls[0].auth, "test-key");
  assert.equal(up.calls[0].redirect, "error");
  assert.equal(t.sent, 1);
});

test("the transport refuses a forward carrying any authorization or OpenAI header, or another URL", async () => {
  const up = fakeUpstream([]);
  const t = providerTransport({ profile: OPENAI_PROFILE, key: TEST_KEY, fetchImpl: up.fetchImpl });
  for (const h of ["Authorization", "authorization", "x-api-key", "OpenAI-Organization", "openai-project", "OpenAI-Beta"]) {
    await assert.rejects(t.send(fwd({ headers: { [h]: "x" } })), /transport refused: header/, h);
  }
  for (const url of ["https://api.openai.com/v1/responses?x=1", "https://api.openai.com/v1/chat/completions", "https://evil.example/v1/responses"]) {
    await assert.rejects(t.send(fwd({ url })), /transport refused: url/, url);
  }
  assert.equal(up.calls.length, 0);
  assert.equal(t.sent, 0);
});

test("a key of the wrong provider or shape is refused, and the error never carries the key", () => {
  assert.equal(keyRefusal(TEST_KEY, OPENAI_PROFILE), null);
  assert.equal(keyRefusal(`sk-ant-api03-${"A".repeat(80)}`, OPENAI_PROFILE), "key_provider");
  assert.equal(keyRefusal(`sk-${"A".repeat(48)}`, OPENAI_PROFILE), "key_format"); // a legacy user key, not a project key
  assert.equal(keyRefusal("sk-proj-short", OPENAI_PROFILE), "key_format");
  assert.equal(keyRefusal(`sk-proj-${"A".repeat(48)}\n`, OPENAI_PROFILE), "key_format");
  assert.equal(keyRefusal(undefined, OPENAI_PROFILE), "key_format");
  const wrong = `sk-ant-api03-${"B".repeat(80)}`;
  assert.throws(
    () => providerTransport({ profile: OPENAI_PROFILE, key: wrong }),
    (err) => /key_provider/.test(err.message) && !err.message.includes(wrong),
  );
});

test("the key file must be a regular file, not a link, readable by no one else, with one key", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "m7o-keyfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.key");
  writeFileSync(good, `${TEST_KEY}\n`);
  chmodSync(good, 0o600);
  assert.equal(readKeyFile(good), TEST_KEY);

  const open = join(dir, "open.key");
  writeFileSync(open, TEST_KEY);
  chmodSync(open, 0o644);
  assert.throws(() => readKeyFile(open), /readable by others/);

  const link = join(dir, "link.key");
  symlinkSync(good, link);
  assert.throws(() => readKeyFile(link), /not a regular file/);

  const two = join(dir, "two.key");
  writeFileSync(two, `${TEST_KEY}\n${TEST_KEY}\n`);
  chmodSync(two, 0o600);
  assert.throws(() => readKeyFile(two), (err) => /not exactly one key/.test(err.message) && !err.message.includes(TEST_KEY));

  assert.throws(() => readKeyFile(dir), /not a regular file/);
});

test("the environment may not name an OpenAI key, base URL, other OPENAI_ settings, a proxy or TLS trust", () => {
  assert.deepEqual(envRefusals({ PATH: "/bin", OPENAI_AGENTS_DISABLE_TRACING: "1", OPENAI_AGENTS_DONT_LOG_MODEL_DATA: "1" }), []);
  assert.deepEqual(
    envRefusals({ OPENAI_API_KEY: "x", OPENAI_BASE_URL: "x", OPENAI_AGENTS_TRACING_EXPORT_API_KEY: "x", OPENAI_ORG_ID: "x", openai_api_key: "x" }),
    ["OPENAI_AGENTS_TRACING_EXPORT_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "openai_api_key"],
  );
  assert.deepEqual(envRefusals({ HTTPS_PROXY: "x", NODE_EXTRA_CA_CERTS: "x", NODE_USE_ENV_PROXY: "1", NODE_OPTIONS: "x" }), [
    "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_USE_ENV_PROXY",
  ]);
});
