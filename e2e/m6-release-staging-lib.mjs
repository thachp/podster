// The parts of m6-release-staging.mjs that touch nothing: its arguments, the hosts it accepts, the plan of checks and
// the run's exit code, what it refuses to start without, and how it judges a content host's answers and a task's
// release status. Kept apart so m6-release-staging-selftest.mjs can check them without a network, a secret or the e2e
// packages.
//
// The run is M6's staging acceptance with release switched ON, for static sites (docs/m6-plan.md, "Acceptance tests"
// and "The gate"). Custom domains and apps with code are out of scope for now: their checks are in the plan, always
// say SKIP, and are listed apart from the rest.
export { scrub, secretProblem, STAGING, STAGING_APP, STAGING_ORG, stagingOnly, Tally } from "./m5-staging-lib.mjs";
export { requestLine, slowestLine } from "./m6-staging-lib.mjs";
import { STAGING, STAGING_APP, stagingOnly } from "./m5-staging-lib.mjs";

/** Staging's content domain, pinned in code: a host the run is told about anywhere else is refused. */
export const CONTENT_DOMAIN = "podster.site";
/** Podster's own domain. No content host may be under it. */
export const PODSTER_DOMAIN = "podster.dev";
/** An app's label, as the API makes it: 26 characters of lowercase base32. */
export const LABEL = /^[a-z2-7]{26}$/;
/** Where the release job puts its own marker in every release (`crates/core/src/release_tree.rs`). */
export const MARKER_PATH = "/.well-known/podster-release.json";
/** The one release directory, the same in every room (`RELEASE_DIRECTORY`). */
export const RELEASE_DIRECTORY = "site";

/**
 * How the run gives a `deploy` grant. **An assumption:** on 2026-11-23 no route gives one. The grant route takes M5's
 * two actions only (`push`, `merge`), and docs/m6-plan.md lists "who may give a `deploy` grant, and the route that
 * gives one" as owed to step 6. The run assumes the route M5's grants use, with the action `deploy`, and refuses to
 * start, offline, while the contract's grant route doesn't list that action.
 */
export const DEPLOY_GRANT = { path: "/v1/workspaces/{ws}/repository/grants", action: "deploy" };

/**
 * The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. Agents are made under people
 * and take none. The operator is staging's one fixed test operator (m4-staging.mjs), signed in again, not a new person.
 */
export const SIGN_UPS = [
  { who: "the room's owner", why: "owns the organization, the room and its repository, and links the coding agent. Taken only after the signed-out preflight" },
  { who: "the room's admin", why: "a second person, who reviews and merges the tasks and approves releases. Taken only once the owner's room shows release answers" },
  { who: "a member with a deploy grant", why: "asks for the releases, and is refused what only the owner and admins may do (AC-11)" },
  { who: "the test operator", why: "staging's fixed test operator, the same person every run: takes release from the organization and gives it back, and suspends and lifts the app. It must be in staging's OPERATORS" },
];

/** The waits, in seconds: flag, option name, default. Each is bounded from 10 to 1800. */
export const WAITS = {
  "--setup-wait": ["setupWait", 300],
  "--merge-wait": ["mergeWait", 300],
  "--release-wait": ["releaseWait", 300],
  "--takedown-wait": ["takedownWait", 180],
};

/**
 * Every check, in the order it runs. `outOfScope` checks are custom domains and apps with code: they always say SKIP,
 * are listed apart, and don't stop exit 0. Every other check must pass for exit 0: none may say SKIP.
 */
export const PLAN = [
  ["M6-R01", "M6-01, M6-23: release switched off publishes nothing. In the private room a request is refused release_needs_public_room; public, with release off in the room, release_off; the task's release status is { exists: false }, the room has no host, and no release awaits approval"],
  ["M6-R02", "M6-02, AC-10: an operator takes release from the organization; the owner's switch-on is then refused release_not_delegated and the configuration is unchanged; the owner, an organization admin, can't set the switch (not_allowed); the operator gives it back"],
  ["M6-R03", "M6-03, AC-11: the room's admin switches release on as a person; a member who will hold a deploy grant can't read or set the configuration or list approvals (not_allowed)"],
  ["M6-R04", "Expanded criterion 3, M6-05, AC-17: an agent that claimed a DevOps opening is refused deploy_release (grant_required), as is a person with no grant; a completed, merged task with no grant behind it deploys nothing"],
  ["M6-R05", "M6-09, M6-21, AC-05: a request naming the task branch's head, another room's task, an unknown environment, or a repository, host, label or account is refused, with no release recorded; a well-formed release ID the room doesn't have can't be approved. Not shown: approving another room's real release, since the run's second room has no repository and so no release"],
  ["M6-R06", "M6-04, M6-06, M6-11: the member with the grant asks; the same idempotency key gives one release; it awaits approval and can't be approved by its requester, who isn't an admin; the admin approves; it is served, and the default host's marker names that release and the merged commit"],
  ["M6-R07", "M6-13: the host serves the site's files with the fixed headers and the sandbox, GET and HEAD only, and a path the site doesn't have is not found"],
  ["M6-R08", "M6-12, over HTTP: the host is on the content domain and not under podster.dev; no answer sets a cookie; a request carrying Podster's cookie names and an Authorization header gets byte for byte what one without does"],
  ["M6-R09", "M6-12, in a scripted browser: the sandboxed page's document.cookie is refused with SecurityError for reading and setting, the browser holds no cookie but the one the run set for podster.dev, and the page's fetch of the application's API is refused by the host's connect-src"],
  ["M6-R10", "AC-17, M6-05: an agent given a deploy grant of its own asks with deploy_release and is recorded awaiting approval; the admin declines it; the host still serves the first release"],
  ["M6-R11", "M6-07, M6-08, AC-16, UI-02: a merged commit whose site holds _headers is released and fails with a reason code; the task stays completed and the merge succeeded; checks, merge and release are reported apart, each with its own time; the host still serves the first release"],
  ["M6-R12", "M6-25, UI-02, in a scripted browser: the failed task's Sheet says \"Merged · Deployment failed\" and never Live; the served task's says Live"],
  ["M6-R13", "M6-10, AC-13: a release asked for, then its requester's deploy grant taken back, then approved, fails requester_lost_authority with no result URL; the host's marker still names the release served before, now and after a wait, and its status says failed, not served"],
  ["M6-R14", "M6-19, M6-27: a person reports the app by its address; the test operator suspends it by its label; the host answers not found within the wait; a request is refused app_suspended; lifting the suspension restores nothing"],
  ["M6-R15", "M6-19: after the lift, only a new request and a new approval serve the app again, under a new release"],
  ["M6-R16", "M6-16, M6-28: switching release off in the room unpublishes: the host answers not found within the wait, and the release records are kept"],
  ["M6-R17", "M6-23, and the run's clean-up: the room is made private again; a request is then refused release_needs_public_room; the host still answers not found"],
  ["M6-X14", "M6-14: a custom hostname routes only after its proof of control", { outOfScope: "custom domains" }],
  ["M6-X15", "M6-15: refused custom hostnames, and two rooms racing for one", { outOfScope: "custom domains" }],
  ["M6-X26", "M6-26: a custom hostname is claimed only by a room that published its own challenge", { outOfScope: "custom domains" }],
  ["M6-X13", "M6-13 as revised for apps with code: an app's Worker, its writes, its store and its outbound refusal", { outOfScope: "apps with code (Workers)" }],
].map(([id, title, flags = {}]) => ({ id, title, outOfScope: flags.outOfScope ?? null }));

/** Why an out-of-scope check says SKIP. */
export const outOfScopeReason = (entry) => `out of scope for now: ${entry.outOfScope} aren't part of this run`;

/**
 * The run's exit code, and what it didn't show. 0 only when nothing failed and every in-scope check passed. Out-of-scope
 * checks are listed apart and never change the code.
 */
export function runOutcome(tally, plan = PLAN) {
  const results = new Map(tally.results.map((r) => [r.id, r.status]));
  const inScope = plan.filter((entry) => !entry.outOfScope);
  const failed = plan.filter((entry) => results.get(entry.id) === "fail").map((entry) => entry.id);
  const unshown = inScope.filter((entry) => results.get(entry.id) !== "pass").map((entry) => entry.id);
  const outOfScope = plan.filter((entry) => entry.outOfScope).map((entry) => entry.id);
  return { code: failed.length || unshown.length || inScope.length === 0 ? 1 : 0, failed, unshown, outOfScope };
}

/** Exit codes, named once. */
export const EXIT = { passed: 0, failed: 1, refused: 2, releaseNotOn: 3 };

export const USAGE = `Usage: node m6-release-staging.mjs --base-url ${STAGING} [--dry-run] [--contract FILE] [--setup-wait S] [--merge-wait S] [--release-wait S] [--takedown-wait S]

M6's staging acceptance run with release switched on, for static sites. Custom domains and apps with code are out of
scope for now: their checks always say SKIP and are listed apart.

  --dry-run         check the configuration and the contract, and print the plan. Sends nothing anywhere.
  --contract        the OpenAPI contract read for the deploy grant's route. Defaults to packages/contracts/openapi.yaml.
  --setup-wait      seconds to wait for the room's repository to be ready (default 300).
  --merge-wait      seconds to wait for each merge (default 300).
  --release-wait    seconds to wait for a release to be served or to fail (default 300).
  --takedown-wait   seconds to wait for the host to stop serving after a suspension or an unpublish (default 180).

  PODSTER_E2E_SIGNUP_SECRET     staging's test sign-up secret. Needed. Never printed.

  Refuses to start, exit 3, unless: the contract's grant route gives a deploy grant (none does on 2026-11-23);
  signed out, staging lists deploy_release, so RELEASES is exactly true; and ${CONTENT_DOMAIN} answers an unknown app's
  host with the content Worker's own not found. Then, after the owner's sign-up only: a room answers its release
  configuration, and a request isn't refused release_not_available, which staging answers while a provider is
  configured and the release path isn't complete.

  It takes 4 test sign-ups (3 new test people and the fixed test operator), makes one public repository in
  podsterdev, merges two tasks there, and releases a tiny static site from it. It cleans up: release off in the room,
  the app unpublished, the room private, grants taken back, agents disconnected, sessions signed out. It can't delete
  the repository: it prints its name for the owner to archive or delete.

  Exit 0 only when every in-scope check passed and none said SKIP; 1 otherwise; 2 for a refused configuration or a
  failed preflight, with no sign-up taken; 3 when release isn't on with a provider, with at most the owner's sign-up.`;

/** The run's options, or why they're refused. An unknown flag or a missing value is an error: nothing is guessed. */
export function parseArgs(argv, env = {}) {
  const options = { base: undefined, dryRun: false, help: false, contract: undefined };
  for (const [name, fallback] of Object.values(WAITS)) options[name] = fallback;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--base-url" || flag === "--contract" || WAITS[flag]) {
      const value = argv[++at];
      if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
      if (flag === "--base-url") options.base = value;
      else if (flag === "--contract") options.contract = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) < 10 || Number(value) > 1800) return { error: `${flag} takes whole seconds from 10 to 1800` };
        options[WAITS[flag][0]] = Number(value);
      }
    } else return { error: `unknown argument ${flag}` };
  }
  if (options.help) return { options };
  options.base ??= env.PODSTER_E2E_BASE_URL;
  if (!options.base) return { error: "pass --base-url, or set PODSTER_E2E_BASE_URL" };
  const refusal = stagingOnly(options.base);
  if (refusal) return { error: refusal };
  options.base = STAGING;
  return { options };
}

/**
 * Why this checkout can't give a deploy grant, or null. Reads the grant route's `action` enum from the contract's text:
 * the run never invents a route the contract doesn't have.
 */
export function deployGrantProblem(openapi) {
  if (typeof openapi !== "string") return "the contract couldn't be read";
  const at = openapi.indexOf(`  ${DEPLOY_GRANT.path}:`);
  if (at < 0) return `the contract has no ${DEPLOY_GRANT.path}`;
  const next = openapi.slice(at + 3).search(/\n {2}\/[^\s]*:\n/);
  const route = openapi.slice(at, next < 0 ? undefined : at + 3 + next);
  const post = route.slice(route.indexOf("\n    post:"));
  const actions = post.match(/action: \{ type: string, enum: \[([^\]]*)\]/);
  if (!actions) return `the contract's ${DEPLOY_GRANT.path} lists no grant actions`;
  const listed = actions[1].split(",").map((name) => name.trim());
  return listed.includes(DEPLOY_GRANT.action) ? null : `no route gives a deploy grant: the contract's ${DEPLOY_GRANT.path} takes ${listed.join(" and ")} only (docs/m6-plan.md lists the route as owed to step 6)`;
}

/** A random label, as an app's is made, for a host no room has. */
export const unknownLabel = (bytes) => Array.from(bytes.slice(0, 26), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");

/**
 * Why an answer isn't the content Worker's own not found, or null: 404, the body `not_found`, no cookie, and the sandbox
 * every answer of the content Worker's carries. `headers` is a Headers object or an array of pairs.
 */
export function contentNotFoundProblem({ status, body, headers }) {
  const h = new Headers(headers);
  if (status !== 404) return `answered ${status}, not 404`;
  if (String(body).trim() !== "not_found") return "its body isn't the content Worker's not_found";
  if (h.has("set-cookie")) return "it set a cookie";
  if (!(h.get("content-security-policy") ?? "").startsWith("sandbox allow-scripts")) return "it carries no sandbox, so it isn't the content Worker's answer";
  return null;
}

/** Why a host isn't an app's default host on the content domain, or null. Answers the label too. */
export function defaultHostProblem(host, domain = CONTENT_DOMAIN) {
  if (typeof host !== "string") return { problem: "no host" };
  const lower = host.toLowerCase();
  if (lower === PODSTER_DOMAIN || lower.endsWith(`.${PODSTER_DOMAIN}`)) return { problem: "the host is under podster.dev" };
  if (!lower.endsWith(`.${domain}`)) return { problem: `the host isn't on ${domain}` };
  const label = lower.slice(0, -domain.length - 1);
  if (!LABEL.test(label)) return { problem: "the host's label isn't 26 characters of base32, one label deep" };
  return { problem: null, label };
}

/** Why a served result URL isn't `https://<host>/`, or null. */
export function resultUrlProblem(url, host) {
  return url === `https://${host}/` ? null : "the result URL isn't https://<the default host>/";
}

/** What the release job writes at the marker path, exactly (`marker_body`). */
export const markerBody = (releaseId, commit) => `{"release_id":"${releaseId}","commit":"${commit}"}\n`;

/** Why a marker answer doesn't name this release and commit, or null. */
export function markerProblem({ status, body }, releaseId, commit) {
  if (status !== 200) return `the marker answered ${status}`;
  return body === markerBody(releaseId, commit) ? null : "the marker names another release or commit";
}

/** The fixed headers every answer of the content Worker's carries, as `handle.ts` sets them. */
export const FIXED_HEADERS = {
  "referrer-policy": (v) => v === "no-referrer",
  "x-content-type-options": (v) => v === "nosniff",
  "strict-transport-security": (v) => v === "max-age=31536000; includeSubDomains",
  "content-security-policy": (v) => typeof v === "string" && v.startsWith("sandbox allow-scripts;"),
};

/** What's wrong with one answer from an app's host, against the fixed headers and no cookie. */
export function fixedHeaderProblems(headers) {
  const h = new Headers(headers);
  const problems = Object.entries(FIXED_HEADERS).filter(([name, okay]) => !okay(h.get(name))).map(([name]) => `${name} isn't the content Worker's`);
  if (h.has("set-cookie")) problems.push("it set a cookie");
  return problems;
}

/**
 * What's wrong with a task's release status, against what the run knows: the task's merge commit and what the release
 * should say. Checks, merge and release must each be there, apart, each with its own time.
 */
export function statusProblems(status, { taskId, mergeSha, release }) {
  const problems = [];
  if (!status || typeof status !== "object") return ["no status"];
  if (status.task_id !== taskId) problems.push("it is for another task");
  if (!status.checks || typeof status.checks !== "object" || !("state" in status.checks) || !("observed_at" in status.checks)) problems.push("checks aren't reported on their own");
  const merge = status.merge;
  if (!merge || merge.state !== "succeeded" || merge.sha !== mergeSha || !Number.isSafeInteger(merge.observed_at)) problems.push(`the merge isn't reported succeeded at the merge commit with its time (${merge?.state ?? "none"})`);
  const r = status.release;
  if (release === "none") {
    if (!r || r.exists !== false || Object.keys(r).length !== 1) problems.push("the release isn't { exists: false }");
    return problems;
  }
  if (!r || r.exists !== true) return [...problems, "no release is reported"];
  if (r.commit_sha !== mergeSha) problems.push("the release is for another commit");
  if (!Number.isSafeInteger(r.observed_at)) problems.push("the release has no time of its own");
  if (release.id && r.release_id !== release.id) problems.push("the release reported isn't the latest one asked for");
  if (release.state && r.state !== release.state) problems.push(`the release is ${r.state}, not ${release.state}`);
  if (release.served !== undefined && r.served !== release.served) problems.push(`served is ${r.served}`);
  if (release.served === false && r.result_url !== null) problems.push("a release that isn't served has a result URL");
  if (release.failed) {
    if (r.state !== "failed" || typeof r.failure_code !== "string" || !/^[a-z][a-z0-9_]*$/.test(r.failure_code)) problems.push("the failure has no reason code");
  } else if (r.failure_code !== null) problems.push("a release that didn't fail has a failure code");
  return problems;
}

/**
 * The code a release fails with when its requester's deploy grant was taken back before the approval
 * (`RecheckFailure::RequesterLostAuthority` in crates/core/src/release.rs; apps/api/test/release-approval.spec.ts).
 */
export const GRANT_LOST_CODE = "requester_lost_authority";

/** The release states the job leaves for good. A release in any other is still on its way. */
export const SETTLED = ["served", "replaced", "unpublished", "declined", "failed"];

/**
 * The tiny static site the run releases, by path in the repository: plain HTML with nothing of Podster's in it, since
 * the repository is public. The failing variant adds a `_headers` file, which the release job refuses by name.
 */
export const SITE = {
  [`${RELEASE_DIRECTORY}/index.html`]: "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Hello</title></head><body><h1>Hello</h1><p>A static page.</p></body></html>\n",
  [`${RELEASE_DIRECTORY}/hello.txt`]: "hello\n",
};
export const REFUSED_SITE = { [`${RELEASE_DIRECTORY}/_headers`]: "/*\n  X-Example: 1\n" };

/** The app's host in a request line: its label is the app's, so the line says which host it was without it. */
export function maskedPath(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.hostname.endsWith(`.${CONTENT_DOMAIN}`)) return `https://[app host].${CONTENT_DOMAIN}${parsed.pathname}`;
    if (parsed.origin === STAGING) return parsed.pathname;
    if (parsed.origin === STAGING_APP) return `${STAGING_APP}${parsed.pathname}`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unreadable URL)";
  }
}
