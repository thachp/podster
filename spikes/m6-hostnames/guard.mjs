// What spike D may send to Cloudflare. No I/O here, so `node --test` covers it offline.
//
// The spike holds a token that can make and delete custom hostnames on the content zone, and a token on the
// second account. So every request goes through `allow` first. A GET goes anywhere on Cloudflare's API (the runner
// only lists, and reads what it made). Anything else must name something this spike made:
// - a custom hostname's create, only for a name in SPIKE_HOSTNAMES, with exactly {method: http, type: dv};
// - a custom hostname's delete, only for an ID the runner holds in `made`, which it fills only from the answer to
//   such a create, or from a listing, for an entry whose name is a spike name;
// - a script on the second account named ^spike-hostnames-[a-z0-9-]{1,30}$, and that script's workers.dev switch.

/** The only names the spike may ask for as custom hostnames, all under opster.dev, which the owner holds. */
export const SPIKE_HOSTNAMES = new Set([
  "spike.opster.dev",
  "x.spike.opster.dev",
  "Spike-Case.Opster.Dev",
  "spike-dot.opster.dev.",
]);

/** A name as Cloudflare might store it: lower case, no trailing dot. Used only to match a listing's entries. */
export const folded = (name) => String(name).toLowerCase().replace(/\.$/, "");
const FOLDED = new Set([...SPIKE_HOSTNAMES].map(folded));
export const spikeHostname = (name) => typeof name === "string" && FOLDED.has(folded(name));

export const SCRIPT_NAME = /^spike-hostnames-[a-z0-9-]{1,30}$/;

const ORIGIN = "https://api.cloudflare.com";
const ROOT = "/client/v4/";
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Throws unless the request may be sent.
 * `ctx`: { zone, account, made } — the zone's and the second account's IDs, and the set of custom hostname IDs
 * the spike made or listed under a spike name.
 */
export function allow(method, url, body, ctx) {
  const u = new URL(url);
  if (u.origin !== ORIGIN || !u.pathname.startsWith(ROOT)) throw new Error("refusing: not Cloudflare's API");
  if (method === "GET") return;
  const path = u.pathname.slice(ROOT.length - 1);
  const { zone, account, made } = ctx;
  if (HEX32.test(zone ?? "")) {
    const base = `/zones/${zone}/custom_hostnames`;
    if (method === "POST" && path === base && u.search === "") {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("refusing: a create's body isn't JSON");
      }
      const keys = Object.keys(parsed ?? {}).sort().join(",");
      if (keys !== "hostname,ssl") throw new Error(`refusing: a create may carry only hostname and ssl, not ${keys}`);
      if (!SPIKE_HOSTNAMES.has(parsed.hostname)) throw new Error("refusing: not a spike hostname");
      const ssl = parsed.ssl ?? {};
      if (Object.keys(ssl).sort().join(",") !== "method,type" || ssl.method !== "http" || ssl.type !== "dv") {
        throw new Error("refusing: ssl must be exactly {method: http, type: dv}");
      }
      return;
    }
    if (method === "DELETE" && path.startsWith(`${base}/`)) {
      const id = path.slice(base.length + 1);
      if ((UUID.test(id) || HEX32.test(id)) && made.has(id) && u.search === "") return;
      throw new Error("refusing: not a custom hostname the spike made");
    }
  }
  if (HEX32.test(account ?? "")) {
    const scripts = `/accounts/${account}/workers/scripts/`;
    if (path.startsWith(scripts)) {
      const [name, sub, more] = path.slice(scripts.length).split("/");
      if (SCRIPT_NAME.test(name) && more === undefined) {
        if (sub === undefined && (method === "PUT" || method === "DELETE")) return;
        if (sub === "subdomain" && method === "POST") return;
      }
    }
  }
  throw new Error(`refusing: ${method} on a path the spike may not write`);
}
