// Offline: `node --test spikes/m6-store/guard.test.mjs`. It makes no request and reads no token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAMESPACE, allow, spikeNamed } from "./guard.mjs";

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
const ok = (method, url, body = null) => assert.equal(allow(method, url, ACCOUNT, { body, made }), url);
const no = (method, url, body = null) => assert.throws(() => allow(method, url, ACCOUNT, { body, made }));

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
    ok("PUT", `${base}/spike-store-ab12-app-kv-a`);
    ok("DELETE", `${base}/spike-store-ab12-app-kv-a`);
    ok("DELETE", `${base}/spike-store-ab12-app-kv-a?force=true`);
    no("PUT", `${base}/podster-api-staging`);
    no("DELETE", `${base}/spike-m6-b-canary`);
    no("PUT", `${base}/spike-store-ab12-x?y=1`);
    no("PUT", `${base}/spike-store-ab12-x/secrets`);
  }
  ok("POST", `${atAccount}/spike-store-ab12-dispatch/subdomain`);
  no("POST", `${atAccount}/podster-api-staging/subdomain`);
  no("POST", `${inNamespace}/spike-store-ab12-x/subdomain`);
  no("PUT", `${account}/workers/dispatch/namespaces/other-namespace/scripts/spike-store-ab12-x`);
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
