// The parts of m7-staging.mjs that touch nothing: its arguments, the criteria and clauses it records, how it judges what
// a room's owner can read on staging, and the report it writes. Kept apart so m7-staging-selftest.mjs can check them with
// no network, no session and no person.
//
// M7's staging run (docs/m7-plan.md, step 16, and docs/m7-two-person-run.md) is a two-person, two-machine run: the
// owner's Mac and the second person's Windows machine under WSL2, each with its own Runner from `npx podster@test`, paired
// with its own agent and signed in to staging with its own account. The script is a conductor, not an impersonator: it
// reads staging through the session of the person at its terminal, and asks each person for what only they can do or see.
// It writes nothing to staging, and it never signs anyone up, in or out.

export const STAGING = "https://gateway-staging.podster.dev";
export const EXIT = { ok: 0, failed: 1, refused: 2, stopped: 3 };
export const PEOPLE = ["first", "second"];
/** How each person is named in prompts. Never a name, an email or a person ID. */
export const WHO = { first: "First person (the owner, on the Mac)", second: "Second person (Long, on Windows under WSL2)", both: "Both people" };
/** The Runner command each person runs, as the README gives it. */
export const NPX = "npx --ignore-scripts podster@test";
/** The test pre-release's versions (docs/m7-plan.md, the gate's note of 2026-11-19). */
export const RUNNER_VERSION = /^0\.0\.\d+-test\.\d+$/;
/** IDs a person types. Person IDs are never asked for, recorded or printed. */
export const ID_PATTERN = {
  room: /^ws_[A-Za-z0-9_-]{4,80}$/,
  agent: /^agt_[A-Za-z0-9_-]{4,80}$/,
  task: /^tsk_[A-Za-z0-9_-]{4,80}$/,
};
/** Runner's three key stores (apps/runner/src/node/key-store.ts, KEY_STORE_LINES). */
export const KEY_STORES = ["macos_keychain", "secret_service", "file"];
/** Runner's container label (apps/runner/src/node/docker-sandbox.ts, LABEL_RUN), for the teardown count a person runs. */
export const RUNNER_LABEL = "dev.podster.runner.run";
/** Runner's default poll, and the one the nudge half asks for so a quick pickup can be told from a poll. */
export const POLL_MS = 30_000;
export const NUDGE_HALF_INTERVAL_S = 900;
/** A nudge-half pickup counts as the nudge's only well inside the long interval. */
export const NUDGE_PICKUP_MS = 5 * 60_000;
/** R-40: a run longer than an hour, and a fresh token in its last part. */
export const LONG_RUN_MS = 60 * 60_000;
export const LONG_RUN_LATE_ISSUE_MS = 55 * 60_000;
/** The body the oversized probe sends: past Runner's 8 KB limit for a nudge (apps/runner/README.md, "Nudges"). */
export const OVERSIZED_BYTES = 16 * 1024;

export const USAGE = `Usage: node m7-staging.mjs [--rehearsal [--two-machines]] [--half off|on|both] [--report <file>] [--dry-run]
       node m7-staging.mjs --help

M7's staging run (step 16 of docs/m7-plan.md), conducted from one terminal with both people present: the owner on the
Mac and Long on Windows under WSL2, each with their own Runner (npx podster@test) paired with their own agent and signed
in to staging with their own account. The setup sheet is docs/m7-two-person-run.md.

It reads staging only through the session of the person at this terminal, the room's owner, given in
PODSTER_E2E_COOKIE_A by that person. It writes nothing to staging: every write is a person's own, in the web app or at
their own Runner, when a prompt asks for it. It never signs anyone up, in or out, and takes no other person's session:
PODSTER_E2E_COOKIE_B and PODSTER_E2E_SIGNUP_SECRET are refused.

Each prompt names who answers. Answer y or n, an ID, a count or a word as asked; "skip" records that clause as NOT
SHOWN, and "stop" ends the run, writing what it has. Each criterion is recorded PASS, FAIL or NOT SHOWN.

  --rehearsal       One person and one machine. Steps that need the second person are NOT SHOWN, and the report is
                    a rehearsal's: it never counts as the gate's run.
  --two-machines    With --rehearsal: every step on both machines, as when one person drives both, or both
                    try the run out first. Still a rehearsal's report, never the gate's.
  --half <which>    off (the nudge off: the proof of concept), on (the nudge on), or both, the default.
  --report <file>   Where the report goes. Default: e2e/m7-staging-<rehearsal|gate>-<time>.json. IDs only.
  --dry-run         Print the plan and the criteria, then exit. Reads nothing and needs no session.

The gate's run needs a terminal for its prompts. Exit codes: 0 when nothing failed, 1 when a criterion failed, 2 for a
refused argument or environment, 3 when stopped before the end.`;

/** Every criterion this run records, with the clauses the staging run shows and what is left to local tests. */
export const CRITERIA = {
  "R-01": {
    half: "both",
    title: "Startup without approved workspace or auth can't execute; endpoint setup needs explicit consent",
    clauses: {
      unpaired: { half: "off", how: "person", text: "Runner started from an empty home, with no pairing, refused and ran nothing" },
      consent: { half: "on", how: "server", text: "the first agent's nudge was switched on by a person, after the endpoint proved control" },
      consentSecond: { half: "on", how: "person", text: "the second agent's nudge shows verified and on, switched on by its person in Podster" },
    },
    local: "verified distribution is decision 26's (the test pre-release's provenance); the startup refusals' unit tests",
  },
  "R-02": {
    half: "on",
    title: "Forged identity, wrong owner or unverified endpoint can't register an active agent",
    clauses: { verifiedBeforeOn: { half: "on", how: "server", text: "nudge on only at a version whose control is verified" } },
    local: "forged identity and wrong owner (steps 5 and 13's tests)",
  },
  "R-03": {
    half: "on",
    title: "(Inbound) Unauthenticated, replayed or substituted requests rejected; an inbound request alone spawns no CLI",
    clauses: {
      unsigned: { half: "on", how: "probe", text: "an unsigned request to each Runner's public nudge address is refused" },
      badSignature: { half: "on", how: "probe", text: "a request with a signature from the wrong secret is refused" },
      noSpawn: { half: "on", how: "person", text: "no run started on either machine from the refused requests" },
    },
    local: "replay and wrong-room or wrong-task substitution (steps 13 and 14's tests): this run holds no signing secret",
  },
  "R-04": {
    half: "off",
    title: "Members and agents can't administer access; Runner's agent gets nothing more",
    clauses: {
      plainRole: { half: "off", how: "server", text: "both Runner agents hold a plain membership in the room, never owner or admin" },
      noAdminAudit: { half: "off", how: "server", text: "the room's access audit has no administration by either Runner agent" },
    },
    local: "the permission matrix (crates/policy) and M0/M1's runs",
  },
  "R-05": {
    half: "off",
    title: "A run starts only with a current policy decision and a fresh read showing the task accepted by this agent",
    clauses: {
      acceptedFirst: { half: "off", how: "server", text: "each run task was accepted by its assignee before any repository access or submission" },
      askScreen: { half: "off", how: "person", text: "in the ask-first room each run began only after its machine's person answered y" },
      afterCancel: { half: "off", how: "server", text: "after a cancel, nothing more was accepted, issued or submitted for that task" },
    },
    local: "a lost accept answer (step 8's lifecycle tests)",
  },
  "R-06": {
    half: "off",
    title: "Lost accept answer and retry resolve to one result and at most one local execution",
    clauses: {
      oneAccept: { half: "off", how: "server", text: "no task was accepted more often than it was offered" },
      oneLocalRun: { half: "off", how: "person", text: "after the crash and restart, Runner's status shows one run for the task" },
    },
    local: "a lost accept response retried with the same key (step 8)",
  },
  "R-07": {
    half: "off",
    title: "Revocation between queueing, accept and execution denies stale authority",
    clauses: {
      canceledWhileOffline: { half: "off", how: "server", text: "a task canceled while its Runner was stopped was never accepted, issued or run after the restart" },
      noLocalRun: { half: "off", how: "person", text: "Runner's log shows no run for the canceled task" },
    },
    local: "a stale executor's result write refused by the server's version check (M0, step 8)",
  },
  "R-12": {
    half: "off",
    title: "Duplicate delivery and crashes keep durable state, recover without duplicate side effects",
    clauses: {
      noDuplicates: { half: "off", how: "server", text: "after a hard kill and restart, one accept, one submission and one pull request" },
      uncertainShown: { half: "off", how: "person", text: "on restart Runner reconciled the task rather than starting it fresh" },
    },
    local: "duplicate delivery and crash points (steps 6, 8 and 11)",
  },
  "R-13": {
    half: "off",
    title: "Cancellation races are versioned; descendants stop or are reported; partial effects disclosed",
    clauses: {
      canceled: { half: "off", how: "server", text: "a cancel during a run ends the task canceled, with no submission after it" },
      stopped: { half: "off", how: "person", text: "after the cancel, no Runner container is left on that machine" },
      disclosed: { half: "off", how: "person", text: "Runner said the run was canceled, and whether anything was pushed" },
    },
    local: "process-tree stop and the race's versions (steps 8 and 9)",
  },
  "R-14": {
    half: "off",
    title: "Results carry only authorized artifacts and no credentials; no self-verify, merge or deploy",
    clauses: {
      noCredentials: { half: "off", how: "server", text: "no credential pattern in any run task's detail, events or the room's audit" },
      otherReviewer: { half: "off", how: "server", text: "each task was completed by a person, its reviewer, who isn't the person whose Runner ran it" },
      noMerge: { half: "off", how: "server", text: "no merge or deploy event by a Runner agent" },
    },
    local: "result shapes and redaction (step 11)",
  },
  "R-15": {
    half: "both",
    title: "Shutdown is observable; offline work stays durable; reconnect revalidates",
    clauses: {
      stopSeen: { half: "off", how: "person", text: "stopping Runner said so at its terminal" },
      durable: { half: "off", how: "server", text: "a task offered while Runner was stopped stayed offered, and was accepted only after the restart" },
      endpointClosed: { half: "on", how: "probe", text: "after Runner stopped, its public nudge address no longer reaches it" },
      endpointStopSeen: { half: "on", how: "person", text: "Runner said its nudge port closed" },
    },
    local: "offline work and reconnect (steps 6 and 8); the endpoint's shutdown tests (step 14)",
  },
  "R-16": {
    half: "on",
    title: "(Inbound) SSRF, redirects, rebinding, malformed and oversized payloads rejected",
    clauses: {
      oversized: { half: "on", how: "probe", text: "a 16 KiB body to each nudge address is refused" },
      malformed: { half: "on", how: "probe", text: "a body that isn't JSON is refused" },
    },
    local: "card-fetch SSRF, redirects and rebinding (step 13's egress tests); no route to the private API (staging-probes)",
  },
  "R-17": {
    half: "on",
    title: "(Inbound) The pinned A2A version passes interoperability for a nudge",
    clauses: {
      quickPickup: { half: "on", how: "server", text: "with a 15-minute poll, each offer was accepted within 5 minutes" },
      nudgeLogged: { half: "on", how: "person", text: "each Runner logged the nudge before the pickup" },
      noFailures: { half: "on", how: "server", text: "the first agent's endpoint shows no failed deliveries" },
    },
    local: "the SDK's own server (m7-nudge-interop-staging.mjs, a separate opt-in run) and step 15's tests",
  },
  "R-18": {
    half: "both",
    title: "Audit links actor, room, task, decision, nudge and session without secrets",
    clauses: {
      linked: { half: "off", how: "server", text: "each run task's events name their actor, and accept and submit are the assignee's" },
      localIds: { half: "off", how: "person", text: "a scan of each Runner's logs and task folders finds no token or key" },
      nudgeAudit: { half: "on", how: "person", text: "each Runner's nudge lines carry IDs and codes only" },
    },
    local: "the local audit's shape (steps 4 and 11)",
  },
  "R-20": {
    half: "off",
    title: "Eligible tasks run unprompted; out-of-scope work never starts; reruns need a fresh decision; caps stop runs",
    clauses: {
      unprompted: { half: "off", how: "person", text: "in the unattended room, each machine started its run with no ask screen" },
      outOfScope: { half: "off", how: "server", text: "a task from an organization the Runner's policy doesn't allow was never accepted" },
      rerunDecided: { half: "off", how: "person", text: "after changes were requested, Runner evaluated the task again before the rerun" },
      rerunSubmitted: { half: "off", how: "server", text: "the rerun's work arrived as a second submission" },
      budgetStop: { half: "off", how: "person", text: "a run over its turn cap stopped, and Runner reported the cap" },
    },
    local: "input and policy changes stopping a run, and out-of-scope authors (step 7)",
  },
  "R-22": {
    half: "off",
    title: "Pairs and picks up work outbound only, with no listening port",
    clauses: {
      noPort: { half: "off", how: "person", text: "neither Runner listens on any port while the nudge is off" },
      noEndpoint: { half: "off", how: "server", text: "the first agent has no A2A endpoint" },
      noEndpointSecond: { half: "off", how: "person", text: "the second agent has no A2A endpoint in Podster" },
      offline: { half: "off", how: "server", text: "work offered while Runner was offline was found after the restart" },
    },
    local: "the poller's tests (step 6)",
  },
  "R-24": {
    half: "off",
    title: "A failed, budget-stopped or canceled run never reaches the reviewer as a submission",
    clauses: {
      canceled: { half: "off", how: "server", text: "the canceled run left no submission" },
      budget: { half: "off", how: "server", text: "the budget-stopped run left no submission" },
    },
    local: "an old process Runner can't confirm stopped (step 8)",
  },
  "R-31": {
    half: "off",
    title: "The end-to-end run: an eligible offer runs unprompted, a verified PR returns, an independent reviewer verifies",
    clauses: {
      endToEnd: { half: "off", how: "server", text: "in the unattended room, each direction ended with a verified pull request and a completion by the other person" },
      testsReported: { half: "off", how: "person", text: "each reviewer saw test outcomes as passed, failed or not run" },
      held: { half: "off", how: "person", text: "in the ask-first room, which holds outputs, Runner asked before pushing" },
    },
    local: "result shapes (step 11)",
  },
  "R-32": {
    half: "off",
    title: "Token issuance checks agent, room, task, repository and grant",
    clauses: { scoped: { half: "off", how: "server", text: "every repository access was issued to the task's assignee while the task was accepted" } },
    local: "cross-repository selectors, revoked grants, stale tasks and excess permissions denied (M5 and step 10's tests)",
  },
  "R-33": {
    half: "off",
    title: "Repository tokens never enter prompts, task-readable files, logs or artifacts",
    clauses: {
      serverClean: { half: "off", how: "server", text: "no token pattern in task details, events or audit" },
      localClean: { half: "off", how: "person", text: "a scan of each machine's Runner logs and task folders finds no token" },
      gitConfig: { half: "off", how: "person", text: "no credential in the task folder's git configuration" },
    },
    local: "expiry, failed renewal and interrupted delivery (step 10)",
  },
  "R-34": {
    half: "off",
    title: "A permitted push and PR succeed; the credential can't bypass review, merge or administer",
    clauses: {
      prShape: { half: "off", how: "server", text: "each pull request's head is in the room's repository and its base is the default branch" },
      notMerged: { half: "off", how: "person", text: "on GitHub, each reviewer saw the pull request open and unmerged by any agent" },
    },
    local: "the credential's refused writes (M5's merge-check and S-21; step 10's tests)",
  },
  "R-35": {
    half: "off",
    title: "Crash after a push reconciles the existing PR; no duplicate PR",
    clauses: {
      verified: { half: "off", how: "server", text: "each submission's pull request was observed in the repository" },
      crashBetween: { half: "off", how: "server", text: "a kill after the pull request and before the submission ended in one submission" },
      onePr: { half: "off", how: "person", text: "GitHub shows one pull request for the crashed task's branch" },
    },
    local: "the reconcile's tests (steps 10 and 11)",
  },
  "R-38": {
    half: "off",
    title: "Clones only the verified repository under the local root and starts without a per-run prompt",
    clauses: {
      unprompted: { half: "off", how: "person", text: "in the unattended room, the run started with no prompt" },
      underRoot: { half: "off", how: "person", text: "the task's folder is under the policy's workspace_root" },
      noToken: { half: "off", how: "person", text: "no token in the task folder's git configuration or files" },
    },
    local: "remote and path substitution, unsafe Git configuration, submodules and LFS (step 10)",
  },
  "R-39": {
    half: "off",
    title: "Revoked access, pending setup or a failed clone prevents CLI launch",
    clauses: {
      noIssue: { half: "off", how: "server", text: "with the push grant taken back, the task got no repository access and no submission" },
      refusedLocally: { half: "off", how: "person", text: "Runner's why for the task names a repository access refusal" },
    },
    local: "pending setup, failed clones and changed bindings (step 10)",
  },
  "R-40": {
    half: "off",
    title: "A task longer than an hour keeps working with fresh tokens; renewal never extends the deadline",
    clauses: {
      long: { half: "off", how: "server", text: "a run longer than an hour pushed with a repository access issued in its last part" },
      deadline: { half: "off", how: "server", text: "the task's deadline was the same at its end as at its start" },
      noPrompt: { half: "off", how: "person", text: "no renewal asked anything at Runner's terminal" },
    },
    local: "renewal bounds (step 10)",
  },
  "R-41": {
    half: "off",
    title: "Completion, cancel and other ends deny renewal and stop operations",
    clauses: { nothingAfterEnd: { half: "off", how: "server", text: "no repository access was issued for a task after it completed or was canceled" } },
    local: "disconnect, reassignment, exhausted budget and concurrent renewals (step 10)",
  },
  "R-42": {
    half: "off",
    title: "Token permissions verified; revocation outcomes reported",
    clauses: { revokedLogged: { half: "off", how: "person", text: "after the long run, Runner's log shows its repository access revoked, or the outcome it couldn't confirm" } },
    local: "revocation success, failure and unknown outcomes (step 10); the API's own revocation lines are in its logs, which this run doesn't read",
  },
};

/** The second machine's own record (step 16's note of 2026-11-19): WSL2 only, never other Linux hosts. */
export const WSL2 = {
  linuxChecked: "Runner's Linux checks passed (its log shows adapter.platform linux_checked)",
  keyStore: "the key store Runner printed",
  teardown: "teardown left no Runner container or network",
};

/** The criteria whose clauses fall in a half, in the map's order. */
export function criteriaFor(half) {
  return Object.entries(CRITERIA).filter(([, c]) => half === "both" || Object.values(c.clauses).some((k) => k.half === half)).map(([id]) => id);
}

// ---- arguments and environment ----

export function parseArgs(argv, env = {}) {
  const options = { help: false, dryRun: false, rehearsal: false, twoMachines: false, half: "both", report: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--rehearsal") options.rehearsal = true;
    else if (arg === "--two-machines") options.twoMachines = true;
    else if (arg === "--half" || arg === "--report") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      if (arg === "--half") {
        if (!["off", "on", "both"].includes(value)) return { error: `--half is off, on or both, not ${JSON.stringify(value)}` };
        options.half = value;
      } else options.report = value;
    } else if (arg === "--base-url" || arg === "--allow-host") return { error: `${arg} isn't taken: this run is against ${STAGING} only` };
    else return { error: `unknown argument ${JSON.stringify(arg)}` };
  }
  if (options.twoMachines && !options.rehearsal) return { error: "--two-machines is for a rehearsal: the gate's run is always two machines" };
  if (options.help || options.dryRun) return { options };
  if (env.PODSTER_E2E_SIGNUP_SECRET) return { error: "PODSTER_E2E_SIGNUP_SECRET is set: this run has real people only and makes no test person. Unset it" };
  if (env.PODSTER_E2E_COOKIE_B) return { error: "PODSTER_E2E_COOKIE_B is set: this run never takes a second person's session. Each person acts in their own browser. Unset it" };
  if (!env.PODSTER_E2E_COOKIE_A) return { error: "PODSTER_E2E_COOKIE_A isn't set: the person at this terminal, the room's owner, sets it to their own staging session cookie (docs/m7-two-person-run.md)" };
  if (/[\r\n]/.test(env.PODSTER_E2E_COOKIE_A)) return { error: "PODSTER_E2E_COOKIE_A holds a line break" };
  return { options };
}

/** What a gate run needs before it asks anyone anything. */
export function gateProblem({ rehearsal, stdinTTY, stdoutTTY, standin }) {
  if (rehearsal) return null;
  if (standin) return "a stand-in is loaded: only a rehearsal runs against one";
  if (!stdinTTY || !stdoutTTY) return "the gate's run needs a terminal for its prompts: answers can't come from a pipe or a file. Use --rehearsal to try it without one";
  return null;
}

export function defaultReportName(rehearsal, now = new Date()) {
  return `m7-staging-${rehearsal ? "rehearsal" : "gate"}-${now.toISOString().slice(0, 16).replace(/:/g, "")}.json`;
}

// ---- answers ----

/** One answer, as a prompt's kind takes it. `{ skip }`, `{ stop }`, `{ value }`, or `{ again }` with what to type. */
export function readAnswer(kind, raw) {
  const text = String(raw ?? "").trim();
  if (/^stop$/i.test(text)) return { stop: true };
  if (/^skip$/i.test(text)) return { skip: true };
  if (kind === "enter") return { value: true };
  if (kind === "yn") {
    if (/^y(es)?$/i.test(text)) return { value: true };
    if (/^no?$/i.test(text)) return { value: false };
    return { again: "y or n (or skip, or stop)" };
  }
  if (kind === "count") return /^\d{1,6}$/.test(text) ? { value: Number(text) } : { again: "a whole number (or skip, or stop)" };
  if (kind === "present") return /^present$/i.test(text) ? { value: true } : { again: "present (or stop)" };
  if (kind === "accepted") return /^accepted$/i.test(text) ? { value: true } : { again: "accepted, once it's done (or skip, or stop)" };
  if (kind === "version") return RUNNER_VERSION.test(text) ? { value: text } : { again: "the version npx printed, like 0.0.7-test.12 (or skip, or stop)" };
  if (kind === "keystore") return KEY_STORES.includes(text) ? { value: text } : { again: `one of ${KEY_STORES.join(", ")} (or skip, or stop)` };
  if (kind === "machine") return PEOPLE.includes(text) ? { value: text } : { again: "first or second" };
  if (kind === "url") {
    const problem = nudgeUrlProblem(text);
    return problem ? { again: `${problem} (or skip, or stop)` } : { value: text };
  }
  if (kind in ID_PATTERN) return ID_PATTERN[kind].test(text) ? { value: text } : { again: `a ${kind} ID, ${ID_PATTERN[kind].source.slice(1, 5)}… (or skip, or stop)` };
  throw new Error(`unknown answer kind ${kind}`);
}

/** A nudge address a person gives: what Runner and Podster accept (apps/runner/README.md, "Nudges"). */
export function nudgeUrlProblem(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return "an https:// address";
  }
  if (url.protocol !== "https:") return "an https:// address";
  if (url.username || url.password) return "an address with no user name or password in it";
  if (url.port) return "an address on the default port";
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || url.hostname === "localhost") return "a DNS name, not an IP address or localhost";
  if (url.hostname === "podster.dev" || url.hostname.endsWith(".podster.dev")) return "an address of your own, not podster.dev";
  if (url.search || url.hash) return "an address with no query or fragment";
  return null;
}

// ---- secrets ----

/** Patterns of what must never reach a room, an event, a report or a log. Names only are reported. */
export const SECRET_PATTERNS = [
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["nudge_secret", /\ba2asec_[A-Za-z0-9]{16,}/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["url_credential", /https?:\/\/[^\s/@:"]+:[^\s/@"]+@/],
];

/** The pattern names found in a value, read as JSON text, and any of `exact` (strings held in memory) found in it. */
export function secretHits(value, exact = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const hits = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (exact.some((s) => s && s.length >= 8 && text.includes(s))) hits.push("held_secret");
  return hits;
}

/** The scan each person runs on their own machine (R-18, R-33). It prints a count of files, never their contents. */
export const LOCAL_SCAN = `grep -rlE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|a2asec_|x-access-token' ~/.podster-runner/logs ~/podster-work 2>/dev/null | wc -l`;
/** The git configuration check in a task folder (R-33, R-38). */
export const GIT_CONFIG_CHECK = `git -C <task folder> config --list --show-origin | grep -ciE 'extraheader|x-access-token|credential|ghs_|github_pat_'`;
/** The listening-port check, per system (R-22). */
export const PORT_CHECK = {
  first: "lsof -nP -iTCP -sTCP:LISTEN | grep -ci node",
  second: "ss -ltnp | grep -c node",
};
/** The teardown count each person runs (R-13, and the WSL2 record). */
export const TEARDOWN_COUNT = `echo $(( $(docker ps -aq --filter label=${RUNNER_LABEL} | wc -l) + $(docker network ls -q --filter label=${RUNNER_LABEL} | wc -l) ))`;

// ---- judging what the room's owner reads ----

const at = (event) => (typeof event?.created_at === "number" ? event.created_at : Date.parse(event?.created_at ?? ""));
const isAgent = (id) => typeof id === "string" && id.startsWith("agt_");

/** A task's room events, oldest first, by seq. */
export function eventsOf(events, task) {
  return (events ?? []).filter((e) => e.task_id === task).sort((a, b) => a.seq - b.seq);
}

/** The status each event leaves the task in, walked from the events' `new_status`. */
export function withStatus(events) {
  let status = null;
  return events.map((e) => {
    const before = status;
    if (e.new_status) status = e.new_status;
    return { ...e, before };
  });
}

const fail = (detail) => ({ status: "FAIL", detail });
const pass = (detail = "") => ({ status: "PASS", detail });
const notShown = (detail) => ({ status: "NOT SHOWN", detail });

/** R-05: accepted by the assignee before any repository access or submission. */
export function judgeAcceptedFirst(events, agent) {
  const firstAccept = events.findIndex((e) => e.type === "task.accepted" && e.actor_id === agent);
  if (firstAccept === -1) return fail(`no task.accepted by ${agent}`);
  const early = events.slice(0, firstAccept).filter((e) => e.type === "repo_access.issued" || e.type === "task.submitted");
  return early.length ? fail(`${early.map((e) => e.type).join(", ")} before the accept`) : pass(`accepted at seq ${events[firstAccept].seq}`);
}

/** R-06: accepts never outnumber offers (a task made already offered counts as one). */
export function judgeOneAccept(events, agent) {
  const accepts = events.filter((e) => e.type === "task.accepted" && e.actor_id === agent).length;
  const offers = Math.max(1, events.filter((e) => e.type === "task.offered" || e.type === "task.reassigned" || (e.type === "task.created" && e.new_status === "offered")).length);
  return accepts <= offers ? pass(`${accepts} accept(s), ${offers} offer(s)`) : fail(`${accepts} accepts for ${offers} offer(s)`);
}

/** R-12: one submission per round of work (the first, and one after each request for changes). */
export function judgeSubmissions(events, { max } = {}) {
  const submitted = events.filter((e) => e.type === "task.submitted").length;
  const allowed = max ?? 1 + events.filter((e) => e.type === "task.changes_requested").length;
  return submitted <= allowed ? pass(`${submitted} submission(s)`) : fail(`${submitted} submissions, at most ${allowed} expected`);
}

/** R-13, R-24, R-41, R-05: after a cancel, nothing more is accepted, issued or submitted. */
export function judgeCanceled(events, task) {
  const cancel = events.findIndex((e) => e.type === "task.canceled");
  if (cancel === -1 || task?.status !== "canceled") return fail(`not canceled (status ${task?.status ?? "unknown"})`);
  const after = events.slice(cancel + 1).filter((e) => ["task.accepted", "task.submitted", "repo_access.issued"].includes(e.type));
  return after.length ? fail(`${after.map((e) => e.type).join(", ")} after the cancel`) : pass(`canceled at seq ${events[cancel].seq}`);
}

/** R-24: no submission at all (a run stopped by its cap, or canceled before it finished). */
export function judgeNoSubmission(events) {
  const submitted = events.filter((e) => e.type === "task.submitted");
  return submitted.length ? fail(`${submitted.length} submission(s)`) : pass("no submission");
}

/** R-07, R-20 out of scope, R-39: the agent never took the task on, from `afterSeq` on. */
export function judgeNotRun(events, agent, { afterSeq = 0, allowAccept = false } = {}) {
  const later = events.filter((e) => e.seq > afterSeq);
  const bad = later.filter((e) => (e.type === "task.accepted" && e.actor_id === agent && !allowAccept) || e.type === "repo_access.issued" || e.type === "task.submitted");
  return bad.length ? fail(`${bad.map((e) => e.type).join(", ")}`) : pass("never accepted, issued or submitted");
}

/** R-15, R-22: offered while Runner was stopped, and accepted only after the restart. */
export function judgeOfflineThenAccepted(events, agent, { stoppedSeq, restartedSeq }) {
  const offered = events.find((e) => ["task.created", "task.offered"].includes(e.type));
  if (!offered) return fail("no offer event");
  if (offered.seq <= stoppedSeq || offered.seq > restartedSeq) return notShown(`offered at seq ${offered.seq}, outside the stop (${stoppedSeq} to ${restartedSeq})`);
  const accept = events.find((e) => e.type === "task.accepted" && e.actor_id === agent);
  if (!accept) return fail("not accepted after the restart");
  return accept.seq > restartedSeq ? pass(`offered at seq ${offered.seq} while stopped, accepted at ${accept.seq}`) : fail(`accepted at seq ${accept.seq}, before the restart (${restartedSeq})`);
}

/** R-14: completed by a person who is the task's reviewer, never an agent, and not the person whose Runner ran it. */
export function judgeCompletedByReviewer(events, task, { runnerPerson, reviewerIsConductor }) {
  if (task?.status !== "completed") return fail(`status ${task?.status ?? "unknown"}, not completed`);
  const done = events.filter((e) => e.type === "task.completed").at(-1);
  if (!done) return fail("no task.completed event");
  if (isAgent(done.actor_id)) return fail("completed by an agent");
  if (done.actor_id !== task.reviewer) return fail("completed by someone other than the task's reviewer");
  // The conductor knows one person's ID, its own, and compares in memory only.
  if (runnerPerson === "first" && reviewerIsConductor) return fail("the reviewer is the person whose Runner ran it");
  if (runnerPerson === "second" && !reviewerIsConductor) return fail("the reviewer isn't the first person, though the second person's Runner ran it");
  return pass(`completed by its reviewer, the ${runnerPerson === "first" ? "second" : "first"} person`);
}

/** R-14, R-34: no merge or deploy event by a Runner agent. */
export function judgeNoMergeByAgent(events, agents) {
  const bad = events.filter((e) => /^(merge\.|release\.|deploy)/.test(e.type ?? "") && agents.includes(e.actor_id));
  return bad.length ? fail(bad.map((e) => e.type).join(", ")) : pass("none");
}

/** R-34, R-35, R-31: the task's change, as the room observed it on GitHub. */
export function judgeChange(change) {
  if (!change || change.pr_number == null) return fail("no pull request on record");
  if (change.head_in_repository === false) return fail("the pull request's head isn't in the room's repository");
  if (change.base_is_default === false) return fail("the pull request's base isn't the default branch");
  if (change.head_in_repository !== true || change.base_is_default !== true) return notShown(`PR #${change.pr_number} not yet observed on GitHub`);
  return pass(`PR #${change.pr_number}, head in the repository, base the default branch`);
}

/** R-32: every repository access went to the assignee while the task was accepted. */
export function judgeIssuanceScoped(events, agent) {
  const issued = withStatus(events).filter((e) => e.type === "repo_access.issued");
  if (!issued.length) return notShown("no repository access on record for the task");
  const bad = issued.filter((e) => e.actor_id !== agent || e.before !== "accepted");
  return bad.length ? fail(`${bad.length} of ${issued.length} issued to another principal or outside accepted`) : pass(`${issued.length} issued, each to the assignee while accepted`);
}

/** R-41: nothing issued after the task completed or was canceled. */
export function judgeNothingAfterEnd(events) {
  const end = events.findIndex((e) => e.type === "task.completed" || e.type === "task.canceled");
  if (end === -1) return notShown("the task hasn't ended");
  const after = events.slice(end + 1).filter((e) => e.type === "repo_access.issued");
  return after.length ? fail(`${after.length} issued after ${events[end].type}`) : pass(`none after ${events[end].type}`);
}

/** R-40: a run longer than an hour that pushed with a fresh repository access in its last part. */
export function judgeLongRun(events, agent) {
  const accept = events.find((e) => e.type === "task.accepted" && e.actor_id === agent);
  const submit = events.find((e) => e.type === "task.submitted");
  if (!accept || !submit) return fail(`${accept ? "" : "no accept "}${submit ? "" : "no submission"}`.trim());
  const ran = at(submit) - at(accept);
  if (!(ran >= LONG_RUN_MS)) return fail(`accepted to submitted took ${Math.round(ran / 60_000)} min, under an hour`);
  const issued = events.filter((e) => e.type === "repo_access.issued" && e.actor_id === agent).map(at);
  if (issued.length < 2) return fail(`${issued.length} repository access issued, a fresh one expected after the first hour`);
  const spread = Math.max(...issued) - Math.min(...issued);
  return spread >= LONG_RUN_LATE_ISSUE_MS ? pass(`ran ${Math.round(ran / 60_000)} min; ${issued.length} issued, ${Math.round(spread / 60_000)} min apart`) : fail(`issued only within ${Math.round(spread / 60_000)} min`);
}

/** R-18: every event names its actor, and accept and submit are the assignee's. */
export function judgeLinked(events, agent) {
  if (!events.length) return fail("no events");
  const unnamed = events.filter((e) => !e.actor_id);
  const wrong = events.filter((e) => ["task.accepted", "task.submitted", "repo_access.issued"].includes(e.type) && e.actor_id !== agent);
  if (unnamed.length) return fail(`${unnamed.length} event(s) with no actor`);
  return wrong.length ? fail(`${wrong.map((e) => e.type).join(", ")} by another principal`) : pass(`${events.length} events, each with its actor`);
}

/** R-04: both Runner agents hold plain roles. */
export function judgePlainRoles(members, agents) {
  const found = agents.map((id) => (members ?? []).find((m) => m.principal_id === id));
  if (found.some((m) => !m)) return fail("a Runner agent isn't a member of the room");
  const raised = found.filter((m) => ["owner", "admin"].includes(m.role));
  return raised.length ? fail(`role ${raised.map((m) => m.role).join(", ")}`) : pass(`roles ${found.map((m) => m.role).join(", ")}`);
}

/** R-04: no access administration by a Runner agent in the room's audit. */
export function judgeNoAdminAudit(audit, agents) {
  const ADMIN = /grant|invit|owner|admin|visib|archive|access|member\.(add|remove|role)|repository|transfer|recover/;
  const bad = (audit ?? []).filter((a) => agents.includes(a.actor_id) && ADMIN.test(a.action ?? "") && a.outcome !== "denied");
  return bad.length ? fail(`administration by a Runner agent: ${[...new Set(bad.map((a) => a.action))].join(", ")}`) : pass(`${(audit ?? []).length} audit entries, none administration by a Runner agent`);
}

/** R-01, R-02: the nudge's own history, as its organization's admin reads it. */
export function judgeNudgeConsent(view) {
  const endpoint = view?.endpoint;
  if (!endpoint) return fail("no endpoint");
  if (endpoint.nudge_on !== true) return fail("the nudge isn't on");
  if (endpoint.control !== "verified") return fail(`control ${endpoint.control ?? "unknown"} while on`);
  const history = [...(view.history ?? [])].reverse();
  const on = history.filter((h) => h.type === "nudge_on" && h.version === endpoint.version).at(-1);
  if (!on) return fail("no nudge_on in the endpoint's history at its version");
  if (isAgent(on.actor_id)) return fail("switched on by an agent");
  const verified = history.findIndex((h) => h.type === "verified" && h.version === endpoint.version);
  if (verified === -1 || verified > history.indexOf(on)) return fail("switched on before control was verified");
  return pass(`version ${endpoint.version}: verified, then switched on by a person`);
}

/** A probe's answer: refused means a 4xx from Runner. A 2xx is a failure; anything else isn't Runner's answer. */
export function judgeRefused(status) {
  if (status === null) return notShown("no answer: the tunnel or Runner isn't reachable");
  if (status >= 400 && status < 500) return pass(`HTTP ${status}`);
  if (status >= 200 && status < 300) return fail(`HTTP ${status}: taken`);
  return notShown(`HTTP ${status}, not Runner's own answer`);
}

/** After Runner stopped: no 2xx, which would mean something still takes requests there. */
export function judgeClosed(status) {
  if (status === null || status >= 500) return pass(status === null ? "no connection" : `HTTP ${status} from the tunnel`);
  if (status >= 200 && status < 300) return fail(`HTTP ${status}: something still answers`);
  return fail(`HTTP ${status}: something still answers with Runner's refusal`);
}

/** A person's y/n, as a clause. */
export function judgeAnswer(answer, { yes = "PASS" } = {}) {
  if (answer === null || answer === undefined) return notShown("skipped");
  if (answer === true) return yes === "PASS" ? pass("confirmed by the person") : fail("the person said yes");
  return yes === "PASS" ? fail("the person said no") : pass("confirmed by the person");
}

/** A count a person read off their own machine, which must be zero. */
export function judgeZero(count) {
  if (count === null || count === undefined) return notShown("skipped");
  return count === 0 ? pass("0") : fail(String(count));
}

// ---- results and the report ----

export class Results {
  constructor({ kind, half }) {
    this.kind = kind;
    this.half = half;
    this.clauses = {};
    this.wsl2 = {};
    this.ids = { room: null, agents: {}, tasks: {} };
    this.facts = {};
  }

  record(criterion, clause, result, machine) {
    const spec = CRITERIA[criterion]?.clauses?.[clause];
    if (!spec) throw new Error(`no clause ${criterion}.${clause}`);
    const key = `${criterion}.${clause}${machine ? `.${machine}` : ""}`;
    // A clause shown twice keeps its worst: a later pass never hides an earlier failure.
    const order = { FAIL: 2, "NOT SHOWN": 1, PASS: 0 };
    const old = this.clauses[key];
    if (!old || order[result.status] > order[old.status]) this.clauses[key] = { status: result.status, detail: String(result.detail ?? "").slice(0, 300) };
    return result;
  }

  /** Every clause in the halves run that nothing recorded is NOT SHOWN, with why. */
  fillUnshown(reason, { rehearsal = false } = {}) {
    for (const [id, c] of Object.entries(CRITERIA)) {
      for (const [name, clause] of Object.entries(c.clauses)) {
        if (this.half !== "both" && clause.half !== this.half) continue;
        if (!Object.keys(this.clauses).some((k) => k === `${id}.${name}` || k.startsWith(`${id}.${name}.`))) {
          this.clauses[`${id}.${name}`] = { status: "NOT SHOWN", detail: rehearsal ? `${reason} (rehearsal)` : reason };
        }
      }
    }
  }

  /** FAIL if any clause failed; NOT SHOWN if any staged clause wasn't shown; PASS only when every staged clause passed. */
  criteria() {
    const out = {};
    for (const id of criteriaFor(this.half)) {
      const mine = Object.entries(this.clauses).filter(([k]) => k.startsWith(`${id}.`));
      const statuses = mine.map(([, v]) => v.status);
      const status = !mine.length ? "NOT SHOWN" : statuses.includes("FAIL") ? "FAIL" : statuses.includes("NOT SHOWN") ? "NOT SHOWN" : "PASS";
      out[id] = { status, title: CRITERIA[id].title, clauses: Object.fromEntries(mine.map(([k, v]) => [k.slice(id.length + 1), v])), left_to_local: CRITERIA[id].local };
    }
    return out;
  }

  counts() {
    const counts = { PASS: 0, FAIL: 0, "NOT SHOWN": 0 };
    for (const c of Object.values(this.criteria())) counts[c.status]++;
    return counts;
  }

  report(extra = {}) {
    return {
      kind: this.kind,
      counts_as_gate: this.kind === "gate",
      half: this.half,
      target: STAGING,
      ids: this.ids,
      facts: this.facts,
      wsl2: this.wsl2,
      counts: this.counts(),
      criteria: this.criteria(),
      ...extra,
    };
  }
}

/** The exit code a finished run gives. */
export function exitCode(results, { stopped }) {
  if (results.counts().FAIL) return EXIT.failed;
  return stopped ? EXIT.stopped : EXIT.ok;
}

/** A report must carry IDs only: no person ID, no credential, nothing held in memory. Returns what's wrong. */
export function reportProblems(text, { exact = [], personIds = [] } = {}) {
  const problems = secretHits(text, exact).map((name) => `credential pattern ${name}`);
  if (personIds.some((id) => id && text.includes(id))) problems.push("a person ID");
  if (/@[a-z0-9-]+\.[a-z]{2,}/i.test(text)) problems.push("an email-like string");
  return problems;
}

// ---- what the people make ----

/** A task's title and instructions, tagged so the conductor finds it in the room. The content is test content only. */
export function taskText(step, tag, extra = "") {
  const titles = {
    scope: "M7 scope check: should not start",
    ask: "M7 ask-first run",
    crash: "M7 crash and restart",
    offline: "M7 offered while Runner is stopped",
    revoked: "M7 canceled while Runner is stopped",
    budget: "M7 budget stop",
    unattended: "M7 unattended run",
    grant: "M7 push grant taken back",
    long: "M7 run longer than an hour",
    nudge: "M7 nudge pickup",
  };
  const work = {
    long: `Run the shell command sleep 100, forty times, one call at a time, so this run takes over an hour. Then add the file m7/${tag}.md holding one line, "long run ${tag}", commit it and open a pull request. Run no tests.`,
    budget: `Write twenty files, m7/${tag}/1.md to m7/${tag}/20.md, one per turn, each holding a short paragraph. Then open a pull request.`,
    offline: `Write ten files, m7/${tag}/1.md to m7/${tag}/10.md, one at a time, each holding a short paragraph about the number. Then open a pull request. Run no tests.`,
  };
  return {
    title: `${titles[step] ?? step} [${tag}]`,
    instructions: work[step] ?? `Add the file m7/${tag}.md holding one line, "${step} ${tag}", commit it and open a pull request. Run no tests.${extra ? ` ${extra}` : ""}`,
  };
}

/** A tag no other task in the room has: the step and some random letters. */
export function makeTag(step, random) {
  return `m7-${step}-${random}`;
}

/** The task in a room listing whose title carries the tag. */
export function findTagged(tasks, tag) {
  const found = (tasks ?? []).filter((t) => typeof t.title === "string" && t.title.includes(`[${tag}]`));
  return found.length === 1 ? found[0] : found.length > 1 ? { duplicate: found.length } : null;
}
