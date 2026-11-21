// Runner's toolchain images (the owner's ruling of 2026-11-20): their Dockerfiles' pins, and how Runner builds, pins and
// reuses them on first need. Every test here runs on a fake docker: no real build, and nothing of the owner's Docker is
// read or changed. The real builds and runs are test/toolchains-docker.test.ts.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TOOLCHAINS, type Toolchain } from "../src/core/toolchains.js";
import type { DockerCli } from "../src/node/docker-sandbox.js";
import { BASE_TAG, buildingLine, builtOn, ensureToolchainImage, LABEL_RECIPE, pinName, recipeOf, TOOLCHAIN_BUILD_FAILED, TOOLCHAIN_INSPECT_FAILED, TOOLCHAIN_PIN_INVALID, TOOLCHAIN_SOURCES } from "../src/node/toolchain-images.js";

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
    expect(code(text)).toMatch(/sha256sum -c sums/);
    // The build stops unless ARCH is one it has sums for and matches the image's own architecture.
    expect(code(text)).toContain('case "$ARCH/$(dpkg --print-architecture)" in');
    expect(code(text)).toMatch(/aarch64\/arm64\)/);
    expect(code(text)).toMatch(/x86_64\/amd64\)/);
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
});

type Answer = Partial<{ code: number; stdout: string; stderr: string; cut: boolean }>;
type Image = { labels: Record<string, string> | null; layers: string[] };

/** A Docker with images in memory: inspect answers from them; a build adds one, its layers the parent's plus one. */
function fakeDocker(images: Map<string, Image>, opts: { arch?: string; build?: (args: string[]) => Answer | null; nextId?: () => string } = {}) {
  const calls: string[][] = [];
  const tags = new Map<string, string>();
  let n = 0;
  const docker: DockerCli = async (args) => {
    calls.push(args);
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
    for (const set of [[], ["rust", "python"], ["rust", "rust"], ["dotnet"]] as Toolchain[][])
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
