// M6's staging acceptance test for custom domains (docs/m6-plan.md, steps 8a to 8e; the labels M6-X14, M6-X15 and
// M6-X26 in m6-release-staging-lib.mjs). One room releases a tiny static site through the real path; then names under a
// fresh label of the test customer's domain, `cd-<random>.opster.dev`, are asked for, proved by publishing their TXT
// challenge through Cloudflare's DNS API, routed through the content zone's fallback origin, and removed:
//
// - refused names: Podster's own and the content domain's, public suffixes, IPs, wildcards, single labels, malformed;
// - while pending, with the CNAME in place and only another room's challenge published, no claim and nothing served;
// - two other rooms racing for one name: exactly one claim;
// - the room's own challenge published: the claim, Cloudflare `active`, the app and its marker over HTTPS on the name,
//   and the certificate served for it (the first live check of HTTP validation with the `*/*` route);
// - removal: the request ending, and the name no longer serving.
//
//   node m6-custom-domain-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// **It runs from GitHub Actions,** `.github/workflows/m6-custom-domain-staging.yml`, started by hand: the owner's machine
// sits behind a web filter that blocks the content domain. The workflow's environment, `staging-dns`, holds the three
// secrets it needs: PODSTER_E2E_SIGNUP_SECRET, OPSTER_DNS_TOKEN and OPSTER_ZONE_ID.
//
// DNS: every write goes through `dnsAllow` (m6-custom-domain-staging-lib.mjs), as spike D's guard.mjs did for its
// token: only TXT at `_podster-challenge.<name>` and CNAME to the fallback origin, only under this run's label, and a
// delete only of a record this run made. Clean-up deletes them all and lists each name again. The token and the zone's
// ID are read once, taken out of the environment, and scrubbed from every line printed.
//
// People: 2 takes of staging's test sign-up, of its 6 a minute and 40 a day: the rooms' owner and admin. The coding
// agent, made under the owner, takes none. Rooms: three, each public with release on, each with a repository (a room
// can't switch release on without one): A releases and maps the name; B and C race for another. Each room makes at most
// two hostname requests, of its 5 an hour. Cloudflare: at most 2 custom hostnames, the race's winner's and A's.
//
// Output carries IDs, statuses and reason codes only. Every credential is scrubbed from it, the two people's IDs are
// printed as their role, and the app's default host as `[app host]`. The run's names under opster.dev are printed: they
// are public anyway once a certificate is issued for one.
//
// Clean-up, on every way out, Ctrl-C included: each room's open hostname request removed through the API, every DNS
// record deleted, release switched off in each room, the rooms made private, every grant taken back, the agent
// disconnected, every session signed out. A removed claim stays `ending` until Cloudflare reads its custom hostname gone
// twice ten minutes apart; the run doesn't wait for that. Left behind, as every staging run's are: the two test people,
// the organization, the rooms and the task, and the three repositories, which it prints for the owner to delete.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  certificateLine, challengeName, CNAME_TARGET, CONTENT_DOMAIN, contentNotFoundProblem, customHeaderProblems, defaultHostProblem, DEPLOY_GRANT, deployGrantProblem, dnsClient, dnsEnvProblem, EXIT, markerBody, parseArgs, PENDING_HOLD_MS, PLAN, RACE_SETTLE_MS, raceOutcome,
  REFUSED_BODIES, REFUSED_NAMES, requestProblem, reservedProblem, Results, resultUrlProblem, runLabel, runNames, runOutcome, secretProblem, SIGN_UPS, SITE, slowestLine, STAGING, STAGING_ORG, TEST_DOMAIN, unclaimedLine, unknownLabel, USAGE,
} from "./m6-custom-domain-staging-lib.mjs";
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
// Read once, and taken out of the environment, so nothing this process starts can inherit them.
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
const dnsProblem = dnsEnvProblem(process.env);
const dnsToken = process.env.OPSTER_DNS_TOKEN;
const zoneId = process.env.OPSTER_ZONE_ID;
delete process.env.OPSTER_DNS_TOKEN;
delete process.env.OPSTER_ZONE_ID;

const LABEL = runLabel(randomBytes(10));
const NAMES = runNames(LABEL);

// ---- the configuration, before anything is sent ----

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
{
  const grantProblem = deployGrantProblem(readText(options.contract ?? join(here, "../packages/contracts/openapi.yaml")));
  const reserved = reservedProblem(readText(options.coreHostnames ?? join(here, "../crates/core/src/hostnames.rs")));
  console.log(`M6's staging run for custom domains, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${SIGN_UPS.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of SIGN_UPS) console.log(`  - ${who}: ${why}`);
  console.log(`\nTest domain: ${TEST_DOMAIN}. This run's names: ${NAMES.main} (mapped and routed) and ${NAMES.race} (raced for). CNAME target: ${CNAME_TARGET}. GitHub organization: ${STAGING_ORG}.`);
  console.log(`Waits, in seconds: repository ${options.setupWait}, merge ${options.mergeWait}, release ${options.releaseWait}, claim ${options.claimWait}, active ${options.activeWait}, serve ${options.serveWait}, takedown ${options.takedownWait}; the pending hold ${PENDING_HOLD_MS / 1000}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const entry of PLAN) console.log(`  ${entry.id.padEnd(6)} ${entry.title}${entry.outOfScope ? ` [out of scope: ${entry.outOfScope}]` : ""}${entry.recordOnly ? ` [recorded, not judged: ${entry.recordOnly}]` : ""}`);
  }
  for (const problem of [grantProblem, reserved]) {
    if (problem) {
      console.error(`\nRefused: ${problem}. Nothing was sent.`);
      process.exit(EXIT.releaseNotOn);
    }
  }
  const missing = [secretProblem(signupSecret), dnsProblem].filter(Boolean);
  if (missing.length && !options.dryRun) {
    console.error(`\nRefused: ${missing.join("; ")}. Nothing was sent.`);
    process.exit(EXIT.refused);
  }
  if (options.dryRun) {
    console.log(`\nThe configuration is complete${missing.length ? `, but for: ${missing.join("; ")}` : ""}. Nothing was sent to staging, Cloudflare, GitHub or ${CONTENT_DOMAIN}.`);
    process.exit(missing.length ? EXIT.refused : 0);
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, ok, sleep } = await import("./lib.mjs");
const { cause, Halt, NotOn, refusedAs, releaseRun } = await import("./m6-release-run.mjs");

const RUN = `M6 custom domain ${new Date().toISOString().slice(0, 16)}`;
const run = releaseRun({ signupSecret, options, runName: RUN, workPrefix: "podster-m6-custom-domain-" });
run.secret(dnsToken);
run.secret(zoneId);
const { say, hostAsk, marker } = run;
const dns = dnsClient({ token: dnsToken, zoneId, root: NAMES.root, fetch: (...args) => fetch(...args), log: (line) => say(`     ${line}`) });
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
async function record(id, body) {
  if (run.stopping) throw new Halt("stopped by a signal");
  try {
    results.add(id, "recorded", await body());
  } catch (error) {
    if (error instanceof Halt) throw error;
    results.add(id, "recorded", `nothing recorded: ${cause(error)}`);
  }
}
const after = (...ids) => {
  const missing = ids.filter((id) => !results.passed(id));
  if (missing.length) throw new Error(`not shown: it needs ${missing.join(" and ")} to have passed`);
};

// ---- the run's state ----

let owner, admin, coder, team, task, host, releaseId;
/** The three rooms: A releases and maps the run's name; B and C race for another. */
const rooms = { a: null, b: null, c: null };
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });
/** Rooms where release may be on: clean-up switches it off. */
const releaseOn = new Set();
/** Rooms that may hold an open hostname request: clean-up removes it. */
const asked = new Set();

const hostnamePath = (room) => `/v1/workspaces/${room}/app-hostname`;
const configOf = async (room) => owner.must("GET", `/v1/workspaces/${room}/release-config`);
const requestOf = async (room) => (await owner.must("GET", hostnamePath(room))).request;
/** Asks for a name in `room` as its owner. Noted for clean-up before it is sent. */
async function askFor(room, hostname) {
  asked.add(room);
  const answer = await owner.dash("PUT", hostnamePath(room), { hostname });
  if (answer.status === 409 && answer.code === "hostname_reserved" && hostname.endsWith(`.${TEST_DOMAIN}`)) throw new NotOn(`${hostname} was refused hostname_reserved: ${TEST_DOMAIN} is one of the deployed API's reserved domains`);
  if (answer.status === 409 && answer.code === "hostname_unavailable") throw new NotOn("a name was refused hostname_unavailable: the deployment can't classify names (no content domain, or no Public Suffix List)");
  if (answer.status === 409 && answer.code === "release_not_available") throw new NotOn("a name was refused release_not_available: the release path isn't complete on staging");
  ok(answer.ok, `asking for ${hostname}: HTTP ${answer.status} ${answer.code ?? ""}`);
  const request = answer.body?.request;
  eq(requestProblem(request, { hostname, state: "pending", setup: "proof_pending" }), null, `the request for ${hostname}`);
  return request;
}
/** Polls a room's request until `done` accepts it, for at most `seconds`. */
const requestWithin = (seconds, what, room, done) => run.within(seconds, what, () => requestOf(room), done, 5000);
/** The custom name's marker, or the error its request ended in. */
async function customMarker() {
  try {
    return { answer: await marker(NAMES.main) };
  } catch (error) {
    return { error: cause(error) };
  }
}
/**
 * The certificate the custom name serves, read from one TLS connection with its name as SNI and certificate validation
 * on, as Node's default is. A handshake that fails validation answers its error's code, which is the finding.
 */
function certificateOf(name) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: name, port: 443, servername: name, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      resolve({ subject: cert?.subject, subjectaltname: cert?.subjectaltname, issuer: cert?.issuer, valid_from: cert?.valid_from, valid_to: cert?.valid_to, authorized: socket.authorized, authorizationError: socket.authorizationError ? String(socket.authorizationError) : null });
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ handshakeError: "timeout" });
    });
    socket.on("error", (error) => resolve({ handshakeError: String(error?.code ?? error?.name ?? "Error") }));
  });
}
/** Makes a room public with person review on, and switches release on there as the admin. */
async function publicWithRelease(room) {
  // A public room always has person review on (decision 159), so publishing is refused person_review_required without it.
  await owner.must("PUT", `/v1/workspaces/${room}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(room) });
  const published = await publisher.publish(owner, room);
  ok(published.ok, `making room ${room} public: HTTP ${published.status} ${published.code ?? ""}`);
  releaseOn.add(room);
  const on = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 });
  eq([on.enabled, on.set_by], [true, admin.id], `release in room ${room}`);
}

// ---- the run ----

async function main() {
  say("\n## the owner, the first room, and whether release answers");
  owner = await run.person("the rooms' owner");
  run.mask(owner.id, "[owner]");
  await owner.useNewOrg(`${RUN} team`);
  team = owner.org;
  run.leftBehind.push(`the run's organization ${team}`);
  rooms.a = await owner.createRoom(`${RUN} A`);
  run.leftBehind.push(`room ${rooms.a}`);
  {
    const config = await owner.dash("GET", `/v1/workspaces/${rooms.a}/release-config`);
    if (config.status === 404 && config.code === "not_found") throw new NotOn("the room's release configuration answers as a missing route: RELEASES isn't exactly true on staging");
    ok(config.ok, `the room's release configuration answered ${config.status} ${config.code ?? ""}`);
    const probe = await owner.dash("POST", `/v1/workspaces/${rooms.a}/releases`, { task_id: "tsk_e2e_probe", commit_sha: "0".repeat(40) });
    if (probe.status === 409 && probe.code === "release_not_available") throw new NotOn("a request is refused release_not_available: the release path isn't complete");
    refusedAs(probe, 409, "release_needs_public_room", "a request in a new, private room");
  }

  say("\n## the admin, the other rooms, the agent and the repositories");
  admin = await run.person("the rooms' admin");
  run.mask(admin.id, "[admin]");
  {
    const invited = await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" });
    await admin.must("POST", "/org-invitations/accept", { token: run.secret(invited.token) });
    admin.org = admin.actingOrg = team;
  }
  rooms.b = await owner.createRoom(`${RUN} B`);
  run.leftBehind.push(`room ${rooms.b}`);
  rooms.c = await owner.createRoom(`${RUN} C`);
  run.leftBehind.push(`room ${rooms.c}`);
  say(`     organization ${team}; rooms A ${rooms.a}, B ${rooms.b}, C ${rooms.c}`);
  for (const room of Object.values(rooms)) await run.addPerson(owner, team, admin, "admin", room);
  coder = await run.agentOf(owner, "coder");
  run.leftBehind.push(`agent ${coder.id}`);
  await owner.addAgent(rooms.a, coder);
  for (const [key, room] of Object.entries(rooms)) await run.setUpRepository(owner, room, `cd-${key}`);
  await run.give(owner, coder, "push", rooms.a);
  await run.give(owner, admin, "merge", rooms.a);
  task = await run.newTask({ owner, coder, reviewer: admin }, "site", rooms.a);
  await run.changeAndMerge({ owner, coder, merger: admin }, task, SITE);

  say("\n## release on in each room, and room A's release served");
  for (const room of Object.values(rooms)) await publicWithRelease(room);
  await run.give(owner, coder, DEPLOY_GRANT.action, rooms.a);
  {
    const requested = await coder.must("deploy_release", { workspace_id: rooms.a, task_id: task.id, commit_sha: task.mergeSha });
    eq([requested.state, requested.commit_sha], ["awaiting_approval", task.mergeSha], "the agent's release as asked for");
    releaseId = requested.id;
    const { seconds } = await run.approveAndServe({ owner, approver: admin }, task, releaseId);
    const config = await configOf(rooms.a);
    const at = defaultHostProblem(config.default_host);
    ok(!at.problem, at.problem);
    host = config.default_host;
    run.secret(at.label);
    eq(resultUrlProblem((await run.statusOf(owner, task)).release.result_url, host), null, "the result URL");
    eq(config.custom_host, null, "room A's custom host before any request");
    say(`     release ${releaseId} served after ${seconds} s at the app's default host`);
  }

  say("\n## refused names");
  await check("X15-1", async () => {
    for (const { body, status, code } of [...REFUSED_NAMES, ...REFUSED_BODIES]) {
      const answer = await owner.dash("PUT", hostnamePath(rooms.a), body);
      if (answer.status === 409 && answer.code === "hostname_unavailable") throw new NotOn("a name was refused hostname_unavailable: the deployment can't classify names");
      refusedAs(answer, status, code, `asking for ${JSON.stringify(body.hostname)}${Object.keys(body).length > 1 ? " with another field" : ""}`);
    }
    eq(await requestOf(rooms.a), null, "room A's request after the refusals");
    return `${REFUSED_NAMES.length} names and ${REFUSED_BODIES.length} bodies refused with their codes; room A holds no request`;
  });

  say(`\n## ${NAMES.main}: another room's challenge, and the CNAME, before room A asks`);
  {
    // Room B's value for the name: asked for and dropped at once, so B can't claim it, and published as a challenge
    // that isn't room A's. Published before A asks, so the name's TXT is never read missing, which a resolver would cache.
    const decoy = await askFor(rooms.b, NAMES.main);
    const dropped = await owner.dash("DELETE", hostnamePath(rooms.b), {});
    ok(dropped.ok && dropped.body?.request === null, `dropping room B's pending request: HTTP ${dropped.status} ${dropped.code ?? ""}`);
    await dns.txt(NAMES.main, decoy.challenge_value);
    await dns.cname(NAMES.main);
  }
  const requestA = await askFor(rooms.a, NAMES.main);
  const holdEnds = Date.now() + PENDING_HOLD_MS;
  say(`     room A asked for ${NAMES.main}: its challenge goes at ${challengeName(NAMES.main)}; held unpublished for ${PENDING_HOLD_MS / 1000} s`);

  say(`\n## the race for ${NAMES.race}, rooms B and C`);
  // A placeholder at the race's challenge name before either room asks: a room looks for its challenge as soon as it
  // asks, before the run can publish it, and a resolver caches a missing TXT for the zone's negative TTL (Cloudflare's
  // SOA minimum, 30 minutes by default), far past the wait. Run 45796822191 saw that: room C's challenge was still
  // unread 9 minutes after it was published. A placeholder is cached for DNS_TTL alone, as the decoy is for the main
  // name. It is no room's value, so it proves nothing.
  await dns.txt(NAMES.race, randomBytes(32).toString("hex"));
  // Cloudflare can take a moment to serve a new record; a room's first look before then would cache the miss.
  await run.pause(5000);
  const [raceB, raceC] = [await askFor(rooms.b, NAMES.race), await askFor(rooms.c, NAMES.race)];
  await dns.txt(NAMES.race, raceB.challenge_value);
  await dns.txt(NAMES.race, raceC.challenge_value);
  const raceStarted = Date.now();

  say("\n## before proof");
  await run.pause(Math.max(0, holdEnds - Date.now()));
  await check("X14-1", async () => {
    eq(requestProblem(await requestOf(rooms.a), { hostname: NAMES.main, state: "pending", setup: "proof_pending" }), null, "room A's request after the hold");
    eq((await configOf(rooms.a)).custom_host, null, "room A's custom host while pending");
    const { answer, error } = await customMarker();
    ok(error || answer.body !== markerBody(releaseId, task.mergeSha), `${NAMES.main} served room A's marker while its request was pending`);
    return `pending after ${Math.round(PENDING_HOLD_MS / 1000)} s with the CNAME and room B's value published; the name answered ${unclaimedLine(answer, error)}`;
  });

  await check("X15-2", async () => {
    const waitMs = Math.max(options.claimWait * 1000, RACE_SETTLE_MS);
    const left = Math.max(10, Math.round((raceStarted + waitMs - Date.now()) / 1000));
    const both = await run.within(left, "the race's outcome", async () => [await requestOf(rooms.b), await requestOf(rooms.c)], ([b, c]) => b?.state !== "pending" && c?.state !== "pending", 5000);
    const [b, c] = both.value;
    for (const [request, label] of [[b, "B"], [c, "C"]]) eq(request?.hostname, NAMES.race, `room ${label}'s request's name`);
    const outcome = raceOutcome(b, c);
    ok(!outcome.problem, outcome.problem);
    return `room ${outcome.winner.toUpperCase()} claimed ${NAMES.race}; the other was refused ${outcome.reason}; settled ${Math.round((Date.now() - raceStarted) / 1000)} s after both challenges were published`;
  });

  say(`\n## room A's own challenge for ${NAMES.main}`);
  await check("X26-1", async () => {
    after("X14-1");
    await dns.txt(NAMES.main, requestA.challenge_value);
    const { value, seconds } = await requestWithin(options.claimWait, "room A's claim", rooms.a, (r) => r?.state !== "pending");
    eq(requestProblem(value, { hostname: NAMES.main, state: "claimed" }), null, `room A's request${value?.end_reason ? ` (${value.end_reason})` : ""}`);
    return `room B's value didn't claim the name during the hold; room A was claimed ${seconds} s after it published its own`;
  });

  await check("X14-2", async () => {
    after("X26-1");
    const { value, seconds } = await requestWithin(options.activeWait, "Cloudflare reading the custom hostname active", rooms.a, (r) => r?.setup_status !== "provider_pending");
    eq(requestProblem(value, { hostname: NAMES.main, state: "claimed", setup: "active" }), null, "room A's request");
    eq((await configOf(rooms.a)).custom_host, NAMES.main, "room A's custom host");
    return `setup_status active ${seconds} s after the claim`;
  });

  await check("X14-3", async () => {
    after("X14-2");
    // Any answer but the marker naming this release is waited out: before the route, the name may answer an error or
    // nothing at all.
    const { seconds } = await run.within(options.serveWait, `${NAMES.main} serving release ${releaseId}`, () => customMarker(), ({ answer }) => answer?.status === 200 && answer.body === markerBody(releaseId, task.mergeSha), 5000);
    const read = await marker(NAMES.main);
    eq(read.body, markerBody(releaseId, task.mergeSha), "the marker on the custom name");
    const index = await hostAsk(`https://${NAMES.main}/`);
    eq([index.status, index.body], [200, SITE["site/index.html"]], "the index on the custom name");
    const problems = [...customHeaderProblems(read.headers).map((p) => `the marker: ${p}`), ...customHeaderProblems(index.headers).map((p) => `the index: ${p}`)];
    ok(problems.length === 0, problems.join("; "));
    return `the marker named release ${releaseId} and the merge commit within ${seconds} s of active; the index is the release's`;
  });

  await record("X14-4", async () => {
    after("X14-3");
    return certificateLine(await certificateOf(NAMES.main), NAMES.main);
  });

  say(`\n## removing ${NAMES.main}`);
  await check("X14-5", async () => {
    after("X14-2");
    const removed = await owner.dash("DELETE", hostnamePath(rooms.a), {});
    ok(removed.ok, `removing room A's name: HTTP ${removed.status} ${removed.code ?? ""}`);
    ok(["ending", "ended"].includes(removed.body?.request?.state), `the removal answered ${removed.body?.request?.state ?? "no request"}, not ending`);
    eq((await configOf(rooms.a)).custom_host, null, "room A's custom host once removed");
    const { seconds } = await run.within(options.takedownWait, `${NAMES.main} no longer serving the marker`, () => customMarker(), ({ answer }) => !answer || answer.body !== markerBody(releaseId, task.mergeSha));
    const last = await customMarker();
    return `the request is ${(await requestOf(rooms.a))?.state}; the name stopped serving the marker within ${seconds} s and answers ${unclaimedLine(last.answer, last.error)}`;
  });
}

// ---- clean-up ----

async function cleanUp() {
  const said = [];
  // Claims first, through the API: the room stops serving on the name, and its job deletes the custom hostname at
  // Cloudflare. Read first, and removed only if still open.
  for (const room of asked) {
    const read = await owner.dash("GET", hostnamePath(room)).catch(() => null);
    const state = read?.body?.request?.state;
    if (read?.ok && ["pending", "claimed"].includes(state)) {
      const removed = await owner.dash("DELETE", hostnamePath(room), {}).catch(() => null);
      const now = removed?.ok ? (removed.body?.request?.state ?? "gone") : null;
      said.push(now ? `room ${room}'s request for ${read.body.request.hostname} removed: ${now}` : `room ${room}'s request could NOT be removed (${removed ? `HTTP ${removed.status} ${removed.code ?? ""}` : "no answer"}): its owner removes it`);
    } else if (!read?.ok) said.push(`room ${room}'s request couldn't be read: its owner checks it`);
    else if (state) said.push(`room ${room}'s request is ${state}`);
  }
  // Then DNS: every record made, and anything a listing of a name it tried finds there.
  if (dns.tried.size) {
    const { left, unread, held } = await dns.removeAll().catch((error) => ({ left: [], unread: [...dns.tried], held: [`(${cause(error)})`] }));
    if (!left.length && !unread.length && !held.length) said.push(`every DNS record this run made under ${NAMES.root} is deleted, and a listing of each name finds none`);
    if (left.length) said.push(`DNS records are still listed at ${left.join(", ")}: the owner deletes them in ${TEST_DOMAIN}'s DNS`);
    if (unread.length) said.push(`${unread.join(", ")} couldn't be listed after the deletes: the owner checks ${TEST_DOMAIN}'s DNS`);
    if (held.length) said.push(`DNS records could NOT be deleted: ${held.join(", ")}`);
  }
  for (const room of releaseOn) {
    const config = await admin?.dash("GET", `/v1/workspaces/${room}/release-config`).catch(() => null);
    const off = config?.ok && config.body?.enabled ? await admin.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.body.version }).catch(() => null) : config;
    said.push(off?.ok && off.body?.enabled === false ? `release is off in room ${room}` : `release could NOT be switched off in room ${room}: its owner switches it off`);
  }
  try {
    const { left } = await publisher.stop();
    if (left) said.push(`${[...publisher.published.keys()].map((at) => `room ${at}`).join(" and ")} could NOT be made private again`);
  } catch (error) {
    said.push(`the rooms could NOT all be made private again (${cause(error)}): their owner makes them private`);
  }
  said.push(...(await run.cleanUpShared()));
  return said;
}

// SIGTERM, as GitHub Actions sends a few seconds after SIGINT when a run is cancelled or times out, and at most seconds
// before SIGKILL: no full clean-up fits. What would outlive the run and cost or expose most goes first, side by side:
// every DNS record the run made, and every open hostname request removed through the API (each a claim's custom
// hostname at Cloudflare). Then it exits 143. Left behind: release on, the rooms public, grants, the agent and the
// sessions, all named in docs/staging.md.
let terminating = false;
process.on("SIGTERM", () => {
  if (terminating) return;
  terminating = true;
  console.log("\nSIGTERM: removing DNS records and hostname requests, then exiting without the rest of clean-up.");
  const claims = [...asked].map((room) => owner?.dash("DELETE", hostnamePath(room), {}, { timeoutMs: 2000 }).catch(() => null));
  const bounded = Promise.race([Promise.all([dns.removeMade(), ...claims]), new Promise((done) => setTimeout(done, 2000))]);
  bounded.finally(() => {
    console.log(run.out(`SIGTERM clean-up: ${dns.made.size} DNS record(s) still held (${[...dns.made.values()].map((r) => `${r.type} ${r.name}`).join(", ") || "none"}); hostname requests asked to be removed in ${asked.size} room(s). Release, the rooms' publicity, grants, the agent and the sessions are left: see docs/staging.md.`));
    process.exit(143);
  });
});

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
      const fallback = problem ? null : contentNotFoundProblem(await hostAsk(`https://${CNAME_TARGET}/`));
      if (fallback) refusal = `the fallback origin ${CNAME_TARGET} wasn't the content Worker's not found, so the */* route may not be deployed: ${fallback}`;
    }
  } catch (error) {
    refusal = `whether release is on couldn't be read: ${cause(error)}`;
  }
  if (refusal) {
    console.error(run.out(`\nRefused: ${refusal}.\nNo sign-up was taken.`));
    run.removeWork();
    process.exit(EXIT.releaseNotOn);
  }
  say("     signed out: deploy_release is listed, and the content domain and its fallback origin answer with the content Worker's not found");
}
{
  let refusal = null;
  try {
    if (!(await dns.verify())) refusal = "the DNS token isn't active";
    else {
      const found = await dns.list(NAMES.main);
      if (!found) refusal = `the DNS token couldn't list a name in ${TEST_DOMAIN}'s zone: it needs Zone, DNS, Edit on that zone, and OPSTER_ZONE_ID must be its ID`;
      else if (found.length) refusal = `${NAMES.main} already has DNS records, so this run's label isn't fresh`;
    }
  } catch (error) {
    refusal = `the DNS token couldn't be checked: ${cause(error)}`;
  }
  if (refusal) {
    console.error(run.out(`\nRefused: ${refusal}.\nNo sign-up was taken, and nothing was written.`));
    run.removeWork();
    process.exit(EXIT.refused);
  }
  say(`     the DNS token is active and lists ${TEST_DOMAIN}'s zone; ${NAMES.main} holds no record`);
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
  say(`\nCustom domains aren't on with release on staging: ${notOn}. Sign-ups taken: ${run.signUpsAsked}.`);
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
