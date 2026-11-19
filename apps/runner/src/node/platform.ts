/**
 * Which systems Runner runs tasks on, and how it reaches its listener from there (S-47; the architect's ruling of
 * 2026-11-19: Windows through WSL2, which makes it the Linux path, so plain Linux gets it too; native Windows is out of
 * scope until after M7's gate).
 *
 * - **macOS:** the relay reaches the host's loopback listener over TCP through Docker Desktop's `host.docker.internal`.
 * - **Linux, and WSL2:** the listener is a Unix socket in the run's folder (mode 0600, this user's), bind-mounted into
 *   the relay container, which forwards to it with `socat UNIX-CONNECT`. Turned on only after a positive check on the
 *   host: Docker answers, and a request crosses the relay with the per-run token (`ClaudeDriver.checkRelay`).
 * - **Windows itself:** refused, with a fixed message pointing to WSL2. **Anything else:** refused (`platform_unverified`).
 *
 * WSL is detected only to word a message; nothing is allowed or refused because of it. What is refused there is the
 * Windows file system (`/mnt/<drive>`, or any 9p or drvfs mount), where Linux file modes aren't enforced.
 */
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { onWindowsDrive } from "../core/policy.js";
import type { DockerCli } from "./docker-sandbox.js";

export type RelayMode = "tcp" | "unix";

export const WINDOWS_REFUSAL =
  "platform_unverified: Runner doesn't run on Windows directly. Run it inside a WSL2 Linux distro, with Docker Desktop's WSL integration turned on for that distro (apps/runner/README.md, \"Windows (WSL2)\").";
const OTHER_REFUSAL = "platform_unverified: Runner runs tasks only on macOS and Linux (including Windows through WSL2) until its checks have run on this system.";

/** How the relay reaches Runner's listener on this system, or a refusal. */
export function relayModeFor(platform: NodeJS.Platform): RelayMode {
  if (platform === "darwin") return "tcp";
  if (platform === "linux") return "unix";
  if (platform === "win32") throw new Error(WINDOWS_REFUSAL);
  throw new Error(OTHER_REFUSAL);
}

/** `/proc/version`, or null where there's none. Small and fixed, read once. */
export function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf8").slice(0, 1024);
  } catch {
    return null;
  }
}

/** `/proc/self/mounts`, or null where there's none. */
export function readMounts(): string | null {
  try {
    return readFileSync("/proc/self/mounts", "utf8").slice(0, 1024 * 1024);
  } catch {
    return null;
  }
}

/** Whether this is WSL, for wording messages only. */
export function isWsl(env: NodeJS.ProcessEnv, procVersion: string | null): boolean {
  return (env.WSL_DISTRO_NAME ?? "") !== "" || /microsoft|wsl/i.test(procVersion ?? "");
}

/** The file system type of the mount holding `path`, by the longest mount point at or above it; null if none is listed. */
export function filesystemOf(path: string, mounts: string): string | null {
  let best: { at: string; type: string } | null = null;
  for (const line of mounts.split("\n")) {
    const [, rawAt = "", type = ""] = line.trim().split(/\s+/);
    const at = rawAt.replace(/\\040/g, " ");
    if (!at.startsWith("/")) continue;
    const holds = at === "/" || path === at || path.startsWith(`${at}/`);
    if (holds && (best === null || at.length >= best.at.length)) best = { at, type };
  }
  return best?.type ?? null;
}

/** The Windows file system as WSL mounts it: 9p (WSL2's drvfs) or drvfs. */
const WINDOWS_FS = /^(9p|v9fs|drvfs)$/;

/** Whether `path` is on a mount of the Windows file system, by its mount's type. */
export function onWindowsFilesystem(path: string, mounts: string | null): boolean {
  const type = mounts === null ? null : filesystemOf(path, mounts);
  return type !== null && WINDOWS_FS.test(type);
}

/**
 * `path` with every link resolved (L1 on #471's review): its own real path, or, while it doesn't exist yet, its
 * nearest existing parent's real path with the rest joined on.
 */
export async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(await resolvedPath(parent), basename(path));
  }
}

/**
 * Why Runner's home can't be at `home`, or null: on a Windows drive, by its path or by its mount's file system. Give
 * it the resolved path too (`resolvedPath`), so a link can't hide where it is. Fixed words, never the path.
 */
export function homeRefusal(home: string, mounts: string | null, real: string = home): string | null {
  if (onWindowsDrive(home) || onWindowsDrive(real) || onWindowsFilesystem(home, mounts) || onWindowsFilesystem(real, mounts)) {
    return "Runner's home is on the Windows file system (/mnt/<drive>), where Linux file modes aren't enforced and access is slow. Use a folder in your WSL2 distro's own file system, such as ~/.podster-runner, the default.";
  }
  return null;
}

/**
 * The longest Runner home the Linux relay takes: a run's socket is `<home>/runs/<run ref>/r.sock`, the run ref a UUID
 * (36 characters), and the whole path at most `MAX_SOCKET_PATH_BYTES` (100).
 */
export const MAX_LINUX_HOME_BYTES = 100 - "/runs/".length - 36 - "/r.sock".length;

/** A home too long for the relay's socket: a fixed message naming `--home` and the limit, never the path. */
export function homeLengthRefusal(home: string): string | null {
  if (Buffer.byteLength(home) <= MAX_LINUX_HOME_BYTES) return null;
  return `linux_home_too_long: Runner's home path is too long for the relay's Unix socket on Linux. Pass a shorter --home, such as ~/.podster-runner, the default: it may be at most ${MAX_LINUX_HOME_BYTES} bytes.`;
}

/** Docker answers: `docker version` names its server's version. */
export async function dockerReachable(docker: DockerCli): Promise<boolean> {
  try {
    const r = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000, maxOutputBytes: 4096 });
    return r.code === 0 && !r.cut && /^\d+\.\d+/.test(r.stdout.trim());
  } catch {
    return false;
  }
}

const WSL_HINT = " In WSL2, turn on Docker Desktop's WSL integration for this distro (Settings > Resources > WSL integration), then open a new terminal.";

/** A Linux check that failed, in fixed words, with the WSL2 setting named when this is WSL. */
export function linuxCheckFailure(step: "docker" | "relay", wsl: boolean): Error {
  const what =
    step === "docker"
      ? "Docker isn't reachable from this user. Start Docker, and make sure `docker version` names a server without sudo."
      : "Runner's relay couldn't reach its listener's Unix socket through Docker. Rootless Docker, user-namespace remapping and SELinux without a socket label aren't supported yet.";
  return new Error(`linux_check_failed: ${what}${wsl ? WSL_HINT : ""}`);
}
