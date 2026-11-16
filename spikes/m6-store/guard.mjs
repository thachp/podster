// What the store spike may send to Cloudflare. No I/O here, so `node --test` covers it offline.
//
// The spike holds tokens that can change every Worker, KV namespace and D1 database on the account. So every
// request goes through `allow` first. A GET goes anywhere on Cloudflare's API (the runner only lists, and reads
// what it made). Anything else must name something this spike made:
// - a script whose name matches SPIKE_NAME, in the one staging namespace or at account level, and whose upload's
//   metadata binds only stores this spike made (or the staging namespace, or the spike's own Durable Object
//   class, at account level) and migrates only that class;
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

/** The only Durable Object class the spike may create, bind or delete. */
export const SPIKE_CLASSES = new Set(["SpikeCounter"]);

const METADATA_KEYS = new Set(["main_module", "compatibility_date", "bindings", "migrations"]);
const MIGRATION_KEYS = new Set(["old_tag", "new_tag", "new_sqlite_classes", "deleted_classes"]);
const BINDING_NAME = /^[A-Z][A-Z_]{0,31}$/;
const sameKeys = (object, keys) => Object.keys(object).every((k) => keys.includes(k)) && keys.every((k) => k in object);

/**
 * Throws unless an upload's metadata binds only what this spike made and migrates only its own class.
 * `atAccount` is true for an account-level script (the dispatch Worker), false for one in the namespace.
 */
export function checkMetadata(text, made, atAccount) {
  if (typeof text !== "string") throw new Error("refusing: an upload must carry metadata the guard can read");
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new Error("refusing: the upload's metadata isn't JSON");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("refusing: the upload's metadata isn't an object");
  for (const key of Object.keys(metadata)) if (!METADATA_KEYS.has(key)) throw new Error(`refusing: metadata key ${key}`);
  const bindings = metadata.bindings ?? [];
  if (!Array.isArray(bindings)) throw new Error("refusing: bindings isn't a list");
  for (const b of bindings) {
    if (!b || typeof b !== "object" || !BINDING_NAME.test(b.name ?? "")) throw new Error("refusing: a binding without a plain name");
    if (b.type === "kv_namespace" && sameKeys(b, ["type", "name", "namespace_id"]) && made.kv.has(b.namespace_id)) continue;
    if (b.type === "d1" && sameKeys(b, ["type", "name", "id"]) && made.d1.has(b.id)) continue;
    if (atAccount && b.type === "dispatch_namespace" && sameKeys(b, ["type", "name", "namespace"]) && b.namespace === NAMESPACE) continue;
    if (atAccount && b.type === "durable_object_namespace" && sameKeys(b, ["type", "name", "class_name"]) && SPIKE_CLASSES.has(b.class_name)) continue;
    throw new Error(`refusing: a ${String(b.type)} binding to something this spike didn't make`);
  }
  if (metadata.migrations !== undefined) {
    const m = metadata.migrations;
    if (!atAccount) throw new Error("refusing: a migration in the namespace");
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("refusing: migrations isn't an object");
    for (const key of Object.keys(m)) if (!MIGRATION_KEYS.has(key)) throw new Error(`refusing: migration key ${key}`);
    for (const key of ["old_tag", "new_tag"]) if (m[key] !== undefined && !/^v[0-9]{1,3}$/.test(m[key])) throw new Error(`refusing: migration ${key}`);
    for (const key of ["new_sqlite_classes", "deleted_classes"]) {
      if (m[key] === undefined) continue;
      if (!Array.isArray(m[key]) || !m[key].every((c) => SPIKE_CLASSES.has(c))) throw new Error(`refusing: ${key} names a class this spike doesn't own`);
    }
  }
}

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
 *   account level; POST of a spike script's `subdomain` at account level. A PUT must also pass `checkMetadata`:
 *   its bindings name only stores in `made`, the staging namespace, or the spike's own Durable Object class,
 *   and its migrations create or delete only that class.
 * - KV: POST a namespace whose body is exactly `{"title": <spike name>}`; DELETE a made namespace; PUT a value
 *   with a spike-named key in a made namespace.
 * - D1: POST a database whose body is exactly `{"name": <spike name>}`; DELETE a made database; POST a query to a
 *   made database.
 * - Anything else, PATCH included: refused.
 */
export function allow(method, url, account, { body = null, made = { kv: new Set(), d1: new Set() }, metadata = null } = {}) {
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
  if ((scriptAt || scriptIn) && method === "PUT" && search === "") {
    checkMetadata(metadata, made, Boolean(scriptAt));
    return url;
  }
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
