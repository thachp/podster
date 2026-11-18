#!/usr/bin/env node
// M6 spike D: custom hostnames (Cloudflare for SaaS) on the content zone, podster.site.
//
// Spike only. It holds a token that can make and delete custom hostnames on the zone, and a token on the second
// account, so:
// - every request to Cloudflare's API goes through `send`, and `send` asks guard.mjs first;
// - a token is read into memory from the owner's file, sent in a header and nowhere else. It is never printed,
//   logged, written or put on a command line;
// - what is recorded is a status, Cloudflare's codes and messages, the names the spike asked for, timings and
//   what Cloudflare's edge answered. Every 32-hex ID, every UUID and the account's workers.dev subdomain are
//   redacted before anything is kept or shown.
// See README.md.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { SCRIPT_NAME, allow, folded, spikeHostname } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const ZONE_NAME = "podster.site";
const FALLBACK = "fallback.podster.site";
const MAIN = "spike.opster.dev";
const TOKEN_DIR = join(homedir(), ".podster");
const RESULTS = join(HERE, "results", "results.jsonl");
const RUN = randomBytes(3).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- secrets, held in memory only ----

const secrets = new Set();
function readSecret(file) {
  const path = join(TOKEN_DIR, file);
  if (statSync(path).mode & 0o077) throw new Error(`${file}: must be mode 600`);
  const value = readFileSync(path, "utf8").trim();
  if (!/^[\x21-\x7e]{20,}$/.test(value)) throw new Error(`${file}: doesn't hold one value`);
  secrets.add(value);
  return value;
}
const tokens = { hostnames: readSecret("spike-hostnames.token"), second: readSecret("spike-store-d1only.token") };
const ctx = { zone: null, account: readSecret("cloudflare-account-id.second-account"), made: new Set() };
let subdomain = null;

function redact(text) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("<secret>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out
    .replace(/[0-9a-f]{32}/gi, "<id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
}

mkdirSync(dirname(RESULTS), { recursive: true });
function record(step, data) {
  const line = redact(JSON.stringify({ run: RUN, at: new Date().toISOString(), step, ...data }));
  appendFileSync(RESULTS, `${line}\n`);
  console.log(line);
}

// ---- Cloudflare's API ----

async function send(method, url, { token = "hostnames", body = null, type = "application/json" } = {}) {
  allow(method, url, typeof body === "string" ? body : null, ctx);
  const headers = { Authorization: `Bearer ${tokens[token]}` };
  if (body !== null && type) headers["Content-Type"] = type;
  const started = Date.now();
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, ms: Date.now() - started };
}
const codes = (json) => (json?.errors ?? []).map((e) => ({ code: e.code, message: e.message }));
const zonePath = () => `${API}/zones/${ctx.zone}/custom_hostnames`;

/** What is kept of one custom hostname: its fields' values except IDs and tokens, which `redact` hides anyway. */
function shape(h) {
  if (!h) return null;
  return {
    hostname: h.hostname,
    status: h.status,
    verification_errors: h.verification_errors,
    ownership_verification: h.ownership_verification ? { type: h.ownership_verification.type, name: h.ownership_verification.name } : undefined,
    ownership_verification_http: h.ownership_verification_http ? { has_url: !!h.ownership_verification_http.http_url } : undefined,
    ssl: h.ssl
      ? {
          status: h.ssl.status,
          method: h.ssl.method,
          type: h.ssl.type,
          validation_errors: h.ssl.validation_errors,
          validation_records: (h.ssl.validation_records ?? []).map((r) => Object.keys(r).sort()),
          certificate_authority: h.ssl.certificate_authority,
          wildcard: h.ssl.wildcard,
        }
      : undefined,
    custom_origin_server: h.custom_origin_server,
    keys: Object.keys(h).sort(),
  };
}

async function findZone() {
  const r = await send("GET", `${API}/zones?name=${ZONE_NAME}`);
  const zone = r.json?.result?.[0];
  if (!zone || zone.name !== ZONE_NAME) throw new Error("the zone wasn't found");
  ctx.zone = zone.id;
  const fb = await send("GET", `${zonePath()}/fallback_origin`);
  record("fallback-origin", { status: fb.status, origin: fb.json?.result?.origin, state: fb.json?.result?.status, errors: codes(fb.json) });
}

/** Every page of a name's search. Returns { entries, info } or null when the pages don't add up. */
async function listByName(name, perPage = 50) {
  const entries = [];
  const infos = [];
  for (let page = 1; page <= 20; page++) {
    const r = await send("GET", `${zonePath()}?hostname=${encodeURIComponent(name)}&per_page=${perPage}&page=${page}`);
    if (r.status !== 200 || !r.json?.success) return { error: { status: r.status, errors: codes(r.json) } };
    entries.push(...r.json.result);
    infos.push(r.json.result_info);
    if (page >= (r.json.result_info?.total_pages ?? 1)) break;
  }
  return { entries, info: infos };
}
async function listAll(perPage = 50) {
  const entries = [];
  const infos = [];
  for (let page = 1; page <= 20; page++) {
    const r = await send("GET", `${zonePath()}?per_page=${perPage}&page=${page}`);
    if (r.status !== 200 || !r.json?.success) return { error: { status: r.status, errors: codes(r.json) } };
    entries.push(...r.json.result);
    infos.push(r.json.result_info);
    if (page >= (r.json.result_info?.total_pages ?? 1)) break;
  }
  return { entries, info: infos };
}

async function create(hostname) {
  const body = JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } });
  const r = await send("POST", zonePath(), { body });
  const h = r.json?.result;
  if (h?.id && spikeHostname(h.hostname ?? hostname)) ctx.made.add(h.id);
  record("create", { asked: hostname, status: r.status, ms: r.ms, success: r.json?.success, errors: codes(r.json), result: shape(h) });
  return h ?? null;
}

async function remove(id, label) {
  const r = await send("DELETE", `${zonePath()}/${id}`);
  record("delete", { hostname: label, status: r.status, ms: r.ms, success: r.json?.success, errors: codes(r.json), result_keys: r.json?.result ? Object.keys(r.json.result).sort() : null });
  return r;
}

async function getById(id) {
  const r = await send("GET", `${zonePath()}/${id}`);
  return { status: r.status, errors: codes(r.json), result: r.json?.result ?? null };
}

/** Polls until the list by name shows (or stops showing) exactly `name`, every 2 s, up to `limitMs`. */
async function waitList(name, present, limitMs) {
  const start = Date.now();
  let reads = 0;
  while (Date.now() - start < limitMs) {
    reads++;
    const l = await listByName(name);
    const found = (l.entries ?? []).some((e) => e.hostname === folded(name));
    if (!l.error && found === present) return { ms: Date.now() - start, reads };
    await sleep(2000);
  }
  return { ms: null, reads, timedOut: true };
}
async function waitGetGone(id, limitMs) {
  const start = Date.now();
  let reads = 0;
  let last = null;
  while (Date.now() - start < limitMs) {
    reads++;
    last = await getById(id);
    if (last.status !== 200) return { ms: Date.now() - start, reads, status: last.status, errors: last.errors };
    await sleep(2000);
  }
  return { ms: null, reads, timedOut: true, lastStatus: last?.status, lastState: last?.result?.status };
}

// ---- the edge: what a request with a given SNI and Host is answered ----

function edge(sni, host, { connect = sni, path = "/", port = 443 } = {}) {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: connect,
        servername: sni,
        port,
        path,
        method: "GET",
        headers: { Host: host, "User-Agent": "spike-client" },
        rejectUnauthorized: false,
        // A fresh connection and a full handshake every time: run c06765 reused sessions, which hid the
        // certificate and may have changed the answer.
        agent: false,
        timeout: 15000,
        lookup: dnsLookup,
      },
      (res) => {
        const cert = res.socket.getPeerCertificate?.() ?? {};
        const authorized = res.socket.authorized;
        let body = "";
        res.on("data", (c) => {
          if (body.length < 20000) body += c;
        });
        res.on("end", () => {
          const code = body.match(/error code: ?(\d{3,4})/i)?.[1] ?? body.match(/Error (\d{4})/)?.[1] ?? null;
          const title = body.match(/<title>([^<]{0,120})<\/title>/i)?.[1]?.trim() ?? null;
          resolve({
            sni,
            host,
            status: res.statusCode,
            cf_error: code,
            title,
            server: res.headers.server ?? null,
            cert_cn: cert.subject?.CN ?? null,
            cert_san: cert.subjectaltname ?? null,
            cert_issuer: cert.issuer?.O ?? null,
            cert_valid_for_sni: authorized,
            body_head: code || title ? undefined : body.slice(0, 80),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ sni, host, error: e.code ?? e.message }));
    req.end();
  });
}

const PROBES = [
  [MAIN, MAIN],
  [FALLBACK, FALLBACK],
  [FALLBACK, MAIN],
  [MAIN, FALLBACK],
  ["podster.dev", MAIN],
  [MAIN, "podster.dev"],
  ["x.spike.opster.dev", MAIN],
];
async function probes(label) {
  for (const [sni, host] of PROBES) record(`edge-${label}`, await edge(sni, host));
}

// ---- DNS over HTTPS ----

const DOH_NAMES = [
  ["_cf-custom-hostname.spike.opster.dev", "TXT"],
  ["spike.opster.dev", "TXT"],
  ["spike.opster.dev", "CNAME"],
  ["nothing-here-spike-d.podster.site", "TXT"],
  ["nothing-here-spike-d.invalid", "TXT"],
  ["_dmarc.podster.dev", "TXT"],
  ["cloudflare.com", "TXT"],
  ["dnssec-failed.org", "TXT"],
  ["www.github.com", "TXT"],
];
const RESOLVERS = {
  cloudflare: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`,
  "cloudflare-1.1.1.1": (n, t) => `https://1.1.1.1/dns-query?name=${encodeURIComponent(n)}&type=${t}`,
  google: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}`,
};
function dohShape(json) {
  if (!json) return null;
  return {
    Status: json.Status,
    TC: json.TC,
    AD: json.AD,
    CD: json.CD,
    Answer: (json.Answer ?? []).map((a) => ({ name: a.name, type: a.type, data: String(a.data).slice(0, 70) })),
    Authority: (json.Authority ?? []).map((a) => ({ name: a.name, type: a.type })),
    Comment: json.Comment,
  };
}
async function dohLocal() {
  for (const [name, type] of DOH_NAMES) {
    for (const [which, url] of Object.entries(RESOLVERS)) {
      try {
        const res = await fetch(url(name, type), { headers: { accept: "application/dns-json" } });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        record("doh-local", { resolver: which, name, type, http: res.status, answer: dohShape(json), ctype: res.headers.get("content-type") });
      } catch (e) {
        record("doh-local", { resolver: which, name, type, error: e.message });
      }
    }
  }
}

/** The test Worker: answers only a request whose path is its key, and only asks the fixed names above. */
function workerSource(key) {
  return `const KEY = ${JSON.stringify(key)};
const NAMES = ${JSON.stringify(DOH_NAMES)};
const RESOLVERS = {
  cloudflare: (n, t) => "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(n) + "&type=" + t,
  "cloudflare-1.1.1.1": (n, t) => "https://1.1.1.1/dns-query?name=" + encodeURIComponent(n) + "&type=" + t,
  google: (n, t) => "https://dns.google/resolve?name=" + encodeURIComponent(n) + "&type=" + t,
};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" + KEY) return new Response("not found", { status: 404 });
    const out = [];
    for (const [name, type] of NAMES) {
      for (const [which, make] of Object.entries(RESOLVERS)) {
        const started = Date.now();
        try {
          const res = await fetch(make(name, type), { headers: { accept: "application/dns-json" } });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          out.push({ resolver: which, name, type, http: res.status, json, head: json ? undefined : text.slice(0, 80), ms: Date.now() - started });
        } catch (e) {
          out.push({ resolver: which, name, type, error: String(e && e.message), ms: Date.now() - started });
        }
      }
    }
    return Response.json({ colo: request.cf && request.cf.colo, out });
  },
};
`;
}

async function dohWorker() {
  const name = `spike-hostnames-${RUN}-doh`;
  if (!SCRIPT_NAME.test(name)) throw new Error("not a spike script name");
  const key = randomBytes(24).toString("hex");
  secrets.add(key);
  const scripts = `${API}/accounts/${ctx.account}/workers/scripts`;
  const sub = await send("GET", `${API}/accounts/${ctx.account}/workers/subdomain`, { token: "second" });
  if (sub.json?.result?.subdomain) {
    subdomain = sub.json.result.subdomain;
    secrets.add(subdomain);
  }
  record("worker-subdomain-read", { status: sub.status, errors: codes(sub.json), known: !!subdomain });

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "doh.mjs", compatibility_date: "2026-11-01" })], { type: "application/json" }));
  form.append("doh.mjs", new Blob([workerSource(key)], { type: "application/javascript+module" }), "doh.mjs");
  // The guard reads only a string body; a form upload is checked by its URL, which names only a spike script.
  allow("PUT", `${scripts}/${name}`, null, ctx);
  const started = Date.now();
  const res = await fetch(`${scripts}/${name}`, { method: "PUT", headers: { Authorization: `Bearer ${tokens.second}` }, body: form });
  const up = await res.json().catch(() => null);
  record("worker-upload", { status: res.status, ms: Date.now() - started, errors: codes(up) });
  if (res.status !== 200) return;
  try {
    const en = await send("POST", `${scripts}/${name}/subdomain`, { token: "second", body: JSON.stringify({ enabled: true, previews_enabled: false }) });
    record("worker-subdomain-enable", { status: en.status, errors: codes(en.json), result: en.json?.result ?? null });
    if (!subdomain) {
      record("worker-call", { skipped: "the account's workers.dev subdomain can't be read with this token, so the Worker's address isn't known" });
      return;
    }
    const url = `https://${name}.${subdomain}.workers.dev/${key}`;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(url).catch((e) => ({ status: 0, e }));
      if (r.status === 200) {
        const body = await r.json();
        record("worker-call", { attempt: i + 1, colo: body.colo });
        for (const o of body.out) record("doh-worker", { resolver: o.resolver, name: o.name, type: o.type, http: o.http, ms: o.ms, error: o.error, head: o.head, answer: dohShape(o.json) });
        return;
      }
      await sleep(3000);
    }
    record("worker-call", { failed: "no 200 in 20 tries" });
  } finally {
    const del = await send("DELETE", `${scripts}/${name}`, { token: "second" });
    record("worker-delete", { status: del.status, errors: codes(del.json) });
  }
}

// ---- the custom hostname run ----

async function hostnames() {
  const before = await listAll();
  record("list-before", { count: before.entries?.length, info: before.info, error: before.error });
  await probes("before");

  // 1. Create the main name; read it back by ID at once, and time how long until the list by name shows it.
  const main = await create(MAIN);
  if (!main) throw new Error("the main create failed");
  const byId = await getById(main.id);
  record("get-after-create", { status: byId.status, result: shape(byId.result) });
  record("list-shows-create", { hostname: MAIN, ...(await waitList(MAIN, true, 10 * 60_000)) });

  // 2. The duplicate's answer.
  await create(MAIN);

  // 3. Names: upper case and a trailing dot; and a longer name that contains the main one, for the search.
  const others = [];
  for (const n of ["Spike-Case.Opster.Dev", "spike-dot.opster.dev.", "x.spike.opster.dev"]) {
    const h = await create(n);
    if (h) others.push(h);
    if (h) record("list-shows-create", { hostname: n, ...(await waitList(h.hostname ?? n, true, 10 * 60_000)) });
  }
  const search = await listByName(MAIN);
  record("search-main", { names: (search.entries ?? []).map((e) => e.hostname), info: search.info, error: search.error });
  for (const n of ["SPIKE.OPSTER.DEV", "spike.opster.dev."]) {
    const s = await listByName(n);
    record("search-variant", { asked: n, names: (s.entries ?? []).map((e) => e.hostname), error: s.error });
  }

  // 4. Paging: pages of 5 (Cloudflare's smallest, if it refuses less) read twice, to see whether order holds.
  for (const per of [1, 5]) {
    const a = await listAll(per);
    const b = await listAll(per);
    record("paging", { per_page: per, first: (a.entries ?? []).map((e) => e.hostname), second: (b.entries ?? []).map((e) => e.hostname), info: a.info, error: a.error ?? b.error });
  }

  // 5. The edge while the hostname is pending, and its status over three minutes.
  await probes("pending");
  for (let i = 0; i < 6; i++) {
    const g = await getById(main.id);
    record("status-while-pending", { minute: i / 2, status: g.result?.status, ssl: g.result?.ssl?.status, verification_errors: g.result?.verification_errors, ssl_errors: g.result?.ssl?.validation_errors });
    await sleep(30_000);
  }

  // 6. Deletes, and how long until each reads gone, by ID and in the list.
  for (const h of [...others, main]) {
    await remove(h.id, h.hostname);
    const [byIdGone, listGone] = await Promise.all([waitGetGone(h.id, 15 * 60_000), waitList(h.hostname, false, 15 * 60_000)]);
    record("reads-gone", { hostname: h.hostname, by_id: byIdGone, list: listGone });
  }
  const del2 = await remove(main.id, `${MAIN} (second delete)`);
  void del2;
  await probes("after");

  // 7. Two more cycles of the main name, for timings only.
  for (let i = 0; i < 2; i++) {
    const h = await create(MAIN);
    if (!h) break;
    record("list-shows-create", { hostname: MAIN, cycle: i + 2, ...(await waitList(MAIN, true, 10 * 60_000)) });
    await remove(h.id, MAIN);
    const [byIdGone, listGone] = await Promise.all([waitGetGone(h.id, 15 * 60_000), waitList(MAIN, false, 15 * 60_000)]);
    record("reads-gone", { hostname: MAIN, cycle: i + 2, by_id: byIdGone, list: listGone });
  }
}

async function cleanup() {
  const all = await listAll();
  if (all.error) {
    record("clean-up", { error: all.error, note: "NOT everything was checked" });
  } else {
    for (const e of all.entries) {
      if (!spikeHostname(e.hostname)) continue;
      ctx.made.add(e.id);
      await remove(e.id, e.hostname).catch((err) => record("clean-up", { hostname: e.hostname, error: err.message }));
    }
  }
  const scripts = await send("GET", `${API}/accounts/${ctx.account}/workers/scripts`, { token: "second" });
  for (const s of scripts.json?.result ?? []) {
    if (!SCRIPT_NAME.test(s.id)) continue;
    const d = await send("DELETE", `${API}/accounts/${ctx.account}/workers/scripts/${s.id}`, { token: "second" });
    record("clean-up-script", { name: s.id, status: d.status, errors: codes(d.json) });
  }
  await sleep(5000);
  const after = await listAll();
  const left = (after.entries ?? []).map((e) => e.hostname);
  const scriptsAfter = await send("GET", `${API}/accounts/${ctx.account}/workers/scripts`, { token: "second" });
  const spikeScripts = (scriptsAfter.json?.result ?? []).filter((s) => SCRIPT_NAME.test(s.id)).length;
  record("clean-up-final", {
    custom_hostnames_left: left.length,
    spike_hostnames_left: left.filter(spikeHostname),
    list_info: after.info,
    list_error: after.error,
    second_account_scripts: scriptsAfter.json?.result?.length ?? null,
    spike_scripts_left: spikeScripts,
    scripts_status: scriptsAfter.status,
  });
}

const which = process.argv[2];
await findZone();
try {
  if (which === "hostnames") await hostnames();
  else if (which === "doh") {
    await dohLocal();
    await dohWorker();
  } else if (which === "probes") await probes("now");
  else if (which === "validate") {
    // After the owner's record on opster.dev: one hostname, its status every 30 s for up to 15 minutes, the
    // edge at each change of status and at the end, then the delete.
    const h = await create(MAIN);
    if (h) {
      let last = null;
      const start = Date.now();
      while (Date.now() - start < 15 * 60_000) {
        const g = await getById(h.id);
        const now = `${g.result?.status}/${g.result?.ssl?.status}`;
        record("status-after-dns", { s: Math.round((Date.now() - start) / 1000), status: g.result?.status, ssl: g.result?.ssl?.status, verification_errors: g.result?.verification_errors, ssl_errors: g.result?.ssl?.validation_errors, validation_records: (g.result?.ssl?.validation_records ?? []).map((r) => Object.keys(r).sort()) });
        if (now !== last) await probes("after-dns");
        last = now;
        if (g.result?.status === "active" && g.result?.ssl?.status === "active") break;
        await sleep(30_000);
      }
      await probes("after-dns-end");
      await remove(h.id, MAIN);
      record("reads-gone", { hostname: MAIN, ...(await waitList(MAIN, false, 15 * 60_000)) });
      await probes("after-dns-deleted");
    }
  } else if (which === "pending") {
    // The edge with and without a pending custom hostname, each twice, on fresh connections.
    await probes("before");
    await probes("before");
    const h = await create(MAIN);
    if (h) {
      await probes("pending");
      await probes("pending");
      const g = await getById(h.id);
      record("status-while-pending", { status: g.result?.status, ssl: g.result?.ssl?.status, verification_errors: g.result?.verification_errors });
      await remove(h.id, MAIN);
      record("reads-gone", { hostname: MAIN, ...(await waitList(MAIN, false, 15 * 60_000)) });
      await probes("after");
    }
  }
  else if (which !== "cleanup") {
    console.error("usage: node spike.mjs hostnames|doh|probes|cleanup");
    process.exitCode = 2;
  }
} catch (e) {
  record("error", { message: e.message });
  process.exitCode = 1;
} finally {
  await cleanup();
}
