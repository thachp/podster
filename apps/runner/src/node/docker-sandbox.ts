/**
 * The task's container, on Docker (M7 step 9(b); the architect's rulings 1 and 4 on spike B; L1, L3 and M4 on #459).
 * Every task command runs here, through Runner's own tools, never in Claude Code.
 *
 * - **Hardened:** the image is pinned by its content digest (an image ID, `sha256:…`, run with `--pull never`); a numeric
 *   non-root UID (the owner's, so the task folder Runner made 0700 stays theirs); `--cap-drop ALL`;
 *   `no-new-privileges`; a read-only root; `/tmp` a bounded tmpfs; PID, memory, swap and CPU limits; a disk bound (a
 *   per-file size limit, a bounded tmpfs and a host-side size check of the task folder after every tool that writes);
 *   `--network none`; no Docker socket, no device and no other mount than the task's folder; a fixed environment; and
 *   labels naming the run and this Runner's home, so a stop or a restart finds it.
 * - **Network:** none. A policy that lists hosts is refused until an egress proxy exists.
 * - **The disk bound for the whole run** (M2 on #460): the folder's size is checked on a timer, every
 *   `LIMITS.watch_ms`, independent of tool calls, so a process left running can't fill the disk between them, and a
 *   breach the timer finds halts the run too (re-review item 5); and after each shell call every process in the
 *   container but its init and its `sleep` is killed, so nothing a command left behind keeps running. A folder with
 *   too many entries counts as over the bound.
 * - **Why no `docker pause` around that kill:** Docker can't `exec` into a paused container, and from the host Runner
 *   can't signal the container's processes one by one (on a Mac they are inside Docker Desktop's VM). So each round
 *   lists `/proc` from inside, leaving out the listing's own process (`/proc/self`), init and the `sleep`, and kills
 *   what it found; it stops once two listings in a row find nothing. A command that keeps forking past
 *   `STRAY_LISTINGS` listings ends the container.
 * - **Its lifetime** is the run-time cap plus a margin: the container's `sleep` ends then, never runs forever (L2).
 * - **Tools from argument arrays, never a shell:** read is `cat -- ./path`; search is `rg` with fixed flags,
 *   `-e PATTERN -- ./path`; write is `mkdir -p -- ./dir` and `tee -- ./path` with the content on standard input; edit
 *   reads, replaces one exact match in Runner, and writes the same way. Only the `shell` tool, when the policy names it,
 *   runs `/bin/sh -c`, which is what that tool is.
 * - **Stop:** `kill` removes every container carrying the run's label (killing a `docker exec` client leaves its process
 *   running, so the container goes). At startup `reapAll` removes every container of this Runner's home, since one
 *   Runner holds the home at a time and anything left is a previous process's.
 *
 * The `docker` program is a seam (`DockerCli`), so tests run no Docker. It gets the allow-listed environment plus its
 * own settings: a throwaway `DOCKER_CONFIG`, and the daemon's address. Logs carry IDs and codes only.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkContainerSpec, CONTAINER_ENV, CONTAINER_WORKDIR, MAX_TOOL_OUTPUT_BYTES, type ContainerSpec, type SandboxEvents, type TaskSandbox, type ToolOutput } from "../core/run-interface.js";
import type { AllowedCall } from "../core/tool-policy.js";
import { childEnv } from "./child-env.js";
import { ensureFolder, folderBytes } from "./safe-fs.js";

export type DockerResult = { code: number; stdout: string; stderr: string; cut: boolean };
/** Runs `docker` with these arguments. Never through a shell. */
export type DockerCli = (args: string[], opts: { input?: string; signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number; env?: Record<string, string> }) => Promise<DockerResult>;

export const LABEL_RUN = "dev.podster.runner.run";
export const LABEL_HOME = "dev.podster.runner.home";
/**
 * Which container of a run a container is: `task` here, `claude`, `relay` and `network` in the driver's. The task
 * sandbox kills and confirms only its own (the eighth real run of #460: both it and the driver removed Claude Code's
 * containers by the run's label at once, and a removal racing another can fail and leave the container listed).
 */
export const LABEL_ROLE = "dev.podster.runner.role";
/** An image pinned by content: Docker's image ID, the digest of its configuration. */
export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9_-]{1,128}$/;

/** **Proposed** figures. */
export const LIMITS = Object.freeze({
  pids: 256,
  memory: "2g",
  cpus: "2",
  tmpfs: "64m",
  file_bytes: 1024 * 1024 * 1024,
  folder_bytes: 4 * 1024 * 1024 * 1024,
  tool_ms: 120_000,
  docker_ms: 60_000,
  read_bytes: 1024 * 1024,
  watch_ms: 2_000,
  folder_entries: 200_000,
});
type Limits = { folder_bytes: number; folder_entries: number };
/**
 * A Docker failure as a fixed code with its step and exit code (`docker_rm_1`, `docker_ps_125`), never Docker's text
 * (the ninth real run of #460).
 */
export const dockerFailure = (step: string, code: number) => new Error(`docker_${step}_${Number.isSafeInteger(code) && code >= 0 ? code : "x"}`);

/** How many times, and how long apart, a removal is checked before it counts as lingering. **Proposed** figures. */
export const REMOVAL_CHECKS = 20;
export const REMOVAL_CHECK_MS = 250;
const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Removes containers by ID, each named once, and confirms them gone. As Docker 28.5.1 behaves (probed 2026-11-18): a
 * container named twice in one `rm` (by its ID and its name) answers exit 1, "removal … is already in progress", for
 * the second, so nothing is ever named twice; `rm --force` of a container already gone answers exit 0 with "No such
 * container"; and an exit 1 whose every error is one of those two is followed by the check, never taken as done by
 * itself. Done means `listLeft` finds nothing, checked up to `REMOVAL_CHECKS` times.
 */
export async function removeContainers(docker: DockerCli, ids: readonly string[], listLeft: () => Promise<string[]>, wait: (ms: number) => Promise<void> = realWait): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length > 0) {
    const r = await docker(["rm", "--force", ...unique], { timeoutMs: LIMITS.docker_ms, maxOutputBytes: 64 * 1024 });
    if (r.code !== 0) {
      const errors = r.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      const benign = (l: string) => /No such container/i.test(l) || /removal of container \S+ is already in progress/i.test(l);
      if (r.code !== 1 || errors.length === 0 || !errors.every(benign)) throw dockerFailure("rm", r.code);
    }
  }
  for (let check = 0; check < REMOVAL_CHECKS; check++) {
    if ((await listLeft()).length === 0) return;
    await wait(REMOVAL_CHECK_MS);
  }
  throw new Error("docker_rm_lingers");
}

/** Runs `fn` every `ms` until the returned stop is called. */
export type Every = (ms: number, fn: () => Promise<void> | void) => () => void;
const realEvery: Every = (ms, fn) => {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void Promise.resolve()
      .then(fn)
      .catch(() => undefined)
      .finally(() => (busy = false));
  }, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** The `rg` flags, fixed: no config file, no links followed, bounded output. */
export const RG_FLAGS = ["--no-config", "--no-follow", "--no-heading", "--line-number", "--color", "never", "--max-count", "100", "--max-columns", "400", "--max-filesize", "1M"] as const;

const containerName = (ref: string) => `podster-run-${ref.toLowerCase()}`;
/** This home's label value: a hash, so no path reaches Docker's labels. */
export const homeLabel = (home: string) => createHash("sha256").update(home).digest("hex").slice(0, 32);

/** `docker run`'s arguments for a spec: the whole hardening list, and nothing from the task. */
export function runArgs(spec: ContainerSpec, opts: { image: string; uid: number; gid: number; home_label: string }): string[] {
  const env = Object.entries(CONTAINER_ENV).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return [
    "run",
    "--detach",
    "--pull",
    "never",
    "--name",
    containerName(spec.run_ref),
    "--label",
    `${LABEL_RUN}=${spec.run_ref}`,
    "--label",
    `${LABEL_HOME}=${opts.home_label}`,
    "--label",
    `${LABEL_ROLE}=task`,
    "--user",
    `${opts.uid}:${opts.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${LIMITS.tmpfs}`,
    "--pids-limit",
    String(LIMITS.pids),
    "--memory",
    LIMITS.memory,
    "--memory-swap",
    LIMITS.memory,
    "--cpus",
    LIMITS.cpus,
    "--ulimit",
    `fsize=${LIMITS.file_bytes}`,
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    "core=0",
    "--network",
    "none",
    "--ipc",
    "none",
    ...env,
    "--mount",
    `type=bind,source=${spec.task_folder},target=${CONTAINER_WORKDIR}`,
    "--workdir",
    CONTAINER_WORKDIR,
    "--init",
    opts.image,
    "sleep",
    String(spec.max_seconds),
  ];
}

/** The program and arguments each tool runs as inside the container: never a shell, except the shell tool itself. */
export function toolArgv(call: AllowedCall): string[] | null {
  switch (call.tool) {
    case "read":
      return ["cat", "--", `./${call.path}`];
    case "search":
      return ["rg", ...RG_FLAGS, "-e", call.pattern, "--", `./${call.path}`];
    case "shell":
      return ["/bin/sh", "-c", call.command];
    default:
      return null;
  }
}

const REFUSED_NETWORK = "network_allowlist_unsupported";

type Opened = { name: string; spec: ContainerSpec; sleep_pid: string | null; unwatch: () => void; events: SandboxEvents | null };

/** The most `/proc` listings one stray-reap may take before it ends the container instead. **Proposed** figure. */
export const STRAY_LISTINGS = 6;

/** The PIDs an `ls -l -- /proc` shows, leaving out the listing's own (the target of `/proc/self`). */
export function procListing(text: string): string[] {
  // Entries only: `ls -l` starts with a "total" line, which is no process.
  const lines = text.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 9);
  const self = new Set(lines.filter((f) => f.length >= 3 && f.at(-3) === "self" && f.at(-2) === "->").map((f) => f.at(-1) as string));
  return lines.map((f) => f.at(-1) ?? "").filter((name) => /^\d+$/.test(name) && !self.has(name));
}

export class DockerSandbox implements TaskSandbox {
  private readonly docker: DockerCli;
  private readonly image: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly homeLabel: string;
  private readonly workspaceRoot: (spec: ContainerSpec) => string;
  private readonly opened = new Map<string, Opened>();
  private readonly every: Every;
  private readonly limits: Limits;

  private readonly wait: (ms: number) => Promise<void>;

  constructor(opts: { docker: DockerCli; image: string; uid: number; gid: number; home: string; workspaceRoot?: (spec: ContainerSpec) => string; every?: Every; limits?: Partial<Limits>; wait?: (ms: number) => Promise<void> }) {
    if (!IMAGE_ID.test(opts.image)) throw new Error("Runner's task image must be pinned by its sha256 image ID");
    if (!Number.isSafeInteger(opts.uid) || !Number.isSafeInteger(opts.gid) || opts.uid <= 0 || opts.gid < 0) throw new Error("Runner won't run a task container as root");
    this.docker = opts.docker;
    this.image = opts.image;
    this.uid = opts.uid;
    this.gid = opts.gid;
    this.homeLabel = homeLabel(opts.home);
    this.workspaceRoot = opts.workspaceRoot ?? ((spec) => dirname(dirname(spec.task_folder)));
    this.every = opts.every ?? realEvery;
    this.wait = opts.wait ?? realWait;
    this.limits = { folder_bytes: opts.limits?.folder_bytes ?? LIMITS.folder_bytes, folder_entries: opts.limits?.folder_entries ?? LIMITS.folder_entries };
  }

  private async overBound(opened: Opened): Promise<boolean> {
    return (await folderBytes(opened.spec.task_folder, this.limits.folder_bytes, this.limits.folder_entries).catch(() => this.limits.folder_bytes + 1)) > this.limits.folder_bytes;
  }

  async open(spec: ContainerSpec, signal: AbortSignal, events?: SandboxEvents): Promise<void> {
    if (!REF.test(spec.run_ref)) throw new Error("run_ref_invalid");
    if (checkContainerSpec(spec) !== null) throw new Error("container_invalid");
    // No allowlist without an egress proxy to hold it (step 9(b)'s ruling): refused, never widened to the internet.
    if (spec.network.kind !== "none") throw new Error(REFUSED_NETWORK);
    // Runner makes the task's folder itself, mode 0700, checking every segment for links (L3).
    await ensureFolder(this.workspaceRoot(spec), spec.task_folder, { makeRoot: true });
    if (signal.aborted) throw new Error("halted");
    const run = await this.docker(runArgs(spec, { image: this.image, uid: this.uid, gid: this.gid, home_label: this.homeLabel }), { signal, timeoutMs: LIMITS.docker_ms, maxOutputBytes: 4096 });
    // Recorded either way, so a kill reaches a container a failed or aborted `docker run` still made.
    const opened: Opened = { name: containerName(spec.run_ref), spec, sleep_pid: null, unwatch: () => undefined, events: events ?? null };
    this.opened.set(spec.run_ref, opened);
    if (run.code !== 0) throw new Error("container_failed");
    // The disk bound, for the whole run, whatever runs in the container (M2).
    opened.unwatch = this.every(LIMITS.watch_ms, async () => {
      if (this.opened.get(spec.run_ref) === opened && (await this.overBound(opened))) await this.breach(opened);
    });
    // The container's own `sleep`, init's only child before any task command runs: kept by every reap after a shell call.
    const children = await this.docker(["exec", opened.name, "cat", "/proc/1/task/1/children"], { signal, timeoutMs: LIMITS.docker_ms, maxOutputBytes: 1024 });
    const pids = children.stdout.trim().split(/\s+/).filter((p) => p !== "");
    if (children.code !== 0 || pids.length !== 1 || !/^\d+$/.test(pids[0])) {
      await this.kill(spec.run_ref).catch(() => undefined);
      throw new Error("container_failed");
    }
    opened.sleep_pid = pids[0];
  }

  /** A bound passed: the container goes, and the run is told, so it halts too. */
  private async breach(opened: Opened) {
    await this.kill(opened.spec.run_ref).catch(() => undefined);
    opened.events?.breach("disk_bound");
  }

  /**
   * Kills every process in the container but init (1) and its `sleep`, after a shell call (M2; re-review item 5). It
   * lists `/proc` and kills what it finds until two listings in a row find nothing; past `STRAY_LISTINGS` listings it
   * throws, and the caller ends the container.
   */
  private async reapStrays(opened: Opened, signal: AbortSignal): Promise<void> {
    const keep = new Set(["1", opened.sleep_pid ?? ""]);
    let empty = 0;
    for (let listing = 0; listing < STRAY_LISTINGS; listing++) {
      const r = await this.docker(["exec", opened.name, "ls", "-l", "--", "/proc"], { signal, timeoutMs: LIMITS.docker_ms, maxOutputBytes: 512 * 1024 });
      if (r.code !== 0) throw dockerFailure("exec_ls", r.code);
      if (r.cut) throw new Error("docker_exec_ls_cut");
      const strays = procListing(r.stdout).filter((p) => !keep.has(p));
      if (strays.length === 0) {
        if (++empty === 2) return;
        continue;
      }
      empty = 0;
      await this.docker(["exec", opened.name, "kill", "-KILL", "--", ...strays], { signal, timeoutMs: LIMITS.docker_ms, maxOutputBytes: 4096 });
    }
    throw new Error("strays_remain");
  }

  async exec(run_ref: string, call: AllowedCall, signal: AbortSignal): Promise<ToolOutput> {
    const opened = this.opened.get(run_ref);
    if (!opened) return { ok: false, text: "The task's container isn't open." };
    const output = await this.runTool(opened, call, signal);
    if (call.tool === "shell") {
      try {
        await this.reapStrays(opened, signal);
      } catch {
        await this.kill(run_ref);
        return { ok: false, text: "Runner stopped the task's container: what the command left running couldn't be ended." };
      }
    }
    if (call.tool === "write" || call.tool === "edit" || call.tool === "shell") {
      // The disk bound: a folder grown past it ends the container, so nothing more is written.
      if (await this.overBound(opened)) {
        await this.breach(opened);
        return { ok: false, text: "Runner stopped the task's container: its folder passed its size bound." };
      }
    }
    return output;
  }

  private async runTool(opened: Opened, call: AllowedCall, signal: AbortSignal): Promise<ToolOutput> {
    const inContainer = (argv: string[], input?: string, max = MAX_TOOL_OUTPUT_BYTES) =>
      this.docker(["exec", ...(input === undefined ? [] : ["--interactive"]), "--workdir", CONTAINER_WORKDIR, opened.name, ...argv], { input, signal, timeoutMs: LIMITS.tool_ms, maxOutputBytes: max });
    const text = (r: DockerResult) => (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim() + (r.cut ? "\n[output cut]" : "");
    switch (call.tool) {
      case "read":
      case "shell": {
        const r = await inContainer(toolArgv(call) as string[]);
        return { ok: r.code === 0, text: text(r) };
      }
      case "search": {
        const r = await inContainer(toolArgv(call) as string[]);
        // rg answers 1 for no match, which isn't a failure.
        if (r.code === 1 && r.stdout === "") return { ok: true, text: "No matches." };
        return { ok: r.code === 0, text: text(r) };
      }
      case "write":
        return this.write(inContainer, call.path, call.content);
      case "edit": {
        const current = await inContainer(["cat", "--", `./${call.path}`], undefined, LIMITS.read_bytes);
        if (current.code !== 0 || current.cut) return { ok: false, text: "The file couldn't be read whole." };
        const at = current.stdout.indexOf(call.old);
        if (call.old === "" || at < 0 || current.stdout.indexOf(call.old, at + 1) >= 0) return { ok: false, text: "The text to replace must appear exactly once." };
        return this.write(inContainer, call.path, current.stdout.slice(0, at) + call.new + current.stdout.slice(at + call.old.length));
      }
      default:
        return { ok: false, text: "Runner refused this call." };
    }
  }

  private async write(inContainer: (argv: string[], input?: string, max?: number) => Promise<DockerResult>, path: string, content: string): Promise<ToolOutput> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parent) {
      const made = await inContainer(["mkdir", "-p", "--", `./${parent}`]);
      if (made.code !== 0) return { ok: false, text: "The folder couldn't be made." };
    }
    // tee echoes what it writes; only its exit code is read.
    const r = await inContainer(["tee", "--", `./${path}`], content, 1024);
    return r.code === 0 ? { ok: true, text: "Written." } : { ok: false, text: "The file couldn't be written." };
  }

  /**
   * Removes the run's task container, by its run and role labels and by its name, whatever this process remembers. A
   * removal that fails is never taken as done: `rm` may answer 1 only because a name it was given is already gone.
   */
  async kill(run_ref: string): Promise<void> {
    if (!REF.test(run_ref)) throw new Error("run_ref_invalid");
    this.opened.get(run_ref)?.unwatch();
    // By labels and by name, resolved to IDs and each named once, then confirmed gone.
    const left = async () => [...new Set([...(await this.list([`label=${LABEL_RUN}=${run_ref}`, `label=${LABEL_ROLE}=task`])), ...(await this.list([`name=^/${containerName(run_ref)}$`]))])];
    await removeContainers(this.docker, await left(), left, this.wait);
  }

  /** Nothing of the run's task container is listed, by its labels or by its name (Docker names carry a leading slash). */
  async gone(run_ref: string): Promise<boolean> {
    if (!REF.test(run_ref)) throw new Error("run_ref_invalid");
    const left = (await this.list([`label=${LABEL_RUN}=${run_ref}`, `label=${LABEL_ROLE}=task`])).length === 0 && (await this.list([`name=^/${containerName(run_ref)}$`])).length === 0;
    if (left) {
      this.opened.get(run_ref)?.unwatch();
      this.opened.delete(run_ref);
    }
    return left;
  }

  /** At startup, before any stop is confirmed (M4 on #459): every container of this home goes. */
  async reapAll(): Promise<number> {
    const ids = await this.list([`label=${LABEL_HOME}=${this.homeLabel}`]);
    if (ids.length === 0) return 0;
    await removeContainers(this.docker, ids, () => this.list([`label=${LABEL_HOME}=${this.homeLabel}`]), this.wait);
    return ids.length;
  }

  private async list(filters: string[]): Promise<string[]> {
    const r = await this.docker(["ps", "--all", "--quiet", "--no-trunc", ...filters.flatMap((f) => ["--filter", f])], { timeoutMs: LIMITS.docker_ms, maxOutputBytes: 64 * 1024 });
    if (r.code !== 0) throw dockerFailure("ps", r.code);
    if (r.cut) throw new Error("docker_ps_cut");
    const ids = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (!ids.every((id) => /^[0-9a-f]{64}$/.test(id))) throw new Error("docker_ps_output");
    return ids;
  }
}

/** Where the `docker` program is, among fixed places; null if none. Nothing is run to find it. */
export function findDocker(exists: (path: string) => boolean = existsSync): string | null {
  for (const path of ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]) if (exists(path)) return path;
  return null;
}

/** The daemon's address: `DOCKER_HOST` if set, else Docker Desktop's socket on a Mac when it exists, else Docker's default. */
export function dockerHost(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists: (path: string) => boolean = existsSync): string | undefined {
  if (env.DOCKER_HOST) return env.DOCKER_HOST;
  const desktop = join(env.HOME ?? homedir(), ".docker", "run", "docker.sock");
  return platform === "darwin" && exists(desktop) ? `unix://${desktop}` : undefined;
}

/** The real `docker`, from an argument array, with the allow-listed environment and bounded output. */
export function dockerCli(program: string, opts: { config_dir: string; host?: string }): DockerCli {
  const env = childEnv({ DOCKER_CONFIG: opts.config_dir, DOCKER_HOST: opts.host, DOCKER_CLI_HINTS: "false" });
  // `extra` carries values a `docker exec --env NAME` hands on by name, so none is ever an argument.
  return (args, { input, signal, timeoutMs, maxOutputBytes, env: extra }) =>
    new Promise((resolve, reject) => {
      // The handed-on values win, except Docker's own settings, which stay Runner's.
      const merged = extra ? { ...env, ...extra, ...Object.fromEntries(Object.entries(env).filter(([n]) => n.startsWith("DOCKER_"))) } : env;
      const child = spawn(program, args, { env: merged, stdio: ["pipe", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let size = 0;
      let cut = false;
      const take = (into: "out" | "err") => (chunk: Buffer) => {
        if (size + chunk.length > maxOutputBytes) {
          cut = true;
          chunk = chunk.subarray(0, Math.max(0, maxOutputBytes - size));
        }
        size += chunk.length;
        if (into === "out") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", take("out"));
      child.stderr.on("data", take("err"));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`docker couldn't start (${(error as NodeJS.ErrnoException).code ?? "error"})`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code: code ?? -1, stdout, stderr, cut });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input ?? "");
    });
}
