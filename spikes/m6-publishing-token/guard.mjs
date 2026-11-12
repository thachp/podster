// What this spike may send to Cloudflare. No I/O here, so `node --test` covers it offline.
//
// The spike holds a token that can change every Worker on the account. So every request goes through
// `allow` first, and anything that isn't a GET is refused unless it names a script this spike made:
// in the one staging namespace, or at account level, and nothing else of the account's.

/** The one namespace the spike touches. A literal, never read from the environment. */
export const NAMESPACE = "podster-staging-apps";

/** A script the spike may write or delete: no `/`, `.`, `%`, upper case or anything else that could change the path. */
export const SCRIPT_NAME = /^spike-m6-b-[a-z0-9-]{1,40}$/;

export const allowedName = (name) => typeof name === "string" && SCRIPT_NAME.test(name);

const ORIGIN = "https://api.cloudflare.com";
const ROOT = "/client/v4/";
const NAME = "(spike-m6-b-[a-z0-9-]{1,40})";

/**
 * Returns `url`, or throws before anything is sent.
 *
 * - Any method: only https://api.cloudflare.com/client/v4/…, written exactly as it will be sent.
 * - GET: allowed.
 * - PUT: only a spike script, in the namespace or at account level.
 * - POST: only a spike script's assets-upload-session in the namespace.
 * - DELETE: only a spike script, in the namespace or at account level, with `?force=true` or nothing.
 * - Anything else, PATCH included: refused.
 */
export function allow(method, url, account) {
  if (typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account)) throw new Error("refusing: no account ID");
  if (typeof url !== "string" || typeof method !== "string") throw new Error("refusing: not a request");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("refusing: not a URL");
  }
  // The text must already be in the form that is sent: nothing for the URL parser to fold away.
  if (parsed.href !== url || /\.\.|%|#|@|\\|\s|\/\/.*\/\//.test(url)) throw new Error("refusing: the URL isn't in its plain form");
  if (parsed.origin !== ORIGIN || !parsed.pathname.startsWith(ROOT)) throw new Error("refusing: not Cloudflare's API");
  if (method === "GET") return url;

  const scripts = `/client/v4/accounts/${account}/workers/scripts/`;
  const namespaced = `/client/v4/accounts/${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts/`;
  const path = parsed.pathname;
  const is = (prefix, suffix = "") => new RegExp(`^${NAME}${suffix}$`).test(path.startsWith(prefix) ? path.slice(prefix.length) : "\n");
  const script = is(scripts) || is(namespaced);
  if (method === "PUT" && script && parsed.search === "") return url;
  if (method === "DELETE" && script && (parsed.search === "" || parsed.search === "?force=true")) return url;
  if (method === "POST" && is(namespaced, "/assets-upload-session") && parsed.search === "") return url;
  throw new Error(`refusing ${method}: a write must name a script matching ${SCRIPT_NAME}, in ${NAMESPACE} or at account level`);
}
