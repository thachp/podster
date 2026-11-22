#!/usr/bin/env node
// M6 spike G: a hostname's proof and a takedown's speed. See README.md.
//
// Spike only. It holds a token that can write the serve entries' KV namespace, one that can write Worker scripts on
// the second account, and, for the TXT half, one that can edit one test zone's DNS. So:
// - every request to Cloudflare's API goes through `api`, and `api` asks guard.mjs first;
// - each token is read from a file whose path is given on the command line, into memory, and sent in a header and
//   nowhere else. It is never printed, logged, written or put on a command line;
// - everything it makes has a spike name carrying the run's ID, and every command ends by deleting what it made,
//   on Ctrl-C too, then listing again and recording what is left;
// - what is recorded is statuses, Cloudflare's codes and messages, shapes, timings and what the edge answered. Every
//   secret, every 32-hex ID, every UUID, every JWT, the account's workers.dev subdomain and the namespace's name are
//   redacted before anything is kept or shown.

import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allow } from "./guard.mjs";
import {
  ASSETS_CONFIG,
  BOUNDS,
  COMPATIBILITY_DATE,
  CURSOR_AGES_MS,
  MARKER_PATH,
  PHASE_WATCH_MS,
  POLL_MS,
  PROBE_SCRIPT,
  SETTLE_MS,
  SPIKE_SCRIPT,
  STOP_KEY,
  checkConfig,
  fullSizeManifest,
  isSpikeStop,
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
} from "./pure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const RESULTS = join(HERE, "results", "results.jsonl");
const RUN = randomBytes(3).toString("hex");
const hex = (bytes) => randomBytes(bytes).toString("hex");

// ---- arguments ----

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`spike G: ${e.message}`);
  console.error("usage: node spike.mjs <plan|run|cursor|cleanup> --config <file> [--kv-token-file <file>] [--scripts-token-file <file>] [--dns-token-file <file>] [--no-stop] [--no-dns]");
  process.exit(2);
}

function readConfig(path) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error("--config: no file at that path");
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("--config: must be a plain file, not a link");
  return checkConfig(JSON.parse(readFileSync(path, "utf8")));
}

if (args.command === "plan") {
  // No network and no token: only the configuration, if given, to fill in names.
  const c = args.config
    ? readConfig(args.config)
    : { account_id: "<account>", kv_namespace_id: "<kv namespace>", dispatch_namespace: "<namespace>", content_worker: "<content Worker>", content_domain: "podster.site", dns_zone: "opster.dev" };
  for (const command of ["run", "cursor", "cleanup"]) {
    console.log(`== ${command}`);
    for (const line of plan(command, names(RUN, c.content_domain, c.dns_zone), c)) console.log(line);
  }
  console.log("(plan only: nothing was read from a token file, and nothing was sent)");
  process.exit(0);
}

// ---- secrets, held in memory only ----

const secrets = [];
function readSecret(path, option) {
  if (!path) throw new Error(`${option} is required for this command`);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`${option}: no file at that path`);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${option}: must be a plain file, not a link`);
  if (st.mode & 0o077) throw new Error(`${option}: must be mode 600`);
  if (st.size > 512) throw new Error(`${option}: longer than a token`);
  const raw = readFileSync(path, "utf8");
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(value)) throw new Error(`${option}: must hold exactly one token on one line`);
  secrets.push(value);
  return value;
}

let config;
const tokens = {};
try {
  config = readConfig(args.config ?? "");
  const needsScripts = args.command === "run" || args.command === "cleanup";
  tokens.kv = readSecret(args.kvTokenFile, "--kv-token-file");
  if (needsScripts) tokens.scripts = readSecret(args.scriptsTokenFile, "--scripts-token-file");
  else if (args.scriptsTokenFile) tokens.scripts = readSecret(args.scriptsTokenFile, "--scripts-token-file");
  const dns = args.command !== "cursor" && !args.flags.has("no-dns");
  if (dns) tokens.dns = readSecret(args.dnsTokenFile, "--dns-token-file (or pass --no-dns)");
} catch (e) {
  console.error(`spike G: refusing: ${e.message}`);
  process.exit(2);
}
secrets.push(config.account_id, config.kv_namespace_id, config.dispatch_namespace);

const n = names(RUN, config.content_domain, config.dns_zone);
const ctx = {
  account: config.account_id,
  kv: config.kv_namespace_id,
  ns: config.dispatch_namespace,
  domain: config.content_domain,
  run: RUN,
  stopAllowed: false,
  stopReadSpike: false,
  dnsZone: config.dns_zone,
  dnsZoneId: null,
  madeDns: new Set(),
};
/** Every release script this run named, made or not, so the clean-up deletes it even if a listing misses it. */
const named = new Set();
let probeUrl = null;
let probeKey = null;

mkdirSync(dirname(RESULTS), { recursive: true });
function record(step, data = {}) {
  const line = redact(JSON.stringify({ run: RUN, command: args.command, at: new Date().toISOString(), step, ...data }), secrets);
  appendFileSync(RESULTS, `${line}\n`);
  console.log(line);
}

// ---- bounds and Ctrl-C ----

const bounds = BOUNDS[args.command];
const started = Date.now();
const used = { api: 0, edge: 0, probe: 0 };
let stopping = null;
const halt = new AbortController();
class Bound extends Error {}
/** Stops every loop: they check `alive()` before each call, and a call made after this throws. */
function stopAll(reason) {
  stopping ??= reason;
  halt.abort();
}
function spend(kind) {
  if (stopping) throw new Bound(`stopping (${stopping})`);
  if (++used[kind] > bounds[kind]) {
    stopAll(`the ${kind} bound`);
    throw new Bound(`the ${kind} bound of ${bounds[kind]} calls`);
  }
}
/** The clean-up's own bound, apart from the command's: BOUNDS.cleanup's time and calls, from its first call. */
const cleanupUse = { api: 0, from: null };
function spendCleanup() {
  cleanupUse.from ??= Date.now();
  if (++cleanupUse.api > BOUNDS.cleanup.api) throw new Bound(`the clean-up's bound of ${BOUNDS.cleanup.api} calls`);
  if (Date.now() - cleanupUse.from > BOUNDS.cleanup.ms) throw new Bound(`the clean-up's bound of ${BOUNDS.cleanup.ms / 60_000} min`);
}
/** Waits for every part to finish, so nothing is still writing when the clean-up lists; then throws the first error. */
async function settle(parts) {
  const out = await Promise.allSettled(parts);
  const failed = out.find((o) => o.status === "rejected");
  if (failed) {
    stopAll(failed.reason?.message ?? "error");
    throw failed.reason;
  }
  return out.map((o) => o.value);
}
const alive = () => !stopping && Date.now() - started < bounds.ms;
const sleep = (ms) =>
  new Promise((resolve) => {
    if (ms <= 0 || halt.signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    halt.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
const deadline = setTimeout(() => stopAll("time bound"), bounds.ms);
deadline.unref();
// After SIGHUP the terminal may be gone: a write to it then fails (EIO, EPIPE), and must not end the clean-up. Every
// line also goes to the results file.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const onSignal = (signal) => () => {
  if (stopping === "Ctrl-C" || stopping === signal) {
    console.error("spike G: second signal, leaving now. Run `node spike.mjs cleanup …` to delete what may be left.");
    process.exit(130);
  }
  stopping = signal;
  halt.abort();
  console.error(`spike G: ${signal}: stopping and cleaning up. The same signal again leaves without cleaning up.`);
};
// SIGTERM and SIGHUP (a closed terminal) clean up as Ctrl-C does.
process.on("SIGINT", onSignal("Ctrl-C"));
process.on("SIGTERM", onSignal("SIGTERM"));
process.on("SIGHUP", onSignal("SIGHUP"));

// ---- Cloudflare's API ----

const codes = (json) => (Array.isArray(json?.errors) ? json.errors.map((e) => ({ code: e.code, message: e.message })) : json?.errors ?? null);
const acc = () => `/accounts/${ctx.account}`;
const kvPath = (key) => `${acc()}/storage/kv/namespaces/${ctx.kv}/values/${key}`;
const dispatchPath = () => `${acc()}/workers/dispatch/namespaces/${ctx.ns}/scripts`;

/** One API call. `token` names one of the tokens; `bearer` is a session's token. Never throws on an answer. */
async function api(method, path, { token, bearer, body = null, type = null, cleanup = false } = {}) {
  const url = `${API}${path}`;
  try {
    allow(method, url, typeof body === "string" ? body : null, ctx);
  } catch (e) {
    stopAll("the guard refused a call");
    throw e;
  }
  if (cleanup) spendCleanup();
  else spend("api");
  const auth = bearer ?? tokens[token];
  if (!auth) throw new Error(`no ${token} token for this call`);
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
    return { status: res.status, json, text: text.slice(0, 2_000), ms: Date.now() - t, sent: t, done: Date.now() };
  } catch (e) {
    return { status: 0, error: e?.name ?? "Error", ms: Date.now() - t, sent: t, done: Date.now() };
  }
}
const answer = (r) => ({ status: r.status, success: r.json?.success, errors: codes(r.json), ms: r.ms, ...(r.error ? { error: r.error } : {}) });

// ---- the edge ----

/** One GET on a fresh TLS connection, so nothing is reused between reads. The body is kept up to 1 MB, undecoded. */
function edge(host, path, headers = {}, kind = "edge") {
  spend(kind);
  const sent = Date.now();
  return new Promise((resolve) => {
    const req = httpsRequest(
      { host, servername: host, path, method: "GET", agent: false, timeout: 10_000, headers: { host, "user-agent": "podster-spike-g", ...headers } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size <= 1_000_000) chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), size, sent, done: Date.now() }));
        res.on("error", (e) => resolve({ error: e.code ?? e.name, sent, done: Date.now() }));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", (e) => resolve({ error: e.code ?? e.name, sent, done: Date.now() }));
    req.end();
  });
}
const colo = (r) => (typeof r.headers?.["cf-ray"] === "string" ? r.headers["cf-ray"].split("-")[1] : undefined);

async function readMarker(label) {
  const r = await edge(n.host(label), `/${MARKER_PATH}`);
  const state = r.error ? `error-${r.error}` : readHost(r.status, r.raw.toString("utf8"), label);
  return { sent: r.sent, done: r.done, state, colo: colo(r) };
}

/** Reads a host until `target` is seen and then for SETTLE_MS more, or for PHASE_WATCH_MS. */
async function watch(label, target, t0) {
  const samples = [];
  let firstAt = null;
  while (alive() && Date.now() - t0 < PHASE_WATCH_MS && !(firstAt && Date.now() - firstAt > SETTLE_MS)) {
    const s = await readMarker(label);
    samples.push(s);
    if (s.state === target && firstAt === null) firstAt = s.done;
    await sleep(POLL_MS - (Date.now() - s.sent));
  }
  return samples;
}

/** Reads a serve entry back through the API at fixed times after `t0`, as the applier's read-back would. */
async function readBack(key, t0, expect) {
  const out = [];
  for (const at of [0, 1_000, 2_000, 5_000, 10_000, 30_000, 65_000]) {
    await sleep(t0 + at - Date.now());
    if (!alive()) break;
    const r = await api("GET", kvPath(key), { token: "kv" });
    let state;
    if (r.status === 200) state = r.text === expect.v1 ? "v1" : r.text === expect.v2 ? "v2" : r.text === expect.stop ? "stop" : "other";
    else state = `${r.status}-${codes(r.json)?.[0]?.code ?? "none"}`;
    out.push({ at_ms: r.sent - t0, state, ms: r.ms });
  }
  return out;
}

// ---- releases ----

const byHashOf = (files) => Object.fromEntries(files.map((f) => [f.hash, f]));

/** Uploads one static release as its own script, as the API's release job does. `partial` sends one file a request. */
async function uploadRelease(label, version, partial) {
  const name = scriptName(label, hex(16));
  named.add(name);
  const files = releaseFiles(label, version);
  const manifest = Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]));
  const byHash = byHashOf(files);
  const sendBuckets = async (sessionToken, buckets, onePerRequest) => {
    let completion = buckets.length === 0 ? sessionToken : null;
    const steps = [];
    for (const bucket of buckets) {
      for (const group of onePerRequest ? bucket.map((h) => [h]) : [bucket]) {
        const form = new FormData();
        for (const h of group) form.append(h, new Blob([byHash[h].bytes.toString("base64")], { type: byHash[h].type }), h);
        const r = await api("POST", `${acc()}/workers/assets/upload?base64=true`, { bearer: sessionToken, body: form });
        const jwt = r.json?.result?.jwt;
        if (typeof jwt === "string") secrets.push(jwt);
        steps.push({ files: group.length, ...answer(r), gives_token: typeof jwt === "string" });
        if (!r.json?.success) return { completion: null, steps };
        if (r.status === 201 && typeof jwt === "string") completion = jwt;
      }
    }
    return { completion, steps };
  };
  const session = async () => {
    const r = await api("POST", `${dispatchPath()}/${name}/assets-upload-session`, { token: "scripts", body: JSON.stringify({ manifest }), type: "application/json" });
    const jwt = r.json?.result?.jwt;
    if (typeof jwt === "string") secrets.push(jwt);
    const buckets = r.json?.result?.buckets;
    return { r, jwt, buckets: Array.isArray(buckets) ? buckets : null };
  };
  let s = await session();
  record("upload-session", { label, version, ...answer(s.r), buckets: s.buckets?.map((b) => b.length), token_prefix: typeof s.jwt === "string" ? s.jwt.slice(0, 6) : null });
  if (!s.jwt || !s.buckets) throw new Error("no upload session");
  let sent = await sendBuckets(s.jwt, s.buckets, partial);
  record("upload-buckets", { label, version, one_file_a_request: partial, steps: sent.steps, completed: !!sent.completion });
  if (!sent.completion && partial) {
    // One file a request wasn't taken: a new session asks only for what the provider is missing.
    s = await session();
    record("upload-session-again", { label, version, ...answer(s.r), buckets: s.buckets?.map((b) => b.length) });
    if (!s.jwt || !s.buckets) throw new Error("no second upload session");
    sent = await sendBuckets(s.jwt, s.buckets, false);
    record("upload-buckets-whole", { label, version, steps: sent.steps, completed: !!sent.completion });
  }
  if (!sent.completion) throw new Error("the upload never completed");
  const metadata = { assets: { config: ASSETS_CONFIG, jwt: sent.completion }, compatibility_date: COMPATIBILITY_DATE, compatibility_flags: [] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  const put = await api("PUT", `${dispatchPath()}/${name}?excludeScript=true&bindings_inherit=strict`, { token: "scripts", body: form });
  record("script-write", { label, version, ...answer(put), names_script: put.json?.result?.id === name, result: shapeOf(put.json?.result, 1) });
  if (put.status !== 200 || !put.json?.success) throw new Error("the script wasn't written");
  const read = await api("GET", `${dispatchPath()}/${name}`, { token: "scripts" });
  record("script-read", { label, version, ...answer(read), script_null: read.json?.result?.script === null, has_script: !!read.json?.result?.script });
  return name;
}

// ---- the parts of `run` ----

async function preflight() {
  for (const kind of Object.keys(tokens)) {
    const user = await api("GET", "/user/tokens/verify", { token: kind });
    const own = user.status === 200 ? null : await api("GET", `${acc()}/tokens/verify`, { token: kind });
    record("token-verify", { token: kind, user: answer(user), account: own && answer(own), state: (own ?? user).json?.result?.status });
  }
  // The content Worker must already answer on the content domain, with its own not-found, before anything is made.
  const x = await edge(n.host(n.missingKey.split(".")[0]), `/${MARKER_PATH}`);
  const body = x.raw?.toString("utf8");
  const csp = String(x.headers?.["content-security-policy"] ?? "");
  record("content-worker-answers", { status: x.status, error: x.error, not_found: body === "not_found\n", sandbox: csp.startsWith("sandbox allow-scripts"), colo: colo(x) });
  if (x.status !== 404 || body !== "not_found\n" || !csp.startsWith("sandbox allow-scripts")) {
    throw new Error("the content Worker isn't answering on the content domain: deploy it first (docs/content-deploy.md)");
  }
}

/** Every key in the namespace, by pages, held in memory only. Returns the count of keys that aren't the spike's. */
async function allKeys(prefix = "", cleanup = false) {
  const keys = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "1000", ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
    const r = await api("GET", `${acc()}/storage/kv/namespaces/${ctx.kv}/keys?${q}`, { token: "kv", cleanup });
    if (r.status !== 200 || !r.json?.success) return { error: answer(r) };
    keys.push(...r.json.result.map((k) => k.name));
    cursor = r.json.result_info?.cursor ?? "";
    if (!cursor) return { keys };
  }
  return { keys, incomplete: true };
}

async function gate() {
  const listed = await allKeys();
  const stop = await api("GET", kvPath(STOP_KEY), { token: "kv" });
  const others = listed.keys ? listed.keys.filter((k) => !spikeKey(k, ctx.domain)).length : null;
  ctx.stopAllowed = !args.flags.has("no-stop") && others === 0 && !listed.incomplete && stop.status === 404;
  record("namespace-before", {
    keys_listed: !!listed.keys,
    others_than_spike: others,
    incomplete: !!listed.incomplete,
    stop_key: { status: stop.status, code: codes(stop.json)?.[0]?.code ?? null },
    stop_part: ctx.stopAllowed ? "allowed" : args.flags.has("no-stop") ? "skipped: --no-stop" : "skipped: the namespace holds keys that aren't the spike's, or a stop",
  });
}

async function deployedVersion() {
  const base = `${acc()}/workers/scripts/${config.content_worker}`;
  const dep = await api("GET", `${base}/deployments`, { token: "scripts" });
  const ver = await api("GET", `${base}/versions`, { token: "scripts" });
  const deployments = dep.json?.result?.deployments;
  const items = ver.json?.result?.items;
  const live = Array.isArray(deployments) ? deployments[0] : null;
  const liveIds = (live?.versions ?? []).map((v) => v.version_id);
  record("content-worker-version", {
    deployments: { ...answer(dep), shape: shapeOf(dep.json?.result, 4) },
    versions: { ...answer(ver), shape: shapeOf(ver.json?.result, 4) },
    // Compared in memory; no ID is kept.
    live: live ? { strategy: live.strategy, source: live.source, versions: (live.versions ?? []).map((v) => ({ percentage: v.percentage })) } : null,
    live_is_newest_version: Array.isArray(items) && items[0] ? liveIds.includes(items[0].id) : null,
  });
}

async function providerAnswers() {
  const missRead = await api("GET", kvPath(n.missingKey), { token: "kv" });
  const missDelete = await api("DELETE", kvPath(n.missingKey), { token: "kv" });
  record("kv-missing-key", { read: { ...answer(missRead), body_shape: shapeOf(missRead.json, 2) }, delete: answer(missDelete) });
}

async function bucketSizing() {
  const name = scriptName(n.sessionLabel, hex(16));
  named.add(name);
  const manifest = fullSizeManifest();
  const r = await api("POST", `${dispatchPath()}/${name}/assets-upload-session`, { token: "scripts", body: JSON.stringify({ manifest }), type: "application/json" });
  if (typeof r.json?.result?.jwt === "string") secrets.push(r.json.result.jwt);
  const sizeOf = Object.fromEntries(Object.values(manifest).map((m) => [m.hash, m.size]));
  const buckets = r.json?.result?.buckets;
  record("bucket-sizing", {
    ...answer(r),
    files: Object.keys(manifest).length,
    bytes: Object.values(manifest).reduce((s, m) => s + m.size, 0),
    buckets: Array.isArray(buckets) ? buckets.map((b) => ({ files: b.length, bytes: b.reduce((s, h) => s + (sizeOf[h] ?? 0), 0) })) : null,
    note: "never uploaded or completed: no script is made",
  });
}

async function probeWorker() {
  const sub = await api("GET", `${acc()}/workers/subdomain`, { token: "scripts" });
  const subdomain = sub.json?.result?.subdomain;
  record("workers-dev-subdomain", { ...answer(sub), present: typeof subdomain === "string" && subdomain.length > 0 });
  if (typeof subdomain !== "string" || !subdomain) return false;
  secrets.push(subdomain);
  probeKey = hex(16);
  secrets.push(probeKey);
  const source = readFileSync(join(HERE, "probe-worker.mjs"), "utf8")
    .replace("__SPIKE_G_KEY__", probeKey)
    .replace("__SPIKE_G_TXT_A__", n.txt.primed)
    .replace("__SPIKE_G_TXT_B__", n.txt.fresh);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "probe.mjs", compatibility_date: COMPATIBILITY_DATE })], { type: "application/json" }));
  form.append("probe.mjs", new Blob([source], { type: "application/javascript+module" }), "probe.mjs");
  const put = await api("PUT", `${acc()}/workers/scripts/${n.probe}`, { token: "scripts", body: form });
  record("probe-write", answer(put));
  if (put.status !== 200) return false;
  const on = await api("POST", `${acc()}/workers/scripts/${n.probe}/subdomain`, { token: "scripts", body: JSON.stringify({ enabled: true, previews_enabled: false }), type: "application/json" });
  record("probe-workers-dev", answer(on));
  probeUrl = `${n.probe}.${subdomain}.workers.dev`;
  const t0 = Date.now();
  while (alive() && Date.now() - t0 < 90_000) {
    const r = await edge(probeUrl, "/compress?nt=1", { "x-spike-g-key": probeKey }, "probe");
    if (r.status === 200) {
      record("probe-live", { after_ms: r.done - t0 });
      return true;
    }
    await sleep(2_000);
  }
  record("probe-live", { after_ms: null, note: "never answered" });
  return false;
}

async function probeJson(path) {
  const r = await edge(probeUrl, path, { "x-spike-g-key": probeKey }, "probe");
  let json = null;
  try {
    json = JSON.parse(r.raw?.toString("utf8") ?? "");
  } catch {}
  const title = r.raw?.toString("utf8").match(/<title>([^<]{0,200})<\/title>/i)?.[1];
  return { status: r.status, error: r.error, json, title, ms: r.done - r.sent, colo: colo(r) };
}

/** Each resolver's verdict on one name, read in the runner from what the probe returned. */
function verdicts(res, name, expected) {
  return (res.json?.answers ?? []).map((a) => ({ resolver: a.resolver, ms: a.ms, ...readDoh(a, name, expected), status: a.json?.Status, ad: a.json?.AD, authority_ttl: a.json?.Authority?.[0]?.TTL }));
}

async function txtHalf() {
  const fixed = {};
  for (const name of ["nothing-here-spike-g.invalid", "dnssec-failed.org", "www.github.com", "cloudflare.com"]) {
    const r = await probeJson(`/doh?name=${encodeURIComponent(name)}`);
    fixed[name] = { status: r.status, answers: verdicts(r, name, "\u0000none"), raw: r.json?.answers?.map((a) => ({ resolver: a.resolver, http: a.http, type: a.type, error: a.error, Status: a.json?.Status, TC: a.json?.TC, AD: a.json?.AD, answers: a.json?.Answer?.length, comment: a.json?.Comment })) };
  }
  record("doh-fixed-names", fixed);
  const timeout = await probeJson("/doh-timeout");
  record("doh-timeout", { status: timeout.status, answers: timeout.json?.answers });
  if (!tokens.dns) return record("txt", { note: "skipped: --no-dns" });

  const zone = await api("GET", `/zones?name=${encodeURIComponent(ctx.dnsZone)}`, { token: "dns" });
  const z = zone.json?.result?.[0];
  if (!z || z.name !== ctx.dnsZone) return record("txt", { note: "the DNS zone wasn't found with the DNS token", ...answer(zone) });
  ctx.dnsZoneId = z.id;
  const values = { [n.txt.primed]: `podster-spike-g=${hex(16)}`, [n.txt.fresh]: `podster-spike-g=${hex(16)}` };
  // The primed name is looked up before its record exists, as a premature check would.
  const before = await probeJson(`/doh?name=${encodeURIComponent(n.txt.primed)}`);
  record("txt-before", { name: n.txt.primed, answers: verdicts(before, n.txt.primed, values[n.txt.primed]) });
  const t0 = Date.now();
  for (const name of [n.txt.primed, n.txt.fresh]) {
    const r = await api("POST", `/zones/${ctx.dnsZoneId}/dns_records`, { token: "dns", body: JSON.stringify({ type: "TXT", name, content: values[name], ttl: 60 }), type: "application/json" });
    if (typeof r.json?.result?.id === "string") ctx.madeDns.add(r.json.result.id);
    record("txt-create", { name, ...answer(r), stored_content_quoted: String(r.json?.result?.content ?? "").startsWith('"') });
  }
  const follow = async (phase, t0, done) => {
    const series = [];
    while (alive() && Date.now() - t0 < 180_000) {
      const row = { at_ms: Date.now() - t0 };
      let finished = true;
      for (const name of [n.txt.primed, n.txt.fresh]) {
        const r = await probeJson(`/doh?name=${encodeURIComponent(name)}`);
        row[name === n.txt.primed ? "primed" : "fresh"] = verdicts(r, name, values[name]).map((v) => `${v.resolver}:${v.verdict}/${v.kind}`);
        if (!done(verdicts(r, name, values[name]))) finished = false;
      }
      series.push(row);
      if (finished) break;
      await sleep(3_000);
    }
    record(`txt-${phase}`, { series });
  };
  await follow("seen", t0, (vs) => vs.length > 0 && vs.every((v) => v.verdict === "found"));
  const t1 = Date.now();
  for (const id of [...ctx.madeDns]) {
    const r = await api("DELETE", `/zones/${ctx.dnsZoneId}/dns_records/${id}`, { token: "dns" });
    record("txt-delete", answer(r));
    if (r.status === 200) ctx.madeDns.delete(id);
  }
  await follow("gone", t1, (vs) => vs.length > 0 && vs.every((v) => v.verdict === "no-record"));
}

/** One cycle on one host: write v1, switch to v2, delete. Each watched at the host and read back through the API. */
async function cycle(label, scripts, tag) {
  const key = n.host(label);
  const expect = { v1: scripts.v1, v2: scripts.v2, stop: stopValue(RUN) };
  for (const [phase, method, body, target] of [
    ["write", "PUT", scripts.v1, "v1"],
    ["switch", "PUT", scripts.v2, "v2"],
    ["remove", "DELETE", null, "absent"],
  ]) {
    if (!alive()) return;
    const r = await api(method, kvPath(key), { token: "kv", body, type: body ? "text/plain" : null });
    const t0 = r.done;
    const [samples, back] = await settle([watch(label, target, t0), readBack(key, t0, expect)]);
    record("takedown", {
      label: tag,
      phase,
      provider: { ...answer(r), result: r.json?.result ?? null },
      at_host: timeline(samples, target, t0),
      colos: [...new Set(samples.map((s) => s.colo).filter(Boolean))],
      read_back: back,
    });
  }
}

/**
 * Deletes the stop key only if a read just now found a spike's value there. The guard refuses the delete without that
 * read (`ctx.stopReadSpike`), and the flag is spent by the one delete. Anything else there is left, and reported.
 */
async function deleteStopIfOurs(step, { cleanup = false, retry404 = false } = {}) {
  // Right after the spike's own write, a read can still miss it. In the run, a 404 is read again over about 10 s
  // before the stop's removal goes unmeasured; the clean-up takes it at once and lists again at its end.
  let read = await api("GET", kvPath(STOP_KEY), { token: "kv", cleanup });
  const reads = [read.status];
  for (let i = 0; retry404 && read.status === 404 && i < 4 && alive(); i++) {
    await sleep(2_500);
    read = await api("GET", kvPath(STOP_KEY), { token: "kv", cleanup });
    reads.push(read.status);
  }
  if (read.status === 404) {
    record(step, { read: answer(read), reads, deleted: false, note: "absent" });
    return null;
  }
  if (read.status !== 200 || !isSpikeStop(read.text)) {
    record(step, { read: answer(read), deleted: false, note: read.status === 200 ? "not a spike's value: left in place" : "unreadable: left in place" });
    return null;
  }
  ctx.stopReadSpike = true;
  try {
    const del = await api("DELETE", kvPath(STOP_KEY), { token: "kv", cleanup });
    record(step, { read: answer(read), reads, deleted: del.status === 200, delete: { ...answer(del), result: del.json?.result ?? null } });
    return del;
  } finally {
    ctx.stopReadSpike = false;
  }
}

async function stopPart(label, scripts) {
  if (!ctx.stopAllowed) return;
  const key = n.host(label);
  const w = await api("PUT", kvPath(key), { token: "kv", body: scripts.v1, type: "text/plain" });
  const seen = await watch(label, "v1", w.done);
  record("stop-setup", { provider: answer(w), at_host: timeline(seen, "v1", w.done) });
  const expect = { v1: scripts.v1, v2: scripts.v2, stop: stopValue(RUN) };
  // The gate again, right before the write: anything that isn't the spike's that appeared since closes it.
  await gate();
  if (!ctx.stopAllowed) {
    record("stop-skipped", { note: "the gate closed before the stop's write" });
    await api("DELETE", kvPath(key), { token: "kv" });
    return;
  }
  // If the write's answer is lost, the clean-up still reads the key and removes it if it holds the spike's value.
  const put = await api("PUT", kvPath(STOP_KEY), { token: "kv", body: stopValue(RUN), type: "text/plain" });
  const [down, backSet] = await settle([watch(label, "absent", put.done), readBack(STOP_KEY, put.done, expect)]);
  record("stop-set", { provider: { ...answer(put), result: put.json?.result ?? null }, at_host: timeline(down, "absent", put.done), read_back: backSet });
  ctx.stopAllowed = false; // one write of the stop, no more
  const del = await deleteStopIfOurs("stop-delete", { retry404: true });
  if (del) {
    const [up, backGone] = await settle([watch(label, "v1", del.done), readBack(STOP_KEY, del.done, expect)]);
    record("stop-removed", { at_host: timeline(up, "v1", del.done), read_back: backGone });
  }
  await api("DELETE", kvPath(key), { token: "kv" });
}

async function takedown(scripts) {
  const cold = n.cold.map((label) => cycle(label, scripts[label], "cold"));
  const warm = (async () => {
    const primed = [];
    for (let i = 0; i < 3; i++) primed.push((await readMarker(n.warm)).state);
    record("warm-primed", { states: primed });
    for (let i = 0; i < 3 && alive(); i++) await cycle(n.warm, scripts[n.warm], `warm-${i + 1}`);
    await stopPart(n.warm, scripts[n.warm]);
  })();
  await settle([...cold, warm]);
}

async function contentChecks(scripts) {
  const label = n.cold[0];
  const w = await api("PUT", kvPath(n.host(label)), { token: "kv", body: scripts[label].v1, type: "text/plain" });
  const seen = await watch(label, "v1", w.done);
  if (!seen.some((s) => s.state === "v1")) return record("content-checks", { note: "the host never served v1" });
  const host = n.host(label);
  const enc = {};
  for (const ae of ["gzip, br", "gzip", "identity"]) {
    const r = await edge(host, "/big.txt", { "accept-encoding": ae });
    enc[ae] = { status: r.status, content_encoding: r.headers?.["content-encoding"] ?? null, cache_control: r.headers?.["cache-control"], bytes_on_wire: r.size };
  }
  const plainFiles = {};
  for (const path of ["/_headers", "/_redirects", "/spike-g-from", `/${MARKER_PATH}`]) {
    const r = await edge(host, path);
    plainFiles[path] = { status: r.status, content_type: r.headers?.["content-type"], location: r.headers?.location ?? null, bytes: r.size };
  }
  record("content-checks", { compression_via_content_worker: enc, root_files: plainFiles });
  await api("DELETE", kvPath(host), { token: "kv" });
}

async function probeChecks() {
  const enc = {};
  for (const nt of ["0", "1"]) {
    const r = await edge(probeUrl, `/compress?nt=${nt}`, { "x-spike-g-key": probeKey, "accept-encoding": "gzip, br" }, "probe");
    enc[`no_transform_${nt}`] = { status: r.status, content_encoding: r.headers?.["content-encoding"] ?? null, bytes_on_wire: r.size };
  }
  record("compression-via-workers-dev", enc);
  for (const c of [1, 2, 3, 4, 5]) {
    if (!alive()) break;
    const r = await probeJson(`/memory?case=${c}`);
    record("memory", { case: c, status: r.status, error: r.error, result: r.json, platform_error: r.title ?? null, ms: r.ms });
    if (r.status !== 200) break;
  }
}

async function lists() {
  for (const key of n.listKeys) await api("PUT", kvPath(key), { token: "kv", body: "spike-g list key", type: "text/plain" });
  const pages = [];
  let cursor = "";
  for (let i = 0; i < 6; i++) {
    const q = new URLSearchParams({ prefix: `spikeg${RUN}l`, limit: "10", ...(cursor ? { cursor } : {}) });
    const r = await api("GET", `${acc()}/storage/kv/namespaces/${ctx.kv}/keys?${q}`, { token: "kv" });
    pages.push({ ...answer(r), keys: r.json?.result?.length, entry: shapeOf(r.json?.result?.[0], 2), result_info: shapeOf(r.json?.result_info, 2), cursor_length: r.json?.result_info?.cursor?.length ?? null });
    cursor = r.json?.result_info?.cursor ?? "";
    if (!cursor) break;
  }
  const small = await api("GET", `${acc()}/storage/kv/namespaces/${ctx.kv}/keys?limit=5&prefix=spikeg${RUN}l`, { token: "kv" });
  record("kv-list", { pages, limit_5: { ...answer(small), keys: small.json?.result?.length } });

  const listing = {};
  for (const q of ["", "?per_page=2", "?per_page=2&page=2", "?page=2", "?limit=2"]) {
    const r = await api("GET", `${dispatchPath()}${q}`, { token: "scripts" });
    const ids = Array.isArray(r.json?.result) ? r.json.result.map((s) => s.id) : [];
    listing[q || "(none)"] = { ...answer(r), scripts: ids.length, spike: ids.filter((id) => SPIKE_SCRIPT.test(id)).length, entry: shapeOf(r.json?.result?.[0], 1), result_info: r.json?.result_info ?? null };
  }
  record("scripts-list", listing);
}

// ---- clean-up, by listing ----

/**
 * Every entry of a Cloudflare list, page after page: by `cursor` when the answer gives one, else by `page` while
 * `total_pages` says there are more. At most 50 pages; `complete` is false if that ran out or an answer failed.
 */
async function listAll(path, token, { perPage = null } = {}) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  let query = perPage ? `${sep}per_page=${perPage}` : "";
  for (let page = 1; page <= 50; page++) {
    const r = await api("GET", `${path}${query}`, { token, cleanup: true });
    if (r.status !== 200 || !Array.isArray(r.json?.result)) return { items: out, complete: false, info: r.json?.result_info ?? null };
    out.push(...r.json.result);
    const info = r.json.result_info ?? {};
    const pp = perPage ? `&per_page=${perPage}` : "";
    if (typeof info.cursor === "string" && info.cursor) query = `${sep}cursor=${encodeURIComponent(info.cursor)}${pp}`;
    else if (typeof info.total_pages === "number" && page < info.total_pages) query = `${sep}page=${page + 1}${pp}`;
    else return { items: out, complete: true, info };
    if (r.json.result.length === 0) return { items: out, complete: false, info };
  }
  return { items: out, complete: false, info: null };
}

const txtRecords = () => listAll(`/zones/${ctx.dnsZoneId}/dns_records?type=TXT`, "dns", { perPage: 100 });

async function cleanup() {
  const left = {};
  // The stop first: if the clean-up's bound runs out later, the content domain is never left dark by the spike.
  await deleteStopIfOurs("cleanup-stop", { cleanup: true });
  const kvKeys = await allKeys("spikeg", true);
  for (const k of kvKeys.keys ?? []) if (spikeKey(k, ctx.domain)) await api("DELETE", kvPath(k), { token: "kv", cleanup: true });
  if (tokens.scripts) {
    const listed = await listAll(dispatchPath(), "scripts");
    for (const s of listed.items) if (SPIKE_SCRIPT.test(s.id)) named.add(s.id);
    for (const name of named) await api("DELETE", `${dispatchPath()}/${name}?force=true`, { token: "scripts", cleanup: true });
    const workers = await listAll(`${acc()}/workers/scripts`, "scripts");
    for (const s of workers.items) if (PROBE_SCRIPT.test(s.id)) await api("DELETE", `${acc()}/workers/scripts/${s.id}`, { token: "scripts", cleanup: true });
  }
  if (tokens.dns) {
    if (!ctx.dnsZoneId) {
      const zone = await api("GET", `/zones?name=${encodeURIComponent(ctx.dnsZone)}`, { token: "dns", cleanup: true });
      if (zone.json?.result?.[0]?.name === ctx.dnsZone) ctx.dnsZoneId = zone.json.result[0].id;
    }
    if (ctx.dnsZoneId) {
      const recs = await txtRecords();
      for (const r of recs.items) if (spikeTxtName(r.name, ctx.dnsZone)) ctx.madeDns.add(r.id);
      for (const id of [...ctx.madeDns]) {
        const d = await api("DELETE", `/zones/${ctx.dnsZoneId}/dns_records/${id}`, { token: "dns", cleanup: true });
        if (d.status === 200 || d.status === 404) ctx.madeDns.delete(id);
      }
    }
  }
  await new Promise((r) => setTimeout(r, 5_000));
  // Listed again: what is left. A list that didn't finish is reported as such, never as nothing left.
  const after = await allKeys("spikeg", true);
  left.kv_spike_keys = after.keys && !after.incomplete ? after.keys.filter((k) => spikeKey(k, ctx.domain)).length : "not fully listed";
  const stopAfter = await api("GET", kvPath(STOP_KEY), { token: "kv", cleanup: true });
  left.stop_key = stopAfter.status === 404 ? "absent" : stopAfter.status === 200 ? (isSpikeStop(stopAfter.text) ? "the spike's, still there" : "someone else's, not touched") : `unknown (${stopAfter.status})`;
  if (tokens.scripts) {
    const listed = await listAll(dispatchPath(), "scripts");
    left.spike_scripts = listed.complete ? listed.items.filter((s) => SPIKE_SCRIPT.test(s.id)).length : "not fully listed";
    left.scripts_list_info = listed.info;
    let readable = 0;
    for (const name of named) {
      const r = await api("GET", `${dispatchPath()}/${name}`, { token: "scripts", cleanup: true });
      if (!(r.status === 200 && r.json?.result?.script === null) && r.status !== 404) readable++;
    }
    left.named_scripts_still_readable = readable;
    const workers = await listAll(`${acc()}/workers/scripts`, "scripts");
    left.probe_workers = workers.complete ? workers.items.filter((s) => PROBE_SCRIPT.test(s.id)).length : "not fully listed";
  } else left.scripts = "not checked: no scripts token";
  if (tokens.dns && ctx.dnsZoneId) {
    const recs = await txtRecords();
    left.txt_records = recs.complete ? recs.items.filter((r) => spikeTxtName(r.name, ctx.dnsZone)).length : "not fully listed";
  } else left.txt_records = "not checked";
  const clean = Object.entries(left).every(
    ([k, v]) => k === "scripts_list_info" || v === 0 || v === "absent" || v === "someone else's, not touched" || String(v).startsWith("not checked"),
  );
  record("cleanup", { left, clean, calls: cleanupUse.api });
  return clean;
}

// ---- commands ----

async function run() {
  await preflight();
  await gate();
  await deployedVersion();
  await providerAnswers();
  const scripts = {};
  let first = true;
  for (const label of n.takedown) {
    scripts[label] = { v1: await uploadRelease(label, "v1", first), v2: await uploadRelease(label, "v2", false) };
    first = false;
    if (!alive()) return;
  }
  await bucketSizing();
  const probe = await probeWorker();
  await settle([takedown(scripts), probe ? txtHalf() : Promise.resolve(record("txt", { note: "skipped: no probe Worker" }))]);
  if (alive()) await contentChecks(scripts);
  if (alive() && probe) await probeChecks();
  if (alive()) await lists();
}

async function cursorRun() {
  for (const key of n.listKeys) await api("PUT", kvPath(key), { token: "kv", body: "spike-g list key", type: "text/plain" });
  const list = (cursor) => api("GET", `${acc()}/storage/kv/namespaces/${ctx.kv}/keys?${new URLSearchParams({ prefix: `spikeg${RUN}l`, limit: "10", ...(cursor ? { cursor } : {}) })}`, { token: "kv" });
  const first = await list("");
  const cursor = first.json?.result_info?.cursor;
  if (!cursor) return record("cursor", { note: "the first page gave no cursor", ...answer(first), keys: first.json?.result?.length });
  const t0 = first.done;
  let expected = null;
  for (const age of CURSOR_AGES_MS) {
    await sleep(t0 + age - Date.now());
    if (!alive()) break;
    const r = await list(cursor);
    const keys = r.json?.result?.map((k) => k.name) ?? null;
    expected ??= keys;
    record("cursor-use", { age_ms: r.sent - t0, ...answer(r), keys: keys?.length ?? null, same_page: keys && expected ? keys.join() === expected.join() : null, next_cursor: !!r.json?.result_info?.cursor });
  }
}

let code = 0;
try {
  record("start", { bounds, stop_part: args.flags.has("no-stop") ? "off" : "if the gate allows", dns: !!tokens.dns });
  if (args.command === "run") await run();
  else if (args.command === "cursor") await cursorRun();
} catch (e) {
  code = 1;
  stopAll(e.message);
  record("stopped", { reason: e instanceof Bound ? `bound: ${e.message}` : e.message });
}
if (stopping) record("stopped", { reason: stopping });
try {
  if (!(await cleanup())) code = code || 3;
} catch (e) {
  code = 3;
  record("cleanup-failed", { reason: e.message, next: "run `node spike.mjs cleanup` with the same files" });
}
record("end", { used, ms: Date.now() - started });
process.exit(code);
