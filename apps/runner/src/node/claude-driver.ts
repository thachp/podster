/**
 * The Claude Agent SDK's driver (M7 step 9(b); the owner's ruling of 2026-11-17; the architect's rulings 1 to 6 on spike
 * B; #459's notes for 9(b)). It implements `AgentDriver` and decides nothing: the run policy, the container, the key, the
 * budget and the outcome are `SupervisedAdapter`'s.
 *
 * **Placement: outside** (ruling 1). Claude Code runs on the host, in an empty folder Runner makes for the run, with no
 * built-in tool (`tools: []`). Its only tools are Runner's, served in Runner's own process as the in-process MCP server
 * `runner`, each running in the task's container through the run interface.
 *
 * **Fixed settings, with no way to unset them** (ruling 2), built only by `claudeOptions` from the session and checked
 * again by `fixedOptionsRefusal` before every run: `verbatimPrompts: true`, `settingSources: []`,
 * `strictMcpConfig: true`, `persistSession: false`, `tools: []`, the permission mode `dontAsk` with Runner's allow list
 * (the second lock), `maxTurns` and an output-token cap, the result schema, and the frame as the whole system prompt.
 * The SDK's mode that skips permissions is never named here, and no option enables it.
 *
 * **The frame** is Runner's fixed `UNTRUSTED_FRAME`, the whole system prompt (not appended to Claude Code's own); the
 * task's words are the user prompt, exactly, and `verbatimPrompts` keeps an `@path` in them from being expanded.
 *
 * **Tool names:** the SDK names Runner's MCP tools `mcp__runner__<tool>`; the hook and the handlers map them back to
 * Runner's (`read`, `search`, `write`, `edit`, `shell`), and the SDK's `StructuredOutput` stays itself. Any other name
 * reaches Runner's decision as no tool of Runner's, and is refused.
 *
 * **The decision point** is a `PreToolUse` hook for every tool, which only refuses (an allowed call gets no opinion, so
 * the SDK's own list still decides), and which blocks the call if it fails. A handler runs only a call the hook saw: an
 * unchecked call ends the run. So does any hook that isn't Runner's starting (S-44, failing closed).
 *
 * **Claude Code's environment** is allow-listed: `PATH` and `LANG`, an empty `HOME`, `CLAUDE_CONFIG_DIR` and `TMPDIR`
 * in the run's folder, telemetry, error reports, updates and nonessential traffic off, the listener's address and its
 * per-run token, and the output-token cap. No D-Bus address, keychain, SSH agent or provider key (L1 on #458; the
 * keychain ruling on #459's item 6). The SDK's own `CLAUDE_CODE_`/`CLAUDE_AGENT_SDK_` settings pass only if not shaped
 * like a secret and not one of Runner's.
 *
 * **Versions:** the installed SDK and its bundled Claude Code must be the pinned pair, checked when the driver is made
 * and again on each run's first message (S-48).
 *
 * **Process tree:** Claude Code starts in its own process group, recorded in the run's folder, so a cancel, and a reap
 * after a restart (M4 on #459), kill the whole group. Logs carry IDs and codes only.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type HookCallback, type Options, type SdkMcpToolDefinition, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CLAUDE_MODEL, CLAUDE_MODELS, CLAUDE_PROFILE, PINNED_CLAUDE_CODE_VERSION, versionRefusal } from "../core/claude-profile.js";
import { RESULT_TOOL } from "../core/policy.js";
import type { AgentDriver, DriverOutcome, DriverRun, DriverSession } from "../core/run-interface.js";
import { silentLogger, type Logger } from "../core/runtime.js";
import { childEnv, forbidden } from "./child-env.js";
import { startBrokerListener, type BrokerListener, type ListenerDeps } from "./broker-listener.js";
import { ensureFolder, freshFolder, readNoFollow, removeOwnFolder, writeNewSync } from "./safe-fs.js";

/** The SDK's functions the driver uses: the real ones, or a test's stand-in. */
export type ClaudeSdk = { query: typeof query; createSdkMcpServer: typeof createSdkMcpServer; tool: typeof tool };
export const CLAUDE_SDK: ClaudeSdk = { query, createSdkMcpServer, tool };

/** Starting and ending Claude Code's process group: the real one, or a test's stand-in. */
export interface ProcessControl {
  spawn(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }): SpawnedProcess & { readonly pid?: number };
  /** Sends `signal` to the whole group; 0 only asks whether any of it is left. True if the group exists. */
  signalGroup(pid: number, signal: "SIGKILL" | 0): boolean;
  /** The process `pid`'s command and start time, or null if there is none. */
  describe(pid: number): Promise<{ command: string; started_at: number } | null>;
}

export const MCP_SERVER = "runner";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const REF = /^[A-Za-z0-9_-]{1,128}$/;
/** How close a process's start must be to the recorded one for a reap after a restart to take it as Runner's. */
const START_SLACK_MS = 5_000;

/** The SDK's name for one of Runner's tools. */
export const sdkToolName = (name: string) => (name === RESULT_TOOL ? RESULT_TOOL : `${MCP_PREFIX}${name}`);
/** Runner's name for a tool the SDK names; anything not Runner's stays marked as not Runner's, so the policy refuses it. */
export function runnerToolName(sdkName: string): string {
  if (sdkName === RESULT_TOOL) return RESULT_TOOL;
  if (sdkName.startsWith(MCP_PREFIX)) return sdkName.slice(MCP_PREFIX.length);
  return `other:${sdkName}`;
}

/** Telemetry, error reports, updates and every other nonessential call off, and experimental betas off. */
export const QUIET: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
});

export type RunDirs = { root: string; work: string; home: string; config: string; tmp: string };

/** Claude Code's whole environment. Nothing else from Runner's reaches it. */
export function claudeEnv(dirs: RunDirs, listener: Pick<BrokerListener, "url" | "token">, maxTokens: number, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const base = childEnv({}, { PATH: from.PATH, LANG: from.LANG });
  return {
    ...base,
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    TMPDIR: dirs.tmp,
    ...QUIET,
    ANTHROPIC_BASE_URL: listener.url,
    // The listener's per-run token, as the API key Claude Code sends to it. Never the provider key.
    ANTHROPIC_API_KEY: listener.token,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
}

/** The spawn's environment: Runner's, plus the SDK's own settings that aren't Runner's and aren't shaped like a secret. */
export function spawnEnv(own: Record<string, string>, fromSdk: Record<string, string | undefined>): Record<string, string> {
  const env = { ...own };
  for (const [name, value] of Object.entries(fromSdk)) {
    if (value === undefined || Object.hasOwn(own, name)) continue;
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_)[A-Z0-9_]*$/.test(name) && !forbidden(name)) env[name] = value;
  }
  return env;
}

/** The SDK's options for a run: every setting fixed here, from the session alone. */
export function claudeOptions(p: { session: DriverSession; cwd: string; env: Record<string, string>; mcp: ReturnType<typeof createSdkMcpServer>; hook: HookCallback; spawn: (options: SpawnOptions) => SpawnedProcess; abortController: AbortController }): Options {
  const { session } = p;
  return Object.freeze({
    model: CLAUDE_MODEL,
    cwd: p.cwd,
    env: p.env,
    abortController: p.abortController,
    systemPrompt: session.frame,
    tools: [],
    mcpServers: { [MCP_SERVER]: p.mcp },
    mcpServersDelivery: "initialize",
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    verbatimPrompts: true,
    permissionMode: "dontAsk",
    allowedTools: session.allowed_tools.map(sdkToolName),
    maxTurns: session.limits.turns,
    outputFormat: { type: "json_schema", schema: session.result_schema as unknown as Record<string, unknown> },
    includeHookEvents: true,
    hooks: { PreToolUse: [{ hooks: [p.hook], onFailure: "block" }] },
    spawnClaudeCodeProcess: p.spawn,
  } satisfies Options) as Options;
}

const ALLOWED_KEYS = new Set([
  "model", "cwd", "env", "abortController", "systemPrompt", "tools", "mcpServers", "mcpServersDelivery", "strictMcpConfig", "settingSources", "persistSession", "verbatimPrompts", "permissionMode", "allowedTools", "maxTurns", "outputFormat", "includeHookEvents", "hooks", "spawnClaudeCodeProcess",
]);

/** Why these options must not run, or null: every fixed setting as fixed, and nothing else set. */
export function fixedOptionsRefusal(o: Options): string | null {
  const keys = Object.keys(o);
  if (keys.some((k) => !ALLOWED_KEYS.has(k))) return "option_not_allowed";
  if (o.permissionMode !== "dontAsk") return "permission_mode";
  if (o.verbatimPrompts !== true) return "verbatim_prompts";
  if (!Array.isArray(o.settingSources) || o.settingSources.length !== 0) return "setting_sources";
  if (o.strictMcpConfig !== true) return "strict_mcp_config";
  if (o.persistSession !== false) return "persist_session";
  if (!Array.isArray(o.tools) || o.tools.length !== 0) return "builtin_tools";
  if (Object.keys(o.mcpServers ?? {}).join(",") !== MCP_SERVER) return "mcp_servers";
  if (!Array.isArray(o.allowedTools) || !o.allowedTools.includes(RESULT_TOOL) || o.allowedTools.some((t) => t !== RESULT_TOOL && !t.startsWith(MCP_PREFIX))) return "allowed_tools";
  if (typeof o.maxTurns !== "number" || o.maxTurns <= 0) return "max_turns";
  if (o.outputFormat?.type !== "json_schema") return "output_format";
  if (typeof o.systemPrompt !== "string") return "system_prompt";
  if (o.model !== CLAUDE_MODEL) return "model";
  const env = o.env ?? {};
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== "1" || !env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) return "env";
  if (Object.keys(env).some((n) => /DBUS|SSH_AUTH|KEYCHAIN|GITHUB|AWS_|CLOUDFLARE|PODSTER/i.test(n))) return "env";
  return null;
}

/** Each of Runner's tools, its input shape for the SDK, and what it tells the model. Fixed. */
const TOOL_SHAPES = {
  read: { description: "Read a file in the task's folder.", shape: { path: z.string() } },
  search: { description: "Search the task's folder for a regular expression.", shape: { pattern: z.string(), path: z.string().optional() } },
  write: { description: "Write a whole file in the task's folder.", shape: { path: z.string(), content: z.string() } },
  edit: { description: "Replace one exact piece of text, which must appear once, in a file in the task's folder.", shape: { path: z.string(), old: z.string(), new: z.string() } },
  shell: { description: "Run a shell command in the task's container, in its folder, with no network.", shape: { command: z.string() } },
} as const;

/** The same input, written the same way, whatever its key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export type DriverObservation =
  | { kind: "spawned"; run_ref: string; pid: number }
  | { kind: "init"; run_ref: string; claude_code_version: unknown; permission_mode: unknown; tools: string[]; mcp_servers: string[]; plugins: string[] }
  | { kind: "hook"; run_ref: string; subtype: string; hook_event: string };

type Live = { pid: number | null; listener: BrokerListener | null; abort: AbortController; dir: string };
type ProcessRecord = { pid: number; command: string; started_at: number };

export type ClaudeDriverDeps = {
  home: string;
  installed: { sdk: unknown; claude_code: unknown };
  sdk?: ClaudeSdk;
  processes?: ProcessControl;
  listen?: (deps: ListenerDeps) => Promise<BrokerListener>;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  log?: Logger;
  observe?: (event: DriverObservation) => void;
};

export class ClaudeDriver implements AgentDriver {
  readonly adapter = "claude_agent_sdk" as const;
  readonly profile = CLAUDE_PROFILE;
  readonly models = CLAUDE_MODELS;
  private readonly deps: ClaudeDriverDeps;
  private readonly sdk: ClaudeSdk;
  private readonly processes: ProcessControl;
  private readonly runs: string;
  private readonly live = new Map<string, Live>();

  constructor(deps: ClaudeDriverDeps) {
    const refused = versionRefusal(deps.installed);
    if (refused) throw new Error(`Runner won't run this Claude Agent SDK: ${refused === "sdk_version" ? "the SDK" : "its bundled Claude Code"} isn't the pinned version.`);
    this.deps = deps;
    this.sdk = deps.sdk ?? CLAUDE_SDK;
    this.processes = deps.processes ?? nodeProcesses;
    this.runs = join(deps.home, "runs");
  }

  private log(outcome: string, code?: string) {
    (this.deps.log ?? silentLogger)("adapter.claude", outcome, code ? { code } : {});
  }

  async begin(session: DriverSession): Promise<DriverRun> {
    const ref = session.run_ref;
    if (!REF.test(ref)) throw new Error("run_ref_invalid");
    await ensureFolder(this.deps.home, this.runs);
    const root = await freshFolder(join(this.runs, ref));
    const live: Live = { pid: null, listener: null, abort: new AbortController(), dir: root };
    this.live.set(ref, live);
    const dirs: RunDirs = { root, work: await freshFolder(join(root, "work")), home: await freshFolder(join(root, "home")), config: await freshFolder(join(root, "config")), tmp: await freshFolder(join(root, "tmp")) };
    live.listener = await (this.deps.listen ?? startBrokerListener)({ model: (r) => session.model(r), signal: session.signal });
    const env = claudeEnv(dirs, live.listener, session.limits.max_tokens, this.deps.env);

    let failure: string | null = null;
    const fail = (code: string) => {
      if (failure === null) {
        failure = code;
        this.log("failed", code);
      }
      live.abort.abort();
    };
    session.signal.addEventListener("abort", () => live.abort.abort(), { once: true });

    // Calls the hook has seen, by ID, and by their input for a handler that isn't told the ID.
    const checked = new Set<string>();
    const pending = new Map<string, string[]>();
    const keyOf = (name: string, input: unknown) => `${name}\u0000${canonical(input)}`;

    const hook: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const name = runnerToolName(input.tool_name);
      const call_id = typeof input.tool_use_id === "string" ? input.tool_use_id : (toolUseID ?? "");
      const decision = session.check({ call_id, tool: name, input: input.tool_input });
      checked.add(call_id);
      const key = keyOf(name, input.tool_input);
      pending.set(key, [...(pending.get(key) ?? []), call_id]);
      if (decision.allow) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Runner refused this call." } };
    };

    const handler = (name: string) => async (args: Record<string, unknown>, extra: unknown) => {
      const meta = (extra as { _meta?: Record<string, unknown> } | null)?._meta?.["claudecode/toolUseId"];
      const key = keyOf(name, args);
      const queue = pending.get(key) ?? [];
      let call_id: string | undefined;
      if (typeof meta === "string" && checked.has(meta)) {
        call_id = meta;
        const at = queue.indexOf(meta);
        if (at >= 0) queue.splice(at, 1);
      } else {
        call_id = queue.shift();
      }
      if (call_id === undefined) {
        // A call the hook never saw: the decision point was passed by, so the run ends.
        fail("hook_bypassed");
        return { content: [{ type: "text" as const, text: "Runner refused this call." }], isError: true };
      }
      const output = await session.tool({ call_id, tool: name, input: args });
      return { content: [{ type: "text" as const, text: output.text === "" ? (output.ok ? "Done." : "Failed.") : output.text }], isError: !output.ok };
    };

    const allowedTools = session.allowed_tools.filter((t): t is keyof typeof TOOL_SHAPES => Object.hasOwn(TOOL_SHAPES, t));
    const mcp = this.sdk.createSdkMcpServer({
      name: MCP_SERVER,
      version: "1.0.0",
      tools: allowedTools.map((name) => this.sdk.tool(name, TOOL_SHAPES[name].description, TOOL_SHAPES[name].shape as Record<string, z.ZodType>, handler(name)) as SdkMcpToolDefinition),
    });

    const spawn = (s: SpawnOptions): SpawnedProcess => {
      if (live.abort.signal.aborted) throw new Error("halted");
      const child = this.processes.spawn(s.command, s.args, { cwd: dirs.work, env: spawnEnv(env, s.env) });
      if (typeof child.pid === "number") {
        live.pid = child.pid;
        const record: ProcessRecord = { pid: child.pid, command: s.command, started_at: (this.deps.clock ?? Date.now)() };
        try {
          // Written before Claude Code is handed back, so a restart always finds the group to reap.
          writeNewSync(join(root, "process.json"), JSON.stringify(record));
        } catch {
          this.processes.signalGroup(child.pid, "SIGKILL");
          throw new Error("process_record");
        }
        this.deps.observe?.({ kind: "spawned", run_ref: ref, pid: child.pid });
      }
      return child;
    };

    const options = claudeOptions({ session, cwd: dirs.work, env, mcp, hook, spawn, abortController: live.abort });
    const refused = fixedOptionsRefusal(options);
    if (refused) throw new Error(refused);
    const allowedNames = new Set(options.allowedTools);

    const done = (async (): Promise<DriverOutcome> => {
      let result: unknown = null;
      try {
        for await (const message of this.sdk.query({ prompt: session.prompt.text, options })) {
          if (failure !== null) break;
          const m = message as Record<string, unknown>;
          if (m.type === "system" && m.subtype === "init") {
            const tools = Array.isArray(m.tools) ? m.tools.map(String) : [];
            const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers.map((s) => String((s as { name?: unknown }).name)) : [];
            const plugins = Array.isArray(m.plugins) ? m.plugins.map((p) => String((p as { name?: unknown }).name ?? p)) : [];
            this.deps.observe?.({ kind: "init", run_ref: ref, claude_code_version: m.claude_code_version, permission_mode: m.permissionMode, tools, mcp_servers: servers, plugins });
            if (m.claude_code_version !== PINNED_CLAUDE_CODE_VERSION) fail("claude_code_version");
            else if (m.permissionMode !== "dontAsk") fail("permission_mode");
            else if (tools.some((t) => !allowedNames.has(t))) fail("tools_unexpected");
            else if (servers.some((s) => s !== MCP_SERVER)) fail("mcp_unexpected");
          } else if (m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("hook_")) {
            const event = String(m.hook_event ?? "");
            this.deps.observe?.({ kind: "hook", run_ref: ref, subtype: m.subtype, hook_event: event });
            // Only Runner's own PreToolUse callback may run; any other hook ends the run (S-44, failing closed).
            if (event !== "PreToolUse") fail("hook_unexpected");
          } else if (m.type === "result") {
            result = m.subtype === "success" ? (m.structured_output ?? null) : null;
          }
        }
      } catch (error) {
        if (failure === null) throw error;
      }
      if (failure !== null) throw new Error(failure);
      return { result };
    })();
    // Handled by the run interface; a rejection here is never left unhandled meanwhile.
    done.catch(() => undefined);

    return { done, cancel: () => this.stop(ref) };
  }

  /** Ends the run's process group and listener at once. */
  private async stop(ref: string) {
    const live = this.live.get(ref);
    if (!live) return this.reap(ref);
    live.abort.abort();
    if (live.pid !== null) this.processes.signalGroup(live.pid, "SIGKILL");
    await live.listener?.close();
  }

  async confirmGone(run_ref: string): Promise<boolean> {
    if (!REF.test(run_ref)) return false;
    const live = this.live.get(run_ref);
    if (live) {
      if (live.pid !== null && this.processes.signalGroup(live.pid, 0)) return false;
      await live.listener?.close();
      this.live.delete(run_ref);
      await removeOwnFolder(live.dir);
      return true;
    }
    const record = await this.record(run_ref);
    if (record === "unreadable") return false;
    if (record !== null && (await this.ours(record))) return false;
    await removeOwnFolder(join(this.runs, run_ref));
    return true;
  }

  /** After a restart (M4 on #459): kills a previous process's Claude Code group for this run, if it is still Runner's. */
  async reap(run_ref: string): Promise<void> {
    if (!REF.test(run_ref)) throw new Error("run_ref_invalid");
    const live = this.live.get(run_ref);
    if (live) {
      live.abort.abort();
      if (live.pid !== null) this.processes.signalGroup(live.pid, "SIGKILL");
      await live.listener?.close();
      return;
    }
    const record = await this.record(run_ref);
    if (record === "unreadable") throw new Error("process_record_unreadable");
    if (record !== null && (await this.ours(record))) this.processes.signalGroup(record.pid, "SIGKILL");
  }

  /** At startup: every run folder a previous process left. */
  async reapAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.runs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) if (REF.test(name) && !this.live.has(name)) await this.reap(name);
  }

  private async record(ref: string): Promise<ProcessRecord | null | "unreadable"> {
    try {
      const text = await readNoFollow(join(this.runs, ref, "process.json"), 4096);
      if (text === null) return null;
      const r = JSON.parse(text) as ProcessRecord;
      if (!Number.isSafeInteger(r.pid) || r.pid <= 1 || typeof r.command !== "string" || !Number.isSafeInteger(r.started_at)) return "unreadable";
      return r;
    } catch {
      return "unreadable";
    }
  }

  /** Whether the recorded group is still there and still Runner's: its leader the same program started then, or gone with members left. */
  private async ours(record: ProcessRecord): Promise<boolean> {
    if (!this.processes.signalGroup(record.pid, 0)) return false;
    const now = await this.processes.describe(record.pid);
    // A group with its leader gone keeps its ID while any member lives, so it can't be another's.
    if (now === null) return true;
    return now.command.startsWith(record.command) && Math.abs(now.started_at - record.started_at) <= START_SLACK_MS;
  }
}

/** The real process control: Claude Code in its own process group, its errors drained, never a shell. */
export const nodeProcesses: ProcessControl = {
  spawn(command, args, opts) {
    const child = nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.stderr?.resume();
    child.on("error", () => undefined);
    return child as unknown as SpawnedProcess & { pid?: number };
  },
  signalGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  describe(pid) {
    return new Promise((resolve) => {
      const ps = nodeSpawn("/bin/ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { env: childEnv({ LC_ALL: "C" }), stdio: ["ignore", "pipe", "ignore"], shell: false });
      let out = "";
      ps.stdout.on("data", (d: Buffer) => {
        if (out.length < 65_536) out += d.toString("utf8");
      });
      ps.on("error", () => resolve(null));
      ps.on("close", () => {
        const line = out.split("\n")[0] ?? "";
        if (line.trim() === "") return resolve(null);
        const started = Date.parse(line.slice(0, 24));
        resolve(Number.isNaN(started) ? null : { command: line.slice(24).trim(), started_at: started });
      });
    });
  },
};
