#!/usr/bin/env node
// Builds spike: do the proposed "Turning Actions on" rules in docs/spec/BUILDS.md hold
// on a real public repository in podsterdev? Nothing builds on this file.
//
//   BUILDS_ORG=podsterdev BUILDS_CONFIRM_ORG=podsterdev node spike.mjs
//   BUILDS_ORG=podsterdev BUILDS_CONFIRM_ORG=podsterdev node spike.mjs --cleanup
//
// The three staging Apps' keys are read by path from BUILDS_KEY_DIR (default
// ~/.podster/m5-staging). The person's steps go through the `gh` CLI's own login.
// Tokens, keys and signed URLs are never printed or written. Results hold status
// codes, GitHub's messages and a few fields per run or artifact.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORG, PREFIX, appJwt, eventWorkflow, locationSummary, orgAllowed, parseSpikeLines, parseTokenPermissions, probeWorkflow, scrub } from "./lib.mjs";

const API = "https://api.github.com";
const HERE = dirname(fileURLToPath(import.meta.url));
const APPS = {
  provision: { id: process.env.BUILDS_PROVISION_APP_ID ?? "5695065" },
  agent: { id: process.env.BUILDS_AGENT_APP_ID ?? "5695079" },
  merge: { id: process.env.BUILDS_MERGE_APP_ID ?? "5695088" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString("base64");

async function gh(token, method, path, body, extra = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    redirect: extra.redirect ?? "follow",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "builds-spike",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(extra.headers ?? {}),
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
  return { status: res.status, json, text, message: scrub(json?.message ?? null), headers: res.headers };
}

// The person's call, through gh's existing login. The body goes on stdin, never argv.
function person(method, path, body) {
  const args = ["api", "--include", "-X", method, path, "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (body) args.push("--input", "-");
  const r = spawnSync("gh", args, { input: body ? JSON.stringify(body) : undefined, encoding: "utf8" });
  const out = r.stdout ?? "";
  const status = Number(out.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1] ?? 0) || null;
  const bodyText = out.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = null;
  }
  return { status, json, message: scrub(json?.message ?? null) };
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => a !== "--cleanup");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(", ")}`);
  if (!orgAllowed(process.env)) {
    throw new Error(`Refusing to run: set BUILDS_ORG=${ORG} and BUILDS_CONFIRM_ORG=${ORG}.`);
  }
  const keyDir = process.env.BUILDS_KEY_DIR ?? join(homedir(), ".podster", "m5-staging");
  for (const [name, app] of Object.entries(APPS)) app.pem = join(keyDir, `${name}.pem`);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const results = [];
  const tokens = [];
  const record = (check, name, observed) => {
    const row = { check, name, ...observed };
    results.push(row);
    console.log(`[${check}] ${name}: ${JSON.stringify(observed)}`);
  };
  try {
    if (argv.includes("--cleanup")) await cleanup({ record, tokens });
    else await run({ stamp, record, tokens });
  } finally {
    const statuses = [];
    for (const t of tokens) statuses.push(await gh(t.token, "DELETE", "/installation/token").then((r) => ({ token: t.label, status: r.status }), () => ({ token: t.label, status: null })));
    if (tokens.length) record("end", "tokens revoked", { minted: tokens.length, statuses });
    const dir = join(HERE, "results");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${stamp}${argv.includes("--cleanup") ? "-cleanup" : ""}.json`);
    writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nWrote ${file}`);
  }
}

async function preflight({ record, tokens, names }) {
  for (const name of names) {
    const app = APPS[name];
    app.jwt = () => appJwt(app.id, readFileSync(app.pem, "utf8"));
    const inst = await gh(app.jwt(), "GET", `/orgs/${ORG}/installation`);
    if (inst.status !== 200) throw new Error(`${name} App isn't installed on ${ORG}: ${inst.status} ${inst.message}`);
    app.installation = inst.json.id;
    record("pre", `${name} App installation`, { status: 200, permissions: inst.json.permissions, repository_selection: inst.json.repository_selection });
    app.mint = async (label, scope) => {
      const r = await gh(app.jwt(), "POST", `/app/installations/${app.installation}/access_tokens`, scope);
      if (r.json?.token) tokens.push({ label, token: r.json.token });
      record("pre", `mint ${label}`, { status: r.status, message: r.message, granted: r.json?.permissions ?? null, repositories: r.json?.repositories?.map((x) => x.name) ?? "all" });
      return r.json?.token ?? null;
    };
  }
}

async function cleanup({ record, tokens }) {
  await preflight({ record, tokens, names: ["provision"] });
  const t = await APPS.provision.mint("provision, unscoped (cleanup)");
  if (!t) return;
  for (let page = 1; ; page++) {
    const list = await gh(t, "GET", `/installation/repositories?per_page=100&page=${page}`);
    if (list.status !== 200) throw new Error(`listing repositories: ${list.status} ${list.message}`);
    const repos = list.json.repositories ?? [];
    for (const repo of repos) {
      if (repo.owner.login.toLowerCase() !== ORG || !repo.name.startsWith(PREFIX)) continue;
      const del = await gh(t, "DELETE", `/repos/${ORG}/${repo.name}`);
      record("cleanup", `delete ${repo.name}`, { status: del.status, message: del.message });
    }
    if (repos.length < 100) break;
  }
}

async function run({ stamp, record, tokens }) {
  await preflight({ record, tokens, names: ["provision", "agent", "merge"] });

  // The repository, made by the provisioning App as provisioning does today.
  const P0 = await APPS.provision.mint("provision, unscoped (create repository)");
  const name = `${PREFIX}${stamp}`;
  const made = await gh(P0, "POST", `/orgs/${ORG}/repos`, { name, private: false, auto_init: true });
  record("setup", "create public repository", { status: made.status, message: made.message });
  if (made.status !== 201) return;
  const repoId = made.json.id;
  const main = made.json.default_branch;
  const at = `/repos/${ORG}/${name}`;
  await sleep(3000);

  const mintScoped = async (app, label, permissions) => {
    for (let i = 0; i < 10; i++) {
      const t = await APPS[app].mint(label, { repository_ids: [repoId], permissions });
      if (t) return t;
      await sleep(2000);
    }
    return null;
  };
  const P = await mintScoped("provision", "provision, repo-scoped administration:write", { administration: "write" });
  const A = await mintScoped("agent", "agent, repo-scoped contents+pull_requests write", { contents: "write", pull_requests: "write" });
  const M = await mintScoped("merge", "merge, repo-scoped actions+metadata read", { actions: "read", metadata: "read" });
  if (!P || !A || !M) return;

  // (d)+(b): repository Actions settings by the provisioning App, each read back.
  const setting = async (label, path, body) => {
    const before = await gh(P, "GET", `${at}${path}`);
    const put = await gh(P, "PUT", `${at}${path}`, body);
    const after = await gh(P, "GET", `${at}${path}`);
    record("d", label, { get_before: { status: before.status, message: before.message, body: before.status === 200 ? before.json : null }, put: { status: put.status, message: put.message, sent: body }, get_after: { status: after.status, message: after.message, body: after.status === 200 ? after.json : null } });
  };
  await setting("Actions on, allowed actions selected, sha pinning required", "/actions/permissions", { enabled: true, allowed_actions: "selected", sha_pinning_required: true });
  await setting("selected actions: GitHub-owned plus explicit list", "/actions/permissions/selected-actions", {
    github_owned_allowed: true,
    verified_allowed: false,
    patterns_allowed: ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"],
  });
  await setting("default workflow permissions read, no PR approvals", "/actions/permissions/workflow", { default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  await setting("fork PR approval: all external contributors", "/actions/permissions/fork-pr-contributor-approval", { approval_policy: "all_external_contributors" });
  await setting("artifact and log retention 30 days", "/actions/permissions/artifact-and-log-retention", { days: 30 });
  const access = await gh(P, "GET", `${at}/actions/permissions/access`);
  record("d", "workflow access from other repositories (read only)", { status: access.status, message: access.message, body: access.status === 200 ? access.json : null });

  // (b), (e), (f): the person adds workflows on the default branch.
  const files = {
    ".github/workflows/default-perms.yml": probeWorkflow({ name: "default-perms", permissions: null }),
    ".github/workflows/raised-perms.yml": probeWorkflow({ name: "raised-perms", permissions: { contents: "write" } }),
    ".github/workflows/dispatch.yml": eventWorkflow({ name: "dispatch", on: "  repository_dispatch:\n    types: [spike]" }),
    ".github/workflows/tag-push.yml": eventWorkflow({ name: "tag-push", on: "  push:\n    tags: [\"spike-*\"]" }),
    ".github/workflows/release.yml": eventWorkflow({ name: "release", on: "  release:\n    types: [published, created]" }),
  };
  for (const [path, content] of Object.entries(files)) {
    const r = person("PUT", `repos/${ORG}/${name}/contents/${path}`, { message: `person adds ${path}`, content: b64(content), branch: main });
    record("b", `person adds ${path} on ${main}`, { status: r.status, message: r.message });
  }
  const head = (await gh(A, "GET", `${at}/git/ref/heads/${main}`)).json?.object?.sha;

  // (a): the agent can't add or change workflows on its task branch.
  const branch = `podster/tsk_spike${stamp}`;
  const mk = await gh(A, "POST", `${at}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  record("a", "agent creates task branch", { status: mk.status, message: mk.message });
  const newWf = await gh(A, "PUT", `${at}/contents/.github/workflows/x.yml`, { message: "agent adds a workflow", content: b64(eventWorkflow({ name: "x", on: "  push:" })), branch });
  record("a", "agent creates .github/workflows/x.yml (contents API)", { status: newWf.status, message: newWf.message });
  const existing = await gh(A, "GET", `${at}/contents/.github/workflows/default-perms.yml?ref=${encodeURIComponent(branch)}`);
  const modWf = await gh(A, "PUT", `${at}/contents/.github/workflows/default-perms.yml`, { message: "agent changes a workflow", content: b64(`${files[".github/workflows/default-perms.yml"]}# changed\n`), sha: existing.json?.sha, branch });
  record("a", "agent modifies .github/workflows/default-perms.yml (contents API)", { status: modWf.status, message: modWf.message });
  gitChecks({ name, branch, token: A, record });

  // (e): repository_dispatch with the agent's token.
  const disp = await gh(A, "POST", `${at}/dispatches`, { event_type: "spike" });
  record("e", "agent POST /dispatches", { status: disp.status, message: disp.message });

  // (f): a tag and a release with the agent's token.
  const tag = await gh(A, "POST", `${at}/git/refs`, { ref: "refs/tags/spike-tag1", sha: head });
  record("f", "agent creates tag spike-tag1 (git refs)", { status: tag.status, message: tag.message });
  const rel = await gh(A, "POST", `${at}/releases`, { tag_name: "spike-rel1", target_commitish: main, name: "spike", body: "spike" });
  record("f", "agent creates release spike-rel1", { status: rel.status, message: rel.message });

  // Builds read path: the merge App's actions:read token.
  const runs = await waitForRuns({ M, at, record });
  await readPath({ M, at, runs, record });
}

// (a) by git push over HTTPS. The token goes in through GIT_CONFIG_* env, never argv or a URL.
// The child gets an isolated environment: no system or global git config, no credential helper.
function gitChecks({ name, branch, token, record }) {
  const scratch = process.env.BUILDS_SCRATCH ?? join(HERE, "work");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "clone-"));
  const home = mkdtempSync(join(scratch, "home-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "builds-spike",
    GIT_AUTHOR_EMAIL: "builds-spike@example.invalid",
    GIT_COMMITTER_NAME: "builds-spike",
    GIT_COMMITTER_EMAIL: "builds-spike@example.invalid",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${b64(`x-access-token:${token}`)}`,
  };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    return { code: r.status, stderr: scrub((r.stderr ?? "").trim()).split("\n").filter((l) => /remote:|error|rejected|refusing|denied|fatal|->/.test(l)).slice(0, 8) };
  };
  try {
    const clone = git("clone", "--quiet", "--branch", branch, `https://github.com/${ORG}/${name}.git`, ".");
    record("a", "git clone of task branch", { exit: clone.code, stderr: clone.stderr });
    if (clone.code !== 0) return;
    const attempt = (label, edit) => {
      git("reset", "--quiet", "--hard", `origin/${branch}`);
      edit();
      git("add", "-A");
      git("commit", "--quiet", "-m", label);
      const push = git("push", "origin", `HEAD:refs/heads/${branch}`);
      record("a", label, { exit: push.code, stderr: push.stderr });
    };
    attempt("git push adding .github/workflows/y.yml", () => writeFileSync(join(dir, ".github/workflows/y.yml"), eventWorkflow({ name: "y", on: "  push:" })));
    attempt("git push modifying .github/workflows/default-perms.yml", () => writeFileSync(join(dir, ".github/workflows/default-perms.yml"), `${readFileSync(join(dir, ".github/workflows/default-perms.yml"), "utf8")}# changed\n`));
    attempt("git push of a normal code change (control; triggers runs)", () => writeFileSync(join(dir, "change.txt"), "a normal code change\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function waitForRuns({ M, at, record }) {
  let runs = [];
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 1000) {
    await sleep(15000);
    const r = await gh(M, "GET", `${at}/actions/runs?per_page=100`);
    if (r.status !== 200) {
      record("read", "list runs while waiting", { status: r.status, message: r.message });
      return [];
    }
    runs = r.json.workflow_runs ?? [];
    const busy = runs.filter((x) => x.status !== "completed");
    console.log(`  waiting: ${runs.length} runs, ${busy.length} not completed`);
    if (runs.length > 0 && busy.length === 0 && Date.now() - started > 90000) break;
  }
  record("read", "list workflow runs (merge App, actions:read)", {
    seconds_waited: Math.round((Date.now() - started) / 1000),
    runs: runs.map((x) => ({ id: x.id, name: x.name, event: x.event, head_branch: x.head_branch, head_sha: x.head_sha, status: x.status, conclusion: x.conclusion })),
  });
  return runs;
}

async function readPath({ M, at, runs, record }) {
  for (const run of runs) {
    // Billing: GitHub's own timing for the run.
    const timing = await gh(M, "GET", `${at}/actions/runs/${run.id}/timing`);
    const jobs = await gh(M, "GET", `${at}/actions/runs/${run.id}/jobs`);
    const out = { run: run.id, name: run.name, event: run.event, head_branch: run.head_branch, conclusion: run.conclusion, timing: { status: timing.status, billable: timing.json?.billable ?? null, message: timing.message } };
    out.jobs = [];
    for (const job of jobs.json?.jobs ?? []) {
      const j = { labels: job.labels, runner_group_name: job.runner_group_name, conclusion: job.conclusion };
      const loc = await gh(M, "GET", `${at}/actions/jobs/${job.id}/logs`, null, { redirect: "manual" });
      j.logs = { status: loc.status, location: locationSummary(loc.headers.get("location")) };
      const href = loc.headers.get("location");
      if (href) {
        const text = await fetch(href).then((r) => r.text(), () => "");
        j.token_permissions = parseTokenPermissions(text);
        j.spike = parseSpikeLines(text);
      }
      out.jobs.push(j);
    }
    const arts = await gh(M, "GET", `${at}/actions/runs/${run.id}/artifacts`);
    out.artifacts = { status: arts.status, message: arts.message, items: [] };
    for (const a of arts.json?.artifacts ?? []) {
      const zip = await gh(M, "GET", `${at}/actions/artifacts/${a.id}/zip`, null, { redirect: "manual" });
      out.artifacts.items.push({
        name: a.name,
        size_in_bytes: a.size_in_bytes,
        has_digest_field: Object.hasOwn(a, "digest"),
        digest_form: typeof a.digest === "string" ? a.digest.replace(/[0-9a-f]{64}$/, "<64 hex>") : a.digest ?? null,
        expires_at: a.expires_at,
        workflow_run_head_branch: a.workflow_run?.head_branch ?? null,
        workflow_run_head_sha: a.workflow_run?.head_sha ?? null,
        zip: { status: zip.status, message: zip.message, location: locationSummary(zip.headers.get("location")) },
      });
    }
    record("read", `run ${run.name} (${run.event}, ${run.head_branch})`, out);
  }

  // Conditional requests: does a 304 cost rate limit?
  const rl = (r) => ({ status: r.status, remaining: r.headers.get("x-ratelimit-remaining"), used: r.headers.get("x-ratelimit-used"), resource: r.headers.get("x-ratelimit-resource") });
  const first = await gh(M, "GET", `${at}/actions/runs?per_page=100`);
  const etag = first.headers.get("etag");
  const second = await gh(M, "GET", `${at}/actions/runs?per_page=100`, null, { headers: { "if-none-match": etag } });
  const third = await gh(M, "GET", `${at}/actions/runs?per_page=100`);
  const fourth = await gh(M, "GET", `${at}/actions/runs?per_page=100`, null, { headers: { "if-none-match": third.headers.get("etag") } });
  const after = await gh(M, "GET", `/rate_limit`);
  record("read", "list runs with If-None-Match", { etag_present: Boolean(etag), plain: rl(first), conditional: rl(second), plain_again: rl(third), conditional_again: rl(fourth), rate_limit_endpoint_core_remaining: after.json?.resources?.core?.remaining ?? null });
}

main().catch((e) => {
  console.error(scrub(String(e?.message ?? e)));
  process.exit(1);
});
