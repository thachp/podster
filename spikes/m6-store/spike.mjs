#!/usr/bin/env node
// M6 stage 1: the spike for a store and its credential. What a token that can make a KV namespace or a D1
// database can also reach, what binding a store to an upload needs, what an app's code sees of its store, and
// what one write costs.
//
// Spike only. It holds tokens that can change every Worker, KV namespace and D1 database on the account, so:
// - every request to Cloudflare's API goes through `send`, and `send` asks guard.mjs first. Nothing but a GET
//   leaves this process unless it names something this spike made, under ^spike-store-[a-z0-9-]{1,40}$;
// - a token is read into memory from the owner's file, sent in a header and nowhere else. It is never printed,
//   logged, written or put on a command line;
// - what is recorded is a status, Cloudflare's error codes and messages, counts, and what the spike's own apps
//   answer. Every 32-hex ID, every UUID, the account and the workers.dev subdomain are redacted before anything
//   is kept or shown.
// See README.md.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACE, allow, spikeNamed } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const TOKEN_DIR = join(homedir(), ".podster");
const RESULTS = join(HERE, "results", "results.jsonl");
const WHICH = ["kv", "d1", "scripts", "read"];
const COMPAT = "2026-11-01";

if (!/^[0-9a-f]{32}$/.test(ACCOUNT)) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID to the ID of the staging account. Refusing to run without it.");
  process.exit(2);
}

const RUN = randomBytes(3).toString("hex");
const N = (suffix) => {
  const name = `spike-store-${RUN}-${suffix}`;
  if (!spikeNamed(name)) throw new Error(`not a spike name: ${suffix}`);
  return name;
};

// ---- secrets, held in memory only ----

const secrets = new Set();
const KEY = randomBytes(24).toString("hex"); // the dispatch Worker answers only a request carrying this
secrets.add(KEY);
let subdomain = null; // the account's workers.dev subdomain, in memory only

function readTokens() {
  const tokens = {};
  for (const which of WHICH) {
    const file = join(TOKEN_DIR, `spike-store-${which}.token`);
    if (statSync(file).mode & 0o077) throw new Error(`${which}: the token file must be mode 600`);
    const token = readFileSync(file, "utf8").trim();
    if (!/^[\x21-\x7e]{20,}$/.test(token)) throw new Error(`${which}: the token file doesn't hold one token`);
    tokens[which] = token;
    secrets.add(token);
  }
  return tokens;
}

function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.replaceAll(secret, "<secret>");
  out = out.replaceAll(ACCOUNT, "<account>");
  if (subdomain) out = out.replaceAll(subdomain, "<subdomain>");
  return out
    .replace(/\b[0-9a-f]{32}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "<email>");
}

function record(entry) {
  mkdirSync(dirname(RESULTS), { recursive: true });
  const line = redact(JSON.stringify({ at: new Date().toISOString(), run: RUN, ...entry }));
  appendFileSync(RESULTS, line + "\n");
  console.log(line);
}

// ---- the one request function ----

const made = { kv: new Set(), d1: new Set() };

async function send(bearer, method, path, { json, text, form } = {}) {
  let body;
  const headers = { authorization: `Bearer ${bearer}` };
  let bodyText = null;
  if (json !== undefined) [headers["content-type"], body, bodyText] = ["application/json", JSON.stringify(json), JSON.stringify(json)];
  if (text !== undefined) [headers["content-type"], body] = ["text/plain", text];
  if (form !== undefined) body = form;
  const url = allow(method, API + path, ACCOUNT, { body: bodyText, made });
  const response = await fetch(url, { method, headers, body, redirect: "error" });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  return { status: response.status, body: parsed, text: raw };
}

const errorsOf = (body) => (body && Array.isArray(body.errors) ? body.errors.map((e) => ({ code: e.code, message: String(e.message ?? "").slice(0, 200) })) : []);

/** One recorded call. `keep` is a function of the answer giving what may be kept besides status and codes. */
async function call(who, tokens, op, method, path, { json, text, form, keep } = {}) {
  let answer;
  try {
    answer = await send(tokens[who], method, path, { json, text, form });
  } catch (error) {
    record({ token: who, op, method, path, refused_or_failed: String(error.message).slice(0, 200) });
    return { status: 0, body: null, text: "" };
  }
  const errors = errorsOf(answer.body);
  const entry = { token: who, op, method, path, status: answer.status, success: answer.body?.success ?? null, codes: errors.map((e) => e.code) };
  if (errors.length) entry.messages = errors.map((e) => e.message);
  if (keep) {
    try {
      Object.assign(entry, keep(answer));
    } catch {}
  }
  record(entry);
  return answer;
}

async function listAll(tokens, who, path) {
  const items = [];
  let status = 0;
  let codes = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const answer = await send(tokens[who], "GET", `${path}${sep}page=${page}&per_page=100`);
    status = answer.status;
    codes = errorsOf(answer.body).map((e) => e.code);
    const result = answer.body?.result;
    if (!Array.isArray(result)) break;
    items.push(...result);
    if (result.length < 100) break;
  }
  return { status, codes, items };
}

const account = `/accounts/${ACCOUNT}`;
const kvPath = (id = "") => `${account}/storage/kv/namespaces${id ? `/${id}` : ""}`;
const d1Path = (id = "") => `${account}/d1/database${id ? `/${id}` : ""}`;
const inNamespace = (name) => `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${name}`;
const atAccount = (name) => `${account}/workers/scripts/${name}`;

// ---- what is uploaded ----

// The control for the subrequest limit: plain fetch() subrequests, which the limit is documented to count. To a
// reserved example domain, HEAD only.
const CONTROL = `
async function control(url) {
  const n = Math.min(Number(url.searchParams.get("n") || 1), 5);
  let ok = 0, error = null;
  for (let i = 0; i < n; i++) {
    try {
      await fetch("https://example.com/", { method: "HEAD" });
      ok++;
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 300);
      break;
    }
  }
  return { ok, error };
}
`;

const KV_APP = `
const json = (o, s = 200) => Response.json(o, { status: s });
function describe(env) {
  const s = env.STORE;
  const proto = s ? Object.getPrototypeOf(s) : null;
  return {
    env_keys: Object.keys(env).sort(),
    store_kind: s ? Object.prototype.toString.call(s) + " " + (s.constructor && s.constructor.name) : typeof s,
    store_methods: proto ? Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").sort() : [],
    caches_default: typeof caches !== "undefined" && caches.default ? "present" : "absent",
  };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const op = url.pathname.split("/")[1];
    try {
      if (op === "env") return json(describe(env));
      if (op === "list") {
        const listed = await env.STORE.list();
        const names = listed.keys.map((k) => k.name);
        return json({ count: names.length, named: names.filter((n) => n.startsWith("spike-store-marker") || n.startsWith("spike-store-from")).sort() });
      }
      if (op === "put") {
        const n = Math.min(Number(url.searchParams.get("n") || 1), 50);
        const ms = [];
        let ok = 0, error = null;
        for (let i = 0; i < n; i++) {
          const t = Date.now();
          try {
            await env.STORE.put("spike-store-w-" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 8), "v");
            ok++;
            ms.push(Date.now() - t);
          } catch (e) {
            error = String((e && e.message) || e).slice(0, 300);
            break;
          }
        }
        return json({ ok, ms, error });
      }
      if (op === "fetch") return json(await control(url));
      return json({ error: "no such op" }, 404);
    } catch (e) {
      return json({ thrown: String((e && e.message) || e).slice(0, 300) }, 500);
    }
  },
};
${CONTROL}
`;

const D1_APP = `
const json = (o, s = 200) => Response.json(o, { status: s });
const err = (e) => String((e && e.message) || e).slice(0, 300);
function describe(env) {
  const s = env.STORE;
  const proto = s ? Object.getPrototypeOf(s) : null;
  return {
    env_keys: Object.keys(env).sort(),
    store_kind: s ? Object.prototype.toString.call(s) + " " + (s.constructor && s.constructor.name) : typeof s,
    store_methods: proto ? Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").sort() : [],
    caches_default: typeof caches !== "undefined" && caches.default ? "present" : "absent",
  };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const op = url.pathname.split("/")[1];
    try {
      if (op === "env") return json(describe(env));
      if (op === "list") {
        const { results } = await env.STORE.prepare("SELECT k FROM t").all();
        const names = results.map((r) => r.k);
        return json({ count: names.length, named: names.filter((n) => n.startsWith("spike-store-marker") || n.startsWith("spike-store-from")).sort() });
      }
      if (op === "schema") {
        const out = {};
        try { out.tables = (await env.STORE.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).results.map((r) => r.name); } catch (e) { out.tables_error = err(e); }
        try { out.database_list = (await env.STORE.prepare("PRAGMA database_list").all()).results.map((r) => r.name); } catch (e) { out.database_list_error = err(e); }
        try { await env.STORE.prepare("ATTACH DATABASE 'other.db' AS other").run(); out.attach = "allowed"; } catch (e) { out.attach_error = err(e); }
        return json(out);
      }
      if (op === "put") {
        const n = Math.min(Number(url.searchParams.get("n") || 1), 50);
        const ms = [], rows_written = [], duration = [];
        let ok = 0, error = null;
        for (let i = 0; i < n; i++) {
          const t = Date.now();
          try {
            const r = await env.STORE.prepare("INSERT INTO t (k, v) VALUES (?, ?)").bind("spike-store-w-" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 8), "v").run();
            ok++;
            ms.push(Date.now() - t);
            rows_written.push(r.meta && r.meta.rows_written);
            duration.push(r.meta && Math.round(r.meta.duration * 1000) / 1000);
          } catch (e) {
            error = err(e);
            break;
          }
        }
        return json({ ok, ms, rows_written, duration, error });
      }
      if (op === "fetch") return json(await control(url));
      return json({ error: "no such op" }, 404);
    } catch (e) {
      return json({ thrown: err(e) }, 500);
    }
  },
};
${CONTROL}
`;

const DISPATCH_WITH_COUNTER = (key) => `
import { DurableObject } from "cloudflare:workers";
export class SpikeCounter extends DurableObject {
  async count() {
    const n = ((await this.ctx.storage.get("n")) || 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}
const KEY = ${JSON.stringify(key)};
const NAME = /^spike-store-[a-z0-9-]{1,40}$/;
export default {
  async fetch(request, env) {
    if (request.headers.get("x-spike-key") !== KEY) return new Response("no", { status: 403 });
    const url = new URL(request.url);
    const [, script, ...rest] = url.pathname.split("/");
    if (script === "health") return Response.json({ ok: true });
    if (!NAME.test(script)) return Response.json({ error: "not a spike script" }, { status: 400 });
    const sub = url.searchParams.get("sub");
    const out = {};
    try {
      if (url.searchParams.get("do") === "1") {
        const t = Date.now();
        out.count = await env.COUNTER.get(env.COUNTER.idFromName(script)).count();
        out.do_ms = Date.now() - t;
      }
      const worker = env.NS.get(script, {}, sub ? { limits: { subRequests: Number(sub) } } : {});
      const t = Date.now();
      const answer = await worker.fetch(new Request("https://app.invalid/" + rest.join("/") + url.search));
      out.app_ms = Date.now() - t;
      out.app_status = answer.status;
      const text = await answer.text();
      try { out.app = JSON.parse(text); } catch { out.app_text = text.slice(0, 300); }
    } catch (e) {
      out.thrown = String((e && e.message) || e).slice(0, 300);
    }
    return Response.json(out);
  },
};
`;

const DISPATCH_NO_COUNTER = `export default { fetch() { return new Response("gone", { status: 410 }); } };\n`;

function moduleForm(code, metadata) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: COMPAT, ...metadata })], { type: "application/json" }));
  form.append("index.js", new Blob([code], { type: "application/javascript+module" }), "index.js");
  return form;
}

const kvBinding = (id) => ({ type: "kv_namespace", name: "STORE", namespace_id: id });
const d1Binding = (id) => ({ type: "d1", name: "STORE", id });
const keepBindings = (a) => ({ bindings: (a.body?.result ?? []).map((b) => `${b.type}:${b.name}`) });

// ---- the run ----

const ids = {};

async function verify(tokens) {
  for (const who of WHICH) {
    const t = (op, path, keep) => call(who, tokens, op, "GET", path, { keep });
    const verified = (a) => ({ token_status: a.body?.result?.status ?? null, expiry_present: Boolean(a.body?.result?.expires_on) });
    await t("0. verify (user token)", "/user/tokens/verify", verified);
    await t("0. verify (account token)", `${account}/tokens/verify`, verified);
    for (const [label, path, spike] of [
      ["KV namespaces", kvPath(), (x) => spikeNamed(x.title)],
      ["D1 databases", d1Path(), (x) => spikeNamed(x.name)],
      ["scripts in the namespace", `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`, (x) => spikeNamed(x.id ?? x.script?.id)],
      ["Durable Object namespaces", `${account}/workers/durable_objects/namespaces`, (x) => String(x.script ?? "").startsWith("spike-store-")],
    ]) {
      const listed = path.includes("/dispatch/") ? await sendList(tokens, who, path) : await listAll(tokens, who, path);
      record({ token: who, op: `0. list ${label}`, status: listed.status, codes: listed.codes, total: listed.items.length, spike_named: listed.items.filter(spike).length });
    }
  }
}

async function sendList(tokens, who, path) {
  const answer = await send(tokens[who], "GET", path);
  return { status: answer.status, codes: errorsOf(answer.body).map((e) => e.code), items: Array.isArray(answer.body?.result) ? answer.body.result : [] };
}

async function makeKv(tokens, who, suffix) {
  const answer = await call(who, tokens, `make KV namespace ${suffix}`, "POST", kvPath(), { json: { title: N(suffix) } });
  const id = answer.body?.result?.id;
  if (answer.status === 200 && /^[0-9a-f]{32}$/.test(id ?? "") && answer.body.result.title === N(suffix)) {
    made.kv.add(id);
    return id;
  }
  return null;
}

async function makeD1(tokens, who, suffix) {
  const answer = await call(who, tokens, `make D1 database ${suffix}`, "POST", d1Path(), { json: { name: N(suffix) } });
  const id = answer.body?.result?.uuid;
  if (answer.status === 200 && /^[0-9a-f-]{36}$/.test(id ?? "") && answer.body.result.name === N(suffix)) {
    made.d1.add(id);
    return id;
  }
  return null;
}

const query = (tokens, who, op, id, sql) =>
  call(who, tokens, op, "POST", `${d1Path(id)}/query`, {
    json: { sql },
    keep: (a) => ({ meta: (a.body?.result ?? []).map((r) => ({ rows_written: r.meta?.rows_written ?? null, rows_read: r.meta?.rows_read ?? null })) }),
  });

async function stores(tokens) {
  // 1. The KV token makes two namespaces and writes a marker in each.
  ids.kvA = await makeKv(tokens, "kv", "kv-a");
  ids.kvB = await makeKv(tokens, "kv", "kv-b");
  ids.kvGone = await makeKv(tokens, "kv", "kv-gone");
  for (const [which, id] of [["a", ids.kvA], ["b", ids.kvB]]) {
    if (id) await call("kv", tokens, `1. kv: write marker in kv-${which}`, "PUT", `${kvPath(id)}/values/spike-store-marker-${which}`, { text: "marker" });
  }
  if (ids.kvA) await call("kv", tokens, "1. kv: read back the marker in kv-a", "GET", `${kvPath(ids.kvA)}/values/spike-store-marker-a`, { keep: (a) => ({ same: a.text === "marker" }) });

  // 2. The D1 token makes two databases, each with a table and a marker row.
  ids.d1A = await makeD1(tokens, "d1", "d1-a");
  ids.d1B = await makeD1(tokens, "d1", "d1-b");
  ids.d1Gone = await makeD1(tokens, "d1", "d1-gone");
  for (const [which, id] of [["a", ids.d1A], ["b", ids.d1B]]) {
    if (id) await query(tokens, "d1", `2. d1: table and marker in d1-${which}`, id, `CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT); INSERT INTO t (k, v) VALUES ('spike-store-marker-${which}', 'marker');`);
  }

  // 3. Each token against the other kind of store, and against stores another token made.
  for (const who of ["kv", "d1", "scripts", "read"]) {
    if (who !== "kv") {
      const other = await makeKv(tokens, who, `kv-by-${who}`);
      if (other) ids[`kvBy_${who}`] = other;
      if (ids.kvA) await call(who, tokens, `3. ${who}: write a key in kv-a, which the kv token made`, "PUT", `${kvPath(ids.kvA)}/values/spike-store-from-${who}`, { text: "x" });
      if (ids.kvA) await call(who, tokens, `3. ${who}: read the marker in kv-a`, "GET", `${kvPath(ids.kvA)}/values/spike-store-marker-a`, { keep: (a) => ({ same: a.text === "marker" }) });
    }
    if (who !== "d1") {
      const other = await makeD1(tokens, who, `d1-by-${who}`);
      if (other) ids[`d1By_${who}`] = other;
      if (ids.d1A) await query(tokens, who, `3. ${who}: insert a row in d1-a, which the d1 token made`, ids.d1A, `INSERT INTO t (k, v) VALUES ('spike-store-from-${who}', 'x');`);
      if (ids.d1A) await query(tokens, who, `3. ${who}: select from d1-a`, ids.d1A, "SELECT count(*) AS n FROM t;");
    }
  }
  // A namespace another token made, if any could: the kv token writes there.
  for (const who of ["d1", "scripts", "read"]) {
    if (ids[`kvBy_${who}`]) await call("kv", tokens, `3. kv: write a key in kv-by-${who}, which it didn't make`, "PUT", `${kvPath(ids[`kvBy_${who}`])}/values/spike-store-from-kv`, { text: "x" });
    if (ids[`d1By_${who}`]) await query(tokens, "d1", `3. d1: insert in d1-by-${who}, which it didn't make`, ids[`d1By_${who}`], "CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT); INSERT INTO t (k, v) VALUES ('spike-store-from-d1', 'x');");
  }
  if (!["d1", "scripts", "read"].some((w) => ids[`kvBy_${w}`])) record({ op: "3. kv: a namespace another token made: none could be made, so the kv token wrote only in namespaces it made itself" });
  if (!["kv", "scripts", "read"].some((w) => ids[`d1By_${w}`])) record({ op: "3. d1: a database another token made: none could be made, so the d1 token wrote only in databases it made itself" });
  // The kv token in its second namespace: the same token's reach beyond the one namespace an app would use.
  if (ids.kvB) await call("kv", tokens, "3. kv: write a key in kv-b, its own second namespace", "PUT", `${kvPath(ids.kvB)}/values/spike-store-from-kv`, { text: "x" });

  // 4. Is a store's permission checked before its existence? Each token against a store that has just been deleted.
  if (ids.kvGone) {
    await call("kv", tokens, "4. kv: delete kv-gone", "DELETE", kvPath(ids.kvGone), { keep: () => ({}) });
    for (const who of WHICH) await call(who, tokens, `4. ${who}: write a key in kv-gone, deleted`, "PUT", `${kvPath(ids.kvGone)}/values/spike-store-probe`, { text: "x" });
  }
  if (ids.d1Gone) {
    await call("d1", tokens, "4. d1: delete d1-gone", "DELETE", d1Path(ids.d1Gone), { keep: () => ({}) });
    for (const who of WHICH) await query(tokens, who, `4. ${who}: query d1-gone, deleted`, ids.d1Gone, "SELECT 1;");
  }
}

async function binds(tokens) {
  // 5. Who can upload a script into the namespace that binds a store?
  const cases = [];
  if (ids.kvA) cases.push(["kv", kvBinding(ids.kvA), KV_APP]);
  if (ids.d1A) cases.push(["d1", d1Binding(ids.d1A), D1_APP]);
  if (ids.kvGone) cases.push(["kv-gone", kvBinding(ids.kvGone), KV_APP]);
  if (ids.d1Gone) cases.push(["d1-gone", d1Binding(ids.d1Gone), D1_APP]);
  for (const who of WHICH) {
    for (const [kind, binding, code] of cases) {
      const name = N(`bind-${who}-${kind}`);
      const put = await call(who, tokens, `5. ${who}: upload into the namespace, binding ${kind}`, "PUT", inNamespace(name), { form: moduleForm(code, { bindings: [binding] }), keep: () => ({}) });
      if (put.status === 200) {
        await call("read", tokens, `5. read: bindings of bind-${who}-${kind}`, "GET", `${inNamespace(name)}/bindings`, { keep: keepBindings });
        await call("scripts", tokens, `5. scripts: delete bind-${who}-${kind}`, "DELETE", `${inNamespace(name)}?force=true`, { keep: () => ({}) });
      }
    }
  }
}

async function apps(tokens) {
  // 6. Four apps, each with one store, uploaded with the scripts token if it can, else the store's own token.
  const plan = [
    ["app-kv-a", ids.kvA, kvBinding, KV_APP, "kv"],
    ["app-kv-b", ids.kvB, kvBinding, KV_APP, "kv"],
    ["app-d1-a", ids.d1A, d1Binding, D1_APP, "d1"],
    ["app-d1-b", ids.d1B, d1Binding, D1_APP, "d1"],
  ];
  for (const [suffix, id, binding, code, fallback] of plan) {
    if (!id) continue;
    let put = await call("scripts", tokens, `6. scripts: upload ${suffix}`, "PUT", inNamespace(N(suffix)), { form: moduleForm(code, { bindings: [binding(id)] }), keep: () => ({}) });
    if (put.status !== 200) put = await call(fallback, tokens, `6. ${fallback}: upload ${suffix}`, "PUT", inNamespace(N(suffix)), { form: moduleForm(code, { bindings: [binding(id)] }), keep: () => ({}) });
    if (put.status === 200) {
      ids[suffix] = true;
      await call("read", tokens, `6. read: bindings of ${suffix}`, "GET", `${inNamespace(N(suffix))}/bindings`, { keep: keepBindings });
    }
  }

  // 7. The dispatch Worker, at account level, on workers.dev, with the counter's class.
  const dispatch = N("dispatch");
  const put = await call("scripts", tokens, "7. scripts: upload the dispatch Worker with a Durable Object class", "PUT", atAccount(dispatch), {
    form: moduleForm(DISPATCH_WITH_COUNTER(KEY), {
      bindings: [
        { type: "dispatch_namespace", name: "NS", namespace: NAMESPACE },
        { type: "durable_object_namespace", name: "COUNTER", class_name: "SpikeCounter" },
      ],
      migrations: { new_tag: "v1", new_sqlite_classes: ["SpikeCounter"] },
    }),
    keep: () => ({}),
  });
  if (put.status !== 200) return false;
  ids.dispatch = true;
  await call("scripts", tokens, "7. scripts: turn on workers.dev for the dispatch Worker", "POST", `${atAccount(dispatch)}/subdomain`, { json: { enabled: true, previews_enabled: false }, keep: () => ({}) });
  const sub = await send(tokens.read, "GET", `${account}/workers/subdomain`);
  subdomain = sub.body?.result?.subdomain ?? null;
  record({ token: "read", op: "7. read: the account's workers.dev subdomain", status: sub.status, found: Boolean(subdomain) });
  if (!subdomain) return false;
  for (let i = 0; i < 30; i++) {
    const health = await hit("health");
    if (health.status === 200) {
      record({ op: "7. dispatch Worker answers", after_tries: i + 1 });
      return true;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  record({ op: "7. dispatch Worker never answered" });
  return false;
}

/** A request to the spike's own dispatch Worker, and nowhere else. */
async function hit(path) {
  const host = `${N("dispatch")}.${subdomain}.workers.dev`;
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(host)) throw new Error("refusing: not the dispatch Worker's host");
  const url = `https://${host}/${path}`;
  try {
    const response = await fetch(url, { headers: { "x-spike-key": KEY }, redirect: "error" });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: response.status, body, text };
  } catch (error) {
    return { status: 0, body: null, text: String(error.message) };
  }
}

async function probe(op, path) {
  const answer = await hit(path);
  record({ op, path, status: answer.status, answer: answer.body ?? answer.text.slice(0, 200) });
  return answer;
}

async function inside() {
  // 8. What each app sees of its store, and that it sees no other.
  for (const app of ["app-kv-a", "app-kv-b", "app-d1-a", "app-d1-b"]) {
    if (!ids[app]) continue;
    await probe(`8. ${app}: its environment`, `${N(app)}/env`);
    await probe(`8. ${app}: its store's keys`, `${N(app)}/list`);
    if (app.includes("d1")) await probe(`8. ${app}: its database's schema, and ATTACH`, `${N(app)}/schema`);
  }

  // 9. Does a write count against the dispatch's subrequest limit?
  for (const app of ["app-kv-a", "app-d1-a"]) {
    if (!ids[app]) continue;
    for (const sub of [1, 2, 3]) await probe(`9. ${app}: 3 writes with subRequests ${sub}`, `${N(app)}/put?n=3&sub=${sub}`);
    await probe(`9. ${app}: 3 writes with no limit set`, `${N(app)}/put?n=3`);
  }

  // 10. What one write costs, with and without a Durable Object counting it first.
  for (const app of ["app-kv-a", "app-d1-a"]) {
    if (!ids[app]) continue;
    const samples = { plain: [], counted: [] };
    for (let i = 0; i < 20; i++) {
      for (const [label, extra] of [["plain", ""], ["counted", "&do=1"]]) {
        const answer = await hit(`${N(app)}/put?n=1${extra}`);
        const b = answer.body ?? {};
        samples[label].push({ status: answer.status, app_ms: b.app_ms ?? null, do_ms: b.do_ms ?? null, write_ms: b.app?.ms?.[0] ?? null, rows_written: b.app?.rows_written?.[0] ?? null, d1_ms: b.app?.duration?.[0] ?? null, error: b.thrown ?? b.app?.error ?? null });
      }
    }
    const median = (xs) => {
      const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    for (const label of ["plain", "counted"]) {
      const s = samples[label];
      record({
        op: `10. ${app}: one write, ${label}, 20 samples`,
        ok: s.filter((x) => x.status === 200 && !x.error).length,
        errors: [...new Set(s.map((x) => x.error).filter(Boolean))],
        median_app_ms: median(s.map((x) => x.app_ms)),
        median_write_ms: median(s.map((x) => x.write_ms)),
        median_do_ms: median(s.map((x) => x.do_ms)),
        max_do_ms: Math.max(...s.map((x) => x.do_ms ?? 0)),
        rows_written: [...new Set(s.map((x) => x.rows_written))],
        median_d1_ms: median(s.map((x) => x.d1_ms)),
      });
    }
  }
  // After the writes, an app's own list again: nothing of the other's.
  for (const app of ["app-kv-a", "app-kv-b", "app-d1-a", "app-d1-b"]) if (ids[app]) await probe(`10. ${app}: its store's keys after the writes`, `${N(app)}/list`);
}

async function deletions(tokens) {
  // 11. Who can delete a store another token made? Each against the second store, which nothing needs now.
  if (ids.kvB) for (const who of ["d1", "scripts", "read"]) await call(who, tokens, `11. ${who}: delete kv-b, which the kv token made`, "DELETE", kvPath(ids.kvB), { keep: () => ({}) });
  if (ids.d1B) for (const who of ["kv", "scripts", "read"]) await call(who, tokens, `11. ${who}: delete d1-b, which the d1 token made`, "DELETE", d1Path(ids.d1B), { keep: () => ({}) });

  // 12. The apps and the dispatch Worker go first, so no script binds a store when the store is deleted.
  for (const app of ["app-kv-a", "app-kv-b", "app-d1-a", "app-d1-b"]) {
    if (!ids[app]) continue;
    await call("scripts", tokens, `12. scripts: delete ${app}`, "DELETE", `${inNamespace(N(app))}?force=true`, { keep: () => ({}) });
    // A namespaced script's read answers 200 whether or not it exists; `"script": null` is its word for gone.
    await call("read", tokens, `12. read: is ${app} there`, "GET", inNamespace(N(app)), { keep: (a) => ({ script_present: a.body?.result?.script != null }) });
  }
  if (ids.dispatch) await deleteDispatch(tokens);

  // 13. Each store deleted by its own token, then read, then deleted again: is the answer telling?
  for (const [label, id] of [["kv-a", ids.kvA], ["kv-b", ids.kvB]]) {
    if (!id) continue;
    await call("kv", tokens, `13. kv: delete ${label}`, "DELETE", kvPath(id), { keep: () => ({}) });
    await call("read", tokens, `13. read: is ${label} there`, "GET", kvPath(id), { keep: () => ({}) });
    await call("kv", tokens, `13. kv: delete ${label} again`, "DELETE", kvPath(id), { keep: () => ({}) });
  }
  for (const [label, id] of [["d1-a", ids.d1A], ["d1-b", ids.d1B]]) {
    if (!id) continue;
    await call("d1", tokens, `13. d1: delete ${label}`, "DELETE", d1Path(id), { keep: () => ({}) });
    await call("read", tokens, `13. read: is ${label} there`, "GET", d1Path(id), { keep: () => ({}) });
    await call("d1", tokens, `13. d1: delete ${label} again`, "DELETE", d1Path(id), { keep: () => ({}) });
  }
  if (ids.kvGone) await call("read", tokens, "13. read: is kv-gone there", "GET", kvPath(ids.kvGone), { keep: () => ({}) });
  if (ids.d1Gone) await call("read", tokens, "13. read: is d1-gone there", "GET", d1Path(ids.d1Gone), { keep: () => ({}) });
}

async function deleteDispatch(tokens) {
  const dispatch = N("dispatch");
  await call("scripts", tokens, "12. scripts: delete the counter's class by a migration", "PUT", atAccount(dispatch), {
    form: moduleForm(DISPATCH_NO_COUNTER, { bindings: [], migrations: { old_tag: "v1", new_tag: "v2", deleted_classes: ["SpikeCounter"] } }),
    keep: () => ({}),
  });
  await call("scripts", tokens, "12. scripts: delete the dispatch Worker", "DELETE", `${atAccount(dispatch)}?force=true`, { keep: () => ({}) });
  await call("read", tokens, "12. read: is the dispatch Worker there", "GET", `${atAccount(dispatch)}/settings`, { keep: () => ({}) });
}

// ---- clean-up: by listing, so it runs from nothing, after a failure, or as its own command ----

/** A listing with the read token, or with the token that can write the kind if the read token can't list it. */
async function listFor(tokens, writer, path, all = true) {
  const list = all ? listAll : sendList;
  const listed = await list(tokens, "read", path);
  return listed.status === 200 ? listed : list(tokens, writer, path);
}

async function cleanup(tokens) {
  const kv = await listFor(tokens, "kv", kvPath());
  for (const ns of kv.items.filter((x) => spikeNamed(x.title))) {
    made.kv.add(ns.id);
    await call("kv", tokens, `clean-up: delete KV namespace ${ns.title}`, "DELETE", kvPath(ns.id), { keep: () => ({}) });
  }
  const d1 = await listFor(tokens, "d1", d1Path());
  for (const db of d1.items.filter((x) => spikeNamed(x.name))) {
    made.d1.add(db.uuid);
    await call("d1", tokens, `clean-up: delete D1 database ${db.name}`, "DELETE", d1Path(db.uuid), { keep: () => ({}) });
  }
  const inside = await listFor(tokens, "scripts", `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`, false);
  for (const name of inside.items.map((s) => s.id ?? s.script?.id).filter(spikeNamed)) {
    await call("scripts", tokens, `clean-up: delete ${name} (namespace)`, "DELETE", `${inNamespace(name)}?force=true`, { keep: () => ({}) });
  }
  const workers = await listFor(tokens, "scripts", `${account}/workers/scripts`, false);
  for (const name of workers.items.map((s) => s.id).filter(spikeNamed)) {
    await call("scripts", tokens, `clean-up: delete ${name} (account)`, "DELETE", `${atAccount(name)}?force=true`, { keep: () => ({}) });
  }
  await confirm(tokens);
}

async function confirm(tokens) {
  const kv = await listAll(tokens, "read", kvPath());
  const d1 = await listAll(tokens, "read", d1Path());
  const inside = await sendList(tokens, "read", `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`);
  const workers = await sendList(tokens, "read", `${account}/workers/scripts`);
  const dos = await listAll(tokens, "read", `${account}/workers/durable_objects/namespaces`);
  record({
    op: "clean-up: confirmed by listing, with the read token",
    kv_status: kv.status,
    kv_total: kv.items.length,
    kv_spike_store: kv.items.filter((x) => String(x.title).startsWith("spike-store-")).length,
    d1_status: d1.status,
    d1_total: d1.items.length,
    d1_spike_store: d1.items.filter((x) => String(x.name).startsWith("spike-store-")).length,
    namespace_status: inside.status,
    namespace_spike_store: inside.items.filter((s) => String(s.id ?? s.script?.id).startsWith("spike-store-")).length,
    account_status: workers.status,
    account_spike_store: workers.items.filter((s) => String(s.id).startsWith("spike-store-")).length,
    do_status: dos.status,
    do_spike_store: dos.items.filter((x) => String(x.script ?? "").startsWith("spike-store-")).length,
  });
}

const commands = {
  async run() {
    const tokens = readTokens();
    record({ op: "start", tokens: WHICH });
    try {
      await verify(tokens);
      await stores(tokens);
      await binds(tokens);
      if (await apps(tokens)) await inside();
      await deletions(tokens);
    } catch (error) {
      record({ op: "the run stopped", error: redact(String(error.message)).slice(0, 300) });
    } finally {
      await cleanup(tokens);
    }
  },
  /**
   * The second, shorter run: a control for the subrequest limit (plain fetches, which it is documented to count),
   * more writes under a limit of 1, and how long a deleted script still reads as there.
   */
  async limits() {
    const tokens = readTokens();
    record({ op: "start limits", tokens: WHICH });
    try {
      ids.kvA = await makeKv(tokens, "kv", "kv-a");
      ids.d1A = await makeD1(tokens, "d1", "d1-a");
      if (ids.d1A) await query(tokens, "d1", "L. d1: table in d1-a", ids.d1A, "CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT);");
      if (await apps(tokens)) {
        for (const app of ["app-kv-a", "app-d1-a"]) {
          if (!ids[app]) continue;
          for (const sub of [1, 2]) await probe(`L. ${app}: control, 3 fetches with subRequests ${sub}`, `${N(app)}/fetch?n=3&sub=${sub}`);
          await probe(`L. ${app}: control, 3 fetches with no limit set`, `${N(app)}/fetch?n=3`);
          await probe(`L. ${app}: 10 writes with subRequests 1`, `${N(app)}/put?n=10&sub=1`);
        }
      }
      for (const app of ["app-kv-a", "app-d1-a"]) {
        if (!ids[app]) continue;
        await call("scripts", tokens, `L. scripts: delete ${app}`, "DELETE", `${inNamespace(N(app))}?force=true`, { keep: () => ({}) });
        const started = Date.now();
        for (let i = 0; i < 30; i++) {
          const read = await send(tokens.read, "GET", inNamespace(N(app)));
          const present = read.body?.result?.script != null;
          if (read.status !== 200 || !present || i === 29) {
            record({ token: "read", op: `L. read: ${app} after its delete`, status: read.status, script_present: present, codes: errorsOf(read.body).map((e) => e.code), after_ms: Date.now() - started, reads: i + 1 });
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (ids.dispatch) await deleteDispatch(tokens);
      if (ids.kvA) await call("kv", tokens, "L. kv: delete kv-a", "DELETE", kvPath(ids.kvA), { keep: () => ({}) });
      if (ids.d1A) await call("d1", tokens, "L. d1: delete d1-a", "DELETE", d1Path(ids.d1A), { keep: () => ({}) });
    } catch (error) {
      record({ op: "the run stopped", error: redact(String(error.message)).slice(0, 300) });
    } finally {
      await cleanup(tokens);
    }
  },
  async cleanup() {
    await cleanup(readTokens());
  },
};

const [command] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`usage: node spike.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
await commands[command]();
