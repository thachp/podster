// What Runner does on the owner's machine: the OS keychain (through a stand-in for its tool), the record on disk, the
// environment a program it starts gets, and checks of Runner's own source.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeypair } from "@auth/agent";
import { afterEach, describe, expect, it } from "vitest";
import { NEVER, RUNNER_CAPABILITIES } from "../src/core/capabilities.js";
import { checkNudgeUrl, MAX_NUDGE_URL_BYTES } from "../src/core/nudge.js";
import { emptyState } from "../src/core/state.js";
import { childEnv, forbidden, INHERITED } from "../src/node/child-env.js";
import { FileStateStore } from "../src/node/file-state.js";
import { RunnerStorage } from "../src/core/storage.js";
import { accountFor, MAC_LINE_LIMIT, MacKeychain, MAX_OUTPUT_BYTES, run, SecretServiceKeychain, SERVICE, systemKeychain, type Runner } from "../src/node/keychain.js";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, repo), "utf8");

/** What `security -i` does with a line longer than this: it cuts it, and stores what's left (H1 on #454). */
const TOOL_LINE_BYTES = 4096;

/** A stand-in for the keychain tool: items by account, every call it got, and the macOS tool's cut of long lines. */
function fakeTool(platform: "mac" | "linux") {
  const items = new Map<string, string>();
  const calls: { file: string; args: string[]; input: string; env: Record<string, string> }[] = [];
  /** For Linux: what the Secret Service answers instead, as a locked collection or a missing bus would. */
  let failure: { code: number; stderr: string } | null = null;
  const runner: Runner = async (file, args, input, env) => {
    calls.push({ file, args, input, env });
    if (platform === "mac") {
      if (args[0] === "-i") {
        const line = Buffer.from(input.split("\n")[0]).subarray(0, TOOL_LINE_BYTES - 1).toString();
        const parts = line.trim().split(" ");
        items.set(parts[parts.indexOf("-a") + 1], parts[parts.indexOf("-w") + 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      const account = args[args.indexOf("-a") + 1];
      if (args[0] === "find-generic-password") return items.has(account) ? { code: 0, stdout: `${items.get(account)}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." };
      if (args[0] === "delete-generic-password") return items.delete(account) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    } else {
      if (failure) return { code: failure.code, stdout: "", stderr: failure.stderr };
      const account = args[args.indexOf("account") + 1];
      if (args[0] === "store") items.set(account, input);
      if (args[0] === "lookup") return items.has(account) ? { code: 0, stdout: items.get(account) as string, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      if (args[0] === "clear") items.delete(account);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  return { items, calls, runner, fail: (code: number, stderr: string) => void (failure = { code, stderr }) };
}

/** An agent connection of the real size Runner now stores, with every Runner capability granted. */
async function realSizeConnection() {
  return { agentId: "plg_0123456789abcdef0123456789abcdef", hostId: "host_0123456789abcdef0123456789abcdef", providerName: "podster", issuer: "https://podster.dev/api/auth", mode: "delegated" as const, agentKeypair: await generateKeypair(), capabilityGrants: RUNNER_CAPABILITIES.map((capability) => ({ capability, status: "active" as const })), createdAt: 1_800_000_000_000 };
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

  it("on macOS, refuses a value whose command line would come near the tool's cut, before writing anything (H1)", async () => {
    const { calls, items, runner } = fakeTool("mac");
    const keychain = new MacKeychain("/home/owner/.podster-runner", runner);
    // Under the limit, the cut never reaches it: what's stored reads back whole.
    const fits = "x".repeat(Math.floor((MAC_LINE_LIMIT - 200) / 2));
    await keychain.set("host", fits);
    expect(await keychain.get("host")).toBe(fits);
    const before = calls.length;
    for (const size of [Math.ceil(MAC_LINE_LIMIT / 2), 14_000]) {
      await expect(keychain.set("agent:plg_1", "y".repeat(size))).rejects.toThrow(/too large/);
    }
    expect(calls.length).toBe(before);
    expect([...items.keys()].some((account) => account.endsWith(":agent:plg_1"))).toBe(false);
    expect(MAC_LINE_LIMIT).toBeLessThanOrEqual(TOOL_LINE_BYTES - 256);
  });

  it("on macOS, stores a real agent connection whole: the slim one fits under the line limit", async () => {
    const { runner } = fakeTool("mac");
    const storage = new RunnerStorage(new MacKeychain("/home/owner/.podster-runner", runner));
    const connection = await realSizeConnection();
    await storage.setAgentConnection(connection.agentId, connection);
    expect(await storage.getAgentConnection(connection.agentId)).toEqual(connection);
  });

  it("on macOS, refuses when what was stored doesn't read back, and a read that fails isn't 'no key'", async () => {
    const runner: Runner = async (_file, args) => (args[0] === "-i" ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" });
    await expect(new MacKeychain("/h", runner).set("host", "x")).rejects.toThrow(/couldn't store/);
    const locked: Runner = async () => ({ code: 51, stdout: "", stderr: "" });
    await expect(new MacKeychain("/h", locked).get("host")).rejects.toThrow(/couldn't be read/);
  });

  it("names a test keychain file only when asked, and the production default names none", async () => {
    const { calls, runner } = fakeTool("mac");
    await new MacKeychain("/h", runner).get("host");
    await new MacKeychain("/h", runner, childEnv(), { keychain: "/tmp/runner-test/throwaway.keychain-db" }).get("host");
    expect(calls[0].args.at(-1)).toBe("-w");
    expect(calls[1].args.at(-1)).toBe("/tmp/runner-test/throwaway.keychain-db");
    expect(() => new MacKeychain("/h", runner, childEnv(), { keychain: "/tmp/has space/x.keychain-db" })).toThrow();
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

  it("on Linux, a locked collection or a missing session bus is an error, never 'no key' (L2)", async () => {
    for (const [code, stderr] of [[1, "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY"], [1, "secret-tool: Cannot create an item in a locked collection"], [1, "secret-tool: The name org.freedesktop.secrets was not provided by any .service files"], [2, ""]] as const) {
      const { runner, fail } = fakeTool("linux");
      fail(code, stderr);
      const keychain = new SecretServiceKeychain("/h", runner, {});
      await expect(keychain.get("host")).rejects.toThrow(/couldn't be read/);
      await expect(keychain.delete("host")).rejects.toThrow(/couldn't delete/);
    }
    // And a pairing whose key can't be read stops with that error: it isn't retired as if the key were gone.
    const { runner, fail } = fakeTool("linux");
    const storage = new RunnerStorage(new SecretServiceKeychain("/h", runner, {}));
    fail(1, "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY");
    await expect(storage.getHostIdentity()).rejects.toThrow(/couldn't be read/);
  });

  it("fails clearly, rather than answering cut-off output, when a tool prints more than its limit", async () => {
    const script = join(await mkdtemp(join(tmpdir(), "runner-tool-")), "loud.sh");
    await writeFile(script, `#!/bin/sh\nhead -c ${MAX_OUTPUT_BYTES + 10} /dev/zero | tr '\\0' 'a'\n`, { mode: 0o755 });
    await expect(run(script, [], "", childEnv())).rejects.toThrow(/more output/);
    const quiet = join(dirname(script), "quiet.sh");
    await writeFile(quiet, "#!/bin/sh\nprintf ok; printf err >&2; exit 3\n", { mode: 0o755 });
    expect(await run(quiet, [], "", childEnv())).toEqual({ code: 3, stdout: "ok", stderr: "err" });
    await rm(dirname(script), { recursive: true, force: true });
  });

  it("keeps two Runner homes apart, and refuses names it doesn't use", () => {
    expect(accountFor("/a", "host")).not.toBe(accountFor("/b", "host"));
    expect(() => accountFor("/a", "host; rm -rf /")).toThrow();
  });

  it("has no supported store on other systems, and Runner refuses rather than using a file", () => {
    expect(() => systemKeychain("/h", "win32")).toThrow(/no supported keychain/);
  });

  // Only by hand, on a Mac, with a throwaway keychain FILE the caller made and will delete: never the login keychain.
  // RUNNER_TEST_KEYCHAIN=<path to that file> npx vitest run -t "a real macOS keychain file"
  it.runIf(process.platform === "darwin" && !!process.env.RUNNER_TEST_KEYCHAIN)("stores, reads back and deletes a real-size agent connection in a real macOS keychain file", async () => {
    const keychain = process.env.RUNNER_TEST_KEYCHAIN as string;
    expect(keychain).not.toMatch(/login\.keychain/);
    const storage = new RunnerStorage(new MacKeychain(join(dirname(keychain), "home"), run, childEnv(), { keychain }));
    const connection = await realSizeConnection();
    await storage.setAgentConnection(connection.agentId, connection);
    expect(await storage.getAgentConnection(connection.agentId)).toEqual(connection);
    await storage.deleteAll();
    expect(await storage.getAgentConnection(connection.agentId)).toBeNull();
    expect(await storage.listAgentConnections()).toEqual([]);
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

/** The two files step 9(b)'s scoped source-test exceptions name, and no others. */
const LISTENER_FILE = "node/broker-listener.ts";
/** Step 14's scoped exception: the inbound nudge's loopback listener. */
const NUDGE_LISTENER_FILE = "node/nudge-listener.ts";
const PROFILE_FILE = "core/claude-profile.ts";
/** The egress proxy's program: run only inside its own container per run, never in Runner's process. */
const EGRESS_PROXY_FILE = "node/egress-proxy.ts";

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
      expect([file, /api\.internal|x-podster-assertion/.test(text)]).toEqual([file, false]);
      // Scoped exception (2), step 9(b): `/v1/` only as the exact literal "/v1/messages", only in the Claude driver's
      // profile file. Everything else is held to the old rule.
      const v1 = file === PROFILE_FILE ? text.replaceAll('"/v1/messages"', "") : text;
      expect([file, /\/v1\//.test(v1)]).toEqual([file, false]);
      // Scoped exception (1), step 9(b): only the broker listener may use node:http and `.listen(` (with node:http's
      // createServer); node:net, node:dgram and node:https stay banned there too.
      // Scoped exception (3), step 14: the nudge listener, under the same rule as the broker listener.
      // Scoped exception (4), the egress proxy (the owner's approval of 2026-11-20): node:net's server, in the proxy's
      // own file only, which Runner never runs itself: it is handed as text to `node` in the proxy's container.
      const listening =
        file === LISTENER_FILE || file === NUDGE_LISTENER_FILE
          ? text.replace(/\bcreateServer\b|\.listen\(|node:http\b(?!s)/g, "")
          : file === EGRESS_PROXY_FILE
            ? text.replace(/\bcreateServer\b|\.listen\(|node:net\b/g, "")
            : text;
      expect([file, /createServer|\.listen\(|node:net|node:dgram|node:http\b|node:https\b/.test(listening)]).toEqual([file, false]);
    }
  });

  it("lets the egress proxy listen only in its container, on its own address in the run's internal subnet, and Runner never start it (scoped exception 4)", async () => {
    const text = await readFile(new URL(`apps/runner/src/${EGRESS_PROXY_FILE}`, repo), "utf8");
    expect([...text.matchAll(/\.listen\(/g)].length).toBe(1);
    expect(text).toContain("server.listen(PROXY_PORT, address, () => write({ e: \"ready\" }));");
    expect(text).toContain('const address = addressIn(subnet ?? "", networkInterfaces());');
    expect(text).not.toMatch(/localhost|listen\(\s*PROXY_PORT\s*\)|"::"/);
    expect(text).not.toMatch(/node:http|node:https|node:dgram|node:child_process|node:fs/);
    // Nothing of Runner's own calls the server or the entry: only its pure checks are imported.
    for (const { file, text: other } of await sources()) {
      if (file === EGRESS_PROXY_FILE) continue;
      expect([file, /\bcreateEgressProxy\b/.test(other)]).toEqual([file, false]);
      const imported = [...other.matchAll(/import \{([^}]*)\} from "\.\/egress-proxy\.js"/g)].flatMap((m) => m[1].split(",").map((n) => n.trim().replace(/^type /, "")));
      for (const name of imported) expect([file, name, ["isHostName", "PROXY_REFUSALS", "ProxyRefusal"].includes(name)]).toEqual([file, name, true]);
    }
  });

  it("lets the broker listener listen only on the literal loopback address, or the run's own Unix socket (scoped exception 1; S-47)", async () => {
    const text = await readFile(new URL(`apps/runner/src/${LISTENER_FILE}`, repo), "utf8");
    // Exactly two calls: TCP on the literal loopback (macOS), or a Unix socket readable and writable by no one else (Linux).
    expect([...text.matchAll(/\.listen\(/g)].length).toBe(2);
    expect(text).toContain('server.listen(0, "127.0.0.1", () => resolve());');
    expect(text).toContain("server.listen({ path: deps.socket, readableAll: false, writableAll: false }, () => resolve());");
    expect(text).not.toMatch(/0\.0\.0\.0|::|localhost/);
  });

  it("lets the nudge listener listen only on the literal loopback address, at the owner's port (scoped exception 3; S-13)", async () => {
    const text = await readFile(new URL(`apps/runner/src/${NUDGE_LISTENER_FILE}`, repo), "utf8");
    expect([...text.matchAll(/\.listen\(/g)].length).toBe(1);
    expect(text).toContain('server.listen(deps.port, "127.0.0.1", () => resolve());');
    expect(text).not.toMatch(/0\.0\.0\.0|::|localhost|node:https|node:net/);
    // Only `run` with the owner's two options starts it.
    for (const { file, text: other } of await sources()) expect([file, /startNudgeListener\(/.test(other)]).toEqual([file, file === NUDGE_LISTENER_FILE || file === "node/nudge-command.ts"]);
    const cli = await readFile(new URL("apps/runner/src/node/cli.ts", repo), "utf8");
    expect(cli).toMatch(/nudging === null \? null : \(bell, ended\) => openNudge\(\{[^\n]*signal: AbortSignal\.any\(\[stop\.signal, ended\]\)/);
  });

  it("leaves the listener's `onServer` hook to tests: no source file passes it (delta review 3)", async () => {
    for (const { file, text } of await sources()) expect([file, /\bonServer\b/.test(text)]).toEqual([file, file === NUDGE_LISTENER_FILE]);
  });

  it("names the endpoint calls only where the nudge registers, and closes the listener when run stops (step 14)", async () => {
    for (const { file, text } of await sources()) {
      const named = /["'](set_a2a_endpoint|verify_a2a_endpoint)["']/.test(text);
      expect([file, named]).toEqual([file, file === "core/capabilities.ts" || file === "core/nudge.ts"]);
    }
    const nudge = await readFile(new URL("apps/runner/src/core/nudge.ts", repo), "utf8");
    // Only ever a nudge endpoint: no call sends `offers`, which would carry task text to the machine.
    expect(nudge).not.toMatch(/delivery: "offers"/);
    expect([...nudge.matchAll(/delivery: "nudge"/g)].length).toBe(2);
    const cli = await readFile(new URL("apps/runner/src/node/cli.ts", repo), "utf8");
    const run = cli.slice(cli.indexOf('if (command === "run")'));
    // The loop's own end aborts the run's signal, which closes the listener; alongsidePolling closes what setup opened.
    expect(run).toMatch(/return await runInbox\([^\n]*\n\s*\} finally \{\n(\s*\/\/[^\n]*\n)*\s*stop\.abort\(\);/);
    const command = await readFile(new URL("apps/runner/src/node/nudge-command.ts", repo), "utf8");
    // The loop's end closes setup's listener at once, without waiting for setup (delta review 1).
    expect(command).toMatch(/\} finally \{\n\s*ended\.abort\(\);\n\s*\}/);
  });

  it("pins the profile file's one versioned path to api.anthropic.com, with no beta header (scoped exception 2)", async () => {
    const text = await readFile(new URL(`apps/runner/src/${PROFILE_FILE}`, repo), "utf8");
    expect(text.match(/\/v1\/[^"]*/g)).toEqual(["/v1/messages"]);
    expect(text).toMatch(/host: "api\.anthropic\.com",/);
    expect(text).not.toMatch(/anthropic-beta|beta=/i);
    const { CLAUDE_PROFILE } = await import("../src/core/claude-profile.js");
    expect(CLAUDE_PROFILE.host).toBe("api.anthropic.com");
    expect(CLAUDE_PROFILE.path).toBe("/v1/messages");
    expect(Object.keys(CLAUDE_PROFILE.headers).map((h) => h.toLowerCase())).not.toContain("anthropic-beta");
  });

  it("takes the home's lock for pair, run and forget, before anything else they do (decision 227)", async () => {
    const cli = await readFile(new URL("apps/runner/src/node/cli.ts", repo), "utf8");
    const main = cli.slice(cli.indexOf("async function main("), cli.indexOf("async function locked("));
    expect(main).toMatch(/command !== "pair" && command !== "run" && command !== "forget"/);
    expect(main.indexOf("acquireLock(home, { command })")).toBeGreaterThan(-1);
    expect(main.indexOf("acquireLock(home, { command })")).toBeLessThan(main.indexOf("locked(command"));
    // Every command that touches keys or the records is inside `locked`, after the lock.
    const after = cli.slice(cli.indexOf("async function locked("));
    for (const command of ["forget", "pair", "run"]) expect(after).toContain(`command === "${command}"`);
    expect(main).not.toMatch(/command === "(forget|pair|run)"/);
  });

  it("keeps every file in src/core free of the machine, so it runs as tested against the real gateway (Standards Low 1 on #458)", async () => {
    const root = new URL("apps/runner/src/core/", repo);
    const files = (await readdir(root)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    const machine = ["fs", "os", "child_process", "net", "path", "http", "https", "dgram", "worker_threads", "process", "crypto", "tls", "dns", "readline", "stream", "url", "util", "vm", "cluster"];
    for (const file of files) {
      const text = await readFile(new URL(file, root), "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const found = [
        /from\s+["']node:/.test(code),
        /\brequire\s*\(/.test(code),
        /\bimport\s*\(/.test(code),
        new RegExp(`(from|import)\\s+["'](${machine.join("|")})(/[^"']*)?["']`).test(code),
        /\bprocess\.(env|exit|kill|argv|stdin|stdout)/.test(code),
      ];
      expect([file, found]).toEqual([file, [false, false, false, false, false]]);
    }
  });

  it("never takes a code as an argument on the command line", async () => {
    const cli = await readFile(new URL("apps/runner/src/node/cli.ts", repo), "utf8");
    expect(cli).not.toMatch(/option\(args, "code"\)/);
    // At a terminal, without echo (L5 on #454).
    expect(cli).toMatch(/readHidden\(prompt, process\.stdin/);
  });

  it("asks for `get_repo_access` only in the repository path, and never names a merge or a release (decision 230, step 10)", async () => {
    for (const { file, text } of await sources()) {
      const calls = /["']get_repo_access["']/.test(text);
      expect([file, calls]).toEqual([file, file === "core/capabilities.ts" || file === "node/repo-path.ts"]);
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const merges = /["'](merge_task|deploy_release)["']|\/merges?\b|\/merge["'`]/.test(code);
      expect([file, merges]).toEqual([file, file === "core/capabilities.ts"]);
      // GitHub's hosts are named in one place, where the fixed requests are built.
      expect([file, /github\.com/.test(code)]).toEqual([file, file === "core/repository.ts"]);
    }
  });

  it("leaves room in the macOS keychain line for Runner's agent with its capability list, measured again at step 14 (#454 re-review)", async () => {
    // The longest real values: Better Auth's 32-character IDs, staging's issuer, and every capability active.
    const items = new Map<string, string>();
    const lines: string[] = [];
    const runner: Runner = async (_file, args, input) => {
      if (args[0] === "-i") {
        lines.push(input);
        const parts = input.trim().split(" ");
        items.set(parts[parts.indexOf("-a") + 1], parts[parts.indexOf("-w") + 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      const account = args[args.indexOf("-a") + 1];
      return items.has(account) ? { code: 0, stdout: `${items.get(account)}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "" };
    };
    const storage = new RunnerStorage(new MacKeychain("/Users/someone-with-a-long-name/Library/Application-Support/podster-runner", runner));
    const id = "A".repeat(32);
    const grants = RUNNER_CAPABILITIES.map((capability) => ({ capability, status: "active" as const }));
    await storage.setAgentConnection(id, { agentId: id, hostId: "B".repeat(32), providerName: "podster", issuer: "https://gateway-staging.podster.dev/api/auth", mode: "delegated", agentKeypair: await generateKeypair(), capabilityGrants: grants, createdAt: 1_800_000_000_000 });
    const line = Buffer.byteLength(lines.at(-1) as string);
    expect(RUNNER_CAPABILITIES).toContain("get_repo_access");
    expect(line).toBeLessThan(MAC_LINE_LIMIT);
    // Measured 2026-11-18 with 18 capabilities and a long home: 3,029 of 3,584 bytes. Measured again 2026-11-19 for step
    // 11, which submits with `submit_task` and posts its one progress message with `send_message`, both already listed, so
    // still 18 capabilities and 3,029 bytes. Each more capability as long as `get_repo_access` costs its grant's JSON
    // twice over (hex): 104 bytes, so about 5 more fit; shorter names fit more. Measured again 2026-11-19 for step 14,
    // which adds `set_a2a_endpoint` and `verify_a2a_endpoint`: 20 capabilities, 3,243 of 3,584 bytes, 341 left, so 3 more
    // as long as `get_repo_access` fit.
    expect(RUNNER_CAPABILITIES).toHaveLength(20);
    expect(RUNNER_CAPABILITIES).toEqual(expect.arrayContaining(["submit_task", "send_message", "set_a2a_endpoint", "verify_a2a_endpoint"]));
    const perCapability = 2 * Buffer.byteLength(`${JSON.stringify({ capability: "get_repo_access", status: "active" })},`);
    expect(line).toBe(3_243);
    expect(Math.floor((MAC_LINE_LIMIT - line) / perCapability)).toBe(3);
  });

  it("leaves room in the macOS keychain line for the nudge's registration at its longest URL (step 14)", async () => {
    const items = new Map<string, string>();
    const lines: string[] = [];
    const runner: Runner = async (_file, args, input) => {
      if (args[0] === "-i") {
        lines.push(input);
        const parts = input.trim().split(" ");
        items.set(parts[parts.indexOf("-a") + 1], parts[parts.indexOf("-w") + 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      const account = args[args.indexOf("-a") + 1];
      return items.has(account) ? { code: 0, stdout: `${items.get(account)}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "" };
    };
    const storage = new RunnerStorage(new MacKeychain("/Users/someone-with-a-long-name/Library/Application-Support/podster-runner", runner));
    // The API's secret is `a2asec_` and two simple UUIDs; the agent ID is Better Auth's longest.
    const url = `https://runner.example.com/${"a".repeat(MAX_NUDGE_URL_BYTES - "https://runner.example.com/".length)}`;
    expect(checkNudgeUrl(url)).toBe(url);
    await storage.setNudge({ url, agent_id: `agt_${"A".repeat(32)}`, version: 2 ** 31, secret: `a2asec_${"f".repeat(64)}` });
    const line = Buffer.byteLength(lines.at(-1) as string);
    // Measured 2026-11-19: 2,452 of 3,584 bytes.
    expect(line).toBe(2_452);
    expect(line).toBeLessThan(MAC_LINE_LIMIT);
  });

  it("names only capabilities inside the gateway's RUNNER_CAPABILITIES, and none it must never hold", async () => {
    const gateway = await read("apps/gateway/src/pairing.ts");
    const list = /export const RUNNER_CAPABILITIES = \[([^\]]*)\]/.exec(gateway)?.[1];
    expect(list).toBeTruthy();
    const allowed = [...(list as string).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(allowed.length).toBeGreaterThan(5);
    for (const capability of RUNNER_CAPABILITIES) expect([capability, allowed.includes(capability)]).toEqual([capability, true]);
    for (const never of NEVER) expect(RUNNER_CAPABILITIES as readonly string[]).not.toContain(never);
  });

  it("has a CI job that typechecks, tests and builds it, and never publishes, installs or deploys it", async () => {
    const ci = await read(".github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  runner:"), ci.indexOf("\n  e2e:"));
    expect(job).toContain("working-directory: apps/runner");
    expect([...job.matchAll(/- run: (.+)/g)].map((match) => match[1])).toEqual([
      "npm ci --ignore-scripts",
      "npm run typecheck",
      "npm test",
      "npm run build",
      // S-47's Linux Docker proof: on this runner's Docker, gated on all three of its tests having run and passed.
      "docker version --format '{{.Server.Version}}'",
      'npx vitest run --config vitest.linux.config.ts --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/linux-docker.json"',
      "|",
    ]);
    expect(job).toContain('RUNNER_LINUX_DOCKER: "1"');
    expect(job).toMatch(/r\.numPassedTests === 11 && r\.numFailedTests === 0 && r\.numPendingTests === 0/);
    expect(job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")).not.toMatch(/deploy|wrangler|publish|secrets\./);
    // merge-gate requires every job ci.yml has, this one included.
    expect(await read("scripts/merge-gate")).toMatch(/^CI_JOBS=".* runner .*"$/m);
  });

  it("pins the same Agent Auth client as the gateway, in both manifests and both lockfiles (Standards Low 2 on #454)", async () => {
    const runner = JSON.parse(await read("apps/runner/package.json")).dependencies["@auth/agent"];
    const gateway = JSON.parse(await read("apps/gateway/package.json")).devDependencies["@auth/agent"];
    expect(gateway).toBe(runner);
    const locked = async (app: string) => JSON.parse(await read(`apps/${app}/package-lock.json`)).packages["node_modules/@auth/agent"].version;
    expect(await locked("gateway")).toBe(await locked("runner"));
  });

  it("pins the Agent Auth client exactly at 0.6.2, in the manifest and the lockfile", async () => {
    const manifest = JSON.parse(await read("apps/runner/package.json"));
    expect(manifest.dependencies["@auth/agent"]).toBe("0.6.2");
    const lock = JSON.parse(await read("apps/runner/package-lock.json"));
    expect(lock.packages["node_modules/@auth/agent"].version).toBe("0.6.2");
  });
});
