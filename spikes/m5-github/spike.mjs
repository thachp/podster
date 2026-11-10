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
  const s = name ?? "";
  return /^[A-Za-z0-9-]+$/.test(s) && /(^|-)(spike|test|sandbox)(-|$)/i.test(s);
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
  // The owner can name an organization that doesn't look like a test one, by repeating it exactly.
  const confirmed = /^[A-Za-z0-9-]+$/.test(org) && process.env.M5_CONFIRM_ORG === org;
  if (!looksLikeTestOrg(org) && !confirmed) {
    throw new Error(`Refusing to run: "${org}" isn't a plain name with spike, test or sandbox in it.`);
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const results = [];
  const broad = [];
  try {
    await run({ args, org, apps, stamp, results, broad });
  } finally {
    // Broad tokens live for an hour unless revoked.
    for (const token of broad) await gh(token, "DELETE", "/installation/token").catch(() => {});
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
        const del = await gh(provisionAll, "DELETE", `/repos/${org}/${repo.name}`);
        console.log(`delete ${repo.name}: ${del.status}`);
      }
      if (repos.length < 100) break;
    }
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
