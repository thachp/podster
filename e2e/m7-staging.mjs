// M7's staging run, step 16 of docs/m7-plan.md: Runner against the staging deployment on two machines, the owner's Mac
// and Long's Windows machine under WSL2, each with its own Runner from `npx podster@test`, paired with its own agent and
// signed in to staging with its own account. Tasks go both ways, and each reviewer is the person who didn't run the task.
// First with the nudge off (the proof of concept), then with it on. It counts only with both people present. The setup
// sheet is docs/m7-two-person-run.md.
//
//   node m7-staging.mjs [--rehearsal [--two-machines]] [--half off|on|both] [--report <file>] [--dry-run]
//
// **A conductor, not an impersonator.** It never runs Runner, Docker or a browser, and never acts as either person:
// - It reads staging through one session only: that of the person at this terminal, the room's owner, who puts their own
//   session cookie in PODSTER_E2E_COOKIE_A. It sends that cookie to the staging gateway and nowhere else, never prints or
//   stores it, and never signs that session out (it's the person's own). It refuses PODSTER_E2E_COOKIE_B and
//   PODSTER_E2E_SIGNUP_SECRET: no second person's session, and no test person.
// - It writes nothing to staging. Every write, a task, a cancel, a review, a grant taken back, a nudge switched on, is a
//   person's own, in the web app or at their own Runner, when a prompt asks for it.
// - It asks each person for what only they can do or see, and records their answer as y, n, a count, an ID or a word:
//   never free text, so nothing a person types can carry a secret into the report.
// - The nudge half sends four small requests to each Runner's own public nudge address, which that person types in, to
//   show the refusals of R-03 and R-16, and one more after Runner stops, for R-15. Nothing else leaves this machine but
//   reads of staging.
//
// It records each criterion of the gate's map that staging shows, R-01 to R-42 there, as PASS, FAIL or NOT SHOWN, with
// each clause and what's left to local tests, and the second machine's WSL2 record. The report goes under e2e/, IDs
// only: no person ID, email, cookie or token, which it checks before writing. It's written after every step, so a run
// that stops keeps what it showed.
//
// `--rehearsal` is one person and one machine: every step that needs the second person is NOT SHOWN, and the report is a
// rehearsal's, never the gate's. `--rehearsal --two-machines` runs every step on both machines, as when one person drives
// both or the two try it out first; it is still a rehearsal's report. A gate run needs a terminal, so its answers can't
// come from a pipe.
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  CRITERIA, criteriaFor, defaultReportName, EXIT, exitCode, findTagged, gateProblem, GIT_CONFIG_CHECK, judgeAcceptedFirst, judgeAnswer, judgeCanceled, judgeChange, judgeClosed, judgeCompletedByReviewer, judgeIssuanceScoped,
  judgeLinked, judgeLongRun, judgeNoAdminAudit, judgeNoMergeByAgent, judgeNoSubmission, judgeNotRun, judgeNothingAfterEnd, judgeNudgeConsent, judgeOfflineThenAccepted, judgeOneAccept, judgePairing, judgePlainRoles, judgeRefused, judgeWrongCode, addressProblem, sameEndpoint, SHOWN_ELSEWHERE, judgeSubmissions, judgeZero,
  LOCAL_SCAN, makeTag, NPX, NUDGE_HALF_INTERVAL_S, NUDGE_PICKUP_MS, OVERSIZED_BYTES, parseArgs, POLL_MS, PORT_CHECK, readAnswer, reportProblems, Results, secretHits, STAGING, TEARDOWN_COUNT, taskText, USAGE, WHO, WSL2,
} from "./m7-staging-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  console.error(`${parsed.error}.\n\n${USAGE}`);
  process.exit(EXIT.refused);
}
const options = parsed.options;
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (options.dryRun) {
  console.log(`M7's staging run, the plan only (dry run: nothing is read or sent). Half: ${options.half}.\n`);
  for (const id of criteriaFor(options.half)) {
    const c = CRITERIA[id];
    console.log(`${id}  ${c.title}`);
    for (const [name, clause] of Object.entries(c.clauses)) if (options.half === "both" || clause.half === options.half) console.log(`      ${name.padEnd(20)} [${clause.how}, nudge ${clause.half}] ${clause.text}`);
    console.log(`      left to local tests: ${c.local}`);
  }
  console.log(`\nThe second machine's WSL2 record: ${Object.values(WSL2).join("; ")}.`);
  console.log(`\nShown elsewhere, per the gate's map:\n${Object.entries(SHOWN_ELSEWHERE).map(([id, why]) => `${id}  ${why}`).join("\n")}`);
  process.exit(0);
}

const standin = globalThis.__podsterM7Standin === true;
const problem = gateProblem({ rehearsal: options.rehearsal, stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, standin });
if (problem) {
  console.error(`Refused: ${problem}. Nothing was read or sent.`);
  process.exit(EXIT.refused);
}

const cookie = process.env.PODSTER_E2E_COOKIE_A;
const rehearsal = options.rehearsal;
/** One person and one machine: a rehearsal without --two-machines. */
const solo = rehearsal && !options.twoMachines;
const halves = options.half === "both" ? ["off", "on"] : [options.half];
const reportPath = options.report ? (isAbsolute(options.report) ? options.report : join(process.cwd(), options.report)) : join(here, defaultReportName(rehearsal));
const results = new Results({ kind: rehearsal ? "rehearsal" : "gate", half: options.half });
const started = new Date().toISOString();
const scriptSha = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);
/** Strings that must never reach the output or the report: the session, and the conductor's own person ID once read. */
const held = [cookie];
const personIds = [];
let stopped = false;

// ---- output: every line is scrubbed of what's held ----

const scrub = (text) => held.reduce((t, s) => (s && s.length >= 8 ? t.split(s).join("[held]") : t), String(text));
const say = (text = "") => console.log(scrub(text));
const section = (name) => say(`\n## ${name}`);

function writeReport(note) {
  const report = results.report({ started, finished: new Date().toISOString(), script_sha256_16: scriptSha, stopped, note: note ?? null, standin });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const problems = reportProblems(text, { exact: held, personIds });
  if (problems.length) {
    console.error(`The report wasn't written: it would have held ${problems.join(", ")}. Nothing was saved.`);
    return false;
  }
  writeFileSync(reportPath, text);
  return true;
}

class Stop extends Error {}

// ---- prompts ----

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
let inputEnded = false;
async function line(question) {
  process.stdout.write(question);
  if (inputEnded) throw new Stop("no more answers");
  const next = await lines.next();
  if (next.done) {
    inputEnded = true;
    throw new Stop("no more answers");
  }
  if (!process.stdin.isTTY) process.stdout.write("\n");
  return next.value;
}

/**
 * Asks one person (or both) and returns their answer, or null for "skip". The prompt names who answers: at the gate,
 * the person at this terminal types what the other person reads off their own machine.
 */
async function ask(who, text, kind = "enter") {
  if (solo && who === "second") return null;
  say(`\n[${WHO[who]}] ${text}`);
  for (;;) {
    const answer = readAnswer(kind, await line(kind === "enter" ? "  Press Return when done (skip, stop): " : `  ${kindHint(kind)}: `));
    if (answer.stop) throw new Stop("stopped by a person");
    if (answer.skip) return null;
    if (answer.again) {
      say(`  Please type ${answer.again}.`);
      continue;
    }
    return answer.value;
  }
}
const kindHint = (kind) => ({ yn: "y or n", count: "the number", present: "type present", accepted: "type accepted", version: "Runner's version", keystore: "the key store", machine: "first or second", url: "the https:// address" })[kind] ?? `the ${kind} ID`;

/** Each machine in this run: both, but for a rehearsal on one machine. */
const machines = () => (solo ? ["first"] : ["first", "second"]);
const other = (m) => (solo ? "first" : m === "first" ? "second" : "first");
const note = (criterion, clause, result, machine) => {
  results.record(criterion, clause, result, machine);
  say(`  ${result.status.padEnd(9)} ${criterion} ${clause}${machine ? ` (${machine})` : ""}${result.detail ? `: ${scrub(result.detail)}` : ""}`);
};
const rehearsalOnly = (criterion, clause, machine) => note(criterion, clause, { status: "NOT SHOWN", detail: "needs the second person (rehearsal)" }, machine);

// ---- staging, read through the conductor's own session ----

// Under the self-test's stand-in no wait is real: its room moves on at each read.
const sleep = (ms) => new Promise((done) => setTimeout(done, standin ? 0 : ms));
async function api(path) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${STAGING}/api${path}`, { headers: { cookie, origin: STAGING, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt < 3) {
        await sleep(5_000);
        continue;
      }
      throw new Error(`GET ${path.split("?")[0]}: ${error?.name ?? "error"}`);
    }
    // A read is safe to repeat: a brief outage of staging shouldn't end a three-hour run.
    if (res.status >= 500 && attempt < 3) {
      await sleep(5_000);
      continue;
    }
    if (res.status === 429 && attempt < 5) {
      await sleep(Math.min(60, Number(res.headers.get("retry-after")) || 10) * 1000);
      continue;
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, code: body?.error?.code };
  }
}
async function must(path) {
  const res = await api(path);
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} answered ${res.status} ${res.code ?? ""}`);
  return res.body;
}

let room = null;
/** The room's events so far, by seq. Only the room's owner or admins may read them. */
const events = [];
async function refreshEvents() {
  for (let pages = 0; pages < 200; pages++) {
    const after = events.at(-1)?.seq ?? 0;
    const page = await must(`/v1/workspaces/${room}/events?after=${after}`);
    if (!page.events?.length) return events;
    events.push(...page.events.filter((e) => e.seq > after));
  }
  throw new Error("the room's events ran past 200 pages");
}
const lastSeq = async () => (await refreshEvents()).at(-1)?.seq ?? 0;
const taskEvents = async (task) => (await refreshEvents()).filter((e) => e.task_id === task).sort((a, b) => a.seq - b.seq);
const taskDetail = (task) => must(`/v1/workspaces/${room}/tasks/${task}`);

async function audit() {
  const entries = [];
  let after = 0;
  for (let pages = 0; pages < 100; pages++) {
    const page = await must(`/v1/workspaces/${room}/audit?after=${after}`);
    entries.push(...(page.audit ?? []));
    if (!page.next_cursor) return entries;
    after = page.next_cursor;
  }
  return entries;
}

/** Polls `test` until it gives a value, `ms` runs out (null), or a person stops the run. */
async function until(what, test, ms, every = 10_000) {
  const deadline = Date.now() + ms;
  let told = 0;
  for (let tries = 1; ; tries++) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline || (standin && tries >= 50)) {
      say(`  Gave up waiting for ${what} after ${Math.round(ms / 60_000)} min.`);
      return null;
    }
    if (Date.now() - told > 60_000) {
      say(`  Waiting for ${what} (up to ${Math.round((deadline - Date.now()) / 60_000)} more min)…`);
      told = Date.now();
    }
    await sleep(every);
  }
}

/** The task a person made with the tag in its title: found in the room's list, or typed in after 3 minutes. */
async function findTask(tag, maker) {
  const found = await until(`the task tagged ${tag}`, async () => {
    const listed = await must(`/v1/workspaces/${room}/tasks?order=newest`);
    const hit = findTagged(listed.tasks, tag);
    if (hit?.duplicate) throw new Error(`${hit.duplicate} tasks carry the tag ${tag}`);
    return hit;
  }, 3 * 60_000, 5_000);
  if (found) return found.id;
  return ask(maker, `The task tagged ${tag} wasn't found in the room. Type its ID, from its address in the web app.`, "task");
}

const statusIs = (task, statuses) => async () => {
  const detail = await taskDetail(task);
  return statuses.includes(detail.task.status) ? detail : null;
};
const hasEvent = (task, type, actor) => async () => (await taskEvents(task)).find((e) => e.type === type && (!actor || e.actor_id === actor)) ?? null;

// ---- the run ----

const agents = {};
const tasks = {};
const randomTag = () => randomBytes(3).toString("hex");
/** Which person a task's Runner belongs to, and the agent IDs, by machine. */
const agentList = () => Object.values(agents);

/** Asks the offering person to make a task in the web app, assigned to `runner`'s agent with themselves as reviewer. */
async function offer(step, runner, { label = step, extra = "" } = {}) {
  const maker = other(runner);
  const tag = makeTag(label, randomTag());
  const text = taskText(step, tag, extra);
  const made = await ask(maker, `In the room, make a task:\n    title:        ${text.title}\n    instructions: ${text.instructions}\n    assignee:     the ${runner} person's agent, ${agents[runner]}\n    reviewer:     yourself`);
  if (!made) return null;
  const id = await findTask(tag, maker);
  if (id) {
    tasks[label] = id;
    results.ids.tasks[label] = id;
    say(`  task ${label}: ${id}`);
  }
  writeReport();
  return id;
}

/** Judges a finished run's task: accepted first, one accept, submissions, its change, scoped issuance and its events. */
async function judgeRun(label, runner) {
  const task = tasks[label];
  const agent = agents[runner];
  if (!task) return;
  const ev = await taskEvents(task);
  const detail = await taskDetail(task);
  note("R-05", "acceptedFirst", judgeAcceptedFirst(ev, agent), label);
  note("R-06", "oneAccept", judgeOneAccept(ev, agent), label);
  note("R-12", "noDuplicates", judgeSubmissions(ev), label);
  note("R-18", "linked", judgeLinked(ev, agent), label);
  note("R-32", "scoped", judgeIssuanceScoped(ev, agent), label);
  note("R-34", "prShape", judgeChange(detail.change), label);
  note("R-35", "verified", judgeChange(detail.change), label);
  const hits = secretHits(detail, [cookie]);
  note("R-14", "noCredentials", hits.length ? { status: "FAIL", detail: hits.join(", ") } : { status: "PASS", detail: "none" }, label);
  note("R-33", "serverClean", hits.length ? { status: "FAIL", detail: hits.join(", ") } : { status: "PASS", detail: "none" }, label);
}

/** The reviewer verifies; then: completed by the reviewer, no merge by an agent, nothing issued after. */
async function review(label, runner, { requestChanges = false } = {}) {
  const task = tasks[label];
  if (!task) return;
  const reviewer = other(runner);
  const notMerged = await ask(reviewer, `Open the pull request of task ${task} on GitHub. Is it open, with its head on a branch other than the default, and not merged by any agent?`, "yn");
  note("R-34", "notMerged", judgeAnswer(notMerged), label);
  const tests = await ask(reviewer, `Does the submission of task ${task} show its test outcomes as passed, failed or not run (here, not run)?`, "yn");
  note("R-31", "testsReported", judgeAnswer(tests), label);
  if (requestChanges) return;
  await ask(reviewer, `Verify task ${task} in the web app (approve its submission).`);
  const done = await until(`task ${task} completed`, statusIs(task, ["completed"]), 10 * 60_000);
  const ev = await taskEvents(task);
  const now = done?.task ?? (await taskDetail(task)).task;
  if (solo) rehearsalOnly("R-14", "otherReviewer", label);
  else note("R-14", "otherReviewer", judgeCompletedByReviewer(ev, now, { runnerPerson: runner, reviewerIsConductor: now.reviewer === personIds[0] }), label);
  note("R-14", "noMerge", judgeNoMergeByAgent(ev, agentList()), label);
  note("R-41", "nothingAfterEnd", judgeNothingAfterEnd(ev), label);
}

/** Waits for an offered task to be accepted and submitted by `runner`'s Runner, answering its questions as it goes. */
async function runToSubmission(label, runner, { askFirst, holds, minutes = 30 }) {
  const task = tasks[label];
  if (!task) return null;
  if (askFirst) {
    const asked = await ask(runner, `Runner shows an ask screen for task ${task}. Did it show before anything ran? Then answer y on Runner's screen.`, "yn");
    note("R-05", "askScreen", judgeAnswer(asked), `${label}`);
  }
  await until(`task ${task} accepted`, hasEvent(task, "task.accepted", agents[runner]), 10 * 60_000);
  if (holds) {
    const pushAsked = await ask(runner, `When the run finishes, Runner asks "Push the task branch and open its pull request?" for task ${task}, because the room holds outputs (or the repository is public). Did it ask? Then answer y there.`, "yn");
    note("R-31", "held", judgeAnswer(pushAsked), label);
  }
  return until(`task ${task} submitted`, statusIs(task, ["submitted", "completed"]), minutes * 60_000, 15_000);
}

async function setup() {
  section("Who is here");
  const me = await must("/v1/me");
  if (typeof me?.id === "string") {
    personIds.push(me.id);
    held.push(me.id);
  }
  say("The session at this terminal was accepted. Its person is recorded as the first person, by role only.");
  await ask("first", "Confirm you are at this terminal and at your own Runner's machine.", "present");
  if (!solo) await ask("second", "Confirm you are present, at your own Windows machine with WSL2, and signed in to staging in your own browser.", "present");

  section("The room");
  room = await ask("first", "Type the room's ID, from its address in the web app (/w/ws_…/). Use a room you own, with a linked repository under podsterdev; a private repository is best (docs/m7-two-person-run.md).", "room");
  if (!room) throw new Stop("no room");
  results.ids.room = room;
  const info = await must(`/v1/workspaces/${room}`);
  if (info.policy_version == null) throw new Error("this session doesn't manage the room's access: the room's owner runs the conductor");
  const repo = await api(`/v1/workspaces/${room}/repository`);
  results.facts.repository_linked = Boolean(repo.ok && repo.body?.repository);
  say(`  The room's repository: ${results.facts.repository_linked ? "linked" : "NOT linked (the run's pull requests need one)"}.`);
  results.facts.repository_private = await ask("first", "Is the room's repository private on GitHub? (With a public one, Runner asks before every push; answer y each time.)", "yn");

  section("Install and pair, each person on their own machine");
  for (const m of machines()) {
    const version = await ask(m, `In a terminal on your machine${m === "second" ? " (inside your WSL2 distro)" : ""}, run: ${NPX} --help\n  Type the version npx installed, as \`npm view podster@test version\` prints it.`, "version");
    results.facts[`runner_version_${m}`] = version;
    const refused = await ask(m, `Before pairing, run: ${NPX} run --home ~/podster-m7-empty   (an empty folder). Did it refuse to run, with no pairing, and run nothing? Then delete that folder.`, "yn");
    note("R-01", "unpaired", judgeAnswer(refused), m);
    await ask(m, `In the web app, open your own agents, add an agent for this machine and start its pairing. Then run: ${NPX} pair --agent <agt_…>${m === "first" ? "\n  When it asks for the code, first paste a WRONG one (change one character), for R-26; if Runner stops, run pair again and paste the right one." : "   and paste the code when asked."} Approve the key and confirm in Podster.`);
    note("R-25", "fingerprint", judgeAnswer(await ask(m, "Did the fingerprint Runner showed match the one Podster showed, before you confirmed?", "yn")), m);
    agents[m] = await ask(m, `Run: ${NPX} status   and type the agent ID it prints.`, "agent");
    if (!agents[m]) throw new Stop(`no agent for the ${m} machine`);
    results.ids.agents[m] = agents[m];
  }
  // The pairing as its starter reads it, through the gateway's own pairing route; the other person's isn't readable.
  const pairing = await api(`/pairing/${agents.first}`);
  note("R-25", "activated", pairing.ok ? judgePairing(pairing.body) : { status: "NOT SHOWN", detail: `HTTP ${pairing.status}` });
  note("R-26", "wrongCode", pairing.ok ? judgeWrongCode(pairing.body) : { status: "NOT SHOWN", detail: `HTTP ${pairing.status}` });
  note("R-27", "proofs", { status: "NOT SHOWN", detail: "a forged or replayed proof needs a hostile client, which this run doesn't run" });
  if (solo) rehearsalOnly("R-28", "otherAccount");
  else {
    const theirs = await api(`/pairing/${agents.second}`);
    note("R-28", "otherAccount", theirs.status === 404 ? { status: "PASS", detail: "not found" } : { status: "FAIL", detail: `HTTP ${theirs.status}` });
  }
  const before = (await must(`/v1/workspaces/${room}`)).members ?? [];
  const early = machines().filter((m) => before.some((x) => x.principal_id === agents[m]));
  const admitted = early.length ? { status: "FAIL", detail: `the ${early.join(" and ")} agent was in the room before anyone added it` } : { status: "PASS", detail: "neither agent in the room" };
  note("R-25", "notInRoomYet", admitted);
  note("R-28", "admitsNothing", admitted);
  if (!solo && agents.first === agents.second) throw new Error("both machines named the same agent: each person pairs their own");
  await ask("first", `Add each agent to the room with a member role${solo ? "" : ": invite the second person's organization, so its agent joins"}. Once each agent is in, give each a push grant on the room's repository (Settings, then Repository).`);
  if (!solo) await ask("second", "Accept the room's invitation for your organization, adding your Runner's agent. Tell the first person when it's done, for the push grant.");
  const members = await until("both agents in the room", async () => {
    const listed = (await must(`/v1/workspaces/${room}`)).members ?? [];
    return machines().every((m) => listed.some((x) => x.principal_id === agents[m])) ? listed : null;
  }, 15 * 60_000);
  if (!members) throw new Error("an agent isn't a member of the room after 15 minutes");
  if (!solo) {
    const orgOf = (m) => members.find((x) => x.principal_id === agents[m])?.org_id;
    results.facts.agents_in_distinct_orgs = Boolean(orgOf("first") && orgOf("second") && orgOf("first") !== orgOf("second"));
    // Two people bring two organizations: one person with two agents, or two accounts in one organization, isn't the gate.
    if (!rehearsal && !results.facts.agents_in_distinct_orgs) throw new Error("both agents are in one organization: the gate's run needs each person's agent from their own organization");
  }
  note("R-04", "plainRole", solo ? { status: "NOT SHOWN", detail: "one agent only (rehearsal)" } : judgePlainRoles(members, agentList()));

  section("Run policy");
  for (const m of machines()) {
    await ask(m, `Run: ${NPX} setup --room ${room}   Keep mode "ask" and outputs "hold" for now, and set day_caps.spend_micro_usd to 8000000 (8 USD; day caps cover the whole machine, so the run isn't stopped partway).${solo ? "" : m === "second" ? " Leave the first person's organization OUT of allowed_orgs for now: the scope check comes first." : " Say yes to adding the second person's organization to allowed_orgs."}\n  Then start: ${NPX} run --provider-key-file <your key file>   (no nudge flags).`);
  }
  if (!solo) {
    const checked = await ask("second", "Did Runner's log show `adapter.platform` `linux_checked` before it ran anything (its Linux checks passed)?", "yn");
    results.wsl2.linux_checked = checked;
    results.wsl2.key_store = await ask("second", `Which key store line did Runner print? Type macos_keychain, secret_service or file.`, "keystore");
  }
}

async function offHalf() {
  section("The nudge off: no listening port (R-22)");
  for (const m of machines()) {
    const count = await ask(m, `With Runner running, run: ${PORT_CHECK[m]}   How many lines did it count?`, "count");
    note("R-22", "noPort", judgeZero(count), m);
  }
  const endpoint = await api(`/v1/agents/${agents.first}/a2a-endpoint`);
  note("R-22", "noEndpoint", endpoint.ok ? (endpoint.body == null || endpoint.body.endpoint === null || endpoint.body.url == null ? { status: "PASS", detail: "none" } : { status: "FAIL", detail: "an endpoint is registered" }) : { status: "NOT SHOWN", detail: `HTTP ${endpoint.status}` });
  if (solo) rehearsalOnly("R-22", "noEndpointSecond");
  else note("R-22", "noEndpointSecond", judgeAnswer(await ask("second", "In the web app, open your agent's page. Does it show no A2A endpoint and no nudge?", "yn")));

  section("Out of scope (R-20)");
  if (solo) rehearsalOnly("R-20", "outOfScope");
  else {
    const scope = await offer("scope", "second");
    if (scope) {
      const mark = await lastSeq();
      say(`  Waiting ${Math.round((3 * POLL_MS) / 1000)} s, three of Runner's polls, to see it isn't taken.`);
      await sleep(3 * POLL_MS);
      note("R-20", "outOfScope", judgeNotRun(await taskEvents(scope), agents.second, { afterSeq: mark - 1 }));
      await ask("first", `Cancel task ${scope} in the web app.`);
    }
    await ask("second", `Now add the first person's organization to allowed_orgs for the room in policy.json (raise revision), as Runner's README says. Runner reads it at the next task.`);
  }

  section("Ask-first runs, both directions (R-05, R-06, R-14, R-18, R-31, R-32 to R-35)");
  for (const runner of machines()) {
    const label = `ask-${runner}`;
    if (!(await offer("ask", runner, { label }))) continue;
    await runToSubmission(label, runner, { askFirst: true, holds: true });
    await judgeRun(label, runner);
    await review(label, runner);
  }

  section("A hard kill between the pull request and the submission (R-12, R-35, R-06)");
  const crashRunner = solo ? "first" : "second";
  if (await offer("crash", crashRunner)) {
    const task = tasks.crash;
    await ask(crashRunner, `Approve the run of task ${task} at Runner's ask screen, and answer y to its push question. Watch Runner's log: as soon as it shows \`repo.publish\` \`pull_request\` for this task, kill Runner hard, a crash and not Ctrl-C or \`stop\`: in another terminal, list its processes with   ps -eo pid,args | grep '[p]odster' | grep ' run'   and kill -9 each PID that is Runner's (never this conductor's).`);
    // Where the kill landed: R-35's case is a pull request on record and no submission yet.
    const killSeq = await lastSeq();
    const submittedBefore = (await taskEvents(task)).some((e) => e.type === "task.submitted");
    const prBefore = (await taskDetail(task)).change?.pr_number != null;
    await ask(crashRunner, `Start Runner again: ${NPX} run --provider-key-file <your key file>`);
    await until(`task ${task} submitted`, statusIs(task, ["submitted", "completed"]), 20 * 60_000, 15_000);
    await judgeRun("crash", crashRunner);
    note("R-35", "crashBetween", submittedBefore ? { status: "NOT SHOWN", detail: `the submission came before the kill (seq ${killSeq})` } : !prBefore ? { status: "NOT SHOWN", detail: "the kill came before the pull request was on record" } : judgeSubmissions(await taskEvents(task), { max: 1 }));
    note("R-12", "uncertainShown", judgeAnswer(await ask(crashRunner, `After the restart, did Runner pick task ${task} up from its own record (reconcile) rather than ask to start it fresh?`, "yn")));
    note("R-06", "oneLocalRun", judgeAnswer(await ask(crashRunner, `Run: ${NPX} status   Does it show one run for task ${task}, not two?`, "yn")));
    note("R-35", "onePr", judgeAnswer(await ask(other(crashRunner), `On GitHub, is there exactly one pull request for task ${task}'s branch?`, "yn")));
    await review("crash", crashRunner);
  }

  section("Offline, then a cancel during a run (R-15, R-22, R-07, R-13, R-24, R-41)");
  const offRunner = solo ? "first" : "second";
  note("R-15", "stopSeen", judgeAnswer(await ask(offRunner, "Stop your Runner with Ctrl-C. Did it say it stopped?", "yn")));
  const stoppedSeq = await lastSeq();
  await offer("offline", offRunner);
  await offer("revoked", offRunner, { label: "revoked" });
  if (tasks.revoked) await ask(other(offRunner), `While that Runner is stopped, cancel task ${tasks.revoked} in the web app.`);
  const restartedSeq = await lastSeq();
  await ask(offRunner, `Start Runner again: ${NPX} run --provider-key-file <your key file>`);
  if (tasks.offline) {
    const task = tasks.offline;
    await ask(offRunner, `Approve the run of task ${task} at Runner's ask screen.`);
    const accepted = await until(`task ${task} accepted`, hasEvent(task, "task.accepted", agents[offRunner]), 10 * 60_000);
    note("R-15", "durable", judgeOfflineThenAccepted(await taskEvents(task), agents[offRunner], { stoppedSeq, restartedSeq }));
    note("R-22", "offline", judgeOfflineThenAccepted(await taskEvents(task), agents[offRunner], { stoppedSeq, restartedSeq }));
    note("R-29", "sameIdentity", accepted ? { status: "PASS", detail: `accepted after the restart by ${agents[offRunner]}, the agent paired at the start` } : { status: "FAIL", detail: "not accepted by the paired agent after the restart" });
    if (accepted) {
      await ask(other(offRunner), `While task ${task} is running (before Runner asks to push), cancel it in the web app.`);
      await until(`task ${task} canceled`, statusIs(task, ["canceled"]), 5 * 60_000, 5_000);
      await sleep(POLL_MS);
      const ev = await taskEvents(task);
      const detail = await taskDetail(task);
      note("R-13", "canceled", judgeCanceled(ev, detail.task));
      note("R-05", "afterCancel", judgeCanceled(ev, detail.task));
      note("R-24", "canceled", judgeNoSubmission(ev));
      note("R-41", "nothingAfterEnd", judgeNothingAfterEnd(ev), "offline");
      note("R-13", "disclosed", judgeAnswer(await ask(offRunner, `Did Runner say task ${task}'s run was canceled, and whether anything was pushed?`, "yn")));
      note("R-13", "stopped", judgeZero(await ask(offRunner, `Run: ${TEARDOWN_COUNT}   What number did it print?`, "count")));
      await ask(offRunner, "If Runner still asks to push the canceled task, answer n.");
    }
  }
  if (tasks.revoked) {
    note("R-07", "canceledWhileOffline", judgeNotRun(await taskEvents(tasks.revoked), agents[offRunner]));
    note("R-07", "noLocalRun", judgeAnswer(await ask(offRunner, `Does Runner's log show no run for task ${tasks.revoked}?`, "yn")));
  }

  section("A run over its cap (R-20, R-24)");
  const capRunner = "first";
  await ask(capRunner, `In policy.json, set caps.turns to 2 (raise revision). Caps cover the whole machine, every room. Runner reads it at the next task.`);
  if (await offer("budget", capRunner)) {
    const task = tasks.budget;
    await ask(capRunner, `Approve the run of task ${task} at Runner's ask screen.`);
    await until(`task ${task} accepted`, hasEvent(task, "task.accepted", agents[capRunner]), 10 * 60_000);
    note("R-20", "budgetStop", judgeAnswer(await ask(capRunner, `Did the run stop on its turn cap, and did Runner report the cap?`, "yn")));
    await sleep(POLL_MS);
    note("R-24", "budget", judgeNoSubmission(await taskEvents(task)));
    await ask(capRunner, `Set caps.turns back to what it was (raise revision), and cancel task ${task} in the web app if it's still open.`);
  }

  section("Unattended runs, both directions (R-20, R-31, R-38)");
  for (const m of machines()) {
    await ask(m, `In policy.json, set this room's mode to "unattended" and outputs to "share" (raise revision). Then accept the trust statement: ${NPX} trust ${room}   Read it, and type accept.`);
    const ok = await ask(m, `Did \`trust\` record your acceptance?`, "yn");
    results.facts[`trust_accepted_${m}`] = ok;
  }
  for (const runner of machines()) {
    const label = `unattended-${runner}`;
    if (!(await offer("unattended", runner, { label }))) continue;
    await until(`task ${tasks[label]} accepted`, hasEvent(tasks[label], "task.accepted", agents[runner]), 10 * 60_000);
    const unprompted = await ask(runner, `Did task ${tasks[label]} start with no ask screen and no question at Runner's terminal?`, "yn");
    note("R-20", "unprompted", judgeAnswer(unprompted), runner);
    note("R-38", "unprompted", judgeAnswer(unprompted), runner);
    if (results.facts.repository_private === false) await ask(runner, "The repository is public, so Runner asks before pushing: answer y.");
    await until(`task ${tasks[label]} submitted`, statusIs(tasks[label], ["submitted", "completed"]), 30 * 60_000, 15_000);
    await judgeRun(label, runner);
    note("R-38", "underRoot", judgeAnswer(await ask(runner, `Is task ${tasks[label]}'s folder under your policy's workspace_root?`, "yn")), runner);
    const gitCount = await ask(runner, `Run: ${GIT_CONFIG_CHECK}   (with the task's folder). What number did it print?`, "count");
    note("R-38", "noToken", judgeZero(gitCount), runner);
    note("R-33", "gitConfig", judgeZero(gitCount), runner);
    if (runner === "first") {
      // One direction also shows a rerun after changes: the reviewer asks for changes, and the Runner decides again.
      await review(label, runner, { requestChanges: true });
      await ask(other(runner), `Request changes on task ${tasks[label]} in the web app, asking for one more line in the file.`);
      await until(`task ${tasks[label]}'s second submission`, async () => (await taskEvents(tasks[label])).filter((e) => e.type === "task.submitted").length >= 2, 30 * 60_000, 15_000);
      note("R-20", "rerunDecided", judgeAnswer(await ask(runner, `Did Runner's log show a new policy evaluation for task ${tasks[label]} before the rerun?`, "yn")));
      note("R-20", "rerunSubmitted", judgeSubmissions(await taskEvents(tasks[label])));
      const n = (await taskEvents(tasks[label])).filter((e) => e.type === "task.submitted").length;
      if (n < 2) note("R-20", "rerunSubmitted", { status: "FAIL", detail: `${n} submission(s)` });
    }
    await review(label, runner);
    const ev = await taskEvents(tasks[label]);
    const detail = await taskDetail(tasks[label]);
    const ended = detail.task.status === "completed" && judgeChange(detail.change).status === "PASS" && ev.some((e) => e.type === "task.accepted" && e.actor_id === agents[runner]);
    note("R-31", "endToEnd", ended ? { status: "PASS", detail: "accepted, PR verified, completed by the reviewer" } : { status: "FAIL", detail: `status ${detail.task.status}` }, runner);
  }

  section("A push grant taken back (R-39)");
  const grantRunner = solo ? "first" : "second";
  await ask("first", `In the room's repository settings, take back the ${grantRunner} person's agent's push grant.`);
  const grantSeq = await lastSeq();
  if (await offer("grant", grantRunner)) {
    say(`  Waiting ${Math.round((4 * POLL_MS) / 1000)} s for that Runner to see it.`);
    await sleep(4 * POLL_MS);
    note("R-39", "noIssue", judgeNotRun(await taskEvents(tasks.grant), agents[grantRunner], { afterSeq: grantSeq, allowAccept: true }));
    note("R-39", "refusedLocally", judgeAnswer(await ask(grantRunner, `Run: ${NPX} why ${tasks.grant}   Does it name a repository access refusal?`, "yn")));
    await ask("first", `Give the push grant back, and cancel task ${tasks.grant} in the web app.`);
  }

  section("A run longer than an hour (R-40, R-41, R-42)");
  const longRunner = solo ? "first" : await ask("first", "Which machine runs the long task? (second shows it under WSL2 too.)", "machine") ?? "first";
  await ask(longRunner, `In policy.json: add "shell" to this room's tools, and set caps.run_time_ms to 5400000, caps.turns to 150 and caps.spend_micro_usd to 5000000 (raise revision). Caps cover the whole machine; leave day_caps.spend_micro_usd at 8000000.`);
  if (await offer("long", longRunner)) {
    const task = tasks.long;
    const first = await until(`task ${task} accepted`, statusIs(task, ["accepted"]), 10 * 60_000);
    const dueAtStart = first?.task?.due_at ?? null;
    say(`  The run takes over an hour. The conductor checks every minute; nothing is needed meanwhile${results.facts.repository_private === false ? ", but Runner's push question at the end (answer y)" : ""}.`);
    await until(`task ${task} submitted`, statusIs(task, ["submitted", "completed"]), 120 * 60_000, 60_000);
    const ev = await taskEvents(task);
    note("R-40", "long", judgeLongRun(ev, agents[longRunner]));
    const dueAtEnd = (await taskDetail(task)).task.due_at ?? null;
    note("R-40", "deadline", dueAtStart === dueAtEnd ? { status: "PASS", detail: dueAtStart === null ? "no deadline, before or after" : "unchanged" } : { status: "FAIL", detail: "the deadline moved" });
    note("R-40", "noPrompt", judgeAnswer(await ask(longRunner, "Did Runner ask anything at its terminal while the long run renewed its repository access?", "yn"), { yes: "FAIL" }));
    await judgeRun("long", longRunner);
    await review("long", longRunner);
    note("R-42", "revokedLogged", judgeAnswer(await ask(longRunner, `Does Runner's log show \`repo.access\` \`revoked\` for task ${task} after it finished (or say which outcome it couldn't confirm)?`, "yn")));
    await ask(longRunner, "Put policy.json back as it was before the long run (raise revision).");
  }

  section("Room-wide checks (R-04, R-14, R-18, R-33)");
  const entries = await audit();
  note("R-04", "noAdminAudit", judgeNoAdminAudit(entries, agentList()));
  const all = await refreshEvents();
  const hits = secretHits({ entries, all }, [cookie]);
  note("R-14", "noCredentials", hits.length ? { status: "FAIL", detail: hits.join(", ") } : { status: "PASS", detail: `${all.length} events and ${entries.length} audit entries` }, "room");
  note("R-33", "serverClean", hits.length ? { status: "FAIL", detail: hits.join(", ") } : { status: "PASS", detail: "none" }, "room");
  note("R-14", "noMerge", judgeNoMergeByAgent(all, agentList()), "room");
  for (const m of machines()) {
    const count = await ask(m, `Run: ${LOCAL_SCAN}   What number did it print?`, "count");
    note("R-18", "localIds", judgeZero(count), m);
    note("R-33", "localClean", judgeZero(count), m);
  }
}

/** Sends one request to a person's nudge address and gives back its status, or null with no answer. */
async function probe(url, { body, headers = {} }) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer().catch(() => null);
    return res.status;
  } catch {
    return null;
  }
}

const stamp = (event) => (typeof event.created_at === "number" ? event.created_at : Date.parse(event.created_at));

async function onHalf() {
  section("The nudge on (R-01, R-02, R-03, R-15, R-16, R-17, R-18)");
  say("  If a room is still ask-first on a Runner, approve each nudge task at its ask screen when it shows.");
  const urls = {};
  for (const m of machines()) {
    await ask(m, `Start your public HTTPS forward (your tunnel or reverse proxy) to 127.0.0.1:<port>, with the path unchanged. Stop Runner, then start it with the nudge and a 15-minute poll:\n  ${NPX} run --provider-key-file <your key file> --interval ${NUDGE_HALF_INTERVAL_S} --nudge-listen <port> --nudge-url <your https address>\n  When it prints the endpoint's version, switch the nudge on for that version on your agent's page in the web app.`);
    urls[m] = await ask(m, "Type your nudge address, exactly as you gave it to --nudge-url.", "url");
  }
  const view = await api(`/v1/agents/${agents.first}/a2a-endpoint/nudge`);
  note("R-01", "consent", view.ok ? judgeNudgeConsent(view.body) : { status: "NOT SHOWN", detail: `HTTP ${view.status}` });
  note("R-02", "verifiedBeforeOn", view.ok ? judgeNudgeConsent(view.body) : { status: "NOT SHOWN", detail: `HTTP ${view.status}` });
  if (solo) rehearsalOnly("R-01", "consentSecond");
  else note("R-01", "consentSecond", judgeAnswer(await ask("second", "On your agent's page, does the nudge show verified and on, switched on by you?", "yn")));

  // A probe goes only to the address Podster holds as that agent's endpoint, and only if its name resolves to public
  // addresses. The first agent's endpoint is read here; the second's isn't readable by this session, so its person checks.
  const allowed = {};
  for (const m of machines()) {
    if (!urls[m]) continue;
    let registered = false;
    if (m === "first") {
      const endpoint = await api(`/v1/agents/${agents.first}/a2a-endpoint`);
      registered = endpoint.ok && sameEndpoint(urls[m], endpoint.body?.url);
    } else registered = (await ask(m, `On your agent's page, is its endpoint address exactly ${urls[m]} ?`, "yn")) === true;
    if (!registered) {
      say(`  Not probing the ${m} machine's address: it isn't the agent's registered endpoint.`);
      continue;
    }
    let addresses = [];
    try {
      addresses = await dns.promises.lookup(new URL(urls[m]).hostname, { all: true });
    } catch {
      addresses = [];
    }
    const bad = addresses.length ? addresses.map((a) => addressProblem(a.address)).filter(Boolean) : ["the name doesn't resolve"];
    if (bad.length) {
      say(`  Not probing the ${m} machine's address: ${bad.join("; ")}.`);
      continue;
    }
    allowed[m] = urls[m];
  }
  for (const m of machines()) {
    if (!allowed[m]) continue;
    const nudge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} });
    const t = Math.floor(Date.now() / 1000);
    const wrong = { "x-podster-signature": `t=${t},v1=${"0".repeat(64)}` };
    note("R-03", "unsigned", judgeRefused(await probe(allowed[m], { body: nudge }), 401), m);
    note("R-03", "badSignature", judgeRefused(await probe(allowed[m], { body: nudge, headers: wrong }), 401), m);
    note("R-16", "oversized", judgeRefused(await probe(allowed[m], { body: JSON.stringify({ pad: "x".repeat(OVERSIZED_BYTES) }), headers: wrong }), 413), m);
    // Runner checks the signature before it parses, so a malformed body from us is refused 401 for its signature, which
    // says nothing about parsing. It isn't sent.
    note("R-16", "malformed", { status: "NOT SHOWN", detail: "Runner checks the signature first, and this run holds no signing secret" }, m);
    note("R-03", "noSpawn", judgeAnswer(await ask(m, "The conductor just sent three requests to your nudge address. Did Runner refuse each, and start no run?", "yn")), m);
  }

  say("\n  Waiting a minute, so the probes are past Runner's rate limit before Podster's nudges.");
  await sleep(60_000);
  for (const runner of machines()) {
    const label = `nudge-${runner}`;
    if (!(await offer("nudge", runner, { label }))) continue;
    const accepted = await until(`task ${tasks[label]} accepted`, hasEvent(tasks[label], "task.accepted", agents[runner]), 10 * 60_000, 5_000);
    // Both times are the room's own, so this machine's clock plays no part.
    const offered = (await taskEvents(tasks[label]))[0];
    const took = accepted && offered ? stamp(accepted) - stamp(offered) : NaN;
    note("R-17", "quickPickup", accepted ? (took <= NUDGE_PICKUP_MS ? { status: "PASS", detail: `${Math.round(took / 1000)} s with a ${NUDGE_HALF_INTERVAL_S} s poll` } : { status: "FAIL", detail: Number.isNaN(took) ? "no times on record" : `${Math.round(took / 1000)} s` }) : { status: "FAIL", detail: "not accepted" }, runner);
    note("R-17", "nudgeLogged", judgeAnswer(await ask(runner, `Did Runner's log show the nudge for task ${tasks[label]} before it picked the task up?`, "yn")), runner);
    note("R-18", "nudgeAudit", judgeAnswer(await ask(runner, "Do Runner's nudge lines carry IDs and codes only, with no address, secret or body?", "yn")), runner);
  }
  const after = await api(`/v1/agents/${agents.first}/a2a-endpoint/nudge`);
  const failures = after.body?.endpoint?.consecutive_failures;
  note("R-17", "noFailures", after.ok && typeof failures === "number" ? (failures === 0 ? { status: "PASS", detail: "0" } : { status: "FAIL", detail: String(failures) }) : { status: "NOT SHOWN", detail: `HTTP ${after.status}` });
  for (const runner of machines()) {
    const label = `nudge-${runner}`;
    if (!tasks[label]) continue;
    await until(`task ${tasks[label]} submitted`, statusIs(tasks[label], ["submitted", "completed"]), 30 * 60_000, 15_000);
    await judgeRun(label, runner);
    await review(label, runner);
  }

  for (const m of machines()) {
    note("R-15", "endpointStopSeen", judgeAnswer(await ask(m, "Stop Runner with Ctrl-C, and leave your forward running. Did Runner say its nudge port closed?", "yn")), m);
    if (allowed[m]) note("R-15", "endpointClosed", judgeClosed(await probe(allowed[m], { body: "{}" })), m);
  }
}

async function teardown() {
  section("Teardown");
  for (const m of machines()) {
    await ask(m, `Switch the nudge off on your agent's page if it's on, stop your forward, and run: ${NPX} stop`);
    const count = await ask(m, `Run: ${TEARDOWN_COUNT}   What number did it print?`, "count");
    results.facts[`teardown_left_${m}`] = count;
    note("R-29", "noDuplicate", judgeAnswer(await ask(m, "In the web app, does your agent list show one agent for this machine, the one paired at the start?", "yn")), m);
    if (m === "second") results.wsl2.teardown_left = count;
  }
  const view = await api(`/v1/agents/${agents.first}/a2a-endpoint/nudge`);
  results.facts.first_nudge_on_at_end = view.ok ? view.body?.endpoint?.nudge_on ?? false : null;
}

const interrupted = () => {
  stopped = true;
  results.fillUnshown("not reached before the run stopped", { rehearsal });
  writeReport("stopped with Ctrl-C");
  console.error(`\nStopped. The report so far is in ${reportPath}.`);
  process.exit(EXIT.stopped);
};
process.on("SIGINT", interrupted);
// With a terminal, readline takes Ctrl-C itself.
rl.on("SIGINT", interrupted);

say(`M7's staging run against ${STAGING}: ${rehearsal ? `a REHEARSAL, ${solo ? "one person and one machine" : "two machines"}. It never counts as the gate's run` : "the gate's run, with both people present"}.`);
say(`Halves: ${halves.join(", then ")}. The report: ${reportPath}. Answer "skip" to leave a clause NOT SHOWN, "stop" to end.`);
say("This conductor reads staging as the person at this terminal and writes nothing there. It runs no Runner and no Docker.");
let crashed = null;
try {
  await setup();
  writeReport();
  if (halves.includes("off")) await offHalf();
  writeReport();
  if (halves.includes("on")) await onHalf();
  await teardown();
} catch (error) {
  if (error instanceof Stop) {
    stopped = true;
    say(`\nStopped: ${error.message}.`);
  } else {
    stopped = true;
    crashed = scrub(String(error?.message ?? error)).slice(0, 300);
    say(`\nThe run stopped on an error: ${crashed}`);
  }
}
rl.close();
results.fillUnshown(stopped ? "not reached before the run stopped" : "not shown in this run", { rehearsal });
const written = writeReport(crashed ? `error: ${crashed}` : null);
const counts = results.counts();
say(`\n${rehearsal ? "Rehearsal" : "Gate run"}: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts["NOT SHOWN"]} NOT SHOWN.${written ? ` Report: ${reportPath}` : ""}`);
if (rehearsal) say("This was a rehearsal: it is recorded as one and never as the gate's run.");
process.exit(written ? exitCode(results, { stopped }) : EXIT.failed);
