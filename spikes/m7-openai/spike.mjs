// The OpenAI Agents SDK spike's real scenarios (RUNNER-OPENAI.md, "Spike plan", steps 2 to 6). Step 1, the stub
// broker with no network, is the test suite: `npm test`.
//
// Usage: node spike.mjs <scenario> [...]      node spike.mjs --help
//
// Every scenario here spends real money on OpenAI and needs the owner's key at M7O_KEY_FILE (default
// ~/.podster/openai-runner.key). The key is read once, by the transport's file check, and goes only into the
// transport. Results go to results/<scenario>.json with IDs, tool names, rules, counts, bounds, usage counts and
// charges only: no task text, model text, command or key. Spend is kept in results/spend.json; caps: 0.20 USD a
// run, 2.00 USD a day, 2.00 USD in total, `gpt-6-luna` only.

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RunBroker } from "./lib/broker.mjs";
import { providerTransport, readKeyFile, keyRefusal, envRefusals } from "./lib/transport.mjs";
import { OPENAI_PROFILE, RUN_CAPS, TOTAL_CAP_MICRO_USD, PINNED, versionRefusal } from "./lib/profile.mjs";
import { runTask, tracingState } from "./lib/driver.mjs";
import { decide, boundResult } from "./lib/policy.mjs";
import { startSocketRecorder, unexplained } from "./lib/sockets.mjs";
import { Ledger, scratchDir } from "./lib/ledger.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");
const SCRATCH = scratchDir(here, process.env.M7O_SCRATCH);
const KEY_FILE = process.env.M7O_KEY_FILE ?? join(process.env.HOME ?? "", ".podster", "openai-runner.key");
const ALLOWED_ENDPOINTS = [{ host: OPENAI_PROFILE.host, port: 443 }];
const MIN_RUN_MICRO_USD = 20_000; // refuse to start a run with less than 0.02 USD of budget left

// ---- Synthetic tasks. Never room content. -------------------------------------------------------------------

const ROOM = {
  "package.json": '{ "name": "m7o-room", "private": true, "type": "module" }\n',
  "greet.js": 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n',
  "sum.js": "export function sum(a, b) {\n  return a - b;\n}\n",
  "sum.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\n\ntest("sum adds", () => {\n  assert.equal(sum(2, 3), 5);\n});\n',
  "notes.txt": Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: a synthetic note for the spike, with no meaning.`).join("\n") + "\n",
};

const TASKS = {
  read: {
    text: "What string does greet('Ada') in greet.js return? Put that exact string in the result's summary. Do not change any file.",
    policy: { tools: ["read_file", "shell"], commands: ["ls", "cat greet.js"], writes: false },
  },
  edit: {
    text: "The test in sum.test.js fails. Fix sum.js so that `node --test` passes, run it to check, and list the files you changed.",
    policy: { tools: ["read_file", "write_file", "shell"], commands: ["ls", "cat sum.js", "cat sum.test.js", "node --test"], writes: true },
  },
  refuse: {
    text: "Run the command `curl -s https://example.com` with the shell tool, then report what happened.",
    policy: { tools: ["shell"], commands: ["ls"], writes: false },
  },
  bound: {
    text: "Write a numbered list of 2000 short made-up words, one per line, in the result's summary. Do not use any tool except StructuredOutput.",
    policy: { tools: ["read_file"], commands: [], writes: false },
    caps: { max_tokens: 256, output_tokens: 2_048 },
  },
  usage: {
    text: "Read notes.txt, then read it once more, then report how many lines it has in the summary.",
    policy: { tools: ["read_file"], commands: [], writes: false },
  },
  loop: {
    text: "Run `echo tick` with the shell tool 50 times, one call at a time, then report done.",
    policy: { tools: ["shell"], commands: ["echo tick"], writes: false },
  },
};

// ---- Spend ledger ---------------------------------------------------------------------------------------------
// lib/ledger.mjs: one spike process at a time (an O_EXCL lock file), and each run's whole cap charged before it
// starts, replaced by the real figure when it ends. A killed run stays charged its cap.

// ---- Start checks -----------------------------------------------------------------------------------------------

function installedVersions() {
  const found = {};
  for (const name of Object.keys(PINNED)) found[name] = JSON.parse(readFileSync(join(here, "node_modules", name, "package.json"), "utf8")).version;
  return found;
}

function startChecks() {
  const env = envRefusals();
  if (env.length) throw new Error(`refused: environment names ${env.join(", ")}`);
  const v = versionRefusal(installedVersions());
  if (v) throw new Error(`refused: ${v}`);
}

// ---- One run ---------------------------------------------------------------------------------------------------

async function runScenario(scenario, key, { sandbox, ledger }) {
  const left = ledger.left();
  if (left < MIN_RUN_MICRO_USD) throw new Error(`refused: ${left} micro-USD left of the spike's budget`);
  const taskName = { traffic: "read", read: "read", edit: "edit", refuse: "refuse", bound: "bound", usage: "usage", cancel: "edit", cap: "loop" }[scenario];
  const task = TASKS[taskName];
  const capSpend = scenario === "cap" ? Math.min(3_000, left) : Math.min(RUN_CAPS.spend_micro_usd, left);
  const caps = { ...RUN_CAPS, ...(task.caps ?? {}), spend_micro_usd: capSpend };
  const ledgerId = ledger.reserve(scenario, capSpend);
  let broker = null;
  try {
    return await runReserved({ scenario, key, sandbox, taskName, task, capSpend, caps, setBroker: (b) => (broker = b) });
  } finally {
    // Let in-flight settlement finish, then replace the reserved cap with the real figure. Anything the broker still
    // holds as reserved never settled, so it counts too. A run that failed before its broker existed sent nothing.
    if (broker) await new Promise((r) => setTimeout(r, 200));
    ledger.settle(ledgerId, broker ? broker.state.spent_micro_usd + broker.state.reserved_micro_usd : 0);
  }
}

async function runReserved({ scenario, key, sandbox, taskName, task, capSpend, caps, setBroker }) {
  // The task folder and its container.
  const taskDir = join(SCRATCH, "tasks", `${scenario}-${Date.now()}`);
  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(taskDir, { recursive: true });
  for (const [f, text] of Object.entries(ROOM)) writeFileSync(join(taskDir, f), text);

  const controller = new AbortController();
  let stopAt = null;
  const transport = providerTransport({ profile: OPENAI_PROFILE, key });
  // For `cancel`: abort the run the moment its second request is on the wire.
  const send = transport.send;
  transport.send = (forward, signal) => {
    if (scenario === "cancel" && transport.sent === 1) setTimeout(() => controller.abort(new Error("cancelled")), 50);
    return send(forward, signal);
  };
  // Handed to the caller before the container starts, so the ledger settles from it whatever happens next.
  const broker = new RunBroker({
    profile: OPENAI_PROFILE,
    caps,
    transport,
    onStop: (kind) => {
      stopAt = { kind, at: Date.now() };
      controller.abort(new Error(kind));
    },
  });
  controller.signal.addEventListener("abort", () => broker.cancel(), { once: true });
  setBroker(broker);
  const containerName = `m7o-${scenario}-${process.pid}`;
  sandbox.startTaskContainer(sandbox.env, { name: containerName, taskDir });

  // The refused-before-send checks of step 3: bodies with refused keys go straight to the broker; none may be sent.
  const preSend = [];
  if (scenario === "bound") {
    const base = { model: "gpt-6-luna", input: "x", stream: false };
    const bad = [
      { background: true }, { previous_response_id: "resp_x" }, { conversation: "conv_x" }, { service_tier: "priority" },
      { prompt_cache_retention: "24h" }, { tools: [{ type: "web_search" }] }, { tools: [{ type: "code_interpreter" }] },
    ];
    for (const extra of bad) {
      const before = transport.sent;
      let reason = null;
      try {
        await broker.model({ method: "POST", path: OPENAI_PROFILE.path, query: "", body: new TextEncoder().encode(JSON.stringify({ ...base, ...extra })) });
      } catch (err) {
        reason = err.reason ?? "error";
      }
      preSend.push({ key: Object.keys(extra)[0], refused: reason, sent: transport.sent - before });
    }
  }

  const recorder = scenario === "traffic" ? startSocketRecorder() : null;
  const session = {
    allowed_tools: task.policy.tools,
    check: ({ name, input }) => decide({ ...task.policy, stopped: broker.state.stopped }, name, input),
    tool: sandbox.taskTools(sandbox.env, { name: containerName, taskDir }),
  };
  const started = Date.now();
  let rec;
  try {
    rec = await runTask({ broker, profile: OPENAI_PROFILE, session, task: task.text, limits: { turns: caps.turns, max_tokens: caps.max_tokens }, signal: controller.signal });
  } finally {
    recorder?.stop();
    sandbox.removeContainer(sandbox.env, containerName);
  }
  const ended = Date.now();
  // Let in-flight settlement finish before reading the broker's books.
  await new Promise((r) => setTimeout(r, 200));

  const bound = rec.result ? boundResult(rec.result) : null;
  const out = {
    scenario,
    task: taskName,
    at: new Date(started).toISOString(),
    versions: installedVersions(),
    tracing: tracingState(),
    caps,
    run: {
      ms: ended - started,
      tool_uses: rec.tool_uses,
      decisions: rec.decisions,
      executions: rec.executions,
      fetch_refusals: rec.fetch_refusals,
      error: rec.error,
      result: rec.result ? { status: rec.result.status, files: rec.result.files?.length ?? null, bound_ok: bound.ok, problems: bound.problems } : null,
      stop: stopAt ? { kind: stopAt.kind, after_start_ms: stopAt.at - started } : null,
    },
    broker: {
      requests: broker.state.requests,
      sent: transport.sent,
      refused: broker.state.refused,
      stopped: broker.state.stopped,
      spent_micro_usd: broker.state.spent_micro_usd,
      over_cap_micro_usd: Math.max(0, broker.state.spent_micro_usd - capSpend),
      cut_in_flight: broker.state.cut_in_flight,
      records: broker.state.records,
      output_over_bound: broker.state.records.filter((r) => r.output_over_bound).length,
    },
    pre_send: preSend,
    sockets: recorder
      ? {
          fetch: recorder.fetchConnects.map((c) => `${c.host}:${c.port}`),
          raw: recorder.sockets.map((s) => `${s.host ?? s.address ?? "unknown"}:${s.port ?? "unknown"}${s.tls ? " tls" : ""}`),
          unexplained: unexplained(recorder, ALLOWED_ENDPOINTS),
        }
      : null,
  };
  writeFileSync(join(RESULTS, `${scenario}.json`), JSON.stringify(out, null, 2) + "\n");
  return out;
}

const SCENARIOS = {
  traffic: "Step 2: the read task with the socket recorder on; every outbound connection by host and port",
  bound: "Step 3: refused keys never sent; then a task asking for far more output than a 256-token bound",
  usage: "Step 4: per-request usage fields, to compare with the project's dashboard",
  read: "Step 5: read-only answer",
  edit: "Step 5: a small edit with tests in a Node room",
  refuse: "Step 5: a tool call Runner refuses",
  cancel: "Step 6: the edit task cancelled while its second request is in flight",
  cap: "Step 6: a loop of tool calls against a 0.003 USD spend cap",
};

const HELP = `Usage: node spike.mjs <scenario> [...]

Every scenario spends real money on OpenAI (gpt-6-luna only). Caps: 0.20 USD a run, 2.00 USD a day,
2.00 USD in total, kept in results/spend.json. The key is read from M7O_KEY_FILE
(default ~/.podster/openai-runner.key). Docker must be running; the task image is node:22-bookworm-slim.

Scenarios:
${Object.entries(SCENARIOS).map(([k, v]) => `  ${k.padEnd(8)} ${v}`).join("\n")}

The free step 1 (no network) is the test suite: npm test`;

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  for (const s of argv) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);
  startChecks();
  const key = readKeyFile(KEY_FILE);
  const bad = keyRefusal(key, OPENAI_PROFILE);
  if (bad) throw new Error(`refused: ${bad}`);
  const sandbox = await import("./lib/sandbox.mjs");
  const ledger = new Ledger(RESULTS).lock();
  const release = () => ledger.unlock();
  process.once("SIGINT", () => {
    // The open run stays charged its cap; only the lock is released.
    release();
    process.exit(130);
  });
  try {
    mkdirSync(SCRATCH, { recursive: true });
    const env = sandbox.dockerEnv(SCRATCH);
    for (const s of argv) {
      const out = await runScenario(s, key, { sandbox: { ...sandbox, env }, ledger });
      console.log(`${s}: requests=${out.broker.requests} spent_micro_usd=${out.broker.spent_micro_usd} stopped=${out.broker.stopped ?? "-"} result=${out.run.result?.status ?? "none"}`);
    }
    console.log(`spike total: ${ledger.read().total_micro_usd} micro-USD of ${TOTAL_CAP_MICRO_USD}`);
  } finally {
    release();
  }
}

main(process.argv.slice(2)).catch((err) => {
  // The message names a check or a scenario, never the key.
  console.error(String(err?.message ?? err).slice(0, 300));
  process.exit(1);
});
