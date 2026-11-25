// M6's staging acceptance run with release switched ON, for static sites (docs/m6-plan.md, "The gate" and "Acceptance
// tests"). m6-staging.mjs shows release switched off; this shows it on: a room's approved, merged commit releases its
// `site` directory to its default host on the content domain, and around that each part of the gate that a script can
// show from outside:
//
// - disabled deployment publishes nothing (M6-01, M6-23);
// - checks, merge and release are reported apart, failure included: "Merged · Deployment failed" (M6-07, M6-08, UI-02,
//   M6-25);
// - claiming a role grants no deploy right (expanded criterion 3);
// - the deployment access tests AC-05, AC-10, AC-11, AC-13, AC-16 and AC-17;
// - takedown by an operator, and unpublish (M6-16, M6-19, M6-27);
// - the content host can't read or set the application's cookies (M6-12).
//
// Custom domains (M6-14, M6-15, M6-26) and apps with code are out of scope for now: their checks are in the plan, always
// say SKIP, and are listed apart. They never stop exit 0.
//
//   node m6-release-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// **Not yet run against staging,** because release isn't switched on there. It gives the `deploy` grant through the
// repository grant route, which takes that action since PR #566, and refuses, offline and before anything is sent, if
// the contract it reads doesn't list it.
//
// Before anything is sent it reads the contract. Before any sign-up, signed out: staging's agent configuration answers,
// a signed-out room list is 401, capabilities discovery lists `deploy_release` (the gateway lists it only while the API
// says RELEASES is exactly true), and an unknown app's host on podster.site gets the content Worker's own not found.
// After the owner's sign-up only, before any other sign-up, repository or public room: the room answers its release
// configuration, and a request isn't refused `release_not_available`, which staging answers while a provider is
// configured and the release path isn't complete.
//
// **No read shows whether a content provider is configured.** Nothing signed out does, and nothing a test person or an
// operator can read without changing state does either: the release configuration, capabilities discovery, the
// operators' findings and the content Worker's own answers are the same with and without one. The checks above are the
// earliest there are. With no provider, a release stays queued; M6-R06 then fails, saying that is the likely cause, and
// clean-up runs as on any failure.
//
// People: 4 takes of staging's test sign-up, of its 6 a minute and 40 a day: the room's owner, its admin, a member who
// holds the deploy grant, and staging's fixed test operator, who must be in the API's OPERATORS (m4-staging.mjs
// --operator-id prints its ID). One agent, made under the owner, takes none. A sign-up is never sent twice.
//
// Uploads: the release job takes at most 2 upload attempts a room in a rolling hour
// (MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR), and a release refused for its tree, like M6-R11's, spends one. So M6-R11 and
// M6-R12 run in a room of their own, the failing room, with its own repository, grants and admin approval: a release
// served there, then the failing one. The run's room spends M6-R06's and M6-R15's. Each room spends at most 2.
//
// Its steps (sign-ups, git, merges, releases, the host's answers, clean-up) are in m6-release-run.mjs since 2026-11-25,
// shared with m6-code-app-staging.mjs.
//
// GitHub: two public repositories in podsterdev, made by Podster, one for the run's room and one for the failing room.
// The coding agent pushes with its
// short-lived token through `git`, a child process with child-env.mjs's environment, a home of its own and the token
// under one name in its environment, never on a command line or in a file; and opens each pull request with that token.
// The browser for M6-R09 and M6-R12 is Playwright's Chromium, launched with child-env.mjs's environment.
//
// Output carries IDs, statuses and reason codes only. Every credential it handles is scrubbed from it. Request lines
// name an app's host as `[app host]`.
//
// Exit codes: 0 only when every in-scope check passed and none said SKIP; 1 otherwise, naming what wasn't shown; 2 for
// a refused configuration or a failed preflight, with no sign-up taken; 3 when release isn't on with a provider, with at
// most the owner's sign-up taken.
//
// Clean-up, on every way out, Ctrl-C included: release switched off in both rooms that had it (which unpublishes), a
// suspension the run left lifted, an organization's release given back, every room made private, every grant taken
// back, the agent disconnected, every session signed out. Left behind, as every staging run's are: the test people, the
// organization, the three rooms and their tasks, and the two repositories, which this script can't delete: it prints
// their names for the owner to archive or delete on GitHub.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import {
  CONTENT_DOMAIN, contentNotFoundProblem, GRANT_LOST_CODE, defaultHostProblem, DEPLOY_GRANT, deployGrantProblem, EXIT, fixedHeaderProblems, IN_FLIGHT, markerProblem, outOfScopeReason, parseArgs, PLAN, REFUSED_SITE, resultUrlProblem,
  runOutcome, secretProblem, SIGN_UPS, SITE, slowestLine, STAGING, STAGING_APP, STAGING_ORG, stateAfterUnpublish, statusProblems, Tally, unknownLabel, USAGE,
} from "./m6-release-staging-lib.mjs";
import { RoomPublisher } from "./room-publisher.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(EXIT.refused);
}
const options = parsed.options;
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;

// ---- the contract and the configuration, before anything is sent ----

const contractText = (() => {
  try {
    return readFileSync(options.contract ?? join(here, "../packages/contracts/openapi.yaml"), "utf8");
  } catch {
    return null;
  }
})();
const grantProblem = deployGrantProblem(contractText);
{
  console.log(`M6's staging run with release switched on, for static sites, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${SIGN_UPS.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of SIGN_UPS) console.log(`  - ${who}: ${why}`);
  console.log(`\nContent domain: ${CONTENT_DOMAIN}. GitHub organization: ${STAGING_ORG}. The deploy grant: POST ${DEPLOY_GRANT.path} with the action "${DEPLOY_GRANT.action}" (an assumption: see the header).`);
  console.log(`Waits, in seconds: repository ${options.setupWait}, merge ${options.mergeWait}, release ${options.releaseWait}, takedown ${options.takedownWait}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const entry of PLAN) console.log(`  ${entry.id.padEnd(7)} ${entry.title}${entry.outOfScope ? ` [out of scope: ${entry.outOfScope}; always SKIP, listed apart]` : ""}`);
  }
  const problem = secretProblem(signupSecret);
  if (grantProblem) {
    console.error(`\nRefused: ${grantProblem}. The run can't ask for a release without one. Nothing was sent.`);
    process.exit(EXIT.releaseNotOn);
  }
  if (problem && !options.dryRun) {
    console.error(`\nRefused: ${problem}. Nothing was sent.`);
    process.exit(EXIT.refused);
  }
  if (options.dryRun) {
    console.log(`\nThe configuration is complete${problem ? `, but for the sign-up secret: ${problem}` : ""}. Nothing was sent to staging, GitHub or ${CONTENT_DOMAIN}.`);
    process.exit(problem ? EXIT.refused : 0);
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, key, ok, Person, sleep } = await import("./lib.mjs");
// The run-time parts this run shares with m6-code-app-staging.mjs.
const { cause, Halt, NotOn, POLL_MS, refusedAs, refusedCode, releaseRun } = await import("./m6-release-run.mjs");

const RUN = `M6 release ${new Date().toISOString().slice(0, 16)}`;
const run = releaseRun({ signupSecret, options, runName: RUN, workPrefix: "podster-m6-release-" });
const { target, requests, say, secret, within, pause, signUpCookie, person, agentOf, leftBehind, hostAsk, marker, grants, repos, takeBack, preflight, deployReleaseListed } = run;
const tally = new Tally(PLAN, say);

// ---- checks ----

/** A check that can't run here, with why. */
class Skip extends Error {}
async function check(id, body) {
  if (run.stopping) throw new Halt("stopped by a signal");
  try {
    tally.add(id, "pass", (await body()) ?? "");
    return true;
  } catch (error) {
    if (error instanceof Halt || error instanceof NotOn) throw error;
    tally.add(id, error instanceof Skip ? "skip" : "fail", cause(error));
    return false;
  }
}
/** Fails a check whose ground an earlier one didn't lay: every in-scope check must pass, so this is never a SKIP. */
const after = (...ids) => {
  const missing = ids.filter((id) => !tally.passed(id));
  if (missing.length) throw new Error(`not shown: it needs ${missing.join(" and ")} to have passed`);
};

/** Playwright's Chromium, with child-env.mjs's environment: never a secret of ours. */
async function withBrowser(body) {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ env: childEnv() });
  try {
    return await body(browser);
  } finally {
    await browser.close().catch(() => null);
  }
}

// ---- the run's state ----

let owner, admin, member, operator, coder;
/** The organization the owner made for the run, which the room is in and the two other people join. */
let team;
let room, otherRoom, otherTask;
/** M6-R11's room, with a repository of its own: a room has 2 uploads an hour, and the run's room spends its own. */
let failRoom;
/** The app's default host and label, once it has one. */
let host, appLabel;
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });
/** What clean-up must undo, set as each is done and cleared once undone. `releaseOn` holds the rooms release may be on in. */
const undo = { releaseOn: new Set(), suspended: null, delegationTaken: false };
const tasks = {};

const releasesPath = (at = room) => `/v1/workspaces/${at}/releases`;
const statusOf = async (task) => run.statusOf(owner, task);
const taskRead = async (task) => run.taskRead(owner, task);
const configOf = async (at = room) => owner.must("GET", `/v1/workspaces/${at}/release-config`);
/** A member's request for a release of `task`'s merged commit, in the task's room. */
const askRelease = (who, task, body = {}, options = undefined) => who.dash("POST", releasesPath(task.room), { task_id: task.id, commit_sha: task.mergeSha, ...body }, options);
/** A grant the owner gives in room `at`, noted for clean-up before anything is asserted about it. */
const give = (principal, action, at = room) => run.give(owner, principal, action, at);
/** Adds a person of the run's organization to room `at`, in `role`. */
const addPerson = (who, role, at) => run.addPerson(owner, team, who, role, at);
const setUpRepository = (at, tag) => run.setUpRepository(owner, at, tag);
/** A task for the coder in room `at`, accepted, reviewed by the admin. */
const newTask = async (name, at = room) => (tasks[name] = await run.newTask({ owner, coder, reviewer: admin }, name, at));
/** The coder's change for a task, merged by the admin. */
const changeAndMerge = (task, files) => run.changeAndMerge({ owner, coder, merger: admin }, task, files);
const settled = (task, releaseId) => run.settled(owner, task, releaseId);
/** Approves a release as the admin, and waits for it to be served. */
const approveAndServe = (task, releaseId) => run.approveAndServe({ owner, approver: admin }, task, releaseId);
const hostDown = (what) => run.hostDown(host, what);
const markerNamed = (releaseId, commit, what) => run.markerNamed(host, releaseId, commit, what);
// ---- the run ----

async function main() {
  say("\n## the owner, the room, and whether release answers");
  owner = await person("the room's owner");
  await owner.useNewOrg(`${RUN} team`);
  team = owner.org;
  leftBehind.push(`the run's organization ${team}`);
  room = await owner.createRoom(`${RUN} release`);
  leftBehind.push(`room ${room}`);
  say(`     owner ${owner.id}; organization ${team}; room ${room}`);
  {
    const config = await owner.dash("GET", `/v1/workspaces/${room}/release-config`);
    if (config.status === 404 && config.code === "not_found") throw new NotOn("the room's release configuration answers as a missing route: RELEASES isn't exactly true on staging");
    ok(config.ok, `the room's release configuration answered ${config.status} ${config.code ?? ""}`);
    eq([config.body.enabled, config.body.version, config.body.default_host], [false, 0, null], "a new room's release configuration");
    // Nothing is in this room to release: a request is refused, and which refusal says whether the path is open.
    const probe = await owner.dash("POST", releasesPath(), { task_id: "tsk_e2e_probe", commit_sha: "0".repeat(40) });
    if (probe.status === 409 && probe.code === "release_not_available") throw new NotOn("a request is refused release_not_available: a provider is configured and the release path isn't complete (RELEASE_PATH_COMPLETE is false)");
    refusedAs(probe, 409, "release_needs_public_room", "a request in a new, private room");
  }

  say("\n## the room's admin, a member, the agent and the repository");
  const joinRoom = async (who, role) => {
    const invited = await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" });
    await who.must("POST", "/org-invitations/accept", { token: secret(invited.token) });
    who.org = who.actingOrg = team;
    await addPerson(who, role, room);
  };
  admin = await person("the room's admin");
  await joinRoom(admin, "admin");
  member = await person("a member");
  await joinRoom(member, "member");
  coder = await agentOf(owner, "coder");
  leftBehind.push(`agent ${coder.id}`);
  await owner.addAgent(room, coder);
  otherRoom = await owner.createRoom(`${RUN} other`);
  leftBehind.push(`room ${otherRoom}`);
  otherTask = (await owner.must("POST", `/v1/workspaces/${otherRoom}/tasks`, { title: `${RUN} elsewhere`, instructions: "Nothing." }, { idempotencyKey: key() })).id;
  say(`     admin ${admin.id}; member ${member.id}; coder ${coder.id}; another room ${otherRoom} with task ${otherTask}`);

  await setUpRepository(room, "room");
  await give(coder, "push");
  await give(admin, "merge");
  const t1 = await changeAndMerge(await newTask("site"), SITE);

  say("\n## release switched off publishes nothing");
  await check("M6-R01", async () => {
    refusedAs(await askRelease(member, t1), 409, "release_needs_public_room", "a request in the private room");
    // A public room always has person review on (decision 159), so publishing is refused person_review_required without it.
    await owner.must("PUT", `/v1/workspaces/${room}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(room) });
    const published = await publisher.publish(owner, room);
    ok(published.ok, `making the room public: HTTP ${published.status} ${published.code ?? ""}`);
    refusedAs(await askRelease(member, t1), 409, "release_off", "a request in the public room, with release off in the room");
    const config = await configOf();
    eq([config.enabled, config.default_host], [false, null], "the room's release configuration");
    eq((await admin.must("GET", `/v1/workspaces/${room}/release-approvals`)).releases, [], "the releases awaiting approval");
    const problems = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: "none" });
    ok(problems.length === 0, problems.join("; "));
    return "refused release_needs_public_room while private and release_off while public; no host, no release, status { exists: false }";
  });

  say("\n## the organization's release switch");
  try {
    operator = await Person.fromCookie(target, "the test operator", await signUpCookie("the test operator", { stable: "operator" }));
    say(`     test operator ${operator.id}`);
  } catch (error) {
    if (error instanceof Halt) throw error;
    say(`     the test operator couldn't sign in: ${cause(error)}`);
  }
  const delegationPath = `/v1/orgs/${team}/release-delegation`;
  await check("M6-R02", async () => {
    ok(operator, "the test operator didn't sign in");
    refusedAs(await owner.dash("PUT", delegationPath, { granted: false }), 403, "not_allowed", "the owner, an admin of the organization, setting its release switch");
    // Set before the request: a take whose answer is lost may still have landed, and clean-up reads before it undoes.
    undo.delegationTaken = true;
    const taken = await operator.dash("PUT", delegationPath, { granted: false });
    if (taken.status === 403) undo.delegationTaken = false;
    if (taken.status === 403) throw new Error(`the test operator was refused (${taken.code}): it isn't in staging's OPERATORS. m4-staging.mjs --operator-id prints its ID for the owner to add`);
    ok(taken.ok, `the operator taking release: HTTP ${taken.status} ${taken.code ?? ""}`);
    eq(taken.body.granted, false, "the switch after the take");
    refusedAs(await owner.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 }), 409, "release_not_delegated", "the owner switching release on");
    const config = await configOf();
    eq([config.enabled, config.version], [false, 0], "the configuration after the refusal");
    const back = await operator.must("PUT", delegationPath, { granted: true });
    eq(back.granted, true, "the switch given back");
    undo.delegationTaken = false;
    return `generation ${back.generation}, last take ${back.last_take}`;
  });

  say("\n## who may configure and approve");
  await check("M6-R03", async () => {
    undo.releaseOn.add(room);
    const on = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 });
    eq([on.enabled, on.version, on.set_by], [true, 1, admin.id], "the configuration the admin set");
    refusedAs(await member.dash("GET", `/v1/workspaces/${room}/release-config`), 403, "not_allowed", "the member reading the configuration");
    refusedAs(await member.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: 1 }), 403, "not_allowed", "the member setting the configuration");
    refusedAs(await member.dash("GET", `/v1/workspaces/${room}/release-approvals`), 403, "not_allowed", "the member listing approvals");
    eq((await configOf()).version, 1, "the configuration's version afterwards");
  });

  say("\n## claiming a role grants no deploy right");
  await check("M6-R04", async () => {
    after("M6-R03");
    const opening = await owner.must("POST", `/v1/workspaces/${room}/roles`, { title: "DevOps", responsibilities: "Deploys the room's app.", preset: "member", capacity: 1, policy_version: await owner.policyVersion(room) });
    await owner.must("POST", `/v1/workspaces/${room}/roles/${opening.id}/invites`, { policy_version: await owner.policyVersion(room), principal_id: coder.id });
    await coder.must("claim_role", { workspace_id: room, role_id: opening.id });
    ok((await coder.tools()).includes("deploy_release"), "the agent isn't offered deploy_release, so its refusal would show nothing");
    refusedCode(await coder.call("deploy_release", { workspace_id: room, task_id: t1.id, commit_sha: t1.mergeSha, idempotency_key: key() }), "grant_required", "the DevOps agent asking for a release");
    refusedAs(await askRelease(member, t1), 403, "grant_required", "the member, with no grant");
    refusedAs(await askRelease(owner, t1), 403, "grant_required", "the owner, with no grant of their own");
    const problems = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: "none" });
    ok(problems.length === 0, `the completed, merged task: ${problems.join("; ")}`);
    return `opening ${opening.id} claimed by ${coder.id}; refused grant_required to it, the member and the owner`;
  });

  await give(member, DEPLOY_GRANT.action);

  say("\n## what may be asked for");
  await check("M6-R05", async () => {
    after("M6-R03");
    refusedAs(await askRelease(member, t1, { commit_sha: t1.head }), 409, "commit_not_releasable", "the task branch's head");
    refusedAs(await askRelease(member, t1, { task_id: otherTask }), 404, "task_not_found", "another room's task");
    refusedAs(await askRelease(member, t1, { environment: "staging" }), 400, "invalid_argument", "another environment");
    for (const field of ["repository_id", "account_id", "namespace", "host", "label", "script_name"]) refusedAs(await askRelease(member, t1, { [field]: "e2e" }), 400, "invalid_argument", `a request naming ${field}`);
    refusedAs(await admin.dash("POST", `${releasesPath()}/rel_${randomBytes(16).toString("hex")}/approve`, {}), 404, "not_found", "approving a release ID this room doesn't have");
    eq((await admin.must("GET", `/v1/workspaces/${room}/release-approvals`)).releases, [], "the releases awaiting approval");
    const problems = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: "none" });
    ok(problems.length === 0, problems.join("; "));
  });

  say("\n## the release");
  let first;
  /** The release the host serves now. */
  let served;
  // R10's declined release of the first task's commit: from then on, the latest attempt for that commit.
  let declinedId;
  // The latest attempt for the first task's commit: set as each is asked for, so it never depends on how that check ended.
  let latestId;
  await check("M6-R06", async () => {
    after("M6-R03");
    const once = key();
    const asked = await askRelease(member, t1, {}, { idempotencyKey: once });
    ok(asked.ok, `the member's request: HTTP ${asked.status} ${asked.code ?? ""}`);
    eq([asked.body.state, asked.body.commit_sha, asked.body.requested_by, asked.body.approved_by], ["awaiting_approval", t1.mergeSha, member.id, null], "the release as asked for");
    const again = await askRelease(member, t1, {}, { idempotencyKey: once });
    eq([again.status, again.body?.id], [200, asked.body.id], "the same request with the same key");
    const waiting = (await admin.must("GET", `/v1/workspaces/${room}/release-approvals`)).releases;
    eq(waiting.map((r) => r.id), [asked.body.id], "the releases awaiting approval");
    refusedAs(await member.dash("POST", `${releasesPath()}/${asked.body.id}/approve`, {}), 403, "not_allowed", "its requester, who isn't an admin, approving it");
    const { seconds } = await approveAndServe(t1, asked.body.id);
    const config = await configOf();
    const at = defaultHostProblem(config.default_host);
    ok(!at.problem, at.problem);
    [host, appLabel] = [config.default_host, at.label];
    const status = await statusOf(t1);
    eq(resultUrlProblem(status.release.result_url, host), null, "the result URL");
    eq(markerProblem(await marker(host), asked.body.id, t1.mergeSha), null, "the host's marker");
    first = served = asked.body.id;
    latestId = first;
    return `release ${first} served after ${seconds} s at the app's default host, label ${appLabel}`;
  });

  say("\n## what the host serves");
  await check("M6-R07", async () => {
    after("M6-R06");
    const index = await hostAsk(`https://${host}/`);
    eq([index.status, index.body], [200, SITE["site/index.html"]], "the site's index");
    ok(/^text\/html/.test(new Headers(index.headers).get("content-type") ?? ""), "the index isn't served as HTML");
    const problems = fixedHeaderProblems(index.headers);
    ok(problems.length === 0, `the index: ${problems.join("; ")}`);
    const text = await hostAsk(`https://${host}/hello.txt`);
    eq([text.status, text.body], [200, SITE["site/hello.txt"]], "the site's text file");
    eq((await hostAsk(`https://${host}/`, { method: "HEAD" })).status, 200, "HEAD of the index");
    for (const method of ["POST", "PUT", "DELETE"]) eq((await hostAsk(`https://${host}/`, { method })).status, 405, `${method} of the index`);
    const missing = await hostAsk(`https://${host}/e2e-${randomBytes(4).toString("hex")}.txt`);
    // The release's own Worker answers a path with no file: 404 with an empty body (not_found_handling none, ADR
    // 0010's spike A), passed on under the content Worker's fixed headers. Its own `not_found` is for a host with no app.
    eq([missing.status, missing.body], [404, ""], "a path the site doesn't have");
    const missingProblems = fixedHeaderProblems(missing.headers);
    ok(missingProblems.length === 0, `a path the site doesn't have: ${missingProblems.join("; ")}`);
  });

  await check("M6-R08", async () => {
    after("M6-R06");
    ok(!defaultHostProblem(host).problem, "the host isn't an app's default host on the content domain");
    const plain = await hostAsk(`https://${host}/`);
    // Podster's own cookie names, with values of the run's own: never a real session, which the content domain must not see.
    const names = owner.cookie.split("; ").map((pair) => pair.slice(0, pair.indexOf("=")));
    const carried = await hostAsk(`https://${host}/`, { headers: { cookie: names.map((n) => `${n}=${randomBytes(12).toString("hex")}`).join("; "), authorization: `Bearer ${randomBytes(24).toString("hex")}` } });
    eq([carried.status, carried.body], [plain.status, plain.body], "an answer to a request carrying Podster's cookie names and an Authorization header");
    for (const answer of [plain, carried]) eq(answer.setCookies, [], "cookies set by the host");
    return `${names.length} cookie name(s) carried; no answer set a cookie`;
  });

  await check("M6-R09", async () => {
    after("M6-R06");
    const probe = randomBytes(16).toString("hex");
    const seen = await withBrowser(async (browser) => {
      const context = await browser.newContext();
      await context.addCookies([{ name: "e2e_probe", value: probe, domain: ".podster.dev", path: "/", secure: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const loaded = await page.goto(`https://${host}/`, { waitUntil: "load", timeout: 60_000 });
      ok(loaded?.status() === 200, `the page answered ${loaded?.status()}`);
      const inPage = await page.evaluate(async (api) => {
        const out = { violations: [] };
        document.addEventListener("securitypolicyviolation", (event) => out.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
        try {
          out.read = document.cookie;
        } catch (error) {
          out.readThrew = error.name;
        }
        try {
          document.cookie = "e2e_set=1; domain=podster.dev; path=/; secure";
        } catch (error) {
          out.setThrew = error.name;
        }
        try {
          await fetch(api, { credentials: "include" });
          out.api = "answered";
        } catch (error) {
          out.apiThrew = error.name;
        }
        // The violation event is queued after the refusal: give it a turn to arrive.
        await new Promise((done) => setTimeout(done, 500));
        return out;
      }, `${STAGING}/api/v1/me`);
      return { inPage, jar: (await context.cookies()).map((c) => `${c.name}@${c.domain}`) };
    });
    // The sandbox gives the page an opaque origin (decision 216): the browser refuses cookies to it outright.
    eq([seen.inPage.readThrew ?? null, seen.inPage.setThrew ?? null], ["SecurityError", "SecurityError"], "reading and setting document.cookie on the host");
    eq(seen.jar, ["e2e_probe@.podster.dev"], "the browser's cookies afterwards: only the one the run set for podster.dev");
    // The API is refused by the host's own policy, connect-src, before any request leaves: not by a network error.
    eq([seen.inPage.api ?? null, seen.inPage.apiThrew ?? null], [null, "TypeError"], "the page's fetch of the application's API");
    ok(seen.inPage.violations.some((v) => v.directive === "connect-src" && String(v.blocked).startsWith(STAGING)), `the fetch wasn't refused by connect-src (violations: ${JSON.stringify(seen.inPage.violations)})`);
    return "document.cookie refused with SecurityError both ways; the API refused by connect-src";
  });

  say("\n## an agent's request, declined");
  await check("M6-R10", async () => {
    after("M6-R06");
    await give(coder, DEPLOY_GRANT.action);
    const asked = await coder.must("deploy_release", { workspace_id: room, task_id: t1.id, commit_sha: t1.mergeSha });
    eq([asked.state, asked.requested_by, asked.commit_sha], ["awaiting_approval", coder.id, t1.mergeSha], "the agent's release as asked for");
    const declined = await admin.must("POST", `${releasesPath()}/${asked.id}/decline`, {});
    eq([declined.state, declined.declined_by], ["declined", admin.id], "the declined release");
    eq(markerProblem(await marker(host), first, t1.mergeSha), null, "the host's marker");
    declinedId = asked.id;
    latestId = declinedId;
    // The status reports the latest attempt for the commit, declined, and `served` for the commit: still true, since
    // the first release of that commit is what the host serves (openapi.yaml's TaskRelease).
    const status = await statusOf(t1);
    const problems = statusProblems(status, { taskId: t1.id, mergeSha: t1.mergeSha, release: { id: declinedId, state: "declined", served: true } });
    ok(problems.length === 0, `the first task: ${problems.join("; ")}`);
    eq(resultUrlProblem(status.release.result_url, host), null, "the first task's result URL");
    return `release ${asked.id} asked for by ${coder.id}, declined`;
  });

  say("\n## a release that fails, beside a merge that succeeded, in a room of its own");
  // A room has 2 uploads an hour, and a release refused for its tree spends one: the run's room keeps its own for
  // M6-R06 and M6-R15. This room gets its own repository, grants and admin approval, a release served, then the failing one.
  let t2;
  await check("M6-R11", async () => {
    after("M6-R03");
    failRoom = await owner.createRoom(`${RUN} failing release`);
    leftBehind.push(`room ${failRoom}`);
    await addPerson(admin, "admin", failRoom);
    await addPerson(member, "member", failRoom);
    await owner.addAgent(failRoom, coder);
    say(`     the failing room ${failRoom}`);
    await setUpRepository(failRoom, "fail");
    await give(coder, "push", failRoom);
    await give(admin, "merge", failRoom);
    const before = await changeAndMerge(await newTask("site-fail-room", failRoom), SITE);
    await owner.must("PUT", `/v1/workspaces/${failRoom}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(failRoom) });
    const published = await publisher.publish(owner, failRoom);
    ok(published.ok, `making the failing room public: HTTP ${published.status} ${published.code ?? ""}`);
    // A deploy grant is given only in a public room (release_needs_public_room), as in the run's room after M6-R01.
    await give(member, DEPLOY_GRANT.action, failRoom);
    undo.releaseOn.add(failRoom);
    const on = await admin.must("PUT", `/v1/workspaces/${failRoom}/release-config`, { enabled: true, expected_version: 0 });
    eq([on.enabled, on.set_by], [true, admin.id], "the failing room's configuration the admin set");
    // Its first upload: a release served, so the failing one has something to leave in place.
    const good = await askRelease(member, before);
    ok(good.ok, `the member's request in the failing room: HTTP ${good.status} ${good.code ?? ""}`);
    await approveAndServe(before, good.body.id);
    const failHost = (await configOf(failRoom)).default_host;
    const at = defaultHostProblem(failHost);
    ok(!at.problem, `the failing room's host: ${at.problem}`);
    ok(failHost !== host, "the failing room's host is the run's room's");
    eq(markerProblem(await marker(failHost), good.body.id, before.mergeSha), null, "the failing room's marker before");

    // Its second upload: the commit whose site holds _headers.
    t2 = await changeAndMerge(await newTask("refused", failRoom), REFUSED_SITE);
    const asked = await askRelease(member, t2);
    ok(asked.ok, `the member's request: HTTP ${asked.status} ${asked.code ?? ""}`);
    await admin.must("POST", `${releasesPath(failRoom)}/${asked.body.id}/approve`, {});
    const { status, seconds } = await settled(t2, asked.body.id);
    const problems = statusProblems(status, { taskId: t2.id, mergeSha: t2.mergeSha, release: { id: asked.body.id, state: "failed", served: false, failed: true } });
    ok(problems.length === 0, problems.join("; "));
    eq((await taskRead(t2)).task.status, "completed", "the task's status");
    // The release before is still the room's latest for its commit, and still served.
    const earlierStatus = await statusOf(before);
    const earlier = statusProblems(earlierStatus, { taskId: before.id, mergeSha: before.mergeSha, release: { id: good.body.id, state: "served", served: true } });
    ok(earlier.length === 0, `the task served before: ${earlier.join("; ")}`);
    eq(resultUrlProblem(earlierStatus.release.result_url, failHost), null, "the result URL of the task served before");
    eq(markerProblem(await marker(failHost), good.body.id, before.mergeSha), null, "the failing room's marker after");
    const index = await hostAsk(`https://${failHost}/`);
    eq([index.status, index.body], [200, SITE["site/index.html"]], "the failing room's index");
    return `room ${failRoom}: release ${good.body.id} served, then release ${asked.body.id} failed ${status.release.failure_code} after ${seconds} s; merge succeeded at ${status.merge.observed_at}, release at ${status.release.observed_at}, checks ${status.checks.state ?? "unread"}`;
  });

  await check("M6-R12", async () => {
    // The failed task is the failing room's; the served one is the run's room's, whose latest attempt R10 declined.
    after("M6-R11", "M6-R10");
    const shown = await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const appHost = new URL(STAGING_APP).hostname;
      const cookies = owner.cookie.split("; ").map((pair) => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), domain: appHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }));
      await context.addCookies([...cookies, { name: "podster-org", value: team, domain: appHost, path: "/", secure: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const stageOf = async (task, headline) => {
        await page.goto(`${STAGING_APP}/w/${task.room}/tasks?task=${task.id}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        // The task's own Sheet, a dialog named by the task's title, and its one deployment stage.
        const sheet = page.getByRole("dialog", { name: task.title });
        await sheet.waitFor({ timeout: 30_000 });
        const stage = sheet.getByTestId("deployment-stage");
        await stage.getByText(headline, { exact: true }).waitFor({ timeout: 30_000 });
        eq(await stage.count(), 1, `deployment stages in ${task.id}'s Sheet`);
        return stage.innerText({ timeout: 10_000 });
      };
      return { failed: await stageOf(t2, "Merged · Deployment failed"), live: await stageOf(t1, "Merged · Live") };
    });
    ok(!/\bLive\b/.test(shown.failed), "the failed task's deployment stage says Live");
    return "\"Merged · Deployment failed\" on the failed task, \"Merged · Live\" on the served one";
  });

  say("\n## authority that ends before the approval");
  await check("M6-R13", async () => {
    after("M6-R06");
    const asked = await askRelease(member, t1);
    ok(asked.ok, `the member's request: HTTP ${asked.status} ${asked.code ?? ""}`);
    latestId = asked.body.id;
    const held = [...grants].find(([, g]) => g.room === room && g.what === `${DEPLOY_GRANT.action} grant to ${member.id}`);
    ok(held, "the member's deploy grant isn't on the run's list");
    const back = await takeBack(held[0]);
    ok(back.ok, `taking the member's grant back: HTTP ${back.status} ${back.code ?? ""}`);
    const approved = await admin.dash("POST", `${releasesPath()}/${asked.body.id}/approve`, {});
    ok(approved.ok, `the approval after the grant was taken back answered HTTP ${approved.status} ${approved.code ?? ""}`);
    eq([approved.body.id, approved.body.state, approved.body.failure_code, approved.body.result_url], [asked.body.id, "failed", GRANT_LOST_CODE, null], "the release approved after its requester's grant was taken back");
    // Nothing new is served, now or once the job has had time: the host keeps the release it served before.
    for (let looks = 0; looks < 3; looks++) {
      if (looks) await pause(POLL_MS);
      eq(markerProblem(await marker(host), served, t1.mergeSha), null, "the host's marker");
    }
    const index = await hostAsk(`https://${host}/`);
    eq([index.status, index.body], [200, SITE["site/index.html"]], "the site's index");
    // The failed attempt is the latest for the commit, and the commit is still served, by the release served before:
    // `served` is the commit's, never this attempt's (openapi.yaml's TaskRelease), and the marker above names that one.
    const status = await statusOf(t1);
    const problems = statusProblems(status, { taskId: t1.id, mergeSha: t1.mergeSha, release: { id: asked.body.id, state: "failed", served: true, failed: true } });
    ok(problems.length === 0, problems.join("; "));
    eq(resultUrlProblem(status.release.result_url, host), null, "the result URL of the commit still served");
    await give(member, DEPLOY_GRANT.action);
    return `release ${asked.body.id} failed ${approved.body.failure_code}; release ${served} still served; the member was given a new grant`;
  });

  say("\n## takedown");
  await check("M6-R14", async () => {
    after("M6-R06");
    ok(operator, "the test operator didn't sign in");
    const report = await member.must("POST", "/v1/app-reports", { address: `https://${host}/`, reason: "other" }, { idempotencyKey: key() });
    ok(/^[A-Za-z0-9_]+$/.test(report.id ?? ""), "the report has no ID");
    undo.suspended = appLabel;
    const suspended = await operator.dash("POST", `/v1/moderation/apps/${appLabel}/suspend`, { reason: "other" });
    ok(suspended.ok, `the operator's suspension: HTTP ${suspended.status} ${suspended.code ?? ""}`);
    eq([suspended.body.label, suspended.body.suspended], [appLabel, true], "the suspension");
    const down = await hostDown("the host stopping after the suspension");
    refusedAs(await askRelease(member, t1), 409, "app_suspended", "a request while the app is suspended");
    const lifted = await operator.must("POST", `/v1/moderation/apps/${appLabel}/lift`, { reason: "other" });
    eq(lifted.suspended, false, "the lift");
    undo.suspended = null;
    for (let looks = 0; looks < 3; looks++) {
      await pause(POLL_MS);
      const answer = await hostAsk(`https://${host}/`);
      // The answer's own code, when it is one of the content Worker's: so a failure says which answer it was.
      const code = /^[a-z_]{1,40}$/.test(String(answer.body).trim()) ? String(answer.body).trim() : "another body";
      eq(contentNotFoundProblem(answer), null, `the host after the lift (${answer.status} ${code})`);
    }
    return `report ${report.id}; the host answered not found ${down} s after the suspension, and still did after the lift`;
  });

  await check("M6-R15", async () => {
    after("M6-R14");
    const asked = await askRelease(member, t1);
    ok(asked.ok, `the member's new request: HTTP ${asked.status} ${asked.code ?? ""}`);
    latestId = asked.body.id;
    const { seconds } = await approveAndServe(t1, asked.body.id);
    const config = await configOf();
    const at = defaultHostProblem(config.default_host);
    ok(!at.problem, at.problem);
    [host, appLabel] = [config.default_host, at.label];
    // R14's reads left the host answering not found, and the content Worker may still hold that answer: so the marker
    // is read until it names the new release, within the wait. One naming any other release fails at once.
    const named = await markerNamed(asked.body.id, t1.mergeSha, "the host's marker naming the new release");
    served = asked.body.id;
    const index = await hostAsk(`https://${host}/`);
    eq([index.status, index.body], [200, SITE["site/index.html"]], "the site's index once served again");
    return `release ${asked.body.id} served after ${seconds} s; its marker named it ${named} s later`;
  });

  say("\n## unpublish");
  await check("M6-R16", async () => {
    after("M6-R06");
    // The latest attempt's state before the switch, read here, decides the one it ends in: so this check stands on what
    // the API says now, not on how an earlier check ended.
    const before = (await statusOf(t1)).release;
    eq([before?.exists, before?.release_id], [true, latestId], "the first task's latest release before release is switched off");
    const ends = stateAfterUnpublish(before.state);
    ok(ends, `the first task's latest release was ${before.state} before release was switched off, which this run doesn't show unpublished`);
    const config = await configOf();
    const off = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.version });
    eq(off.enabled, false, "the configuration switched off");
    undo.releaseOn.delete(room);
    const down = await hostDown("the host stopping after release was switched off");
    // While the room's release is off, the status says only that no release exists (openapi.yaml's TaskRelease;
    // M6 plan, step 7). The records are kept: switched on again, the status names the latest attempt, ended.
    eq((await statusOf(t1)).release, { exists: false }, "the first task's release while release is off");
    const again = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: off.version });
    undo.releaseOn.add(room);
    eq(again.enabled, true, "the configuration switched on again");
    // A release still on its way is failed by the job, not by the switch: so its status is read until it has ended.
    const { value: status } = await within(options.releaseWait, `release ${latestId} ending`, () => statusOf(t1), (s) => !IN_FLIGHT.includes(s.release?.state) && s.release?.state !== "live");
    eq([status.release?.exists, status.release?.release_id, status.release?.state, status.release?.served, status.release?.result_url], [true, latestId, ends, false, null], `the first task's release once release is on again, ${before.state} before`);
    // Three looks, spaced, so a republish in the background would show.
    for (let look = 1; look <= 3; look++) {
      if (look > 1) await sleep(POLL_MS);
      eq(contentNotFoundProblem(await hostAsk(`https://${host}/`)), null, `the host once release is on again, look ${look} of 3`);
    }
    eq((await statusOf(t1)).release?.served, false, "the first task's release, still not served after the looks");
    const offAgain = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: again.version });
    eq(offAgain.enabled, false, "the configuration switched off again");
    undo.releaseOn.delete(room);
    return `the host answered not found ${down} s after release was switched off; release ${status.release.release_id} is kept, ${status.release.state}`;
  });

  say("\n## the room made private again");
  await check("M6-R17", async () => {
    const back = await publisher.unpublish(owner, room);
    ok(back.ok, `making the room private: HTTP ${back.status} ${back.code ?? ""}`);
    eq((await owner.must("GET", `/v1/workspaces/${room}/visibility`)).visibility, "private", "the room's visibility");
    refusedAs(await askRelease(member, t1), 409, "release_needs_public_room", "a request in the private room");
    if (host) eq(contentNotFoundProblem(await hostAsk(`https://${host}/`)), null, "the host");
  });
}

// ---- clean-up ----

async function cleanUp() {
  const said = [];
  // Each undo is safe to run whatever the step it undoes got to: a lift asked again changes nothing, and the switch and
  // the room's configuration are read first and changed only if they still need it.
  if (undo.suspended && operator) {
    const lifted = await operator.dash("POST", `/v1/moderation/apps/${undo.suspended}/lift`, { reason: "other" }).catch(() => null);
    if (lifted?.ok && lifted.body?.suspended === false) undo.suspended = null;
    said.push(!undo.suspended ? "the app is not suspended" : `the app's suspension could NOT be lifted (${lifted ? `HTTP ${lifted.status} ${lifted.code ?? ""}` : "no answer"}): an operator lifts label ${undo.suspended}`);
  }
  if (undo.delegationTaken && operator) {
    const path = `/v1/orgs/${team}/release-delegation`;
    const read = await operator.dash("GET", path).catch(() => null);
    const back = read?.ok && read.body?.granted === false ? await operator.dash("PUT", path, { granted: true }).catch(() => null) : read;
    if (back?.ok && back.body?.granted === true) undo.delegationTaken = false;
    said.push(!undo.delegationTaken ? "the organization holds release" : `the organization's release could NOT be given back: an operator gives it back to ${team}`);
  }
  for (const at of [...undo.releaseOn]) {
    const who = admin ?? owner;
    const config = await who.dash("GET", `/v1/workspaces/${at}/release-config`).catch(() => null);
    const off = config?.ok && config.body?.enabled ? await who.dash("PUT", `/v1/workspaces/${at}/release-config`, { enabled: false, expected_version: config.body.version }).catch(() => null) : config;
    if (off?.ok && off.body?.enabled === false) undo.releaseOn.delete(at);
    said.push(!undo.releaseOn.has(at) ? `release is off in room ${at}, so its app is unpublished` : `release could NOT be switched off in room ${at}: its owner switches it off`);
  }
  const { left } = await publisher.stop();
  if (left) said.push(`${[...publisher.published.keys()].map((at) => `room ${at}`).join(" and ")} could NOT be made private again`);
  said.push(...(await run.cleanUpShared()));
  return said;
}

const started = Date.now();
try {
  await preflight();
} catch (error) {
  console.error(run.out(`\nRefused: the signed-out preflight failed: ${cause(error)}.\nNo sign-up was taken.`));
  run.removeWork();
  process.exit(EXIT.refused);
}
{
  let listed;
  let refusal = null;
  try {
    listed = await deployReleaseListed();
    if (!listed) refusal = "staging's capabilities discovery doesn't list deploy_release, so the API doesn't say RELEASES is exactly true";
    else {
      const unknown = await hostAsk(`https://${unknownLabel(randomBytes(26))}.${CONTENT_DOMAIN}/`);
      const problem = contentNotFoundProblem(unknown);
      if (problem) refusal = `an unknown app's host on ${CONTENT_DOMAIN} wasn't the content Worker's not found: ${problem}`;
    }
  } catch (error) {
    refusal = `whether release is on couldn't be read: ${cause(error)}`;
  }
  if (refusal) {
    console.error(run.out(`\nRefused: ${refusal}. Release isn't on with a provider on staging.\nNo sign-up was taken.`));
    run.removeWork();
    process.exit(EXIT.releaseNotOn);
  }
  say("     signed out: deploy_release is listed, and the content domain answers an unknown host with the content Worker's not found");
}
let notOn = null;
let halted = false;
let cleanupLines = [];
try {
  await main();
} catch (error) {
  if (error instanceof NotOn) notOn = cause(error);
  halted = error instanceof Halt;
  say(`\nThe run stopped: ${cause(error)}`);
} finally {
  const notRun = run.stopping || halted ? "not run: the run was stopped by a signal" : "not run: the run stopped before it";
  for (const entry of PLAN) if (!tally.has(entry.id)) tally.add(entry.id, "skip", entry.outOfScope ? outOfScopeReason(entry) : notRun);
  cleanupLines = await cleanUp();
}
say("\n## clean-up");
for (const line of cleanupLines) say(`  - ${line}`);
for (const { full } of repos.values()) say(`  - the repository ${full} stays on GitHub: the owner archives or deletes it`);
if (notOn) {
  say(`\nRelease isn't on with a provider on staging: ${notOn}. Sign-ups taken: ${run.signUpsAsked}.`);
  say(`Left behind on staging: ${leftBehind.join("; ") || "nothing"}. Every test session was signed out.`);
  say(slowestLine(requests));
  process.exit(EXIT.releaseNotOn);
}
const outcome = runOutcome(tally, PLAN);
say(`\n${tally.summary()}, in ${Math.round((Date.now() - started) / 1000)} s. Sign-ups asked for: ${run.signUpsAsked}.`);
if (run.signUpUnknown) say("A sign-up's answer was lost in transport: whether staging took it is unknown, and it wasn't asked again.");
say(`Out of scope for now, skipped by design and not counted: ${PLAN.filter((e) => e.outOfScope).map((e) => `${e.id} (${e.outOfScope})`).join(", ")}.`);
if (outcome.unshown.length) say(`Not shown, so the run doesn't count as passed: ${outcome.unshown.join(", ")}.`);
say(`Left behind on staging: ${leftBehind.join("; ") || "nothing"}. Every test session was signed out.`);
say(slowestLine(requests));
process.exit(outcome.code);
