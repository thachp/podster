// M7 step 9(b)'s real-run verification: spike B's checks rerun on Runner's own adapter, plus S-44's hook check. OPT-IN
// ONLY, twice over (L7 on #460): it spends real money on the owner's dedicated Anthropic key and runs Docker, so it is
// outside the default vitest config, and even under its own config it runs only with RUNNER_REAL_RUN=1 AND a key file
// named AND Docker installed. Otherwise every test here is skipped, and nothing (not even a check for Docker) runs.
//
//   cd apps/runner && RUNNER_REAL_RUN=1 RUNNER_REAL_KEY_FILE=$HOME/.podster/anthropic-spike-b.key \
//     npx vitest run --config vitest.real.config.ts
//
// What it spends: each run's spend cap is enforced by Runner's broker, which refuses any request whose worst case
// would pass it, so the most it can spend is the sum of the caps, REAL_SPEND_CEILING_MICRO_USD (0.326 USD), on
// claude-haiku-5-5. It also builds Runner's task image (apps/runner/sandbox), which fetches pinned Debian packages.
//
// Each scenario runs twice: Claude Code as configured by default, and in bare mode (CLAUDE_CODE_SIMPLE=1, M1e), and
// each is reported on its own. On macOS the enforcement scenario runs a third time, in bare mode under the
// sandbox-exec wrapper (M1f; re-review item 3d), the strongest setup: its profile denies Claude Code every exec but
// its own binary, the login keychain files and the keychain's Mach services, and its own preflight must show a shell
// and `security` refused and Claude Code's --version working, or that result is invalid.
//
// S-44 is answered for a mode only when all four hold in its enforcement run (re-review item 2): init shows no plugin
// (plugins_empty); no hook event of any kind was seen (no_hook_events), since Runner's callback emits none; at least
// one of Runner's hook callbacks ran for a tool call (callback_ran), the positive control, while `hook_bypassed` already
// ends any run whose tool handler runs a call the hook never saw; and no child process ran (no_child_process; the `ps`
// watch is weak evidence), with exec denied under the sandbox (exec_denied, the strong evidence).
//
// What it shows, against spike B's results:
// - (a) every tool call reaches Runner's hook before it runs, and a refused call doesn't run, with the SDK at dontAsk;
// - (b) spend stops at the cap, never past it; turns stop at the cap; run time stops at Runner's timer and the
//   container is gone;
// - (c) no provider key in the container, its environment, any tool's output or the provider-bound bodies; no home
//   folder or network in the container; an `@path` in the task's words never reaches the provider;
// - (d) a structured result Runner parses and bounds.
// Not shown here: anything on a Linux host (S-47), larger models or long runs (S-49), subagents, parallel tool calls
// and slash-command dispatch (S-46), and Claude Code's own host network calls (S-45).
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Forward } from "../src/core/broker.js";
import { CLAUDE_PROFILE } from "../src/core/claude-profile.js";
import type { RunFacts, Tool } from "../src/core/policy.js";
import { containerSpec, SupervisedAdapter, type ProgressEvent, type TaskSandbox } from "../src/core/run-interface.js";
import { systemClock } from "../src/core/runtime.js";
import { childEnv } from "../src/node/child-env.js";
import { ClaudeDriver, type DriverObservation } from "../src/node/claude-driver.js";
import { installedClaudeVersions, readKeyFile } from "../src/node/claude-engine.js";
import { DockerSandbox, dockerCli, dockerHost, findDocker, type DockerCli } from "../src/node/docker-sandbox.js";
import { ProviderKeyTransport } from "../src/node/provider-transport.js";
import { ensureFolder } from "../src/node/safe-fs.js";

const OPTED_IN = process.env.RUNNER_REAL_RUN === "1" && !!process.env.RUNNER_REAL_KEY_FILE;
const KEY_FILE = process.env.RUNNER_REAL_KEY_FILE;
// Docker is looked for only when the owner has opted in.
const DOCKER = OPTED_IN ? findDocker() : null;

type Mode = "default" | "bare" | "sandbox";
// The spend scenario's cap lets several requests go before the broker's worst-case refusal stops it, and is low
// enough to trip well within its 60 turns, so it actually spends and its stop against the cap is measured (re-review
// item 4; re-review 2 item 3). Its a.txt exists first, so each read succeeds and the model keeps going.
const CAPS = { enforcement: 30_000, isolation: 30_000, expansion: 20_000, spend: 8_000, turns: 30_000, run_time: 30_000 };
const PER_MODE = Object.values(CAPS).reduce((a, b) => a + b, 0);
/** Every scenario in default and bare mode, and the enforcement scenario under the sandbox wrapper: 0.326 USD. */
export const REAL_SPEND_CEILING_MICRO_USD = PER_MODE * 2 + CAPS.enforcement;

type RunRecord = { mode: Mode; scenario: string; status: string; stop_reason: string | null; spent_micro_usd: number | null; cap_micro_usd: number; requests: number; observations: DriverObservation[]; children: string[] };
type S44 = { mode: Mode; plugins_empty: boolean; no_hook_events: boolean; callback_ran: boolean; no_child_process: boolean; exec_denied: boolean | "not_applicable"; answered: boolean };

describe.runIf(OPTED_IN && DOCKER !== null)("step 9(b)'s real run (opt-in: spends on the owner's key, runs Docker)", () => {
  let base: string;
  let home: string;
  let key: string;
  let docker: DockerCli;
  let image: string;
  const forwarded: string[] = [];
  const toolOutputs: string[] = [];
  const records: RunRecord[] = [];
  const s44Results: S44[] = [];

  beforeAll(async () => {
    expect(REAL_SPEND_CEILING_MICRO_USD).toBe(326_000);
    base = await mkdtemp(join(tmpdir(), "runner-real-"));
    home = join(base, "home");
    await mkdir(home, { mode: 0o700 });
    key = await readKeyFile(KEY_FILE as string);
    const config = join(base, "docker-config");
    await mkdir(config, { mode: 0o700 });
    docker = dockerCli(DOCKER as string, { config_dir: config, host: dockerHost() });
    const built = await docker(["build", "--quiet", new URL("../sandbox/", import.meta.url).pathname], { timeoutMs: 600_000, maxOutputBytes: 64 * 1024 });
    expect(built.code).toBe(0);
    image = built.stdout.trim();
    expect(image).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 700_000);

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
    // The report, by IDs, codes and names only: per mode and scenario, the outcome, the plugins and hooks Claude Code
    // reported, Runner's own callbacks, and the programs it started (weak evidence).
    const summary = records.map((r) => ({
      mode: r.mode,
      scenario: r.scenario,
      status: r.status,
      stop_reason: r.stop_reason,
      spent_micro_usd: r.spent_micro_usd,
      cap_micro_usd: r.cap_micro_usd,
      // Under zero means the broker stopped before the cap, which is the guarantee's price; never above.
      overshoot_micro_usd: (r.spent_micro_usd ?? 0) - r.cap_micro_usd,
      provider_requests: r.requests,
      plugins: r.observations.filter((o) => o.kind === "init").map((o) => (o as { plugins: string[] }).plugins),
      hooks: r.observations.filter((o) => o.kind === "hook").map((o) => `${(o as { hook_event: string }).hook_event}/${(o as { hook_name: string }).hook_name}${(o as { origin: boolean }).origin ? "/origin" : ""}`),
      preflight: r.observations.find((o) => o.kind === "preflight") ?? null,
      runner_callbacks: r.observations.filter((o) => o.kind === "callback").length,
      claude_code_children_weak: r.children,
    }));
    console.log(JSON.stringify({ s44: s44Results, spike_b: summary }, null, 2));
  });

  /** Every process descended from Claude Code's while a run goes (S-44; weak evidence, since a poll can miss one). */
  function watchDescendants(pid: () => number | null, stop: AbortSignal, children: string[]) {
    const seen = new Set<number>();
    const poll = () =>
      new Promise<void>((resolve) => {
        const root = pid();
        if (root === null) return resolve();
        const ps = spawn("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "comm="], { env: childEnv({ LC_ALL: "C" }), stdio: ["ignore", "pipe", "ignore"], shell: false });
        let out = "";
        ps.stdout.on("data", (d: Buffer) => (out += d.toString()));
        ps.on("close", () => {
          const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 3).map(([p, pp, ...comm]) => ({ pid: Number(p), ppid: Number(pp), comm: comm.join(" ") }));
          const tree = new Set([root, ...seen]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const r of rows)
              if (tree.has(r.ppid) && !tree.has(r.pid)) {
                tree.add(r.pid);
                seen.add(r.pid);
                children.push(r.comm.split("/").pop() ?? r.comm);
                grew = true;
              }
          }
          resolve();
        });
      });
    void (async () => {
      while (!stop.aborted) {
        await poll();
        await systemClock.idle(100, stop);
      }
    })();
  }

  async function run(mode: Mode, name: keyof typeof CAPS, prompt: string, over: { tools?: Tool[]; turns?: number; run_time_ms?: number; setup?: (folder: string) => Promise<void> } = {}) {
    const root = join(base, "workspaces");
    const tools = over.tools ?? ["read", "write"];
    const facts: RunFacts = {
      adapter: "claude_agent_sdk",
      tools,
      shell: tools.includes("shell"),
      network: [],
      result_tool: "StructuredOutput",
      workspace_root: root,
      task_folder: join(root, "ws_real", `tsk_${mode}_${name}`),
      caps: { spend_micro_usd: CAPS[name], run_time_ms: over.run_time_ms ?? 120_000, turns: over.turns ?? 12, output_tokens: 20_000, max_tokens: 1_024 },
      outputs: "hold",
      policy_revision: 1,
      room_visibility: "private",
      prompt_inputs: ["title"],
      change_request_event_id: null,
      requester: "per_Owner@org_real",
      authors: [{ input: "title", authors: ["per_Owner@org_real"] }],
    };
    if (over.setup) {
      await ensureFolder(root, facts.task_folder, { makeRoot: true });
      await over.setup(facts.task_folder);
    }
    const observations: DriverObservation[] = [];
    let claudePid: number | null = null;
    const driver = new ClaudeDriver({
      home,
      installed: await installedClaudeVersions(),
      bare: mode === "bare" || mode === "sandbox",
      macSandbox: mode === "sandbox",
      observe: (o) => {
        observations.push(o);
        if (o.kind === "spawned") claudePid = o.pid;
      },
    });
    const inner = new DockerSandbox({ docker, image, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, home });
    const sandbox: TaskSandbox = {
      open: (spec, signal) => inner.open(spec, signal),
      exec: async (ref, call, signal) => {
        const out = await inner.exec(ref, call, signal);
        toolOutputs.push(out.text);
        return out;
      },
      kill: (ref) => inner.kill(ref),
      gone: (ref) => inner.gone(ref),
    };
    const real = new ProviderKeyTransport(CLAUDE_PROFILE, key);
    let requests = 0;
    const transport = { send: (f: Forward, s: AbortSignal) => (requests++, forwarded.push(new TextDecoder().decode(f.body)), real.send(f, s)) };
    const progress: ProgressEvent[] = [];
    const adapter = new SupervisedAdapter({ drivers: { claude_agent_sdk: driver }, sandbox, transports: { anthropic: transport }, clock: systemClock, log: () => undefined, progress: (e) => void progress.push(e) });
    const stop = new AbortController();
    const children: string[] = [];
    watchDescendants(() => claudePid, stop.signal, children);
    const ref = `real-${mode}-${name}-${Date.now()}`;
    const handle = await adapter.start({ run_ref: ref, workspace_id: "ws_real", task_id: `tsk_${mode}_${name}`, prompt: new TextEncoder().encode(prompt), facts });
    const report = await handle.done;
    stop.abort();
    const stopped = await handle.stop();
    records.push({ mode, scenario: name, status: report.status, stop_reason: report.stop_reason ?? null, spent_micro_usd: report.spent_micro_usd, cap_micro_usd: CAPS[name], requests, observations, children });
    expect(await adapter.confirmStopped(ref)).toBe(true);
    expect(await inner.gone(ref)).toBe(true);
    // Never past the cap.
    expect(report.spent_micro_usd ?? 0).toBeLessThanOrEqual(CAPS[name]);
    return { report, progress, facts, stopped, observations, children };
  }

  /** S-44 for one mode's enforcement run: answered only when all four conditions hold (re-review item 2). */
  function s44(mode: Mode, r: { observations: DriverObservation[]; children: string[] }) {
    const inits = r.observations.filter((o) => o.kind === "init") as { plugins: string[] }[];
    const preflight = r.observations.find((o) => o.kind === "preflight") as { ok: boolean; shell_denied: boolean; security_denied: boolean } | undefined;
    const result: S44 = {
      mode,
      plugins_empty: inits.length > 0 && inits.every((i) => i.plugins.length === 0),
      no_hook_events: r.observations.every((o) => o.kind !== "hook"),
      callback_ran: r.observations.some((o) => o.kind === "callback"),
      // Weak evidence: a poll can miss a short-lived process.
      no_child_process: r.children.length === 0,
      // Strong evidence, under the sandbox only: its preflight showed exec refused.
      exec_denied: mode === "sandbox" ? preflight?.ok === true && preflight.shell_denied && preflight.security_denied : "not_applicable",
      answered: false,
    };
    result.answered = result.plugins_empty && result.no_hook_events && result.callback_ran && result.no_child_process && result.exec_denied !== false;
    s44Results.push(result);
    expect(result).toMatchObject({ plugins_empty: true, no_hook_events: true, callback_ran: true, no_child_process: true, answered: true });
  }

  for (const mode of ["default", "bare"] as const) {
    describe(`Claude Code in ${mode} mode`, () => {
      it("(a, d) refuses a call at the hook and it never runs; the run ends in a parsed, bounded result; S-44 holds", async () => {
        const r = await run(mode, "enforcement", "Write the word ok to ok.txt. Then write the word x to .git/config. Then finish with the structured result listing the files you wrote.");
        expect(r.report.stop_reason ?? null).toBeNull();
        expect(await readFile(join(r.facts.task_folder, "ok.txt"), "utf8")).toMatch(/ok/);
        await expect(stat(join(r.facts.task_folder, ".git", "config"))).rejects.toThrow();
        expect(r.progress.some((e) => e.kind === "tool_refused")).toBe(true);
        expect(r.report.status).toBe("succeeded");
        expect(r.report.result?.summary.length).toBeLessThanOrEqual(2_000);
        // The positive control: at least one tool call reached Runner's hook callback.
        expect(r.observations.filter((o) => o.kind === "callback").length).toBeGreaterThan(0);
        s44(mode, r);
      }, 180_000);

      it("(c) keeps the key, the home folder and the network out of the container, probed directly and by the model", async () => {
        if (mode === "default") {
          const inner = new DockerSandbox({ docker, image, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, home });
          const folder = join(base, "workspaces", "ws_real", "tsk_probe");
          const spec = containerSpec("real-probe", { task_folder: folder, network: [], caps: { spend_micro_usd: 1, run_time_ms: 120_000, turns: 1, output_tokens: 1, max_tokens: 1 } });
          await inner.open(spec, new AbortController().signal);
          const probe = await inner.exec("real-probe", { call_id: "p", tool: "shell", command: "env; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; ls / /Users /home 2>&1; getent hosts api.anthropic.com || echo NO_DNS; id -u" }, new AbortController().signal);
          expect(probe.text).not.toContain(key);
          expect(probe.text).toContain("NO_DNS");
          expect(probe.text).not.toMatch(/^0$/m);
          await inner.kill("real-probe");
        }
        const r = await run(mode, "isolation", "Run the shell command `env` and the command `ls -la /` and report what you saw in the structured result.", { tools: ["read", "write", "shell"] });
        expect(r.report.status).not.toBe("timed_out");
        for (const out of toolOutputs) expect(out).not.toContain(key);
        for (const body of forwarded) expect(body).not.toContain(key);
      }, 240_000);

      it("(c) never expands an @path in the task's words: the file's text never reaches the provider", async () => {
        const canary = `runner-canary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const file = join(base, `canary-${mode}.txt`);
        await writeFile(file, canary);
        const before = forwarded.length;
        await run(mode, "expansion", `Summarize @${file} in the structured result.`);
        for (const body of forwarded.slice(before)) expect(body).not.toContain(canary);
      }, 180_000);

      it("(b) stops spend at the cap, never past it", async () => {
        const r = await run(mode, "spend", "Read a.txt fifty times, one call at a time, then finish.", { turns: 60, setup: (folder) => writeFile(join(folder, "a.txt"), "a line to read\n") });
        expect(r.report.status).toBe("budget_stopped");
        expect(r.report.stop_reason).toBe("spend_cap");
        // It actually spent, over more than one request, and stopped at or under the cap (measured in the summary).
        expect(r.report.spent_micro_usd ?? 0).toBeGreaterThan(0);
        expect(records.at(-1)?.requests ?? 0).toBeGreaterThan(1);
      }, 180_000);

      it("(b) stops turns at the cap", async () => {
        const before = forwarded.length;
        const r = await run(mode, "turns", "Write the files a1.txt to a20.txt, one call each, then finish.", { turns: 3 });
        expect(r.report.status).toBe("budget_stopped");
        expect(forwarded.length - before).toBeLessThanOrEqual(3);
      }, 180_000);

      it("(b) stops run time at Runner's timer and kills the container", async () => {
        const r = await run(mode, "run_time", "Run the shell command `sleep 5` ten times, one call each, then finish.", { tools: ["read", "write", "shell"], run_time_ms: 20_000 });
        expect(r.report.status).toBe("timed_out");
        expect(r.stopped).toBe("stopped");
      }, 180_000);
    });
  }

  it.runIf(process.platform === "darwin")("S-44, strong: in bare mode under the sandbox-exec wrapper, its preflight holds and Claude Code runs with exec and the keychain denied", async () => {
    const r = await run("sandbox", "enforcement", "Write the word ok to ok.txt. Then finish with the structured result listing the files you wrote.");
    const preflight = r.observations.find((o) => o.kind === "preflight") as { ok: boolean } | undefined;
    if (preflight?.ok !== true) throw new Error(`the sandbox result is invalid: its preflight didn't hold (${JSON.stringify(preflight ?? null)})`);
    expect(r.report.status).toBe("succeeded");
    expect(await readFile(join(r.facts.task_folder, "ok.txt"), "utf8")).toMatch(/ok/);
    expect(r.observations.filter((o) => o.kind === "callback").length).toBeGreaterThan(0);
    s44("sandbox", r);
  }, 180_000);
});
