// What spike H may send to Cloudflare's API. No I/O here, so `node --test` covers it offline.
//
// The spike borrows three tokens on the second account: one that can write any Worker script there, one that can
// write any key in the serve entries' KV namespace, and one that can make and delete any D1 database. So every request
// goes through `allow` first, reads included, and anything not listed here is refused:
// - reads: the token check; a spike key or the stop key; the spike's keys listed by its prefix; the namespace's list;
//   a spike script, its bindings, settings and content; the run's own database, and D1's list by the spike's name;
//   the two deployed Workers' deployments (to record which versions ran);
// - writes: a spike key (never the stop key); a spike script, by one of the four queries item 4 tries, its upload
//   session and the assets upload; a delete of a spike script by `?force=true`; the run's database, made with exactly
//   its name and deleted only by an ID the run made or listed under a spike name.
import { CONTROL_WORKER, QUERIES, SPIKE_DATABASE, SPIKE_SCRIPT, STOP_KEY, spikeKey } from "./pure.mjs";

const ORIGIN = "https://api.cloudflare.com";
const ROOT = "/client/v4";
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_QUERIES = new Set(Object.values(QUERIES));
const DEPLOYED = new Set(["podster-content", "podster-outbound"]);

/**
 * Throws unless the request may be sent.
 * `ctx`: { account, kv, ns, domain, run, madeDb: Set of database IDs this run made or listed under a spike name }.
 */
export function allow(method, url, body, ctx) {
  const u = new URL(url);
  if (u.origin !== ORIGIN || !u.pathname.startsWith(`${ROOT}/`)) throw new Error("refusing: not Cloudflare's API");
  if (u.username || u.password || u.hash) throw new Error("refusing: a URL with credentials or a fragment");
  const path = u.pathname.slice(ROOT.length);
  const search = u.search;
  const { account, kv, ns, domain } = ctx;
  if (method === "GET" && path === "/user/tokens/verify" && search === "") return;
  if (!HEX32.test(account ?? "")) throw new Error("refusing: no account");
  const acc = `/accounts/${account}`;

  // KV: the serve entries' namespace.
  const ns_kv = `${acc}/storage/kv/namespaces/${kv}`;
  if (HEX32.test(kv ?? "") && path.startsWith(`${ns_kv}/`)) {
    if (method === "GET" && path === `${ns_kv}/keys` && /^\?prefix=spikeh(&cursor=[A-Za-z0-9_%.-]+)?$/.test(search)) return;
    if (path.startsWith(`${ns_kv}/values/`) && search === "") {
      const key = decodeURIComponent(path.slice(`${ns_kv}/values/`.length));
      if (key === STOP_KEY && method === "GET") return;
      if (spikeKey(key, domain) && (method === "GET" || method === "PUT" || method === "DELETE")) return;
    }
    throw new Error("refusing: a KV call that isn't on a spike key");
  }

  // The dispatch namespace.
  const dispatch = `${acc}/workers/dispatch/namespaces/${ns}/scripts`;
  if (/^[a-z0-9-]{1,63}$/.test(ns ?? "") && (path === dispatch || path.startsWith(`${dispatch}/`))) {
    if (path === dispatch && method === "GET" && search === "") return;
    const [name, sub, more] = path.slice(dispatch.length + 1).split("/");
    if (SPIKE_SCRIPT.test(name ?? "") && more === undefined) {
      if (sub === undefined && method === "GET" && search === "") return;
      if (sub === undefined && method === "PUT" && WRITE_QUERIES.has(search)) return;
      if (sub === undefined && method === "DELETE" && search === "?force=true") return;
      if (sub === "assets-upload-session" && method === "POST" && search === "") return;
      if ((sub === "bindings" || sub === "settings" || sub === "content") && method === "GET" && search === "") return;
    }
    throw new Error("refusing: a namespace call that isn't on a spike script");
  }

  if (path === `${acc}/workers/assets/upload` && method === "POST" && search === "?base64=true") return;

  // The account's workers.dev subdomain and its list of Workers: read only (the control, 2026-11-24).
  if (method === "GET" && (path === `${acc}/workers/subdomain` || path === `${acc}/workers/scripts`) && search === "") return;
  // The two deployed Workers: their deployments, read only. The control's own Worker, `spikeh-ctl-<run>` for this run
  // only: written, read, its workers.dev switch, deleted.
  const scripts = `${acc}/workers/scripts/`;
  if (path.startsWith(scripts)) {
    const [name, sub, more] = path.slice(scripts.length).split("/");
    if (method === "GET" && DEPLOYED.has(name) && sub === "deployments" && more === undefined && search === "") return;
    if (CONTROL_WORKER.test(name ?? "") && more === undefined && search === "") {
      if (sub === undefined && (method === "GET" || method === "DELETE")) return;
      if (sub === undefined && method === "PUT" && name === `spikeh-ctl-${ctx.run}`) return;
      if (sub === "subdomain" && (method === "POST" || method === "GET") && name === `spikeh-ctl-${ctx.run}`) return;
    }
    throw new Error("refusing: a Worker call the spike doesn't make");
  }

  // D1.
  const d1 = `${acc}/d1/database`;
  if (path === d1 || path.startsWith(`${d1}/`)) {
    if (path === d1 && method === "GET" && search === "?name=spike-h-") return;
    if (path === d1 && method === "POST" && search === "") {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("refusing: a database's body isn't JSON");
      }
      if (Object.keys(parsed ?? {}).join(",") !== "name" || parsed.name !== `spike-h-${ctx.run}` || !SPIKE_DATABASE.test(parsed.name)) throw new Error("refusing: only the run's own database, by name alone");
      return;
    }
    const id = path.slice(d1.length + 1);
    if (UUID.test(id) && ctx.madeDb?.has(id) && search === "" && (method === "GET" || method === "DELETE")) return;
    throw new Error("refusing: a D1 call that isn't on the run's database");
  }
  throw new Error(`refusing: ${method} on a path the spike may not call`);
}
