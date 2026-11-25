// Spike H's offline checks: the guard refuses everything but the spike's own calls, and each judge fails when its
// property doesn't hold. `node --test spikes/m6-spike-h/spike.test.mjs`
import assert from "node:assert/strict";
import { test } from "node:test";
import { allow } from "./guard.mjs";
import { API_QUERY, OUTBOUND_BODY, QUERIES, assetMarker, judgeBindings, judgeMarker, judgeOutbound, judgeQuery, moduleSource, names, redact, source, spikeKey } from "./pure.mjs";

const account = "a".repeat(32);
const kv = "b".repeat(32);
const ctx = { account, kv, ns: "apps-ns", domain: "podster.site", run: "abc123", madeDb: new Set(["11111111-2222-3333-4444-555555555555"]) };
const API = "https://api.cloudflare.com/client/v4";
const acc = `${API}/accounts/${account}`;
const script = `spikehabc123a.rel_${"c".repeat(32)}`;
const ok = (m, u, b = null) => assert.doesNotThrow(() => allow(m, u, b, ctx), `${m} ${u}`);
const no = (m, u, b = null) => assert.throws(() => allow(m, u, b, ctx), /refusing/, `${m} ${u}`);

test("the guard lets through the spike's own calls", () => {
  ok("GET", `${API}/user/tokens/verify`);
  ok("PUT", `${acc}/storage/kv/namespaces/${kv}/values/spikehabc123a.podster.site`);
  ok("DELETE", `${acc}/storage/kv/namespaces/${kv}/values/spikehabc123a.podster.site`);
  ok("GET", `${acc}/storage/kv/namespaces/${kv}/values/_stop`);
  ok("GET", `${acc}/storage/kv/namespaces/${kv}/keys?prefix=spikeh`);
  for (const q of Object.values(QUERIES)) ok("PUT", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/${script}${q}`);
  ok("DELETE", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/${script}?force=true`);
  for (const sub of ["bindings", "settings", "content"]) ok("GET", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/${script}/${sub}`);
  ok("POST", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/${script}/assets-upload-session`);
  ok("GET", `${acc}/workers/dispatch/namespaces/apps-ns/scripts`);
  ok("POST", `${acc}/workers/assets/upload?base64=true`);
  ok("GET", `${acc}/workers/scripts/podster-content/deployments`);
  ok("POST", `${acc}/d1/database`, JSON.stringify({ name: "spike-h-abc123" }));
  ok("DELETE", `${acc}/d1/database/11111111-2222-3333-4444-555555555555`);
  ok("GET", `${acc}/d1/database?name=spike-h-`);
});

test("the guard refuses anything else", () => {
  no("PUT", `${acc}/storage/kv/namespaces/${kv}/values/_stop`);
  no("DELETE", `${acc}/storage/kv/namespaces/${kv}/values/_stop`);
  no("PUT", `${acc}/storage/kv/namespaces/${kv}/values/myapp.podster.site`);
  no("GET", `${acc}/storage/kv/namespaces/${kv}/values/myapp.podster.site`);
  no("GET", `${acc}/storage/kv/namespaces/${kv}/keys`);
  no("PUT", `${acc}/storage/kv/namespaces/${"d".repeat(32)}/values/spikehabc123a.podster.site`);
  no("PUT", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/myapp.rel_${"c".repeat(32)}${API_QUERY}`);
  no("GET", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/myapp.rel_${"c".repeat(32)}/content`);
  no("PUT", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/${script}?excludeScript=false`);
  no("DELETE", `${acc}/workers/dispatch/namespaces/apps-ns/scripts/${script}`);
  no("PUT", `${acc}/workers/scripts/podster-content`);
  no("PUT", `${acc}/workers/scripts/podster-outbound`);
  no("GET", `${acc}/workers/scripts/podster-content/content`);
  no("POST", `${acc}/d1/database`, JSON.stringify({ name: "podster-store-x" }));
  no("POST", `${acc}/d1/database`, JSON.stringify({ name: "spike-h-abc123", primary_location_hint: "weur" }));
  no("DELETE", `${acc}/d1/database/99999999-2222-3333-4444-555555555555`);
  no("POST", `${acc}/d1/database/11111111-2222-3333-4444-555555555555/query`);
  no("GET", `${acc}/d1/database`);
  no("PUT", `${API}/accounts/${"e".repeat(32)}/storage/kv/namespaces/${kv}/values/spikehabc123a.podster.site`.replace(account, "x"));
  no("GET", `https://example.com/client/v4/user/tokens/verify`);
  no("POST", `${API}/zones/x/dns_records`);
});

test("names stay in the content Worker's forms", () => {
  const n = names("abc123", "podster.site");
  for (const l of Object.values(n.label)) assert.match(l, /^[a-z0-9]{1,26}$/);
  assert.ok(spikeKey(n.host(n.label.marker), "podster.site"));
  assert.ok(!spikeKey("spikehabc123a.other.site", "podster.site"));
  assert.throws(() => names("ABC", "podster.site"));
  assert.match(moduleSource("d-none"), /const TAG = "d-none";/);
  assert.throws(() => moduleSource('x"; evil'));
});

test("item 1's judge", () => {
  const good = { reads: ["asset", "asset"], head: { status: 200, bytes: 0 }, other: "worker", control: "worker" };
  assert.equal(judgeMarker(good).holds, true);
  assert.equal(judgeMarker({ ...good, reads: ["asset", "worker"] }).holds, false);
  assert.equal(judgeMarker({ ...good, reads: [] }).holds, false);
  assert.equal(judgeMarker({ ...good, other: "other-404" }).holds, false);
  assert.equal(judgeMarker({ ...good, control: "asset" }).holds, false);
  assert.equal(judgeMarker({ ...good, head: { status: 200, bytes: 10 } }).holds, false);
  assert.equal(source(200, assetMarker("l"), "l"), "asset");
  assert.equal(source(200, assetMarker("m"), "l"), "other-200");
  assert.equal(source(200, JSON.stringify({ spike: "h", source: "asset", label: "l", extra: 1 }), "l"), "other-200");
  assert.equal(source(200, JSON.stringify({ spike: "h", source: "worker" }), "l"), "worker");
  assert.equal(source(404, "not_found\n", "l"), "other-404");
});

test("item 3's judge", () => {
  const refused = { status: 403, body: OUTBOUND_BODY };
  const good = { source: "worker", fetches: [{ url: "x", ...refused }], sockets: [{ hostname: "h", port: 80, opened: false, bytes_read: 0 }] };
  assert.equal(judgeOutbound(good).holds, true);
  assert.equal(judgeOutbound({ ...good, fetches: [{ url: "x", status: 200, body: "hi" }] }).holds, false);
  assert.equal(judgeOutbound({ ...good, fetches: [{ url: "x", status: 403, body: "other" }] }).holds, false);
  assert.equal(judgeOutbound({ ...good, sockets: [{ hostname: "h", port: 80, opened: true, bytes_read: 0 }] }).holds, false);
  assert.equal(judgeOutbound({ ...good, sockets: [{ hostname: "h", port: 80, opened: false, bytes_read: 3 }] }).holds, false);
  assert.equal(judgeOutbound({ ...good, sockets: [] }).holds, false);
  assert.equal(judgeOutbound(null).holds, false);
});

test("item 2's judge", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const good = { list: [{ type: "d1", name: "STORE", id }], id, served: { source: "worker", env: ["STORE"], store: { seven: 7 } }, staticList: [] };
  assert.equal(judgeBindings(good).holds, true);
  assert.equal(judgeBindings({ ...good, list: [] }).holds, false);
  assert.equal(judgeBindings({ ...good, list: [...good.list, { type: "kv_namespace", name: "X" }] }).holds, false);
  assert.equal(judgeBindings({ ...good, list: [{ type: "d1", name: "STORE", id: "other" }] }).holds, false);
  assert.equal(judgeBindings({ ...good, served: { ...good.served, env: ["STORE", "X"] } }).holds, false);
  assert.equal(judgeBindings({ ...good, staticList: null }).holds, false);
});

test("item 4's judge", () => {
  const w = { ok: true, content: true, served: true };
  const good = { writes: { both: w, none: w, exclude: w, strict: w }, rewrites: { none: { ok: true, list: [] }, strict: { ok: true, list: [] } } };
  assert.equal(judgeQuery(good).holds, true);
  assert.equal(judgeQuery({ ...good, writes: { ...good.writes, exclude: { ...w, content: false } } }).holds, false);
  assert.equal(judgeQuery({ ...good, writes: { both: w } }).holds, false);
  assert.equal(judgeQuery({ ...good, rewrites: { none: { ok: true, list: [{ type: "d1" }] } } }).holds, false);
  assert.equal(judgeQuery({ ...good, rewrites: {} }).holds, false);
});

test("redaction", () => {
  const line = redact(`tok123 ${"f".repeat(32)} 11111111-2222-3333-4444-555555555555 eyJabcdefghij.abcdefghijk.sig`, ["tok123"]);
  assert.equal(line, "<secret> <id> <uuid> <jwt>");
});
