// What the runner may name in the dispatch namespace. No I/O here, so `node --test` covers it offline.
//
// `wrangler delete --name <x>` puts <x> into the API path unescaped. The runner uses that to delete a
// script in the namespace, and the same trick with another name could reach a Worker on the account.
// So nothing is handed to wrangler unless it passes `guard` first.

/** The one namespace the runner touches. A literal, never read from the environment. */
export const NAMESPACE = "podster-staging-apps";

/** A script the runner may upload, read or delete: no `/`, `.`, `%`, upper case or anything else that could change the path. */
export const SCRIPT_NAME = /^spike-m6-[a-z0-9-]{1,50}$/;

export const allowedName = (name) => typeof name === "string" && SCRIPT_NAME.test(name);

/** Returns `name`, or throws before anything is run. */
export function guard(name, namespace) {
  if (namespace !== NAMESPACE) throw new Error(`refusing a namespace other than ${NAMESPACE}`);
  if (!allowedName(name)) throw new Error(`refusing a script name that doesn't match ${SCRIPT_NAME}`);
  return name;
}

/** The `--name` that makes `wrangler delete` reach DELETE /workers/dispatch/namespaces/<namespace>/scripts/<name>. */
export function deleteArgument(name, namespace) {
  return `../dispatch/namespaces/${NAMESPACE}/scripts/${guard(name, namespace)}`;
}
