#!/usr/bin/env node
// M5 spike: what GitHub App tokens, branch rules and merges really do.
// Runs against a TEST organization only. Nothing builds on this file.
//
//   M5_ORG=podster-spike M5_PROVISION_APP_ID=1 M5_MERGE_APP_ID=2 node spike.mjs
//   ... node spike.mjs --allow-public   also try rules on a public repository
//   ... node spike.mjs --cleanup        delete this spike's repositories and exit
//   ... node spike.mjs --cleanup --public-only   delete only its public ones
//   ... node spike.mjs --merge-restriction        only test, on a public repository,
//                                                 whether a rule can restrict who merges
//   ... M5_AGENT_APP_ID=3 node spike.mjs --three-apps   only test ADR 0009's three-App
//                                                 split, on a public repository (plus one
//                                                 private repository to probe reach)
//
// Tokens and keys are never printed or written. Results hold status codes and
// GitHub's own error messages only.

import { createPrivateKey, createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.github.com";
const PREFIX = "m5-spike-";
const STATUS_CONTEXT = "podster/review";
const KNOWN_ARGS = ["--allow-public", "--cleanup", "--public-only", "--merge-restriction", "--three-apps"];
const ALONE = ["--merge-restriction", "--three-apps"];

export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(body).sign(createPrivateKey(pem)).toString("base64url");
  return `${body}.${sig}`;
}

// The organization must look like a test one, so a typo can't point this at a real one.
export function looksLikeTestOrg(name) {
  const s = name ?? "";
  return /^[A-Za-z0-9-]+$/.test(s) && /(^|-)(spike|test|sandbox)(-|$)/i.test(s);
}

// An organization that doesn't look like a test one runs only if the owner repeats its name exactly.
export function orgAllowed(org, confirm) {
  if (looksLikeTestOrg(org)) return true;
  return typeof org === "string" && /^[A-Za-z0-9-]+$/.test(org) && confirm === org;
}

// A ruleset on the default branch for the merge-restriction mode. Body shape per
// https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28#create-a-repository-ruleset
// `bypassAppId` names a GitHub App that may bypass every rule in this ruleset.
export function restrictionRuleset({ name, statusAppId = null, pullRequest = false, update = false, bypassAppId = null }) {
  const rules = [];
  if (pullRequest) {
    rules.push({ type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } });
  }
  if (statusAppId !== null) {
    rules.push({ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: STATUS_CONTEXT, integration_id: statusAppId }] } });
  }
  if (update) rules.push({ type: "update", parameters: { update_allows_fetch_and_merge: false } });
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: bypassAppId === null ? [] : [{ actor_id: bypassAppId, actor_type: "Integration", bypass_mode: "always" }],
    rules,
  };
}

// What the three-Apps mode expects to read back: exactly two active rulesets on the
// default branch, the review one with no bypass actor and the update one whose bypass
// list is exactly the merge App. Anything missing, extra or unreadable is false.
// Takes rulesets as GET /repos/{owner}/{repo}/rulesets/{id} returns them.
export function rulesetsAsExpected(rulesets, mergeAppId) {
  if (!Array.isArray(rulesets) || rulesets.length !== 2) return false;
  const types = (r) => (Array.isArray(r?.rules) ? r.rules.map((x) => x.type).sort().join(",") : "");
  const common = (r) =>
    r?.enforcement === "active" &&
    r?.target === "branch" &&
    JSON.stringify(r?.conditions?.ref_name?.include) === '["~DEFAULT_BRANCH"]' &&
    JSON.stringify(r?.conditions?.ref_name?.exclude) === "[]" &&
    Array.isArray(r?.bypass_actors);
  const review = rulesets.find((r) => types(r) === "pull_request,required_status_checks");
  const update = rulesets.find((r) => types(r) === "update");
  if (!review || !update || !common(review) || !common(update)) return false;
  const checks = review.rules.find((x) => x.type === "required_status_checks")?.parameters?.required_status_checks;
  if (!Array.isArray(checks) || checks.length !== 1 || checks[0].context !== STATUS_CONTEXT || checks[0].integration_id !== mergeAppId) return false;
  if (review.bypass_actors.length !== 0 || update.bypass_actors.length !== 1) return false;
  const b = update.bypass_actors[0];
  return b.actor_id === mergeAppId && b.actor_type === "Integration" && b.bypass_mode === "always";
}

// Returns why these arguments can't run, or null. The merge-restriction and
// three-Apps modes each run alone, so a flag they would ignore is refused instead.
export function argsProblem(list) {
  const unknown = list.filter((x) => !KNOWN_ARGS.includes(x));
  if (unknown.length > 0) return `Unknown argument: ${unknown.join(", ")}`;
  for (const mode of ALONE) {
    if (!list.includes(mode)) continue;
    const clash = list.filter((x) => x !== mode);
    if (clash.length > 0) return `${mode} runs alone; it can't be combined with ${clash.join(", ")}`;
  }
  return null;
}

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "m5-spike",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, message: json?.message ?? null, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString("base64");

async function main() {
  const args = new Set(process.argv.slice(2));
  const problem = argsProblem([...args]);
  if (problem) throw new Error(problem);
  const org = process.env.M5_ORG;
  const keyDir = process.env.M5_KEY_DIR ?? join(homedir(), ".podster", "m5-spike");
  const apps = {
    provision: { id: process.env.M5_PROVISION_APP_ID, pem: join(keyDir, "provision.pem") },
    merge: { id: process.env.M5_MERGE_APP_ID, pem: join(keyDir, "merge.pem") },
  };
  if (!org || !apps.provision.id || !apps.merge.id) {
    throw new Error("Set M5_ORG, M5_PROVISION_APP_ID and M5_MERGE_APP_ID.");
  }
  if (args.has("--three-apps")) {
    if (!process.env.M5_AGENT_APP_ID) throw new Error("--three-apps also needs M5_AGENT_APP_ID.");
    apps.agent = { id: process.env.M5_AGENT_APP_ID, pem: join(keyDir, "agent.pem") };
  }
  if (!orgAllowed(org, process.env.M5_CONFIRM_ORG)) {
    throw new Error(`Refusing to run: "${org}" isn't a plain name with spike, test or sandbox in it. The owner can allow it by setting M5_CONFIRM_ORG to the same name.`);
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const results = [];
  const broad = [];
  try {
    await run({ args, org, apps, stamp, results, broad });
  } finally {
    // Tokens live for an hour unless revoked. The merge-restriction and three-Apps modes add their scoped tokens here.
    // Each revocation's status is recorded, never the token. null means the call itself failed.
    const statuses = [];
    for (const token of broad) {
      statuses.push(await gh(token, "DELETE", "/installation/token").then((r) => r.status, () => null));
    }
    if (broad.length > 0) {
      const revoked = { risk: 0, name: "tokens revoked at the end", minted: broad.length, statuses };
      results.push(revoked);
      console.log(`[risk 0] ${revoked.name}: ${JSON.stringify({ minted: revoked.minted, statuses })}`);
    }
    if (results.length > 0) finish(results, stamp);
  }
}

async function run({ args, org, apps, stamp, results, broad }) {
  const record = (risk, name, observed) => {
    results.push({ risk, name, ...observed });
    console.log(`[risk ${risk}] ${name}: ${JSON.stringify(observed)}`);
  };

  // Preflight: each App answers, and is installed on this organization.
  for (const [name, app] of Object.entries(apps)) {
    app.jwt = () => appJwt(app.id, readFileSync(app.pem, "utf8"));
    const me = await gh(app.jwt(), "GET", "/app");
    if (me.status !== 200) throw new Error(`${name} App: GET /app returned ${me.status} ${me.message}`);
    const inst = await gh(app.jwt(), "GET", `/orgs/${org}/installation`);
    if (inst.status !== 200) throw new Error(`${name} App isn't installed on ${org}: ${inst.status} ${inst.message}`);
    app.installation = inst.json.id;
    app.githubAppId = me.json.id;
    record(0, `${name} App installed`, {
      status: 200,
      permissions: inst.json.permissions,
      repository_selection: inst.json.repository_selection,
    });
    app.token = async (scope) => {
      const r = await gh(app.jwt(), "POST", `/app/installations/${app.installation}/access_tokens`, scope);
      return { status: r.status, message: r.message, token: r.json?.token, expires_at: r.json?.expires_at, granted: r.json?.permissions };
    };
    const all = await app.token();
    if (!all.token) throw new Error(`${name} App: minting a token returned ${all.status} ${all.message}`);
    app.all = all.token;
    broad.push(all.token);
  }
  const provisionAll = apps.provision.all;
  const mergeAll = apps.merge.all;

  if (args.has("--cleanup")) {
    for (let page = 1; ; page++) {
      const list = await gh(provisionAll, "GET", `/installation/repositories?per_page=100&page=${page}`);
      if (list.status !== 200) throw new Error(`Listing repositories returned ${list.status} ${list.message}`);
      const repos = list.json.repositories ?? [];
      for (const repo of repos) {
        if (repo.owner.login.toLowerCase() !== org.toLowerCase() || !repo.name.startsWith(PREFIX)) continue;
        if (args.has("--public-only") && repo.private !== false) continue;
        const del = await gh(provisionAll, "DELETE", `/repos/${org}/${repo.name}`);
        record(0, `cleanup: delete ${repo.name}`, { status: del.status, message: del.message, repository: repo.private === false ? "public" : "private" });
      }
      if (repos.length < 100) break;
    }
    return;
  }

  if (args.has("--merge-restriction")) {
    await mergeRestriction({ org, apps, stamp, record, revoke: broad });
    return;
  }

  if (args.has("--three-apps")) {
    await threeApps({ org, apps, stamp, record, revoke: broad });
    return;
  }

  // Risk 1: can the App create a repository in the organization?
  const createRepo = async (suffix, isPrivate) => {
    const name = `${PREFIX}${stamp}-${suffix}`;
    const r = await gh(provisionAll, "POST", `/orgs/${org}/repos`, { name, private: isPrivate, auto_init: true });
    record(1, `create ${isPrivate ? "private" : "public"} repository ${suffix}`, { status: r.status, message: r.message });
    return r.status === 201 ? { name, id: r.json.id, branch: r.json.default_branch, visibility: isPrivate ? "private" : "public" } : null;
  };
  const repo = await createRepo("a", true);
  const other = await createRepo("b", true);
  if (!repo || !other) return;
  const base = `/repos/${org}/${repo.name}`;

  // Risk 2: is the new repository under the installation at once?
  // Risk 3: can a token be limited to one repository and a subset of permissions?
  const scopeFor = (r) => ({ repository_ids: [r.id], permissions: { contents: "write", pull_requests: "write" } });
  let agent = null;
  const started = Date.now();
  for (let i = 0; i < 15 && !agent?.token; i++) {
    agent = await apps.provision.token(scopeFor(repo));
    if (!agent.token) await sleep(2000);
  }
  record(2, "scoped token for the new repository", {
    status: agent.status,
    message: agent.message,
    seconds_until_minted: Math.round((Date.now() - started) / 1000),
    expires_at: agent.expires_at,
  });
  if (!agent.token) return;
  record(3, "permissions granted on the scoped token", { granted: agent.granted });
  const reach = await gh(agent.token, "GET", `/repos/${org}/${other.name}`);
  record(3, "scoped token reads the other repository", { status: reach.status, message: reach.message });
  const admin = await gh(agent.token, "PATCH", base, { description: "spike" });
  record(3, "scoped token edits repository settings", { status: admin.status, message: admin.message });
  const wider = await apps.provision.token({ repository_ids: [repo.id], permissions: { workflows: "write" } });
  record(3, "asking for a permission the App doesn't hold", { status: wider.status, message: wider.message });

  // Risk 5: do rulesets apply to a private repository on this plan?
  const ruleset = {
    name: "podster-default-branch",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: STATUS_CONTEXT, integration_id: apps.merge.githubAppId }] } },
    ],
  };
  const addRuleset = async (r) => {
    const res = await gh(provisionAll, "POST", `/repos/${org}/${r.name}/rulesets`, ruleset);
    record(5, `ruleset on a ${r.visibility} repository`, { status: res.status, message: res.message, enforcement: res.json?.enforcement });
    return res.status === 201 && res.json?.enforcement === "active";
  };
  const privateRules = await addRuleset(repo);
  const agentRules = await gh(agent.token, "POST", `${base}/rulesets`, { ...ruleset, name: "agent-made" });
  record(3, "scoped token creates a ruleset", { status: agentRules.status, message: agentRules.message });

  // Risks 4 and 6 on one repository. Every record says whether a ruleset was active,
  // because without one these results say nothing about the boundary.
  const mergeProbes = async (target, rulesetActive, token) => {
    const at = `/repos/${org}/${target.name}`;
    const note = { repository: target.visibility, ruleset_active: rulesetActive };
    const rec = (risk, name, r, extra = {}) => record(risk, name, { status: r.status, message: r.message, ...note, ...extra });
    const mainRef = await gh(token, "GET", `${at}/git/ref/heads/${target.branch}`);
    const mainSha = mainRef.json?.object?.sha;
    if (!mainSha) return rec(4, "read the default branch's head", mainRef);
    const commitFile = async (branch, path, text) => {
      const r = await gh(token, "PUT", `${at}/contents/${path}`, { message: `spike: ${path}`, content: b64(text), branch });
      return { status: r.status, message: r.message, sha: r.json?.commit?.sha };
    };
    const openPr = async (branch) => {
      const ref = await gh(token, "POST", `${at}/git/refs`, { ref: `refs/heads/${branch}`, sha: mainSha });
      const c = await commitFile(branch, `${branch}.txt`, "one\n");
      const pr = await gh(token, "POST", `${at}/pulls`, { title: branch, head: branch, base: target.branch });
      rec(4, `agent opens pull request ${branch}`, pr, { branch_status: ref.status, commit_status: c.status });
      return { number: pr.json?.number, sha: c.sha };
    };
    const merge = (t, number, sha) => gh(t, "PUT", `${at}/pulls/${number}/merge`, { merge_method: "merge", sha });
    const setStatus = (t, sha) => gh(t, "POST", `${at}/statuses/${sha}`, { state: "success", context: STATUS_CONTEXT });

    // Risk 4: can the agent's token get code onto the default branch?
    rec(4, "agent commits straight to the default branch", await commitFile(target.branch, "direct.txt", "direct\n"));
    const pr1 = await openPr("task-1");
    if (!pr1.number) return;
    rec(4, "agent merges before any status", await merge(token, pr1.number, pr1.sha));
    rec(4, "agent's token, which has no statuses permission, sets the required status", await setStatus(token, pr1.sha));
    rec(4, "provisioning App sets the status that is pinned to the merge App", await setStatus(provisionAll, pr1.sha));
    await sleep(3000);
    rec(4, "agent merges after the wrong App's status", await merge(token, pr1.number, pr1.sha));
    rec(4, "merge App sets the required status", await setStatus(mergeAll, pr1.sha));
    await sleep(3000);
    const late = await merge(token, pr1.number, pr1.sha);
    rec(4, "agent merges after the merge App's status", late);

    // Risk 6: a head that differs from the given sha, and a base that has moved.
    const pr2 = await openPr("task-2");
    if (!pr2.number) return;
    rec(6, "merge App sets the status on the first head", await setStatus(mergeAll, pr2.sha));
    const moved = await commitFile("task-2", "task-2-more.txt", "two\n");
    rec(6, "agent pushes a second commit", moved);
    if (!moved.sha) return;
    await sleep(3000);
    rec(6, "merge App merges with the old sha after a new push", await merge(mergeAll, pr2.number, pr2.sha));
    rec(6, "merge App merges the new head with no status on it", await merge(mergeAll, pr2.number, moved.sha));
    rec(6, "merge App sets the status on the new head", await setStatus(mergeAll, moved.sha));
    await sleep(3000);
    rec(6, "merge App merges the reviewed head", await merge(mergeAll, pr2.number, moved.sha), { base_had_moved: late.status === 200 });
  };
  await mergeProbes(repo, privateRules, agent.token);

  if (!privateRules && args.has("--allow-public")) {
    const pub = await createRepo("public", false);
    if (pub) {
      const publicRules = await addRuleset(pub);
      const t = await apps.provision.token(scopeFor(pub));
      if (t.token) await mergeProbes(pub, publicRules, t.token);
      else record(4, "scoped token for the public repository", { status: t.status, message: t.message });
    }
  }

  // Risk 10: can the agent push a workflow?
  const mainSha = (await gh(agent.token, "GET", `${base}/git/ref/heads/${repo.branch}`)).json?.object?.sha;
  const ref3 = await gh(agent.token, "POST", `${base}/git/refs`, { ref: "refs/heads/task-3", sha: mainSha });
  const wf = await gh(agent.token, "PUT", `${base}/contents/.github/workflows/spike.yml`, {
    message: "spike: workflow",
    branch: "task-3",
    content: b64("name: spike\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo spike\n"),
  });
  record(10, "agent pushes a workflow file without the Workflows permission", { status: wf.status, message: wf.message, branch_status: ref3.status });
  if (wf.status === 201) {
    await sleep(15000);
    const runs = await gh(provisionAll, "GET", `${base}/actions/runs`);
    record(10, "workflow runs after the push", { status: runs.status, message: runs.message, total: runs.json?.total_count });
  }

  // Risk 9: rate limits for an installation.
  const limit = await gh(provisionAll, "GET", "/rate_limit");
  record(9, "installation rate limit", { status: limit.status, core: limit.json?.resources?.core?.limit, graphql: limit.json?.resources?.graphql?.limit });

  // Risk 7: revoke one token, and time how long it keeps working.
  const doomed = await apps.provision.token(scopeFor(repo));
  if (!doomed.token) {
    record(7, "mint a token to revoke", { status: doomed.status, message: doomed.message });
  } else {
    const revoke = await gh(doomed.token, "DELETE", "/installation/token");
    let after = { status: null };
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      after = await gh(doomed.token, "GET", base);
      if (after.status === 401) break;
      await sleep(2000);
    }
    record(7, "revoke one token", {
      status: revoke.status,
      message: revoke.message,
      status_after: after.status,
      seconds_until_refused: Math.round((Date.now() - t0) / 1000),
      other_token_still_works: (await gh(agent.token, "GET", base)).status === 200,
    });
  }

  record(8, "webhooks", { status: null, message: "Not run: the Apps have webhooks off." });
}

// Can a ruleset restrict WHO updates the default branch, so that only the merge App
// merges even after the required status exists? One public repository, three
// variants in turn; each variant's rulesets are deleted before the next.
async function mergeRestriction({ org, apps, stamp, record, revoke }) {
  const RISK = "merge-restriction";
  const provisionAll = apps.provision.all;
  const mergeAll = apps.merge.all;
  const mergeAppId = apps.merge.githubAppId;
  const name = `${PREFIX}${stamp}-restrict`;
  const made = await gh(provisionAll, "POST", `/orgs/${org}/repos`, { name, private: false, auto_init: true });
  record(RISK, "create public repository", { status: made.status, message: made.message });
  if (made.status !== 201) return;
  const at = `/repos/${org}/${name}`;
  const branch = made.json.default_branch;

  let agent = null;
  for (let i = 0; i < 15 && !agent?.token; i++) {
    agent = await apps.provision.token({ repository_ids: [made.json.id], permissions: { contents: "write", pull_requests: "write" } });
    if (!agent.token) await sleep(2000);
  }
  record(RISK, "scoped agent token for the repository", { status: agent.status, message: agent.message, granted: agent.granted });
  if (!agent.token) return;
  revoke.push(agent.token);

  // The variants share one repository, so each starts and ends with a check that
  // no ruleset is left from the one before.
  const rulesetsNow = async (label) => {
    const r = await gh(provisionAll, "GET", `${at}/rulesets`);
    const names = Array.isArray(r.json) ? r.json.map((x) => x.name) : null;
    record(RISK, label, { status: r.status, message: r.message, count: names?.length ?? null, names });
    return names;
  };

  const variants = [
    {
      key: "a",
      about: "one ruleset: pull_request + required status + update, merge App bypasses",
      status: true,
      rulesets: [restrictionRuleset({ name: "podster-a", statusAppId: mergeAppId, pullRequest: true, update: true, bypassAppId: mergeAppId })],
    },
    {
      key: "b",
      about: "one ruleset: pull_request + update, no status rule, merge App bypasses",
      status: false,
      rulesets: [restrictionRuleset({ name: "podster-b", pullRequest: true, update: true, bypassAppId: mergeAppId })],
    },
    {
      key: "c",
      about: "two rulesets: pull_request + required status with no bypass; update alone, merge App bypasses",
      status: true,
      rulesets: [
        restrictionRuleset({ name: "podster-c-review", statusAppId: mergeAppId, pullRequest: true }),
        restrictionRuleset({ name: "podster-c-update", update: true, bypassAppId: mergeAppId }),
      ],
    },
  ];

  for (const v of variants) {
    const before = await rulesetsNow(`${v.key}: rulesets on the repository before this variant`);
    if (before === null || before.length > 0) {
      record(RISK, `${v.key}: skipped`, { status: null, message: "Rulesets from an earlier variant are still there, or couldn't be listed." });
      continue;
    }
    const ids = [];
    let active = true;
    for (const body of v.rulesets) {
      const r = await gh(provisionAll, "POST", `${at}/rulesets`, body);
      record(RISK, `${v.key}: create ruleset ${body.name}`, {
        status: r.status,
        message: r.message,
        errors: r.status === 201 ? undefined : r.json?.errors,
        enforcement: r.json?.enforcement,
        rule_types: body.rules.map((x) => x.type),
        bypass_actors_sent: body.bypass_actors,
        bypass_actors_returned: r.json?.bypass_actors,
        variant: v.about,
      });
      if (r.status === 201) ids.push(r.json.id);
      if (r.status !== 201 || r.json?.enforcement !== "active") active = false;
    }
    try {
      if (active) await restrictionProbes({ v, at, branch, agentToken: agent.token, mergeAll, record, RISK });
    } finally {
      for (const id of ids) {
        const del = await gh(provisionAll, "DELETE", `${at}/rulesets/${id}`);
        record(RISK, `${v.key}: delete ruleset ${id}`, { status: del.status, message: del.message });
      }
      await rulesetsNow(`${v.key}: rulesets on the repository after its deletes`);
    }
  }
}

async function restrictionProbes({ v, at, branch, agentToken, mergeAll, record, RISK }) {
  const note = { repository: "public", ruleset_active: true, variant: v.about };
  const rec = (name, r, extra = {}) => record(RISK, `${v.key}: ${name}`, { status: r.status, message: r.message, ...note, ...extra });
  const commitFile = async (token, onBranch, path) => {
    const r = await gh(token, "PUT", `${at}/contents/${path}`, { message: `spike: ${path}`, content: b64(`${path}\n`), branch: onBranch });
    return { status: r.status, message: r.message, sha: r.json?.commit?.sha };
  };
  const openPr = async (task) => {
    const head = (await gh(agentToken, "GET", `${at}/git/ref/heads/${branch}`)).json?.object?.sha;
    const ref = await gh(agentToken, "POST", `${at}/git/refs`, { ref: `refs/heads/${task}`, sha: head });
    const c = await commitFile(agentToken, task, `${task}.txt`);
    const pr = await gh(agentToken, "POST", `${at}/pulls`, { title: task, head: task, base: branch });
    rec(`agent opens pull request ${task}`, pr, { branch_status: ref.status, commit_status: c.status });
    return { number: pr.json?.number, sha: c.sha };
  };
  // A merge call on an already merged pull request answers 200 again, so every
  // attempt records whether the pull request was merged before and after it.
  const merged = async (number) => (await gh(mergeAll, "GET", `${at}/pulls/${number}`)).json?.merged ?? null;
  const merge = async (label, token, pr, extra = {}) => {
    const before = await merged(pr.number);
    const r = await gh(token, "PUT", `${at}/pulls/${pr.number}/merge`, { merge_method: "merge", sha: pr.sha });
    rec(label, r, { merged_before: before, merged_after: await merged(pr.number), ...extra });
  };

  rec("agent commits straight to the default branch", await commitFile(agentToken, branch, `direct-agent-${v.key}.txt`));

  const pr1 = await openPr(`task-${v.key}1`);
  if (!pr1.number) return;
  if (v.status) {
    const st = await gh(mergeAll, "POST", `${at}/statuses/${pr1.sha}`, { state: "success", context: STATUS_CONTEXT });
    rec("merge App sets the required status on the head", st);
    await sleep(3000);
  }
  const statusNote = { required_status_on_head: v.status ? true : "no status rule" };
  const ff = await gh(agentToken, "PATCH", `${at}/git/refs/heads/${branch}`, { sha: pr1.sha, force: false });
  rec("agent moves the default branch ref to the head (fast-forward)", ff, { ...statusNote, merged_after: await merged(pr1.number) });
  await merge("agent merges the pull request", agentToken, pr1, statusNote);
  await merge("merge App merges the pull request", mergeAll, pr1, statusNote);

  if (v.status) {
    // Does the merge App's bypass also cover the status rule in the same ruleset?
    const pr2 = await openPr(`task-${v.key}2`);
    if (pr2.number) await merge("merge App merges a pull request with no status on its head", mergeAll, pr2, { required_status_on_head: false });
  }
  rec("merge App commits straight to the default branch", await commitFile(mergeAll, branch, `direct-merge-app-${v.key}.txt`));
}

// ADR 0009's three Apps: provisioning (Administration only), agent token (Contents
// and Pull requests) and merge (Contents, Pull requests, Commit statuses). One public
// repository with variant (c)'s two rulesets, and one private repository that no token
// is scoped to, to probe reach. Probes that would damage the test if they succeeded
// (ruleset and repository deletes) run last.
async function threeApps({ org, apps, stamp, record, revoke }) {
  const RISK = "three-apps";
  const P = apps.provision.all;
  const AF = apps.agent.all;
  const mergeAppId = apps.merge.githubAppId;
  const rec = (name, r, extra = {}) =>
    record(RISK, name, { status: r.status, message: r.message, errors: r.status >= 400 ? r.json?.errors : undefined, ...extra });
  const slug = (who) => who.replace(/'s/g, "").replace(/[^a-z]+/gi, "-").toLowerCase();

  // 1. The provisioning App creates the repository and both rulesets.
  const name = `${PREFIX}${stamp}-three`;
  let made = await gh(P, "POST", `/orgs/${org}/repos`, { name, private: false, auto_init: true });
  rec("provisioning App creates a public repository with auto_init", made);
  const autoInit = made.status === 201;
  if (!autoInit) {
    made = await gh(P, "POST", `/orgs/${org}/repos`, { name, private: false, auto_init: false });
    rec("provisioning App creates a public repository without auto_init", made);
    if (made.status !== 201) return;
  }
  const at = `/repos/${org}/${name}`;
  const repoId = made.json.id;
  const branch = made.json.default_branch;
  const otherName = `${PREFIX}${stamp}-other`;
  const otherMade = await gh(P, "POST", `/orgs/${org}/repos`, { name: otherName, private: true, auto_init: true });
  rec("provisioning App creates a private repository that no token is scoped to", otherMade);
  const other = otherMade.status === 201 ? `/repos/${org}/${otherName}` : null;

  if (!autoInit) {
    const first = await gh(AF, "PUT", `${at}/contents/README.md`, { message: "spike: first commit", content: b64("spike\n") });
    rec("agent App's full token makes the first commit, since auto_init was refused", first);
  }
  const head0 = await gh(P, "GET", `${at}/git/ref/heads/${branch}`);
  rec("provisioning App reads the default branch's head (the initial commit exists)", head0, { has_commit: Boolean(head0.json?.object?.sha) });

  const bodies = [
    restrictionRuleset({ name: "podster-review", statusAppId: mergeAppId, pullRequest: true }),
    restrictionRuleset({ name: "podster-update", update: true, bypassAppId: mergeAppId }),
  ];
  const ids = [];
  let active = true;
  for (const body of bodies) {
    const r = await gh(P, "POST", `${at}/rulesets`, body);
    rec(`provisioning App creates ruleset ${body.name}`, r, {
      enforcement: r.json?.enforcement,
      rule_types: body.rules.map((x) => x.type),
      bypass_actors_sent: body.bypass_actors,
      bypass_actors_returned: r.json?.bypass_actors,
    });
    if (r.status === 201) ids.push(r.json.id);
    if (r.status !== 201 || r.json?.enforcement !== "active") active = false;
  }
  // `rulesets_active` and `required_status_on_head` in the records below are labels this
  // script sets from its own earlier calls (both creates answered 201 and active; the
  // merge App's status call ran or didn't). Neither is read back from GitHub per record.
  const note = { rulesets_active: active };

  // 5. The readiness read-back: list, then each ruleset by ID, with one token.
  const readBack = async (label, token) => {
    const list = await gh(token, "GET", `${at}/rulesets`);
    const full = [];
    const seen = [];
    for (const id of ids) {
      const r = await gh(token, "GET", `${at}/rulesets/${id}`);
      if (r.status === 200) full.push(r.json);
      seen.push({
        status: r.status,
        message: r.message,
        name: r.json?.name,
        enforcement: r.json?.enforcement,
        include: r.json?.conditions?.ref_name?.include,
        rule_types: r.json?.rules?.map((x) => x.type),
        required_status_checks: r.json?.rules?.find((x) => x.type === "required_status_checks")?.parameters?.required_status_checks,
        bypass_actors: r.json?.bypass_actors,
        current_user_can_bypass: r.json?.current_user_can_bypass,
      });
    }
    record(RISK, label, {
      status: list.status,
      message: list.message,
      listed: Array.isArray(list.json) ? list.json.map((x) => ({ name: x.name, enforcement: x.enforcement })) : null,
      rulesets: seen,
      as_expected: rulesetsAsExpected(full, mergeAppId),
    });
  };
  await readBack("read-back with the provisioning App's token, straight after creation", P);
  const effective = await gh(P, "GET", `${at}/rules/branches/${branch}`);
  rec("provisioning App reads the rules in effect on the default branch", effective, { rule_types: Array.isArray(effective.json) ? effective.json.map((x) => x.type) : null });
  const repoActions = await gh(P, "GET", `${at}/actions/permissions`);
  rec("provisioning App reads the repository's Actions setting", repoActions, { enabled: repoActions.json?.enabled });
  const orgActions = await gh(P, "GET", `/orgs/${org}/actions/permissions`);
  rec("provisioning App reads the organization's Actions setting", orgActions, { enabled_repositories: orgActions.json?.enabled_repositories });

  // Risk 11: is the new repository at once under the other two installations?
  const mintFor = async (app, scope) => {
    let t = null;
    let tries = 0;
    const t0 = Date.now();
    for (; tries < 15 && !t?.token; tries++) {
      if (tries > 0) await sleep(2000);
      t = await app.token(scope);
    }
    if (t.token) revoke.push(t.token);
    return { t, extra: { tries, seconds_until_minted: Math.round((Date.now() - t0) / 1000), granted: t.granted, expires_at: t.expires_at } };
  };
  const agentMint = await mintFor(apps.agent, { repository_ids: [repoId], permissions: { contents: "write", pull_requests: "write" } });
  rec("agent App mints a token scoped to the new repository (contents, pull requests)", agentMint.t, agentMint.extra);
  const mergeMint = await mintFor(apps.merge, { repository_ids: [repoId] });
  rec("merge App mints a token scoped to the new repository", mergeMint.t, mergeMint.extra);
  const A = agentMint.t.token;
  const M = mergeMint.t.token;
  if (!A || !M) return;
  const wider = await apps.agent.token({ repository_ids: [repoId], permissions: { administration: "write" } });
  if (wider.token) revoke.push(wider.token);
  rec("agent App is asked for a token with Administration, which it doesn't hold", wider, { token_returned: Boolean(wider.token) });

  await readBack("read-back with the agent's scoped token", A);
  await readBack("read-back with the merge App's token", M);

  const commitFile = async (token, onBranch, path) => {
    const r = await gh(token, "PUT", `${at}/contents/${path}`, { message: `spike: ${path}`, content: b64(`${path}\n`), branch: onBranch });
    return { status: r.status, message: r.message, json: r.json, sha: r.json?.commit?.sha };
  };
  const merged = async (number) => (await gh(M, "GET", `${at}/pulls/${number}`)).json?.merged ?? null;
  const tryMerge = async (label, token, pr, extra = {}) => {
    const before = await merged(pr.number);
    const r = await gh(token, "PUT", `${at}/pulls/${pr.number}/merge`, { merge_method: "merge", sha: pr.sha });
    rec(label, r, { merged_before: before, merged_after: await merged(pr.number), ...note, ...extra });
  };
  const setStatus = (token, sha) => gh(token, "POST", `${at}/statuses/${sha}`, { state: "success", context: STATUS_CONTEXT });

  // 2. The agent's scoped token does its own work.
  const ref = await gh(A, "POST", `${at}/git/refs`, { ref: "refs/heads/task-1", sha: head0.json?.object?.sha });
  rec("agent's scoped token creates a task branch", ref);
  const c1 = await commitFile(A, "task-1", "task-1.txt");
  rec("agent's scoped token commits to the task branch", c1);
  const prRes = await gh(A, "POST", `${at}/pulls`, { title: "task-1", head: "task-1", base: branch });
  rec("agent's scoped token opens a pull request", prRes);
  const pr = { number: prRes.json?.number, sha: c1.sha };
  if (!pr.number || !pr.sha) return;

  // Before the merge App's status.
  const unmarked = { required_status_on_head: false };
  await tryMerge("agent's scoped token merges before the merge App's status", A, pr, unmarked);
  await tryMerge("merge App merges an unmarked commit", M, pr, unmarked);
  rec("agent's scoped token sets the required status", await setStatus(A, pr.sha), note);
  rec("agent App's full token sets the required status", await setStatus(AF, pr.sha), note);
  rec("provisioning App sets the required status", await setStatus(P, pr.sha), note);
  rec("merge App sets the required status on the head", await setStatus(M, pr.sha), note);
  await sleep(3000);

  // After it: the agent App (scoped, then full) and the provisioning App try every path.
  const marked = { required_status_on_head: true };
  for (const [who, token] of [["agent's scoped token", A], ["agent App's full token", AF], ["provisioning App", P]]) {
    rec(`${who} commits straight to the default branch`, await commitFile(token, branch, `direct-${slug(who)}.txt`), { ...note, ...marked });
    const ff = await gh(token, "PATCH", `${at}/git/refs/heads/${branch}`, { sha: pr.sha, force: false });
    rec(`${who} moves the default branch ref to the marked head (fast-forward)`, ff, { ...note, ...marked, merged_after: await merged(pr.number) });
    await tryMerge(`${who} merges the marked pull request`, token, pr, marked);
  }
  // 4. Can the provisioning App push code anywhere?
  rec("provisioning App commits to the task branch", await commitFile(P, "task-1", "from-provisioning.txt"), note);
  const pRef = await gh(P, "POST", `${at}/git/refs`, { ref: "refs/heads/from-provisioning", sha: head0.json?.object?.sha });
  rec("provisioning App creates a branch", pRef, note);
  const pPr = await gh(P, "POST", `${at}/pulls`, { title: "from-provisioning", head: "task-1", base: branch });
  rec("provisioning App opens a pull request", pPr, note);

  // 3. The merge App merges the commit it marked.
  await tryMerge("merge App merges the marked pull request", M, pr, marked);
  rec("merge App commits straight to the default branch", await commitFile(M, branch, "direct-merge-app.txt"), note);

  // Reach and administration. Nothing here should succeed for the agent or merge Apps.
  if (other) {
    rec("agent's scoped token reads the other (private) repository", await gh(A, "GET", other));
    const w = await gh(A, "PUT", `${other}/contents/reach.txt`, { message: "spike: reach", content: b64("reach\n") });
    rec("agent's scoped token commits to the other (private) repository", w);
  }
  const others = [["agent's scoped token", A], ["agent App's full token", AF], ["merge App", M]];
  for (const [who, token] of others) {
    rec(`${who} edits repository settings`, await gh(token, "PATCH", at, { description: "spike" }));
    rec(`${who} creates a ruleset`, await gh(token, "POST", `${at}/rulesets`, restrictionRuleset({ name: `made-by-${slug(who)}`, pullRequest: true })));
    if (ids[1]) rec(`${who} edits the update ruleset`, await gh(token, "PUT", `${at}/rulesets/${ids[1]}`, bodies[1]));
    // If this were allowed, the repository would carry the prefix, so --cleanup removes it.
    rec(`${who} creates a repository in the organization`, await gh(token, "POST", `/orgs/${org}/repos`, { name: `${PREFIX}${stamp}-made-by-${slug(who)}`, private: true }));
  }
  for (const [who, token] of others) {
    if (ids[0]) rec(`${who} deletes the review ruleset`, await gh(token, "DELETE", `${at}/rulesets/${ids[0]}`));
  }
  await readBack("read-back with the provisioning App's token, after every attempt above", P);
  for (const [who, token] of others) rec(`${who} deletes the repository`, await gh(token, "DELETE", at));
  rec("the repository still exists afterwards (read with the provisioning App's token)", await gh(P, "GET", at));
}

function finish(results, stamp) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nWrote ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
