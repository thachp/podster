// Offline: `node --test spikes/m6-store/guard.test.mjs`. It makes no request and reads no token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAMESPACE, SCRIPT_IN_SOURCE, allow, spikeNamed } from "./guard.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef"; // made up
const API = "https://api.cloudflare.com/client/v4";
const account = `${API}/accounts/${ACCOUNT}`;
const inNamespace = `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`;
const atAccount = `${account}/workers/scripts`;
const KV_MADE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KV_OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const D1_MADE = "11111111-2222-3333-4444-555555555555";
const D1_OTHER = "99999999-2222-3333-4444-555555555555";
const made = { kv: new Set([KV_MADE]), d1: new Set([D1_MADE]) };
const WRITES = ["PUT", "POST", "PATCH", "DELETE"];
const ok = (method, url, body = null, metadata = null) => assert.equal(allow(method, url, ACCOUNT, { body, made, metadata }), url);
const no = (method, url, body = null, metadata = null) => assert.throws(() => allow(method, url, ACCOUNT, { body, made, metadata }));
const meta = (extra = {}) => JSON.stringify({ main_module: "index.js", compatibility_date: "2026-11-01", ...extra });
const PLAIN = meta();

test("the account must be exactly 32 lowercase hex, or nothing is sent", () => {
  const path = (acct) => `${API}/accounts/${acct}/workers/scripts/spike-store-ab12-x`;
  for (const bad of [
    "0123456789abcdef0123456789abcde\\",
    "0123456789abcdef0123456789abcde.",
    "0123456789abcdef0123456789abcd.*",
    "0123456789abcdef0123456789abc|()",
    "[0-9a-f]{32}",
    ".*",
    "0123456789ABCDEF0123456789ABCDEF",
    "0123456789abcdef0123456789abcdef0",
    "",
    null,
  ]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      assert.throws(() => allow(method, path("0123456789abcdef0123456789abcdef"), bad, { made, metadata: PLAIN }), /no account ID/, `${method} ${bad}`);
    }
  }
});

test("a write is refused unless its path is under this account", () => {
  const other = `${API}/accounts/fedcba9876543210fedcba9876543210`;
  no("PUT", `${other}/workers/scripts/spike-store-ab12-x`, null, PLAIN);
  no("POST", `${other}/storage/kv/namespaces`, JSON.stringify({ title: "spike-store-ab12-kv-a" }));
  no("DELETE", `${other}/storage/kv/namespaces/${KV_MADE}`);
  no("POST", `${other}/d1/database/${D1_MADE}/query`);
  no("PUT", `${account}workers/scripts/spike-store-ab12-x`, null, PLAIN);
});

test("the namespace written into the script pattern is NAMESPACE", () => {
  assert.ok(SCRIPT_IN_SOURCE.includes(`\\/namespaces\\/${NAMESPACE}\\/scripts\\/`));
});

test("names", () => {
  assert.ok(spikeNamed("spike-store-ab12-kv-a"));
  for (const bad of ["spike-store-", "spike-store-A", "spike-store-a/b", "spike-store-a.b", "podster-x", "spike-store-" + "a".repeat(41), null]) {
    assert.equal(spikeNamed(bad), false, String(bad));
  }
});

test("GET goes anywhere on the API, and nowhere else", () => {
  ok("GET", `${account}/storage/kv/namespaces`);
  ok("GET", `${account}/storage/kv/namespaces/${KV_OTHER}`);
  no("GET", "https://example.com/client/v4/x");
  no("GET", `${account}/../x`);
  no("GET", `${account}/%2e%2e/x`);
});

test("scripts: only spike names, in the namespace or at account level", () => {
  for (const base of [inNamespace, atAccount]) {
    ok("PUT", `${base}/spike-store-ab12-app-kv-a`, null, PLAIN);
    ok("DELETE", `${base}/spike-store-ab12-app-kv-a`);
    ok("DELETE", `${base}/spike-store-ab12-app-kv-a?force=true`);
    no("PUT", `${base}/podster-api-staging`, null, PLAIN);
    no("DELETE", `${base}/spike-m6-b-canary`);
    no("PUT", `${base}/spike-store-ab12-x?y=1`, null, PLAIN);
    no("PUT", `${base}/spike-store-ab12-x/secrets`, null, PLAIN);
  }
  ok("POST", `${atAccount}/spike-store-ab12-dispatch/subdomain`);
  no("POST", `${atAccount}/podster-api-staging/subdomain`);
  no("POST", `${inNamespace}/spike-store-ab12-x/subdomain`);
  no("PUT", `${account}/workers/dispatch/namespaces/other-namespace/scripts/spike-store-ab12-x`);
});

test("an upload binds only stores this spike made, and migrates only its own class", () => {
  const app = `${inNamespace}/spike-store-ab12-app`;
  const dispatch = `${atAccount}/spike-store-ab12-dispatch`;
  const kv = (id) => ({ type: "kv_namespace", name: "STORE", namespace_id: id });
  const d1 = (id) => ({ type: "d1", name: "STORE", id });
  const ns = { type: "dispatch_namespace", name: "NS", namespace: NAMESPACE };
  const counter = (cls) => ({ type: "durable_object_namespace", name: "COUNTER", class_name: cls });

  // What the spike sends.
  ok("PUT", app, null, meta({ bindings: [kv(KV_MADE)] }));
  ok("PUT", app, null, meta({ bindings: [d1(D1_MADE)] }));
  ok("PUT", dispatch, null, meta({ bindings: [ns, counter("SpikeCounter")], migrations: { new_tag: "v1", new_sqlite_classes: ["SpikeCounter"] } }));
  ok("PUT", dispatch, null, meta({ bindings: [], migrations: { old_tag: "v1", new_tag: "v2", deleted_classes: ["SpikeCounter"] } }));

  // A foreign KV namespace, a foreign D1 database, a class that isn't the spike's.
  no("PUT", app, null, meta({ bindings: [kv(KV_OTHER)] }));
  no("PUT", app, null, meta({ bindings: [d1(D1_OTHER)] }));
  no("PUT", dispatch, null, meta({ bindings: [ns, counter("Workspace")] }));
  no("PUT", dispatch, null, meta({ bindings: [counter("SpikeCounter"), { ...counter("SpikeCounter"), script_name: "podster-api-staging" }] }));
  no("PUT", dispatch, null, meta({ migrations: { new_tag: "v1", new_sqlite_classes: ["Workspace"] } }));
  no("PUT", dispatch, null, meta({ migrations: { old_tag: "v1", new_tag: "v2", deleted_classes: ["Principal"] } }));
  no("PUT", dispatch, null, meta({ migrations: { new_tag: "v1", new_classes: ["SpikeCounter"] } }));
  no("PUT", dispatch, null, meta({ migrations: { new_tag: "v2", renamed_classes: [{ from: "Workspace", to: "SpikeCounter" }] } }));

  // Every other kind of binding, a dispatch or class binding inside the namespace, a migration there, extra keys.
  no("PUT", app, null, meta({ bindings: [{ ...kv(KV_MADE), extra: 1 }] }));
  no("PUT", app, null, meta({ bindings: [ns] }));
  no("PUT", app, null, meta({ bindings: [counter("SpikeCounter")] }));
  no("PUT", app, null, meta({ migrations: { new_tag: "v1", new_sqlite_classes: ["SpikeCounter"] } }));
  no("PUT", dispatch, null, meta({ bindings: [{ ...ns, namespace: "podster-apps" }] }));
  no("PUT", dispatch, null, meta({ bindings: [{ ...ns, outbound: { worker: { service: "x" } } }] }));
  for (const type of ["r2_bucket", "service", "secret_text", "plain_text", "queue", "analytics_engine", "hyperdrive", "ai"]) {
    no("PUT", app, null, meta({ bindings: [{ type, name: "STORE" }] }));
  }
  no("PUT", app, null, meta({ tail_consumers: [{ service: "podster-api-staging" }] }));
  no("PUT", app, null, meta({ keep_bindings: ["secret_text"] }));

  // No metadata, or metadata the guard can't read.
  no("PUT", app, null, null);
  no("PUT", app, null, "{not json");
  no("PUT", app, null, JSON.stringify([]));
});

test("KV: create only with a spike title; write and delete only what was made", () => {
  ok("POST", `${account}/storage/kv/namespaces`, JSON.stringify({ title: "spike-store-ab12-kv-a" }));
  no("POST", `${account}/storage/kv/namespaces`, JSON.stringify({ title: "podster-serve" }));
  no("POST", `${account}/storage/kv/namespaces`, JSON.stringify({ title: "spike-store-ab12-kv-a", extra: 1 }));
  no("POST", `${account}/storage/kv/namespaces`, null);
  ok("DELETE", `${account}/storage/kv/namespaces/${KV_MADE}`);
  no("DELETE", `${account}/storage/kv/namespaces/${KV_OTHER}`);
  ok("PUT", `${account}/storage/kv/namespaces/${KV_MADE}/values/spike-store-marker-a`);
  no("PUT", `${account}/storage/kv/namespaces/${KV_OTHER}/values/spike-store-marker-a`);
  no("PUT", `${account}/storage/kv/namespaces/${KV_MADE}/values/host-podster`);
  no("PUT", `${account}/storage/kv/namespaces/${KV_MADE}/bulk`);
  no("DELETE", `${account}/storage/kv/namespaces/${KV_MADE}/values/spike-store-marker-a`);
  no("PATCH", `${account}/storage/kv/namespaces/${KV_MADE}`);
});

test("D1: create only with a spike name; query and delete only what was made", () => {
  ok("POST", `${account}/d1/database`, JSON.stringify({ name: "spike-store-ab12-d1-a" }));
  no("POST", `${account}/d1/database`, JSON.stringify({ name: "podster" }));
  ok("POST", `${account}/d1/database/${D1_MADE}/query`);
  no("POST", `${account}/d1/database/${D1_OTHER}/query`);
  ok("DELETE", `${account}/d1/database/${D1_MADE}`);
  no("DELETE", `${account}/d1/database/${D1_OTHER}`);
  no("DELETE", `${account}/d1/database/${D1_MADE}/query`);
  no("POST", `${account}/d1/database/${D1_MADE}`);
  no("POST", `${account}/d1/database/${D1_MADE}/export`);
});

test("nothing else is written", () => {
  for (const method of WRITES) {
    no(method, `${account}/workers/durable_objects/namespaces`);
    no(method, `${account}/tokens`);
    no(method, `${account}/workers/subdomain`);
    no(method, `${API}/zones`);
  }
});
