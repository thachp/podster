// The parts of m5-staging.mjs that touch nothing: its arguments, the one host it accepts, the plan of checks, the results
// and their exit code, the environment its `git` child gets, and what it reads out of GitHub's answers. Kept apart so
// m5-staging-selftest.mjs can check them without a network, a secret or the e2e packages.
import { createHmac } from "node:crypto";
import { childEnv } from "./child-env.mjs";

export const STAGING = "https://gateway-staging.podster.dev";
/** The one GitHub organization this run may make repositories in. Pinned here, so a changed file can't point it elsewhere. */
export const STAGING_ORG = "podsterdev";
export const STATUS_CONTEXT = "podster/review";
export const DEFAULT_BRANCH_REF = "~DEFAULT_BRANCH";
/** The merge App's name on staging (docs/staging.md). A status it sets is created by `<name>[bot]`. */
export const MERGE_APP_SLUG = "podster-staging-merge";
/** Staging's web app. The run asks it for one page that doesn't exist, so the web Worker's log tail shows it's connected. */
export const STAGING_APP = "https://app-staging.podster.dev";
/** Where GitHub's deliveries arrive, on the gateway. */
export const WEBHOOK_PATH = "/webhooks/github";
/**
 * The one name the webhook secret is taken from, and only for a run the owner sets it for. The script reads no file for
 * it. Without it the signed-delivery checks are skipped, by name. child-env.mjs refuses to pass any name like it on.
 */
export const WEBHOOK_SECRET_ENV = "PODSTER_M5_WEBHOOK_SECRET";

/**
 * The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. Agents are made under these
 * people and take none.
 */
export const SIGN_UPS = [
  { who: "the room's owner", why: "owns the room and its repository, gives grants, reviews, and controls the submitting agent" },
  { who: "a second person", why: "is the room's admin, who asks for the repository and gives the push grant, and controls the merging agents, an agent with no grant, a guest and a public claimant; and owns the second room, which the first person has no place in" },
];

/** Every check, in the order it runs. A result for an ID that isn't here is a bug in the script. */
export const PLAN = [
  ["M5-00", "managed repositories are switched on, and a room that hasn't asked has no repository"],
  ["M5-13a", "wrangler tail is connected to the API, the gateway and the web app, shown by the run's own marker requests; the scanner, which this run never calls, isn't tailed"],
  ["M5-14", "no operator approves first: an organization nobody set a delegation for holds it, and the room's owner and admin are told so"],
  ["M5-04", "a request naming an organization is refused 400 invalid_argument"],
  ["M5-01", "a room admin's request, a person who isn't the owner, is recorded as pending and becomes a ready repository, with GitHub's ID recorded"],
  ["M5-02", "the repository is public and under podsterdev on GitHub, while the room is private"],
  ["M5-01b", "GitHub shows exactly the two rulesets of ADR 0009 on the default branch, both active"],
  ["M5-03a", "a second room asking for a name GitHub already holds: setup fails name_taken, nothing is linked or adopted by the name, and a retry at once is refused 429 retry_too_soon"],
  ["M5-15a", "while that setup is failed, the room's other work goes on, a task made then is refused task_not_linked, and the first room's repository is untouched"],
  ["M5-A1", "an agent can't be made a room admin (400 invalid_argument), and has no tool to ask for a repository or give a grant"],
  ["M5-05", "an agent with no grant is refused grant_required, with no token in the answer"],
  ["M5-G2", "the room admin's push grant is given, recorded as theirs and listed as live"],
  ["M5-06a", "the agent gets a token for the room's repository only, and asking again gives the same one"],
  ["M5-06b", "the token pushes a task branch with git over HTTPS and opens a pull request"],
  ["M5-06c", "git push to the default branch with the token is refused by GitHub, and the branch doesn't move"],
  ["M5-06d", "the token can't write the default branch through the API: a commit 409, a ref update 422, a merge 405"],
  ["M5-06e", "the token can't set the review status or change the repository's settings: 403 each"],
  ["M5-08a", "the submission records its commit, and the task shows its pull request as Podster read it"],
  ["M5-07a", "after the submission a new token is refused task_not_active, and GitHub refuses the old one 401"],
  ["M5-10a", "a merge-grant holder asking before approval is refused not_approved"],
  ["M5-10b", "after approval the submitter and the person who controls it, each holding a merge grant, are refused self_merge"],
  ["M5-10c", "an agent another person controls, with approval done and no merge grant, is refused grant_required"],
  ["M5-G3", "a merge grant that expired is refused grant_expired, and is listed as expired"],
  ["M5-10d", "approval and every refusal merged nothing: the merge isn't requested and the default branch hasn't moved"],
  ["M5-09a", "the grant holder's merge_task is accepted, and the task's merge succeeds"],
  ["M5-09b", "on GitHub the default branch's tip is one merge commit whose second parent is exactly the reviewed commit"],
  ["M5-09c", "the reviewed commit carries exactly one podster/review status, set by the merge App"],
  ["M5-09d", "asking again is refused already_merged"],
  ["M5-10e", "a commit the submitter's own person approved isn't merged: the review completes the task, and merge_task is refused self_review"],
  ["M5-11a", "a head moved after review is observed by Podster, by a webhook or by polling, within the wait"],
  ["M5-09e", "the moved head isn't merged: merge_task is refused commit_changed, and GitHub shows the pull request open"],
  ["M5-12", "release status matches the task's change, pairs checks with their commit, and says no release exists"],
  ["M5-V1", "an agent that reads the task and isn't shown its change gets a null change, as for a task with none"],
  ["M5-V2", "a guest not party to the task gets task_not_found for it, as for a task that doesn't exist"],
  ["M5-G4", "a push grant taken back is refused grant_required, and GitHub refuses the token it backed 401"],
  ["M5-G1", "a grant to a public-claim participant is refused 400 grantee_public"],
  ["M5-03b", "the retry, once its wait is over, makes the second room's repository under a new server-made name in podsterdev, and the first room's is still there"],
  ["M5-S1", "ground for what follows: a second coding agent in the first room, with a push grant, a live token and a pull request"],
  ["M5-S2", "ground for what follows: the second room's push grant, a submitted task with a pull request, and an accepted one with a live token"],
  ["M5-07b", "asking again for a live token gives the same token with the same expiry and permissions: renewal neither extends nor widens"],
  ["M5-06f", "the token can't write another managed repository: a branch through the API and a git push are refused, and nothing appears there"],
  ["M5-06g", "the token can't add a workflow file, force the default branch back, write or remove a ruleset, or change Actions permissions or the default branch"],
  ["M5-08b", "after the branch advances, approval is refused 409 commit_changed for the submitted commit and for the new head, and nothing is approved"],
  ["AC-05a", "an admin naming the second room's grant, task or repository in their own room's routes gets what an ID that names nothing gets"],
  ["AC-05b", "the same person calling the second room's own routes gets what a room that doesn't exist gets: 404 workspace_not_found"],
  ["AC-05c", "an agent naming the second room's task gets task_not_found in its own room, and workspace_not_found in the second, as for IDs that name nothing"],
  ["AC-05d", "a submission naming another room's commit, or a pull request number only another room's repository has, is refused as a made-up one is"],
  ["AC-05e", "none of that changed anything in the second room: its grants, its task and its change read as before"],
  ["M5-11b", "a delivery signed with the wrong key, or with a malformed signature, is refused 401 invalid_signature and changes nothing"],
  ["M5-16a", "a correctly signed delivery is taken once, by the API's log: nudged the first time, and replayed when sent again under the same ID and under a new one, each answering 202"],
  ["M5-16b", "a signed delivery about this room's pull request naming the second room's repository, or one no room has, answers 202, and the API logs unknown_change and no_room"],
  ["M5-09f", "a merge asked for before Podster has seen a moved head is ended by the job: merge failed commit_changed, and the task stays completed"],
  ["M5-09g", "five merges asked for at once: the first lands exactly its reviewed commit"],
  ["M5-12b", "a merge GitHub refuses is reported as failed, provider_refused, with its time, apart from the checks, for a pull request still open"],
  ["AC-16", "GitHub's refusals are recorded as failures and never as success: the name it refused, and the merge it refused, which landed nothing"],
  ["AC-13a", "a merge grant taken back while its merge waits for the job: the job ends the merge grant_required and merges nothing"],
  ["AC-13b", "the admin who gave a merge grant demoted while its merge waits: the job ends the merge grant_required and merges nothing"],
  ["AC-13c", "the agent that asked removed from the room while its merge waits: the job ends the merge access_revoked and merges nothing"],
  ["AC-13d", "nothing brings a grant back: the stored answer to the grant sent again, and the admin made one again, leave every one ended"],
  ["M5-07f", "a push grant that reaches its expiry: renewal is refused grant_expired, and GitHub refuses the token it backed"],
  ["M5-07c", "a canceled task's token: renewal is refused task_not_active, as for a completed task, and GitHub refuses the token it held"],
  ["M5-C3", "recorded, not judged: what the token does with a tag, a release, and another task's branch and pull request (review C-3)"],
  ["M5-C1", "recorded, not judged: GitHub's rate limit as the agent's token sees it, before and after one read of Podster's (review C-1)"],
  ["M5-C8", "recorded, not judged: the repository's settings as the agent's token is shown them (review C-8)"],
  ["M5-07e", "a disconnected agent's call isn't answered and carries no token, and GitHub refuses the token it held"],
  ["M5-07d", "an agent removed from the room: renewal is refused access_revoked, and GitHub refuses the token it held"],
  ["M5-01c", "a room that never asked has no repository, and podsterdev gained exactly this run's two repositories"],
  ["M5-13", "what the API, the gateway and the web app logged while their tails were connected holds no credential the run handled, and no repository name, branch name, pull request title or note of its"],
].map(([id, title]) => ({ id, title }));

const WAITS = { "--setup-wait-s": ["setupWait", 240], "--merge-wait-s": ["mergeWait", 180], "--observe-wait-s": ["observeWait", 420], "--revoke-wait-s": ["revokeWait", 180] };

export const USAGE = `node m5-staging.mjs --base-url ${STAGING} [--dry-run] [--skip-logs]
    [--setup-wait-s N] [--merge-wait-s N] [--observe-wait-s N] [--revoke-wait-s N] [--api-config FILE]

  --dry-run   check the configuration and print the plan. Sends nothing anywhere.
  --skip-logs don't tail the Workers' logs. M5-13a and M5-13 are then skipped, and counted as skipped.
              Without it the run starts \`wrangler tail\` from apps/api, apps/gateway and apps/web, each with its own
              installed wrangler and your \`wrangler login\`: run \`npm ci\` in each first.
  The waits bound, in seconds, the repository's setup (240), a merge (180), Podster noticing a moved head (420)
  and a token's revocation (180). Each is 10 to 1800.
  --api-config   the API's wrangler file, which names staging's GitHub organization and merge App.
                 It defaults to apps/api/wrangler.jsonc.

  PODSTER_E2E_SIGNUP_SECRET     staging's test sign-up secret. Needed.
  ${WEBHOOK_SECRET_ENV}     staging's GitHub webhook secret, for M5-16a and M5-16b only. Optional: without it
                                those two are skipped, and counted. They also need the log tails, since only the API's
                                log says what became of a delivery: with --skip-logs they're skipped too. The script reads no file for it, and never prints,
                                writes or passes it on. Set it for the one run that needs it.

  It makes repositories in ${STAGING_ORG} and nowhere else: a configuration naming another organization is refused.`;

/** The arguments, or why they're refused. Nothing is guessed: an unknown flag or a missing value is an error. */
export function parseArgs(argv, env = {}) {
  const options = { base: undefined, dryRun: false, help: false, apiConfig: undefined, logs: true };
  for (const [key, fallback] of Object.values(WAITS)) options[key] = fallback;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--skip-logs") options.logs = false;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--base-url" || flag === "--api-config" || WAITS[flag]) {
      const value = argv[++at];
      if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
      if (flag === "--base-url") options.base = value;
      else if (flag === "--api-config") options.apiConfig = value;
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

/** Why a base URL is refused, or null for staging's gateway and nothing else. */
export function stagingOnly(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return `Only ${STAGING}. Refusing a base URL that isn't a URL.`;
  }
  if (url.origin !== STAGING) return `Only ${STAGING}. Refusing ${url.origin === "null" ? "that URL" : url.origin}.`;
  const plain = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  return plain ? null : `Only ${STAGING} itself. Refusing it with a path, a query or credentials.`;
}

/** Why the sign-up secret can't be right, or null. The gateway wants at least 32 characters. */
export function secretProblem(secret) {
  if (!secret) return "PODSTER_E2E_SIGNUP_SECRET isn't set";
  return secret.length < 32 ? "PODSTER_E2E_SIGNUP_SECRET is shorter than the 32 characters the gateway wants" : null;
}

/** Why the webhook secret can't be right, or null: unset is fine, and skips the checks that sign. The gateway wants 32 characters. */
export function webhookSecretProblem(secret) {
  if (secret === undefined || secret === "") return null;
  return secret.length < 32 ? `${WEBHOOK_SECRET_ENV} is set and shorter than the 32 characters the gateway wants` : null;
}

/**
 * What the run needs from staging's own configuration, `env.staging.vars` of the API's wrangler file, or why it can't
 * run: the organization and the merge App, to compare GitHub's answers with. Whether managed repositories are switched
 * on isn't read from the file. The run asks staging, and stops with exit code 3 when they're off.
 */
export function stagingConfig(vars = {}) {
  const [org, orgId, mergeAppId] = [vars.GITHUB_ORG_LOGIN, Number(vars.GITHUB_ORG_ID), Number(vars.GITHUB_MERGE_APP_ID)];
  if (!org || !/^[A-Za-z0-9-]+$/.test(org) || !Number.isInteger(orgId) || orgId <= 0 || !Number.isInteger(mergeAppId) || mergeAppId <= 0) {
    return { error: "the API's wrangler file doesn't name staging's GitHub organization, its ID and the merge App's ID" };
  }
  // The organization is pinned in code. A file that names another one is refused, whatever else it holds.
  if (org !== STAGING_ORG) return { error: `the API's wrangler file names ${org} as staging's GitHub organization, and this run makes repositories in ${STAGING_ORG} only` };
  return { org, orgId, mergeAppId };
}

/** Why a repository's full name isn't one under the pinned organization, or null. What staging answers is checked too. */
export function repositoryOrgProblem(fullName) {
  return typeof fullName === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(fullName) && fullName.split("/")[0] === STAGING_ORG ? null : `staging linked ${JSON.stringify(fullName)}, which isn't a repository under ${STAGING_ORG}`;
}

/**
 * Why one of the run's people can't ask for the room's repository, or null. Staging names who may ask in the API's
 * REPOSITORY_REQUESTERS, and the run's people are in it through its `test-people` entry alone: each is made by the test
 * sign-up, so their ID starts `per_e2e_`. `mayRequest` is what the room's repository read said to that person.
 */
export function requesterProblem(personId, mayRequest) {
  if (typeof personId !== "string" || !/^per_e2e_[A-Za-z0-9]+$/.test(personId)) return `${JSON.stringify(personId)} isn't a test person's ID, so staging's list of repository requesters can't hold them as one`;
  if (mayRequest !== true) return `staging told ${personId} they may not ask for a repository (may_request: ${JSON.stringify(mayRequest)}). The API's REPOSITORY_REQUESTERS must hold the entry test-people, exactly, with every other entry well formed`;
  return null;
}

/**
 * The grants a run gave that must not outlive it: each is noted when given and settled once the run has seen it
 * ended, expired or taken back. Whatever is left is what clean-up takes back, so a wait that timed out leaves no live grant.
 */
export class GrantLedger {
  #open = new Map();

  note(id, what) {
    if (typeof id === "string" && id) this.#open.set(id, what);
  }

  settle(id) {
    this.#open.delete(id);
  }

  /** The grants still to take back, oldest first, each with what it was. */
  left() {
    return [...this.#open].map(([id, what]) => ({ id, what }));
  }
}

/** Results by ID, printed as they come. Exit code 0 only when nothing failed. */
export class Tally {
  results = [];
  #say;
  #known;

  constructor(plan = PLAN, say = console.log) {
    this.#known = new Map(plan.map((entry) => [entry.id, entry.title]));
    this.#say = say;
  }

  /** `status` is `pass`, `fail` or `skip`. Each planned ID gets one result, and no other ID gets any. */
  add(id, status, detail = "") {
    if (!this.#known.has(id)) throw new Error(`${id} isn't in the plan`);
    if (this.has(id)) throw new Error(`${id} already has a result`);
    if (!["pass", "fail", "skip"].includes(status)) throw new Error(`${status} isn't a result`);
    this.results.push({ id, status, detail });
    this.#say(`${{ pass: "PASS", fail: "FAIL", skip: "SKIP" }[status]} ${id.padEnd(7)} ${this.#known.get(id)}${detail ? `\n             ${detail}` : ""}`);
  }

  has(id) {
    return this.results.some((r) => r.id === id);
  }

  passed(id) {
    return this.results.some((r) => r.id === id && r.status === "pass");
  }

  /** Marks every planned check without a result as skipped, so a run that stopped early still lists them all. */
  skipRest(why) {
    for (const id of this.#known.keys()) if (!this.has(id)) this.add(id, "skip", why);
  }

  counts() {
    return Object.fromEntries(["pass", "fail", "skip"].map((s) => [s, this.results.filter((r) => r.status === s).length]));
  }

  ids(status) {
    return this.results.filter((r) => r.status === status).map((r) => r.id);
  }

  summary() {
    const { pass, fail, skip } = this.counts();
    return `${pass} passed, ${fail} failed, ${skip} skipped`;
  }

  /** 0 only when nothing failed and something passed. A skip doesn't fail the run, and is always printed and counted. */
  exitCode() {
    const { pass, fail } = this.counts();
    return fail > 0 || pass === 0 ? 1 : 0;
  }
}

/** Text with every secret, and anything shaped like a GitHub token, taken out, for anything that's printed. */
export function scrub(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/gh[a-z]_[A-Za-z0-9_]{16,}/g, "[redacted]");
}

/** The one name the repository token travels under, to the `git` child and nowhere else. */
export const CREDENTIAL_ENV = "M5_GIT_ANSWER";

/**
 * What git runs to ask for a name and a password. It holds no token: it prints the one in its environment, and only to
 * git's two questions about github.com itself. Any other question, for another host or another name, gets no answer.
 */
export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  "Username for 'https://github.com': ") printf '%s\\n' x-access-token ;;
  "Password for 'https://x-access-token@github.com': ") printf '%s\\n' "$${CREDENTIAL_ENV}" ;;
  *) exit 1 ;;
esac
`;

/**
 * The `git` child's environment: child-env.mjs's allow-list, a home of its own so no configuration, credential helper or
 * keychain of the person running this is read or written, and, when a push needs it, the token under one name.
 */
export function gitEnv({ home, askpass, credential, from = process.env }) {
  const env = childEnv({ HOME: home, LC_ALL: "C", GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, from);
  // Added here, past the allow-list, which refuses a secret by design: the token is this child's one secret.
  return credential ? { ...env, [CREDENTIAL_ENV]: credential } : env;
}

/** Why a clone URL isn't the repository's own on github.com, or null. The token is offered to this host only. */
export function cloneUrlProblem(cloneUrl, fullName) {
  return cloneUrl === `https://github.com/${fullName}.git` ? null : "the clone URL isn't https://github.com/<the repository>.git";
}

/**
 * What's wrong with a repository's rulesets, as GitHub's public API shows them, against ADR 0009's two. An empty list
 * means they match. `bypassRead` says whether the answers carried bypass lists, which GitHub shows to administrators only.
 */
export function rulesetProblems(rulesets, mergeAppId) {
  const problems = [];
  const types = (set) => (set.rules ?? []).map((rule) => rule.type).sort().join("+");
  if (rulesets.length !== 2) problems.push(`${rulesets.length} rulesets, not 2`);
  const review = rulesets.filter((set) => types(set) === "pull_request+required_status_checks");
  const update = rulesets.filter((set) => types(set) === "update");
  if (review.length !== 1) problems.push(`${review.length} rulesets with exactly pull_request and required_status_checks`);
  if (update.length !== 1) problems.push(`${update.length} rulesets with exactly update`);
  for (const set of rulesets) {
    if (set.enforcement !== "active") problems.push(`ruleset ${set.id} is ${set.enforcement}`);
    if (set.target !== "branch") problems.push(`ruleset ${set.id} targets ${set.target}`);
    const refs = set.conditions?.ref_name;
    if (JSON.stringify([refs?.include, refs?.exclude]) !== JSON.stringify([[DEFAULT_BRANCH_REF], []])) problems.push(`ruleset ${set.id} isn't on the default branch alone`);
  }
  for (const set of review) {
    const rule = set.rules.find((r) => r.type === "required_status_checks")?.parameters ?? {};
    const wanted = (rule.required_status_checks ?? []).map((c) => [c.context, c.integration_id]);
    if (JSON.stringify(wanted) !== JSON.stringify([[STATUS_CONTEXT, mergeAppId]])) problems.push(`ruleset ${set.id} doesn't require exactly ${STATUS_CONTEXT} from the merge App`);
    if (rule.strict_required_status_checks_policy !== false) problems.push(`ruleset ${set.id} has the strict policy on`);
    if (set.bypass_actors && set.bypass_actors.length !== 0) problems.push(`ruleset ${set.id} has a bypass actor`);
  }
  for (const set of update) {
    const bypass = (set.bypass_actors ?? []).map((a) => [a.actor_type, a.actor_id, a.bypass_mode]);
    if (set.bypass_actors && JSON.stringify(bypass) !== JSON.stringify([["Integration", mergeAppId, "always"]])) problems.push(`ruleset ${set.id}'s bypass isn't the merge App alone`);
  }
  return { problems, bypassRead: rulesets.length > 0 && rulesets.every((set) => Array.isArray(set.bypass_actors)) };
}

/** What's wrong with a merge commit: it must have the default branch's old tip first and the reviewed commit second. */
export function mergeCommitProblems(commit, { tipBefore, reviewed }) {
  const parents = (commit?.parents ?? []).map((p) => p.sha);
  return JSON.stringify(parents) === JSON.stringify([tipBefore, reviewed]) ? [] : [`its parents are ${parents.length ? parents.join(" and ") : "none"}, not the old tip and the reviewed commit`];
}

/** What's wrong with a commit's statuses: exactly one for the review context, a success, created by the merge App's bot. */
export function reviewStatusProblems(statuses, slug = MERGE_APP_SLUG) {
  const ours = (Array.isArray(statuses) ? statuses : []).filter((s) => s.context === STATUS_CONTEXT);
  // More than one is a different finding from a wrong creator: it's what a merge job that ran twice leaves.
  if (ours.length > 1) return [`${ours.length} ${STATUS_CONTEXT} statuses were found, not 1, as a retried merge job would leave: ${ours.map((s) => `${s.state} by ${s.creator?.login ?? "nobody"}`).join(", ")}`];
  if (ours.length === 0) return [`no ${STATUS_CONTEXT} status was found`];
  const [{ state, creator }] = ours;
  const seen = [state, creator?.login, creator?.type];
  return JSON.stringify(seen) === JSON.stringify(["success", `${slug}[bot]`, "Bot"]) ? [] : [`the one status is ${state} by ${creator?.login ?? "nobody"} (${creator?.type ?? "unknown"})`];
}

/**
 * What's wrong with a release status against the task's change as the same person reads it: the pull request and the
 * merge must say what the change says, checks must name the commit they were read for, and no release exists.
 */
export function releaseStatusProblems(status, change, taskId) {
  const problems = [];
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} is ${JSON.stringify(a)}, and the change says ${JSON.stringify(b)}`);
  };
  same("task_id", status?.task_id, taskId);
  same("linked", status?.linked, true);
  const pull = status?.pull_request;
  if (!pull) problems.push("no pull request is reported");
  else for (const field of ["pr_number", "pr_state", "reviewed_commit_sha", "observed_head_sha", "commit_changed"]) same(`pull_request.${field}`, pull[field], change[field]);
  const merge = status?.merge ?? {};
  for (const [field, from] of [["state", "merge_state"], ["reason", "merge_reason"], ["sha", "merge_sha"], ["requested_by", "merge_requested_by"]]) same(`merge.${field}`, merge[field], change[from]);
  const checks = status?.checks;
  if (!checks) problems.push("no checks are reported to someone shown the change");
  else if (checks.commit_sha === null) {
    if (checks.state !== null || checks.counts !== null || checks.observed_at !== null) problems.push("checks are reported with no commit they were read for");
  } else if (checks.commit_sha !== pull?.observed_head_sha) problems.push("checks are reported beside a head they weren't read for");
  else if (checks.observed_at === null) problems.push("checks name a commit and no time they were read");
  if (JSON.stringify(status?.release) !== JSON.stringify({ exists: false })) problems.push(`release is ${JSON.stringify(status?.release)}, not { exists: false }`);
  return problems;
}

// ---- what the extended run adds ----

/** An ID of the same shape that names nothing: the part after the last `_`, reversed. Null if that leaves it unchanged. */
export function absentId(id) {
  const cut = String(id).lastIndexOf("_") + 1;
  const other = String(id).slice(0, cut) + [...String(id).slice(cut)].reverse().join("");
  return cut > 0 && other !== id ? other : null;
}

/** The parts of a task's change that only a real change on GitHub moves. Times of reading it aren't among them. */
export const STEADY = ["provider_repo_id", "pr_number", "submission_no", "pr_state", "pr_draft", "observed_head_sha", "head_in_repository", "base_is_default", "reviewed_commit_sha", "commit_changed", "watched", "merge_state", "merge_reason", "merge_sha"];
export const steady = (change) => (change && typeof change === "object" ? STEADY.map((field) => change[field] ?? null) : null);

/**
 * A `pull_request` delivery's body, as small as the gateway takes: the repository's ID, the pull request's number and
 * its head commit. The nonce makes each body a different one, since the room takes the same body as the same delivery.
 */
export function deliveryBody({ repositoryId, number, head, nonce }) {
  return JSON.stringify({ action: "synchronize", number, pull_request: { number, head: { sha: head } }, repository: { id: repositoryId }, nonce });
}

/** GitHub's signature header for a body under a secret. */
export function signDelivery(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Each thing a `wrangler tail` event says the Worker itself logged, as the values it logged. */
function logged(event) {
  return (Array.isArray(event?.logs) ? event.logs : []).flatMap((entry) => (Array.isArray(entry?.message) ? entry.message : [entry?.message]));
}

/**
 * What the API's log says became of a delivery: every `provider.delivery` line for that ID, in order, by its outcome.
 * The API logs one line a delivery, of IDs and a fixed code.
 */
export function deliveryOutcomes(events, deliveryId) {
  const outcomes = [];
  for (const event of events) {
    for (const part of logged(event)) {
      let line = part;
      if (typeof part === "string") {
        try {
          line = JSON.parse(part);
        } catch {
          continue;
        }
      }
      if (line && typeof line === "object" && line.at === "provider.delivery" && line.delivery === deliveryId) outcomes.push(String(line.outcome));
    }
  }
  return outcomes;
}

/** What the Workers themselves logged in these events, and their exceptions, as text to search. Never the request's own headers. */
export const loggedText = (events) => events.map((event) => JSON.stringify([event?.logs ?? [], event?.exceptions ?? []])).join("\n");

/**
 * Which of the run's own strings are in a text: the labels only, never the strings. A string shorter than 8 characters
 * isn't looked for, since it could be there by chance.
 */
export function leaks(text, needles) {
  const found = new Set();
  for (const { label, value } of needles) if (typeof value === "string" && value.length >= 8 && text.includes(value)) found.add(label);
  return [...found];
}

/** How long after authority ended a merge may still land and be the job's last, already-checked call. Past it, it isn't. */
export const LATE_MERGE_MS = 5000;
/** How far GitHub's clock and staging's are allowed to differ when one's time is set against the other's. */
export const CLOCK_SKEW_MS = 2000;

const seconds = (ms) => `${Math.round(Math.abs(ms) / 100) / 10} s ${ms < 0 ? "before" : "after"}`;

/**
 * How a merge ended that the run asked for and then took the authority for away, while it waited for the job.
 *
 * The job must end it with that authority's own code and merge nothing: `shown`. A merge that succeeded is never
 * waved through:
 *
 * - **`held`:** the run itself saw the order. After the authority had ended, the merge ahead of this one in the job's
 *   order was still waiting, and so was this one. Then any merge is the job merging without authority: a failure,
 *   whatever any clock says.
 * - **Not held:** only times are left. `lostAt` is when Podster recorded the authority ending, from the room's audit
 *   log, and `finishedAt` when it recorded the merge finished, by the same clock. `mergedAt` is GitHub's time for the
 *   merge, by GitHub's clock, cut to the second.
 *   - Finished before the authority ended by Podster's own clock, or merged more than a second and CLOCK_SKEW_MS
 *     before it by GitHub's: the race was lost. `race_lost`, a skip.
 *   - Merged more than LATE_MERGE_MS and CLOCK_SKEW_MS after it: the job merged without authority. A failure.
 *   - Anything between, from CLOCK_SKEW_MS + 1 s before to LATE_MERGE_MS + CLOCK_SKEW_MS after: the job's call may
 *     have been checked and on its way, or the clocks may differ. `cannot_tell`, a skip counted apart.
 *   - A time that can't be read: a failure.
 */
export function lostAuthorityEnding(change, reason, { lostAt, mergedAt, held } = {}) {
  if (change?.merge_state === "failed" && change.merge_reason === reason && (change.merge_sha ?? null) === null) return { shown: true };
  if (change?.merge_state !== "succeeded") return { problem: `the merge ended ${change?.merge_state ?? "in no state"} with ${change?.merge_reason ?? "no reason"}, not failed with ${reason}` };
  const timed = Number.isFinite(lostAt) && Number.isFinite(mergedAt);
  if (held === true) return { problem: `the merge succeeded, and the run had seen the job not yet reach it once the authority had ended: it merged without authority${timed ? ` (GitHub's time for the merge is ${seconds(mergedAt - lostAt)} Podster's for the authority ending)` : ""}` };
  if (!timed) return { problem: "the merge succeeded, and when the authority ended or when GitHub merged couldn't be read, so it can't be shown to have come first" };
  const finishedAt = Number.isFinite(change.merge_finished_at) ? change.merge_finished_at : null;
  const gap = mergedAt - lostAt;
  if ((finishedAt !== null && finishedAt < lostAt) || gap + 1000 + CLOCK_SKEW_MS <= 0) return { shown: false, kind: "race_lost", why: `the race was lost: the merge landed ${seconds(finishedAt !== null && finishedAt < lostAt ? finishedAt - lostAt : gap)} the authority ended, so this run shows nothing either way` };
  if (gap >= LATE_MERGE_MS + CLOCK_SKEW_MS) return { problem: `the merge succeeded ${seconds(gap)} the authority ended, by GitHub's time against Podster's: it merged without authority` };
  return { shown: false, kind: "cannot_tell", why: `it can't be told: GitHub's time for the merge is ${seconds(gap)} Podster's for the authority ending, inside the window from ${(CLOCK_SKEW_MS + 1000) / 1000} s before to ${(LATE_MERGE_MS + CLOCK_SKEW_MS) / 1000} s after where the job's call may already have been checked, or the two clocks may differ; and the run hadn't seen the job still waiting` };
}

/** Whether a value is a full commit ID, before it goes into a path. */
export const isCommitSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/**
 * The longest a run could take if every bounded wait ran to its limit, in seconds: the waits only, not the requests
 * between them. A run that passes takes a small part of this.
 */
export function worstCaseSeconds(options) {
  const fixed = { tails: 60 + 120 + 60, retry: 180, expiries: 90 + 90, publicRoom: 60, deliveries: 120 + 5 * 60, githubHeads: 3 * 60 };
  return 3 * options.setupWait + 7 * options.mergeWait + options.observeWait + 7 * options.revokeWait + Object.values(fixed).reduce((sum, seconds) => sum + seconds, 0);
}

/** A log line's own name for what it records, if it has one that is plainly a name: never free text, which could hold what's looked for. */
function eventName(part) {
  let line = part;
  if (typeof part === "string") {
    try {
      line = JSON.parse(part);
    } catch {
      return "a line with no event name";
    }
  }
  const name = line && typeof line === "object" ? (line.at ?? line.event) : undefined;
  return typeof name === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(name) ? name : "a line with no event name";
}

/**
 * Where the Workers logged something of the run's own: for each tail, each log line or exception that holds one of the
 * needles, or anything shaped like a GitHub token or a private key. A hit names the Worker, the line's event name and
 * the kind of string, and never the string or the line. A needle under 8 characters isn't looked for.
 */
export function logHits(tails, needles) {
  const hits = new Map();
  const note = (app, event, kind) => hits.set(`${app}\n${event}\n${kind}`, { app, event, kind });
  const wanted = needles.filter(({ value }) => typeof value === "string" && value.length >= 8);
  for (const { app, events } of tails) {
    for (const event of events) {
      const parts = [...logged(event).map((part) => [eventName(part), typeof part === "string" ? part : JSON.stringify(part ?? null)]), ...(Array.isArray(event?.exceptions) ? event.exceptions : []).map((thrown) => ["an exception", JSON.stringify(thrown ?? null)])];
      for (const [given, text] of parts) {
        // A name that holds one of the strings isn't printed either.
        const name = wanted.some(({ value }) => given.includes(value)) || /gh[a-z]_/.test(given) ? "a line with no event name" : given;
        for (const { label, value } of wanted) if (text.includes(value)) note(app, name, label);
        if (/gh[a-z]_[A-Za-z0-9_]{16,}/.test(text)) note(app, name, "something shaped like a GitHub token");
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) note(app, name, "key material");
      }
    }
  }
  return [...hits.values()];
}

/**
 * How a merge ended that was asked for right after the reviewed branch advanced. `shown` only when the job itself found
 * the moved head. The other endings are safe and show nothing: Podster had already seen the move and refused the
 * request, GitHub refused the merge call, or GitHub merged exactly the reviewed commit before its pull request showed
 * the new head. Anything else is a problem.
 */
export function movedHeadEnding({ refusedCode, change, mergedSecondParent, reviewed }) {
  if (refusedCode !== undefined) return refusedCode === "commit_changed" ? { shown: false, why: "Podster had already seen the moved head, and refused the request with commit_changed before any job ran" } : { problem: `the request was refused ${refusedCode}, not commit_changed` };
  if (change?.merge_state === "failed" && change.merge_reason === "commit_changed" && (change.merge_sha ?? null) === null) return { shown: true };
  if (change?.merge_state === "failed" && change.merge_reason === "provider_refused" && (change.merge_sha ?? null) === null) return { shown: false, why: "GitHub's pull request still showed the reviewed head to the job, and GitHub then refused the merge call: failed, provider_refused" };
  if (change?.merge_state === "succeeded") return mergedSecondParent === reviewed ? { shown: false, why: "GitHub merged exactly the reviewed commit before its pull request showed the new head" } : { problem: `the merge succeeded with ${mergedSecondParent ?? "no"} second parent, not the reviewed commit` };
  return { problem: `the merge ended ${change?.merge_state ?? "in no state"} with ${change?.merge_reason ?? "no reason"}` };
}

/** The log tails' child environment: child-env.mjs's allow-list and nothing else, so wrangler finds its own login under HOME. */
export const tailEnv = (from = process.env) => childEnv({}, from);
