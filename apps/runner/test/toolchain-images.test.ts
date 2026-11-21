// Runner's toolchain images (the owner's ruling of 2026-11-20): their Dockerfiles' pins, and how Runner builds, pins and
// reuses them on first need. Every test here runs on a fake docker: no real build, and nothing of the owner's Docker is
// read or changed. The real builds and runs are test/toolchains-docker.test.ts.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WORK_TREE_CACHES } from "../src/core/repository.js";
import { TOOLCHAIN_ENV, TOOLCHAINS, type Toolchain } from "../src/core/toolchains.js";
import type { DockerCli } from "../src/node/docker-sandbox.js";
import { EGRESS_ALIAS, EGRESS_PORT } from "../src/core/run-interface.js";
import { ARCHES, BASE_TAG, buildingLine, builtOn, ensureToolchainImage, SharedBuilds, toolchainImages, LABEL_RECIPE, pinName, recipeOf, TOOLCHAIN_ARCH, TOOLCHAIN_BUILD_FAILED, TOOLCHAIN_INSPECT_FAILED, TOOLCHAIN_PIN_INVALID, TOOLCHAIN_SOURCES } from "../src/node/toolchain-images.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const id = (c: string) => `sha256:${c.repeat(64)}`;
const BASE = id("b");
const L = (c: string) => id(c);

const temps: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "runner-tc-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const dockerfile = (name: Toolchain) => readFile(join(TOOLCHAIN_SOURCES[name], "Dockerfile"), "utf8");
/** The Dockerfile's instructions, its comments left out. */
const code = (text: string) => text.split("\n").filter((line) => !line.startsWith("#")).join("\n");

describe("the caches tools keep in the work tree", () => {
  it("are each under a folder Runner excludes from a repository room's commit", async () => {
    // Every /work path anywhere in a value, such as Maven's inside MAVEN_OPTS, not only values that are a path.
    const inWork = Object.values(TOOLCHAIN_ENV).flatMap((env) => Object.values(env)).flatMap((v) => v.match(/\/work(?:\/[^\s"'=:]*)?/g) ?? []);
    // npm's global prefix, from the task image's npmrc.
    const npmrc = (await readFile(join(PACKAGE, "sandbox", "Dockerfile"), "utf8")).match(/prefix=(\/work\/[^\\]+)\\n/);
    expect(npmrc?.[1]).toBe("/work/.npm-global");
    expect([...inWork, npmrc?.[1]].sort()).toEqual([
      "/work/.cache/dotnet",
      "/work/.cache/gradle",
      "/work/.cache/m2/repository",
      "/work/.cache/nuget/packages",
      "/work/.cache/uv",
      "/work/.cargo",
      "/work/.npm-global",
    ]);
    expect(WORK_TREE_CACHES).toEqual([".cache", ".cargo", ".npm-global"]);
    for (const path of [...inWork, npmrc?.[1] as string]) expect([path, WORK_TREE_CACHES.some((name) => path === `/work/${name}` || path.startsWith(`/work/${name}/`))]).toEqual([path, true]);
  });
});

describe("the toolchain Dockerfiles", () => {
  it("are the package's own toolchains/<name> folders, one per toolchain, each shipped in the package", async () => {
    expect(Object.keys(TOOLCHAIN_SOURCES)).toEqual([...TOOLCHAINS]);
    const pkg = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8")) as { files: string[] };
    for (const name of TOOLCHAINS) {
      expect(TOOLCHAIN_SOURCES[name]).toBe(join(PACKAGE, "toolchains", name));
      expect(existsSync(join(TOOLCHAIN_SOURCES[name], "Dockerfile"))).toBe(true);
      expect(pkg.files).toContain(`toolchains/${name}/Dockerfile`);
    }
  });

  it.each(TOOLCHAINS.map((t) => [t]))("%s: built FROM the base Runner passes, from a pinned Debian, copying nothing from the build folder", async (name) => {
    const text = await dockerfile(name);
    const lines = code(text).split("\n");
    expect(lines.filter((l) => /^ARG /.test(l)).slice(0, 2)).toEqual(["ARG BASE", "ARG ARCH"]);
    expect(lines.filter((l) => /^FROM /.test(l))).toEqual(["FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch", "FROM ${BASE}"]);
    for (const line of lines.filter((l) => /^(COPY|ADD)\b/.test(l))) expect(line).toMatch(/^COPY --from=fetch |^ADD https:\/\//);
    // Never a checksum file fetched during the build, a BuildKit-only feature or a floating source.
    expect(code(text)).not.toMatch(/SHASUMS|SHA256SUMS|\.sha256\b|--checksum|TARGETARCH|rustup|curl |wget |latest/);
    expect(text).not.toMatch(/# syntax=/);
    expect(code(text)).toMatch(/sha(256|512)sum -c sums/);
    // The build stops unless ARCH is one it has sums for and matches the image's own architecture.
    expect(code(text)).toContain('case "$ARCH/$(dpkg --print-architecture)" in');
    // ARCH in this toolchain's own spelling (TOOLCHAIN_ARCH), for Docker's arm64 and amd64.
    const arm = TOOLCHAIN_ARCH[name][ARCHES.arm64];
    const amd = TOOLCHAIN_ARCH[name][ARCHES.amd64];
    // Checked in the FROM ${BASE} stage too, against the base image's own architecture, before anything is installed.
    const final = code(text).slice(code(text).indexOf("FROM ${BASE}"));
    expect(final.startsWith(`FROM \${BASE}\nARG ARCH\nRUN case "$ARCH/$(dpkg --print-architecture)" in ${arm}/arm64|${amd}/amd64) ;; *) exit 1 ;; esac`)).toBe(true);
    expect(final).toMatch(/^.*\n.*\n.*esac( \\)?\n/);
    expect(code(text)).toContain(`${arm}/arm64)`);
    expect(code(text)).toContain(`${amd}/amd64)`);
    expect(code(text)).toMatch(/\*\) exit 1 ;;/);
    // Debian packages only from the base image's snapshot, at exact versions.
    expect(code(text)).not.toMatch(/deb\.debian\.org/);
    for (const install of code(text).match(/apt-get install [^\n\\]*/g) ?? []) for (const pkg of install.split(" ").slice(2).filter((t) => t !== "" && !t.startsWith("-"))) expect(pkg).toMatch(/^[a-z0-9.+-]+=[^=\s]+$/);
    expect(text).toContain('CMD ["sleep", "60"]');
  });

  it("rust: 1.100.0's rustc, cargo, rust-std, rustfmt and clippy from static.rust-lang.org, with the SHA-256s from the signed manifest", async () => {
    const text = await dockerfile("rust");
    for (const c of ["rustc", "cargo", "rust-std", "rustfmt", "clippy"]) expect(text).toContain(`ADD https://static.rust-lang.org/dist/2026-11-12/${c}-1.100.0-\${ARCH}-unknown-linux-gnu.tar.gz /fetch/${c}.tar.gz`);
    const sums: [string, string][] = [
      ["7ccc960846f81e016086f1931dedadd837a3317da80e0114df68651145c0f43b", "rustc"],
      ["b3acccbba065da7e97c20592442f104bd9554d54bf87a323bba8a1d6e61282eb", "cargo"],
      ["89b01323a6611c9382a401282fb66eb80f1f3241df3e139d3df41afbd2da314b", "rust-std"],
      ["e555f81eccd5e2f741732be3f6784d073946eadbf2e00f4112dfdabc6c36c13e", "rustfmt"],
      ["41920025e43c858e777177468698a88fc270bcceb6ba61059aac1dfee4da1d37", "clippy"],
      ["67b0e85ff4b3eee83c48b8ae1da10dd0bcd60b43d02cd0e7df78c59d19f6b960", "rustc"],
      ["4e7fc3cbe98e23c88a3c6ce37f834e3ffbc91536789782c4c4a9670df6b16a49", "cargo"],
      ["61eb09d68b338e230d698716927bd4623049c9910ef4a4972e66d763d66ed9e1", "rust-std"],
      ["b62ba6e046a5580c52f24a817101734b73e76ea0724fc6a21d57fba4db345ced", "rustfmt"],
      ["277a9abd9378561d11fb67a9eb5c08895e207d07dfd985a67197aa47e030856f", "clippy"],
    ];
    for (const [sum, c] of sums) expect(text).toContain(`${sum} ${c}.tar.gz`);
    // The signing key the manifest was checked against, named in the header.
    expect(text).toContain("108F 6620 5EAE B0AA A8DD 5E1C 85AB 96E6 FA1B E5FE");
    expect(text).toContain("install.sh\" --prefix=/opt/rust");
    expect(text).toContain("gcc=4:12.2.0-3 gcc-12=12.2.0-14+deb12u1 libc6-dev=2.36-9+deb12u14 binutils=2.40-2 ca-certificates=20230311+deb12u1");
    expect(text).toMatch(/ln -s \/opt\/rust\/bin\/rustc .* \/usr\/local\/bin\//);
  });

  it("python: uv 0.13.9 from its GitHub release and CPython 3.14.10 from python-build-standalone 20261110, installed by uv from a local mirror", async () => {
    const text = await dockerfile("python");
    expect(text).toContain("ADD https://github.com/astral-sh/uv/releases/download/0.13.9/uv-${ARCH}-unknown-linux-gnu.tar.gz /fetch/uv.tar.gz");
    expect(text).toContain("ADD https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.14.10%2B20261110-${ARCH}-unknown-linux-gnu-install_only_stripped.tar.gz /fetch/python.tar.gz");
    for (const line of [
      "0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d uv.tar.gz",
      "38fd50f07170adc29d481913d1c30b17ecb538fbe290315fe1f83d84fdd5b694 python.tar.gz",
      "a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5 uv.tar.gz",
      "c2ff2e97422f5d3896a16e0317fd212ba977bbf2688d93a6f7a03d817506bd30 python.tar.gz",
    ])
      expect(text).toContain(line);
    // uv installs the checked tarball from a file mirror, so it downloads nothing itself.
    expect(text).toContain("UV_PYTHON_INSTALL_MIRROR=file:///mirror");
    expect(text).toContain("uv python install --no-bin --no-registry 3.14.10");
    expect(text).toContain("ca-certificates=20230311+deb12u1");
    expect(text).toContain("ln -s /opt/uv/python/current/bin/python3.14 /usr/local/bin/python3 ");
  });

  it("dotnet: the .NET SDK 10.0.404 from builds.dotnet.microsoft.com, with the SHA-512s from Microsoft's release metadata", async () => {
    const text = await dockerfile("dotnet");
    expect(text).toContain("ADD https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.404/dotnet-sdk-10.0.404-linux-${ARCH}.tar.gz /fetch/dotnet.tar.gz");
    for (const [arch, sum] of [
      ["arm64", "3533a3869da219cac45c567aadac3d8e96cdf1c6a04fe1c1d5fdeefea5d45af8424488f0144730d11b4a751f7ad546fb11e4c2b2725cd8401efee726711f8f11"],
      ["x64", "577d0eb17fec33d029104c5c63a1ab0accc3e28776274abef2218dbac5af18d2109b5406d26b31d76f5c245215e3ba0926a94c20246c672c41847c9e1eb1dc50"],
    ])
      expect(text).toMatch(new RegExp(`${arch}/\\w+\\) printf '%s  %s\\\\n' \\\\\\n +${sum} dotnet\\.tar\\.gz > sums ;;`));
    expect(code(text)).toContain("sha512sum -c sums");
    expect(code(text)).toContain("test -d /opt/dotnet/sdk/10.0.404");
    expect(code(text)).toContain("test -d /opt/dotnet/shared/Microsoft.NETCore.App/10.0.15");
    // ICU and OpenSSL for the runtime, at exact versions from the base's snapshot; not invariant globalization.
    expect(text).toContain("libicu72=72.1-3+deb12u1 libssl3=3.0.20-1~deb12u2 openssl=3.0.20-1~deb12u2 ca-certificates=20230311+deb12u1");
    expect(code(text)).not.toContain("INVARIANT");
    // Workloads are user-local, under the CLI's home in /work, so the read-only SDK is never written to.
    expect(code(text)).toContain("touch /opt/dotnet/metadata/workloads/10.0.400/userlocal");
    expect(code(text)).toContain("ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet");
  });

  it("java: Temurin JDK 25.0.5.1+2 from Adoptium's GitHub release and Maven 3.10.1 from archive.apache.org, with their checked sums", async () => {
    const text = await dockerfile("java");
    expect(text).toContain("ADD https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5.1%2B2/OpenJDK25U-jdk_${ARCH}_linux_hotspot_25.0.5.1_2.tar.gz /fetch/jdk.tar.gz");
    expect(text).toContain("ADD https://archive.apache.org/dist/maven/maven-3/3.10.1/binaries/apache-maven-3.10.1-bin.tar.gz /fetch/maven.tar.gz");
    expect(text).toMatch(/aarch64\/arm64\) printf '%s  %s\\n' \\\n +c37879e0d08eeb1baa69fcbb7758cd455b7b1c0ceab1e2a136ccb1713c530984 jdk\.tar\.gz > sums ;;/);
    expect(text).toMatch(/x64\/amd64\) printf '%s  %s\\n' \\\n +760f91b22c3efc9bd1b64ff950598231be82928cc807e30691a0e7a2995a62c0 jdk\.tar\.gz > sums ;;/);
    expect(text).toContain("8af2fcc48ee6b8f8fc0b21054226e14404b88500df6483cdeb3ae603408f6de27b1397ac591a9fb0d98fee64f4f624fee1383efd25b8998786cda1598fb9ea39 maven.tar.gz > sums512");
    expect(code(text)).toContain("sha256sum -c sums");
    expect(code(text)).toContain("sha512sum -c sums512");
    // The keys the signatures were checked against, named in the header.
    expect(text).toContain("3B04 D753 C905 0D9A 5D34 3F39 843C 48A5 65F8 F04B");
    expect(text).toContain("88BE 34F9 4BDB 2B53 5704 4E2E 3A38 7D43 9641 43E3");
    // No Gradle installed, and no Debian package: Temurin carries its own CA certificates.
    expect(code(text)).not.toMatch(/gradle|apt-get/i);
    // The JDK and Maven reach the network only through Runner's egress proxy, which resolves only in a run that lists hosts.
    expect(code(text)).toContain(`'http.proxyHost=${EGRESS_ALIAS}' 'http.proxyPort=${EGRESS_PORT}' 'https.proxyHost=${EGRESS_ALIAS}' 'https.proxyPort=${EGRESS_PORT}' >> /opt/java/jdk/conf/net.properties`);
    for (const protocol of ["https", "http"])
      expect(code(text)).toContain(`<protocol>${protocol}</protocol><host>${EGRESS_ALIAS}</host><port>${EGRESS_PORT}</port><nonProxyHosts>localhost|127.*|::1|[::1]</nonProxyHosts>`);
    expect(code(text)).toContain("> /opt/java/maven/conf/settings.xml");
    expect(code(text)).toContain("ln -s /opt/java/jdk/bin/* /usr/local/bin/");
    expect(code(text)).toContain("ln -s /opt/java/maven/bin/mvn /usr/local/bin/mvn");
  });
});

type Answer = Partial<{ code: number; stdout: string; stderr: string; cut: boolean }>;
type Image = { labels: Record<string, string> | null; layers: string[] };

/** A Docker with images in memory: inspect answers from them; a build adds one, its layers the parent's plus one. */
function fakeDocker(images: Map<string, Image>, opts: { arch?: string; build?: (args: string[]) => Answer | null; nextId?: () => string; hold?: (args: string[], signal: AbortSignal | undefined) => Promise<void> } = {}) {
  const calls: string[][] = [];
  const tags = new Map<string, string>();
  let n = 0;
  const docker: DockerCli = async (args, o) => {
    calls.push(args);
    if (args[0] === "build" && opts.hold) await opts.hold(args, o.signal);
    if (o.signal?.aborted) return { code: 137, stdout: "", stderr: "killed", cut: false };
    const ok = (stdout = ""): Required<Answer> => ({ code: 0, stdout, stderr: "", cut: false });
    if (args[0] === "version") return ok(`${opts.arch ?? "arm64"}\n`);
    if (args[0] === "tag") {
      tags.set(args[2], args[1]);
      return ok();
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[4];
      const image = images.get(ref);
      if (!image) return { code: 1, stdout: "", stderr: `Error response from daemon: No such image: ${ref}`, cut: false };
      // Docker 29's containerd store answers another digest as `.Id` than the one a build printed; it isn't read.
      return ok(`${JSON.stringify({ labels: image.labels, layers: image.layers })}\n`);
    }
    if (args[0] === "build") {
      const special = opts.build?.(args);
      if (special) return { code: 0, stdout: "", stderr: "", cut: false, ...special };
      const from = tags.get(args[args.indexOf("--build-arg") + 1].slice("BASE=".length));
      const parent = from ? images.get(from) : undefined;
      if (!parent) return { code: 1, stdout: "", stderr: "no base", cut: false };
      n += 1;
      const built = opts.nextId?.() ?? id(String.fromCharCode(0x30 + n));
      const label = args[args.indexOf("--label") + 1];
      images.set(built, { labels: { [label.split("=")[0]]: label.split("=")[1] }, layers: [...parent.layers, L(String.fromCharCode(0x60 + n))] });
      return ok(`${built}\n`);
    }
    return { code: 2, stdout: "", stderr: "unexpected", cut: false };
  };
  return { calls, docker, tags };
}

const baseImages = () => new Map<string, Image>([[BASE, { labels: null, layers: [L("1"), L("2")] }]]);

describe("ensureToolchainImage", () => {
  it("builds each step FROM its parent by a tag on the parent's ID, with the Engine's architecture and the recipe label, then pins it", async () => {
    const home = await temp();
    const images = baseImages();
    const { calls, docker, tags } = fakeDocker(images);
    const said: string[] = [];
    const image = await ensureToolchainImage(["python", "rust"], { home, docker, notify: (l) => said.push(l), base: BASE });
    const builds = calls.filter((c) => c[0] === "build");
    expect(builds).toHaveLength(2);
    const python = (await readFile(join(home, pinName(["python"])), "utf8")).trim();
    expect((await readFile(join(home, pinName(["python", "rust"])), "utf8")).trim()).toBe(image);
    expect(pinName(["python", "rust"])).toBe("toolchain-image-python-rust");
    expect(builds[0]).toEqual(["build", "--quiet", "--pull=false", "--build-arg", `BASE=${BASE_TAG}:${"b".repeat(64)}`, "--build-arg", "ARCH=aarch64", "--label", `${LABEL_RECIPE}=${await recipeOf(BASE, "python")}`, TOOLCHAIN_SOURCES.python]);
    expect(builds[1]).toEqual(["build", "--quiet", "--pull=false", "--build-arg", `BASE=${BASE_TAG}:${python.slice(7)}`, "--build-arg", "ARCH=aarch64", "--label", `${LABEL_RECIPE}=${await recipeOf(python, "rust")}`, TOOLCHAIN_SOURCES.rust]);
    expect(tags.get(`${BASE_TAG}:${"b".repeat(64)}`)).toBe(BASE);
    expect(said).toEqual([buildingLine(["python"]), buildingLine(["python", "rust"])]);
    expect(said[1]).toBe("Building Runner's task image with the Python and Rust toolchains, from its packaged Dockerfiles, for a room that names them. This happens once and takes a few minutes.");
    // Layered on its parent, which is layered on the base.
    expect(builtOn(images.get(BASE)!.layers, images.get(python)!.layers)).toBe(true);
    expect(builtOn(images.get(python)!.layers, images.get(image)!.layers)).toBe(true);
  });

  it("uses a pinned image Docker has, with this recipe and on this parent, building and saying nothing", async () => {
    const home = await temp();
    const images = baseImages();
    const first = fakeDocker(images);
    const rust = await ensureToolchainImage(["rust"], { home, docker: first.docker, notify: () => undefined, base: BASE });
    const again = fakeDocker(images);
    const said: string[] = [];
    expect(await ensureToolchainImage(["rust"], { home, docker: again.docker, notify: (l) => said.push(l), base: BASE })).toBe(rust);
    expect(again.calls.map((c) => c[0])).toEqual(["image", "image"]);
    expect(said).toEqual([]);
  });

  it("rebuilds and re-pins when Docker no longer has the pinned image", async () => {
    const home = await temp();
    const images = baseImages();
    const rust = await ensureToolchainImage(["rust"], { home, docker: fakeDocker(images).docker, notify: () => undefined, base: BASE });
    images.delete(rust);
    const { calls, docker } = fakeDocker(images, { nextId: () => id("e") });
    expect(await ensureToolchainImage(["rust"], { home, docker, notify: () => undefined, base: BASE })).toBe(id("e"));
    expect(calls.filter((c) => c[0] === "build")).toHaveLength(1);
    expect((await readFile(join(home, pinName(["rust"])), "utf8")).trim()).toBe(id("e"));
  });

  it("rebuilds a stale pin: another base, another Dockerfile, or an image not layered on its parent", async () => {
    const stale: [string, (images: Map<string, Image>, pinned: string) => void, Partial<{ base: string; source: string }>][] = [
      ["the base task image was rebuilt", (images) => images.set(id("c"), { labels: null, layers: [L("9")] }), { base: id("c") }],
      ["a new Runner moved the Dockerfile's pins", () => undefined, { source: "FROM ${BASE}\n# moved\n" }],
      ["the pinned image isn't on the parent's layers", (images, pinned) => images.set(pinned, { ...images.get(pinned)!, layers: [L("8"), L("9")] }), {}],
      ["the pinned image has no recipe label", (images, pinned) => images.set(pinned, { ...images.get(pinned)!, labels: null }), {}],
    ];
    for (const [what, change, over] of stale) {
      const home = await temp();
      const images = baseImages();
      const pinned = await ensureToolchainImage(["rust"], { home, docker: fakeDocker(images).docker, notify: () => undefined, base: BASE });
      change(images, pinned);
      const readSource = over.source ? async () => Buffer.from(over.source as string) : undefined;
      const { calls, docker } = fakeDocker(images, { nextId: () => id("f") });
      const got = await ensureToolchainImage(["rust"], { home, docker, notify: () => undefined, base: over.base ?? BASE, readSource });
      expect([what, got, calls.filter((c) => c[0] === "build").length]).toEqual([what, id("f"), 1]);
    }
  });

  it("refuses an image a build made that isn't exactly its parent plus its own layers, or lacks the recipe, and pins nothing", async () => {
    const wrongs: [string, string[]][] = [
      ["layers from elsewhere", [L("8"), L("9")]],
      ["the parent's layers and nothing more", [L("1"), L("2")]],
    ];
    for (const [what, layers] of wrongs) {
      const home = await temp();
      const images = baseImages();
      const recipe = await recipeOf(BASE, "rust");
      const { docker } = fakeDocker(images, { build: () => (images.set(id("d"), { layers, labels: { [LABEL_RECIPE]: recipe } }), { stdout: `${id("d")}\n` }) });
      await expect(ensureToolchainImage(["rust"], { home, docker, notify: () => undefined, base: BASE }), what).rejects.toThrow(TOOLCHAIN_BUILD_FAILED);
      expect(existsSync(join(home, pinName(["rust"])))).toBe(false);
    }
  });

  it("stops with a fixed message when a build fails, saying nothing of Docker's output, and pins nothing", async () => {
    const home = await temp();
    const { docker } = fakeDocker(baseImages(), { build: () => ({ code: 1, stdout: "", stderr: "secret-ish build output" }) });
    const error = await ensureToolchainImage(["python"], { home, docker, notify: () => undefined, base: BASE }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(TOOLCHAIN_BUILD_FAILED);
    expect((error as Error).message).not.toContain("secret-ish");
    expect(existsSync(join(home, pinName(["python"])))).toBe(false);
  });

  it("builds only for arm64 and amd64 Engines, as aarch64 and x86_64", async () => {
    const amd = fakeDocker(baseImages(), { arch: "amd64" });
    await ensureToolchainImage(["rust"], { home: await temp(), docker: amd.docker, notify: () => undefined, base: BASE });
    expect(amd.calls.find((c) => c[0] === "build")).toContain("ARCH=x86_64");
    // .NET's and Temurin's tarballs name them otherwise, so each gets its own spelling.
    expect(TOOLCHAIN_ARCH).toEqual({
      dotnet: { aarch64: "arm64", x86_64: "x64" },
      java: { aarch64: "aarch64", x86_64: "x64" },
      python: { aarch64: "aarch64", x86_64: "x86_64" },
      rust: { aarch64: "aarch64", x86_64: "x86_64" },
    });
    for (const [arch, name, spelled] of [["amd64", "dotnet", "x64"], ["arm64", "dotnet", "arm64"], ["amd64", "java", "x64"], ["arm64", "java", "aarch64"], ["arm64", "python", "aarch64"]] as const) {
      const engine = fakeDocker(baseImages(), { arch });
      await ensureToolchainImage([name], { home: await temp(), docker: engine.docker, notify: () => undefined, base: BASE });
      const build = engine.calls.find((c) => c[0] === "build") ?? [];
      expect(build.filter((a) => a.startsWith("ARCH="))).toEqual([`ARCH=${spelled}`]);
      expect(build.at(-1)).toBe(TOOLCHAIN_SOURCES[name]);
    }
    for (const arch of ["s390x", "riscv64", "arm", ""]) {
      const { calls, docker } = fakeDocker(baseImages(), { arch });
      await expect(ensureToolchainImage(["rust"], { home: await temp(), docker, notify: () => undefined, base: BASE })).rejects.toThrow(TOOLCHAIN_BUILD_FAILED);
      expect(calls.filter((c) => c[0] === "build")).toEqual([]);
    }
  });

  it("stops when Docker can't say whether an image exists: nothing built or re-pinned", async () => {
    const home = await temp();
    const images = baseImages();
    const rust = await ensureToolchainImage(["rust"], { home, docker: fakeDocker(images).docker, notify: () => undefined, base: BASE });
    const real = fakeDocker(images);
    const failing: DockerCli = async (args, o) => (args[0] === "image" && args[4] === rust ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", cut: false } : real.docker(args, o));
    await expect(ensureToolchainImage(["rust"], { home, docker: failing, notify: () => undefined, base: BASE })).rejects.toThrow(TOOLCHAIN_INSPECT_FAILED);
    expect(real.calls.filter((c) => c[0] === "build")).toEqual([]);
    // Nor when the base itself is gone.
    await expect(ensureToolchainImage(["rust"], { home: await temp(), docker: fakeDocker(new Map()).docker, notify: () => undefined, base: BASE })).rejects.toThrow(TOOLCHAIN_INSPECT_FAILED);
  });

  it("refuses a pin it can't read as an image ID, or one that's a link, without building", async () => {
    const home = await temp();
    await writeFile(join(home, pinName(["rust"])), "rust:latest\n");
    const { calls, docker } = fakeDocker(baseImages());
    await expect(ensureToolchainImage(["rust"], { home, docker, notify: () => undefined, base: BASE })).rejects.toThrow(TOOLCHAIN_PIN_INVALID);
    const linked = await temp();
    await writeFile(join(linked, "elsewhere"), `${id("a")}\n`);
    await symlink(join(linked, "elsewhere"), join(linked, pinName(["rust"])));
    await expect(ensureToolchainImage(["rust"], { home: linked, docker, notify: () => undefined, base: BASE })).rejects.toThrow();
    expect(calls.filter((c) => c[0] === "build")).toEqual([]);
  });

  it("refuses a set that isn't sorted, known and non-empty, or a base that isn't an image ID", async () => {
    const { calls, docker } = fakeDocker(baseImages());
    for (const set of [[], ["rust", "python"], ["java", "dotnet"], ["rust", "rust"], ["gradle"]] as Toolchain[][])
      await expect(ensureToolchainImage(set, { home: await temp(), docker, notify: () => undefined, base: BASE })).rejects.toThrow(TOOLCHAIN_BUILD_FAILED);
    await expect(ensureToolchainImage(["rust"], { home: await temp(), docker, notify: () => undefined, base: "debian:latest" })).rejects.toThrow(TOOLCHAIN_BUILD_FAILED);
    expect(calls).toEqual([]);
  });

  it("binds the recipe to the parent's ID, the toolchain and its Dockerfile's exact bytes", async () => {
    const a = await recipeOf(BASE, "rust");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await recipeOf(id("c"), "rust")).not.toBe(a);
    expect(await recipeOf(BASE, "python")).not.toBe(a);
    expect(await recipeOf(BASE, "rust", async () => Buffer.from(`${await dockerfile("rust")} `))).not.toBe(a);
    expect(await recipeOf(BASE, "rust", async () => Buffer.from(await dockerfile("rust")))).toBe(a);
  });
});

describe("toolchain builds shared between runs (review items 2 and 3 on #497)", () => {
  /** A build held open until released, recording whether its signal was aborted. */
  function held() {
    const builds: { args: string[]; signal: AbortSignal | undefined; release: () => void }[] = [];
    const hold = (args: string[], signal: AbortSignal | undefined) =>
      new Promise<void>((resolve) => {
        builds.push({ args, signal, release: resolve });
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    return { builds, hold };
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));
  async function untilBuilds(builds: unknown[], count: number) {
    for (let i = 0; i < 200 && builds.length < count; i++) await flush();
    expect(builds.length).toBe(count);
  }

  it("a halted run leaves the build another run waits on running, and that run gets its image", async () => {
    const home = await temp();
    const { builds, hold } = held();
    const { calls, docker } = fakeDocker(baseImages(), { hold });
    const images = toolchainImages({ home, docker, notify: () => undefined, base: BASE });
    const a = new AbortController();
    const b = new AbortController();
    const runA = images(["rust"], a.signal);
    const runB = images(["rust"], b.signal);
    await untilBuilds(builds, 1);
    a.abort();
    await expect(runA).rejects.toThrow("halted");
    expect(builds[0].signal?.aborted).toBe(false);
    builds[0].release();
    const image = await runB;
    expect(image).toMatch(/^sha256:/);
    expect((await readFile(join(home, pinName(["rust"])), "utf8")).trim()).toBe(image);
    expect(calls.filter((c) => c[0] === "build")).toHaveLength(1);
  });

  it("ends a build only when every run waiting on it has halted, and the next ask starts afresh", async () => {
    const home = await temp();
    const { builds, hold } = held();
    const { calls, docker } = fakeDocker(baseImages(), { hold });
    const images = toolchainImages({ home, docker, notify: () => undefined, base: BASE });
    const a = new AbortController();
    const b = new AbortController();
    const runA = images(["rust"], a.signal);
    const runB = images(["rust"], b.signal);
    await untilBuilds(builds, 1);
    a.abort();
    await expect(runA).rejects.toThrow("halted");
    expect(builds[0].signal?.aborted).toBe(false);
    b.abort();
    await expect(runB).rejects.toThrow("halted");
    expect(builds[0].signal?.aborted).toBe(true);
    expect(existsSync(join(home, pinName(["rust"])))).toBe(false);
    const c = images(["rust"], new AbortController().signal);
    await untilBuilds(builds, 2);
    builds[1].release();
    expect(await c).toMatch(/^sha256:/);
    expect(calls.filter((x) => x[0] === "build")).toHaveLength(2);
  });

  it("builds and pins a step two sets share once, when both ask at the same time", async () => {
    const home = await temp();
    const { builds, hold } = held();
    const { calls, docker } = fakeDocker(baseImages(), { hold });
    const said: string[] = [];
    const images = toolchainImages({ home, docker, notify: (l) => said.push(l), base: BASE });
    const python = images(["python"], new AbortController().signal);
    const both = images(["python", "rust"], new AbortController().signal);
    await untilBuilds(builds, 1);
    await flush();
    // Only Python's step builds while both wait on it.
    expect(builds).toHaveLength(1);
    builds[0].release();
    const pythonImage = await python;
    await untilBuilds(builds, 2);
    builds[1].release();
    const bothImage = await both;
    expect(calls.filter((c) => c[0] === "build").map((c) => c.at(-1))).toEqual([TOOLCHAIN_SOURCES.python, TOOLCHAIN_SOURCES.rust]);
    expect((await readFile(join(home, pinName(["python"])), "utf8")).trim()).toBe(pythonImage);
    expect((await readFile(join(home, pinName(["python", "rust"])), "utf8")).trim()).toBe(bothImage);
    expect(said).toEqual([buildingLine(["python"]), buildingLine(["python", "rust"])]);
  });

  it("SharedBuilds: one build per key, a waiter's own abort ends only its wait, and a finished key can run again", async () => {
    const shared = new SharedBuilds();
    let started = 0;
    let release: (v: string) => void = () => undefined;
    let buildSignal: AbortSignal | null = null;
    const start = (signal: AbortSignal) => {
      started += 1;
      buildSignal = signal;
      return new Promise<string>((r) => (release = r));
    };
    const a = new AbortController();
    const one = shared.join("k", start, a.signal);
    const two = shared.join("k", start);
    expect(started).toBe(1);
    a.abort();
    await expect(one).rejects.toThrow("halted");
    expect((buildSignal as AbortSignal | null)?.aborted).toBe(false);
    release("done");
    expect(await two).toBe("done");
    await flush();
    expect(shared.size).toBe(0);
    await expect(shared.join("k", async () => "again")).resolves.toBe("again");
    expect(started).toBe(1);
    const gone = new AbortController();
    gone.abort();
    await expect(shared.join("k", start, gone.signal)).rejects.toThrow("halted");
  });
});
