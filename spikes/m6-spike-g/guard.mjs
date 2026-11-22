// What spike G may send to Cloudflare's API. No I/O here, so `node --test` covers it offline.
//
// The spike holds a token that can write any key in the serve entries' KV namespace, a token that can write any
// Worker script on the second account, and, for the TXT half, a token that can edit one test zone's DNS. So every
// API request goes through `allow` first. A GET may read anywhere on the API. Anything else must name something of
// the spike's own form, on the configured account, namespace or zone:
// - a KV value: only a spike key (`pure.mjs` `spikeKey`); the stop key only with the spike's own value, only when the
//   run's gate allowed it, and deleted only right after a read found a spike's value there;
// - a release script in the dispatch namespace, its upload session, and the assets upload: only a spike script name;
// - one Worker outside the namespace, `spike-g-probe-<run>`, and its workers.dev switch;
// - a TXT record on the DNS zone: only a spike name, with exactly type, name, content and TTL 60; deleted only by an
//   ID the runner got from such a create or from a listing under a spike name.
import { PROBE_SCRIPT, SPIKE_SCRIPT, STOP_KEY, spikeKey, spikeTxtName, stopValue } from "./pure.mjs";

const ORIGIN = "https://api.cloudflare.com";
const ROOT = "/client/v4";
const HEX32 = /^[0-9a-f]{32}$/;

/**
 * Throws unless the request may be sent.
 * `ctx`: { account, kv, ns, domain, run, stopAllowed, stopReadSpike, dnsZone, dnsZoneId, madeDns }.
 */
export function allow(method, url, body, ctx) {
  const u = new URL(url);
  if (u.origin !== ORIGIN || !u.pathname.startsWith(`${ROOT}/`)) throw new Error("refusing: not Cloudflare's API");
  if (u.username || u.password || u.hash) throw new Error("refusing: a URL with credentials or a fragment");
  if (method === "GET") return;
  const path = u.pathname.slice(ROOT.length);
  const search = u.search;
  const { account, kv, ns, domain } = ctx;
  if (!HEX32.test(account ?? "")) throw new Error("refusing: no account");

  const acc = `/accounts/${account}`;
  const values = `${acc}/storage/kv/namespaces/${kv}/values/`;
  if (HEX32.test(kv ?? "") && path.startsWith(values) && search === "") {
    const key = decodeURIComponent(path.slice(values.length));
    if (spikeKey(key, domain) && (method === "PUT" || method === "DELETE")) return;
    if (key === STOP_KEY) {
      if (method === "PUT" && ctx.stopAllowed === true && body === stopValue(ctx.run)) return;
      // Only right after a read that found a spike's value there (`isSpikeStop`). The guard can't read, so it trusts
      // this flag, which only the runner's `deleteStopIfOurs` sets, for its one delete. KV has no compare-and-delete:
      // a write by someone else between that read and this delete would be deleted with it. That window is a known
      // limit, accepted because the gate keeps the stop part to a namespace that holds only the spike's keys.
      if (method === "DELETE" && ctx.stopReadSpike === true) return;
    }
    throw new Error("refusing: a KV key that isn't the spike's");
  }

  const dispatch = `${acc}/workers/dispatch/namespaces/${ns}/scripts/`;
  if (/^[a-z0-9-]{1,63}$/.test(ns ?? "") && path.startsWith(dispatch)) {
    const [name, sub, more] = path.slice(dispatch.length).split("/");
    if (SPIKE_SCRIPT.test(name) && more === undefined) {
      if (sub === undefined && method === "PUT" && search === "?excludeScript=true&bindings_inherit=strict") return;
      if (sub === undefined && method === "DELETE" && search === "?force=true") return;
      if (sub === "assets-upload-session" && method === "POST" && search === "") return;
    }
    throw new Error("refusing: a namespace script that isn't the spike's");
  }

  if (path === `${acc}/workers/assets/upload` && method === "POST" && search === "?base64=true") return;

  const scripts = `${acc}/workers/scripts/`;
  if (path.startsWith(scripts)) {
    const [name, sub, more] = path.slice(scripts.length).split("/");
    if (PROBE_SCRIPT.test(name) && more === undefined && search === "") {
      if (sub === undefined && (method === "PUT" || method === "DELETE")) return;
      if (sub === "subdomain" && method === "POST") return;
    }
    throw new Error("refusing: a Worker that isn't the spike's probe");
  }

  if (HEX32.test(ctx.dnsZoneId ?? "")) {
    const records = `/zones/${ctx.dnsZoneId}/dns_records`;
    if (method === "POST" && path === records && search === "") {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("refusing: a record's body isn't JSON");
      }
      if (Object.keys(parsed ?? {}).sort().join(",") !== "content,name,ttl,type") throw new Error("refusing: a record carries exactly type, name, content and ttl");
      if (parsed.type !== "TXT" || parsed.ttl !== 60) throw new Error("refusing: only a TXT record with TTL 60");
      if (!spikeTxtName(parsed.name, ctx.dnsZone)) throw new Error("refusing: not a spike TXT name");
      if (typeof parsed.content !== "string" || !/^"?podster-spike-g=[0-9a-f]{32}"?$/.test(parsed.content)) throw new Error("refusing: not a spike TXT value");
      return;
    }
    if (method === "DELETE" && path.startsWith(`${records}/`) && search === "") {
      const id = path.slice(records.length + 1);
      if (HEX32.test(id) && ctx.madeDns?.has(id)) return;
      throw new Error("refusing: not a TXT record the spike made");
    }
  }
  throw new Error(`refusing: ${method} on a path the spike may not write`);
}
