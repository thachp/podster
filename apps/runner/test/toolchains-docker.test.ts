// Runner's toolchain images on a real Docker Engine (the owner's ruling of 2026-11-20). It never runs in the default
// config: set RUNNER_TOOLCHAIN_DOCKER=1 to run it on this machine (`npx vitest run --config vitest.linux.config.ts` with
// it), and CI's Linux job runs it with RUNNER_LINUX_DOCKER=1 next to S-47's proof. Building the images fetches Debian's
// packages, Node, Rust, uv and CPython from their pinned addresses; the runs themselves have no network. No provider is
// called.
//
// It builds Runner's base task image, then opens runs through `DockerSandbox` exactly as Runner does, with Runner's own
// `ensureToolchainImage` building and pinning each toolchain image FROM that base on first need, and from INSIDE each
// task container (network none, read-only root, noexec /tmp, Runner's fixed environment and bounds) proves:
// - Rust: cargo, rustc, rustfmt and clippy answer their pinned versions, and `cargo build` of a tiny crate with no
//   dependencies and a build script works offline, the build script running from the crate's target folder in /work;
// - Python: uv and python answer their pinned versions, and `uv run` of a standard-library script works offline;
// - both together: one image with both, reusing Python's pinned image as its parent, and a second ask builds nothing;
// - a room with no toolchains runs the base image itself, with the base bounds, and has neither toolchain.
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunFacts } from "../src/core/policy.js";
import { containerSpec } from "../src/core/run-interface.js";
import type { Toolchain } from "../src/core/toolchains.js";
import { dockerCli, dockerHost, DockerSandbox, findDocker, IMAGE_ID, LIMITS, TOOLCHAIN_LIMITS, type DockerCli } from "../src/node/docker-sandbox.js";
import { ensureFolder } from "../src/node/safe-fs.js";
import { ensureToolchainImage, pinName } from "../src/node/toolchain-images.js";

const ON = process.env.RUNNER_TOOLCHAIN_DOCKER === "1" || (process.platform === "linux" && process.env.RUNNER_LINUX_DOCKER === "1");
const apps = new URL("../", import.meta.url).pathname;

describe.runIf(ON)("the toolchain images on a real Docker Engine", () => {
  let home = "";
  let work = "";
  let docker: DockerCli;
  let base = "";
  let sandbox: DockerSandbox;
  const said: string[] = [];
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  const signal = new AbortController().signal;

  const facts = (ref: string, toolchains: Toolchain[]): Pick<RunFacts, "task_folder" | "network" | "caps" | "toolchains"> => ({
    task_folder: join(work, "ws_tc", ref),
    network: [],
    toolchains,
    caps: { spend_micro_usd: 1, run_time_ms: 900_000, turns: 1, output_tokens: 1, max_tokens: 1 },
  });
  const shell = async (ref: string, command: string) => sandbox.exec(ref, { call_id: "c", tool: "shell", command }, signal);
  const write = async (ref: string, path: string, content: string) => expect((await sandbox.exec(ref, { call_id: "w", tool: "write", path, content }, signal)).ok).toBe(true);
  const inspect = async (ref: string, format: string) => (await docker(["inspect", "--format", format, `podster-run-${ref}`], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 })).stdout.trim();

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "rth-"));
    work = await mkdtemp(join(tmpdir(), "rtw-"));
    await chmod(home, 0o700);
    await chmod(work, 0o700);
    const program = findDocker() ?? "";
    expect(program).not.toBe("");
    docker = dockerCli(program, { config_dir: await ensureFolder(home, join(home, "docker-config")), host: dockerHost(process.env, process.platform) });
    const built = await docker(["build", "--quiet", "--pull=false", join(apps, "sandbox")], { timeoutMs: 15 * 60_000, maxOutputBytes: 64 * 1024 });
    expect(built.code).toBe(0);
    base = built.stdout.trim();
    expect(base).toMatch(IMAGE_ID);
    sandbox = new DockerSandbox({
      docker,
      image: base,
      uid,
      gid,
      home,
      toolchainImage: (set, s) => ensureToolchainImage(set, { home, docker, notify: (line) => void said.push(line), base, signal: s }),
    });
  });

  afterAll(async () => {
    if (sandbox) await sandbox.reapAll().catch(() => undefined);
    if (home) await rm(home, { recursive: true, force: true });
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  });

  it("Rust: the pinned versions, and an offline cargo build of a tiny crate whose build script runs in /work", async () => {
    const ref = "tc-rust";
    await sandbox.open(containerSpec(ref, facts(ref, ["rust"])), signal);
    try {
      const pinned = (await readFile(join(home, pinName(["rust"])), "utf8")).trim();
      expect(pinned).toMatch(IMAGE_ID);
      expect(await inspect(ref, "{{.Image}}")).toBe(pinned);
      expect(await inspect(ref, "{{.HostConfig.NetworkMode}}")).toBe("none");
      expect(await inspect(ref, "{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.ReadonlyRootfs}}")).toBe(`${TOOLCHAIN_LIMITS.pids} ${4 * 1024 ** 3} true`);
      const versions = await shell(ref, "cargo --version && rustc --version && cargo fmt --version && cargo clippy --version && echo home=$CARGO_HOME");
      expect(versions.ok).toBe(true);
      expect(versions.text).toMatch(/^cargo 1\.100\.0 /m);
      expect(versions.text).toMatch(/^rustc 1\.100\.0 /m);
      expect(versions.text).toMatch(/^rustfmt 1\.11\.0-stable /m);
      expect(versions.text).toMatch(/^clippy 0\.1\.100 /m);
      expect(versions.text).toContain("home=/work/.cargo");
      await write(ref, "hello/Cargo.toml", '[package]\nname = "hello"\nversion = "0.1.0"\nedition = "2021"\n');
      await write(ref, "hello/build.rs", 'fn main() { println!("cargo:rustc-env=FROM_BUILD_SCRIPT=ran"); }\n');
      await write(ref, "hello/src/main.rs", 'fn main() { println!("build script {}", env!("FROM_BUILD_SCRIPT")); }\n');
      const build = await shell(ref, "cd hello && cargo build --offline --quiet && ./target/debug/hello && find /work/hello/target -type f -perm -u+x -name 'build_script_build*'");
      expect(build.text).toMatch(/^build script ran$/m);
      // The build script, compiled and run from the crate's own target folder in /work.
      expect(build.text).toMatch(/^\/work\/hello\/target\/debug\/build\/\S*build_script_build\S*$/m);
      expect([build.ok, build.text]).toEqual([true, build.text]);
      // /tmp is noexec, so nothing built there could run: the target folder in /work is what makes this work.
      expect((await shell(ref, "cp /work/hello/target/debug/hello /tmp/h && /tmp/h")).ok).toBe(false);
    } finally {
      await sandbox.kill(ref);
    }
  });

  it("Python: the pinned versions, and an offline uv run of a standard-library script", async () => {
    const ref = "tc-python";
    await sandbox.open(containerSpec(ref, facts(ref, ["python"])), signal);
    try {
      expect(await inspect(ref, "{{.Image}}")).toBe((await readFile(join(home, pinName(["python"])), "utf8")).trim());
      const versions = await shell(ref, "uv --version && python --version && python3 --version && echo cache=$UV_CACHE_DIR downloads=$UV_PYTHON_DOWNLOADS");
      expect(versions.ok).toBe(true);
      expect(versions.text).toMatch(/^uv 0\.13\.9 /m);
      expect(versions.text).toMatch(/^Python 3\.14\.10$/m);
      expect(versions.text).toContain("cache=/work/.cache/uv downloads=never");
      await write(ref, "stats.py", "import json, statistics, sqlite3\nprint(json.dumps({'mean': statistics.mean([1, 2, 3, 6]), 'sqlite': bool(sqlite3.sqlite_version)}))\n");
      const ran = await shell(ref, "uv run --no-project --offline stats.py");
      expect(ran.text).toContain('{"mean": 3, "sqlite": true}');
      expect(ran.ok).toBe(true);
      // A virtual environment goes in /work; there is no network to fetch another Python or a package.
      expect((await shell(ref, "uv venv --offline /work/.venv && /work/.venv/bin/python -c 'import sys; print(sys.prefix)'")).text).toContain("/work/.venv");
      expect((await shell(ref, "uv pip install --python /work/.venv/bin/python six")).ok).toBe(false);
    } finally {
      await sandbox.kill(ref);
    }
  });

  it("both: one image layered on Python's pinned image, and a second ask builds nothing", async () => {
    const ref = "tc-both";
    const before = said.length;
    await sandbox.open(containerSpec(ref, facts(ref, ["python", "rust"])), signal);
    try {
      // Python's image was pinned by the test above, so only the combined step is built.
      expect(said.slice(before)).toEqual([expect.stringContaining("Python and Rust toolchains")]);
      const both = (await readFile(join(home, pinName(["python", "rust"])), "utf8")).trim();
      expect(await inspect(ref, "{{.Image}}")).toBe(both);
      const versions = await shell(ref, "cargo --version && python --version && uv --version && node --version && echo $CARGO_HOME $UV_CACHE_DIR");
      expect(versions.ok).toBe(true);
      expect(versions.text).toMatch(/^cargo 1\.100\.0 /m);
      expect(versions.text).toMatch(/^Python 3\.14\.10$/m);
      expect(versions.text).toMatch(/^v22\.23\.5$/m);
      expect(versions.text).toContain("/work/.cargo /work/.cache/uv");
      const again = said.length;
      expect(await ensureToolchainImage(["python", "rust"], { home, docker, notify: (line) => void said.push(line), base })).toBe(both);
      expect(said.length).toBe(again);
    } finally {
      await sandbox.kill(ref);
    }
  });

  it("a room with no toolchains runs the base image itself, with the base bounds and neither toolchain", async () => {
    const ref = "tc-none";
    await sandbox.open(containerSpec(ref, facts(ref, [])), signal);
    try {
      expect(await inspect(ref, "{{.Image}}")).toBe(base);
      expect(await inspect(ref, "{{.HostConfig.PidsLimit}}")).toBe(String(LIMITS.pids));
      const env = await inspect(ref, "{{json .Config.Env}}");
      expect(env).not.toMatch(/CARGO_HOME|UV_/);
      const missing = await shell(ref, "command -v cargo; command -v uv; command -v python3; echo done");
      expect(missing.text.trim()).toBe("done");
    } finally {
      await sandbox.kill(ref);
    }
  });
});
