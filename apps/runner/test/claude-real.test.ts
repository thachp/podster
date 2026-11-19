// M7 step 9(b)'s real-run verification: spike B's checks rerun on Runner's own adapter, plus S-44's hook check. OPT-IN
// ONLY, twice over (L7 on #460): it spends real money on the owner's dedicated Anthropic key and runs Docker, so it is
// outside the default vitest config, and even under its own config it runs only with RUNNER_REAL_RUN=1 AND a key file
// named AND Docker installed. Otherwise every test here is skipped, and nothing (not even a check for Docker) runs.
//
//   cd apps/runner && RUNNER_REAL_RUN=1 RUNNER_REAL_KEY_FILE=$HOME/.podster/anthropic-spike-b.key \
//     npx vitest run --config vitest.real.config.ts
//
// What it spends: each run's spend cap is enforced by Runner's broker, which refuses any request whose worst case
// would pass it, so the most it can spend is the sum of the caps, REAL_SPEND_CEILING_MICRO_USD (0.314 USD), on
// claude-haiku-5-5. It also builds Runner's task image (apps/runner/sandbox), which fetches pinned Debian packages.
//
// Each scenario runs twice: Claude Code as configured by default, and in bare mode (CLAUDE_CODE_SIMPLE=1, M1e), and
// each is reported on its own. On macOS the enforcement scenario runs a third time under the sandbox-exec wrapper
// (M1f), which denies Claude Code every exec but its own binary and the login keychain files: that is the strong S-44
// evidence. The `ps` watch of Claude Code's children is weak evidence and reported as such. S-44 is conclusive only if
// Runner's own PreToolUse callback shows as a hook event (the positive control, M1g); otherwise it is reported
// inconclusive.
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

const OPTED_IN = process.env.RUNNER_REAL_RUN === "1" && !!process.env.RUNNER_REAL_KEY_FILE;
const KEY_FILE = process.env.RUNNER_REAL_KEY_FILE;
// Docker is looked for only when the owner has opted in.
const DOCKER = OPTED_IN ? findDocker() : null;

type Mode = "default" | "bare" | "sandbox";
const CAPS = { enforcement: 30_000, isolation: 30_000, expansion: 20_000, spend: 2_000, turns: 30_000, run_time: 30_000 };
const PER_MODE = Object.values(CAPS).reduce((a, b) => a + b, 0);
/** Every scenario in default and bare mode, and the enforcement scenario under the sandbox wrapper. */
export const REAL_SPEND_CEILING_MICRO_USD = PER_MODE * 2 + CAPS.enforcement;

type RunRecord = { mode: Mode; scenario: string; status: string; stop_reason: string | null; spent_micro_usd: number | null; observations: DriverObservation[]; children: string[] };

describe.runIf(OPTED_IN && DOCKER !== null)("step 9(b)'s real run (opt-in: spends on the owner's key, runs Docker)", () => {
  let base: string;
  let home: string;
  let key: string;
  let docker: DockerCli;
  let image: string;
  const forwarded: string[] = [];
  const toolOutputs: string[] = [];
  const records: RunRecord[] = [];

  beforeAll(async () => {
    expect(REAL_SPEND_CEILING_MICRO_USD).toBe(314_000);
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
      plugins: r.observations.filter((o) => o.kind === "init").map((o) => (o as { plugins: string[] }).plugins),
      hooks: r.observations.filter((o) => o.kind === "hook").map((o) => `${(o as { hook_event: string }).hook_event}/${(o as { hook_name: string }).hook_name}`),
      runner_callbacks: r.observations.filter((o) => o.kind === "callback").length,
      claude_code_children_weak: r.children,
    }));
    console.log(JSON.stringify({ s44_and_spike_b: summary }, null, 2));
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

  async function run(mode: Mode, name: keyof typeof CAPS, prompt: string, over: { tools?: Tool[]; turns?: number; run_time_ms?: number } = {}) {
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
    const observations: DriverObservation[] = [];
    let claudePid: number | null = null;
    const driver = new ClaudeDriver({
      home,
      installed: await installedClaudeVersions(),
      bare: mode === "bare",
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
    const transport = { send: (f: Forward, s: AbortSignal) => (forwarded.push(new TextDecoder().decode(f.body)), real.send(f, s)) };
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
    records.push({ mode, scenario: name, status: report.status, stop_reason: report.stop_reason ?? null, spent_micro_usd: report.spent_micro_usd, observations, children });
    expect(await adapter.confirmStopped(ref)).toBe(true);
    expect(await inner.gone(ref)).toBe(true);
    // Never past the cap.
    expect(report.spent_micro_usd ?? 0).toBeLessThanOrEqual(CAPS[name]);
    return { report, progress, facts, stopped, observations, children };
  }

  /** S-44 for one run: no hook but Runner's own and no child program; inconclusive without the positive control. */
  function s44(r: { observations: DriverObservation[]; children: string[] }, strong: boolean) {
    const hooks = r.observations.filter((o) => o.kind === "hook") as { hook_event: string; hook_name: string }[];
    const callbacks = r.observations.filter((o) => o.kind === "callback").length;
    if (callbacks > 0 && !hooks.some((h) => h.hook_event === "PreToolUse")) throw new Error("S-44 inconclusive: Runner's own PreToolUse callback ran but never showed as a hook event, so the absence of other hook events proves nothing");
    expect(hooks.filter((h) => h.hook_event !== "PreToolUse")).toEqual([]);
    // Weak unless the run was under the sandbox wrapper, which denies every exec but Claude Code's own.
    expect({ strong, children: r.children }).toEqual({ strong, children: [] });
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
        s44(r, false);
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
        const r = await run(mode, "spend", "Read a.txt fifty times, one call at a time, then finish.");
        expect(r.report.status).toBe("budget_stopped");
        expect(r.report.stop_reason).toBe("spend_cap");
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

  it.runIf(process.platform === "darwin")("S-44, strong: under the sandbox-exec wrapper Claude Code runs, can exec nothing else, and reads no keychain file", async () => {
    const r = await run("sandbox", "enforcement", "Write the word ok to ok.txt. Then finish with the structured result listing the files you wrote.");
    expect(r.report.status).toBe("succeeded");
    expect(await readFile(join(r.facts.task_folder, "ok.txt"), "utf8")).toMatch(/ok/);
    s44(r, true);
  }, 180_000);
});
