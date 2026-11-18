// What Runner does on the owner's machine: the OS keychain (through a stand-in for its tool), the record on disk, the
// environment a program it starts gets, and checks of Runner's own source.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NEVER, RUNNER_CAPABILITIES } from "../src/core/capabilities.js";
import { emptyState } from "../src/core/state.js";
import { childEnv, forbidden, INHERITED } from "../src/node/child-env.js";
import { FileStateStore } from "../src/node/file-state.js";
import { accountFor, MacKeychain, SecretServiceKeychain, SERVICE, systemKeychain, type Runner } from "../src/node/keychain.js";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, repo), "utf8");

/** A stand-in for the keychain tool: items by account, and every call it got. */
function fakeTool(platform: "mac" | "linux") {
  const items = new Map<string, string>();
  const calls: { file: string; args: string[]; input: string; env: Record<string, string> }[] = [];
  const runner: Runner = async (file, args, input, env) => {
    calls.push({ file, args, input, env });
    if (platform === "mac") {
      if (args[0] === "-i") {
        const parts = input.trim().split(" ");
        items.set(parts[parts.indexOf("-a") + 1], parts[parts.indexOf("-w") + 1]);
        return { code: 0, stdout: "" };
      }
      const account = args[args.indexOf("-a") + 1];
      if (args[0] === "find-generic-password") return items.has(account) ? { code: 0, stdout: `${items.get(account)}\n` } : { code: 44, stdout: "" };
      if (args[0] === "delete-generic-password") return items.delete(account) ? { code: 0, stdout: "" } : { code: 44, stdout: "" };
    } else {
      const account = args[args.indexOf("account") + 1];
      if (args[0] === "store") items.set(account, input);
      if (args[0] === "lookup") return items.has(account) ? { code: 0, stdout: items.get(account) as string } : { code: 1, stdout: "" };
      if (args[0] === "clear") items.delete(account);
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return { items, calls, runner };
}

describe("the OS keychain", () => {
  const secret = JSON.stringify({ keypair: { privateKey: { d: "private-part-of-the-key" } } });

  it("on macOS, stores through the fixed tool with the secret on standard input, never in an argument", async () => {
    const { calls, runner } = fakeTool("mac");
    const keychain = new MacKeychain("/home/owner/.podster-runner", runner, childEnv({}, { PATH: "/usr/bin", HOME: "/home/owner", ANTHROPIC_API_KEY: "sk-x" }));
    await keychain.set("host", secret);
    expect(await keychain.get("host")).toBe(secret);
    await keychain.delete("host");
    expect(await keychain.get("host")).toBeNull();
    for (const call of calls) {
      expect(call.file).toBe("/usr/bin/security");
      expect(call.args.join(" ")).not.toContain("private-part");
      expect(call.args.join(" ")).not.toContain(Buffer.from(secret).toString("hex"));
      expect(Object.keys(call.env).every((name) => (INHERITED as readonly string[]).includes(name))).toBe(true);
    }
    expect(calls[0].input).toContain(`-s ${SERVICE}`);
    expect(calls[0].input).not.toContain("private-part");
  });

  it("on macOS, refuses when what was stored doesn't read back", async () => {
    const runner: Runner = async (_file, args) => (args[0] === "-i" ? { code: 0, stdout: "" } : { code: 44, stdout: "" });
    await expect(new MacKeychain("/h", runner).set("host", "x")).rejects.toThrow(/couldn't store/);
    const locked: Runner = async () => ({ code: 51, stdout: "" });
    await expect(new MacKeychain("/h", locked).get("host")).rejects.toThrow(/couldn't be read/);
  });

  it("on Linux, stores through secret-tool with the secret on standard input, and passes on only the session's bus", async () => {
    const { calls, runner } = fakeTool("linux");
    const keychain = new SecretServiceKeychain("/home/owner/.podster-runner", runner, { PATH: "/usr/bin", HOME: "/home/owner", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", GITHUB_TOKEN: "ghp_x" });
    await keychain.set("agent:plg_1", secret);
    expect(await keychain.get("agent:plg_1")).toBe(secret);
    expect(await keychain.get("host")).toBeNull();
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain("private-part");
      expect(call.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(call.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1/bus");
    }
  });

  it("keeps two Runner homes apart, and refuses names it doesn't use", () => {
    expect(accountFor("/a", "host")).not.toBe(accountFor("/b", "host"));
    expect(() => accountFor("/a", "host; rm -rf /")).toThrow();
  });

  it("has no supported store on other systems, and Runner refuses rather than using a file", () => {
    expect(() => systemKeychain("/h", "win32")).toThrow(/no supported keychain/);
  });
});

describe("the record on disk", () => {
  let home: string;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("is written whole into an owner-only folder, readable by the owner only, and read back", async () => {
    home = join(await mkdtemp(join(tmpdir(), "runner-state-")), "home");
    const store = new FileStateStore(home);
    expect(await store.load()).toEqual(emptyState());
    await store.save({ ...emptyState(), agent_id: "agt_1", inbox_cursor: 7 });
    expect((await store.load()).inbox_cursor).toBe(7);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "state.json"))).mode & 0o777).toBe(0o600);
    // No temporary file is left behind.
    expect(await readdir(home)).toEqual(["state.json"]);
  });

  it("never starts over from a record it can't read", async () => {
    home = await mkdtemp(join(tmpdir(), "runner-state-"));
    await writeFile(join(home, "state.json"), "{ not json");
    await expect(new FileStateStore(home).load()).rejects.toThrow(/can't be read/);
    await writeFile(join(home, "state.json"), JSON.stringify({ version: 2 }));
    await expect(new FileStateStore(home).load()).rejects.toThrow(/isn't one/);
  });
});

describe("the environment of a program Runner starts", () => {
  it("is the allow-listed one, by the same rule as e2e/child-env.mjs", async () => {
    const shared = (await import(new URL("e2e/child-env.mjs", repo).href)) as { forbidden(name: string): boolean; childEnv(own?: Record<string, string>, from?: Record<string, string>): Record<string, string> };
    const from = { PATH: "/usr/bin", HOME: "/h", LANG: "C", AWS_SECRET_ACCESS_KEY: "x", PODSTER_E2E_TOKEN: "x", ANTHROPIC_API_KEY: "x", SHELL: "/bin/zsh" };
    expect(childEnv({}, from)).toEqual(shared.childEnv({}, from));
    for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "PODSTER_E2E_X", "CLOUDFLARE_API_TOKEN", "DB_PASSWORD"]) {
      expect([name, forbidden(name)]).toEqual([name, true]);
      if (shared.forbidden(name)) expect(() => childEnv({ [name]: "x" })).toThrow();
    }
  });
});

describe("Runner's own source", () => {
  const sources = async () => {
    const root = new URL("apps/runner/src/", repo);
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
    return Promise.all(files.map(async (f) => ({ file: f, text: await readFile(new URL(f, root), "utf8") })));
  };

  it("never calls the SDK's disconnect or rotate methods", async () => {
    for (const { file, text } of await sources()) expect([file, /\.(disconnectAgent|rotateAgentKey|rotateHostKey|reactivateAgent|claimAgent)\s*\(/.test(text)]).toEqual([file, false]);
  });

  it("never reaches the Rust API, and opens no listening port", async () => {
    for (const { file, text } of await sources()) {
      expect([file, /api\.internal|x-podster-assertion|\/v1\//.test(text)]).toEqual([file, false]);
      expect([file, /createServer|\.listen\(|node:net|node:dgram|node:http\b|node:https\b/.test(text)]).toEqual([file, false]);
    }
  });

  it("never takes a code as an argument on the command line", async () => {
    const cli = await readFile(new URL("apps/runner/src/node/cli.ts", repo), "utf8");
    expect(cli).not.toMatch(/option\(args, "code"\)/);
    expect(cli).toMatch(/input\.question\("Paste the code/);
  });

  it("names only capabilities inside the gateway's RUNNER_CAPABILITIES, and none it must never hold", async () => {
    const gateway = await read("apps/gateway/src/pairing.ts");
    const list = /export const RUNNER_CAPABILITIES = \[([^\]]*)\]/.exec(gateway)?.[1];
    expect(list).toBeTruthy();
    const allowed = [...(list as string).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(allowed.length).toBeGreaterThan(5);
    for (const capability of RUNNER_CAPABILITIES) expect([capability, allowed.includes(capability)]).toEqual([capability, true]);
    for (const never of NEVER) expect(RUNNER_CAPABILITIES as readonly string[]).not.toContain(never);
  });

  it("has a CI job that typechecks, tests and builds it, and never publishes, installs or deploys it", async () => {
    const ci = await read(".github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  runner:"), ci.indexOf("\n  e2e:"));
    expect(job).toContain("working-directory: apps/runner");
    expect([...job.matchAll(/- run: (.+)/g)].map((match) => match[1])).toEqual(["npm ci --ignore-scripts", "npm run typecheck", "npm test", "npm run build"]);
    expect(job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")).not.toMatch(/deploy|wrangler|publish|secrets\./);
    // merge-gate requires every job ci.yml has, this one included.
    expect(await read("scripts/merge-gate")).toMatch(/^CI_JOBS=".* runner .*"$/m);
  });

  it("pins the Agent Auth client exactly at 0.6.2, in the manifest and the lockfile", async () => {
    const manifest = JSON.parse(await read("apps/runner/package.json"));
    expect(manifest.dependencies["@auth/agent"]).toBe("0.6.2");
    const lock = JSON.parse(await read("apps/runner/package-lock.json"));
    expect(lock.packages["node_modules/@auth/agent"].version).toBe("0.6.2");
  });
});
