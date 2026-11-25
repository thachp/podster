// M6 spike H: the pure half. Names, the app's module, the release's files, and the judges that turn what was seen into
// a verdict for each of the four "before code is turned on" items. No I/O, so `node --test` covers it offline.
import { createHash } from "node:crypto";

export const RUN_FORM = /^[0-9a-f]{6}$/;
/** The compatibility date every release script is written with: `podster_core::app_code::COMPATIBILITY_DATE`. */
export const COMPATIBILITY_DATE = "2026-11-01";
/** The fixed assets configuration the API writes (`apps/api/src/content_provider/upload.rs`, `ASSETS_CONFIG`). */
export const ASSETS_CONFIG = { html_handling: "auto-trailing-slash", not_found_handling: "none" };
/** The release's marker, as `podster_core::release_tree::MARKER_PATH` has it. */
export const MARKER_PATH = ".well-known/podster-release.json";
/** The store's binding name, `podster_core::app_code::STORE_BINDING_NAME`, and D1's binding type. */
export const STORE_BINDING = "STORE";
export const D1_TYPE = "d1";
/** The type a module is uploaded with, `podster_core::app_code::MODULE_UPLOAD_TYPE`. */
export const MODULE_TYPE = "application/javascript+module";
/** The entry module's name. */
export const MAIN_MODULE = "index.js";
/** The query the API's script write sends today (`upload.rs`, `write_script`). */
export const API_QUERY = "?excludeScript=true&bindings_inherit=strict";
/** The four queries item 4 tries, by the suffix of the script that is written with each. */
export const QUERIES = { both: API_QUERY, none: "", exclude: "?excludeScript=true", strict: "?bindings_inherit=strict" };
/** The outbound Worker's one answer (`apps/outbound/src/refuse.ts`). */
export const OUTBOUND_STATUS = 403;
export const OUTBOUND_BODY = "outbound requests from apps are refused\n";
/** The stop key, which the spike only reads. */
export const STOP_KEY = "_stop";

// ---- names ----

/**
 * Every label, host, script and database of one run. Each label is `spikeh<run><one letter>`, 13 characters, inside a
 * label's 26; each script is `<label>.rel_<32 hex>`, the form the content Worker serves.
 *   a: item 1 and item 3. Assets with the marker, and a module that answers every path, the marker's too, and runs the
 *      outbound probes. Written as the API writes, with ASSETS_CONFIG and API_QUERY.
 *   b: item 1's control. The same, with `run_worker_first: true` added to the assets configuration, which Podster never
 *      sends: it shows the test can see a module answer the marker's path.
 *   d: item 2. Bound to the run's D1 database as `STORE`, as S3 writes a release with code and its store.
 *   n, e, s: item 4. The same module as a, written with no query, `excludeScript=true` alone, and
 *      `bindings_inherit=strict` alone. (`a` is the API's query, both.)
 *   i: item 4's binding inheritance: written only with an `inherit` binding, never served.
 */
export const SUFFIXES = { marker: "a", control: "b", store: "d", none: "n", exclude: "e", strict: "s", inherit: "i" };
export const SERVED = ["marker", "control", "store", "none", "exclude", "strict"];

export function names(run, domain) {
  if (!RUN_FORM.test(run)) throw new Error("not a run ID");
  const base = `spikeh${run}`;
  const label = Object.fromEntries(Object.entries(SUFFIXES).map(([k, s]) => [k, `${base}${s}`]));
  return {
    base,
    label,
    host: (l) => `${l}.${domain}`,
    database: `spike-h-${run}`,
  };
}

/** Any spike H label, any run: what the clean-up and the guard accept. */
export const SPIKE_LABEL = /^spikeh[0-9a-f]{6}[a-z]$/;
export const SPIKE_SCRIPT = /^spikeh[0-9a-f]{6}[a-z]\.rel_[0-9a-f]{32}$/;
export const SPIKE_DATABASE = /^spike-h-[0-9a-f]{6}$/;

export function scriptName(label, hex32) {
  if (!SPIKE_LABEL.test(label) || !/^[0-9a-f]{32}$/.test(hex32)) throw new Error("not a script name");
  return `${label}.rel_${hex32}`;
}

/** A serve entry's key that is the spike's: `spikeh<run><letter>.<domain>`, any run. */
export function spikeKey(key, domain) {
  if (typeof key !== "string" || !key.endsWith(`.${domain}`)) return false;
  return SPIKE_LABEL.test(key.slice(0, key.length - domain.length - 1));
}

// ---- a release ----

/** The manifest's hash of one file: the API's (`upload.rs`): SHA-256 over the type, a NUL and the bytes, 32 hex. */
export function manifestHash(type, bytes) {
  return createHash("sha256").update(Buffer.from(type, "utf8")).update(Buffer.from([0])).update(bytes).digest("hex").slice(0, 32);
}

/** The static marker's body for a label: what the asset holds. */
export function assetMarker(label) {
  return JSON.stringify({ spike: "h", source: "asset", label });
}

/** A release's static files: the marker, as the job adds it to every release, and a page. */
export function releaseFiles(label) {
  const files = [
    { path: `/${MARKER_PATH}`, type: "application/json", bytes: Buffer.from(assetMarker(label)) },
    { path: "/index.html", type: "text/html; charset=utf-8", bytes: Buffer.from("<!doctype html><title>spike h</title><p>asset</p>\n") },
  ];
  return files.map((f) => ({ ...f, hash: manifestHash(f.type, f.bytes), size: f.bytes.length }));
}

/**
 * The app's one module. It answers every path it is given, the marker's included, with JSON naming itself as the
 * source; `/spike-h/outbound` runs the outbound probes; `/spike-h/store` queries its store if it has one. It reports
 * the names of its environment's bindings, never their values. `tag` is written into the source, so a read of the
 * script's content or an answer from the host says which write it came from.
 */
export function moduleSource(tag) {
  if (!/^[a-z0-9-]{1,40}$/.test(tag)) throw new Error("not a tag");
  return `import { connect } from "cloudflare:sockets";
const TAG = ${JSON.stringify(tag)};
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error("spike timeout"), { name: "SpikeTimeout" })), ms))]);
const err = (e) => ({ name: String(e && e.name), message: String(e && e.message).slice(0, 200) });
async function tryFetch(url) {
  const t = Date.now();
  try {
    const r = await within(fetch(url, { redirect: "manual" }), 8000);
    const body = (await within(r.text(), 4000)).slice(0, 200);
    return { url, status: r.status, body, ms: Date.now() - t };
  } catch (e) {
    return { url, error: err(e), ms: Date.now() - t };
  }
}
async function trySocket(hostname, port) {
  const t = Date.now();
  const out = { hostname, port, opened: false, bytes_read: 0 };
  let socket;
  try {
    socket = connect({ hostname, port });
  } catch (e) {
    return { ...out, at: "connect", error: err(e), ms: Date.now() - t };
  }
  try {
    if (socket.opened) await within(socket.opened, 6000);
    out.opened = true;
    const w = socket.writable.getWriter();
    await within(w.write(new TextEncoder().encode("HEAD / HTTP/1.0\\r\\nHost: " + hostname + "\\r\\n\\r\\n")), 4000);
    const r = socket.readable.getReader();
    const chunk = await within(r.read(), 6000);
    out.bytes_read = chunk && chunk.value ? chunk.value.length : 0;
    out.first = chunk && chunk.value ? new TextDecoder().decode(chunk.value.slice(0, 12)) : null;
  } catch (e) {
    out.at = out.opened ? "use" : "opened";
    out.error = err(e);
  }
  try { socket.close(); } catch {}
  return { ...out, ms: Date.now() - t };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = { spike: "h", source: "worker", tag: TAG, path: url.pathname, env: Object.keys(env ?? {}).sort() };
    if (url.pathname === "/spike-h/outbound") {
      const fetches = [await tryFetch("https://www.google.com/"), await tryFetch("http://neverssl.com/"), await tryFetch("https://cloudflare.com/cdn-cgi/trace")];
      const sockets = [await trySocket("google.com", 80), await trySocket("google.com", 443), await trySocket("8.8.8.8", 53), await trySocket("neverssl.com", 80)];
      return json({ ...base, fetches, sockets });
    }
    if (url.pathname === "/spike-h/store") {
      if (!env || !env.STORE) return json({ ...base, store: "none" });
      try {
        const row = await within(env.STORE.prepare("select 7 as seven").first(), 8000);
        return json({ ...base, store: row });
      } catch (e) {
        return json({ ...base, store: "error", error: err(e) });
      }
    }
    return json(base);
  },
};
`;
}

// ---- judges: each item's properties, asserted ----

/** What a host answered, read as JSON: who answered (`asset`, `worker`, or `other`), and for which label. */
export function source(status, body, label) {
  let v = null;
  try {
    v = JSON.parse(body);
  } catch {}
  if (status === 200 && v?.spike === "h" && v.source === "asset" && v.label === label && body === assetMarker(label)) return "asset";
  if (status === 200 && v?.spike === "h" && v.source === "worker") return "worker";
  return `other-${status}`;
}

/**
 * Item 1. `reads`: the marker job's own request (exact path, its headers) to host a, repeated; `head`: the same as HEAD;
 * `other`: a path with no file on host a; `control`: the marker's path on host b (run_worker_first).
 * Holds only if every exact read on a was the asset, HEAD was 200 with no body, a path with no asset reached the
 * module (so the module was live and could have answered), and on b the module answered the marker's path (so the
 * test can see it if it does).
 */
export function judgeMarker({ reads, head, other, control }) {
  const failed = [];
  if (!Array.isArray(reads) || reads.length === 0) failed.push("no read of the marker on host a");
  else if (!reads.every((r) => r === "asset")) failed.push(`the marker's path on host a wasn't always the asset: ${reads.join(",")}`);
  if (!(head?.status === 200 && head.bytes === 0)) failed.push("HEAD of the marker on host a wasn't 200 with no body");
  if (other !== "worker") failed.push(`a path with no file on host a didn't reach the module (${other}), so the module wasn't shown live`);
  if (control !== "worker") failed.push(`the control (run_worker_first) didn't let the module answer the marker's path (${control})`);
  return { holds: failed.length === 0, failed };
}

/**
 * Item 3. `probe`: the module's own report from `/spike-h/outbound`, through the content Worker. Holds only if every
 * fetch got exactly the outbound Worker's refusal, and no socket opened or read a byte.
 */
export function judgeOutbound(probe) {
  const failed = [];
  if (!probe || probe.source !== "worker" || !Array.isArray(probe.fetches) || !Array.isArray(probe.sockets)) return { holds: false, failed: ["no probe report"] };
  for (const f of probe.fetches) if (!(f.status === OUTBOUND_STATUS && f.body === OUTBOUND_BODY)) failed.push(`fetch ${f.url} wasn't the outbound Worker's refusal`);
  for (const s of probe.sockets) if (s.opened || s.bytes_read > 0) failed.push(`socket ${s.hostname}:${s.port} opened or read`);
  if (probe.fetches.length === 0 || probe.sockets.length === 0) failed.push("no fetch or no socket tried");
  return { holds: failed.length === 0, failed };
}

/**
 * Item 2. `list`: the bindings the provider listed for script d; `id`: the database's ID; `served`: host d's report
 * from `/spike-h/store`; `staticList`: script a's bindings. Holds only if d's list is exactly one entry of type d1,
 * name STORE and that ID (any other field recorded, not judged), the module reached the store and saw only STORE, and
 * a script with no binding lists `[]`.
 */
export function judgeBindings({ list, id, served, staticList }) {
  const failed = [];
  if (!Array.isArray(list)) failed.push("the bindings weren't read as a list");
  else if (!(list.length === 1 && list[0]?.type === D1_TYPE && list[0]?.name === STORE_BINDING && list[0]?.id === id)) failed.push("the list wasn't exactly the one store binding with the database's ID");
  if (!(served?.source === "worker" && served.store?.seven === 7 && JSON.stringify(served.env) === JSON.stringify([STORE_BINDING]))) failed.push("the module didn't reach its store, or saw a binding but STORE");
  if (!(Array.isArray(staticList) && staticList.length === 0)) failed.push("a script with no binding didn't list []");
  return { holds: failed.length === 0, failed };
}

/**
 * Item 4. `writes`: for each query, { ok (200 and success, the script's own name), content (the module's source as
 * read back held the tag), served (the host's module answered with the tag) }. `rewrites`: re-writes of d with `[]`
 * under no query and under strict, each { ok, list }. Holds only if every query took the module and served it, and no
 * re-write with `[]` kept the old binding.
 */
export function judgeQuery({ writes, rewrites }) {
  const failed = [];
  for (const q of Object.keys(QUERIES)) {
    const w = writes?.[q];
    if (!w?.ok) failed.push(`the write with query "${q}" wasn't taken`);
    else {
      if (!w.content) failed.push(`the script written with query "${q}" didn't read back its module`);
      if (!w.served) failed.push(`the script written with query "${q}" didn't serve its module`);
    }
  }
  for (const [q, r] of Object.entries(rewrites ?? {})) if (!(r.ok && Array.isArray(r.list) && r.list.length === 0)) failed.push(`a re-write with [] under "${q}" kept a binding or wasn't taken`);
  if (Object.keys(rewrites ?? {}).length === 0) failed.push("no re-write tried");
  return { holds: failed.length === 0, failed };
}

// ---- recording ----

/** Takes every secret and every 32-hex ID, UUID and JWT out of a line before it is kept or shown. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (typeof s === "string" && s.length > 0) out = out.split(s).join("<secret>");
  return out
    .replace(/cfwau_[A-Za-z0-9._-]+/g, "<session-token>")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/[0-9a-f]{32}/gi, "<id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
}

/** A value's shape: keys and types, never values. */
export function shapeOf(value, depth = 3) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? ["empty"] : [`length ${value.length}`, depth > 0 ? shapeOf(value[0], depth - 1) : "…"];
  if (typeof value === "object") {
    if (depth <= 0) return "object";
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], depth - 1)]));
  }
  return typeof value;
}

/** The run's limits. The runner stops and cleans up at either. */
export const BOUNDS = { ms: 15 * 60_000, api: 300, edge: 800, cleanupApi: 120, cleanupMs: 5 * 60_000 };
