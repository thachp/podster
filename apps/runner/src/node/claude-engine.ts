/**
 * The run engine `run` uses (M7 step 9(b)): the Claude Agent SDK's driver, the Docker task container and the provider
 * transport holding the owner's API key. It replaces step 9(a)'s `NO_ENGINE` in `cli.ts` when the owner names a key file.
 *
 * Before anything runs, it refuses unless:
 * - the installed SDK and its bundled Claude Code are exactly the pinned pair (S-48);
 * - the key file is a regular file, not a link, owned by the owner and readable by no one else, holding one key;
 * - Runner's three images are pinned: `task-image`, `claude-image` and `proxy-image` in Runner's home each name an image
 *   ID (`sha256:…`), built from `apps/runner/sandbox`, `apps/runner/claude-image` and `apps/runner/proxy-image` (the
 *   egress proxy's, for rooms that list hosts). A pin that's missing, or names an
 *   image Docker no longer has, is built from the Dockerfile in Runner's own package and pinned (`ensureImage`, the
 *   ruling on #470); a build that fails stops `run` before anything runs;
 * - `docker` is installed in a fixed place;
 * - no proxy or TLS trust would be taken from the environment.
 * It runs what was ruled after #460's real runs: Claude Code in default mode, never bare (bare mode turns off the SDK's
 * PreToolUse callback, Runner's decision point), in its own container (the two-container placement). The macOS `sandbox-exec` wrapper is gone.
 * **Which systems** (`platform.ts`; S-47 and the architect's ruling of 2026-11-19): macOS relays over TCP to the
 * loopback listener, as before. Linux, which is also Windows through WSL2, relays to a Unix-socket listener in the
 * run's folder, and is turned on only when its own checks pass on this host: Runner's home isn't on the Windows file
 * system, Docker answers, and a request crosses the relay with the per-run token (`ClaudeDriver.checkRelay`). Windows
 * itself is refused with a fixed message pointing to WSL2, and every other system with `platform_unverified`.
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
import { ClaudeDriver, type ClaudeDriverDeps } from "./claude-driver.js";
import { DockerSandbox, dockerCli, dockerHost, findDocker, IMAGE_ID, type DockerCli } from "./docker-sandbox.js";
import { dockerReachable, homeLengthRefusal, homeRefusal, isWsl, linuxCheckFailure, readMounts, readProcVersion, relayModeFor, resolvedPath } from "./platform.js";
import { loadProxyProgram } from "./egress-network.js";
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

/** Runner's pinned egress proxy image, from `proxy-image` in its home. */
export async function proxyImage(home: string): Promise<string> {
  const text = (await readNoFollow(join(home, "proxy-image"), 256))?.trim();
  if (!text || !IMAGE_ID.test(text)) throw new Error("Runner's egress proxy image isn't pinned. Build apps/runner/proxy-image and write its image ID (sha256:…) to proxy-image in Runner's home.");
  return text;
}

export type ImageName = "task-image" | "claude-image" | "proxy-image";
const PINNED: Record<ImageName, (home: string) => Promise<string>> = { "task-image": taskImage, "claude-image": claudeImage, "proxy-image": proxyImage };

/** Each image's build folder, in Runner's own package: its Dockerfile, which copies nothing from the folder. */
export const IMAGE_SOURCES: Record<ImageName, string> = {
  "task-image": fileURLToPath(new URL("../../sandbox", import.meta.url)),
  "claude-image": fileURLToPath(new URL("../../claude-image", import.meta.url)),
  "proxy-image": fileURLToPath(new URL("../../proxy-image", import.meta.url)),
};

/** The fixed line said before a build. */
export const BUILDING: Record<ImageName, string> = {
  "task-image": "Building Runner's task image from its packaged Dockerfile. This happens once and takes a few minutes.",
  "claude-image": "Building Runner's Claude Code image from its packaged Dockerfile. This happens once and takes a few minutes.",
  "proxy-image": "Building Runner's egress proxy image from its packaged Dockerfile. This happens once and takes a few minutes.",
};

/** The fixed message a failed build stops `run` with. Docker's own output never reaches it. */
export const BUILD_FAILED: Record<ImageName, string> = {
  "task-image": "Runner couldn't build its task image, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
  "claude-image": "Runner couldn't build its Claude Code image, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
  "proxy-image": "Runner couldn't build its egress proxy image, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
};

/** The fixed message when Docker can't say whether a pinned image exists. Nothing is built or re-pinned. */
export const INSPECT_FAILED: Record<ImageName, string> = {
  "task-image": "Runner couldn't check its task image with Docker, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
  "claude-image": "Runner couldn't check its Claude Code image with Docker, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
  "proxy-image": "Runner couldn't check its egress proxy image with Docker, so nothing ran. Check that Docker Desktop is running, then start `run` again.",
};

/** Docker's own answer for an image it doesn't have, from `docker image inspect`. */
const NO_SUCH_IMAGE = /^(Error: |Error response from daemon: )?No such image: /m;

const JSON_NO_SUCH_IMAGE_PREFIX = "Error response from daemon: ";

/**
 * Docker 28.5.1 answers a missing image as `Error response from daemon: {"message":"No such image: <id>"}`. Accepted
 * only as one JSON object whose single key is `message` and whose value is "No such image: " plus the pinned ID or its
 * short form; anything else is not Docker's answer for this image.
 */
function isJsonNoSuchImage(stderr: string, pinnedId: string): boolean {
  const text = stderr.trim();
  if (!text.startsWith(JSON_NO_SUCH_IMAGE_PREFIX)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(JSON_NO_SUCH_IMAGE_PREFIX.length));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "message") return false;
  const message = (parsed as { message: unknown }).message;
  const hex = pinnedId.replace(/^sha256:/, "");
  return typeof message === "string" && [pinnedId, hex, hex.slice(0, 12)].some((id) => message === `No such image: ${id}`);
}

/** A build's bound: Claude Code's image fetches its packages, so it can take minutes. */
const BUILD_TIMEOUT_MS = 30 * 60_000;

/**
 * The image `name` pins, built when missing (the ruling on #470). A pin naming an image Docker has is used as it is. A
 * missing pin, or one naming an image Docker says it doesn't have ("No such image"), is built from the package's own Dockerfile with
 * `docker build --quiet --pull=false <folder>`, the form the real runs used, through `docker`'s structured arguments and
 * allow-listed environment, then pinned by the ID the build printed. A pin that isn't an image ID, or is a link, is
 * refused, not replaced.
 */
export async function ensureImage(name: ImageName, opts: { home: string; docker: DockerCli; notify: (line: string) => void }): Promise<string> {
  const path = join(opts.home, name);
  const pinned = (await readNoFollow(path, 256))?.trim();
  if (pinned) {
    const pinnedId = await PINNED[name](opts.home);
    const present = await opts.docker(["image", "inspect", "--format", "{{.Id}}", pinnedId], { timeoutMs: 60_000, maxOutputBytes: 4096 });
    if (present.code === 0) return pinnedId;
    // Rebuilt only when Docker says it hasn't the image (security review L4 on #470). Any other failure stops.
    if (present.code !== 1 || present.cut || !(NO_SUCH_IMAGE.test(present.stderr) || isJsonNoSuchImage(present.stderr, pinnedId))) throw new Error(INSPECT_FAILED[name]);
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

export async function claudeEngine(opts: {
  home: string;
  key_file: string;
  log: Logger;
  notify?: (line: string) => void;
  docker?: DockerCli;
  dockerProgram?: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  platform?: NodeJS.Platform;
  wait?: (ms: number) => Promise<void>;
  /** `/proc/self/mounts` and `/proc/version`, for tests; read from the system when left out, on Linux only. */
  mounts?: string | null;
  procVersion?: string | null;
  /**
   * For CI's real Linux proof only (`test/linux-docker.test.ts`): a stand-in SDK and process control, so the driver's
   * own wiring starts a process in Claude Code's container with no model call. `cli.ts` never passes it.
   */
  driverSeams?: Pick<ClaudeDriverDeps, "sdk" | "processes">;
}): Promise<ClaudeEngine> {
  // macOS and Linux (with WSL2) only (L3 of the review at 1335df4a; S-47); Windows itself points to WSL2.
  const platform = opts.platform ?? process.platform;
  const relay = relayModeFor(platform);
  const env = opts.env ?? process.env;
  const mounts = relay === "unix" ? (opts.mounts !== undefined ? opts.mounts : readMounts()) : null;
  if (relay === "unix") {
    // By its path and its real path, so a link can't hide a home on the Windows file system (L1 on #471's review).
    const refused = homeRefusal(opts.home, mounts, await resolvedPath(opts.home)) ?? homeLengthRefusal(opts.home);
    if (refused) throw new Error(refused);
  }
  const key = await readKeyFile(opts.key_file);
  const transport = new ProviderKeyTransport(CLAUDE_PROFILE, key, { env: opts.env, execArgv: opts.execArgv });
  const program = opts.dockerProgram ?? findDocker();
  if (!program) throw new Error("Runner needs Docker for the task's and Claude Code's containers, and found none.");
  const config = join(opts.home, "docker-config");
  const host = dockerHost(env, platform);
  let docker = opts.docker;
  if (!docker) docker = dockerCli(program, { config_dir: await ensureFolder(opts.home, config), host });
  // On Linux, Docker must answer before anything is inspected or built (S-47), so an unreachable Docker is said as that.
  const wsl = relay === "unix" ? isWsl(env, opts.procVersion !== undefined ? opts.procVersion : readProcVersion()) : false;
  if (relay === "unix" && !(await dockerReachable(docker))) throw linuxCheckFailure("docker", wsl);
  // Each image as pinned, or built from the package's own Dockerfile and pinned (the ruling on #470).
  const notify = opts.notify ?? (() => undefined);
  const image = await ensureImage("task-image", { home: opts.home, docker, notify });
  const ccImage = await ensureImage("claude-image", { home: opts.home, docker, notify });
  // The egress proxy's, for rooms whose run policy lists hosts; its program is Runner's own built file, read when needed.
  const pxImage = await ensureImage("proxy-image", { home: opts.home, docker, notify });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  // Never bare: under bare mode the SDK's PreToolUse callback, Runner's decision point, never fires (the fifth real run
  // of #460), and the container now does what bare mode was for.
  const driver = new ClaudeDriver({ home: opts.home, installed: await installedClaudeVersions(), log: opts.log, bare: false, docker, dockerProgram: program, dockerEnv: { DOCKER_CONFIG: config, DOCKER_HOST: host }, claudeImage: ccImage, uid, gid, wait: opts.wait, relay, ...opts.driverSeams });
  if (relay === "unix") {
    // Linux is turned on only by a positive check on this host (S-47): Docker answered above; now the relay must carry a
    // request. This needs Claude Code's image, so it comes after the images are pinned.
    try {
      await driver.checkRelay();
    } catch {
      throw linuxCheckFailure("relay", wsl);
    }
    opts.log("adapter.platform", "linux_checked", {});
  }
  const sandbox = new DockerSandbox({ docker, image, uid, gid, home: opts.home, wait: opts.wait, log: opts.log, proxy: { image: pxImage, program: () => loadProxyProgram() }, ...(relay === "unix" ? { mounts: () => (opts.mounts !== undefined ? opts.mounts : readMounts()) } : {}) });
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
