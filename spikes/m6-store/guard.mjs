// What the store spike may send to Cloudflare. No I/O here, so `node --test` covers it offline.
//
// The spike holds tokens that can change every Worker, KV namespace and D1 database on the account. So every
// request goes through `allow` first. A GET goes anywhere on Cloudflare's API (the runner only lists, and reads
// what it made). Anything else must name something this spike made:
// - a script whose name matches SPIKE_NAME, in the one staging namespace or at account level;
// - a KV namespace or D1 database whose ID the runner holds in `made`, which it fills only from the answer to a
//   create whose title or name matched SPIKE_NAME, or from a listing, for a resource whose title or name matched it;
// - a create, only when the body's title or name matches SPIKE_NAME.

/** The one namespace the spike touches. A literal, never read from the environment. */
export const NAMESPACE = "podster-staging-apps";

/** Every name the spike gives: a script, a KV namespace's title, a D1 database's name, a KV key. */
export const SPIKE_NAME = /^spike-store-[a-z0-9-]{1,40}$/;

export const spikeNamed = (name) => typeof name === "string" && SPIKE_NAME.test(name);

const ORIGIN = "https://api.cloudflare.com";
const ROOT = "/client/v4/";
const NAME = "spike-store-[a-z0-9-]{1,40}";
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The JSON body's one field, or null if the body isn't exactly that object. */
function onlyField(body, field) {
  if (typeof body !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== field) return null;
  return parsed[field];
}

/**
 * Returns `url`, or throws before anything is sent.
 *
 * `made` is `{ kv: Set<id>, d1: Set<uuid> }`. `body` is the request body as a string for JSON, or null for a form
 * or no body.
 *
 * - Any method: only https://api.cloudflare.com/client/v4/…, written exactly as it will be sent.
 * - GET: allowed.
 * - Scripts: PUT or DELETE (no query, or `?force=true` for DELETE) of a spike script in the namespace or at
 *   account level; POST of a spike script's `subdomain` at account level.
 * - KV: POST a namespace whose body is exactly `{"title": <spike name>}`; DELETE a made namespace; PUT a value
 *   with a spike-named key in a made namespace.
 * - D1: POST a database whose body is exactly `{"name": <spike name>}`; DELETE a made database; POST a query to a
 *   made database.
 * - Anything else, PATCH included: refused.
 */
export function allow(method, url, account, { body = null, made = { kv: new Set(), d1: new Set() } } = {}) {
  if (typeof account !== "string" || !HEX32.test(account)) throw new Error("refusing: no account ID");
  if (typeof url !== "string" || typeof method !== "string") throw new Error("refusing: not a request");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("refusing: not a URL");
  }
  if (parsed.href !== url || /\.\.|%|#|@|\\|\s|\/\/.*\/\//.test(url)) throw new Error("refusing: the URL isn't in its plain form");
  if (parsed.origin !== ORIGIN || !parsed.pathname.startsWith(ROOT)) throw new Error("refusing: not Cloudflare's API");
  if (method === "GET") return url;

  const path = parsed.pathname;
  const search = parsed.search;
  const base = `/client/v4/accounts/${account}`;
  const match = (re) => path.match(new RegExp(`^${base.replace(/\//g, "\\/")}${re}$`));

  // Scripts.
  const scriptAt = match(`\\/workers\\/scripts\\/(${NAME})`);
  const scriptIn = match(`\\/workers\\/dispatch\\/namespaces\\/${NAMESPACE}\\/scripts\\/(${NAME})`);
  if ((scriptAt || scriptIn) && method === "PUT" && search === "") return url;
  if ((scriptAt || scriptIn) && method === "DELETE" && (search === "" || search === "?force=true")) return url;
  if (match(`\\/workers\\/scripts\\/(${NAME})\\/subdomain`) && method === "POST" && search === "") return url;

  // KV.
  if (match("\\/storage\\/kv\\/namespaces") && method === "POST" && search === "") {
    if (spikeNamed(onlyField(body, "title"))) return url;
    throw new Error("refusing: a KV namespace's title must be a spike name");
  }
  const kvNamespace = match("\\/storage\\/kv\\/namespaces\\/([0-9a-f]{32})");
  if (kvNamespace && method === "DELETE" && search === "") {
    if (made.kv.has(kvNamespace[1])) return url;
    throw new Error("refusing: not a KV namespace this spike made");
  }
  const kvValue = match(`\\/storage\\/kv\\/namespaces\\/([0-9a-f]{32})\\/values\\/(${NAME})`);
  if (kvValue && method === "PUT" && search === "") {
    if (made.kv.has(kvValue[1])) return url;
    throw new Error("refusing: not a KV namespace this spike made");
  }

  // D1.
  if (match("\\/d1\\/database") && method === "POST" && search === "") {
    if (spikeNamed(onlyField(body, "name"))) return url;
    throw new Error("refusing: a D1 database's name must be a spike name");
  }
  const d1 = match("\\/d1\\/database\\/([0-9a-f-]{36})(\\/query)?");
  if (d1 && UUID.test(d1[1]) && search === "") {
    if (!made.d1.has(d1[1])) throw new Error("refusing: not a D1 database this spike made");
    if (method === "DELETE" && !d1[2]) return url;
    if (method === "POST" && d1[2]) return url;
  }

  throw new Error(`refusing ${method}: a write must name something this spike made, under ${SPIKE_NAME}`);
}
