// The provider transport: the only part of the spike that holds the key. It sends the broker's forward to the one
// upstream with the key added last, refuses a forward that carries any authorization of its own, never follows a
// redirect, and never logs, returns or stores the key. Also the start checks: the key file, the key's provider and
// the process environment.

import { lstatSync, readFileSync } from "node:fs";
import { upstreamUrl } from "./profile.mjs";

/** OpenAI project keys only. An Anthropic key (or anything else) is refused, so it is never sent to OpenAI. */
const KEY_PATTERNS = { openai: /^sk-proj-[A-Za-z0-9_-]{40,400}$/ };

/** Why a key can't be used for this profile's provider, or null. Never includes the key. */
export function keyRefusal(key, profile) {
  if (typeof key !== "string") return "key_format";
  if (key.startsWith("sk-ant-")) return "key_provider";
  const pattern = KEY_PATTERNS[profile.provider];
  if (!pattern) return "key_provider";
  return pattern.test(key) ? null : "key_format";
}

/**
 * Read the key file once: a regular file, not a link, owned by this user, readable by no one else, one line.
 * Throws an error naming the failed check only.
 */
export function readKeyFile(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("key_file: not a regular file");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("key_file: not owned by this user");
  if ((st.mode & 0o077) !== 0) throw new Error("key_file: readable by others");
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("key_file: not exactly one key");
  return lines[0];
}

/**
 * Environment names the spike refuses to start with: anything that could point the SDK or client elsewhere, hand
 * them a key, or change TLS trust or proxying for this process. The three disabling names are allowed.
 */
const ALLOWED_OPENAI_ENV = new Set(["OPENAI_AGENTS_DISABLE_TRACING", "OPENAI_AGENTS_DONT_LOG_MODEL_DATA", "OPENAI_AGENTS_DONT_LOG_TOOL_DATA"]);
const REFUSED_ENV = [
  "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
];

/** The refused environment names found, or an empty list. Values are never read into the result. */
export function envRefusals(env = process.env) {
  const found = [];
  for (const name of Object.keys(env)) {
    if (/^OPENAI_/i.test(name) && !ALLOWED_OPENAI_ENV.has(name)) found.push(name);
    else if (REFUSED_ENV.includes(name)) found.push(name);
  }
  return found.sort();
}

/**
 * Build the transport for one profile. `fetchImpl` is the real fetch in a real run; tests pass a fake upstream.
 * `sent` counts forwards that left for the upstream, so a test can show a refused request never got here.
 */
export function providerTransport({ profile, key, fetchImpl = globalThis.fetch }) {
  const bad = keyRefusal(key, profile);
  if (bad) throw new Error(`transport refused: ${bad}`);
  const expected = upstreamUrl(profile);
  const t = {
    sent: 0,
    async send(forward, signal) {
      if (forward.url !== expected) throw new Error("transport refused: url");
      for (const name of Object.keys(forward.headers)) {
        const lower = name.toLowerCase();
        if (lower === "authorization" || lower === "x-api-key" || lower.startsWith("openai-")) throw new Error("transport refused: header");
      }
      const headers = { ...forward.headers, authorization: `Bearer ${key}` };
      t.sent++;
      return fetchImpl(expected, { method: "POST", headers, body: forward.body, signal, redirect: "error" });
    },
  };
  return t;
}
