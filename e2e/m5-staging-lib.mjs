// The parts of m5-staging.mjs that touch nothing: its arguments, the one host it accepts, the plan of checks, the results
// and their exit code, the environment its `git` child gets, and what it reads out of GitHub's answers. Kept apart so
// m5-staging-selftest.mjs can check them without a network, a secret or the e2e packages.
import { childEnv } from "./child-env.mjs";

export const STAGING = "https://gateway-staging.podster.dev";
/** The one GitHub organization this run may make repositories in. Pinned here, so a changed file can't point it elsewhere. */
export const STAGING_ORG = "podsterdev";
export const STATUS_CONTEXT = "podster/review";
export const DEFAULT_BRANCH_REF = "~DEFAULT_BRANCH";
/** The merge App's name on staging (docs/staging.md). A status it sets is created by `<name>[bot]`. */
export const MERGE_APP_SLUG = "podster-staging-merge";

/**
 * The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. Agents are made under these
 * people and take none.
 */
export const SIGN_UPS = [
  { who: "the room's owner", why: "owns the room and its repository, gives grants, reviews, and controls the submitting agent" },
  { who: "a second person", why: "is the room's admin, who asks for the repository and gives the push grant, and controls the merging agent, an agent with no grant, a guest and a public claimant" },
];

/** Every check, in the order it runs. A result for an ID that isn't here is a bug in the script. */
export const PLAN = [
  ["M5-00", "managed repositories are switched on, and a room that hasn't asked has no repository"],
  ["M5-14", "no operator approves first: an organization nobody set a delegation for holds it, and the room's owner and admin are told so"],
  ["M5-04", "a request naming an organization is refused 400 invalid_argument"],
  ["M5-01", "a room admin's request, a person who isn't the owner, is recorded as pending and becomes a ready repository, with GitHub's ID recorded"],
  ["M5-02", "the repository is public and under podsterdev on GitHub, while the room is private"],
  ["M5-01b", "GitHub shows exactly the two rulesets of ADR 0009 on the default branch, both active"],
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
].map(([id, title]) => ({ id, title }));

const WAITS = { "--setup-wait-s": ["setupWait", 240], "--merge-wait-s": ["mergeWait", 180], "--observe-wait-s": ["observeWait", 420], "--revoke-wait-s": ["revokeWait", 180] };

export const USAGE = `node m5-staging.mjs --base-url ${STAGING} [--dry-run]
    [--setup-wait-s N] [--merge-wait-s N] [--observe-wait-s N] [--revoke-wait-s N] [--api-config FILE]

  --dry-run   check the configuration and print the plan. Sends nothing anywhere.
  The waits bound, in seconds, the repository's setup (240), a merge (180), Podster noticing a moved head (420)
  and a token's revocation (180). Each is 10 to 1800.
  --api-config   the API's wrangler file, which names staging's GitHub organization and merge App.
                 It defaults to apps/api/wrangler.jsonc.

  PODSTER_E2E_SIGNUP_SECRET     staging's test sign-up secret. Needed.

  It makes repositories in ${STAGING_ORG} and nowhere else: a configuration naming another organization is refused.`;

/** The arguments, or why they're refused. Nothing is guessed: an unknown flag or a missing value is an error. */
export function parseArgs(argv, env = {}) {
  const options = { base: undefined, dryRun: false, help: false, apiConfig: undefined };
  for (const [key, fallback] of Object.values(WAITS)) options[key] = fallback;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
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
