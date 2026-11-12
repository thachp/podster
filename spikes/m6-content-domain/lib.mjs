// Spike only. M6 spike C's calls to Cloudflare, with wrangler's own login. The token is read into memory and never
// printed, logged or written. Every name this spike creates starts with spike-m6-c-, and clean-up touches nothing else.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const ACCOUNT = "d8dfeaad2beaa38306233d81b93217d8";
export const NAMESPACE = "podster-staging-apps";
export const ZONE_NAME = "opster.dev";
export const ZONE_ID = "73b83ff0bd4033b94710ce77a71bea74";
export const PREFIX = "spike-m6-c-";
export const DISPATCH = `${PREFIX}dispatch`;
export const ROUTE_PATTERN = "*.opster.dev/*";
export const COMPATIBILITY_DATE = "2026-11-01";
export const LEDGER = join(HERE, "results", "ledger.jsonl");
const WRANGLER = join(ROOT, "apps", "gateway", "node_modules", ".bin", "wrangler");
const API = "https://api.cloudflare.com/client/v4";

/** True only for names this spike made. Never matches another spike's or the product's. */
export const isSpikeName = (name) => typeof name === "string" && name.startsWith(PREFIX) && name.length > PREFIX.length;

export const scriptFor = (label) => {
  if (!/^[a-z0-9]{1,20}$/.test(label)) throw new Error(`bad label: ${label}`);
  return PREFIX + label;
};

let cachedToken;
function token() {
  if (!cachedToken) {
    const out = execFileSync(WRANGLER, ["auth", "token", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    cachedToken = JSON.parse(out).token;
    if (!cachedToken) throw new Error("wrangler has no login");
  }
  return cachedToken;
}

/** One API call. Returns { status, body } and never includes the token in anything it returns or throws. */
export async function api(method, path, { json, form, bearer } = {}) {
  const headers = { authorization: `Bearer ${bearer ?? token()}` };
  let body;
  if (json !== undefined) [headers["content-type"], body] = ["application/json", JSON.stringify(json)];
  if (form !== undefined) body = form;
  const res = await fetch(API + path, { method, headers, body });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

export const errorsOf = (body) => (body && Array.isArray(body.errors) ? body.errors.map((e) => ({ code: e.code, message: e.message })) : []);

export function record(entry) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain" };
export const contentType = (path) => TYPES[extname(path)] ?? "application/octet-stream";

/** Cloudflare's documented asset hash: SHA-256 of the base64 content and the extension, first 32 hex digits. */
export const assetHash = (base64, path) => createHash("sha256").update(base64 + extname(path).slice(1)).digest("hex").slice(0, 32);

/** Every file under dir, as { "/path": { hash, size, base64, type } }, sorted by path. */
export function readApp(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const bytes = readFileSync(full);
        const path = "/" + relative(dir, full).split(sep).join("/");
        const base64 = bytes.toString("base64");
        files[path] = { hash: assetHash(base64, path), size: bytes.length, base64, type: contentType(path) };
      }
    }
  };
  walk(dir);
  return files;
}

export const manifestOf = (files) => Object.fromEntries(Object.entries(files).map(([p, f]) => [p, { hash: f.hash, size: f.size }]));

/** A script that serves nothing itself, for when a user Worker can't be assets only. */
export const EMPTY_SCRIPT = 'export default { fetch() { return new Response("not found\\n", { status: 404 }); } };\n';

/**
 * The three-call upload, as Cloudflare documents it for a user Worker in a namespace:
 * an upload session with the manifest, the files in the buckets it names, then the script naming the completed session.
 * Returns each call's status and errors, and timing in milliseconds. `assetsOnly` sends no module.
 */
export async function uploadApp(script, dir, { assetsOnly = false, headersInConfig = false } = {}) {
  const files = readApp(dir);
  const byHash = new Map(Object.values(files).map((f) => [f.hash, f]));
  const base = `/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${script}`;
  const report = { script, files: Object.keys(files).length, calls: [] };
  const t0 = Date.now();

  const session = await api("POST", `${base}/assets-upload-session`, { json: { manifest: manifestOf(files) } });
  report.calls.push({ call: "assets-upload-session", status: session.status, errors: errorsOf(session.body), buckets: session.body?.result?.buckets?.map((b) => b.length) });
  if (!session.body?.success) return report;
  let completion = session.body.result.jwt;

  for (const bucket of session.body.result.buckets ?? []) {
    const form = new FormData();
    for (const hash of bucket) form.append(hash, new Blob([byHash.get(hash).base64], { type: byHash.get(hash).type }), hash);
    const up = await api("POST", `/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, { form, bearer: session.body.result.jwt });
    report.calls.push({ call: "assets/upload", status: up.status, errors: errorsOf(up.body), files: bucket.length, completed: Boolean(up.body?.result?.jwt) });
    if (!up.body?.success) return report;
    if (up.body.result?.jwt) completion = up.body.result.jwt;
  }

  const metadata = { compatibility_date: COMPATIBILITY_DATE, assets: { jwt: completion }, bindings: [] };
  // Wrangler sends _headers and _redirects as text in the assets config, not only as files; spike A says which counts.
  if (headersInConfig && files["/_headers"]) metadata.assets.config = { _headers: Buffer.from(files["/_headers"].base64, "base64").toString("utf8") };
  const form = new FormData();
  if (!assetsOnly) {
    metadata.main_module = "worker.js";
    form.append("worker.js", new Blob([EMPTY_SCRIPT], { type: "application/javascript+module" }), "worker.js");
  }
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  const put = await api("PUT", base, { form });
  report.calls.push({ call: "script PUT", status: put.status, errors: errorsOf(put.body), assetsOnly, headersInConfig });
  report.ms = Date.now() - t0;
  report.ok = Boolean(put.body?.success);
  return report;
}

/** Names of the scripts in the namespace, whatever the listing calls the field. */
export async function namespaceScripts() {
  const res = await api("GET", `/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NAMESPACE}/scripts`);
  const names = (res.body?.result ?? []).map((s) => s.id ?? s.script_name ?? s.script?.id ?? s.name).filter(Boolean);
  return { status: res.status, errors: errorsOf(res.body), names };
}

export const deleteScript = (script) => api("DELETE", `/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${script}`);

export async function zoneRoutes() {
  const res = await api("GET", `/zones/${ZONE_ID}/workers/routes`);
  return { status: res.status, errors: errorsOf(res.body), routes: (res.body?.result ?? []).map((r) => ({ id: r.id, pattern: r.pattern, script: r.script })) };
}

export const deleteRoute = (id) => api("DELETE", `/zones/${ZONE_ID}/workers/routes/${id}`);
export const accountScript = (name) => api("GET", `/accounts/${ACCOUNT}/workers/scripts/${name}/settings`);
export const deleteAccountScript = (name) => api("DELETE", `/accounts/${ACCOUNT}/workers/scripts/${name}?force=true`);
