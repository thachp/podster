#!/usr/bin/env node
// M5 spike: what GitHub App tokens, branch rules and merges really do.
// Runs against a TEST organization only. Nothing builds on this file.
//
//   M5_ORG=podster-spike M5_PROVISION_APP_ID=1 M5_MERGE_APP_ID=2 node spike.mjs
//   ... node spike.mjs --allow-public   also try rules on a public repository
//   ... node spike.mjs --cleanup        delete this spike's repositories and exit
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

export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(body).sign(createPrivateKey(pem)).toString("base64url");
  return `${body}.${sig}`;
}

// The organization must look like a test one, so a typo can't point this at a real one.
export function looksLikeTestOrg(name) {
  return /(^|[-_])(spike|test|sandbox)([-_]|$)/i.test(name ?? "");
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
  const org = process.env.M5_ORG;
  const keyDir = process.env.M5_KEY_DIR ?? join(homedir(), ".podster", "m5-spike");
  const apps = {
    provision: { id: process.env.M5_PROVISION_APP_ID, pem: join(keyDir, "provision.pem") },
    merge: { id: process.env.M5_MERGE_APP_ID, pem: join(keyDir, "merge.pem") },
  };
  if (!org || !apps.provision.id || !apps.merge.id) {
    throw new Error("Set M5_ORG, M5_PROVISION_APP_ID and M5_MERGE_APP_ID.");
  }
  if (!looksLikeTestOrg(org)) {
    throw new Error(`Refusing to run: "${org}" doesn't have spike, test or sandbox in its name.`);
  }

  const results = [];
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
  }

  const provisionAll = (await apps.provision.token()).token;
  const mergeAll = (await apps.merge.token()).token;

  if (args.has("--cleanup")) {
    const list = await gh(provisionAll, "GET", "/installation/repositories?per_page=100");
    for (const repo of list.json?.repositories ?? []) {
      if (repo.owner.login !== org || !repo.name.startsWith(PREFIX)) continue;
      const del = await gh(provisionAll, "DELETE", `/repos/${org}/${repo.name}`);
      console.log(`delete ${repo.name}: ${del.status}`);
    }
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

  // Risk 1: can the App create a repository in the organization?
  const createRepo = async (suffix, isPrivate) => {
    const name = `${PREFIX}${stamp}-${suffix}`;
    const r = await gh(provisionAll, "POST", `/orgs/${org}/repos`, { name, private: isPrivate, auto_init: true });
    record(1, `create ${isPrivate ? "private" : "public"} repository ${suffix}`, { status: r.status, message: r.message });
    return r.status === 201 ? { name, id: r.json.id, branch: r.json.default_branch } : null;
  };
  const repo = await createRepo("a", true);
  const other = await createRepo("b", true);
  if (!repo || !other) return finish(results, stamp);
  const base = `/repos/${org}/${repo.name}`;

  // Risk 2: is the new repository under the installation at once?
  // Risk 3: can a token be limited to one repository and a subset of permissions?
  const agentScope = { repository_ids: [repo.id], permissions: { contents: "write", pull_requests: "write" } };
  let agent = null;
  const started = Date.now();
  for (let i = 0; i < 15 && !agent?.token; i++) {
    agent = await apps.provision.token(agentScope);
    if (!agent.token) await sleep(2000);
  }
  record(2, "scoped token for the new repository", {
    status: agent.status,
    message: agent.message,
    seconds_until_minted: Math.round((Date.now() - started) / 1000),
    expires_at: agent.expires_at,
  });
  if (!agent.token) return finish(results, stamp);
  record(3, "permissions granted on the scoped token", { granted: agent.granted });
  const reach = await gh(agent.token, "GET", `/repos/${org}/${other.name}`);
  record(3, "scoped token reads the other repository", { status: reach.status, message: reach.message });
  const admin = await gh(agent.token, "PATCH", base, { description: "spike" });
  record(3, "scoped token edits repository settings", { status: admin.status, message: admin.message });
  const wider = await apps.provision.token({ repository_ids: [repo.id], permissions: { workflows: "write" } });
  record(3, "asking for a permission the App doesn't hold", { status: wider.status, message: wider.message });

  // Risk 5: do rulesets apply to a private repository on this plan?
  const ruleset = (appId) => ({
    name: "podster-default-branch",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: STATUS_CONTEXT, integration_id: appId }] } },
    ],
  });
  const rules = await gh(provisionAll, "POST", `${base}/rulesets`, ruleset(apps.merge.githubAppId));
  record(5, "ruleset on a private repository", { status: rules.status, message: rules.message, enforcement: rules.json?.enforcement });
  const agentRules = await gh(agent.token, "POST", `${base}/rulesets`, { ...ruleset(apps.merge.githubAppId), name: "agent-made" });
  record(3, "scoped token creates a ruleset", { status: agentRules.status, message: agentRules.message });

  if (rules.status !== 201 && args.has("--allow-public")) {
    const pub = await createRepo("public", false);
    if (pub) {
      const r = await gh(provisionAll, "POST", `/repos/${org}/${pub.name}/rulesets`, ruleset(apps.merge.githubAppId));
      record(5, "ruleset on a public repository", { status: r.status, message: r.message });
    }
  }

  // Helpers that act as the agent.
  const mainSha = (await gh(agent.token, "GET", `${base}/git/ref/heads/${repo.branch}`)).json?.object?.sha;
  const commitFile = async (branch, path, text) => {
    const r = await gh(agent.token, "PUT", `${base}/contents/${path}`, { message: `spike: ${path}`, content: b64(text), branch });
    return { status: r.status, message: r.message, sha: r.json?.commit?.sha };
  };
  const openPr = async (branch) => {
    await gh(agent.token, "POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: mainSha });
    const c = await commitFile(branch, `${branch}.txt`, "one\n");
    const pr = await gh(agent.token, "POST", `${base}/pulls`, { title: branch, head: branch, base: repo.branch });
    return { number: pr.json?.number, sha: c.sha, status: pr.status, message: pr.message };
  };
  const merge = (token, number, sha) => gh(token, "PUT", `${base}/pulls/${number}/merge`, { merge_method: "merge", ...(sha ? { sha } : {}) });
  const setStatus = (token, sha) => gh(token, "POST", `${base}/statuses/${sha}`, { state: "success", context: STATUS_CONTEXT });

  // Risk 4: can the agent's token get code onto the default branch?
  const direct = await commitFile(repo.branch, "direct.txt", "pushed straight to the default branch\n");
  record(4, "agent commits straight to the default branch", { status: direct.status, message: direct.message });
  const pr1 = await openPr("task-1");
  record(4, "agent opens a pull request", { status: pr1.status, message: pr1.message });
  if (!pr1.number) return finish(results, stamp);
  const early = await merge(agent.token, pr1.number, pr1.sha);
  record(4, "agent merges before the required status", { status: early.status, message: early.message });
  const forged = await setStatus(agent.token, pr1.sha);
  record(4, "agent sets the required status itself", { status: forged.status, message: forged.message });
  const real = await setStatus(mergeAll, pr1.sha);
  record(4, "merge App sets the required status", { status: real.status, message: real.message });
  await sleep(3000);
  const late = await merge(agent.token, pr1.number, pr1.sha);
  record(4, "agent merges after the merge App's status", { status: late.status, message: late.message });

  // Risk 6: a head that differs from the given sha, and a base that has moved.
  const pr2 = await openPr("task-2");
  if (pr2.number) {
    await setStatus(mergeAll, pr2.sha);
    const moved = await commitFile("task-2", "task-2-more.txt", "two\n");
    await sleep(3000);
    const stale = await merge(mergeAll, pr2.number, pr2.sha);
    record(6, "merge App merges with the old sha after a new push", { status: stale.status, message: stale.message });
    const unreviewed = await merge(mergeAll, pr2.number, moved.sha);
    record(6, "merge App merges the new head with no status on it", { status: unreviewed.status, message: unreviewed.message });
    await setStatus(mergeAll, moved.sha);
    await sleep(3000);
    const good = await merge(mergeAll, pr2.number, moved.sha);
    record(6, "merge App merges the reviewed head", {
      status: good.status,
      message: good.message,
      base_had_moved: late.status === 200,
    });
  }

  // Risk 10: can the agent push a workflow?
  await gh(agent.token, "POST", `${base}/git/refs`, { ref: "refs/heads/task-3", sha: mainSha });
  const wf = await commitFile("task-3", ".github/workflows/spike.yml", "name: spike\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo spike\n");
  record(10, "agent pushes a workflow file without the Workflows permission", { status: wf.status, message: wf.message });
  if (wf.status === 201) {
    await sleep(15000);
    const runs = await gh(provisionAll, "GET", `${base}/actions/runs`);
    record(10, "workflow runs after the push", { status: runs.status, message: runs.message, total: runs.json?.total_count });
  }

  // Risk 9: rate limits for an installation.
  const limit = await gh(provisionAll, "GET", "/rate_limit");
  record(9, "installation rate limit", { status: limit.status, core: limit.json?.resources?.core?.limit, graphql: limit.json?.resources?.graphql?.limit });

  // Risk 7: revoke one token, and time how long it keeps working.
  const doomed = await apps.provision.token(agentScope);
  const revoke = await gh(doomed.token, "DELETE", "/installation/token");
  let after = null;
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

  record(8, "webhooks", { status: null, message: "Not run: the Apps have webhooks off." });
  finish(results, stamp);
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
