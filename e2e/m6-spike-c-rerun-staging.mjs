// M6's spike C rerun on the real content domain (docs/m6-plan.md, "Spike C rerun on podster.site, 2026-11-24"). Spike
// C first ran on 2026-11-12 on another domain, behind its own test Worker. This shows its header and cookie checks on
// podster.site, against two sibling static apps the real content Worker serves, released by staging's real release path:
//
// - the certificate's shape: one wildcard certificate for every first-level host, none deeper;
// - the content Worker's answers: the fixed headers and the sandbox, no cookie set, a request's cookies and
//   Authorization ignored, a service worker's script refused, plain HTTP sent to HTTPS, an unknown host not found;
// - in Playwright's own Chromium, Firefox and WebKit, headless: a page on an app's host can't read, set or receive a
//   podster.dev cookie; sibling hosts can't read or set each other's cookies; no storage and no service worker; and an
//   ordinary static app's module script, fetch, CSS, image and history work under the sandbox.
//
//   node m6-spike-c-rerun-staging.mjs --base-url https://gateway-staging.podster.dev [--out FILE] [--dry-run]
//
// It deploys nothing and changes no cloud resource. Every app it serves is staging's release path's own.
//
// People: 3 takes of staging's test sign-up, of its 6 a minute and 40 a day: the rooms' owner, their admin, and a member
// with the deploy grant. None is sent twice, and none is sent after a 429, whose Retry-After it prints. One agent, made
// under the owner, takes none.
//
// GitHub: two public repositories in podsterdev, made by Podster, one for each room. Their files are the probe site
// below: plain files with nothing of Podster's in them. What the page is to try is given in the address's fragment,
// which is never sent to a server.
//
// Browsers and git get the allow-listed environment from child-env.mjs. Output carries statuses, error names and
// reason codes; no person ID, host label, cookie value or token. The results file names hosts as A and B.
//
// Clean-up, on every way out, Ctrl-C included: release switched off in both rooms (which unpublishes), each host
// checked not found, both rooms made private, every grant taken back, the agent disconnected, every session signed
// out. Left behind: the test people, the organization, the rooms and their tasks, and the two repositories, which it
// prints for the owner to delete.
//
// Exit 0 when both apps were served and every check ran; 1 when a check didn't hold or couldn't run; 2 for a refused
// configuration or a failed preflight, with no sign-up taken.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:tls";

const STAGING = "https://gateway-staging.podster.dev";
const USAGE = `Usage: node m6-spike-c-rerun-staging.mjs --base-url ${STAGING} [--out FILE] [--dry-run]

Spike C's header and cookie checks on podster.site, against two sibling static apps staging's release path serves.
Takes 3 test sign-ups (PODSTER_E2E_SIGNUP_SECRET), makes two public podsterdev repositories, and switches release off
in both rooms before it ends. --out writes the results, hosts named A and B, as JSON. --dry-run sends nothing.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const opt = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const known = new Set(["--base-url", "--out", "--dry-run"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i])) {
    console.error(`unknown argument ${argv[i]}\n\n${USAGE}`);
    process.exit(2);
  }
  if (argv[i] !== "--dry-run") i++;
}
if (opt("--base-url") !== STAGING) {
  console.error(`--base-url must be ${STAGING}\n\n${USAGE}`);
  process.exit(2);
}
const outFile = opt("--out");

const { childEnv } = await import("./child-env.mjs");
const { ASKPASS_SCRIPT, gitEnv } = await import("./m5-staging-lib.mjs");
const { CONTENT_DOMAIN, contentNotFoundProblem, DEPLOY_GRANT, defaultHostProblem, fixedHeaderProblems, markerProblem, MARKER_PATH, scrub, secretProblem, SETTLED, STAGING_ORG, unknownLabel } = await import("./m6-release-staging-lib.mjs");
const { RoomPublisher } = await import("./room-publisher.mjs");

const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
const SIGN_UP_COUNT = 3;
console.log(`Spike C's rerun on ${CONTENT_DOMAIN}, against ${STAGING}. Sign-ups it takes: ${SIGN_UP_COUNT}.`);
if (argv.includes("--dry-run")) {
  console.log("Dry run: nothing was sent.");
  process.exit(0);
}
{
  const problem = secretProblem(signupSecret);
  if (problem) {
    console.error(`Refused: ${problem}. Nothing was sent.`);
    process.exit(2);
  }
}
const { eq, key, McpAgent, ok, Person, sleep, Target } = await import("./lib.mjs");

const POLL_MS = 3000;
const WAIT = { setup: 300, merge: 300, release: 300, takedown: 180 };
const secrets = [signupSecret];
const secret = (value) => {
  if (typeof value === "string" && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
  return value;
};
/** Prints a line with every credential scrubbed and each app's host named A or B, never by its label. */
const masked = (text) => Object.entries(hosts).reduce((t, [name, host]) => t.replaceAll(host, `<${name}>`).replaceAll(host.split(".")[0], `<${name} label>`), text);
const say = (line = "") => console.log(masked(scrub(line, secrets)));
const target = new Target(STAGING, { pollMs: POLL_MS });
const RUN = `Spike C rerun ${new Date().toISOString().slice(0, 16)}`;
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping at the next request; clean-up follows.");
});
const cause = (error) => [error?.code, error?.message].filter(Boolean).join(" ") || String(error);
async function within(seconds, what, read, done) {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return { value, seconds: Math.round((Date.now() - start) / 100) / 10 };
    ok(Date.now() - start < seconds * 1000, `${what} didn't happen within ${seconds} s`);
    ok(!stopping, "stopped by a signal");
    await sleep(POLL_MS);
  }
}

// ---- the probe site, the same in both rooms ----

const PROBE_JS = `// What a page on this host may do. Each step reports its value or its error's name; nothing leaves the page.
const out = { violations: [] };
document.addEventListener("securitypolicyviolation", (e) => out.violations.push(e.effectiveDirective));
const ask = new URLSearchParams(location.hash.slice(1));
const names = () => document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).sort();
const step = async (name, fn) => {
  try {
    out[name] = { ok: true, value: await fn() };
  } catch (e) {
    out[name] = { ok: false, error: (e && e.name) || String(e) };
  }
};
const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
await step("origin", () => self.origin);
await step("cookieRead", () => names());
await step("cookieSetOwnHost", () => { document.cookie = "probe_own=1; path=/; secure"; return names(); });
await step("cookieSetContentDomain", () => { document.cookie = "probe_sib=1; domain=" + ask.get("site") + "; path=/; secure"; return names(); });
await step("cookieSetPodsterDomain", () => { document.cookie = "probe_pd=1; domain=" + ask.get("app") + "; path=/; secure"; return names(); });
await step("localStorage", () => { localStorage.setItem("probe", "1"); return localStorage.length; });
await step("sessionStorage", () => { sessionStorage.setItem("probe", "1"); return sessionStorage.length; });
await step("indexedDB", () => within(5000, new Promise((ok, no) => { const r = indexedDB.open("probe"); r.onsuccess = () => ok(true); r.onerror = () => no(r.error); })));
await step("cacheApi", async () => { const c = await caches.open("probe"); await c.put("/cached", new Response("x")); return (await caches.keys()).length; });
await step("serviceWorker", async () => {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return "navigator.serviceWorker absent";
  const r = await within(8000, navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  return r.scope;
});
await step("fetchOwnJson", async () => (await (await fetch("/data.json")).json()).items.length);
await step("fetchApplication", async () => (await within(8000, fetch(ask.get("api"), { credentials: "include" }))).status);
await step("style", () => getComputedStyle(document.querySelector("h1")).color);
await step("image", () => new Promise((ok) => { const i = document.getElementById("logo"); i.complete ? ok(i.naturalWidth > 0) : ((i.onload = () => ok(true)), (i.onerror = () => ok(false))); }));
await step("history", () => { history.replaceState({}, "", "/?step=1"); return location.search; });
await new Promise((done) => setTimeout(done, 500));
document.getElementById("result").textContent = JSON.stringify(out);
document.getElementById("status").textContent = "done";
`;
const PROBE_SITE = {
  "site/index.html": `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Probe</title><link rel="stylesheet" href="/style.css"></head>\n<body><h1>Probe</h1><p id="status">loading</p><pre id="result"></pre><img id="logo" alt="" src="/logo.svg" width="16" height="16">\n<script type="module" src="/probe.js"></script></body></html>\n`,
  "site/probe.js": PROBE_JS,
  "site/style.css": "h1 { color: rgb(0, 128, 0); }\n",
  "site/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>\n`,
  "site/data.json": `{ "items": [1, 2, 3] }\n`,
  "site/sw.js": "self.addEventListener(\"fetch\", () => {});\n",
};

// ---- people, the agent, GitHub and git ----

const sessions = [];
let signUps = 0;
let signUpBlocked = null;
async function person(label) {
  ok(!signUpBlocked, `the test sign-up for ${label} wasn't asked for: ${signUpBlocked}`);
  ok(signUps < SIGN_UP_COUNT, "the run's sign-ups are spent");
  signUps++;
  let res;
  try {
    res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}` }, retry: false });
  } catch (error) {
    signUpBlocked = "an earlier sign-up's outcome is unknown";
    throw new Error(`the test sign-up for ${label} failed in transport (${cause(error)})`);
  }
  if (res.status === 429) {
    signUpBlocked = `a sign-up answered 429, Retry-After ${res.headers.get("retry-after") ?? "absent"}`;
    throw new Error(`the test sign-up for ${label} answered 429, Retry-After ${res.headers.get("retry-after") ?? "absent"}. Not asked again; the limit is not changed`);
  }
  ok(res.status === 200, `the test sign-up for ${label} answered ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  for (const value of [cookie, ...cookie.split("; ").map((p) => p.slice(p.indexOf("=") + 1))]) secret(value);
  sessions.push(cookie);
  return Person.fromCookie(target, label, cookie);
}
const agents = [];
async function agentOf(linker, label) {
  const agent = await McpAgent.connect(target, linker, `${RUN} ${label}`);
  agents.push({ agent, linker });
  const keep = (held) => {
    secret(held?.access_token);
    secret(held?.refresh_token);
  };
  keep(agent.provider?.tokens?.());
  const save = agent.provider?.saveTokens;
  if (typeof save === "function") agent.provider.saveTokens = (held) => (keep(held), save(held));
  return agent;
}
async function github(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    redirect: "manual",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "e2e-check", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Only the status is used.
  }
  return { status: res.status, body: json };
}
const work = mkdtempSync(join(tmpdir(), "podster-spike-c-rerun-"));
const askpass = join(work, "askpass.sh");
writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
chmodSync(askpass, 0o700);
function git(args, { cwd = work, credential } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false", ...args], { cwd, env: gitEnv({ home: work, askpass, credential }), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", () => (clearTimeout(timer), resolve({ code: -1, stdout: "", stderr: "spawn_failed" })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code: code ?? -1, stdout, stderr: scrub(stderr, secrets) })));
  });
}
async function mustGit(args, opts, label) {
  const done = await git(args, opts);
  ok(done.code === 0, `${label}: git exited ${done.code}: ${done.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`);
  return done;
}

// ---- the run's state ----

let owner, admin, member, coder, team;
/** The two apps' default hosts, named A and B in everything the run prints or writes. */
const hosts = {};
const rooms = [];
const repos = [];
const grants = new Map();
const releaseOn = new Set();
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });

async function give(principal, action, room) {
  const answer = await owner.dash("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action });
  if (answer.body?.id) grants.set(answer.body.id, room);
  ok(answer.ok, `giving a ${action} grant: HTTP ${answer.status} ${answer.code ?? ""}`);
}

/** One room, from nothing to its app served. Answers its default host. */
async function serveRoom(name) {
  ok(!stopping, "stopped by a signal");
  const room = await owner.createRoom(`${RUN} ${name}`);
  rooms.push(room);
  for (const [who, role] of [[admin, "admin"], [member, "member"]]) await owner.must("POST", `/v1/workspaces/${room}/members`, { principal_id: who.id, kind: "person", org_id: team, role, policy_version: await owner.policyVersion(room) });
  await owner.addAgent(room, coder);
  const repoName = `e2e-spikec-${name}-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}-${randomBytes(2).toString("hex")}`;
  repos.push(`${STAGING_ORG}/${repoName}`);
  const asked = await owner.dash("POST", `/v1/workspaces/${room}/repository`, { name: repoName, visibility: "public" });
  ok(asked.ok, `asking for room ${name}'s repository: HTTP ${asked.status} ${asked.code ?? ""}`);
  const { value: read } = await within(WAIT.setup, "the repository's setup", () => owner.must("GET", `/v1/workspaces/${room}/repository`), (r) => r.request?.state !== "pending");
  eq([read.request.state, read.repository?.status], ["ready", "ready"], `room ${name}'s repository`);
  const repo = { full: read.repository.full_name, defaultBranch: read.repository.default_branch };
  await give(coder, "push", room);
  await give(admin, "merge", room);

  // The coder's change: the probe site, merged by the admin.
  const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} ${name}`, instructions: "Add the site.", acceptance_criteria: "A pull request.", assignee: coder.id, reviewer: admin.id }, { idempotencyKey: key() });
  const at = { workspace_id: room, task_id: made.id };
  const accepted = await coder.must("accept_task", { ...at, version: made.version });
  const access = await coder.must("get_repo_access", at, false);
  const token = secret(access.token);
  const dir = join(work, name);
  await mustGit(["clone", "-q", `https://github.com/${repo.full}.git`, dir], {}, "git clone");
  await mustGit(["checkout", "-q", "-b", "e2e/site"], { cwd: dir }, "git checkout");
  for (const [path, content] of Object.entries(PROBE_SITE)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  await mustGit(["add", "--", ...Object.keys(PROBE_SITE)], { cwd: dir }, "git add");
  await mustGit(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "e2e: probe site"], { cwd: dir }, "git commit");
  const head = (await mustGit(["rev-parse", "HEAD"], { cwd: dir }, "git rev-parse")).stdout.trim();
  await mustGit(["push", "-q", "origin", "e2e/site"], { cwd: dir, credential: token }, "git push");
  const pr = await github(`/repos/${repo.full}/pulls`, { token, method: "POST", body: { title: "e2e: probe site", head: "e2e/site", base: repo.defaultBranch } });
  eq(pr.status, 201, "opening the pull request");
  await coder.must("submit_task", { ...at, version: accepted.version, note: "Ready.", commit_sha: head, pr_number: pr.body.number });
  await admin.must("POST", `/v1/workspaces/${room}/tasks/${made.id}/verify`, { submission_no: 1, commit_sha: head });
  await admin.must("POST", `/v1/workspaces/${room}/tasks/${made.id}/merge`, { submission_no: 1, commit_sha: head });
  const { value: change } = await within(WAIT.merge, "the merge", async () => (await owner.must("GET", `/v1/workspaces/${room}/tasks/${made.id}`)).change, (c) => ["succeeded", "failed", "outcome_unknown"].includes(c?.merge_state));
  eq(change.merge_state, "succeeded", "the merge");

  // Public, release on, asked for by the member, approved by the admin.
  await owner.must("PUT", `/v1/workspaces/${room}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(room) });
  const published = await publisher.publish(owner, room);
  ok(published.ok, `making room ${name} public: HTTP ${published.status} ${published.code ?? ""}`);
  releaseOn.add(room);
  const on = await admin.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 });
  ok(on.ok, `switching release on in room ${name}: HTTP ${on.status} ${on.code ?? ""}`);
  // A deploy grant needs a public room.
  await give(member, DEPLOY_GRANT.action, room);
  const release = await member.must("POST", `/v1/workspaces/${room}/releases`, { task_id: made.id, commit_sha: change.merge_sha }, { idempotencyKey: key() });
  await admin.must("POST", `/v1/workspaces/${room}/releases/${release.id}/approve`, {});
  const { value: status, seconds } = await within(WAIT.release, "the release settling", () => owner.must("GET", `/v1/workspaces/${room}/tasks/${made.id}/release-status`), (s) => s.release?.release_id === release.id && SETTLED.includes(s.release?.state));
  eq(status.release.state, "served", `room ${name}'s release`);
  const host = (await owner.must("GET", `/v1/workspaces/${room}/release-config`)).default_host;
  ok(!defaultHostProblem(host).problem, `room ${name}'s host: ${defaultHostProblem(host).problem}`);
  const { seconds: markerSeconds } = await within(WAIT.takedown, "the marker", () => hostGet(`https://${host}${MARKER_PATH}`), (a) => markerProblem(a, release.id, change.merge_sha) === null);
  say(`     room ${name}: served after ${seconds} s; marker named it ${markerSeconds} s later`);
  return host;
}

// ---- what is checked ----

async function hostGet(url, { method = "GET", headers = {}, redirect = "manual" } = {}) {
  const res = await fetch(url, { method, redirect, headers: { "cache-control": "no-cache", ...headers }, signal: AbortSignal.timeout(30_000) });
  const body = method === "HEAD" ? "" : await res.text();
  return { status: res.status, headers: [...res.headers], setCookies: res.headers.getSetCookie(), body };
}
const header = (answer, name) => new Headers(answer.headers).get(name);

function certOf(host) {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ authorized: s.authorized, error: s.authorizationError ?? null, issuer: c?.issuer?.O ?? null, subjectAltNames: c?.subjectaltname ?? null, validFrom: c?.valid_from ?? null, validTo: c?.valid_to ?? null });
      s.end();
    });
    s.on("error", (e) => resolve({ authorized: false, error: e.code ?? e.message }));
    s.on("timeout", () => (s.destroy(), resolve({ authorized: false, error: "timeout" })));
  });
}

async function certificateChecks(hosts) {
  const named = { A: hosts.A, "an unknown first-level host": `${unknownLabel(randomBytes(26))}.${CONTENT_DOMAIN}`, "a second-level host": `x.${hosts.A}`, "the apex": CONTENT_DOMAIN };
  const out = {};
  for (const [name, host] of Object.entries(named)) out[name] = await certOf(host);
  return out;
}

async function headerChecks(hosts) {
  const out = {};
  for (const [name, host] of Object.entries(hosts)) {
    const index = await hostGet(`https://${host}/`);
    out[`${name} index`] = { status: index.status, problems: fixedHeaderProblems(index.headers), csp: header(index, "content-security-policy"), acao: header(index, "access-control-allow-origin"), cacheControl: header(index, "cache-control"), setCookies: index.setCookies.length };
  }
  const A = hosts.A;
  const plain = await hostGet(`https://${A}/`);
  const carried = await hostGet(`https://${A}/`, { headers: { cookie: `__Secure-better-auth.session_token=${randomBytes(12).toString("hex")}; podster-org=org_x`, authorization: `Bearer ${randomBytes(24).toString("hex")}` } });
  out["credentials ignored"] = { same: plain.status === carried.status && plain.body === carried.body, status: carried.status, setCookies: carried.setCookies.length };
  const sw = await hostGet(`https://${A}/sw.js`, { headers: { "service-worker": "script" } });
  out["service-worker script"] = { status: sw.status, body: sw.body.trim() };
  out["sw.js without the header"] = { status: (await hostGet(`https://${A}/sw.js`)).status };
  out.POST = { status: (await hostGet(`https://${A}/`, { method: "POST" })).status };
  const http = await hostGet(`http://${A}/probe.js`);
  out["plain HTTP"] = { status: http.status, location: header(http, "location") ?? null };
  const unknown = await hostGet(`https://${unknownLabel(randomBytes(26))}.${CONTENT_DOMAIN}/`);
  out["unknown host"] = { status: unknown.status, notFoundProblem: contentNotFoundProblem(unknown), clearSiteData: header(unknown, "clear-site-data") };
  return out;
}

async function browserChecks(browserName, hosts, playwright) {
  const browser = await playwright[browserName].launch({ env: childEnv() });
  try {
    const context = await browser.newContext();
    // Seeded into the browser's own jar and never sent anywhere else: one for podster.dev, and one for the whole content
    // domain, as an app's cookie for its parent domain would be if one could ever be set.
    await context.addCookies([
      { name: "e2e_pd", value: randomBytes(8).toString("hex"), domain: ".podster.dev", path: "/", secure: true, sameSite: "Lax" },
      { name: "e2e_site", value: randomBytes(8).toString("hex"), domain: `.${CONTENT_DOMAIN}`, path: "/", secure: true, sameSite: "Lax" },
    ]);
    const sent = {};
    const pages = {};
    const fragment = new URLSearchParams({ site: CONTENT_DOMAIN, app: "podster.dev", api: `${STAGING}/api/v1/me` }).toString();
    for (const [name, host] of Object.entries(hosts)) {
      const page = await context.newPage();
      const seen = (sent[name] = new Set());
      page.on("request", async (request) => {
        if (new URL(request.url()).hostname !== host) return;
        const all = await request.allHeaders().catch(() => ({}));
        for (const pair of String(all.cookie ?? "").split(";")) if (pair.trim()) seen.add(pair.trim().split("=")[0]);
        if (!("cookie" in all)) seen.add("(no cookie header)");
      });
      const loaded = await page.goto(`https://${host}/#${fragment}`, { waitUntil: "load", timeout: 60_000 });
      const done = await page.locator("#status", { hasText: "done" }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
      const text = done ? await page.locator("#result").textContent() : null;
      pages[name] = { status: loaded?.status() ?? null, ran: done, result: text ? JSON.parse(text) : null };
    }
    // After A and B both tried: what the jar holds, by name and domain only.
    const jar = (await context.cookies()).map((c) => `${c.name}@${c.domain}`).sort();
    const workers = browserName === "chromium" ? context.serviceWorkers().length : null;
    await context.close();
    return { pages, cookieNamesSentToHost: Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, [...v].sort()])), jarAfter: jar, chromiumServiceWorkers: workers };
  } finally {
    await browser.close().catch(() => null);
  }
}

// ---- the run ----

const results = { at: new Date().toISOString(), contentDomain: CONTENT_DOMAIN };
async function main() {
  // Signed out first: an unknown host is the content Worker's not found, so the real Worker is on the domain.
  const unknown = await hostGet(`https://${unknownLabel(randomBytes(26))}.${CONTENT_DOMAIN}/`);
  const problem = contentNotFoundProblem(unknown);
  if (problem) throw Object.assign(new Error(`an unknown host on ${CONTENT_DOMAIN} wasn't the content Worker's not found: ${problem}`), { preflight: true });

  say("\n## people, the agent and two rooms");
  owner = await person("the rooms' owner");
  await owner.useNewOrg(`${RUN} team`);
  team = owner.org;
  admin = await person("the rooms' admin");
  member = await person("a member with the deploy grant");
  for (const who of [admin, member]) {
    const invited = await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" });
    await who.must("POST", "/org-invitations/accept", { token: secret(invited.token) });
    who.org = who.actingOrg = team;
  }
  coder = await agentOf(owner, "coder");
  hosts.A = await serveRoom("a");
  hosts.B = await serveRoom("b");
  ok(hosts.A !== hosts.B, "the two rooms share a host");
  say("     hosts A and B are both served");

  say("\n## the certificate");
  results.certificate = await certificateChecks(hosts);
  say(JSON.stringify(results.certificate));
  say("\n## the content Worker's answers");
  results.headers = await headerChecks(hosts);
  say(JSON.stringify(results.headers));
  const playwright = await import("playwright");
  results.browsers = {};
  for (const name of ["chromium", "firefox", "webkit"]) {
    say(`\n## ${name}`);
    try {
      results.browsers[name] = await browserChecks(name, hosts, playwright);
    } catch (error) {
      results.browsers[name] = { error: cause(error) };
    }
    say(JSON.stringify(results.browsers[name]));
  }
}

async function cleanUp() {
  const said = [];
  for (const room of [...releaseOn]) {
    const config = await admin.dash("GET", `/v1/workspaces/${room}/release-config`).catch(() => null);
    const off = config?.ok && config.body?.enabled ? await admin.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.body.version }).catch(() => null) : config;
    if (off?.ok && off.body?.enabled === false) releaseOn.delete(room);
    const host = config?.body?.default_host;
    let down = "not checked";
    if (!releaseOn.has(room) && host) {
      down = await within(WAIT.takedown, "the host stopping", () => hostGet(`https://${host}/`), (a) => contentNotFoundProblem(a) === null).then(({ seconds }) => `not found after ${seconds} s`, (e) => `NOT shown not found: ${cause(e)}`);
    }
    said.push(!releaseOn.has(room) ? `release is off in room ${room}; its host is ${down}` : `release could NOT be switched off in room ${room}`);
  }
  const { left } = await publisher.stop();
  said.push(left ? "a room could NOT be made private again" : `rooms ${rooms.join(" and ")} are private`);
  for (const [id, room] of [...grants]) {
    const back = await owner.dash("DELETE", `/v1/workspaces/${room}/repository/grants/${id}`, { policy_version: await owner.policyVersion(room) }).catch(() => null);
    if ((back?.ok && back.body?.revoked_at) || back?.code === "grant_not_found") grants.delete(id);
  }
  said.push(grants.size ? `${grants.size} grant(s) could NOT be taken back` : "every grant is taken back");
  for (const { agent, linker } of agents) {
    await agent.close().catch(() => null);
    const gone = await linker.dash("POST", `/agents/${agent.id}/disconnect`, {}).catch(() => null);
    said.push(`the agent ${gone?.status === 200 ? "is disconnected" : "could NOT be disconnected"}`);
  }
  for (const cookie of sessions.splice(0)) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  rmSync(work, { recursive: true, force: true });
  return said;
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  say(`\nThe run stopped: ${cause(error)}`);
  exitCode = error.preflight ? 2 : 1;
} finally {
  say("\n## clean-up");
  for (const line of await cleanUp()) say(`  - ${line}`);
  for (const repo of repos) say(`  - the repository ${repo} stays on GitHub: the owner deletes it`);
  say(`Sign-ups taken: ${signUps}.`);
}
if (outFile) {
  writeFileSync(outFile, masked(scrub(JSON.stringify(results, null, 2), secrets)) + "\n");
  say(`Results written to ${outFile}.`);
}
const incomplete = !results.browsers || Object.values(results.browsers).some((b) => b.error);
process.exit(exitCode || (incomplete ? 1 : 0));
