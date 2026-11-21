// Runner's two images, built from the Dockerfiles in its own package when a pin is missing (the architect's ruling on
// #470). Every test runs on a fake docker: no real build, and nothing of the owner's Docker is read or changed.
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_FAILED, BUILDING, ensureImage, IMAGE_SOURCES, INSPECT_FAILED } from "../src/node/claude-engine.js";
import type { DockerCli } from "../src/node/docker-sandbox.js";

const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const NEW_CLAUDE = `sha256:${"c".repeat(64)}`;
const NEW_PROXY = `sha256:${"d".repeat(64)}`;
const KEY = "sk-ant-test-0123456789abcdefghij-the-owners-key";
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const temps: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "runner-images-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Answer = Partial<{ code: number; stdout: string; stderr: string; cut: boolean }>;
function fakeDocker(answer: (args: string[]) => Answer = () => ({})) {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const docker: DockerCli = async (args, { timeoutMs }) => {
    calls.push({ args, timeoutMs });
    return { code: 0, stdout: "", stderr: "", cut: false, ...answer(args) };
  };
  return { calls, docker };
}

describe("the packaged Dockerfiles", () => {
  it("are the package's own sandbox, claude-image and proxy-image folders, each with its Dockerfile", () => {
    expect(IMAGE_SOURCES["task-image"]).toBe(join(PACKAGE, "sandbox"));
    expect(IMAGE_SOURCES["claude-image"]).toBe(join(PACKAGE, "claude-image"));
    expect(IMAGE_SOURCES["proxy-image"]).toBe(join(PACKAGE, "proxy-image"));
    for (const folder of Object.values(IMAGE_SOURCES)) expect(existsSync(join(folder, "Dockerfile"))).toBe(true);
  });

  it("copy nothing from the build folder, so each Dockerfile is the whole of what's packaged for it", async () => {
    for (const folder of Object.values(IMAGE_SOURCES)) {
      const text = await readFile(join(folder, "Dockerfile"), "utf8");
      for (const line of text.split("\n").filter((l) => /^(COPY|ADD)\b/.test(l))) expect(line).toMatch(/^COPY --from=|^ADD https:\/\//);
    }
  });
});

describe("ensureImage", () => {
  it("uses a pinned image Docker has, without building or saying anything", async () => {
    const home = await temp();
    await writeFile(join(home, "task-image"), `${OLD}\n`);
    const { calls, docker } = fakeDocker();
    const said: string[] = [];
    expect(await ensureImage("task-image", { home, docker, notify: (l) => said.push(l) })).toBe(OLD);
    expect(calls.map((c) => c.args)).toEqual([["image", "inspect", "--format", "{{.Id}}", OLD]]);
    expect(said).toEqual([]);
  });

  it("builds a missing pin from the packaged Dockerfile, says so first, and pins what it built", async () => {
    for (const name of ["task-image", "claude-image", "proxy-image"] as const) {
      const home = await temp();
      const said: string[] = [];
      const { calls, docker } = fakeDocker((args) => (args[0] === "build" ? { stdout: `${NEW}\n` } : {}));
      expect(await ensureImage(name, { home, docker, notify: (l) => said.push(l) })).toBe(NEW);
      expect(said).toEqual([BUILDING[name]]);
      expect(calls.map((c) => c.args)).toEqual([["build", "--quiet", "--pull=false", IMAGE_SOURCES[name]]]);
      expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(15 * 60_000);
      expect((await readFile(join(home, name), "utf8")).trim()).toBe(NEW);
      expect((await lstat(join(home, name))).mode & 0o777).toBe(0o600);
    }
  });

  it("rebuilds and re-pins when Docker no longer has the pinned image", async () => {
    const home = await temp();
    await writeFile(join(home, "task-image"), `${OLD}\n`);
    const said: string[] = [];
    const { calls, docker } = fakeDocker((args) => (args[0] === "image" ? { code: 1, stderr: `Error: No such image: ${OLD}` } : args[0] === "build" ? { stdout: NEW } : {}));
    expect(await ensureImage("task-image", { home, docker, notify: (l) => said.push(l) })).toBe(NEW);
    expect(calls.map((c) => c.args[0])).toEqual(["image", "build"]);
    expect(said).toEqual([BUILDING["task-image"]]);
    expect((await readFile(join(home, "task-image"), "utf8")).trim()).toBe(NEW);
  });

  it("rebuilds only on Docker's own \"No such image\": any other failure to check stops, with nothing built or re-pinned", async () => {
    for (const stderr of ["Error: No such image: sha256:aaaa", "Error response from daemon: No such image: sha256:aaaa"]) {
      const home = await temp();
      await writeFile(join(home, "claude-image"), `${OLD}\n`);
      const { calls, docker } = fakeDocker((args) => (args[0] === "image" ? { code: 1, stderr } : { stdout: NEW }));
      expect(await ensureImage("claude-image", { home, docker, notify: () => undefined })).toBe(NEW);
      expect(calls.map((c) => c.args[0])).toEqual(["image", "build"]);
    }
    for (const answer of [{ code: 1, stderr: "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?" }, { code: 1, stderr: "" }, { code: 125, stderr: "permission denied" }, { code: -1, stderr: "" }, { code: 1, stderr: "No such image", cut: true }] as Answer[]) {
      const home = await temp();
      await writeFile(join(home, "task-image"), `${OLD}\n`);
      const said: string[] = [];
      const { calls, docker } = fakeDocker((args) => (args[0] === "image" ? answer : { stdout: NEW }));
      const error = await ensureImage("task-image", { home, docker, notify: (l) => said.push(l) }).catch((e: Error) => e);
      expect((error as Error).message).toBe(INSPECT_FAILED["task-image"]);
      expect((error as Error).message).not.toMatch(/daemon|permission/);
      expect(calls.map((c) => c.args[0])).toEqual(["image"]);
      expect(said).toEqual([]);
      expect((await readFile(join(home, "task-image"), "utf8")).trim()).toBe(OLD);
    }
  });

  it("rebuilds and re-pins on Docker 28.5.1's JSON-wrapped \"No such image\"", async () => {
    const home = await temp();
    await writeFile(join(home, "task-image"), `${OLD}\n`);
    const stderr = `Error response from daemon: {"message":"No such image: ${OLD}"}\n`;
    const { calls, docker } = fakeDocker((args) => (args[0] === "image" ? { code: 1, stderr } : args[0] === "build" ? { stdout: NEW } : {}));
    expect(await ensureImage("task-image", { home, docker, notify: () => undefined })).toBe(NEW);
    expect(calls.map((c) => c.args[0])).toEqual(["image", "build"]);
    expect((await readFile(join(home, "task-image"), "utf8")).trim()).toBe(NEW);
  });

  it("stops on near-misses of the JSON-wrapped form: extra keys, another image, another message, malformed JSON", async () => {
    const other = `sha256:${"d".repeat(64)}`;
    const wrap = (body: string) => `Error response from daemon: ${body}`;
    for (const stderr of [
      wrap(`{"message":"No such image: ${OLD}","extra":1}`),
      wrap(`{"message":"No such image: ${OLD}","message2":"x"}`),
      wrap(`{"message":"No such image: ${other}"}`),
      wrap(`{"message":"No such image: ${OLD}x"}`),
      wrap(`{"message":"No such container: ${OLD}"}`),
      wrap(`{"message":"Cannot connect, no such image: ${OLD}"}`),
      wrap(`{"msg":"No such image: ${OLD}"}`),
      wrap(`{"message":42}`),
      wrap(`{"message":"No such image: ${OLD}"`),
      wrap(`{"message":"No such image: ${OLD}"} trailing`),
      wrap(`["No such image: ${OLD}"]`),
      wrap(`{"message":"No such image: ${OLD}"}\n{"message":"No such image: ${OLD}"}`),
      `Error: {"message":"No such image: ${OLD}"}`,
      `{"message":"No such image: ${OLD}"}`,
    ]) {
      const home = await temp();
      await writeFile(join(home, "task-image"), `${OLD}\n`);
      const { calls, docker } = fakeDocker((args) => (args[0] === "image" ? { code: 1, stderr } : { stdout: NEW }));
      const error = await ensureImage("task-image", { home, docker, notify: () => undefined }).catch((e: Error) => e);
      expect((error as Error).message, stderr).toBe(INSPECT_FAILED["task-image"]);
      expect(calls.map((c) => c.args[0])).toEqual(["image"]);
      expect((await readFile(join(home, "task-image"), "utf8")).trim()).toBe(OLD);
    }
  });

  it("stops with a fixed message when a build fails, says nothing of Docker's output, and pins nothing", async () => {
    for (const answer of [{ code: 1, stderr: "secret-ish build output" }, { stdout: "not an id" }, { stdout: NEW, cut: true }, { code: 0, stdout: "" }] as Answer[]) {
      const home = await temp();
      const { docker } = fakeDocker((args) => (args[0] === "build" ? answer : {}));
      const error = await ensureImage("claude-image", { home, docker, notify: () => undefined }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(BUILD_FAILED["claude-image"]);
      expect((error as Error).message).not.toMatch(/secret-ish|not an id/);
      expect(existsSync(join(home, "claude-image"))).toBe(false);
    }
  });

  it("refuses a pin it can't read as an image ID, or one that's a link, without building", async () => {
    const home = await temp();
    await writeFile(join(home, "task-image"), "node:22-bookworm-slim\n");
    const { calls, docker } = fakeDocker();
    await expect(ensureImage("task-image", { home, docker, notify: () => undefined })).rejects.toThrow(/isn't pinned/);
    const other = await temp();
    await writeFile(join(other, "elsewhere"), OLD);
    await symlink(join(other, "elsewhere"), join(other, "task-image"));
    await expect(ensureImage("task-image", { home: other, docker, notify: () => undefined })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("claudeEngine with no images pinned", () => {
  async function setup() {
    const home = await temp();
    await chmod(home, 0o700);
    const keyFile = join(home, "fake.key");
    await writeFile(keyFile, KEY, { mode: 0o600 });
    return { home, keyFile };
  }

  it("builds all three from the package, saying so before each, then builds the engine", async () => {
    const { claudeEngine } = await import("../src/node/claude-engine.js");
    const { home, keyFile } = await setup();
    const said: string[] = [];
    const built = (folder: string) => (folder === IMAGE_SOURCES["task-image"] ? NEW : folder === IMAGE_SOURCES["claude-image"] ? NEW_CLAUDE : NEW_PROXY);
    const { calls, docker } = fakeDocker((args) => (args[0] === "build" ? { stdout: built(args[3]) } : args[0] === "ps" ? { stdout: "" } : {}));
    const engine = await claudeEngine({ home, key_file: keyFile, log: () => undefined, notify: (l) => said.push(l), docker, dockerProgram: "/usr/local/bin/docker", env: {}, execArgv: [], platform: "darwin" });
    expect(Object.keys(engine.drivers)).toEqual(["claude_agent_sdk"]);
    expect(said).toEqual([BUILDING["task-image"], BUILDING["claude-image"], BUILDING["proxy-image"]]);
    expect(calls.filter((c) => c.args[0] === "build").map((c) => c.args[3])).toEqual([IMAGE_SOURCES["task-image"], IMAGE_SOURCES["claude-image"], IMAGE_SOURCES["proxy-image"]]);
    expect((await readFile(join(home, "task-image"), "utf8")).trim()).toBe(NEW);
    expect((await readFile(join(home, "claude-image"), "utf8")).trim()).toBe(NEW_CLAUDE);
    expect((await readFile(join(home, "proxy-image"), "utf8")).trim()).toBe(NEW_PROXY);
  });

  it("stops on a failed build with the fixed message, before anything runs", async () => {
    const { claudeEngine } = await import("../src/node/claude-engine.js");
    const { home, keyFile } = await setup();
    const { calls, docker } = fakeDocker((args) => (args[0] === "build" ? { code: 1 } : {}));
    await expect(claudeEngine({ home, key_file: keyFile, log: () => undefined, notify: () => undefined, docker, dockerProgram: "/usr/local/bin/docker", env: {}, execArgv: [], platform: "darwin" })).rejects.toThrow(BUILD_FAILED["task-image"]);
    expect(calls.map((c) => c.args[0])).toEqual(["build"]);
  });
});
