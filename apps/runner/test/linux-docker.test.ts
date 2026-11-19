// S-47's Linux proof on a real Docker Engine: CI's `runner` job runs it on GitHub's Ubuntu runner, through
// vitest.linux.config.ts, with RUNNER_LINUX_DOCKER=1. It never runs in the default config, on a Mac, or without that
// variable. It builds Runner's two images, starts the run's containers with the Unix-socket relay, and proves:
// - the engine's own Linux checks pass (Docker answers; a request crosses the relay with the per-run token);
// - the provider key can't be read from the task container, Claude Code's container or the relay;
// - the relay carries a request with the token, and the listener refuses one without it;
// - teardown leaves no container or network of the home.
// No provider is called: the key is a fake, and the upstream is a stand-in function on the host, given to the
// transport as its `fetch`. Claude Code itself isn't started; the SDK and the model are the real runs' (claude-real).
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upstreamUrl } from "../src/core/broker.js";
import { CLAUDE_PROFILE } from "../src/core/claude-profile.js";
import { containerSpec } from "../src/core/run-interface.js";
import { startBrokerListener } from "../src/node/broker-listener.js";
import { ClaudeDriver, claudeNames } from "../src/node/claude-driver.js";
import { claudeEngine, installedClaudeVersions } from "../src/node/claude-engine.js";
import { dockerCli, dockerHost, DockerSandbox, findDocker, homeLabel, IMAGE_ID, LABEL_HOME, type DockerCli } from "../src/node/docker-sandbox.js";
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
  const run = (args: string[], input?: string, timeoutMs = 120_000) => docker(args, { input, timeoutMs, maxOutputBytes: 256 * 1024 });

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

  it("the engine's own Linux checks pass on this host, and reap leaves nothing", async () => {
    const lines: string[] = [];
    const engine = await claudeEngine({ home, key_file: keyFile, log: (event, outcome) => void lines.push(`${event} ${outcome}`), platform: "linux" });
    await engine.reap();
    expect(lines).toContain("adapter.reap done");
  }, 300_000);

  it("keeps the key out of every container, refuses without the token, and tears down to nothing", async () => {
    const seenKeys: string[] = [];
    // The stand-in upstream on the host: it sees the key, as the provider would, and answers with no key in its body.
    const upstream = (async (_url: unknown, init?: RequestInit) => {
      seenKeys.push(String((init?.headers as Record<string, string>)["x-api-key"]));
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "from the stand-in upstream" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const transport = new ProviderKeyTransport(CLAUDE_PROFILE, KEY, { fetch: upstream, env: {}, execArgv: [] });
    const halt = new AbortController();
    const runDir = await ensureFolder(home, join(home, "runs", REF));
    const socket = join(runDir, "r.sock");
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
    const sandbox = new DockerSandbox({ docker, image: taskImage, uid, gid, home });
    const names = claudeNames(REF);
    try {
      await driver.prepare(REF, { socket }, 300);
      await sandbox.open(containerSpec(REF, { task_folder: join(work, "ws_ci", "tsk_ci"), network: [], caps: { spend_micro_usd: 1, run_time_ms: 240_000, turns: 1, output_tokens: 1, max_tokens: 1 } }), halt.signal);
      const task = `podster-run-${REF}`;

      // Through the relay, as Claude Code sends: with the token it reaches the stand-in upstream, with the owner's key
      // added on the host only; without it, the listener refuses.
      const through = (token: string | null) => run(["exec", "--interactive", names.container, "socat", "-t", "10", "-", "TCP:relay:8080"], request(token));
      const ok = await through(listener.token);
      expect(ok.stdout).toMatch(/^HTTP\/1\.1 200 /);
      expect(ok.stdout).toContain("from the stand-in upstream");
      expect(ok.stdout).not.toContain(KEY);
      expect(seenKeys).toEqual([KEY]);
      const refused = await through(null);
      expect(answeredUnauthorized(refused)).toBe(true);
      expect(seenKeys).toHaveLength(1);

      // Claude Code's container: exactly its expected mounts, none from the host.
      const mounts = await run(["exec", names.container, "cat", "/proc/mounts"]);
      expect(unexpectedMounts(mounts.stdout)).toEqual([]);

      // The key, in no container: not in any process's environment, at no path, and in no file. The key goes in on
      // grep's standard input, never as an argument or a file.
      for (const container of [task, names.container, names.relay]) {
        for (const pid of ["1", "self"]) {
          const environ = await run(["exec", container, "cat", `/proc/${pid}/environ`]);
          expect([container, pid, environ.code, environ.stdout.includes(KEY)]).toEqual([container, pid, 0, false]);
        }
        const keyPath = await run(["exec", container, "cat", "--", keyFile]);
        expect([container, keyPath.code === 0]).toEqual([container, false]);
        const found = await run(["exec", "--interactive", container, "grep", "-rlsF", "--exclude-dir=proc", "--exclude-dir=sys", "--exclude-dir=dev", "-f", "/dev/stdin", "/"], `${KEY}\n`, 300_000);
        expect([container, found.code === 0, found.stdout.trim(), found.cut]).toEqual([container, false, "", false]);
      }
    } finally {
      await sandbox.kill(REF).catch(() => undefined);
      await driver.teardown(REF).catch(() => undefined);
      halt.abort();
      await listener.close();
    }

    // Teardown by label: nothing of this home is left, container or network, and the socket is gone.
    const label = `label=${LABEL_HOME}=${homeLabel(home)}`;
    const left = await run(["ps", "--all", "--quiet", "--filter", label]);
    const nets = await run(["network", "ls", "--quiet", "--filter", label]);
    expect([left.code, left.stdout.trim(), nets.code, nets.stdout.trim()]).toEqual([0, "", 0, ""]);
    await expect(lstat(socket)).rejects.toThrow();
  }, 900_000);
});
