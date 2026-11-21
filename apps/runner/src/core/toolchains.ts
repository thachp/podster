/**
 * Runner's optional toolchains (the owner's ruling of 2026-11-20: no single large task image). A room's run policy may
 * name some, `"toolchains": ["rust", "python"]` (or `dotnet`, `java`); its tasks then run in an image built FROM Runner's base task image
 * with those toolchains added, each pinned in its own Dockerfile under `apps/runner/toolchains/<name>`. A room that
 * names none runs in the base image exactly as before.
 *
 * Everything here is fixed: the names, the environment each adds to the task's container, the words the model is told
 * and the registries the owner is pointed at. Nothing comes from the task or from Podster. Pure: no I/O.
 *
 * **Adding one**: a name in `TOOLCHAINS` (in policy.ts, which imports nothing), its entries in `TOOLCHAIN_ENV` and
 * `TOOLCHAIN_INFO`, its spelling of the architecture in `TOOLCHAIN_ARCH` (toolchain-images.ts), a Dockerfile at
 * `apps/runner/toolchains/<name>/Dockerfile` that starts `ARG BASE` and builds `FROM ${BASE}` with checksums written in
 * the file, that Dockerfile in package.json's `files`, its pin tests, and a row in RUNNER.md. Its environment must not
 * name a variable another toolchain sets, and every path it puts under /work must be under a `WORK_TREE_CACHES` folder.
 */

import { isToolchain, TOOLCHAINS, type Toolchain } from "./policy.js";

export { isToolchain, TOOLCHAINS, type Toolchain };

/**
 * What each toolchain adds to the task container's fixed environment, only in a room that names it. Every value is a
 * fixed path inside the container or a fixed word; caches go under the task's folder (`HOME` is /work/.cache/home), never /tmp,
 * which is noexec and small.
 */
export const TOOLCHAIN_ENV: Readonly<Record<Toolchain, Readonly<Record<string, string>>>> = Object.freeze({
  // The CLI's home and NuGet's packages under /work/.cache (NuGet's own data and the runtime's ~/.dotnet follow HOME,
  // also there); no telemetry, logo, first-run work or ASP.NET development certificate (a private key it would write
  // under HOME); DOTNET_ROOT so a built program's own launcher finds the runtime; and no MSBuild nodes or compiler
  // server left running after a command.
  dotnet: Object.freeze({
    DOTNET_ROOT: "/opt/dotnet",
    DOTNET_CLI_HOME: "/work/.cache/dotnet",
    NUGET_PACKAGES: "/work/.cache/nuget/packages",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "1",
    MSBUILDDISABLENODEREUSE: "1",
    UseSharedCompilation: "false",
  }),
  // Maven's local repository and the Gradle wrapper's home under /work/.cache. Gradle reads no proxy from the
  // environment, so GRADLE_OPTS names Runner's egress proxy (`egress`, port 3128, as EGRESS_ENV does), which resolves
  // only in a run whose network lists hosts; the image points the JDK and Maven at it in their own configuration.
  // GRADLE_OPTS also turns off Gradle's daemon and runs Kotlin's compiler in Gradle's own process, so neither outlives
  // a command.
  java: Object.freeze({
    JAVA_HOME: "/opt/java/jdk",
    MAVEN_OPTS: "-Dmaven.repo.local=/work/.cache/m2/repository",
    GRADLE_USER_HOME: "/work/.cache/gradle",
    GRADLE_OPTS: "-Dhttps.proxyHost=egress -Dhttps.proxyPort=3128 -Dhttp.proxyHost=egress -Dhttp.proxyPort=3128 -Dorg.gradle.daemon=false -Dkotlin.compiler.execution.strategy=in-process",
  }),
  python: Object.freeze({
    UV_CACHE_DIR: "/work/.cache/uv",
    UV_PYTHON_INSTALL_DIR: "/opt/uv/python",
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_PYTHON_DOWNLOADS: "never",
  }),
  rust: Object.freeze({
    CARGO_HOME: "/work/.cargo",
  }),
});

/** What the model is told a toolchain holds, and the registry hosts a room lists in `network` to fetch packages. */
export const TOOLCHAIN_INFO: Readonly<Record<Toolchain, { readonly label: string; readonly versions: string; readonly registries: readonly string[] }>> = Object.freeze({
  dotnet: { label: ".NET", versions: ".NET SDK 10.0.404 (dotnet, with the .NET 10.0.15 runtime)", registries: ["api.nuget.org"] },
  java: {
    label: "Java",
    versions: "Java 25 (Temurin JDK 25.0.5.1: java, javac, jar) and Maven 3.10.1 (mvn); Gradle only through a project's own wrapper",
    // The Gradle wrapper's download from services.gradle.org redirected on 2026-11-20 to GitHub's release hosts,
    // which RUNNER.md names; they aren't listed here, since listing them opens much more than Gradle.
    registries: ["repo.maven.apache.org", "services.gradle.org", "plugins.gradle.org"],
  },
  python: { label: "Python", versions: "Python 3.14.10 (python, python3) and uv 0.13.9", registries: ["pypi.org", "files.pythonhosted.org"] },
  rust: { label: "Rust", versions: "Rust 1.100.0 (cargo, rustc, rustfmt, clippy) with gcc 12 as its linker", registries: ["index.crates.io", "static.crates.io"] },
});

/** A room's toolchains as a run uses them: each once, sorted. */
export function sortedToolchains(list: readonly Toolchain[]): Toolchain[] {
  return [...new Set(list)].sort();
}

/** True for a list a container spec may carry: known names, each once, sorted. */
export function isToolchainList(v: unknown): v is Toolchain[] {
  return Array.isArray(v) && v.length <= TOOLCHAINS.length && v.every(isToolchain) && v.every((t, i) => i === 0 || v[i - 1] < t);
}

/** The environment a set of toolchains adds: the union of each one's, which never overlap. */
export function toolchainEnv(list: readonly Toolchain[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const t of list) Object.assign(env, TOOLCHAIN_ENV[t]);
  return env;
}

/** The frame's fixed line for a run's toolchains, or null when it has none or no shell to use them. */
export function toolchainLine(list: readonly Toolchain[], shell: boolean): string | null {
  if (list.length === 0 || !shell) return null;
  const held = list.map((t) => TOOLCHAIN_INFO[t].versions).join("; ");
  return `Toolchains in the task's container, for the shell: ${held}. Keep builds, caches and virtual environments inside /work: /tmp can't run programs and the rest of the file system is read-only. Packages can be fetched only from registry hosts the run's network lists.`;
}

/** The shell tool's fixed description, naming the run's toolchains when it has any. */
export function shellDescription(list: readonly Toolchain[]): string {
  const base = "Run a shell command in the task's container, in its folder. It reaches no network but the hosts the run's instructions name, if any.";
  if (list.length === 0) return base;
  return `${base} Toolchains here: ${list.map((t) => TOOLCHAIN_INFO[t].versions).join("; ")}.`;
}
