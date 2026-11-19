/**
 * The run engine `run` uses (M7 step 9(b)): the Claude Agent SDK's driver, the Docker task container and the provider
 * transport holding the owner's API key. It replaces step 9(a)'s `NO_ENGINE` in `cli.ts` when the owner names a key file.
 *
 * Before anything runs, it refuses unless:
 * - the installed SDK and its bundled Claude Code are exactly the pinned pair (S-48);
 * - the key file is a regular file, not a link, owned by the owner and readable by no one else, holding one key;
 * - Runner's two images are pinned: `task-image` and `claude-image` in Runner's home each name an image ID
 *   (`sha256:…`), built from `apps/runner/sandbox` and `apps/runner/claude-image`. A pin that's missing, or names an
 *   image Docker no longer has, is built from the Dockerfile in Runner's own package and pinned (`ensureImage`, the
 *   ruling on #470); a build that fails stops `run` before anything runs;
 * - `docker` is installed in a fixed place;
 * - no proxy or TLS trust would be taken from the environment.
 * It runs what was ruled after #460's real runs: Claude Code in default mode, never bare (bare mode turns off the SDK's
 * PreToolUse callback, Runner's decision point), in its own container (the two-container placement). The macOS `sandbox-exec` wrapper is gone. On every system but macOS it refuses
 * (`platform_unverified`); on Linux until S-47's Linux run: the relay reaches the host through `host-gateway`, which the listener, bound to 127.0.0.1
 * (scoped exception 1, not loosened), doesn't serve there. The owed Linux path is a Unix-socket listener.
 * Then it reaps (M4 on #459): every container and network of this home a previous process left goes before the
 * lifecycle opens and confirms any stop.
 *
 * The key is read once into the transport and never logged, written, put in an error or passed to another program.
 */
import { constants } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_PROFILE } from "../core/claude-profile.js";
import type { Logger } from "../core/runtime.js";
import { ClaudeDriver } from "./claude-driver.js";
import { DockerSandbox, dockerCli, dockerHost, findDocker, IMAGE_ID, type DockerCli } from "./docker-sandbox.js";
import { ProviderKeyTransport } from "./provider-transport.js";
import type { RunEngine } from "./run-command.js";
import { ensureFolder, readNoFollow, writeNew } from "./safe-fs.js";

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

/** Runner's pinned Claude Code image, from `claude-image` in its home. */
export async function claudeImage(home: string): Promise<string> {
  const text = (await readNoFollow(join(home, "claude-image"), 256))?.trim();
  if (!text || !IMAGE_ID.test(text)) throw new Error("Runner's Claude Code image isn't pinned. Build apps/runner/claude-image and write its image ID (sha256:…) to claude-image in Runner's home.");
  return text;
}

export type ImageName = "task-image" | "claude-image";

/** Each image's build folder, in Runner's own package: its Dockerfile, which copies nothing from the folder. */
export const IMAGE_SOURCES: Record<ImageName, string> = {
  "task-image": fileURLToPath(new URL("../../sandbox", import.meta.url)),
  "claude-image": fileURLToPath(new URL("../../claude-image", import.meta.url)),
};

/** The fixed line said before a build. */
export const BUILDING: Record<ImageName, string> = {
  "task-image": "Building Runner's task image from its packaged Dockerfile. This happens once and takes a few minutes.",
  "claude-image": "Building Runner's Claude Code image from its packaged Dockerfile. This happens once and takes a few minutes.",
};

/** The fixed message a failed build stops `run` with. Docker's own output never reaches it. */
export const BUILD_FAILED: Record<ImageName, string> = {
  "task-image": "Runner couldn't build its task image, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
  "claude-image": "Runner couldn't build its Claude Code image, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
};

/** A build's bound: Claude Code's image fetches its packages, so it can take minutes. */
const BUILD_TIMEOUT_MS = 30 * 60_000;

/**
 * The image `name` pins, built when missing (the ruling on #470). A pin naming an image Docker has is used as it is. A
 * missing pin, or one naming an image Docker no longer has, is built from the package's own Dockerfile with
 * `docker build --quiet --pull=false <folder>`, the form the real runs used, through `docker`'s structured arguments and
 * allow-listed environment, then pinned by the ID the build printed. A pin that isn't an image ID, or is a link, is
 * refused, not replaced.
 */
export async function ensureImage(name: ImageName, opts: { home: string; docker: DockerCli; notify: (line: string) => void }): Promise<string> {
  const path = join(opts.home, name);
  const pinned = (await readNoFollow(path, 256))?.trim();
  if (pinned) {
    const pinnedId = name === "task-image" ? await taskImage(opts.home) : await claudeImage(opts.home);
    const present = await opts.docker(["image", "inspect", "--format", "{{.Id}}", pinnedId], { timeoutMs: 60_000, maxOutputBytes: 4096 });
    if (present.code === 0) return pinnedId;
  }
  opts.notify(BUILDING[name]);
  const built = await opts.docker(["build", "--quiet", "--pull=false", IMAGE_SOURCES[name]], { timeoutMs: BUILD_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
  const id = built.stdout.trim();
  if (built.code !== 0 || built.cut || !IMAGE_ID.test(id)) throw new Error(BUILD_FAILED[name]);
  await rm(path, { force: true });
  await writeNew(path, `${id}\n`);
  return id;
}

export type ClaudeEngine = RunEngine & { reap(): Promise<void> };

export async function claudeEngine(opts: { home: string; key_file: string; log: Logger; notify?: (line: string) => void; docker?: DockerCli; dockerProgram?: string; env?: NodeJS.ProcessEnv; execArgv?: readonly string[]; platform?: NodeJS.Platform; wait?: (ms: number) => Promise<void> }): Promise<ClaudeEngine> {
  // Only macOS is verified (L3 of the review at 1335df4a); Linux waits on S-47's run, and every other system is refused.
  if ((opts.platform ?? process.platform) !== "darwin") throw new Error("platform_unverified: Runner runs tasks only on macOS until its checks have run on this system (Linux: S-47).");
  const key = await readKeyFile(opts.key_file);
  const transport = new ProviderKeyTransport(CLAUDE_PROFILE, key, { env: opts.env, execArgv: opts.execArgv });
  const program = opts.dockerProgram ?? findDocker();
  if (!program) throw new Error("Runner needs Docker for the task's and Claude Code's containers, and found none.");
  const config = join(opts.home, "docker-config");
  const host = dockerHost(opts.env ?? process.env, opts.platform ?? process.platform);
  let docker = opts.docker;
  if (!docker) docker = dockerCli(program, { config_dir: await ensureFolder(opts.home, config), host });
  // Each image as pinned, or built from the package's own Dockerfile and pinned (the ruling on #470).
  const notify = opts.notify ?? (() => undefined);
  const image = await ensureImage("task-image", { home: opts.home, docker, notify });
  const ccImage = await ensureImage("claude-image", { home: opts.home, docker, notify });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  // Never bare: under bare mode the SDK's PreToolUse callback, Runner's decision point, never fires (the fifth real run
  // of #460), and the container now does what bare mode was for.
  const driver = new ClaudeDriver({ home: opts.home, installed: await installedClaudeVersions(), log: opts.log, bare: false, docker, dockerProgram: program, dockerEnv: { DOCKER_CONFIG: config, DOCKER_HOST: host }, claudeImage: ccImage, uid, gid, wait: opts.wait });
  const sandbox = new DockerSandbox({ docker, image, uid, gid, home: opts.home, wait: opts.wait });
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
