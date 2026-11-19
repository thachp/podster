// S-47: Runner's Linux path, which is also Windows through WSL2 (the architect's ruling of 2026-11-19). Everything here
// runs against stand-ins: a fake `docker` (which reaches the listener's real Unix socket with node:net, as the relay
// would), a fake `secret-tool`, and temporary folders. No Docker runs, no D-Bus or keyring is touched, nothing reaches a
// provider. The real Linux Docker proof is test/linux-docker.test.ts, which only CI's Linux job runs.
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED_CLAUDE_CODE_VERSION, PINNED_SDK_VERSION } from "../src/core/claude-profile.js";
import { onWindowsDrive, parsePolicyConfig } from "../src/core/policy.js";
import { containerSpec } from "../src/core/run-interface.js";
import { MemorySecretStore, RunnerStorage } from "../src/core/storage.js";
import { startBrokerListener } from "../src/node/broker-listener.js";
import { ClaudeDriver, claudeNames, RELAY_SOCKET_IN_CONTAINER, relayRunArgs } from "../src/node/claude-driver.js";
import { DockerSandbox, type DockerCli } from "../src/node/docker-sandbox.js";
import { chooseKeyStore, FileSecretStore, KEY_STORE_LINES, MAX_ITEM_BYTES } from "../src/node/key-store.js";
import type { Runner } from "../src/node/keychain.js";
import { filesystemOf, isWsl, relayModeFor, WINDOWS_REFUSAL } from "../src/node/platform.js";
import { writeFileAtomic } from "../src/node/safe-fs.js";

const enc = new TextEncoder();
const KEY = "sk-ant-test-0123456789abcdefghij-the-owners-key";
const IMAGE = `sha256:${"a".repeat(64)}`;
const CLAUDE_IMAGE = `sha256:${"c".repeat(64)}`;
const DOCKER_PROGRAM = "/usr/bin/docker";

const temps: string[] = [];
async function temp(prefix = "rl-") {
  // Short, so a Unix socket's path fits: /tmp on a Mac, whose own temporary folder is long.
  const dir = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix));
  await chmod(dir, 0o700);
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Sends raw bytes to a Unix socket and answers what came back: the relay's `socat UNIX-CONNECT`, from the host. */
function overSocket(path: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.end(raw);
  });
}

const httpRequest = (token: string | null, host = "relay:8080") =>
  `POST /v1/messages HTTP/1.1\r\nHost: ${host}\r\n${token === null ? "" : `x-api-key: ${token}\r\n`}content-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`;

/**
 * A fake `docker` for the Linux placement: it records containers and networks by label, answers `version`, and serves an
 * `exec … socat - TCP:relay:8080` by sending its standard input to the Unix socket the relay was started with, as the
 * relay's socat would.
 */
function fakeLinuxDocker(opts: { version?: { code: number; stdout: string }; relayBroken?: boolean; answerWithoutNonce?: boolean } = {}) {
  const containers = new Map<string, string[]>();
  const networks = new Map<string, string[]>();
  const calls: string[][] = [];
  let socket: string | null = null;
  const labelsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === "--label");
  const matches = (labels: string[], filters: string[]) => filters.every((f) => (f.includes("=", f.indexOf("=") + 1) ? labels.includes(f.slice(f.indexOf("=") + 1)) : labels.some((l) => l.startsWith(`${f.slice(f.indexOf("=") + 1)}=`))));
  const docker: DockerCli = async (args, { input }) => {
    calls.push(args);
    const filters = args.filter((_, i) => args[i - 1] === "--filter");
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", cut: false });
    if (args[0] === "version") return { ...ok(), ...(opts.version ?? { code: 0, stdout: "28.5.1\n" }) };
    if (args[0] === "network" && args[1] === "create") networks.set(args.at(-1) as string, labelsOf(args));
    else if (args[0] === "network" && args[1] === "rm") for (const n of args.slice(3)) networks.delete(n);
    else if (args[0] === "network" && args[1] === "ls") return ok([...networks].filter(([, l]) => matches(l, filters)).map(([n]) => n).join("\n"));
    else if (args[0] === "run") {
      containers.set(args[args.indexOf("--name") + 1], labelsOf(args));
      const mount = args.filter((_, i) => args[i - 1] === "--mount").find((m) => m.includes(`target=${RELAY_SOCKET_IN_CONTAINER}`));
      if (mount) socket = /source=([^,]+)/.exec(mount)?.[1] ?? null;
    } else if (args[0] === "rm") for (const c of args.slice(2)) containers.delete(c);
    else if (args[0] === "ps") return ok([...containers].filter(([, l]) => matches(l, filters)).map(([n]) => n).join("\n"));
    else if (args[0] === "exec" && args.includes("socat")) {
      if (opts.relayBroken || socket === null) return { code: 1, stdout: "", stderr: "socat E connect(): Connection refused", cut: false };
      // Something answering 200 that isn't Runner's listener: never taken as the relay working.
      if (opts.answerWithoutNonce) return ok('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"type":"message"}');
      return ok(await overSocket(socket, input ?? ""));
    }
    return ok();
  };
  return { docker, calls, containers, networks };
}

function driver(home: string, docker: DockerCli, extra: Partial<ConstructorParameters<typeof ClaudeDriver>[0]> = {}) {
  return new ClaudeDriver({ home, installed: { sdk: PINNED_SDK_VERSION, claude_code: PINNED_CLAUDE_CODE_VERSION }, docker, dockerProgram: DOCKER_PROGRAM, dockerEnv: {}, claudeImage: CLAUDE_IMAGE, uid: 1000, gid: 1000, relay: "unix", ...extra });
}

describe("which systems run tasks (S-47)", () => {
  it("relays over TCP on macOS, over a Unix socket on Linux, and refuses Windows itself, pointing to WSL2", () => {
    expect(relayModeFor("darwin")).toBe("tcp");
    expect(relayModeFor("linux")).toBe("unix");
    expect(() => relayModeFor("win32")).toThrow(WINDOWS_REFUSAL);
    expect(WINDOWS_REFUSAL).toMatch(/^platform_unverified: /);
    expect(WINDOWS_REFUSAL).toMatch(/WSL2/);
    for (const platform of ["freebsd", "openbsd", "aix", "sunos"] as const) expect(() => relayModeFor(platform)).toThrow(/^platform_unverified: /);
  });

  it("detects WSL from WSL_DISTRO_NAME or /proc/version, for messages only", () => {
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, null)).toBe(true);
    expect(isWsl({}, "Linux version 5.15.167.4-microsoft-standard-WSL2 (root@host) (gcc) #1 SMP")).toBe(true);
    expect(isWsl({}, "Linux version 6.8.0-1017-azure (buildd@lcy02) #20-Ubuntu SMP")).toBe(false);
    expect(isWsl({}, null)).toBe(false);
  });

  it("reads which file system holds a path, by the longest mount point above it", () => {
    const mounts = ["/dev/sdc / ext4 rw 0 0", "C:\\134 /mnt/c 9p rw,dirsync,aname=drvfs 0 0", "drvfs /win drvfs rw 0 0", "tmpfs /run tmpfs rw 0 0"].join("\n");
    expect(filesystemOf("/home/long/.podster-runner", mounts)).toBe("ext4");
    expect(filesystemOf("/mnt/c/Users/long/runner", mounts)).toBe("9p");
    expect(filesystemOf("/win/x", mounts)).toBe("drvfs");
    expect(filesystemOf("/mnt/cx", mounts)).toBe("ext4");
  });
});

describe("the Windows file system under WSL2 is refused", () => {
  it("names /mnt/<drive> paths, and nothing else", () => {
    for (const path of ["/mnt/c", "/mnt/c/Users/long", "/mnt/D/work"]) expect([path, onWindowsDrive(path)]).toEqual([path, true]);
    for (const path of ["/mnt", "/mnt/wsl/x", "/mnt/cd/x", "/home/long/mnt/c", "/Users/o/work"]) expect([path, onWindowsDrive(path)]).toEqual([path, false]);
  });

  it("refuses a run policy whose workspace root is on a Windows drive", () => {
    const config = { version: 1, revision: 1, owner_org: "org_one", adapter: "claude_agent_sdk", workspace_root: "/mnt/c/Users/long/work", caps: { spend_micro_usd: 100_000, run_time_ms: 600_000, turns: 5, output_tokens: 20_000, max_tokens: 1_024 }, day_caps: { spend_micro_usd: 1_000_000 }, rooms: [] };
    expect(parsePolicyConfig(config)).toEqual({ ok: false, at: "workspace_root_windows_drive" });
    expect(parsePolicyConfig({ ...config, workspace_root: "/home/long/work" }).ok).toBe(true);
    expect(parsePolicyConfig({ ...config, workspace_root: "/home/long/work" }, { runner_home: "/mnt/c/runner" })).toEqual({ ok: false, at: "runner_home_windows_drive" });
  });

  it("refuses to open a task container in a folder on a Windows drive", async () => {
    const { docker, calls } = fakeLinuxDocker();
    const sandbox = new DockerSandbox({ docker, image: IMAGE, uid: 1000, gid: 1000, home: "/home/long/.podster-runner" });
    const spec = containerSpec("run-1", { task_folder: "/mnt/c/work/ws_room/tsk_one", network: [], caps: { spend_micro_usd: 1, run_time_ms: 600_000, turns: 1, output_tokens: 1, max_tokens: 1 } });
    await expect(sandbox.open(spec, new AbortController().signal)).rejects.toThrow(/workspace_on_windows_drive/);
    expect(calls).toEqual([]);
  });

  it("refuses a task folder whose real path is on a 9p or drvfs mount, wherever the drive is mounted (L1)", async () => {
    const root = await temp();
    const drive = join(root, "drive");
    await mkdir(drive, { mode: 0o700 });
    await symlink(drive, join(root, "linked"));
    const mounts = `/dev/sdc / ext4 rw 0 0\nC:\\134 ${await realpath(drive)} 9p rw,aname=drvfs 0 0`;
    const { docker, calls } = fakeLinuxDocker();
    const sandbox = new DockerSandbox({ docker, image: IMAGE, uid: 1000, gid: 1000, home: "/home/long/.podster-runner", mounts: () => mounts });
    const caps = { spend_micro_usd: 1, run_time_ms: 600_000, turns: 1, output_tokens: 1, max_tokens: 1 };
    const spec = containerSpec("run-1", { task_folder: join(root, "linked", "ws", "ws_room", "tsk_one"), network: [], caps });
    await expect(sandbox.open(spec, new AbortController().signal)).rejects.toThrow(/workspace_on_windows_drive/);
    expect(calls).toEqual([]);
    // The same folder on an ordinary mount opens.
    const plain = new DockerSandbox({ docker, image: IMAGE, uid: 1000, gid: 1000, home: "/home/long/.podster-runner", mounts: () => "/dev/sdc / ext4 rw 0 0", every: () => () => undefined });
    // (This fake answers no container's processes, so the open goes on to `docker run` and then stops.)
    await expect(plain.open(containerSpec("run-2", { task_folder: join(root, "ws2", "ws_room", "tsk_one"), network: [], caps }), new AbortController().signal)).rejects.toThrow(/container_failed/);
    expect(calls[0][0]).toBe("run");
  });

  it("refuses a symlinked Runner home whose real path is on a drvfs mount (L1)", async () => {
    const root = await temp();
    await mkdir(join(root, "win"), { mode: 0o700 });
    await symlink(join(root, "win"), join(root, "home"));
    await expect(chooseKeyStore(join(root, "home"), { platform: "linux", env: {}, mounts: `drvfs ${await realpath(join(root, "win"))} drvfs rw 0 0` })).rejects.toThrow(/Windows file system/);
  });

  it("refuses Runner's home on a Windows drive before choosing a key store", async () => {
    await expect(chooseKeyStore("/mnt/c/Users/long/.podster-runner", { platform: "linux", env: {}, mounts: "" })).rejects.toThrow(/Windows file system/);
    await expect(chooseKeyStore("/win/runner", { platform: "linux", env: {}, mounts: "drvfs /win drvfs rw 0 0" })).rejects.toThrow(/Windows file system/);
  });
});

describe("the listener on a Unix socket (S-47)", () => {
  it("listens only on the socket, mode 0600 and owned by this user, and checks the token and the relay's Host", async () => {
    const dir = await temp();
    const path = join(dir, "r.sock");
    const halt = new AbortController();
    const seen: string[] = [];
    const listener = await startBrokerListener({ model: async (r) => (seen.push(r.path), { ok: true, status: 200, body: enc.encode('{"type":"message"}') }), signal: halt.signal, host: "relay:8080", socket: path });
    const info = await lstat(path);
    expect(info.isSocket()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.uid).toBe(process.getuid?.());
    expect(listener.port).toBe(0);
    expect(listener.url).toBe(`unix:${path}`);
    expect(await overSocket(path, httpRequest(listener.token))).toMatch(/^HTTP\/1\.1 200 /);
    expect(await overSocket(path, httpRequest(null))).toMatch(/^HTTP\/1\.1 401 /);
    expect(await overSocket(path, httpRequest("0".repeat(64)))).toMatch(/^HTTP\/1\.1 401 /);
    expect(await overSocket(path, httpRequest(listener.token, "127.0.0.1:8080"))).toMatch(/^HTTP\/1\.1 403 /);
    expect(seen).toEqual(["/v1/messages"]);
    halt.abort();
    await listener.close();
    await expect(lstat(path)).rejects.toThrow();
  });

  it("needs the relay's Host name with a socket, and refuses a path too long for a socket", async () => {
    const dir = await temp();
    const halt = new AbortController();
    const model = async () => ({ ok: true as const, status: 200, body: enc.encode("{}") });
    await expect(startBrokerListener({ model, signal: halt.signal, socket: join(dir, "r.sock") })).rejects.toThrow(/listener_socket_host/);
    await expect(startBrokerListener({ model, signal: halt.signal, host: "relay:8080", socket: join(dir, "x".repeat(120)) })).rejects.toThrow(/listener_socket_path/);
    await expect(startBrokerListener({ model, signal: halt.signal, host: "relay:8080", socket: "relative.sock" })).rejects.toThrow(/listener_socket_path/);
  });
});

describe("the relay on Linux: socat UNIX-CONNECT to the run's socket, internal network only", () => {
  it("mounts only the socket, read-only, and forwards to it; no host-gateway, no bridge", () => {
    const relay = relayRunArgs({ ref: "run-1", image: CLAUDE_IMAGE, uid: 1000, gid: 1000, socket: "/home/long/.podster-runner/runs/run-1/r.sock", home_label: "h", max_seconds: 660 });
    const flag = (name: string) => relay.filter((_, i) => relay[i - 1] === name);
    expect(flag("--mount")).toEqual([`type=bind,source=/home/long/.podster-runner/runs/run-1/r.sock,target=${RELAY_SOCKET_IN_CONTAINER},readonly`]);
    expect(flag("--network")).toEqual([claudeNames("run-1").network]);
    expect(flag("--add-host")).toEqual([]);
    expect(relay.slice(-3)).toEqual(["socat", "TCP-LISTEN:8080,fork,reuseaddr", `UNIX-CONNECT:${RELAY_SOCKET_IN_CONTAINER}`]);
    expect(relay).toContain("--read-only");
    expect(flag("--cap-drop")).toEqual(["ALL"]);
    expect(flag("--user")).toEqual(["1000:1000"]);
    // A path that would be read as mount options is refused.
    expect(() => relayRunArgs({ ref: "run-1", image: CLAUDE_IMAGE, uid: 1000, gid: 1000, socket: "/h/a,b.sock", home_label: "h", max_seconds: 60 })).toThrow();
    // The TCP relay (macOS) is unchanged.
    const tcp = relayRunArgs({ ref: "run-1", image: CLAUDE_IMAGE, uid: 501, gid: 20, port: 4321, home_label: "h", max_seconds: 660 });
    expect(tcp.at(-1)).toBe("TCP:host.docker.internal:4321");
    expect(tcp.filter((_, i) => tcp[i - 1] === "--mount")).toEqual([]);
  });

  it("prepares the run without joining the default bridge, and tears down by label", async () => {
    const home = await temp();
    const dk = fakeLinuxDocker();
    const d = driver(home, dk.docker);
    await d.prepare("run-1", { socket: join(home, "r.sock") }, 60);
    expect(dk.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["network create", "run --detach", "run --detach"]);
    expect(dk.calls.some((c) => c[0] === "network" && c[1] === "connect")).toBe(false);
    await d.teardown("run-1");
    expect(dk.containers.size).toBe(0);
    expect(dk.networks.size).toBe(0);
  });

  it("checks the relay end to end before Linux is turned on: Docker reachable, then a request through the relay with the token", async () => {
    const home = await temp();
    const dk = fakeLinuxDocker();
    await driver(home, dk.docker).checkRelay();
    // The request went in on standard input, never as an argument, and from Claude Code's own container.
    const exec = dk.calls.find((c) => c[0] === "exec") as string[];
    expect(exec).toContain("--interactive");
    expect(exec.join(" ")).not.toMatch(/x-api-key|[0-9a-f]{64}/);
    expect(exec.slice(2)).toEqual([exec[2], "socat", "-t", "10", "-", "TCP:relay:8080"]);
    expect(exec[2]).toMatch(/^podster-cc-chk-[0-9a-f]{8}$/);
    // Everything of the check is gone: containers, network and its folder.
    expect(dk.containers.size).toBe(0);
    expect(dk.networks.size).toBe(0);
    await expect(stat(join(home, "runs"))).resolves.toBeTruthy();
    expect(await (await import("node:fs/promises")).readdir(join(home, "runs"))).toEqual([]);
  });

  it("fails the check when something answers 200 without the listener's own value (L2)", async () => {
    const home = await temp();
    const dk = fakeLinuxDocker({ answerWithoutNonce: true });
    await expect(driver(home, dk.docker).checkRelay()).rejects.toThrow(/relay_check_failed/);
    expect(dk.containers.size).toBe(0);
    expect(dk.networks.size).toBe(0);
  });

  it("refuses a run whose socket path is too long with a fixed message naming --home and the limit, before anything starts", async () => {
    const home = await temp();
    const deep = join(home, "a".repeat(40), "b".repeat(40));
    await mkdir(deep, { recursive: true, mode: 0o700 });
    const dk = fakeLinuxDocker();
    const d = driver(deep, dk.docker);
    const halt = new AbortController();
    const s = { run_ref: "run-1", signal: halt.signal } as never;
    await expect(d.begin(s)).rejects.toThrow(/^relay_socket_path_too_long: .*--home.*100 bytes/);
    expect(dk.calls).toEqual([]);
  });

  it("fails the check, and leaves nothing, when the relay can't reach the socket", async () => {
    const home = await temp();
    const dk = fakeLinuxDocker({ relayBroken: true });
    await expect(driver(home, dk.docker).checkRelay()).rejects.toThrow(/relay_check_failed/);
    expect(dk.containers.size).toBe(0);
    expect(dk.networks.size).toBe(0);
  });
});

describe("the engine on Linux", () => {
  async function engineHome() {
    const home = await temp();
    const keyFile = join(home, "fake.key");
    await writeFile(keyFile, KEY, { mode: 0o600 });
    await writeFile(join(home, "task-image"), IMAGE);
    await writeFile(join(home, "claude-image"), CLAUDE_IMAGE);
    return { home, keyFile };
  }
  const build = async (home: string, keyFile: string, docker: DockerCli, extra: Record<string, unknown> = {}) => {
    const { claudeEngine } = await import("../src/node/claude-engine.js");
    return claudeEngine({ home, key_file: keyFile, log: () => undefined, docker, dockerProgram: DOCKER_PROGRAM, env: {}, execArgv: [], platform: "linux", mounts: "", procVersion: null, ...extra });
  };

  it("builds the engine only after Docker answers and the relay check passes", async () => {
    const { home, keyFile } = await engineHome();
    const dk = fakeLinuxDocker();
    const engine = await build(home, keyFile, dk.docker);
    expect(dk.calls[0][0]).toBe("version");
    expect(dk.calls.some((c) => c[0] === "exec" && c.includes("socat"))).toBe(true);
    expect(engine.drivers.claude_agent_sdk).toBeDefined();
  });

  it("refuses with a fixed message when Docker isn't reachable, or the relay check fails, and says what to do in WSL2", async () => {
    const { home, keyFile } = await engineHome();
    await expect(build(home, keyFile, fakeLinuxDocker({ version: { code: 1, stdout: "" } }).docker)).rejects.toThrow(/^linux_check_failed: Docker isn't reachable/);
    await expect(build(home, keyFile, fakeLinuxDocker({ version: { code: 1, stdout: "" } }).docker, { env: { WSL_DISTRO_NAME: "Ubuntu" } })).rejects.toThrow(/WSL integration/);
    await expect(build(home, keyFile, fakeLinuxDocker({ relayBroken: true }).docker)).rejects.toThrow(/^linux_check_failed: Runner's relay/);
  });

  it("refuses a Runner home on the Windows file system, by its real path (L1)", async () => {
    const { home, keyFile } = await engineHome();
    await expect(build(home, keyFile, fakeLinuxDocker().docker, { mounts: `drvfs ${await realpath(home)} 9p rw 0 0` })).rejects.toThrow(/Windows file system/);
    // A link to it, from a folder that isn't on that mount, is refused the same.
    const elsewhere = await temp();
    await symlink(home, join(elsewhere, "home"));
    await expect(build(join(elsewhere, "home"), keyFile, fakeLinuxDocker().docker, { mounts: `drvfs ${await realpath(home)} 9p rw 0 0` })).rejects.toThrow(/Windows file system/);
  });

  it("refuses a home too long for the relay's socket with a fixed message naming --home, not as a relay failure (nit)", async () => {
    const { home, keyFile } = await engineHome();
    const deep = join(home, "x".repeat(60));
    await mkdir(deep, { mode: 0o700 });
    for (const f of ["task-image", "claude-image"]) await writeFile(join(deep, f), await readFile(join(home, f)));
    const dk = fakeLinuxDocker();
    await expect(build(deep, keyFile, dk.docker)).rejects.toThrow(/^linux_home_too_long: .*--home.*\d+ bytes/);
    expect(dk.calls).toEqual([]);
  });

  it("refuses Windows itself, pointing to WSL2", async () => {
    const { home, keyFile } = await engineHome();
    await expect(build(home, keyFile, fakeLinuxDocker().docker, { platform: "win32" })).rejects.toThrow(WINDOWS_REFUSAL);
  });
});

describe("Runner's key store on Linux", () => {
  /** A fake `secret-tool`: answers as a reachable Secret Service with no item, or as one that can't be reached. */
  function fakeSecretTool(reachable: boolean) {
    const calls: { file: string; args: string[]; input: string }[] = [];
    const runner: Runner = async (file, args, input) => {
      calls.push({ file, args, input });
      return reachable ? { code: 1, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" };
    };
    return { calls, runner };
  }
  const linux = (over: Record<string, unknown> = {}) => ({ platform: "linux" as const, env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, mounts: "", exists: () => true, ...over });

  it("uses the Secret Service through secret-tool's arguments when it answers, and says so in one fixed line", async () => {
    const home = await temp();
    const tool = fakeSecretTool(true);
    const chosen = await chooseKeyStore(home, linux({ runner: tool.runner }));
    expect(chosen.kind).toBe("secret_service");
    expect(chosen.line).toBe(KEY_STORE_LINES.secret_service);
    expect(tool.calls[0].file).toBe("/usr/bin/secret-tool");
    expect(tool.calls[0].args[0]).toBe("lookup");
    // Remembered: the next start uses the same store and doesn't fall back to a file.
    expect((await readFile(join(home, "key-store"), "utf8")).trim()).toBe("secret_service");
    const again = await chooseKeyStore(home, linux({ runner: fakeSecretTool(false).runner }));
    expect(again.kind).toBe("secret_service");
  });

  it("falls back to a file store when there's no secret-tool, no session bus, or it doesn't answer", async () => {
    for (const over of [{ exists: () => false }, { env: {} }, { runner: fakeSecretTool(false).runner }]) {
      const home = await temp();
      const chosen = await chooseKeyStore(home, linux({ runner: fakeSecretTool(true).runner, ...over }));
      expect(chosen.kind).toBe("file");
      expect(chosen.line).toBe(KEY_STORE_LINES.file);
      // Remembered too: a later start never moves keys to the Secret Service by itself.
      expect((await chooseKeyStore(home, linux({ runner: fakeSecretTool(true).runner }))).kind).toBe("file");
    }
  });

  it("refuses a marker it didn't write", async () => {
    const home = await temp();
    await writeFile(join(home, "key-store"), "plaintext\n", { mode: 0o600 });
    await expect(chooseKeyStore(home, linux({ runner: fakeSecretTool(true).runner }))).rejects.toThrow(/key-store/);
  });

  it("keeps macOS unchanged: the login keychain, no marker, and no limits but its own", async () => {
    const home = await temp();
    const chosen = await chooseKeyStore(home, { platform: "darwin", env: {} });
    expect(chosen.kind).toBe("macos_keychain");
    expect(chosen.line).toBe(KEY_STORE_LINES.macos_keychain);
    await expect(stat(join(home, "key-store"))).rejects.toThrow();
    await expect(chooseKeyStore(home, { platform: "win32", env: {} })).rejects.toThrow(/no supported keychain/);
  });

  it("the file store: folder 0700, files 0600, owned by this user, written whole, and refused if either is wrong", async () => {
    const home = await temp();
    const store = new FileSecretStore(home);
    expect(await store.get("host")).toBeNull();
    // Far past macOS's line limit: Linux has none of the keychain tool's.
    const big = "x".repeat(64 * 1024);
    await store.set("agent:agt_1", big);
    expect(await store.get("agent:agt_1")).toBe(big);
    const folder = await lstat(join(home, "keys"));
    expect(folder.mode & 0o777).toBe(0o700);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(home, "keys"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}$/);
    const file = await lstat(join(home, "keys", files[0]));
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.uid).toBe(process.getuid?.());
    await chmod(join(home, "keys", files[0]), 0o644);
    await expect(store.get("agent:agt_1")).rejects.toThrow(/mode 600/);
    await chmod(join(home, "keys", files[0]), 0o600);
    await chmod(join(home, "keys"), 0o755);
    await expect(store.get("agent:agt_1")).rejects.toThrow(/mode 700/);
    await chmod(join(home, "keys"), 0o700);
    await store.delete("agent:agt_1");
    await store.delete("agent:agt_1");
    expect(await store.get("agent:agt_1")).toBeNull();
  });

  it("the file store holds a real pairing's records through RunnerStorage, as the keychain does", async () => {
    const home = await temp();
    const mem = new RunnerStorage(new MemorySecretStore());
    const file = new RunnerStorage(new FileSecretStore(home));
    const keypair = { publicKey: { kty: "OKP", crv: "Ed25519", x: "x" }, privateKey: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" } } as never;
    await mem.installHostKey(keypair);
    await file.installHostKey(keypair);
    expect((await file.getHostIdentity())?.keypair).toEqual((await mem.getHostIdentity())?.keypair);
    await file.deleteAll();
    expect(await file.getHostIdentity()).toBeNull();
  });

  it("the file store never follows a link planted at an item, and never reads a FIFO or an item past its bound (L3)", async () => {
    const home = await temp();
    const store = new FileSecretStore(home);
    await store.set("host", "real");
    const item = (name: string) => join(home, "keys", createHash("sha256").update(name).digest("hex"));
    // A link to a file holding something else, owned by this user and mode 600: refused, not followed.
    const decoy = join(home, "decoy");
    await writeFile(decoy, "planted", { mode: 0o600 });
    await rm(item("host"));
    await symlink(decoy, item("host"));
    await expect(store.get("host")).rejects.toThrow(/regular file/);
    await rm(item("host"));
    // A FIFO: refused at once, never waited on.
    execFileSync("mkfifo", ["-m", "600", item("host")]);
    await expect(store.get("host")).rejects.toThrow(/regular file/);
    await rm(item("host"));
    // One byte past the bound.
    await writeFile(item("host"), "x".repeat(MAX_ITEM_BYTES + 1), { mode: 0o600 });
    await expect(store.get("host")).rejects.toThrow(/regular file/);
    await expect(store.set("host", "x".repeat(MAX_ITEM_BYTES + 1))).rejects.toThrow(/too large/);
  });

  it("the file store needs Runner's home to be this user's, mode 700 (L3)", async () => {
    const home = await temp();
    await chmod(home, 0o755);
    await expect(new FileSecretStore(home).get("host")).rejects.toThrow(/home must be yours alone \(mode 700\)/);
    await chmod(home, 0o700);
    expect(await new FileSecretStore(home).get("host")).toBeNull();
  });

  it("writes atomically and clears an earlier write's leftover temporary file (L3)", async () => {
    const dir = await temp();
    const target = join(dir, "item");
    await writeFile(join(dir, ".item.0123456789ab.tmp"), "half", { mode: 0o600 });
    await writeFileAtomic(target, "whole");
    expect(await readdir(dir)).toEqual(["item"]);
    expect(await readFile(target, "utf8")).toBe("whole");
  });

  it("writes atomically: a new file in the same folder, renamed over, never through a link", async () => {
    const dir = await temp();
    const target = join(dir, "item");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    expect(await readFile(target, "utf8")).toBe("two");
    expect(((await lstat(target)).mode & 0o777)).toBe(0o600);
    const { readdir, symlink } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["item"]);
    await mkdir(join(dir, "elsewhere"), { mode: 0o700 });
    await symlink(join(dir, "elsewhere", "x"), join(dir, "link"));
    await writeFileAtomic(join(dir, "link"), "three");
    // The link itself was replaced; nothing was written where it pointed.
    expect((await lstat(join(dir, "link"))).isSymbolicLink()).toBe(false);
    await expect(stat(join(dir, "elsewhere", "x"))).rejects.toThrow();
  });
});
