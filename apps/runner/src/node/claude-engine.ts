/**
 * The run engine `run` uses (M7 step 9(b)): the Claude Agent SDK's driver, the Docker task container and the provider
 * transport holding the owner's API key. It replaces step 9(a)'s `NO_ENGINE` in `cli.ts` when the owner names a key file.
 *
 * Before anything runs, it refuses unless:
 * - the installed SDK and its bundled Claude Code are exactly the pinned pair (S-48);
 * - the key file is a regular file, not a link, owned by the owner and readable by no one else, holding one key;
 * - Runner's task image is pinned: `task-image` in Runner's home names an image ID (`sha256:…`);
 * - `docker` is installed in a fixed place;
 * - no proxy would be taken from the environment.
 * It runs exactly what was verified (re-review 2 item 2): Claude Code always in bare mode, and on macOS always under
 * the `sandbox-exec` wrapper with its preflight. Any other system is refused (`platform_unverified`) until S-47's
 * Linux run exists.
 * Then it reaps (M4 on #459): every container of this home, and every Claude Code group a previous process left, go
 * before the lifecycle opens and confirms any stop.
 *
 * The key is read once into the transport and never logged, written, put in an error or passed to another program.
 */
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CLAUDE_PROFILE } from "../core/claude-profile.js";
import type { Logger } from "../core/runtime.js";
import { ClaudeDriver } from "./claude-driver.js";
import { DockerSandbox, dockerCli, dockerHost, findDocker, IMAGE_ID, type DockerCli } from "./docker-sandbox.js";
import { ProviderKeyTransport } from "./provider-transport.js";
import type { RunEngine } from "./run-command.js";
import { ensureFolder, readNoFollow } from "./safe-fs.js";

/** The installed SDK's version and its bundled Claude Code's, from its own manifest. */
export async function installedClaudeVersions(): Promise<{ sdk: unknown; claude_code: unknown }> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8")) as { name?: unknown; version?: unknown; claudeCodeVersion?: unknown };
  if (manifest.name !== "@anthropic-ai/claude-agent-sdk") return { sdk: null, claude_code: null };
  return { sdk: manifest.version, claude_code: manifest.claudeCodeVersion };
}

/**
 * The owner's provider key, from a file only they can read. The file is opened first, never through a link, and its
 * owner, mode and size are checked on the open handle, so nothing can swap the file between check and read (L5 on #460).
 */
export async function readKeyFile(path: string, opts: { uid?: number } = {}): Promise<string> {
  const refuse = () => new Error("The provider key file must be a regular file you own, readable only by you (mode 600), holding one key.");
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw refuse();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 1024) throw refuse();
    const key = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(key)) throw refuse();
    return key;
  } finally {
    await handle.close();
  }
}

/** Runner's pinned task image, from `task-image` in its home. */
export async function taskImage(home: string): Promise<string> {
  const text = (await readNoFollow(join(home, "task-image"), 256))?.trim();
  if (!text || !IMAGE_ID.test(text)) throw new Error("Runner's task image isn't pinned. Build apps/runner/sandbox and write its image ID (sha256:…) to task-image in Runner's home.");
  return text;
}

export type ClaudeEngine = RunEngine & { reap(): Promise<void> };

export async function claudeEngine(opts: { home: string; key_file: string; log: Logger; docker?: DockerCli; env?: NodeJS.ProcessEnv; execArgv?: readonly string[]; platform?: NodeJS.Platform }): Promise<ClaudeEngine> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("platform_unverified: Runner runs tasks only on macOS, under its sandbox, until its checks have run on this system.");
  const driver = new ClaudeDriver({ home: opts.home, installed: await installedClaudeVersions(), log: opts.log, bare: true, macSandbox: true, platform });
  const key = await readKeyFile(opts.key_file);
  const transport = new ProviderKeyTransport(CLAUDE_PROFILE, key, { env: opts.env, execArgv: opts.execArgv });
  const image = await taskImage(opts.home);
  let docker = opts.docker;
  if (!docker) {
    const program = findDocker();
    if (!program) throw new Error("Runner needs Docker for the task's container, and found none.");
    const config = await ensureFolder(opts.home, join(opts.home, "docker-config"));
    docker = dockerCli(program, { config_dir: config, host: dockerHost() });
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const sandbox = new DockerSandbox({ docker, image, uid, gid, home: opts.home });
  return {
    drivers: { claude_agent_sdk: driver },
    sandbox,
    transports: { [CLAUDE_PROFILE.provider]: transport },
    async reap() {
      const containers = await sandbox.reapAll();
      await driver.reapAll();
      opts.log("adapter.reap", "done", { count: containers });
    },
  };
}
