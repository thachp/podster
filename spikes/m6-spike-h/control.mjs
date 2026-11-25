#!/usr/bin/env node
// M6 spike H, item 3's control (the owner's "Run the control", 2026-11-24). See README.md, "The control".
//
// One throwaway Worker on the second account, `spikeh-ctl-<run>`, binds the dispatch namespace twice: `WITH_OUTBOUND`
// names the deployed `podster-outbound` as its outbound Worker, `NO_OUTBOUND` names none. Through each it asks one
// test script in the namespace for the same probe item 3 ran (`/spike-h/outbound`: three fetches, four sockets). If
// the outbound Worker is what stops them, the probe through `NO_OUTBOUND` reaches the network and the one through
// `WITH_OUTBOUND` doesn't. The control Worker is reached on the account's existing workers.dev address only, and
// answers only a request carrying a random key it holds; it is deleted at the end with the script.
//
//   node control.mjs run --config <file> --scripts-token-file <file>
//   node control.mjs cleanup --config <file> --scripts-token-file <file>
//
// Exit 0 when the control held and nothing was left; 1 when it didn't hold or couldn't run; 2 for a refused
// configuration or a failed preflight; 3 when the clean-up left something. Nothing touches podster-content,
// podster-outbound (only named as an outbound Worker and its deployments read), DNS, routes, KV or secrets.

import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allow } from "./guard.mjs";
import { API_QUERY, COMPATIBILITY_DATE, CONTROL_WORKER, MAIN_MODULE, MODULE_TYPE, SPIKE_SCRIPT, judgeControl, moduleSource, names, redact, scriptName, shapeOf } from "./pure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const RUN = randomBytes(3).toString("hex");
const command = process.argv[2];
const RESULTS = join(HERE, "results", `control-${command}.jsonl`);
const SUMMARY = join(HERE, "results", `control-summary-${RUN}.json`);
const WORKER = `spikeh-ctl-${RUN}`;
const BOUND = { ms: 10 * 60_000, api: 80, edge: 200 };

const option = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (command !== "run" && command !== "cleanup") {
  console.error("usage: node control.mjs <run|cleanup> --config <file> --scripts-token-file <file>");
  process.exit(2);
}

const secrets = [];
function plainFile(path, what) {
  if (!path) throw new Error(`${what} is required`);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`${what}: no file at that path`);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${what}: must be a plain file, not a link`);
  if (st.mode & 0o077) throw new Error(`${what}: must be mode 600`);
}
let config;
let token;
try {
  plainFile(option("config"), "--config");
  config = JSON.parse(readFileSync(option("config"), "utf8"));
  if (!/^[0-9a-f]{32}$/.test(config.account_id ?? "") || !/^[a-z0-9-]{1,63}$/.test(config.dispatch_namespace ?? "")) throw new Error("--config: needs account_id and dispatch_namespace");
  plainFile(option("scripts-token-file"), "--scripts-token-file");
  const raw = readFileSync(option("scripts-token-file"), "utf8");
  token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error("--scripts-token-file: must hold one token on one line");
} catch (e) {
  console.error(`spike H control: refusing: ${e.message}`);
  process.exit(2);
}
const KEY = randomBytes(24).toString("hex");
secrets.push(token, config.account_id, config.dispatch_namespace, KEY);
if (config.kv_namespace_id) secrets.push(config.kv_namespace_id);
const ctx = { account: config.account_id, kv: config.kv_namespace_id, ns: config.dispatch_namespace, domain: config.content_domain, run: RUN, madeDb: new Set() };

mkdirSync(dirname(RESULTS), { recursive: true });
function record(step, data = {}) {
  const line = redact(JSON.stringify({ run: RUN, command, at: new Date().toISOString(), step, ...data }), secrets);
  appendFileSync(RESULTS, `${line}\n`);
  console.log(line);
}

const started = Date.now();
const used = { api: 0, edge: 0 };
let cleaning = false;
let stopping = null;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = "signal";
});
process.on("SIGTERM", () => (stopping = "signal"));
function spend(kind) {
  if (cleaning) return;
  if (stopping) throw new Error(`stopping (${stopping})`);
  if (Date.now() - started > BOUND.ms) throw new Error("the time bound");
  if (++used[kind] > BOUND[kind]) throw new Error(`the ${kind} bound`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codes = (json) => (Array.isArray(json?.errors) ? json.errors.map((e) => ({ code: e.code, message: String(e.message).slice(0, 300) })) : null);
const acc = () => `/accounts/${ctx.account}`;
const dispatchPath = () => `${acc()}/workers/dispatch/namespaces/${ctx.ns}/scripts`;

async function api(method, path, { body = null, type = null } = {}) {
  const url = `${API}${path}`;
  allow(method, url, typeof body === "string" ? body : null, ctx);
  spend("api");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
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

/** The control Worker's module. It answers only a request carrying its key, and only `?via=a` or `?via=b`. */
const CONTROL_SOURCE = `export default {
  async fetch(request, env) {
    if (request.headers.get("x-spike-h-key") !== env.KEY) return new Response("not found\\n", { status: 404 });
    const via = new URL(request.url).searchParams.get("via");
    const ns = via === "a" ? env.WITH_OUTBOUND : via === "b" ? env.NO_OUTBOUND : null;
    if (!ns) return new Response("no such via\\n", { status: 400 });
    try {
      const r = await ns.get(env.SCRIPT).fetch(new Request("https://spike-h.invalid/spike-h/outbound"));
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ dispatch_error: String(e && e.message).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } });
    }
  },
};
`;

const named = new Set();
const verdicts = {};

async function run() {
  record("start", { bound: BOUND, worker: WORKER });
  const v = await api("GET", "/user/tokens/verify");
  record("token-verify", { ...answer(v), state: v.json?.result?.status ?? null });
  if (v.json?.result?.status !== "active") return 2;
  for (const w of ["podster-content", "podster-outbound"]) {
    const r = await api("GET", `${acc()}/workers/scripts/${w}/deployments`);
    const live = r.json?.result?.deployments?.[0];
    record("deployed-version", { worker: w, ...answer(r), versions: Array.isArray(live?.versions) ? live.versions.map((x) => ({ version: String(x.version_id).slice(0, 8), percentage: x.percentage })) : null });
  }
  const sub = await api("GET", `${acc()}/workers/subdomain`);
  const subdomain = sub.json?.result?.subdomain;
  if (typeof subdomain === "string") secrets.push(subdomain);
  record("workers-dev-subdomain", { ...answer(sub), exists: typeof subdomain === "string" });
  if (typeof subdomain !== "string") {
    verdicts.control = { holds: false, not_run: true, failed: ["the account has no workers.dev subdomain; the spike never makes one"] };
    return 1;
  }

  // The test script in the namespace: item 3's module, no assets, no binding, the API's query.
  const script = scriptName(names(RUN, "podster.site").label.marker, randomBytes(16).toString("hex"));
  named.add(script);
  const sform = new FormData();
  sform.append("metadata", new Blob([JSON.stringify({ main_module: MAIN_MODULE, bindings: [], compatibility_date: COMPATIBILITY_DATE, compatibility_flags: [] })], { type: "application/json" }));
  sform.append(MAIN_MODULE, new Blob([moduleSource("ctl")], { type: MODULE_TYPE }), MAIN_MODULE);
  const sput = await api("PUT", `${dispatchPath()}/${script}${API_QUERY}`, { body: sform });
  record("script-write", { ...answer(sput), ok: sput.json?.result?.id === script });
  if (sput.json?.result?.id !== script) return 1;

  // The control Worker: the namespace twice, one with podster-outbound as outbound and one with none.
  const bindings = [
    { type: "dispatch_namespace", name: "WITH_OUTBOUND", namespace: ctx.ns, outbound: { worker: { service: "podster-outbound" } } },
    { type: "dispatch_namespace", name: "NO_OUTBOUND", namespace: ctx.ns },
    { type: "secret_text", name: "KEY", text: KEY },
    { type: "plain_text", name: "SCRIPT", text: script },
  ];
  // Checked before it is sent, since the guard can't read a form: only these four, on this namespace.
  if (bindings.some((b) => b.type === "dispatch_namespace" && b.namespace !== ctx.ns) || bindings.length !== 4) throw new Error("refusing: the control's bindings");
  const wform = new FormData();
  wform.append("metadata", new Blob([JSON.stringify({ main_module: "control.js", bindings, compatibility_date: COMPATIBILITY_DATE, compatibility_flags: [] })], { type: "application/json" }));
  wform.append("control.js", new Blob([CONTROL_SOURCE], { type: MODULE_TYPE }), "control.js");
  const wput = await api("PUT", `${acc()}/workers/scripts/${WORKER}`, { body: wform });
  record("control-write", { ...answer(wput), ok: wput.status === 200 && wput.json?.success === true, result: shapeOf(wput.json?.result, 1) });
  if (!(wput.status === 200 && wput.json?.success === true)) {
    verdicts.control = { holds: false, not_run: true, failed: [`the control Worker wasn't written: ${JSON.stringify(codes(wput.json))}`] };
    return 1;
  }
  const on = await api("POST", `${acc()}/workers/scripts/${WORKER}/subdomain`, { body: JSON.stringify({ enabled: true, previews_enabled: false }), type: "application/json" });
  record("control-workers-dev-on", answer(on));

  // Reach it, through each binding. Wait for the address to answer first.
  const base = `https://${WORKER}.${subdomain}.workers.dev/`;
  const ask = async (via) => {
    spend("edge");
    const t = Date.now();
    try {
      const r = await fetch(`${base}?via=${via}`, { headers: { "x-spike-h-key": KEY, "user-agent": "podster-spike-h" }, signal: AbortSignal.timeout(60_000) });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, json, ms: Date.now() - t };
    } catch (e) {
      return { status: 0, error: e?.name, ms: Date.now() - t };
    }
  };
  let first = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    first = await ask("a");
    if (first.status === 200 && first.json?.source === "worker") break;
    await sleep(2_000);
  }
  record("control-live", { status: first?.status, after_ms: Date.now() - t0 });
  const probes = { a: first?.json ?? null, b: (await ask("b")).json };
  const again = { a: (await ask("a")).json, b: (await ask("b")).json };
  for (const [via, p] of Object.entries(probes)) record(`probe-${via}`, { via, with_outbound: via === "a", probe: p });
  for (const [via, p] of Object.entries(again)) record(`probe-${via}-again`, { via, with_outbound: via === "a", probe: p });
  verdicts.control = judgeControl(probes);
  verdicts.control_again = judgeControl(again);
  record("control-verdict", { first: verdicts.control, again: verdicts.control_again });
  return verdicts.control.holds && verdicts.control_again.holds ? 0 : 1;
}

async function cleanup() {
  cleaning = true;
  const left = {};
  try {
    const workers = await api("GET", `${acc()}/workers/scripts`);
    const controls = new Set([WORKER]);
    for (const s of workers.json?.result ?? []) if (CONTROL_WORKER.test(s.id ?? "")) controls.add(s.id);
    for (const w of controls) record("control-delete", { ...answer(await api("DELETE", `${acc()}/workers/scripts/${w}`)) });
    const ns = await api("GET", dispatchPath());
    for (const s of ns.json?.result ?? []) if (SPIKE_SCRIPT.test(s.id)) named.add(s.id);
    for (const name of named) record("script-delete", answer(await api("DELETE", `${dispatchPath()}/${name}?force=true`)));
    await sleep(5_000);
    const reads = [];
    let controlsLeft = 0;
    for (const w of controls) {
      const r = await api("GET", `${acc()}/workers/scripts/${w}`);
      reads.push({ worker: true, status: r.status, code: codes(r.json)?.[0]?.code ?? null });
      if (r.status !== 404) controlsLeft++;
    }
    left.control_workers_readable = controlsLeft;
    const wAfter = await api("GET", `${acc()}/workers/scripts`);
    left.control_workers_listed = wAfter.status === 200 && Array.isArray(wAfter.json?.result) ? wAfter.json.result.filter((s) => CONTROL_WORKER.test(s.id ?? "")).length : "not listed";
    let scriptsLeft = 0;
    for (const name of named) {
      const r = await api("GET", `${dispatchPath()}/${name}`);
      const gone = (r.status === 200 && r.json?.result?.script === null) || (r.status === 404 && codes(r.json)?.[0]?.code === 10007);
      reads.push({ script: true, status: r.status, script_null: r.json?.result?.script === null, gone });
      if (!gone) scriptsLeft++;
    }
    left.scripts_readable = scriptsLeft;
    const nsAfter = await api("GET", dispatchPath());
    left.scripts_listed = nsAfter.status === 200 && Array.isArray(nsAfter.json?.result) ? nsAfter.json.result.filter((s) => SPIKE_SCRIPT.test(s.id)).length : "not listed";
    const clean = Object.values(left).every((x) => x === 0);
    record("cleanup", { left, clean, reads, controls: controls.size, scripts: named.size });
    return clean;
  } catch (e) {
    record("cleanup-error", { error: e.message });
    return false;
  }
}

let code = 0;
try {
  if (command === "run") code = await run();
} catch (e) {
  record("error", { error: String(e?.message ?? e) });
  code = 1;
} finally {
  const clean = await cleanup();
  if (command === "run") writeFileSync(SUMMARY, `${redact(JSON.stringify({ run: RUN, at: new Date().toISOString(), verdicts, clean, calls: used }, null, 2), secrets)}\n`);
  if (!clean) code = 3;
}
process.exit(code);
