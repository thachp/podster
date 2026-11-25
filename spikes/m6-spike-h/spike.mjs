#!/usr/bin/env node
// M6 spike H: the four "before code is turned on" items, on the second account and podster.site. See README.md.
//
// Spike only. Every request to Cloudflare's API goes through `api`, which asks guard.mjs first. Each token is read from
// a file whose path is given on the command line, held in memory and sent in a header only. Everything it makes has a
// spike name carrying the run's ID, and every run ends by deleting what it made (on an error, at a bound and on
// Ctrl-C too), then reading each thing back and recording what is left. Every secret, 32-hex ID, UUID and JWT is
// redacted before a line is written.
//
//   node spike.mjs plan
//   node spike.mjs run --config <file> --scripts-token-file <file> --kv-token-file <file> --store-token-file <file>
//   node spike.mjs cleanup --config <file> --scripts-token-file <file> --kv-token-file <file> --store-token-file <file>
//
// Exit 0 when every item held and nothing was left; 1 when an item didn't hold or couldn't run; 2 for a refused
// configuration or a failed preflight (nothing made); 3 when the clean-up left something.

import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allow } from "./guard.mjs";
import {
  API_QUERY,
  ASSETS_CONFIG,
  BOUNDS,
  COMPATIBILITY_DATE,
  D1_TYPE,
  MAIN_MODULE,
  MARKER_PATH,
  MODULE_TYPE,
  QUERIES,
  SERVED,
  SPIKE_DATABASE,
  SPIKE_SCRIPT,
  STOP_KEY,
  STORE_BINDING,
  judgeBindings,
  judgeMarker,
  judgeOutbound,
  judgeQuery,
  moduleSource,
  names,
  redact,
  releaseFiles,
  scriptName,
  shapeOf,
  source,
  spikeKey,
} from "./pure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const RUN = randomBytes(3).toString("hex");
const command = process.argv[2];
const RESULTS = join(HERE, "results", `${command}.jsonl`);
const SUMMARY = join(HERE, "results", `summary-${RUN}.json`);

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (command === "plan") {
  const n = names(RUN, "podster.site");
  console.log(`Run ${RUN} would make, on the second account:`);
  console.log(`  one D1 database: ${n.database} (store token)`);
  for (const [k, l] of Object.entries(n.label)) console.log(`  a dispatch script ${l}.rel_<32 hex> (${k}), with the marker and index.html as assets and one module`);
  console.log("  more writes of the same name for script d (re-writes), none of a new name");
  for (const k of SERVED) console.log(`  a serve entry ${n.host(n.label[k])} naming its script, unmarked (routing token)`);
  console.log("and delete every one of them, then read each back.");
  process.exit(0);
}
if (command !== "run" && command !== "cleanup") {
  console.error("usage: node spike.mjs <plan|run|cleanup> --config <file> --scripts-token-file <file> --kv-token-file <file> --store-token-file <file>");
  process.exit(2);
}

// ---- configuration and secrets ----

const secrets = [];
function plainFile(path, what) {
  if (!path) throw new Error(`${what} is required`);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`${what}: no file at that path`);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${what}: must be a plain file, not a link`);
  if (st.mode & 0o077) throw new Error(`${what}: must be mode 600`);
}
function readSecret(path, what) {
  plainFile(path, what);
  const raw = readFileSync(path, "utf8");
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(value)) throw new Error(`${what}: must hold exactly one token on one line`);
  secrets.push(value);
  return value;
}
let config;
const tokens = {};
try {
  plainFile(option("config"), "--config");
  const c = JSON.parse(readFileSync(option("config"), "utf8"));
  if (!/^[0-9a-f]{32}$/.test(c.account_id ?? "") || !/^[0-9a-f]{32}$/.test(c.kv_namespace_id ?? "") || !/^[a-z0-9-]{1,63}$/.test(c.dispatch_namespace ?? "") || c.content_domain !== "podster.site")
    throw new Error("--config: needs account_id, kv_namespace_id, dispatch_namespace and content_domain podster.site");
  config = c;
  tokens.scripts = readSecret(option("scripts-token-file"), "--scripts-token-file");
  tokens.kv = readSecret(option("kv-token-file"), "--kv-token-file");
  tokens.store = readSecret(option("store-token-file"), "--store-token-file");
  if (new Set(Object.values(tokens)).size !== 3) throw new Error("the three token files must hold three different tokens");
} catch (e) {
  console.error(`spike H: refusing: ${e.message}`);
  process.exit(2);
}
secrets.push(config.account_id, config.kv_namespace_id, config.dispatch_namespace);

const n = names(RUN, config.content_domain);
const ctx = { account: config.account_id, kv: config.kv_namespace_id, ns: config.dispatch_namespace, domain: config.content_domain, run: RUN, madeDb: new Set() };
/** Every script this run named, written or not, so the clean-up deletes it even if a listing misses it. */
const named = new Set();
/** Every serve entry key this run wrote or may have. */
const keysWritten = new Set();

mkdirSync(dirname(RESULTS), { recursive: true });
function record(step, data = {}) {
  const line = redact(JSON.stringify({ run: RUN, command, at: new Date().toISOString(), step, ...data }), secrets);
  appendFileSync(RESULTS, `${line}\n`);
  console.log(line);
}

// ---- bounds and signals ----

const started = Date.now();
const used = { api: 0, edge: 0, cleanup: 0 };
let stopping = null;
let cleaning = false;
let cleanupFrom = null;
class Bound extends Error {}
function spend(kind) {
  if (cleaning) {
    cleanupFrom ??= Date.now();
    if (++used.cleanup > BOUNDS.cleanupApi || Date.now() - cleanupFrom > BOUNDS.cleanupMs) throw new Bound("the clean-up's bound");
    return;
  }
  if (stopping) throw new Bound(`stopping (${stopping})`);
  if (Date.now() - started > BOUNDS.ms) throw new Bound("the time bound");
  if (++used[kind] > BOUNDS[kind]) throw new Bound(`the ${kind} bound of ${BOUNDS[kind]}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
process.stdout.on("error", () => {});
process.on("SIGINT", () => {
  if (stopping === "signal") process.exit(130);
  stopping = "signal";
  console.error("spike H: stopping and cleaning up. Again to leave without cleaning up; then run `cleanup`.");
});
process.on("SIGTERM", () => (stopping = "signal"));

// ---- Cloudflare's API ----

const codes = (json) => (Array.isArray(json?.errors) ? json.errors.map((e) => ({ code: e.code, message: String(e.message).slice(0, 300) })) : null);
const acc = () => `/accounts/${ctx.account}`;
const kvPath = (key) => `${acc()}/storage/kv/namespaces/${ctx.kv}/values/${key}`;
const dispatchPath = () => `${acc()}/workers/dispatch/namespaces/${ctx.ns}/scripts`;

async function api(method, path, { token, bearer, body = null, type = null } = {}) {
  const url = `${API}${path}`;
  allow(method, url, typeof body === "string" ? body : null, ctx);
  spend("api");
  const auth = bearer ?? tokens[token];
  const headers = { authorization: `Bearer ${auth}`, accept: "application/json" };
  if (type) headers["content-type"] = type;
  const t = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, ms: Date.now() - t };
  } catch (e) {
    return { status: 0, error: e?.name ?? "Error", ms: Date.now() - t };
  }
}
const answer = (r) => ({ status: r.status, success: r.json?.success, errors: codes(r.json), ms: r.ms, ...(r.error ? { error: r.error } : {}) });

// ---- the edge ----

/** One request on a fresh TLS connection. The body is kept up to 64 KB. */
function edge(host, path, { method = "GET", headers = {} } = {}) {
  spend("edge");
  return new Promise((resolve) => {
    const req = httpsRequest({ host, servername: host, path, method, agent: false, timeout: 20_000, headers: { host, "user-agent": "podster-spike-h", ...headers } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size <= 65_536) chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), bytes: size }));
      res.on("error", (e) => resolve({ error: e.code ?? e.name }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", (e) => resolve({ error: e.code ?? e.name }));
    req.end();
  });
}
/** The marker job's own request (`content_provider::fetch_marker`): the exact path, its two headers. */
const MARKER_HEADERS = { accept: "application/json", "cache-control": "no-cache" };
const colo = (r) => (typeof r.headers?.["cf-ray"] === "string" ? r.headers["cf-ray"].split("-")[1] : undefined);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---- releases ----

/**
 * Writes one release script with modules, as S3's upload does: a session, the files, then the script's PUT with a
 * `metadata` part and the module part. `query` is item 4's; `assetsConfig` and `bindings` are what the metadata holds.
 */
async function writeScript(name, label, { tag, query = API_QUERY, assetsConfig = ASSETS_CONFIG, bindings = [] }) {
  named.add(name);
  const files = releaseFiles(label);
  const manifest = Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]));
  const byHash = Object.fromEntries(files.map((f) => [f.hash, f]));
  const s = await api("POST", `${dispatchPath()}/${name}/assets-upload-session`, { token: "scripts", body: JSON.stringify({ manifest }), type: "application/json" });
  const jwt = s.json?.result?.jwt;
  if (typeof jwt === "string") secrets.push(jwt);
  const buckets = Array.isArray(s.json?.result?.buckets) ? s.json.result.buckets : null;
  let completion = buckets && buckets.length === 0 ? jwt : null;
  const steps = [];
  for (const bucket of buckets ?? []) {
    const form = new FormData();
    for (const h of bucket) form.append(h, new Blob([byHash[h].bytes.toString("base64")], { type: byHash[h].type }), h);
    const r = await api("POST", `${acc()}/workers/assets/upload?base64=true`, { bearer: jwt, body: form });
    const done = r.json?.result?.jwt;
    if (typeof done === "string") secrets.push(done);
    steps.push(answer(r));
    if (r.status === 201 && typeof done === "string") completion = done;
  }
  if (!completion) {
    record("upload", { tag, session: answer(s), buckets: buckets?.map((b) => b.length) ?? null, steps, completed: false });
    return { ok: false, tag };
  }
  const metadata = { assets: { config: assetsConfig, jwt: completion }, bindings, compatibility_date: COMPATIBILITY_DATE, compatibility_flags: [], main_module: MAIN_MODULE };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(MAIN_MODULE, new Blob([moduleSource(tag)], { type: MODULE_TYPE }), MAIN_MODULE);
  const put = await api("PUT", `${dispatchPath()}/${name}${query}`, { token: "scripts", body: form });
  const ok = put.status === 200 && put.json?.success === true && put.json?.result?.id === name;
  const result = put.json?.result ?? null;
  record("script-write", {
    tag,
    query,
    assets_config: assetsConfig,
    bindings: bindings.map((b) => ({ type: b.type, name: b.name, has_id: typeof b.id === "string" })),
    buckets: buckets?.map((b) => b.length) ?? null,
    ...answer(put),
    ok,
    result_keys: result && typeof result === "object" ? Object.keys(result).sort() : null,
    result_has_script_text: typeof result?.script === "string",
    result_bindings: Array.isArray(result?.bindings) ? result.bindings.map((b) => ({ type: b.type, name: b.name })) : null,
    result_main_module: result?.main_module ?? null,
  });
  return { ok, tag, put };
}

/** The script's own reads: the script, its bindings, its settings and its content. */
async function readScript(name, tag) {
  const read = await api("GET", `${dispatchPath()}/${name}`, { token: "scripts" });
  const bindings = await api("GET", `${dispatchPath()}/${name}/bindings`, { token: "scripts" });
  const settings = await api("GET", `${dispatchPath()}/${name}/settings`, { token: "scripts" });
  const content = await api("GET", `${dispatchPath()}/${name}/content`, { token: "scripts" });
  const list = bindings.status === 200 && bindings.json?.success === true && Array.isArray(bindings.json.result) ? bindings.json.result : null;
  const holdsTag = typeof content.text === "string" && content.text.includes(`const TAG = ${JSON.stringify(tag)};`);
  record("script-read", {
    tag,
    read: { ...answer(read), shape: shapeOf(read.json?.result, 2) },
    bindings: { ...answer(bindings), list: list?.map((b) => ({ ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k === "id" ? (v === undefined ? null : "<id>") : v])) })) ?? null },
    settings: { ...answer(settings), bindings: Array.isArray(settings.json?.result?.bindings) ? settings.json.result.bindings.map((b) => ({ type: b.type, name: b.name })) : null, shape: shapeOf(settings.json?.result, 1) },
    content: { status: content.status, type_is_multipart: /multipart|form-data|boundary/i.test(content.text?.slice(0, 200) ?? ""), holds_tag: holdsTag, bytes: content.text?.length ?? 0 },
  });
  return { list, holdsTag };
}

/** Reads a host's `/spike-h/who` until its module answers with `tag`, up to `ms`. */
async function untilTag(label, tag, ms = 90_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms && !stopping) {
    const r = await edge(n.host(label), "/spike-h/who");
    last = { status: r.status, error: r.error, colo: colo(r) };
    const v = parse(r.body);
    if (r.status === 200 && v?.source === "worker" && v.tag === tag) return { seen: true, after_ms: Date.now() - t0, env: v.env, colo: colo(r) };
    if (r.status === 200 && v?.source === "worker") last.tag = v.tag;
    await sleep(1_000);
  }
  return { seen: false, after_ms: Date.now() - t0, last };
}

// ---- run ----

const verdicts = {};
const evidence = {};

async function preflight() {
  for (const kind of Object.keys(tokens)) {
    const r = await api("GET", "/user/tokens/verify", { token: kind });
    record("token-verify", { token: kind, ...answer(r), state: r.json?.result?.status ?? null });
    if (r.json?.result?.status !== "active") throw new Error(`the ${kind} token isn't active`);
  }
  for (const w of ["podster-content", "podster-outbound"]) {
    const r = await api("GET", `${acc()}/workers/scripts/${w}/deployments`, { token: "scripts" });
    const live = r.json?.result?.deployments?.[0];
    const versions = Array.isArray(live?.versions) ? live.versions.map((v) => ({ version: String(v.version_id).slice(0, 8), percentage: v.percentage })) : null;
    record("deployed-version", { worker: w, ...answer(r), versions });
    evidence[`${w}_version`] = versions;
  }
  const unknown = await edge(n.host(`${n.base}z`), `/${MARKER_PATH}`, { headers: MARKER_HEADERS });
  const ok = unknown.status === 404 && unknown.body === "not_found\n" && /^sandbox allow-scripts;/.test(unknown.headers?.["content-security-policy"] ?? "");
  record("content-worker-answers", { status: unknown.status, error: unknown.error, not_found: ok, colo: colo(unknown) });
  if (!ok) throw new Error("the content Worker didn't answer an unknown spike host with its own not-found");
  const stop = await api("GET", kvPath(STOP_KEY), { token: "kv" });
  record("stop-key", { status: stop.status, code: codes(stop.json)?.[0]?.code ?? null });
  if (stop.status !== 404) throw new Error("the stop key is set, or couldn't be read: nothing would be served");
}

async function run() {
  record("start", { bounds: BOUNDS });
  try {
    await preflight();
  } catch (e) {
    record("preflight-failed", { error: e.message });
    return 2;
  }

  // The store.
  const db = await api("POST", `${acc()}/d1/database`, { token: "store", body: JSON.stringify({ name: n.database }), type: "application/json" });
  const dbId = db.json?.result?.uuid;
  if (typeof dbId === "string") ctx.madeDb.add(dbId);
  record("d1-create", { ...answer(db), has_id: typeof dbId === "string", shape: shapeOf(db.json?.result, 1) });
  evidence.d1_create = { status: db.status, success: db.json?.success, store_token_made_it: db.status === 200 && typeof dbId === "string" };

  // The scripts.
  const script = Object.fromEntries(Object.entries(n.label).map(([k, l]) => [k, scriptName(l, randomBytes(16).toString("hex"))]));
  const w = {};
  w.marker = await writeScript(script.marker, n.label.marker, { tag: "a" });
  w.control = await writeScript(script.control, n.label.control, { tag: "b", assetsConfig: { ...ASSETS_CONFIG, run_worker_first: true } });
  if (typeof dbId === "string") w.store = await writeScript(script.store, n.label.store, { tag: "d1", bindings: [{ type: D1_TYPE, name: STORE_BINDING, id: dbId }] });
  w.none = await writeScript(script.none, n.label.none, { tag: "n", query: QUERIES.none });
  w.exclude = await writeScript(script.exclude, n.label.exclude, { tag: "e", query: QUERIES.exclude });
  w.strict = await writeScript(script.strict, n.label.strict, { tag: "s", query: QUERIES.strict });
  // An `inherit` binding on a script that has no earlier version: under strict, then under no query. Never served.
  const inheritStrict = await writeScript(script.inherit, n.label.inherit, { tag: "i-strict", query: QUERIES.strict, bindings: [{ type: "inherit", name: STORE_BINDING }] });
  const inheritNone = await writeScript(script.inherit, n.label.inherit, { tag: "i-none", query: QUERIES.none, bindings: [{ type: "inherit", name: STORE_BINDING }] });
  evidence.inherit = { strict_ok: inheritStrict.ok, strict_errors: inheritStrict.put ? codes(inheritStrict.put.json) : null, none_ok: inheritNone.ok, none_errors: inheritNone.put ? codes(inheritNone.put.json) : null };

  const reads = {};
  for (const k of [...SERVED, "inherit"]) if (w[k]?.ok || (k === "inherit" && (inheritStrict.ok || inheritNone.ok))) reads[k] = await readScript(script[k], k === "inherit" ? (inheritNone.ok ? "i-none" : "i-strict") : w[k].tag);
  evidence.inherit.bindings_after = reads.inherit?.list?.map((b) => ({ type: b.type, name: b.name })) ?? null;

  // The serve entries, unmarked, so the deployed content Worker dispatches GET and HEAD to each script as it does a
  // static host's. (A marked entry is refused `code_apps_off` there, by the code-apps switch.)
  for (const k of SERVED) {
    if (!w[k]?.ok) continue;
    const key = n.host(n.label[k]);
    keysWritten.add(key);
    const put = await api("PUT", kvPath(key), { token: "kv", body: script[k], type: "text/plain" });
    record("serve-entry-write", { which: k, ...answer(put) });
  }
  await sleep(1_000);
  const live = {};
  for (const k of SERVED) if (w[k]?.ok) live[k] = await untilTag(n.label[k], w[k].tag, 60_000);
  record("hosts-live", { live });

  // ---- item 1: the marker's order ----
  if (live.marker?.seen) {
    const hostA = n.host(n.label.marker);
    const markerReads = [];
    for (let i = 0; i < 10; i++) {
      const r = await edge(hostA, `/${MARKER_PATH}`, { headers: MARKER_HEADERS });
      markerReads.push({ source: source(r.status, r.body, n.label.marker), status: r.status, type: r.headers?.["content-type"], etag: typeof r.headers?.etag === "string", colo: colo(r) });
      await sleep(300);
    }
    const head = await edge(hostA, `/${MARKER_PATH}`, { method: "HEAD", headers: MARKER_HEADERS });
    const other = await edge(hostA, "/no-such-file.json", { headers: MARKER_HEADERS });
    // Paths the marker job never asks, recorded only: who answers each.
    const variants = {};
    for (const p of [`/${MARKER_PATH}?v=1`, `/${MARKER_PATH}/`, `/.well-known/./podster-release.json`, `/.well-known/podster-release%2ejson`, `/.WELL-KNOWN/podster-release.json`, `//${MARKER_PATH}`, "/.well-known/", "/"]) {
      const r = await edge(hostA, p, { headers: MARKER_HEADERS });
      variants[p] = { status: r.status, source: source(r.status, r.body, n.label.marker), location: r.headers?.location ?? null };
    }
    const controlReads = [];
    for (let i = 0; i < (live.control?.seen ? 3 : 0); i++) {
      const r = await edge(n.host(n.label.control), `/${MARKER_PATH}`, { headers: MARKER_HEADERS });
      controlReads.push(source(r.status, r.body, n.label.control));
    }
    const facts = { reads: markerReads.map((r) => r.source), head: { status: head.status, bytes: head.bytes }, other: source(other.status, other.body, n.label.marker), control: controlReads.length > 0 && controlReads.every((s) => s === "worker") ? "worker" : controlReads.join(",") || "not served" };
    verdicts.marker = judgeMarker(facts);
    record("item-1-marker", { facts, markerReads, variants, controlReads, verdict: verdicts.marker });
  } else {
    verdicts.marker = { holds: false, failed: ["host a never served its module"], not_run: true };
    record("item-1-marker", { verdict: verdicts.marker });
  }

  // ---- item 3: outbound ----
  if (live.marker?.seen) {
    const r = await edge(n.host(n.label.marker), "/spike-h/outbound");
    const probe = parse(r.body);
    verdicts.outbound = judgeOutbound(probe);
    record("item-3-outbound", { status: r.status, probe, verdict: verdicts.outbound });
  } else {
    verdicts.outbound = { holds: false, failed: ["host a never served its module"], not_run: true };
    record("item-3-outbound", { verdict: verdicts.outbound });
  }

  // ---- item 2: bindings with a store ----
  if (w.store?.ok && live.store?.seen) {
    const served = parse((await edge(n.host(n.label.store), "/spike-h/store")).body);
    // The list straight after the write, then again after 10 s: a lag would show as 404 or [] first.
    const again = (await sleep(10_000), await readScript(script.store, "d1"));
    const list = again.list;
    const raw = list?.map((b) => ({ type: b.type, name: b.name, id_matches: b.id === dbId, database_id_matches: b.database_id === undefined ? null : b.database_id === dbId, keys: Object.keys(b).sort() })) ?? null;
    verdicts.bindings = judgeBindings({ list, id: dbId, served, staticList: reads.marker?.list });
    record("item-2-bindings", { first_read: reads.store?.list?.map((b) => ({ type: b.type, name: b.name, id_matches: b.id === dbId })) ?? null, list: raw, served: { source: served?.source, env: served?.env, store: served?.store }, static_list: reads.marker?.list ?? null, verdict: verdicts.bindings });
  } else {
    verdicts.bindings = { holds: false, failed: ["the store's script wasn't written or never served"], not_run: true };
    record("item-2-bindings", { verdict: verdicts.bindings });
  }

  // ---- item 4: the write's query ----
  const writes = {};
  const byQuery = { both: "marker", none: "none", exclude: "exclude", strict: "strict" };
  for (const [q, k] of Object.entries(byQuery)) writes[q] = { ok: !!w[k]?.ok, content: !!reads[k]?.holdsTag, served: !!live[k]?.seen };
  // A re-write of d with no binding, under no query and then (after binding it again) under strict: does an old
  // binding survive? Seen at the host by the new tag and its environment, and by the bindings' read.
  const rewrites = {};
  if (w.store?.ok) {
    for (const [q, tag, rebind] of [["none", "d-none", "d-rebind"], ["strict", "d-strict", null]]) {
      const r = await writeScript(script.store, n.label.store, { tag, query: QUERIES[q], bindings: [] });
      const seen = r.ok ? await untilTag(n.label.store, tag) : { seen: false };
      const read = r.ok ? await readScript(script.store, tag) : { list: null };
      rewrites[q] = { ok: r.ok && seen.seen && JSON.stringify(seen.env) === "[]", list: read.list, host_env: seen.env ?? null, seen_after_ms: seen.after_ms };
      if (rebind) {
        const b = await writeScript(script.store, n.label.store, { tag: rebind, bindings: [{ type: D1_TYPE, name: STORE_BINDING, id: dbId }] });
        const s2 = b.ok ? await untilTag(n.label.store, rebind) : { seen: false };
        record("rebind", { ok: b.ok, seen: s2.seen, env: s2.env ?? null });
      }
    }
  }
  verdicts.query = judgeQuery({ writes, rewrites });
  record("item-4-query", { writes, rewrites, inherit: evidence.inherit, verdict: verdicts.query });

  return Object.values(verdicts).every((v) => v.holds) ? 0 : 1;
}

// ---- clean-up ----

async function cleanup() {
  cleaning = true;
  const left = {};
  try {
    // Serve entries first, so nothing is served while the rest goes.
    const listed = await api("GET", `${acc()}/storage/kv/namespaces/${ctx.kv}/keys?prefix=spikeh`, { token: "kv" });
    const keys = new Set(keysWritten);
    for (const k of listed.json?.result ?? []) if (spikeKey(k.name, ctx.domain)) keys.add(k.name);
    for (const k of keys) await api("DELETE", kvPath(k), { token: "kv" });
    const ns = await api("GET", dispatchPath(), { token: "scripts" });
    for (const s of ns.json?.result ?? []) if (SPIKE_SCRIPT.test(s.id)) named.add(s.id);
    for (const name of named) await api("DELETE", `${dispatchPath()}/${name}?force=true`, { token: "scripts" });
    const dbs = await api("GET", `${acc()}/d1/database?name=spike-h-`, { token: "store" });
    for (const d of dbs.json?.result ?? []) if (SPIKE_DATABASE.test(d.name ?? "") && typeof d.uuid === "string") ctx.madeDb.add(d.uuid);
    for (const id of ctx.madeDb) {
      const del = await api("DELETE", `${acc()}/d1/database/${id}`, { token: "store" });
      record("d1-delete", answer(del));
    }
    await sleep(5_000);

    // Read back: each key, each script, each database, and the three listings.
    let kvLeft = 0;
    for (const k of keys) {
      const r = await api("GET", kvPath(k), { token: "kv" });
      if (!(r.status === 404 && codes(r.json)?.[0]?.code === 10009)) kvLeft++;
    }
    const after = await api("GET", `${acc()}/storage/kv/namespaces/${ctx.kv}/keys?prefix=spikeh`, { token: "kv" });
    left.kv_keys_readable = kvLeft;
    left.kv_keys_listed = after.status === 200 && Array.isArray(after.json?.result) ? after.json.result.filter((k) => spikeKey(k.name, ctx.domain)).length : "not listed";
    let scriptsLeft = 0;
    const scriptReads = [];
    for (const name of named) {
      const r = await api("GET", `${dispatchPath()}/${name}`, { token: "scripts" });
      const gone = (r.status === 200 && r.json?.result?.script === null) || (r.status === 404 && codes(r.json)?.[0]?.code === 10007);
      scriptReads.push({ status: r.status, script_null: r.json?.result?.script === null, code: codes(r.json)?.[0]?.code ?? null, gone });
      if (!gone) scriptsLeft++;
    }
    left.scripts_readable = scriptsLeft;
    const nsAfter = await api("GET", dispatchPath(), { token: "scripts" });
    left.scripts_listed = nsAfter.status === 200 && Array.isArray(nsAfter.json?.result) ? nsAfter.json.result.filter((s) => SPIKE_SCRIPT.test(s.id)).length : "not listed";
    let dbLeft = 0;
    const dbReads = [];
    for (const id of ctx.madeDb) {
      const r = await api("GET", `${acc()}/d1/database/${id}`, { token: "store" });
      dbReads.push({ status: r.status, code: codes(r.json)?.[0]?.code ?? null });
      if (r.status !== 404) dbLeft++;
    }
    left.databases_readable = dbLeft;
    const dbsAfter = await api("GET", `${acc()}/d1/database?name=spike-h-`, { token: "store" });
    left.databases_listed = dbsAfter.status === 200 && Array.isArray(dbsAfter.json?.result) ? dbsAfter.json.result.filter((d) => SPIKE_DATABASE.test(d.name ?? "")).length : "not listed";
    const clean = Object.values(left).every((v) => v === 0);
    record("cleanup", { left, clean, named_scripts: named.size, keys: keys.size, databases: ctx.madeDb.size, scriptReads, dbReads, calls: used.cleanup });
    return clean;
  } catch (e) {
    record("cleanup-error", { error: e.message, left });
    return false;
  }
}

let code = 0;
try {
  if (command === "run") code = await run();
} catch (e) {
  record("error", { error: e instanceof Bound ? `bound: ${e.message}` : String(e?.message ?? e) });
  code = 1;
} finally {
  const clean = await cleanup();
  if (command === "run") {
    const summary = { run: RUN, at: new Date().toISOString(), verdicts, evidence, clean, calls: used };
    writeFileSync(SUMMARY, `${redact(JSON.stringify(summary, null, 2), secrets)}\n`);
  }
  if (!clean) code = 3;
}
process.exit(code);
