// Checks M7's staging conductor without a network, a session or a person: how it judges what a room's owner reads, its
// answers, its report and exit code, its refusals before it reads anything, and its whole flow as a rehearsal against
// m7-staging-standin.mjs, which stands in for staging on this machine and plays each person's answers through a pipe.
//
//   node m7-staging-selftest.mjs
//
// It needs no npm packages and sends nothing anywhere: the stand-in answers every fetch the conductor makes. Each child
// gets PATH and what its case sets, nothing else of this shell's environment.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRITERIA, criteriaFor, EXIT, exitCode, findTagged, gateProblem, judgeAcceptedFirst, judgeAnswer, judgeCanceled, judgeChange, judgeClosed, judgeCompletedByReviewer, judgeIssuanceScoped, judgeLinked, judgeLongRun, judgeNoAdminAudit,
  judgeNoMergeByAgent, judgeNoSubmission, judgeNotRun, judgeNothingAfterEnd, judgeNudgeConsent, judgeOfflineThenAccepted, judgeOneAccept, judgePlainRoles, judgeRefused, judgeSubmissions, judgeZero, makeTag, nudgeUrlProblem, parseArgs, readAnswer,
  reportProblems, Results, secretHits, taskText,
} from "./m7-staging-lib.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node m7-staging-selftest.mjs

Checks M7's staging conductor (m7-staging.mjs) without a network, a session or a person: its judges, answers, report
and exit code, its refusals, and a whole rehearsal against m7-staging-standin.mjs. It takes no options and sends nothing.`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passes = 0;
function check(condition, title) {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${title}`);
  }
}
const status = (r) => r.status;

// ---- judges ----

const A = "agt_aaaa1111";
const B = "agt_bbbb2222";
const P1 = "per_Owner01";
const P2 = "per_Second02";
const ev = (seq, type, actor, extra = {}) => ({ seq, type, actor_id: actor, task_id: "tsk_1", created_at: seq * 60_000, ...extra });
const happy = [ev(1, "task.created", P1, { new_status: "offered" }), ev(2, "task.accepted", B, { new_status: "accepted" }), ev(3, "repo_access.issued", B), ev(4, "task.submitted", B, { new_status: "submitted" }), ev(5, "task.completed", P1, { new_status: "completed" })];

check(status(judgeAcceptedFirst(happy, B)) === "PASS", "accepted before issuance passes");
check(status(judgeAcceptedFirst([happy[0], happy[2], happy[1]], B)) === "FAIL", "issuance before the accept fails");
check(status(judgeAcceptedFirst(happy, A)) === "FAIL", "an accept by another agent doesn't count");
check(status(judgeOneAccept(happy, B)) === "PASS", "one accept for one offer passes");
check(status(judgeOneAccept([...happy, ev(6, "task.accepted", B)], B)) === "FAIL", "two accepts for one offer fail");
check(status(judgeOneAccept([...happy, ev(6, "task.reassigned", P1), ev(7, "task.accepted", B)], B)) === "PASS", "a second accept after a second offer passes");
check(status(judgeSubmissions(happy)) === "PASS", "one submission passes");
check(status(judgeSubmissions([...happy, ev(6, "task.submitted", B)])) === "FAIL", "a duplicate submission fails");
check(status(judgeSubmissions([...happy, ev(6, "task.changes_requested", P1), ev(7, "task.submitted", B)])) === "PASS", "a submission after changes passes");
check(status(judgeSubmissions([...happy, ev(6, "task.changes_requested", P1), ev(7, "task.submitted", B)], { max: 1 })) === "FAIL", "max 1 holds");

const canceled = [happy[0], happy[1], ev(3, "task.canceled", P1, { new_status: "canceled" })];
check(status(judgeCanceled(canceled, { status: "canceled" })) === "PASS", "a clean cancel passes");
check(status(judgeCanceled([...canceled, ev(4, "task.submitted", B)], { status: "canceled" })) === "FAIL", "a submission after a cancel fails");
check(status(judgeCanceled([...canceled, ev(4, "repo_access.issued", B)], { status: "canceled" })) === "FAIL", "issuance after a cancel fails");
check(status(judgeCanceled(canceled, { status: "submitted" })) === "FAIL", "a task not canceled fails");
check(status(judgeNoSubmission(canceled)) === "PASS" && status(judgeNoSubmission(happy)) === "FAIL", "no submission");
check(status(judgeNotRun([happy[0]], B)) === "PASS", "an untouched task passes not-run");
check(status(judgeNotRun(happy, B)) === "FAIL", "a run task fails not-run");
check(status(judgeNotRun(happy, B, { afterSeq: 5 })) === "PASS", "not-run looks only after the mark");
check(status(judgeNotRun([happy[0], happy[1]], B, { allowAccept: true })) === "PASS", "an accept alone passes when allowed");

const offline = [ev(11, "task.created", P1), ev(14, "task.accepted", B)];
check(status(judgeOfflineThenAccepted(offline, B, { stoppedSeq: 10, restartedSeq: 12 })) === "PASS", "offered while stopped, accepted after");
check(status(judgeOfflineThenAccepted(offline, B, { stoppedSeq: 10, restartedSeq: 15 })) === "FAIL", "accepted before the restart fails");
check(status(judgeOfflineThenAccepted(offline, B, { stoppedSeq: 12, restartedSeq: 13 })) === "NOT SHOWN", "offered outside the stop isn't shown");
check(status(judgeOfflineThenAccepted([ev(11, "task.created", P1)], B, { stoppedSeq: 10, restartedSeq: 12 })) === "FAIL", "never accepted fails");

const done = { status: "completed", reviewer: P1 };
check(status(judgeCompletedByReviewer(happy, done, { runnerPerson: "second", reviewerIsConductor: true })) === "PASS", "the first person verifies the second's run");
check(status(judgeCompletedByReviewer(happy, done, { runnerPerson: "first", reviewerIsConductor: true })) === "FAIL", "the first person verifying their own Runner's run fails");
check(status(judgeCompletedByReviewer([...happy.slice(0, 4), ev(5, "task.completed", B)], done, { runnerPerson: "second", reviewerIsConductor: true })) === "FAIL", "completion by an agent fails");
check(status(judgeCompletedByReviewer([...happy.slice(0, 4), ev(5, "task.completed", P2)], done, { runnerPerson: "second", reviewerIsConductor: true })) === "FAIL", "completion by someone not the reviewer fails");
check(status(judgeCompletedByReviewer(happy, { status: "submitted", reviewer: P1 }, { runnerPerson: "second", reviewerIsConductor: true })) === "FAIL", "not completed fails");
check(status(judgeNoMergeByAgent([...happy, ev(6, "merge.requested", B)], [A, B])) === "FAIL" && status(judgeNoMergeByAgent([...happy, ev(6, "merge.requested", P1)], [A, B])) === "PASS", "merges by agents only");

check(status(judgeChange({ pr_number: 3, head_in_repository: true, base_is_default: true })) === "PASS", "an observed PR passes");
check(status(judgeChange(null)) === "FAIL" && status(judgeChange({ pr_number: null })) === "FAIL", "no PR fails");
check(status(judgeChange({ pr_number: 3, head_in_repository: false, base_is_default: true })) === "FAIL", "a head outside the repository fails");
check(status(judgeChange({ pr_number: 3, head_in_repository: true, base_is_default: false })) === "FAIL", "a base other than the default fails");
check(status(judgeChange({ pr_number: 3, head_in_repository: null, base_is_default: null })) === "NOT SHOWN", "a PR not yet observed isn't shown");

check(status(judgeIssuanceScoped(happy, B)) === "PASS", "issuance while accepted passes");
check(status(judgeIssuanceScoped([...happy, ev(6, "repo_access.issued", B)], B)) === "FAIL", "issuance after completion fails scoping");
check(status(judgeIssuanceScoped([happy[0], happy[1], ev(3, "repo_access.issued", A)], B)) === "FAIL", "issuance to another agent fails");
check(status(judgeIssuanceScoped([happy[0]], B)) === "NOT SHOWN", "no issuance isn't shown");
check(status(judgeNothingAfterEnd(happy)) === "PASS" && status(judgeNothingAfterEnd([...happy, ev(6, "repo_access.issued", B)])) === "FAIL", "nothing after the end");
check(status(judgeNothingAfterEnd(happy.slice(0, 4))) === "NOT SHOWN", "a task not ended isn't shown");

const long = [ev(1, "task.created", P1), ev(2, "task.accepted", B), ev(3, "repo_access.issued", B), ev(70, "repo_access.issued", B), ev(71, "task.submitted", B)];
check(status(judgeLongRun(long, B)) === "PASS", "a run over an hour with a late token passes");
check(status(judgeLongRun([long[0], long[1], long[2], ev(30, "task.submitted", B)], B)) === "FAIL", "a short run fails R-40");
check(status(judgeLongRun([long[0], long[1], long[2], ev(71, "task.submitted", B)], B)) === "FAIL", "a long run with one token fails R-40");
check(status(judgeLinked(happy, B)) === "PASS" && status(judgeLinked([...happy, ev(6, "task.message", null)], B)) === "FAIL", "every event names an actor");
check(status(judgeLinked([happy[0], ev(2, "task.accepted", A)], B)) === "FAIL", "an accept by another principal fails linking");

check(status(judgePlainRoles([{ principal_id: A, role: "member" }, { principal_id: B, role: "guest" }], [A, B])) === "PASS", "plain roles pass");
check(status(judgePlainRoles([{ principal_id: A, role: "admin" }, { principal_id: B, role: "guest" }], [A, B])) === "FAIL", "an admin agent fails");
check(status(judgePlainRoles([{ principal_id: A, role: "member" }], [A, B])) === "FAIL", "a missing agent fails");
check(status(judgeNoAdminAudit([{ actor_id: P1, action: "member.add", outcome: "allowed" }], [A, B])) === "PASS", "a person's administration passes");
check(status(judgeNoAdminAudit([{ actor_id: A, action: "repo_grant.give", outcome: "allowed" }], [A, B])) === "FAIL", "an agent's administration fails");
check(status(judgeNoAdminAudit([{ actor_id: A, action: "repo_grant.give", outcome: "denied" }], [A, B])) === "PASS", "an agent's refused attempt passes");

const nudgeView = (history, endpoint = {}) => ({ endpoint: { version: 2, control: "verified", nudge_on: true, ...endpoint }, history });
check(status(judgeNudgeConsent(nudgeView([{ type: "nudge_on", actor_id: P1, version: 2 }, { type: "verified", actor_id: A, version: 2 }]))) === "PASS", "verified, then on by a person");
check(status(judgeNudgeConsent(nudgeView([{ type: "verified", actor_id: A, version: 2 }, { type: "nudge_on", actor_id: P1, version: 2 }]))) === "FAIL", "on before verified fails");
check(status(judgeNudgeConsent(nudgeView([{ type: "nudge_on", actor_id: A, version: 2 }, { type: "verified", actor_id: A, version: 2 }]))) === "FAIL", "on by an agent fails");
check(status(judgeNudgeConsent(nudgeView([], { control: "unverified" }))) === "FAIL", "on while unverified fails");
check(status(judgeNudgeConsent(nudgeView([], { nudge_on: false }))) === "FAIL" && status(judgeNudgeConsent(null)) === "FAIL", "off or none fails");
check(status(judgeNudgeConsent(nudgeView([{ type: "nudge_on", actor_id: P1, version: 1 }, { type: "verified", actor_id: A, version: 2 }]))) === "FAIL", "on at another version fails");

check(status(judgeRefused(401)) === "PASS" && status(judgeRefused(413)) === "PASS", "a 4xx is a refusal");
check(status(judgeRefused(200)) === "FAIL" && status(judgeRefused(202)) === "FAIL", "a 2xx is taken");
check(status(judgeRefused(502)) === "NOT SHOWN" && status(judgeRefused(null)) === "NOT SHOWN", "a tunnel's error or no answer isn't Runner's");
check(status(judgeClosed(null)) === "PASS" && status(judgeClosed(502)) === "PASS" && status(judgeClosed(200)) === "FAIL" && status(judgeClosed(401)) === "FAIL", "closed means no answer from Runner");
check(status(judgeAnswer(true)) === "PASS" && status(judgeAnswer(false)) === "FAIL" && status(judgeAnswer(null)) === "NOT SHOWN", "y, n and skip");
check(status(judgeAnswer(true, { yes: "FAIL" })) === "FAIL" && status(judgeAnswer(false, { yes: "FAIL" })) === "PASS", "a question whose yes is a failure");
check(status(judgeZero(0)) === "PASS" && status(judgeZero(2)) === "FAIL" && status(judgeZero(null)) === "NOT SHOWN", "counts");

// ---- answers, arguments, secrets, the report ----

check(readAnswer("yn", "Y").value === true && readAnswer("yn", "no").value === false && readAnswer("yn", "maybe").again, "y/n answers");
check(readAnswer("yn", "skip").skip && readAnswer("count", "STOP").stop, "skip and stop");
check(readAnswer("room", "ws_abc123").value === "ws_abc123" && readAnswer("room", "ws_a b").again && readAnswer("agent", "per_Abc123").again, "IDs by kind; a person ID is never an agent");
check(readAnswer("task", "tsk_x; rm -rf /").again, "a task ID with anything else is refused");
check(readAnswer("version", "0.0.9-test.3").value && readAnswer("version", "1.0.0").again, "only a test pre-release version");
check(readAnswer("count", "0").value === 0 && readAnswer("count", "-1").again, "counts are whole numbers");
check(readAnswer("keystore", "file").value === "file" && readAnswer("keystore", "vault").again, "key stores");
check(nudgeUrlProblem("https://runner.example.org/podster/nudge") === null, "a nudge address");
for (const bad of ["http://runner.example.org/x", "https://1.2.3.4/x", "https://u:p@runner.example.org/x", "https://runner.example.org:8443/x", "https://gateway-staging.podster.dev/x", "https://localhost/x", "https://runner.example.org/x?token=1"]) check(nudgeUrlProblem(bad) !== null, `nudge address refused: ${bad}`);

check(parseArgs([], { PODSTER_E2E_COOKIE_A: "s=1" }).options?.half === "both", "defaults");
check(parseArgs(["--half", "off", "--rehearsal"], { PODSTER_E2E_COOKIE_A: "s=1" }).options?.rehearsal === true, "rehearsal and half");
check(parseArgs(["--half", "sideways"], { PODSTER_E2E_COOKIE_A: "s=1" }).error, "a bad half is refused");
check(parseArgs([], {}).error?.includes("PODSTER_E2E_COOKIE_A"), "no session is refused");
check(parseArgs([], { PODSTER_E2E_COOKIE_A: "s=1", PODSTER_E2E_COOKIE_B: "t=2" }).error?.includes("COOKIE_B"), "a second person's session is refused");
check(parseArgs([], { PODSTER_E2E_COOKIE_A: "s=1", PODSTER_E2E_SIGNUP_SECRET: "x" }).error?.includes("SIGNUP"), "the test sign-up is refused");
check(parseArgs(["--base-url", "https://example.org"], { PODSTER_E2E_COOKIE_A: "s=1" }).error, "another host is refused");
check(parseArgs(["--dry-run"], {}).options?.dryRun, "a dry run needs no session");
check(parseArgs(["--two-machines"], { PODSTER_E2E_COOKIE_A: "s=1" }).error?.includes("rehearsal"), "--two-machines alone is refused: the gate is always two machines");
check(gateProblem({ rehearsal: false, stdinTTY: false, stdoutTTY: true }) !== null, "the gate needs a terminal");
check(gateProblem({ rehearsal: false, stdinTTY: true, stdoutTTY: true, standin: true }) !== null, "the gate refuses a stand-in");
check(gateProblem({ rehearsal: true, stdinTTY: false, stdoutTTY: false, standin: true }) === null, "a rehearsal may run piped");

check(secretHits({ note: "token ghs_abcdefghijklmnopqrstuvwxyz0123" }).includes("github_token"), "a GitHub token is found");
check(secretHits("Bearer abcdefghijklmnopqrstuvwxyz012345").includes("bearer"), "a bearer token is found");
check(secretHits("https://x-access-token:abc@github.com/o/r").includes("url_credential"), "a credential in a URL is found");
check(secretHits({ ok: "agt_abc tsk_def ws_ghi" }).length === 0, "IDs are not secrets");
check(secretHits("cookie=sessionvalue123", ["sessionvalue123"]).includes("held_secret"), "a held string is found");
check(reportProblems('{"x":"per_Owner01"}', { personIds: ["per_Owner01"] }).length === 1, "a person ID in the report is refused");
check(reportProblems('{"x":"someone@example.com"}').length === 1, "an email in the report is refused");

const r = new Results({ kind: "gate", half: "off" });
r.record("R-05", "acceptedFirst", { status: "PASS" }, "a");
r.record("R-05", "acceptedFirst", { status: "FAIL", detail: "x" }, "a");
r.record("R-05", "acceptedFirst", { status: "PASS" }, "a");
check(r.criteria()["R-05"].status === "FAIL", "a later pass never hides a failure");
const s = new Results({ kind: "rehearsal", half: "off" });
s.fillUnshown("not shown");
check(Object.values(s.criteria()).every((c) => c.status === "NOT SHOWN"), "nothing recorded is NOT SHOWN");
check(!("R-03" in s.criteria()) && "R-40" in s.criteria(), "the off half has no inbound-only criterion");
check(s.report().counts_as_gate === false && s.report().kind === "rehearsal", "a rehearsal never counts as the gate");
check(exitCode(r, { stopped: false }) === EXIT.failed && exitCode(s, { stopped: true }) === EXIT.stopped && exitCode(s, { stopped: false }) === EXIT.ok, "exit codes");
let threw = false;
try {
  r.record("R-05", "nope", { status: "PASS" });
} catch {
  threw = true;
}
check(threw, "an unknown clause throws");

// The gate's map's staging criteria, all recorded: R-04 to R-42 there, and the inbound ones in the nudge half.
const mapped = ["R-01", "R-02", "R-03", "R-04", "R-05", "R-06", "R-07", "R-12", "R-13", "R-14", "R-15", "R-16", "R-17", "R-18", "R-20", "R-22", "R-24", "R-31", "R-32", "R-33", "R-34", "R-35", "R-38", "R-39", "R-40", "R-41", "R-42"];
check(mapped.every((id) => id in CRITERIA) && Object.keys(CRITERIA).every((id) => mapped.includes(id)), "every staging criterion of the map, and no other");
check(["R-01", "R-02", "R-03", "R-16", "R-17"].every((id) => criteriaFor("on").includes(id)), "the inbound criteria are in the nudge half");
check(Object.values(CRITERIA).every((c) => c.local && Object.values(c.clauses).every((k) => ["server", "person", "probe"].includes(k.how) && ["off", "on"].includes(k.half))), "each clause says how and when, and each criterion what's left to local tests");
const tag = makeTag("ask", "a1b2c3");
check(findTagged([{ id: "tsk_1", title: taskText("ask", tag).title }, { id: "tsk_2", title: "other" }], tag)?.id === "tsk_1", "a task is found by its tag");
check(findTagged([{ id: "tsk_1", title: `x [${tag}]` }, { id: "tsk_2", title: `y [${tag}]` }], tag)?.duplicate === 2, "two tasks with one tag are a duplicate");
check(taskText("long", tag).instructions.includes("sleep 100") && !taskText("ask", tag).instructions.includes("sleep"), "only the long task sleeps");

// ---- the script: refusals, then whole rehearsals against the stand-in ----

const script = join(here, "m7-staging.mjs");
/** The conductor's environment here: a path to find node, and what each case sets. Nothing else of this shell's. */
const childEnv = (own = {}) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", ...own });
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: here, env: childEnv(env), encoding: "utf8", input: "", timeout: 30_000 });
const help = run(["--help"]);
check(help.status === 0 && /usage/i.test(help.stdout), "--help");
const dry = run(["--dry-run"]);
check(dry.status === 0 && dry.stdout.includes("R-40") && dry.stdout.includes("left to local tests"), "--dry-run prints the plan with no session");
check(run([]).status === EXIT.refused, "no session: refused");
check(run([], { PODSTER_E2E_COOKIE_A: "s=1", PODSTER_E2E_COOKIE_B: "t=2" }).status === EXIT.refused, "a second session: refused");
check(run([], { PODSTER_E2E_COOKIE_A: "s=1", PODSTER_E2E_SIGNUP_SECRET: "x" }).status === EXIT.refused, "the sign-up secret: refused");
const piped = run([], { PODSTER_E2E_COOKIE_A: "s=1" });
check(piped.status === EXIT.refused && piped.stderr.includes("terminal"), "the gate from a pipe: refused before anything is read");
const standinGate = spawnSync(process.execPath, ["--import", "./m7-staging-standin.mjs", script], { cwd: here, env: childEnv({ PODSTER_E2E_COOKIE_A: "s=1" }), encoding: "utf8", input: "", timeout: 30_000 });
check(standinGate.status === EXIT.refused && standinGate.stderr.includes("stand-in"), "the gate with the stand-in: refused");

const COOKIE = "standin_session=QmVlZm9yZUFueVJlYWQx";
/** The answers a person gives, by the hint the prompt ends with. */
function answerFor(prompt, question, speaker, { stopAt } = {}) {
  if (stopAt && question.includes(stopAt)) return "stop";
  if (prompt.endsWith("Press Return when done (skip, stop): ")) return "";
  if (prompt.endsWith("y or n: ")) return question.includes("Did Runner ask anything") ? "n" : "y";
  if (prompt.endsWith("the number: ")) return "0";
  if (prompt.endsWith("type present: ")) return "present";
  if (prompt.endsWith("Runner's version: ")) return "0.0.9-test.3";
  if (prompt.endsWith("the key store: ")) return "file";
  if (prompt.endsWith("first or second: ")) return "second";
  if (prompt.endsWith("the https:// address: ")) return "https://nudge.example.org/podster/nudge";
  if (prompt.endsWith("the room ID: ")) return "ws_standin01";
  if (prompt.endsWith("the agent ID: ")) return speaker.startsWith("Second") ? "agt_standinsecond" : "agt_standinfirst";
  return null;
}

function rehearse({ brk, stopAt, half = "both", two = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "m7-staging-selftest-"));
  const report = join(dir, "report.json");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "./m7-staging-standin.mjs", script, "--rehearsal", ...(two ? ["--two-machines"] : []), "--half", half, "--report", report], {
      cwd: here,
      env: childEnv({ PODSTER_E2E_COOKIE_A: COOKIE, STANDIN_AGENTS: two ? "agt_standinfirst,agt_standinsecond" : "agt_standinfirst", ...(brk ? { STANDIN_BREAK: brk } : {}) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let answered = 0;
    let lastQuestion = "";
    let speaker = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      out += d;
      const tail = out.slice(answered);
      const asked = /\n\[([^\]]+)\] ([^\n]*)/g;
      for (const m of tail.matchAll(asked)) [speaker, lastQuestion] = [m[1], m[2]];
      const prompt = /(  [^\n]*: )$/.exec(tail)?.[1];
      if (!prompt) return;
      const answer = answerFor(prompt, lastQuestion, speaker, { stopAt });
      answered = out.length;
      child.stdin.write(`${answer ?? "stop"}\n`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      let parsed = null;
      let text = "";
      try {
        text = readFileSync(report, "utf8");
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, err, report: parsed, text });
    });
  });
}

const clean = await rehearse();
check(clean.code === EXIT.ok, `a clean rehearsal exits 0 (got ${clean.code}; ${clean.err.slice(0, 300)}${clean.code === EXIT.ok ? "" : clean.out.slice(-1500)})`);
check(clean.report?.kind === "rehearsal" && clean.report?.counts_as_gate === false, "the rehearsal's report says rehearsal, never the gate");
check(clean.report && clean.report.counts.FAIL === 0, `no criterion fails in a clean rehearsal: ${JSON.stringify(Object.entries(clean.report?.criteria ?? {}).filter(([, c]) => c.status === "FAIL").map(([id, c]) => [id, c.clauses]))}`);
check(clean.report?.criteria?.["R-14"]?.clauses?.["otherReviewer.ask-first"]?.status === "NOT SHOWN", "one person can't show an independent reviewer");
check(clean.report?.criteria?.["R-40"]?.clauses?.long?.status === "PASS", "the long run is judged from the room's own times");
check(clean.report?.criteria?.["R-03"]?.clauses?.["unsigned.first"]?.status === "PASS" && clean.report?.criteria?.["R-15"]?.clauses?.["endpointClosed.first"]?.status === "PASS", "the probes are judged");
check(clean.report?.criteria?.["R-15"]?.clauses?.durable?.status === "PASS", "offline work, offered while stopped and accepted after");
check(clean.report?.ids?.tasks && Object.values(clean.report.ids.tasks).every((id) => /^tsk_/.test(id)), "the report's tasks are IDs");
check(!clean.text.includes(COOKIE) && !clean.out.includes(COOKIE) && !clean.text.includes("per_StandIn") && !clean.out.includes("per_StandIn"), "neither the session nor a person ID reaches the output or the report");
check(clean.text.length > 0 && reportProblems(clean.text).length === 0, "the report passes its own check");

const two = await rehearse({ two: true });
check(two.code === EXIT.ok && two.report?.kind === "rehearsal" && two.report?.counts_as_gate === false, `a two-machine rehearsal exits 0 and is still a rehearsal (got ${two.code}: ${JSON.stringify(Object.entries(two.report?.criteria ?? {}).filter(([, c]) => c.status !== "PASS").map(([id, c]) => [id, Object.fromEntries(Object.entries(c.clauses).filter(([, v]) => v.status !== "PASS"))]))})`);
check(two.report?.criteria?.["R-14"]?.clauses?.["otherReviewer.ask-first"]?.status === "PASS" && two.report?.criteria?.["R-14"]?.clauses?.["otherReviewer.ask-second"]?.status === "PASS", "with two machines, each direction's reviewer is the other person");
check(two.report?.criteria?.["R-20"]?.clauses?.outOfScope?.status === "PASS" && two.report?.wsl2?.key_store === "file" && two.report?.wsl2?.teardown_left === 0, "the scope check and the second machine's WSL2 record");
check(two.report && Object.values(two.report.criteria).every((c) => c.status === "PASS"), "with two machines, the stand-in shows every criterion");
check(!two.text.includes("per_StandIn") && !two.out.includes("per_StandIn"), "no person ID with two machines either");
const dup = await rehearse({ brk: "duplicate-accept", half: "off" });
check(dup.code === EXIT.failed && dup.report?.criteria?.["R-06"]?.status === "FAIL", "a duplicate accept fails R-06 and the run");
const late = await rehearse({ brk: "submit-after-cancel", half: "off" });
check(late.code === EXIT.failed && late.report?.criteria?.["R-13"]?.status === "FAIL" && late.report?.criteria?.["R-24"]?.status === "FAIL", "a submission after a cancel fails R-13 and R-24");
const admin = await rehearse({ brk: "agent-admin", half: "off" });
check(admin.code === EXIT.failed && admin.report?.criteria?.["R-04"]?.status === "FAIL", "administration by a Runner agent fails R-04");
const stop = await rehearse({ stopAt: "Type the room's ID" });
check(stop.code === EXIT.stopped && stop.report?.stopped === true && stop.report.counts.PASS === 0 && stop.report.counts.FAIL === 0, "stopping early writes a report with everything NOT SHOWN");

console.log(`${failures ? "FAIL" : "ok"}: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
