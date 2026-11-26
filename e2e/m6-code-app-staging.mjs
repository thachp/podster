// M6's staging run with a real app with code (docs/m6-plan.md, "The content Worker serves apps with code, built
// 2026-11-25": "Also owed: a staging run with a real app with code through the deployed content Worker"). One tiny app,
// a worker/ module and podster-app.json asking for its store, is merged and released through the real path, and its
// host is then asked, from outside, for each thing ADR 0010's revision (section 10) and the plan say a staging run
// must show:
//
// - the release marker is the static file, never the module's answer, on a host with code;
// - a read reaches the module, with the fixed headers, and the app's own cookies and CORS headers dropped;
// - writes within the budget reach the app, and the first over it is refused 429 with Retry-After;
// - the app's fetch gets podster-outbound's 403, and its connect() is refused;
// - an app that spins is stopped by the CPU limit (502 app_error);
// - a limit hit after the headers were sent never reaches a visitor as a clean 200: 502 app_error, or an aborted body;
// - unpublish: the host answers not found, and a write no longer reaches the app.
//
//   node m6-code-app-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// **It runs from GitHub Actions,** `.github/workflows/m6-code-app-staging.yml`, started by hand: the owner's machine
// sits behind a web filter that blocks the content domain. The workflow's environment, `staging-e2e`, holds the one
// secret it needs, PODSTER_E2E_SIGNUP_SECRET, set by the owner.
//
// Before any sign-up, signed out: staging's agent configuration answers, a signed-out room list is 401, capabilities
// discovery lists `deploy_release`, and an unknown app's host on podster.site gets the content Worker's own not found.
// After the owner's sign-up only: the room answers its release configuration, and a request isn't refused
// `release_not_available`. No read shows whether the deployed content Worker serves apps with code: if it doesn't, the
// release can't be confirmed by its marker, and M6-C01 fails naming the likely cause.
//
// People: 2 takes of staging's test sign-up, of its 6 a minute and 40 a day: the room's owner and its admin. The coding
// agent, made under the owner, takes none; it asks for the release with a deploy grant, and the admin, who doesn't
// control it, merges its task and approves the release. A sign-up is never sent twice.
//
// Uploads: one release, one of the room's 2 upload attempts an hour. The write budget is shown at its deployed figure,
// 300 writes a 10-minute window, by about 300 small JSON writes sent one at a time to the app's own host: each a few
// hundred bytes, none in parallel. The run waits for a fresh window when less than 2 minutes of the current one is left.
//
// GitHub: one public repository in podsterdev, made by Podster. The coding agent pushes with its short-lived token
// through `git`, a child process with child-env.mjs's environment (m6-release-run.mjs). No browser is used.
//
// Output carries IDs, statuses and reason codes only. Every credential it handles is scrubbed from it, the two people's
// IDs are printed as their role, and request lines name the app's host as `[app host]`. Its label is never printed.
//
// Clean-up, on every way out, Ctrl-C included: release switched off in the room (which unpublishes the app and retires
// its label), the room made private, every grant taken back, the agent disconnected, every session signed out. Left
// behind, as every staging run's are: the two test people, the organization, the room and its task, and the
// repository, which this script can't delete: it prints its name for the owner to archive or delete on GitHub.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterHeadersLine, afterHeadersProblem, appFiles, budgetRefusalProblem, burstPlan, BURST_SPARE, codeHeaderProblems, CONTENT_DOMAIN, contentNotFoundProblem, defaultHostProblem, DEPLOY_GRANT, deployGrantProblem, EXIT, MANIFEST, markerBody, MARKER_PATH, moduleAnswer, outboundProblems, parseArgs, PLAN,
  preflightProblem, Results, resultUrlProblem, runOutcome, secretProblem, SIGN_UPS, slowestLine, spinProblem, STAGING, STAGING_ORG, unknownLabel, USAGE, windowStart, WRITE_CAP,
} from "./m6-code-app-staging-lib.mjs";
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
  console.log(`M6's staging run with an app with code, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${SIGN_UPS.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of SIGN_UPS) console.log(`  - ${who}: ${why}`);
  console.log(`\nContent domain: ${CONTENT_DOMAIN}. GitHub organization: ${STAGING_ORG}. The manifest: ${JSON.stringify(MANIFEST)}. The write budget: ${WRITE_CAP.writes} writes a ${WRITE_CAP.windowMs} ms window.`);
  console.log(`Waits, in seconds: repository ${options.setupWait}, merge ${options.mergeWait}, release ${options.releaseWait}, takedown ${options.takedownWait}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const entry of PLAN) console.log(`  ${entry.id.padEnd(7)} ${entry.title}${entry.outOfScope ? ` [out of scope: ${entry.outOfScope}]` : ""}${entry.recordOnly ? ` [recorded, not judged: ${entry.recordOnly}]` : ""}`);
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
const { eq, ok, sleep } = await import("./lib.mjs");
const { cause, Halt, NotOn, refusedAs, releaseRun } = await import("./m6-release-run.mjs");

const RUN = `M6 code app ${new Date().toISOString().slice(0, 16)}`;
const TAG = `e2e-${randomBytes(6).toString("hex")}`;
const run = releaseRun({ signupSecret, options, runName: RUN, workPrefix: "podster-m6-code-app-" });
const { say, hostAsk, marker } = run;
const results = new Results(PLAN, say);

// ---- checks ----

async function check(id, body) {
  if (run.stopping) throw new Halt("stopped by a signal");
  try {
    results.add(id, "pass", (await body()) ?? "");
    return true;
  } catch (error) {
    if (error instanceof Halt || error instanceof NotOn) throw error;
    results.add(id, "fail", cause(error));
    return false;
  }
}
/** Fails a check whose ground an earlier one didn't lay. */
const after = (...ids) => {
  const missing = ids.filter((id) => !results.passed(id));
  if (missing.length) throw new Error(`not shown: it needs ${missing.join(" and ")} to have passed`);
};

// ---- the run's state ----

let owner, admin, coder, team, room, task, host;
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });
/** Whether release may be on in the room: clean-up switches it off. */
let releaseOn = false;
/** When each write the budget counted was sent, by this machine's clock: the burst's arithmetic needs them. */
const counted = [];

const configOf = async () => owner.must("GET", `/v1/workspaces/${room}/release-config`);
const app = (path) => `https://${host}${path}`;
/** A JSON write to the app's host. Answers the host's answer; a write that passed the content Worker's own rules is noted as counted. */
async function write(path, value, { quiet = false } = {}) {
  const at = Date.now();
  const answer = await hostAsk(app(path), { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify(value), quiet });
  // Every write past the content Worker's own rules is counted, whatever the app then answers; one refused for the budget isn't.
  if (answer.status !== 429 && answer.status !== 415) counted.push(at);
  return answer;
}

/** The release's failure codes that name a cause on staging, for M6-C01's message. */
const CODE_FAILURE_HINT = {
  release_code_not_available: ": the API's gate for apps with code is closed on staging (CODE_RELEASES_COMPLETE)",
  release_marker_missing: ": the marker couldn't be confirmed, as when the deployed content Worker doesn't yet serve apps with code (scripts/deploy-content is the owner's)",
};

// ---- the run ----

async function main() {
  say("\n## the owner, the room, and whether release answers");
  owner = await run.person("the room's owner");
  run.mask(owner.id, "[owner]");
  await owner.useNewOrg(`${RUN} team`);
  team = owner.org;
  run.leftBehind.push(`the run's organization ${team}`);
  room = await owner.createRoom(`${RUN} app`);
  run.leftBehind.push(`room ${room}`);
  say(`     organization ${team}; room ${room}`);
  {
    const config = await owner.dash("GET", `/v1/workspaces/${room}/release-config`);
    if (config.status === 404 && config.code === "not_found") throw new NotOn("the room's release configuration answers as a missing route: RELEASES isn't exactly true on staging");
    ok(config.ok, `the room's release configuration answered ${config.status} ${config.code ?? ""}`);
    eq([config.body.enabled, config.body.version, config.body.default_host], [false, 0, null], "a new room's release configuration");
    const probe = await owner.dash("POST", `/v1/workspaces/${room}/releases`, { task_id: "tsk_e2e_probe", commit_sha: "0".repeat(40) });
    if (probe.status === 409 && probe.code === "release_not_available") throw new NotOn("a request is refused release_not_available: a provider is configured and the release path isn't complete (RELEASE_PATH_COMPLETE is false)");
    refusedAs(probe, 409, "release_needs_public_room", "a request in a new, private room");
  }

  say("\n## the room's admin, the agent and the repository");
  admin = await run.person("the room's admin");
  run.mask(admin.id, "[admin]");
  {
    const invited = await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" });
    await admin.must("POST", "/org-invitations/accept", { token: run.secret(invited.token) });
    admin.org = admin.actingOrg = team;
    await run.addPerson(owner, team, admin, "admin", room);
  }
  coder = await run.agentOf(owner, "coder");
  run.leftBehind.push(`agent ${coder.id}`);
  await owner.addAgent(room, coder);
  say(`     coder ${coder.id}`);
  await run.setUpRepository(owner, room, "code");
  await run.give(owner, coder, "push", room);
  await run.give(owner, admin, "merge", room);
  task = await run.newTask({ owner, coder, reviewer: admin }, "app", room);
  await run.changeAndMerge({ owner, coder, merger: admin }, task, appFiles(TAG));

  say("\n## the release");
  let releaseId;
  await check("M6-C01", async () => {
    // A public room always has person review on (decision 159), so publishing is refused person_review_required without it.
    await owner.must("PUT", `/v1/workspaces/${room}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(room) });
    const published = await publisher.publish(owner, room);
    ok(published.ok, `making the room public: HTTP ${published.status} ${published.code ?? ""}`);
    releaseOn = true;
    const on = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 });
    eq([on.enabled, on.set_by], [true, admin.id], "the configuration the admin set");
    await run.give(owner, coder, DEPLOY_GRANT.action, room);
    const asked = await coder.must("deploy_release", { workspace_id: room, task_id: task.id, commit_sha: task.mergeSha });
    eq([asked.state, asked.requested_by, asked.commit_sha], ["awaiting_approval", coder.id, task.mergeSha], "the agent's release as asked for");
    releaseId = asked.id;
    const { seconds } = await run.approveAndServe({ owner, approver: admin }, task, releaseId, (code) => CODE_FAILURE_HINT[code] ?? "");
    const config = await configOf();
    const at = defaultHostProblem(config.default_host);
    ok(!at.problem, at.problem);
    host = config.default_host;
    run.secret(at.label);
    const status = await run.statusOf(owner, task);
    eq(resultUrlProblem(status.release.result_url, host), null, "the result URL");
    return `release ${releaseId} served after ${seconds} s at the app's default host`;
  });

  say("\n## the marker, and the module behind it");
  await check("M6-C02", async () => {
    after("M6-C01");
    const read = await hostAsk(app(MARKER_PATH), { headers: { accept: "application/json" } });
    ok(!moduleAnswer(read.body, TAG), "the module answered the marker's path");
    eq([read.status, read.body === markerBody(releaseId, task.mergeSha)], [200, true], "the marker, as the release job wrote it");
    const problems = codeHeaderProblems(read.headers);
    ok(problems.length === 0, `the marker: ${problems.join("; ")}`);
    const head = await hostAsk(app(MARKER_PATH), { method: "HEAD" });
    // fetch never hands over a body for HEAD, so only the status says anything here.
    eq(head.status, 200, "HEAD of the marker");
    const nothing = `/e2e-${randomBytes(4).toString("hex")}`;
    const other = await hostAsk(app(nothing));
    const answered = moduleAnswer(other.body, TAG);
    ok(other.status === 200 && answered?.path === nothing, `a path with no file didn't reach the module (${other.status}), so the module wasn't shown live`);
    return "the marker was the static file; a path with no file reached the module";
  });

  say("\n## a read");
  await check("M6-C03", async () => {
    after("M6-C01");
    const read = await hostAsk(app("/api/hello"));
    const answered = moduleAnswer(read.body, TAG);
    ok(read.status === 200 && answered?.method === "GET", `the read answered ${read.status}, not the module's 200`);
    const problems = codeHeaderProblems(read.headers);
    ok(problems.length === 0, `the module's answer: ${problems.join("; ")}`);
    eq(read.setCookies, [], "cookies set by the host");
    const head = await hostAsk(app("/api/hello"), { method: "HEAD" });
    eq(head.status, 200, "HEAD of the same path");
    const index = await hostAsk(app("/"));
    eq([index.status, index.body], [200, appFiles(TAG)["site/index.html"]], "the static index");
    const indexProblems = codeHeaderProblems(index.headers);
    ok(indexProblems.length === 0, `the static index: ${indexProblems.join("; ")}`);
    return "the module answered with the fixed headers only; its Set-Cookie, CORS, Cache-Control and own header were dropped";
  });

  await check("M6-C04", async () => {
    after("M6-C01");
    const read = await hostAsk(app("/api/store"));
    const answered = moduleAnswer(read.body, TAG);
    ok(read.status === 200 && answered, `the store's read answered ${read.status}, not the module's 200`);
    eq(answered.env, ["STORE"], "the bindings the module sees");
    eq(answered.store, { seven: 7 }, "the row the module read from its store");
    return "the module's bindings are exactly STORE, and it read { seven: 7 } from it";
  });

  say("\n## writes");
  await check("M6-C05", async () => {
    after("M6-C01");
    const preflight = await hostAsk(app("/api/echo"), { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    eq(preflightProblem(preflight), null, "the preflight's answer");
    const sent = { nonce: randomBytes(8).toString("hex") };
    const posted = await write("/api/echo", sent);
    const answered = moduleAnswer(posted.body, TAG);
    ok(posted.status === 200 && answered?.method === "POST", `the write answered ${posted.status}, not the module's 200`);
    eq(answered.received, sent, "the body the module received");
    const problems = codeHeaderProblems(posted.headers);
    ok(problems.length === 0, `the write's answer: ${problems.join("; ")}`);
    const plain = await hostAsk(app("/api/echo"), { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
    eq([plain.status, plain.body.trim()], [415, "write_not_json"], "a write that isn't JSON");
  });

  await check("M6-C06", async () => {
    after("M6-C05");
    const plan = burstPlan(Date.now(), counted);
    if (plan.waitMs > 0) {
      say(`     waiting ${Math.ceil(plan.waitMs / 1000)} s for a write window with room for the burst`);
      await run.pause(plan.waitMs);
    }
    let admitted = 0;
    let refusal = null;
    const first = Date.now();
    // One at a time, bounded: a budget that isn't enforced is shown by BURST_SPARE writes past it, never more.
    for (let n = 1; n <= WRITE_CAP.writes + BURST_SPARE; n++) {
      if (run.stopping) throw new Halt("stopped by a signal");
      const answer = await write("/api/echo", { n, tag: TAG }, { quiet: true });
      if (answer.status === 429) {
        refusal = { answer, at: Date.now() };
        break;
      }
      const answered = moduleAnswer(answer.body, TAG);
      ok(answer.status === 200 && answered?.received?.n === n, `write ${n} of the burst answered ${answer.status} ${answer.body.trim().slice(0, 40)}, not the module's 200`);
      admitted++;
    }
    const last = Date.now();
    say(`     ${admitted} write(s) admitted in ${Math.round((last - first) / 100) / 10} s, then ${refusal ? refusal.answer.status : "no refusal"}`);
    ok(windowStart(first) === windowStart(last), "a write window ended during the burst, so its count can't be read");
    ok(refusal, `${admitted} writes were admitted and none refused: the budget of ${WRITE_CAP.writes} isn't enforced`);
    ok(admitted >= plan.admitted.least && admitted <= plan.admitted.most, `the budget admitted ${admitted} of the burst's writes, not ${plan.admitted.least === plan.admitted.most ? plan.admitted.most : `${plan.admitted.least} to ${plan.admitted.most}`}`);
    eq(budgetRefusalProblem(refusal.answer, refusal.at), null, "the first write over the budget");
    return `${admitted} admitted (${WRITE_CAP.writes - admitted} counted earlier in the window), then 429 write_budget_spent with Retry-After ${new Headers(refusal.answer.headers).get("retry-after")} s`;
  });

  say("\n## outbound, and the CPU limit");
  await check("M6-C07", async () => {
    after("M6-C01");
    const read = await hostAsk(app("/api/outbound"));
    const answered = moduleAnswer(read.body, TAG);
    ok(read.status === 200 && answered, `the outbound probe answered ${read.status}, not the module's 200`);
    const problems = outboundProblems(answered);
    ok(problems.length === 0, problems.join("; "));
    return `${answered.fetches.length} fetch(es) got podster-outbound's 403; ${answered.sockets.length} socket(s) refused (${[...new Set(answered.sockets.map((s) => `${s.at}: ${s.error.name}`))].join(", ")})`;
  });

  await check("M6-C08", async () => {
    after("M6-C01");
    const light = await hostAsk(app("/api/spin-light"));
    ok(light.status === 200 && moduleAnswer(light.body, TAG), `the module's light work answered ${light.status}, not 200`);
    const spun = await hostAsk(app("/api/spin"));
    eq(spinProblem(spun, spun.ms, TAG), null, "the spinning app's answer");
    return `light work 200 in ${light.ms} ms; the spin answered 502 app_error in ${spun.ms} ms`;
  });

  await check("M6-C09", async () => {
    after("M6-C01");
    const url = app("/api/after-headers");
    const at = new Date().toISOString();
    const begun = performance.now();
    const seen = { bytes: 0, text: "", ended: false };
    let res;
    try {
      res = await fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
      Object.assign(seen, { status: res.status, headers: [...res.headers], contentType: res.headers.get("content-type"), cacheControl: res.headers.get("cache-control"), allowOrigin: res.headers.get("access-control-allow-origin") });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen.bytes += value.byteLength;
        seen.text += decoder.decode(value, { stream: true });
      }
      seen.ended = true;
    } catch (error) {
      seen.error = `${error?.name ?? "Error"}${error?.cause?.code ? ` (${error.cause.code})` : ""}`;
    }
    seen.ms = Math.round(performance.now() - begun);
    run.logRequest({ url, method: "GET", at, ms: seen.ms, ...(res ? { status: res.status } : { error: seen.error }) });
    const problem = afterHeadersProblem(seen);
    ok(problem === null, `${problem}; seen: ${afterHeadersLine(seen)}`);
    return afterHeadersLine(seen);
  });

  say("\n## unpublish");
  await check("M6-C10", async () => {
    after("M6-C01");
    const config = await configOf();
    const off = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.version });
    eq(off.enabled, false, "the configuration switched off");
    releaseOn = false;
    const down = await run.hostDown(host, "the host stopping after release was switched off");
    eq(contentNotFoundProblem(await marker(host)), null, "the marker once unpublished");
    const posted = await hostAsk(app("/api/echo"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ after: "unpublish" }) });
    eq([posted.status, posted.body.trim(), moduleAnswer(posted.body, TAG)], [405, "method_not_allowed", null], "a write once unpublished");
    eq((await run.statusOf(owner, task)).release, { exists: false }, "the task's release while release is off");
    return `the host answered not found ${down} s after release was switched off`;
  });

  say("\n## the room made private again");
  await check("M6-C11", async () => {
    const back = await publisher.unpublish(owner, room);
    ok(back.ok, `making the room private: HTTP ${back.status} ${back.code ?? ""}`);
    eq((await owner.must("GET", `/v1/workspaces/${room}/visibility`)).visibility, "private", "the room's visibility");
    if (host) eq(contentNotFoundProblem(await hostAsk(app("/"))), null, "the host");
  });
}

// ---- clean-up ----

async function cleanUp() {
  const said = [];
  // Read first and changed only if it still needs it.
  if (releaseOn && room) {
    const who = admin ?? owner;
    const config = await who.dash("GET", `/v1/workspaces/${room}/release-config`).catch(() => null);
    const off = config?.ok && config.body?.enabled ? await who.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.body.version }).catch(() => null) : config;
    if (off?.ok && off.body?.enabled === false) releaseOn = false;
    said.push(!releaseOn ? `release is off in room ${room}, so its app is unpublished` : `release could NOT be switched off in room ${room}: its owner switches it off`);
  }
  const { left } = await publisher.stop();
  if (left) said.push(`room ${room} could NOT be made private again`);
  said.push(...(await run.cleanUpShared()));
  return said;
}

const started = Date.now();
try {
  await run.preflight();
} catch (error) {
  console.error(run.out(`\nRefused: the signed-out preflight failed: ${cause(error)}.\nNo sign-up was taken.`));
  run.removeWork();
  process.exit(EXIT.refused);
}
{
  let refusal = null;
  try {
    if (!(await run.deployReleaseListed())) refusal = "staging's capabilities discovery doesn't list deploy_release, so the API doesn't say RELEASES is exactly true";
    else {
      const problem = contentNotFoundProblem(await hostAsk(`https://${unknownLabel(randomBytes(26))}.${CONTENT_DOMAIN}/`));
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
  for (const entry of PLAN) {
    if (results.has(entry.id)) continue;
    if (entry.outOfScope) results.add(entry.id, "outOfScope", entry.outOfScope);
    else if (entry.recordOnly) results.add(entry.id, "recorded", `nothing recorded: ${notRun}`);
    else results.add(entry.id, "fail", notRun);
  }
  cleanupLines = await cleanUp();
}
say("\n## clean-up");
for (const line of cleanupLines) say(`  - ${line}`);
for (const { full } of run.repos.values()) say(`  - the repository ${full} stays on GitHub: the owner archives or deletes it`);
if (notOn) {
  say(`\nRelease isn't on with a provider on staging: ${notOn}. Sign-ups taken: ${run.signUpsAsked}.`);
  say(`Left behind on staging: ${run.leftBehind.join("; ") || "nothing"}. Every test session was signed out.`);
  say(slowestLine(run.requests));
  process.exit(EXIT.releaseNotOn);
}
const outcome = runOutcome(results, PLAN);
say(`\n${results.summary()}, in ${Math.round((Date.now() - started) / 1000)} s. Sign-ups asked for: ${run.signUpsAsked}.`);
if (run.signUpUnknown) say("A sign-up's answer was lost in transport: whether staging took it is unknown, and it wasn't asked again.");
if (outcome.unshown.length) say(`Not shown, so the run doesn't count as passed: ${outcome.unshown.join(", ")}.`);
say(`Left behind on staging: ${run.leftBehind.join("; ") || "nothing"}. Every test session was signed out.`);
say(slowestLine(run.requests));
process.exit(outcome.code);
