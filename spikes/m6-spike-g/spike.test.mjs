// Offline checks only. Nothing here calls Cloudflare.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allow } from "./guard.mjs";
import {
  checkConfig,
  manifestHash,
  names,
  parseArgs,
  plan,
  readDoh,
  readHost,
  redact,
  releaseFiles,
  scriptName,
  shapeOf,
  spikeKey,
  spikeTxtName,
  stopValue,
  timeline,
  txtText,
  fullSizeManifest,
} from "./pure.mjs";

const API = "https://api.cloudflare.com/client/v4";
const account = "a".repeat(32);
const kv = "b".repeat(32);
const zoneId = "c".repeat(32);
const ctx = (more = {}) => ({ account, kv, ns: "apps-ns", domain: "podster.site", run: "abc123", stopAllowed: false, stopOwned: false, dnsZone: "opster.dev", dnsZoneId: zoneId, madeDns: new Set(["d".repeat(32)]), ...more });
const value = (key) => `${API}/accounts/${account}/storage/kv/namespaces/${kv}/values/${key}`;
const script = `spikegabc123c1.rel_${"e".repeat(32)}`;
const dispatch = (name, q = "") => `${API}/accounts/${account}/workers/dispatch/namespaces/apps-ns/scripts/${name}${q}`;

test("a GET reads anywhere on the API, and nothing goes anywhere else", () => {
  allow("GET", `${API}/accounts/${account}/storage/kv/namespaces/${kv}/keys?limit=10`, null, ctx());
  assert.throws(() => allow("GET", "https://example.com/client/v4/x", null, ctx()));
  assert.throws(() => allow("PUT", "https://spikegabc123c1.podster.site/x", "v", ctx()));
});

test("a KV write or delete only for the spike's own keys", () => {
  allow("PUT", value("spikegabc123c1.podster.site"), "x", ctx());
  allow("DELETE", value("spikegabc123w.podster.site"), null, ctx());
  allow("DELETE", value("spikegabc123l07.podster.site"), null, ctx());
  for (const key of ["myapp.podster.site", "spikegabc123c1.podster.dev", "spikegabc123c4.podster.site", "spikeg.podster.site", "x.spikegabc123c1.podster.site"]) {
    assert.throws(() => allow("PUT", value(key), "x", ctx()), key);
    assert.throws(() => allow("DELETE", value(key), null, ctx()), key);
  }
  assert.throws(() => allow("PUT", value("spikegabc123c1.podster.site?expiration_ttl=60"), "x", ctx()));
  assert.throws(() => allow("PUT", `${API}/accounts/${account}/storage/kv/namespaces/${"f".repeat(32)}/values/spikegabc123c1.podster.site`, "x", ctx()));
  assert.throws(() => allow("PUT", `${API}/accounts/${"f".repeat(32)}/storage/kv/namespaces/${kv}/values/spikegabc123c1.podster.site`, "x", ctx()));
});

test("the stop key only with the gate open and the spike's value, and deleted only when the spike owns it", () => {
  assert.throws(() => allow("PUT", value("_stop"), stopValue("abc123"), ctx()));
  allow("PUT", value("_stop"), stopValue("abc123"), ctx({ stopAllowed: true }));
  assert.throws(() => allow("PUT", value("_stop"), "stopped", ctx({ stopAllowed: true })));
  assert.throws(() => allow("PUT", value("_stop"), stopValue("ffffff"), ctx({ stopAllowed: true })));
  assert.throws(() => allow("DELETE", value("_stop"), null, ctx({ stopAllowed: true })));
  allow("DELETE", value("_stop"), null, ctx({ stopOwned: true }));
});

test("namespace scripts only by a spike name, with the API's own query", () => {
  allow("PUT", dispatch(script, "?excludeScript=true&bindings_inherit=strict"), null, ctx());
  allow("DELETE", dispatch(script, "?force=true"), null, ctx());
  allow("POST", dispatch(`${script}/assets-upload-session`), "{}", ctx());
  allow("POST", `${API}/accounts/${account}/workers/assets/upload?base64=true`, null, ctx());
  assert.throws(() => allow("PUT", dispatch(script), null, ctx()));
  assert.throws(() => allow("DELETE", dispatch(`myapp.rel_${"e".repeat(32)}`, "?force=true"), null, ctx()));
  assert.throws(() => allow("PUT", dispatch(`${script}/settings`), null, ctx()));
  assert.throws(() => allow("POST", `${API}/accounts/${account}/workers/assets/upload`, null, ctx()));
});

test("one Worker outside the namespace: the probe, and its workers.dev switch", () => {
  allow("PUT", `${API}/accounts/${account}/workers/scripts/spike-g-probe-abc123`, null, ctx());
  allow("POST", `${API}/accounts/${account}/workers/scripts/spike-g-probe-abc123/subdomain`, "{}", ctx());
  allow("DELETE", `${API}/accounts/${account}/workers/scripts/spike-g-probe-abc123`, null, ctx());
  assert.throws(() => allow("PUT", `${API}/accounts/${account}/workers/scripts/podster-content`, null, ctx()));
  assert.throws(() => allow("DELETE", `${API}/accounts/${account}/workers/scripts/podster-content`, null, ctx()));
  assert.throws(() => allow("PATCH", `${API}/accounts/${account}/workers/scripts/spike-g-probe-abc123/settings`, "{}", ctx()));
  assert.throws(() => allow("PUT", `${API}/accounts/${account}/workers/subdomain`, "{}", ctx()));
});

test("TXT records only of the spike's name, value and TTL, and deleted only by an ID the spike holds", () => {
  const rec = (o) => JSON.stringify({ type: "TXT", name: "_spike-g-abc123a.opster.dev", content: `podster-spike-g=${"1".repeat(32)}`, ttl: 60, ...o });
  const url = `${API}/zones/${zoneId}/dns_records`;
  allow("POST", url, rec(), ctx());
  assert.throws(() => allow("POST", url, rec({ type: "CNAME" }), ctx()));
  assert.throws(() => allow("POST", url, rec({ name: "opster.dev" }), ctx()));
  assert.throws(() => allow("POST", url, rec({ name: "_spike-g-abc123a.podster.dev" }), ctx()));
  assert.throws(() => allow("POST", url, rec({ content: "v=spf1 -all" }), ctx()));
  assert.throws(() => allow("POST", url, rec({ ttl: 1 }), ctx()));
  assert.throws(() => allow("POST", url, rec({ proxied: false }), ctx()));
  allow("DELETE", `${url}/${"d".repeat(32)}`, null, ctx());
  assert.throws(() => allow("DELETE", `${url}/${"9".repeat(32)}`, null, ctx()));
  assert.throws(() => allow("POST", `${API}/zones/${"9".repeat(32)}/dns_records`, rec(), ctx()));
});

test("names carry the run and stay in their forms", () => {
  const n = names("abc123", "podster.site");
  assert.deepEqual(n.takedown, ["spikegabc123c1", "spikegabc123c2", "spikegabc123c3", "spikegabc123w"]);
  for (const l of n.takedown) assert.ok(spikeKey(n.host(l), "podster.site"));
  for (const k of n.listKeys) assert.ok(spikeKey(k, "podster.site"));
  assert.ok(spikeKey(n.missingKey, "podster.site"));
  assert.equal(n.listKeys.length, 25);
  assert.ok(spikeTxtName(n.txt.primed, "opster.dev") && spikeTxtName(n.txt.fresh, "opster.dev"));
  for (const l of n.takedown) assert.ok(l.length <= 26 && /^[a-z0-9]+$/.test(l), "a label the content Worker reads");
  assert.match(scriptName(n.warm, "0".repeat(32)), /^spikegabc123w\.rel_0{32}$/);
  assert.throws(() => names("ABC123", "podster.site"));
});

test("a release's files: the API's hash, a marker naming label and version, and root _headers and _redirects", () => {
  assert.equal(manifestHash("text/plain", Buffer.from("x")), manifestHash("text/plain", Buffer.from("x")));
  assert.notEqual(manifestHash("text/plain", Buffer.from("x")), manifestHash("text/html", Buffer.from("x")));
  const files = releaseFiles("spikegabc123c1", "v1");
  assert.deepEqual(files.map((f) => f.path), ["/.well-known/podster-release.json", "/index.html", "/big.txt", "/_headers", "/_redirects"]);
  assert.equal(readHost(200, files[0].bytes.toString(), "spikegabc123c1"), "v1");
  const m = fullSizeManifest();
  assert.equal(Object.keys(m).length, 300);
  assert.ok(Object.values(m).reduce((s, f) => s + f.size, 0) <= 25_000_000);
  assert.equal(new Set(Object.values(m).map((f) => f.hash)).size, 300);
});

test("a host's answer is read for its own label only", () => {
  const marker = (o) => JSON.stringify({ spike: "g", label: "spikegabc123c1", version: "v2", ...o });
  assert.equal(readHost(200, marker(), "spikegabc123c1"), "v2");
  assert.equal(readHost(200, marker({ label: "spikegabc123c2" }), "spikegabc123c1"), "other-200");
  assert.equal(readHost(404, "not_found\n", "spikegabc123c1"), "absent");
  assert.equal(readHost(404, "", "spikegabc123c1"), "other-404");
  assert.equal(readHost(522, "x", "spikegabc123c1"), "other-522");
});

test("a timeline: first seen, stable from, and flips back", () => {
  const s = (t, state) => ({ sent: t, done: t + 50, state });
  const tl = timeline([s(1000, "absent"), s(1500, "v1"), s(2000, "absent"), s(2500, "v1"), s(3000, "v1")], "v1", 900);
  assert.deepEqual(tl.first_ms, { sent: 600, done: 650 });
  assert.deepEqual(tl.stable_ms, { sent: 1600, done: 1650 });
  assert.equal(tl.flips_after_first, 1);
  assert.equal(timeline([s(1000, "absent")], "v1", 0).seen, false);
  const clean = timeline([s(1000, "v1"), s(1500, "v1")], "v1", 0);
  assert.deepEqual(clean.stable_ms, clean.first_ms);
});

test("DNS over HTTPS: a definite no is told from no answer", () => {
  const ok = (j) => ({ http: 200, json: j });
  const name = "_spike-g-abc123a.opster.dev";
  const want = "podster-spike-g=1";
  assert.equal(readDoh(ok({ Status: 0, Answer: [{ name, type: 16, data: '"podster-spike-g=1"' }] }), name, want).verdict, "found");
  assert.equal(readDoh(ok({ Status: 0, Answer: [{ name: `${name}.`, type: 16, data: "podster-spike-g=1" }] }), name, want).verdict, "found");
  assert.equal(readDoh(ok({ Status: 0, Answer: [{ name, type: 16, data: '"podster-" "spike-g=1"' }] }), name, want).verdict, "found");
  assert.deepEqual(readDoh(ok({ Status: 0 }), name, want), { verdict: "no-record", kind: "nodata" });
  assert.deepEqual(readDoh(ok({ Status: 3 }), name, want), { verdict: "no-record", kind: "nxdomain" });
  assert.deepEqual(readDoh(ok({ Status: 0, Answer: [{ name, type: 16, data: '"other"' }] }), name, want), { verdict: "no-record", kind: "other-value" });
  assert.equal(readDoh(ok({ Status: 2 }), name, want).verdict, "no-answer");
  assert.equal(readDoh(ok({ Status: 5 }), name, want).verdict, "no-answer");
  assert.equal(readDoh(ok({ Status: 0, TC: true }), name, want).verdict, "no-answer");
  assert.equal(readDoh({ http: 503, json: null }, name, want).verdict, "no-answer");
  assert.equal(readDoh({ error: "TimeoutError" }, name, want).kind, "error-TimeoutError");
  assert.equal(readDoh(ok({ Status: 0, Answer: [{ name, type: 5, data: "x.example." }, { name: "x.example.", type: 16, data: '"podster-spike-g=1"' }] }), name, want).verdict, "no-answer");
  assert.equal(txtText('"a\\"b"'), 'a"b');
});

test("arguments take file paths only, and the configuration only its six keys", () => {
  const a = parseArgs(["run", "--config", "./c.json", "--kv-token-file", "/x/kv.token", "--no-stop"]);
  assert.equal(a.kvTokenFile, "/x/kv.token");
  assert.ok(a.flags.has("no-stop"));
  assert.throws(() => parseArgs(["run", "--kv-token-file=/x"]));
  assert.throws(() => parseArgs(["run", "--kv-token-file", "AbCdEf0123456789xyzTOKEN"]));
  assert.throws(() => parseArgs(["run", "--kv-token"]));
  assert.throws(() => parseArgs(["deploy"]));
  const c = { account_id: account, kv_namespace_id: kv, dispatch_namespace: "ns", content_worker: "podster-content", content_domain: "podster.site", dns_zone: "opster.dev" };
  assert.equal(checkConfig(c), c);
  assert.throws(() => checkConfig({ ...c, content_domain: "podster.dev" }));
  assert.throws(() => checkConfig({ ...c, dns_zone: "podster.site" }));
  assert.throws(() => checkConfig({ ...c, token: "x" }));
  assert.throws(() => checkConfig({ ...c, account_id: "x" }));
});

test("redaction hides secrets, IDs, UUIDs and tokens, and the plan prints none", () => {
  const out = redact(`k=sekrit-value a=${account} u=123e4567-e89b-12d3-a456-426614174000 s=cfwau_eyJabc.def j=eyJhbGciOiJI.eyJzdWIiOiIx.sig`, ["sekrit-value"]);
  assert.ok(!out.includes("sekrit") && !out.includes(account) && !out.includes("123e4567") && !out.includes("cfwau_") && !out.includes("eyJ"), out);
  const c = { account_id: account, kv_namespace_id: kv, dispatch_namespace: "ns", content_worker: "podster-content", content_domain: "podster.site", dns_zone: "opster.dev" };
  const text = ["run", "cursor", "cleanup"].flatMap((cmd) => plan(cmd, names("abc123", "podster.site"), c)).join("\n");
  assert.ok(!text.includes(account) && !text.includes(kv) && !text.includes(account.slice(0, 4)));
});

test("a shape keeps keys and types, never values", () => {
  assert.deepEqual(shapeOf({ b: "x@example.com", a: [{ id: 1 }] }), { a: ["length 1", { id: "number" }], b: "string" });
});

test("the probe answers only its header, and builds the smallest upload body in memory", async () => {
  const probe = (await import("./probe-worker.mjs")).default;
  const get = (path, key = "__SPIKE_G_KEY__") => probe.fetch(new Request(`https://probe.invalid${path}`, { headers: key ? { "x-spike-g-key": key } : {} }));
  assert.equal((await get("/memory?case=1", null)).status, 404);
  assert.equal((await get("/memory?case=1", "wrong")).status, 404);
  assert.equal((await get("/memory?case=9")).status, 404);
  assert.equal((await get("/doh?name=example.com")).status, 404, "only the run's and the fixed names are looked up");
  const mem = await (await get("/memory?case=1")).json();
  assert.equal(mem.raw_bytes, 5_000_000);
  assert.equal(mem.copy_bytes, mem.body_bytes);
  assert.ok(mem.body_bytes > (5_000_000 * 4) / 3);
  const nt = await get("/compress?nt=1");
  assert.equal(nt.headers.get("cache-control"), "max-age=60, no-transform");
  assert.equal((await nt.text()).length, 200_000);
});
