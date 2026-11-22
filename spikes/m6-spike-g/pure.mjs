// M6 spike G: the parts with no I/O, so `node --test` covers them offline. See README.md.
//
// Names, the plan, the arguments, the redaction, and how an answer is read: a host's answer, a timeline of them, and
// a DNS-over-HTTPS answer.

import { createHash } from "node:crypto";

/** The spike's run ID: 6 lower-case hex digits. Every name it makes carries it. */
export const RUN_FORM = /^[0-9a-f]{6}$/;

/** The compatibility date every release script is written with: `podster_core::app_code::COMPATIBILITY_DATE`. */
export const COMPATIBILITY_DATE = "2026-11-01";
/** The fixed assets configuration the API writes (`apps/api/src/content_provider/upload.rs`, `ASSETS_CONFIG`). */
export const ASSETS_CONFIG = { html_handling: "auto-trailing-slash", not_found_handling: "none" };
/** The release's marker, as `podster_core::release_tree::MARKER_PATH` has it. */
export const MARKER_PATH = ".well-known/podster-release.json";
/** The stop key, as `apps/api/src/content_provider.rs` and `apps/content/src/names.ts` have it. */
export const STOP_KEY = "_stop";

// ---- names ----

/** Every label, key, script and record the spike makes, for one run. All derive from the run ID. */
export function names(run, domain, dnsZone = "opster.dev") {
  if (!RUN_FORM.test(run)) throw new Error("not a run ID");
  const base = `spikeg${run}`;
  const cold = ["c1", "c2", "c3"].map((s) => `${base}${s}`);
  const warm = `${base}w`;
  const takedown = [...cold, warm];
  return {
    run,
    cold,
    warm,
    takedown,
    /** The keys only the lists read: 25, so a page of 10 has two more after it. */
    listKeys: Array.from({ length: 25 }, (_, i) => `${base}l${String(i).padStart(2, "0")}.${domain}`),
    /** A key never written, for the provider's answer to a missing key. */
    missingKey: `${base}x.${domain}`,
    host: (label) => `${label}.${domain}`,
    /** A label for an upload session that is never completed: the provider's buckets for a full-size manifest. */
    sessionLabel: `${base}m`,
    probe: `spike-g-probe-${run}`,
    txt: { primed: `_spike-g-${run}a.${dnsZone}`, fresh: `_spike-g-${run}b.${dnsZone}` },
  };
}

/** A serve entry's key this spike may write or delete: one of its own hosts on the content domain. */
export function spikeKey(key, domain) {
  if (typeof key !== "string" || typeof domain !== "string") return false;
  const suffix = `.${domain}`;
  if (!key.endsWith(suffix)) return false;
  return /^spikeg[0-9a-f]{6}(c[1-3]|w|x|l[0-9]{2})$/.test(key.slice(0, -suffix.length));
}
/** A script in the dispatch namespace this spike may write or delete. */
export const SPIKE_SCRIPT = /^spikeg[0-9a-f]{6}(c[1-3]|w|m)\.rel_[0-9a-f]{32}$/;
/** The probe Worker, the one script this spike may write outside the namespace. */
export const PROBE_SCRIPT = /^spike-g-probe-[0-9a-f]{6}$/;
/** A TXT record name this spike may make or delete, under the DNS zone. */
export function spikeTxtName(name, zone) {
  if (typeof name !== "string" || typeof zone !== "string") return false;
  const suffix = `.${zone}`;
  return name.endsWith(suffix) && /^_spike-g-[0-9a-f]{6}[ab]$/.test(name.slice(0, -suffix.length));
}
/** The value this spike writes to the stop key, so a clean-up can tell its own stop from anyone else's. */
export const stopValue = (run) => `spike-g stop ${run}`;
export const isSpikeStop = (value) => typeof value === "string" && /^spike-g stop [0-9a-f]{6}$/.test(value);

/** A release script's name: `<label>.rel_<32 hex>`, as `podster_core::release::script_owner` reads one. */
export function scriptName(label, hex32) {
  if (!/^[a-z0-9]{1,26}$/.test(label) || !/^[0-9a-f]{32}$/.test(hex32)) throw new Error("not a script name");
  return `${label}.rel_${hex32}`;
}

// ---- a release's files ----

/** The manifest hash the API uses: the first 32 hex of SHA-256 over the type, a zero byte, and the bytes. */
export function manifestHash(type, bytes) {
  return createHash("sha256").update(Buffer.from(type, "utf8")).update(Buffer.from([0])).update(bytes).digest("hex").slice(0, 32);
}

/** 200 KB of text that compresses well, for the `no-transform` check. */
export function compressibleText(bytes = 200_000) {
  const line = "podster spike g: the same line again, so any compressor would shrink it a great deal.\n";
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

/** The files of one spike release: its marker, a page, a large text file, and a root `_headers` and `_redirects`. */
export function releaseFiles(label, version) {
  const marker = JSON.stringify({ spike: "g", label, version });
  const files = [
    { path: `/${MARKER_PATH}`, type: "application/json", bytes: Buffer.from(marker) },
    { path: "/index.html", type: "text/html; charset=utf-8", bytes: Buffer.from(`<!doctype html><title>spike g</title><p>${version}</p>\n`) },
    { path: "/big.txt", type: "text/plain; charset=utf-8", bytes: Buffer.from(compressibleText()) },
    // Sent as ordinary files with an ordinary type. If the platform read either, the marker's type would change or
    // `/spike-g-from` would redirect.
    { path: "/_headers", type: "application/octet-stream", bytes: Buffer.from(`/${MARKER_PATH}\n  Content-Type: text/x-spike-g-headers\n`) },
    { path: "/_redirects", type: "application/octet-stream", bytes: Buffer.from(`/spike-g-from /${MARKER_PATH} 302\n`) },
  ];
  return files.map((f) => ({ ...f, hash: manifestHash(f.type, f.bytes), size: f.bytes.length }));
}

/** A full-size manifest that is never uploaded: 300 files, 25 MB, one of them 5 MB. Hashes are made up and unique. */
export function fullSizeManifest() {
  const manifest = {};
  const fake = (i) => createHash("sha256").update(`spike-g manifest ${i}`).digest("hex").slice(0, 32);
  manifest["/big-5mb.bin"] = { hash: fake(0), size: 5_000_000 };
  const each = Math.floor(20_000_000 / 299);
  for (let i = 1; i < 300; i++) manifest[`/f/${String(i).padStart(3, "0")}.bin`] = { hash: fake(i), size: each };
  return manifest;
}

// ---- what a host answered ----

/** What a host's answer says: the release `v1` or `v2` of `label`, the content Worker's not-found, or something else. */
export function readHost(status, body, label) {
  if (status === 404 && body === "not_found\n") return "absent";
  if (status === 200) {
    try {
      const marker = JSON.parse(body);
      if (marker?.spike === "g" && marker.label === label && (marker.version === "v1" || marker.version === "v2")) return marker.version;
    } catch {}
  }
  return `other-${status}`;
}

/**
 * A timeline of reads of one host after a change at `t0`, read for one `target` state. `samples` are
 * `{ sent, done, state }` with times in ms. Answers when the target was first seen, when it was seen from then on with
 * nothing else, and how many reads after the first saw something else.
 */
export function timeline(samples, target, t0) {
  const sorted = [...samples].sort((a, b) => a.sent - b.sent);
  const firstIdx = sorted.findIndex((s) => s.state === target);
  if (firstIdx < 0) return { seen: false, reads: sorted.length, states: countStates(sorted) };
  let lastOther = -1;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].state !== target) lastOther = i;
  const flipsAfterFirst = sorted.slice(firstIdx + 1).filter((s) => s.state !== target).length;
  // The answer is bounded by when the read that saw it was sent and when it came back.
  const first = sorted[firstIdx];
  const stableFrom = lastOther < firstIdx ? first : sorted[lastOther + 1];
  return {
    seen: true,
    first_ms: { sent: first.sent - t0, done: first.done - t0 },
    stable_ms: stableFrom ? { sent: stableFrom.sent - t0, done: stableFrom.done - t0 } : null,
    last_other_ms: lastOther >= 0 ? sorted[lastOther].sent - t0 : null,
    flips_after_first: flipsAfterFirst,
    reads: sorted.length,
    states: countStates(sorted),
  };
}
function countStates(samples) {
  const out = {};
  for (const s of samples) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

// ---- DNS over HTTPS ----

/** A TXT record's text as a resolver gave it: Cloudflare quotes it and may split it into strings; Google doesn't. */
export function txtText(data) {
  const s = String(data ?? "").trim();
  if (!s.startsWith('"')) return s;
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  return parts.join("");
}

/**
 * What one resolver's answer says about `name`'s TXT `expected` value:
 * - `found`: the value is there, owned by `name` itself;
 * - `no-record`: a definite no: `NOERROR` with no TXT for the name (owned by it), or `NXDOMAIN`;
 * - `no-answer`: nothing can be concluded: no HTTP answer, a timeout, not `200`, not JSON, truncated, `SERVFAIL`,
 *   `REFUSED` or any other code, or TXT answers that are someone else's (through a CNAME) and not the value.
 * `kind` says which, more finely.
 */
export function readDoh(answer, name, expected) {
  if (!answer || answer.error) return { verdict: "no-answer", kind: answer?.error ? `error-${answer.error}` : "none" };
  if (answer.http !== 200) return { verdict: "no-answer", kind: `http-${answer.http}` };
  const j = answer.json;
  if (!j || typeof j.Status !== "number") return { verdict: "no-answer", kind: "not-json" };
  if (j.TC === true) return { verdict: "no-answer", kind: "truncated" };
  if (j.Status === 3) return { verdict: "no-record", kind: "nxdomain" };
  if (j.Status !== 0) return { verdict: "no-answer", kind: `rcode-${j.Status}` };
  const folded = (n) => String(n ?? "").toLowerCase().replace(/\.$/, "");
  const own = (j.Answer ?? []).filter((a) => a.type === 16 && folded(a.name) === folded(name));
  if (own.some((a) => txtText(a.data) === expected)) return { verdict: "found", kind: "value" };
  if (own.length > 0) return { verdict: "no-record", kind: "other-value" };
  const cname = (j.Answer ?? []).some((a) => a.type === 5);
  if (cname) return { verdict: "no-answer", kind: "cname" };
  return { verdict: "no-record", kind: "nodata" };
}

// ---- arguments and redaction ----

const OPTIONS = new Set(["--config", "--kv-token-file", "--scripts-token-file", "--dns-token-file"]);
const FLAGS = new Set(["--no-stop", "--no-dns"]);
export const COMMANDS = new Set(["plan", "run", "cursor", "cleanup"]);

/** The command line: a command, then `--option <path>` pairs and flags. Anything else is refused. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) throw new Error(`the command must be one of: ${[...COMMANDS].join(", ")}`);
  const out = { command, flags: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (FLAGS.has(a)) {
      out.flags.add(a.slice(2));
      continue;
    }
    if (a.includes("=")) throw new Error("give an option's path after a space, never with `=`");
    if (!OPTIONS.has(a)) throw new Error(`unknown option ${JSON.stringify(a.slice(0, 40))}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a file path`);
    // A path, never a token: a token passed here would be refused as no file, but say so before it is looked up.
    if (!/[/.~]/.test(value)) throw new Error(`${a} takes a file's path (with a / or a .), never a value`);
    out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

/** The configuration file: names and IDs, none of them secret, kept out of the repository. Exactly these keys. */
export function checkConfig(c) {
  const keys = ["account_id", "content_domain", "content_worker", "dispatch_namespace", "dns_zone", "kv_namespace_id"];
  if (!c || typeof c !== "object" || Object.keys(c).sort().join(",") !== keys.join(",")) {
    throw new Error(`the configuration must hold exactly: ${keys.join(", ")}`);
  }
  const hex32 = /^[0-9a-f]{32}$/;
  const host = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  if (!hex32.test(c.account_id)) throw new Error("account_id: 32 lower-case hex digits");
  if (!hex32.test(c.kv_namespace_id)) throw new Error("kv_namespace_id: 32 lower-case hex digits");
  if (!/^[a-z0-9-]{1,63}$/.test(c.dispatch_namespace)) throw new Error("dispatch_namespace: a namespace's name");
  if (!/^[a-z0-9-]{1,63}$/.test(c.content_worker)) throw new Error("content_worker: a Worker's name");
  if (!host.test(c.content_domain) || c.content_domain === "podster.dev") throw new Error("content_domain: the content domain, never podster.dev");
  if (!host.test(c.dns_zone) || c.dns_zone === "podster.dev" || c.dns_zone === c.content_domain) {
    throw new Error("dns_zone: the test zone for TXT records, never podster.dev or the content domain");
  }
  return c;
}

/** Hides every secret, every 32-hex ID, every UUID and every JWT. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("<secret>");
  return out
    .replace(/cfwau_[A-Za-z0-9._-]+/g, "<session-token>")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/[0-9a-f]{32}/gi, "<id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
}

// ---- bounds ----

/** The run's limits. The runner stops and cleans up at either. */
export const BOUNDS = {
  run: { ms: 20 * 60_000, api: 900, edge: 5_000, probe: 400 },
  cursor: { ms: 13 * 60_000, api: 120, edge: 0, probe: 0 },
  cleanup: { ms: 3 * 60_000, api: 200, edge: 0, probe: 0 },
};
/** How long one phase of the takedown is watched before it is recorded as not seen. */
export const PHASE_WATCH_MS = 120_000;
/** How often a host is read while a phase is watched. */
export const POLL_MS = 500;
/** How long reading goes on after the target is first seen, to catch it flipping back. */
export const SETTLE_MS = 10_000;
/** When the cursor is used again, after it was given. */
export const CURSOR_AGES_MS = [0, 60_000, 330_000, 630_000];

/** What `plan` prints: everything a command would make, and its bounds. No network, no token. */
export function plan(command, n, c) {
  const host = (l) => `${l}.${c.content_domain}`;
  const lines = [];
  const add = (s) => lines.push(s);
  if (command === "run") {
    add(`Run ${n.run}: at most ${BOUNDS.run.ms / 60_000} min, ${BOUNDS.run.api} API calls, ${BOUNDS.run.edge} reads of the content domain, ${BOUNDS.run.probe} calls to the probe.`);
    add(`On the account, KV namespace and dispatch namespace the configuration names (none printed), against the content Worker ${c.content_worker} on ${c.content_domain}.`);
    add("Creates, in the dispatch namespace (scripts token), 8 static release scripts, 2 for each label:");
    for (const l of n.takedown) add(`  ${l}.rel_<32 hex> (v1) and ${l}.rel_<32 hex> (v2), 5 files each: /${MARKER_PATH}, /index.html, /big.txt, /_headers, /_redirects`);
    add(`Opens one upload session for ${n.sessionLabel}.rel_<32 hex> (300 files, 25 MB, never uploaded or completed: no script is made).`);
    add(`Creates one Worker on the account (scripts token): ${n.probe}, on the account's existing workers.dev subdomain only, answering only a per-run header. It is skipped if the account has no workers.dev subdomain; the spike never makes one.`);
    add("Writes, in the serve entries' KV namespace (KV token), only these keys:");
    for (const l of n.takedown) add(`  ${host(l)}  (v1, then v2, then deleted; ${n.cold.includes(l) ? "never read before its first write" : "read before its first write, three cycles"})`);
    add(`  ${n.listKeys[0]} … ${n.listKeys.at(-1)}  (25 keys for the list's pages)`);
    add(`  ${n.missingKey}  (never written: read and deleted for the provider's missing-key answers)`);
    add(`  ${STOP_KEY}  (value "${stopValue(n.run)}"), only if the namespace then holds no key but this spike's and no ${STOP_KEY}, and not with --no-stop. While it is there, the content domain serves nothing.`);
    add(`Creates, on ${c.dns_zone} (DNS token), two TXT records, unless --no-dns: ${n.txt.primed} (looked up before it exists) and ${n.txt.fresh}. TTL 60.`);
    add("Reads: the content Worker's deployments and versions; the namespace's scripts, paged; the KV keys, paged; the account's workers.dev subdomain.");
    add("Ends, and on Ctrl-C, by deleting all of the above, listing again, and recording what is left.");
  } else if (command === "cursor") {
    add(`Run ${n.run}: at most ${BOUNDS.cursor.ms / 60_000} min, ${BOUNDS.cursor.api} API calls.`);
    add(`Writes ${n.listKeys.length} keys ${n.listKeys[0]} … ${n.listKeys.at(-1)} (KV token), lists them 10 at a time, and uses the first page's cursor again at ${CURSOR_AGES_MS.map((t) => `${t / 1000} s`).join(", ")}. Then deletes them and lists again.`);
  } else if (command === "cleanup") {
    add("Lists and deletes: KV keys of the spike's forms; the spike's release scripts in the namespace; spike-g-probe-* Workers; _spike-g-* TXT records on the DNS zone (with a DNS token); and the stop key only if it holds a spike's value. Then lists again.");
  }
  return lines;
}

/** A value's shape: its keys and their types, with no value kept. Arrays show their length and their first entry's shape. */
export function shapeOf(value, depth = 4) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? ["empty"] : [`length ${value.length}`, depth > 0 ? shapeOf(value[0], depth - 1) : "…"];
  if (typeof value === "object") {
    if (depth <= 0) return "object";
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], depth - 1)]));
  }
  return typeof value;
}
