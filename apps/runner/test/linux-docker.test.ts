// S-47's Linux proof on a real Docker Engine: CI's `runner` job runs it on GitHub's Ubuntu runner, through
// vitest.linux.config.ts, with RUNNER_LINUX_DOCKER=1. It never runs in the default config, on a Mac, or without that
// variable. It builds Runner's two images, starts the run's containers with the Unix-socket relay, and proves:
// - the engine's own Linux checks pass (Docker answers; a request crosses the relay with the per-run token);
// - with the production wiring (`claudeEngine`'s driver and sandbox, a real key file holding a fake key, the driver's
//   own `begin`, `claudeEnv`, `spawnEnv`, `claudeExecArgs` and `dockerEnv`), a long-lived process started as Claude
//   Code would be, with `sleep` in place of the `claude` binary so no model is called, and the task container open:
//   the key is in no `/proc/*/environ` and no file of the task container, Claude Code's container or the relay, nor in
//   the `docker exec` client's own environment on the host;
// - the scan isn't blind: the same run with the key put into Claude Code's environment, as a mutation of `claudeEnv`
//   or `dockerEnv` would, is caught both in the container and on the host;
// - the relay's networks are exactly the run's internal one and its mounts exactly the socket; Claude Code's container
//   can't connect out; the relay carries a request with the token, and the listener refuses one without it;
// - teardown leaves no container or network of the home.
// No provider is called: the key is a fake, the SDK is a stand-in that only asks the driver to start its process, and
// the upstream is a stand-in function on the host, given to the transport as its `fetch`.
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upstreamUrl } from "../src/core/broker.js";
import { CLAUDE_PROFILE } from "../src/core/claude-profile.js";
import { PLACEHOLDER_KEY, RESULT_SCHEMA, UNTRUSTED_FRAME, containerSpec, type DriverSession } from "../src/core/run-interface.js";
import { startBrokerListener } from "../src/node/broker-listener.js";
import { CLAUDE_IN_CONTAINER, CLAUDE_SDK, ClaudeDriver, claudeNames, nodeProcesses, RELAY_SOCKET_IN_CONTAINER, SOCKET_NAME, type ClaudeSdk, type ProcessControl } from "../src/node/claude-driver.js";
import { claudeEngine, installedClaudeVersions } from "../src/node/claude-engine.js";
import { dockerCli, dockerHost, findDocker, homeLabel, IMAGE_ID, LABEL_HOME, type DockerCli } from "../src/node/docker-sandbox.js";
import { ProviderKeyTransport } from "../src/node/provider-transport.js";
import { ensureFolder } from "../src/node/safe-fs.js";
import { answeredUnauthorized, unexpectedMounts } from "./probe-checks.js";

const ON = process.platform === "linux" && process.env.RUNNER_LINUX_DOCKER === "1";
// A fake key with a distinctive shape: what is searched for in every container.
const KEY = `sk-ant-ci-fake-${"0123456789abcdef".repeat(3)}`;
const REF = "ci-linux-1";
const apps = new URL("../", import.meta.url).pathname;

const request = (token: string | null) =>
  `POST /v1/messages HTTP/1.1\r\nHost: relay:8080\r\n${token === null ? "" : `x-api-key: ${token}\r\n`}content-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`;

describe.runIf(ON)("S-47: the two-container placement on a real Linux Docker Engine", () => {
  let home = "";
  let work = "";
  let keyFile = "";
  let docker: DockerCli;
  let program = "";
  let taskImage = "";
  let ccImage = "";
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  const run = (args: string[], input?: string, timeoutMs = 120_000) => docker(args, { input, timeoutMs, maxOutputBytes: 1024 * 1024 });

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "rld-"));
    work = await mkdtemp(join(tmpdir(), "rlw-"));
    await chmod(home, 0o700);
    await chmod(work, 0o700);
    program = findDocker() ?? "";
    expect(program).not.toBe("");
    docker = dockerCli(program, { config_dir: await ensureFolder(home, join(home, "docker-config")), host: dockerHost(process.env, "linux") });
    // Both images, as the owner builds them; only their IDs are used from here on.
    for (const [dir, file] of [["sandbox", "task-image"], ["claude-image", "claude-image"]] as const) {
      const built = await docker(["build", "-q", join(apps, dir)], { timeoutMs: 15 * 60_000, maxOutputBytes: 64 * 1024 });
      expect([dir, built.code]).toEqual([dir, 0]);
      const id = built.stdout.trim();
      expect(id).toMatch(IMAGE_ID);
      await writeFile(join(home, file), `${id}\n`, { mode: 0o600 });
      if (file === "task-image") taskImage = id;
      else ccImage = id;
    }
    keyFile = join(home, "provider.key");
    await writeFile(keyFile, KEY, { mode: 0o600 });
  }, 40 * 60_000);

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    if (work) await rm(work, { recursive: true, force: true });
  });

  /** Every process's environment in a container, read from inside it; the key is compared on the host. */
  const environs = async (container: string) => {
    const r = await run(["exec", container, "sh", "-c", 'for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null; printf "\\n"; done']);
    expect([container, r.code, r.cut]).toEqual([container, 0, false]);
    return r.stdout;
  };
  /** Files holding the key, outside /proc, /sys and /dev; the key goes in on grep's standard input, never as an argument. */
  const filesWithKey = async (container: string) => {
    const r = await run(["exec", "--interactive", container, "grep", "-rlsF", "--exclude-dir=proc", "--exclude-dir=sys", "--exclude-dir=dev", "-f", "/dev/stdin", "/"], `${KEY}\n`, 300_000);
    // grep exits 2 when any file couldn't be read, even with matches listed, so what it lists is read whatever its exit
    // code; only 0 (a match) or 1 (none) or 2 (some unreadable) are answers at all.
    expect([container, r.cut, [0, 1, 2].includes(r.code)]).toEqual([container, false, true]);
    return r.stdout.trim();
  };
  const cmdlines = async (container: string) => (await run(["exec", container, "sh", "-c", 'for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f" 2>/dev/null; printf "\\n"; done'])).stdout;

  it("the engine's own Linux checks pass on this host, and reap leaves nothing", async () => {
    const lines: string[] = [];
    const engine = await claudeEngine({ home, key_file: keyFile, log: (event, outcome) => void lines.push(`${event} ${outcome}`), platform: "linux" });
    await engine.reap();
    expect(lines).toContain("adapter.platform linux_checked");
    expect(lines).toContain("adapter.reap done");
  }, 300_000);

  it("with the production wiring, keeps the key out of every container and the exec client, and the scan catches a planted one", async () => {
    // The `docker exec` client's environment as the driver built it, per run; and, for the run named `ci-leak` only,
    // the key put into Claude Code's environment, as a mutation of claudeEnv or dockerEnv would.
    const clientEnv = new Map<string, Record<string, string>>();
    const processes: ProcessControl = {
      spawn(command, args, opts) {
        const container = args.find((a) => a.startsWith("podster-cc-")) as string;
        clientEnv.set(container, { ...opts.env });
        let argv = args;
        let env = opts.env;
        if (container === claudeNames("ci-leak").container) {
          env = { ...env, LEAK_PROBE: KEY };
          argv = [...args.slice(0, args.indexOf(container)), "--env", "LEAK_PROBE", ...args.slice(args.indexOf(container))];
          clientEnv.set(container, { ...env });
        }
        // `sleep` in place of Claude Code's binary: the same exec, environment and container, and no model call.
        const at = argv.indexOf(CLAUDE_IN_CONTAINER);
        return nodeProcesses.spawn(command, [...argv.slice(0, at), "sleep", "600"], { ...opts, env });
      },
    };
    // A stand-in SDK: it only asks the driver to start Claude Code's process, then waits until the run is cancelled.
    const sdk: ClaudeSdk = {
      ...CLAUDE_SDK,
      query: (({ options }: { options: { spawnClaudeCodeProcess: (s: SpawnOptions) => unknown; abortController: AbortController } }) =>
        (async function* () {
          options.spawnClaudeCodeProcess({ command: "claude", args: ["--output-format", "stream-json"], cwd: "/work", env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, signal: options.abortController.signal });
          await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
        })()) as never,
    };
    const engine = await claudeEngine({ home, key_file: keyFile, log: () => undefined, platform: "linux", driverSeams: { sdk, processes } });
    const driver = engine.drivers.claude_agent_sdk as ClaudeDriver;
    const halt = new AbortController();
    const session = (ref: string): DriverSession => ({
      run_ref: ref,
      prompt: { trust: "untrusted", origin: "podster_task", text: "ci" },
      frame: UNTRUSTED_FRAME,
      toolchains: [],
      allowed_tools: ["read", "StructuredOutput"],
      result_schema: RESULT_SCHEMA,
      limits: { turns: 1, max_tokens: 1, output_tokens: 1, run_time_ms: 240_000 },
      provider: { api_key: PLACEHOLDER_KEY },
      signal: halt.signal,
      check: () => ({ allow: false, reason: "ci" }) as never,
      tool: async () => ({ ok: false, text: "" }),
      model: async () => ({ ok: false, refused: "run_stopped" }),
    });
    const waitFor = async (container: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await cmdlines(container)).includes("sleep 600")) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("Claude Code's stand-in process never started");
    };
    const names = claudeNames(REF);
    const leakNames = claudeNames("ci-leak");
    const real = await driver.begin(session(REF));
    real.done.catch(() => undefined);
    const leak = await driver.begin(session("ci-leak"));
    leak.done.catch(() => undefined);
    try {
      await engine.sandbox.open(containerSpec(REF, { task_folder: join(work, "ws_ci", "tsk_ci"), network: [], caps: { spend_micro_usd: 1, run_time_ms: 240_000, turns: 1, output_tokens: 1, max_tokens: 1 } }), halt.signal);
      const task = `podster-run-${REF}`;
      await waitFor(names.container);
      await waitFor(leakNames.container);

      // The process runs with claudeEnv as built: the relay's address and the listener's token, never the key.
      const env = clientEnv.get(names.container) as Record<string, string>;
      expect(env.ANTHROPIC_BASE_URL).toBe("http://relay:8080");
      expect(env.ANTHROPIC_API_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.values(env).some((v) => v.includes(KEY))).toBe(false);
      expect(await environs(names.container)).toContain(`ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`);

      // The key: in no process's environment and no file of any container.
      for (const container of [task, names.container, names.relay]) {
        expect([container, (await environs(container)).includes(KEY)]).toEqual([container, false]);
        expect([container, await filesWithKey(container)]).toEqual([container, ""]);
        const keyPath = await run(["exec", container, "cat", "--", keyFile]);
        expect([container, keyPath.code === 0]).toEqual([container, false]);
      }

      // The scan isn't blind: the planted key is caught in the container's environments and in the exec client's.
      expect(await environs(leakNames.container)).toContain(KEY);
      expect(Object.values(clientEnv.get(leakNames.container) as Record<string, string>).some((v) => v.includes(KEY))).toBe(true);
      const planted = await run(["exec", "--interactive", leakNames.container, "tee", "/tmp/planted"], KEY);
      expect(planted.code).toBe(0);
      expect(await filesWithKey(leakNames.container)).toContain("/tmp/planted");

      // The relay (L4): exactly the run's internal network, exactly the socket mounted, read-only.
      const nets = await run(["inspect", "--format", "{{json .NetworkSettings.Networks}}", names.relay]);
      expect(Object.keys(JSON.parse(nets.stdout) as Record<string, unknown>)).toEqual([names.network]);
      const mounts = JSON.parse((await run(["inspect", "--format", "{{json .Mounts}}", names.relay])).stdout) as { Type: string; Source: string; Destination: string; RW: boolean }[];
      expect(mounts).toEqual([expect.objectContaining({ Type: "bind", Source: join(home, "runs", REF, SOCKET_NAME), Destination: RELAY_SOCKET_IN_CONTAINER, RW: false })]);
      // Claude Code's container: its expected mounts only, and no way out.
      expect(unexpectedMounts((await run(["exec", names.container, "cat", "/proc/mounts"])).stdout)).toEqual([]);
      const out = await run(["exec", names.container, "socat", "-u", "OPEN:/dev/null", "TCP:1.1.1.1:443,connect-timeout=3"], undefined, 30_000);
      expect(out.code).not.toBe(0);

      // Through the run's relay without the token: 401. (With it, the last test shows the request reaching the upstream.)
      expect(answeredUnauthorized(await run(["exec", "--interactive", names.container, "socat", "-t", "10", "-", "TCP:relay:8080"], request(null)))).toBe(true);
    } finally {
      await real.cancel().catch(() => undefined);
      await leak.cancel().catch(() => undefined);
      await engine.sandbox.kill(REF).catch(() => undefined);
      halt.abort();
    }
    expect(await driver.confirmGone(REF)).toBe(true);
    expect(await driver.confirmGone("ci-leak")).toBe(true);

    // Teardown by label: nothing of this home is left, container or network, and the sockets are gone.
    const label = `label=${LABEL_HOME}=${homeLabel(home)}`;
    const left = await run(["ps", "--all", "--quiet", "--filter", label]);
    const netsLeft = await run(["network", "ls", "--quiet", "--filter", label]);
    expect([left.code, left.stdout.trim(), netsLeft.code, netsLeft.stdout.trim()]).toEqual([0, "", 0, ""]);
    await expect(lstat(join(home, "runs", REF, SOCKET_NAME))).rejects.toThrow();
  }, 900_000);

  it("the relay forwards a request with the token to a stand-in upstream, which alone sees the key", async () => {
    const seenKeys: string[] = [];
    const upstream = (async (_url: unknown, init?: RequestInit) => {
      seenKeys.push(String((init?.headers as Record<string, string>)["x-api-key"]));
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "from the stand-in upstream" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const transport = new ProviderKeyTransport(CLAUDE_PROFILE, KEY, { fetch: upstream, env: {}, execArgv: [] });
    const halt = new AbortController();
    const ref = "ci-upstream";
    const runDir = await ensureFolder(home, join(home, "runs", ref));
    const socket = join(runDir, SOCKET_NAME);
    const listener = await startBrokerListener({
      model: async (r) => {
        const answer = await transport.send({ request_id: "ci", url: upstreamUrl(CLAUDE_PROFILE), headers: { ...CLAUDE_PROFILE.headers }, body: r.body, max_tokens: 1, worst_micro_usd: 1 }, halt.signal);
        return { ok: true, status: answer.status, body: answer.body };
      },
      signal: halt.signal,
      host: "relay:8080",
      socket,
    });
    const socketInfo = await lstat(socket);
    expect([socketInfo.isSocket(), socketInfo.mode & 0o777, socketInfo.uid]).toEqual([true, 0o600, uid]);
    const driver = new ClaudeDriver({ home, installed: await installedClaudeVersions(), docker, dockerProgram: program, dockerEnv: {}, claudeImage: ccImage, uid, gid, relay: "unix" });
    try {
      await driver.prepare(ref, { socket }, 300);
      const ok = await run(["exec", "--interactive", claudeNames(ref).container, "socat", "-t", "10", "-", "TCP:relay:8080"], request(listener.token));
      expect(ok.stdout).toMatch(/^HTTP\/1\.1 200 /);
      expect(ok.stdout).toContain("from the stand-in upstream");
      expect(ok.stdout).not.toContain(KEY);
      expect(seenKeys).toEqual([KEY]);
    } finally {
      await driver.teardown(ref).catch(() => undefined);
      halt.abort();
      await listener.close();
    }
    expect(taskImage).toMatch(IMAGE_ID);
  }, 300_000);
});
