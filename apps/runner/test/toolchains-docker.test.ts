// Runner's toolchain images on a real Docker Engine (the owner's ruling of 2026-11-20). It never runs in the default
// config: set RUNNER_TOOLCHAIN_DOCKER=1 to run it on this machine (`npx vitest run --config vitest.linux.config.ts` with
// it), and CI's Linux job runs it with RUNNER_LINUX_DOCKER=1 next to S-47's proof. Building the images fetches Debian's
// packages, Node, Rust, uv, CPython, the .NET SDK, the Temurin JDK and Maven from their pinned addresses; the runs
// themselves have no network. No provider is called.
//
// It builds Runner's base task image, then opens runs through `DockerSandbox` exactly as Runner does, with Runner's own
// `ensureToolchainImage` building and pinning each toolchain image FROM that base on first need, and from INSIDE each
// task container (network none, read-only root, noexec /tmp, Runner's fixed environment and bounds) proves:
// - Rust: cargo, rustc, rustfmt and clippy answer their pinned versions, and `cargo build` of a tiny crate with no
//   dependencies and a build script works offline, the build script running from the crate's target folder in /work;
// - Python: uv and python answer their pinned versions, and `uv run` of a standard-library script works offline;
// - both together: one image with both, reusing Python's pinned image as its parent, and a second ask builds nothing;
// - .NET: `dotnet --info` answers the pinned SDK and runtime, and `dotnet new console` and `dotnet build` work offline
//   from the SDK's bundled templates and packs (a project with no package references needs nothing from NuGet), the
//   program runs both through `dotnet` and its own launcher, no build server is left running, and nothing lands at
//   the top of /work but the project and folders Runner excludes from a commit;
// - Java: `java -version`, `javac` and a Hello class, and `mvn -v`, answer the pinned versions, Maven builds a project
//   offline with its local repository in /work/.cache, and the JDK and Maven name Runner's egress proxy;
// - .NET and Java together: one image layered on .NET's pinned image, with both;
// - a room with no toolchains runs the base image itself, with the base bounds, and has no toolchain.
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunFacts } from "../src/core/policy.js";
import { containerSpec } from "../src/core/run-interface.js";
import type { Toolchain } from "../src/core/toolchains.js";
import { dockerCli, dockerHost, DockerSandbox, findDocker, IMAGE_ID, LIMITS, TOOLCHAIN_LIMITS, type DockerCli } from "../src/node/docker-sandbox.js";
import { WORK_TREE_CACHES } from "../src/core/repository.js";
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
  /** Opens a run, saying Runner's own fixed message for the step that failed, if one did, and for a failed build the tail of Docker's output. */
  const open = (ref: string, toolchains: Toolchain[]) =>
    sandbox.open(containerSpec(ref, facts(ref, toolchains)), signal).catch((error: Error & { detail?: { stderr?: string } }) => {
      throw new Error(`${error.message}: ${error.detail?.stderr ?? ""}`);
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
    await open(ref, ["rust"]);
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
    await open(ref, ["python"]);
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
    await open(ref, ["python", "rust"]);
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

  /** The dot folders at the top of /work, which must each be one Runner excludes from a repository room's commit. */
  const topDots = async (ref: string) => (await shell(ref, "cd /work && ls -A | grep '^\\.' || true")).text.split("\n").filter((l) => l.startsWith("."));

  it(".NET: the pinned SDK, and an offline dotnet new console and dotnet build, run by dotnet and by its own launcher", async () => {
    const ref = "tc-dotnet";
    await open(ref, ["dotnet"]);
    try {
      const pinned = (await readFile(join(home, pinName(["dotnet"])), "utf8")).trim();
      expect(await inspect(ref, "{{.Image}}")).toBe(pinned);
      expect(await inspect(ref, "{{.HostConfig.NetworkMode}}")).toBe("none");
      expect(await inspect(ref, "{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.ReadonlyRootfs}}")).toBe(`${TOOLCHAIN_LIMITS.pids} ${4 * 1024 ** 3} true`);
      const info = await shell(ref, "dotnet --info && echo home=$DOTNET_CLI_HOME packages=$NUGET_PACKAGES root=$DOTNET_ROOT");
      expect(info.ok).toBe(true);
      expect(info.text).toMatch(/^ Version: +10\.0\.404$/m);
      expect(info.text).toMatch(/Microsoft\.NETCore\.App 10\.0\.15 \[\/opt\/dotnet\/shared\/Microsoft\.NETCore\.App\]/);
      expect(info.text).toMatch(/^ Base Path: +\/opt\/dotnet\/sdk\/10\.0\.404\/$/m);
      expect(info.text).toContain("home=/work/.cache/dotnet packages=/work/.cache/nuget/packages root=/opt/dotnet");
      // The bundled template, with no network: its restore needs nothing from NuGet, and the read-only SDK isn't written.
      const made = await shell(ref, "dotnet new console -o hello 2>&1");
      expect(made.text).toContain('The template "Console App" was created successfully.');
      expect(made.text).not.toMatch(/issue was encountered verifying workloads|Read-only file system|error/i);
      expect(made.ok).toBe(true);
      const built = await shell(ref, "cd hello && dotnet build 2>&1 && dotnet bin/Debug/net10.0/hello.dll && ./bin/Debug/net10.0/hello");
      expect(built.text).toMatch(/Build succeeded\.\s+0 Warning\(s\)\s+0 Error\(s\)/);
      expect(built.text).toMatch(/^Hello, World!\nHello, World!$/m);
      expect(built.ok).toBe(true);
      // No MSBuild node or compiler server is left behind.
      expect((await shell(ref, "ps -e -o comm= | grep -c -E 'dotnet|VBCSCompiler' || true")).text.trim()).toBe("0");
      // No ASP.NET development certificate (a private key) was made anywhere under /work.
      expect((await shell(ref, "find /work -name '*.pfx' | wc -l")).text.trim()).toBe("0");
      for (const dot of await topDots(ref)) expect([dot, WORK_TREE_CACHES.includes(dot as (typeof WORK_TREE_CACHES)[number])]).toEqual([dot, true]);
      // The runtime's ~/.dotnet and NuGet's ~/.local follow HOME, inside .cache.
      expect((await shell(ref, "test -d /work/.cache/home/.dotnet/corefx && test -d /work/.cache/home/.local/share/NuGet && echo inside")).text.trim()).toBe("inside");
      expect(await topDots(ref)).toEqual([".cache"]);
    } finally {
      await sandbox.kill(ref);
    }
  });

  it("Java: the pinned JDK and Maven, javac and a Hello class, an offline Maven build, and Runner's egress proxy named", async () => {
    const ref = "tc-java";
    await open(ref, ["java"]);
    try {
      expect(await inspect(ref, "{{.Image}}")).toBe((await readFile(join(home, pinName(["java"])), "utf8")).trim());
      const versions = await shell(ref, "java -version 2>&1 && javac -version 2>&1 && mvn -v && echo home=$JAVA_HOME gradle=$GRADLE_USER_HOME opts=$MAVEN_OPTS");
      expect(versions.ok).toBe(true);
      expect(versions.text).toMatch(/^openjdk version "25\.0\.5\.1" /m);
      expect(versions.text).toMatch(/^OpenJDK Runtime Environment Temurin-25\.0\.5\.1\+2 /m);
      expect(versions.text).toMatch(/^javac 25\.0\.5\.1$/m);
      expect(versions.text).toMatch(/^Apache Maven 3\.10\.1 /m);
      expect(versions.text).toMatch(/^Java version: 25\.0\.5\.1, vendor: Eclipse Adoptium, runtime: \/opt\/java\/jdk$/m);
      expect(versions.text).toContain("home=/opt/java/jdk gradle=/work/.cache/gradle opts=-Dmaven.repo.local=/work/.cache/m2/repository");
      expect((await shell(ref, "command -v gradle || echo none")).text.trim()).toBe("none");
      await write(ref, "hi/Hello.java", 'public class Hello { public static void main(String[] a) { System.out.println("hello from " + System.getProperty("java.version")); } }\n');
      const ran = await shell(ref, "cd hi && javac Hello.java && java -cp . Hello && java Hello.java");
      expect(ran.text).toMatch(/^hello from 25\.0\.5\.1\nhello from 25\.0\.5\.1$/m);
      expect(ran.ok).toBe(true);
      // A Maven build with no plugins to fetch, offline, its local repository where MAVEN_OPTS points.
      await write(ref, "app/pom.xml", '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>dev.podster</groupId><artifactId>app</artifactId><version>1</version><packaging>pom</packaging></project>\n');
      const mvn = await shell(ref, "cd app && mvn -B -o -X validate 2>&1");
      expect(mvn.text).toMatch(/BUILD SUCCESS/);
      // Anything Maven downloads goes to /work/.cache/m2/repository, and the proxy it would use is Runner's.
      expect(mvn.text).toMatch(/local repository.*\/work\/\.cache\/m2\/repository/i);
      expect(mvn.ok).toBe(true);
      // The proxy the JDK and Maven use when the room's network lists hosts: Runner's egress proxy, never another.
      const proxy = await shell(ref, "grep -E '^https?\\.proxy' /opt/java/jdk/conf/net.properties && grep -o '<host>[^<]*</host><port>[^<]*</port>' /opt/java/maven/conf/settings.xml");
      expect(proxy.text.trim().split("\n")).toEqual(["http.proxyHost=egress", "http.proxyPort=3128", "https.proxyHost=egress", "https.proxyPort=3128", "<host>egress</host><port>3128</port>", "<host>egress</host><port>3128</port>"]);
      // What a Maven wrapper and java.util.prefs write under the user's home: the JDK's user.home is HOME (the task's
      // user has no passwd entry), so both land in /work/.cache/home, never at the top of the work tree.
      await write(ref, "hi/Prefs.java", 'public class Prefs { public static void main(String[] a) throws Exception { var p = java.util.prefs.Preferences.userRoot().node("podster"); p.put("k", "v"); p.flush(); var w = java.nio.file.Path.of(System.getProperty("user.home"), ".m2", "wrapper", "dists", "x"); java.nio.file.Files.createDirectories(w.getParent()); java.nio.file.Files.writeString(w, "x"); System.out.println("user.home=" + System.getProperty("user.home")); } }\n');
      const homes = await shell(ref, "cd hi && java Prefs.java 2>/dev/null && ls -A /work/.cache/home && echo HOME=$HOME && pwd");
      expect(homes.text).toContain("user.home=/work/.cache/home");
      expect(homes.text).toMatch(/^\.java$/m);
      expect(homes.text).toMatch(/^\.m2$/m);
      expect(homes.text).toContain("HOME=/work/.cache/home");
      expect(homes.text).toMatch(/^\/work\/hi$/m);
      expect(homes.ok).toBe(true);
      for (const dot of await topDots(ref)) expect([dot, WORK_TREE_CACHES.includes(dot as (typeof WORK_TREE_CACHES)[number])]).toEqual([dot, true]);
      expect(await topDots(ref)).toEqual([".cache"]);
    } finally {
      await sandbox.kill(ref);
    }
  });

  it(".NET and Java together: one image layered on .NET's pinned image, with both", async () => {
    const ref = "tc-dotnet-java";
    const before = said.length;
    await open(ref, ["dotnet", "java"]);
    try {
      expect(said.slice(before)).toEqual([expect.stringContaining(".NET and Java toolchains")]);
      expect(await inspect(ref, "{{.Image}}")).toBe((await readFile(join(home, pinName(["dotnet", "java"])), "utf8")).trim());
      const versions = await shell(ref, "dotnet --version && java -version 2>&1 && mvn -v && node --version && echo $DOTNET_CLI_HOME $MAVEN_OPTS");
      expect(versions.ok).toBe(true);
      expect(versions.text).toMatch(/^10\.0\.404$/m);
      expect(versions.text).toMatch(/^openjdk version "25\.0\.5\.1" /m);
      expect(versions.text).toMatch(/^Apache Maven 3\.10\.1 /m);
      expect(versions.text).toMatch(/^v22\.23\.5$/m);
      expect(versions.text).toContain("/work/.cache/dotnet -Dmaven.repo.local=/work/.cache/m2/repository");
    } finally {
      await sandbox.kill(ref);
    }
  });

  it("a room with no toolchains runs the base image itself, with the base bounds and neither toolchain", async () => {
    const ref = "tc-none";
    await open(ref, []);
    try {
      expect(await inspect(ref, "{{.Image}}")).toBe(base);
      expect(await inspect(ref, "{{.HostConfig.PidsLimit}}")).toBe(String(LIMITS.pids));
      const env = await inspect(ref, "{{json .Config.Env}}");
      expect(env).not.toMatch(/CARGO_HOME|UV_|DOTNET|NUGET|JAVA|MAVEN|GRADLE/);
      const missing = await shell(ref, "command -v cargo; command -v uv; command -v python3; command -v dotnet; command -v java; command -v mvn; echo done");
      expect(missing.text.trim()).toBe("done");
      // Every room's HOME is /work/.cache/home, which Runner made, and its working folder /work: a tool's dot folder
      // (npm's ~/.npm, ~/.config) never lands at the top of the work tree.
      const home = await shell(ref, "echo $HOME; pwd; mkdir -p ~/.config/tool && echo x > ~/.config/tool/x && ls -A /work");
      expect(home.text.trim().split("\n")).toEqual(["/work/.cache/home", "/work", ".cache"]);
    } finally {
      await sandbox.kill(ref);
    }
  });
});
