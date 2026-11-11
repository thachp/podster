// The parts of m4-staging.mjs that touch nothing: how it tells Cloudflare's edge refusal from any other answer, and which
// installs its log tails need. Kept apart so m4-staging-selftest.mjs can check them without a network or a secret.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The apps whose `wrangler tail` a staging run starts, each from that app's own installed wrangler. */
export const TAILED_APPS = ["api", "gateway", "web"];

/** The apps under `repo` with no installed wrangler to tail with, so a staging run can name the missing `npm ci` first. */
export const missingWranglers = (repo) => TAILED_APPS.filter((app) => !existsSync(join(repo, "apps", app, "node_modules/.bin/wrangler")));

// Cloudflare's own page for error 1000, "DNS points to prohibited IP": its title, and the error number as the page's heading
// writes it. Both must be there. Another Cloudflare error, or a page that only mentions 1000, isn't this refusal.
const ERROR_1000_TITLE = /<title>\s*DNS points to prohibited IP \| [^<|]+ \| Cloudflare\s*<\/title>/;
const ERROR_1000_HEADING = /<span data-translate="error">Error<\/span>\s*<span>1000<\/span>/;

/**
 * Cloudflare's edge refusing a request that carries its own `cf-connecting-ip`, before the app runs: error 1000, in either
 * of the two forms the edge gives depending on the client. Plain text, exactly "error code: 1000", as curl gets; or
 * Cloudflare's HTML error page for 1000, as Node's fetch gets. Either way a 403 marked as Cloudflare's own by its server
 * or cf-ray header, with none of the app's own public headers, so a 403 from the app itself is never taken for it.
 */
export function edgeRefused(status, headers, body) {
  if (status !== 403) return false;
  if (headers.has("content-security-policy") || headers.has("x-robots-tag")) return false;
  if (headers.get("server") !== "cloudflare" && !headers.has("cf-ray")) return false;
  if (/^error code: 1000\n?$/.test(body)) return true;
  return (headers.get("content-type") ?? "").startsWith("text/html") && ERROR_1000_TITLE.test(body) && ERROR_1000_HEADING.test(body);
}
