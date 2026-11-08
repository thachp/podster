/**
 * `crates/egress`'s wake URL rules, written again in TypeScript for this spike only. In M3 the check stays in Rust, in the
 * `apps/api` consumer. Decision 134: these rules, `global_fetch_strictly_public`, no redirects, and no check of what a
 * name resolves to.
 */

const MAX_URL_BYTES = 2048;
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "private", "test", "example", "invalid", "onion", "arpa", "podster.dev"];

export type Refusal = "too_long" | "not_a_url" | "not_https" | "has_credentials" | "has_fragment" | "not_default_port" | "ip_address" | "not_public_name";

export function checkEndpoint(raw: string): { ok: true; url: string } | { ok: false; refusal: Refusal } {
  if (raw.length > MAX_URL_BYTES) return { ok: false, refusal: "too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refusal: "not_a_url" };
  }
  if (url.protocol !== "https:") return { ok: false, refusal: "not_https" };
  if (url.username || url.password) return { ok: false, refusal: "has_credentials" };
  if (url.hash || raw.includes("#")) return { ok: false, refusal: "has_fragment" };
  if (url.port) return { ok: false, refusal: "not_default_port" };
  const host = url.hostname;
  // WHATWG URL turns `0x7f.1` and `2130706433` into dotted IPv4, and IPv6 keeps its brackets.
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, refusal: "ip_address" };
  const name = host.replace(/\.$/, "").toLowerCase();
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((l) => l === "")) return { ok: false, refusal: "not_public_name" };
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, refusal: "not_public_name" };
  if (PRIVATE_SUFFIXES.some((s) => name === s || name.endsWith(`.${s}`))) return { ok: false, refusal: "not_public_name" };
  const normalized = url.toString();
  if (normalized.length > MAX_URL_BYTES) return { ok: false, refusal: "too_long" };
  return { ok: true, url: normalized };
}
