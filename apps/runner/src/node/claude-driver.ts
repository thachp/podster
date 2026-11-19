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
 *
 * **The deep review of #460 (the architect's rulings of 2026-11-18):**
 * - (M1a) no tool call and no model request is let through until a valid `init` has been read; a request held for it
 *   waits at most `INIT_WAIT_MS`, then the run fails `init_missing`; an `init` of the wrong shape fails `init_invalid`;
 * - (M1b) a hook event passes only if both its event is `PreToolUse` and its name is one of `RUNNER_HOOK_NAMES`;
 * - (M1c) any plugin not on `PLUGIN_ALLOWLIST`, which is empty, fails the run;
 * - (M1d) built-in agents and bundled skills are switched off by environment, always;
 * - (M1e) bare mode (`CLAUDE_CODE_SIMPLE=1`) is an option, off until the real run shows Runner's hook still fires under it;
 * - (M1f) on macOS, opt-in, Claude Code starts under `sandbox-exec` with a profile denying every `process-exec` but its
 *   own binary and every read of the login keychain files;
 * - (L1) a reap kills only a group it can prove is Runner's: `ps` failing is never "no such process", a leaderless
 *   group is judged by a member's command, and a record from before the last boot is never acted on;
 * - (L3) a tool-use ID the hook never saw ends the run, with no fallback;
 * - (L4) the SDK's environment names pass only from `SDK_ENV_NAMES`, exactly;
 * - (L8) `GIT_CEILING_DIRECTORIES` stops Git at the run's folder.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
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

/** A process as `ps` shows it. */
export type ProcessInfo = { command: string; started_at: number };
/** What `ps` said of one process: found, no such process, or `ps` itself failed (never read as either). */
export type Described = ({ kind: "found" } & ProcessInfo) | { kind: "none" } | { kind: "failed" };

/** Starting and ending Claude Code's process group: the real one, or a test's stand-in. */
export interface ProcessControl {
  spawn(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }): SpawnedProcess & { readonly pid?: number };
  /** Sends `signal` to the whole group; 0 only asks whether any of it is left. True if the group exists. */
  signalGroup(pid: number, signal: "SIGKILL" | 0): boolean;
  /** The process `pid`'s command and start time. */
  describe(pid: number): Promise<Described>;
  /** Every member of process group `pgid`; null if `ps` failed. */
  group(pgid: number): Promise<(ProcessInfo & { pid: number })[] | null>;
  /** When this machine last booted, in milliseconds; null if it can't be read. */
  bootTime(): Promise<number | null>;
}

/** How long a tool call or model request waits for a valid init before the run fails (M1a). */
export const INIT_WAIT_MS = 15_000;
/** The names Claude Code gives Runner's own PreToolUse callback in its hook events (M1b). Confirmed only by the real run. */
export const RUNNER_HOOK_NAMES: readonly string[] = Object.freeze(["PreToolUse", "PreToolUse:callback"]);
/** Plugins reviewed and allowed to load: none (M1c). */
export const PLUGIN_ALLOWLIST: readonly string[] = Object.freeze([]);
/** The SDK's own environment names that may reach Claude Code, exactly (L4). */
export const SDK_ENV_NAMES: readonly string[] = Object.freeze(["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_AGENT_SDK_CLIENT_APP"]);
/** macOS's sandbox tool. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const sbplString = (path: string) => {
  if (!/^\/[^"\\\u0000-\u001f]*$/.test(path)) throw new Error("sandbox_path_invalid");
  return `"${path}"`;
};

/**
 * The sandbox profile Claude Code runs under on macOS, opt-in (M1f): everything as usual, except that no program may be
 * started but Claude Code's own binary, and the login keychain files can't be read or written. Later rules win.
 */
export function sandboxProfile(command: string, ownerHome: string): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny process-exec)",
    `(allow process-exec (literal ${sbplString(command)}))`,
    `(deny file-read* file-write* (subpath ${sbplString(join(ownerHome, "Library", "Keychains"))}))`,
  ].join("\n");
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
  // No built-in agents and no bundled skills (M1d).
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
});

export type RunDirs = { root: string; work: string; home: string; config: string; tmp: string };

/** Claude Code's whole environment. Nothing else from Runner's reaches it. */
export function claudeEnv(dirs: RunDirs, listener: Pick<BrokerListener, "url" | "token">, maxTokens: number, from: NodeJS.ProcessEnv = process.env, opts: { bare?: boolean } = {}): Record<string, string> {
  const base = childEnv({}, { PATH: from.PATH, LANG: from.LANG });
  return {
    ...base,
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    TMPDIR: dirs.tmp,
    // Git never looks above the run's own folder (L8).
    GIT_CEILING_DIRECTORIES: dirs.root,
    ...(opts.bare === true ? { CLAUDE_CODE_SIMPLE: "1" } : {}),
    ...QUIET,
    ANTHROPIC_BASE_URL: listener.url,
    // The listener's per-run token, as the API key Claude Code sends to it. Never the provider key.
    ANTHROPIC_API_KEY: listener.token,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
}

/** The spawn's environment: Runner's, plus only the SDK's own names in `SDK_ENV_NAMES`, never over Runner's (L4). */
export function spawnEnv(own: Record<string, string>, fromSdk: Record<string, string | undefined>): Record<string, string> {
  const env = { ...own };
  for (const name of SDK_ENV_NAMES) {
    const value = fromSdk[name];
    if (value !== undefined && !Object.hasOwn(own, name) && !forbidden(name)) env[name] = value;
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
  | { kind: "hook"; run_ref: string; subtype: string; hook_event: string; hook_name: string }
  | { kind: "callback"; run_ref: string; tool: string };

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
  /** Bare mode (M1e): off until the real run shows Runner's own hook still fires under it. */
  bare?: boolean;
  /** Start Claude Code under `sandbox-exec` (M1f). macOS only, opt-in. */
  macSandbox?: boolean;
  platform?: NodeJS.Platform;
  /** The owner's own home, for the sandbox profile's keychain rule. */
  ownerHome?: string;
  /** The real path of Claude Code's binary, for the sandbox profile. */
  resolveCommand?: (command: string) => string;
  initWaitMs?: number;
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
    if (deps.macSandbox === true && (deps.platform ?? process.platform) !== "darwin") throw new Error("Runner's sandbox-exec wrapper is for macOS only.");
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
    let failure: string | null = null;
    const fail = (code: string) => {
      if (failure === null) {
        failure = code;
        this.log("failed", code);
      }
      live.abort.abort();
    };
    session.signal.addEventListener("abort", () => live.abort.abort(), { once: true });

    // Nothing goes through until a valid init has been read (M1a): a call waits for it, bounded, and a run whose init
    // never comes, or comes malformed, fails.
    let initOk = false;
    let markInit: (ok: boolean) => void = () => undefined;
    const initSeen = new Promise<boolean>((resolve) => (markInit = resolve));
    live.abort.signal.addEventListener("abort", () => markInit(false), { once: true });
    const waitForInit = async (): Promise<boolean> => {
      if (initOk) return true;
      const timer = new AbortController();
      const late = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), this.deps.initWaitMs ?? INIT_WAIT_MS);
        timer.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
      });
      const ok = await Promise.race([initSeen, late]);
      timer.abort();
      if (!ok && failure === null) fail("init_missing");
      return ok && failure === null;
    };

    live.listener = await (this.deps.listen ?? startBrokerListener)({
      model: async (r) => ((await waitForInit()) ? session.model(r) : { ok: false, refused: "run_stopped" }),
      signal: session.signal,
    });
    const env = claudeEnv(dirs, live.listener, session.limits.max_tokens, this.deps.env, { bare: this.deps.bare });

    // Calls the hook has seen, by ID, and by their input for a handler that isn't told the ID.
    const checked = new Set<string>();
    const pending = new Map<string, string[]>();
    const keyOf = (name: string, input: unknown) => `${name}\u0000${canonical(input)}`;

    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Runner refused this call." } };
    const hook: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (!(await waitForInit())) return deny;
      const name = runnerToolName(input.tool_name);
      const call_id = typeof input.tool_use_id === "string" ? input.tool_use_id : (toolUseID ?? "");
      this.deps.observe?.({ kind: "callback", run_ref: ref, tool: name });
      const decision = session.check({ call_id, tool: name, input: input.tool_input });
      checked.add(call_id);
      const key = keyOf(name, input.tool_input);
      pending.set(key, [...(pending.get(key) ?? []), call_id]);
      if (decision.allow) return {};
      return deny;
    };

    const handler = (name: string) => async (args: Record<string, unknown>, extra: unknown) => {
      const meta = (extra as { _meta?: Record<string, unknown> } | null)?._meta?.["claudecode/toolUseId"];
      const key = keyOf(name, args);
      const queue = pending.get(key) ?? [];
      let call_id: string | undefined;
      if (typeof meta === "string") {
        // A named call the hook never saw ends the run, with no fallback to matching by input (L3 on #460).
        call_id = checked.has(meta) ? meta : undefined;
        const at = queue.indexOf(meta);
        if (at >= 0) queue.splice(at, 1);
      } else {
        call_id = queue.shift();
      }
      if (!initOk) call_id = undefined;
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
      let command = s.command;
      let args = s.args;
      if (this.deps.macSandbox === true) {
        const real = (this.deps.resolveCommand ?? realpathSync)(s.command);
        args = ["-p", sandboxProfile(real, this.deps.ownerHome ?? homedir()), real, ...s.args];
        command = SANDBOX_EXEC;
      }
      const child = this.processes.spawn(command, args, { cwd: dirs.work, env: spawnEnv(env, s.env) });
      if (typeof child.pid === "number") {
        live.pid = child.pid;
        // sandbox-exec replaces itself with Claude Code, so the group's command is Claude Code's either way.
        const record: ProcessRecord = { pid: child.pid, command: this.deps.macSandbox === true ? (this.deps.resolveCommand ?? realpathSync)(s.command) : s.command, started_at: (this.deps.clock ?? Date.now)() };
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
            const init = readInit(m);
            if (init === null) {
              fail("init_invalid");
              break;
            }
            this.deps.observe?.({ kind: "init", run_ref: ref, ...init });
            if (init.claude_code_version !== PINNED_CLAUDE_CODE_VERSION) fail("claude_code_version");
            else if (init.permission_mode !== "dontAsk") fail("permission_mode");
            else if (init.tools.some((t) => !allowedNames.has(t))) fail("tools_unexpected");
            else if (init.mcp_servers.some((s) => s !== MCP_SERVER)) fail("mcp_unexpected");
            else if (init.plugins.some((p) => !PLUGIN_ALLOWLIST.includes(p))) fail("plugins_unexpected");
            else {
              initOk = true;
              markInit(true);
            }
          } else if (m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("hook_")) {
            const event = String(m.hook_event ?? "");
            const hookName = String(m.hook_name ?? "");
            this.deps.observe?.({ kind: "hook", run_ref: ref, subtype: m.subtype, hook_event: event, hook_name: hookName });
            // Only Runner's own PreToolUse callback may run, by its event and its name (S-44, M1b, failing closed).
            if (event !== "PreToolUse" || !RUNNER_HOOK_NAMES.includes(hookName)) fail("hook_unexpected");
          } else if (m.type === "result") {
            if (!initOk) fail("init_missing");
            result = m.subtype === "success" ? (m.structured_output ?? null) : null;
          }
        }
      } catch (error) {
        if (failure === null) throw error;
      }
      if (failure === null && !initOk) fail("init_missing");
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
    if (record !== null && (await this.ours(record)) !== "no") return false;
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
    // Killed only when proven Runner's; unknown never kills (L1).
    if (record !== null && (await this.ours(record)) === "yes") this.processes.signalGroup(record.pid, "SIGKILL");
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

  /**
   * Whether the recorded group is still there and still Runner's (L1 on #460): "yes", "no", or "unknown" when `ps` or
   * the boot time can't be read. Never "yes" for a record from before the last boot; a leaderless group is judged by
   * its members' commands.
   */
  private async ours(record: ProcessRecord): Promise<"yes" | "no" | "unknown"> {
    if (!this.processes.signalGroup(record.pid, 0)) return "no";
    const boot = await this.processes.bootTime();
    if (boot === null) return "unknown";
    if (boot > record.started_at) return "no";
    const leader = await this.processes.describe(record.pid);
    if (leader.kind === "failed") return "unknown";
    if (leader.kind === "found") return leader.command.startsWith(record.command) && Math.abs(leader.started_at - record.started_at) <= START_SLACK_MS ? "yes" : "no";
    const members = await this.processes.group(record.pid);
    if (members === null) return "unknown";
    if (members.length === 0) return "no";
    return members.some((m) => m.command.startsWith(record.command) && m.started_at >= record.started_at - START_SLACK_MS) ? "yes" : "no";
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
  async describe(pid) {
    const r = await psRows(["-o", "lstart=", "-o", "command=", "-p", String(pid)]);
    if (r === null) return { kind: "failed" };
    // ps answers 1 with nothing for no such process; anything else unreadable is a failure.
    if (r.code === 1 && r.out.trim() === "") return { kind: "none" };
    if (r.code !== 0) return { kind: "failed" };
    const line = r.out.split("\n")[0] ?? "";
    const started = Date.parse(line.slice(0, 24));
    return Number.isNaN(started) ? { kind: "failed" } : { kind: "found", command: line.slice(24).trim(), started_at: started };
  },
  async group(pgid) {
    const r = await psRows(["-A", "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="]);
    if (r === null || r.code !== 0) return null;
    const members: (ProcessInfo & { pid: number })[] = [];
    for (const line of r.out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[2]) !== pgid) continue;
      const started = Date.parse(m[3]);
      if (Number.isNaN(started)) return null;
      members.push({ pid: Number(m[1]), command: m[4], started_at: started });
    }
    return members;
  },
  async bootTime() {
    if (process.platform === "linux") {
      const stat = await readFile("/proc/stat", "utf8").catch(() => null);
      const btime = stat ? /^btime (\d+)$/m.exec(stat)?.[1] : undefined;
      return btime ? Number(btime) * 1000 : null;
    }
    const r = await run("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
    const sec = r && r.code === 0 ? /sec = (\d+)/.exec(r.out)?.[1] : undefined;
    return sec ? Number(sec) * 1000 : null;
  },
};

/** A fixed program's output, from an argument array with the allow-listed environment; null if it couldn't start. */
function run(program: string, args: string[]): Promise<{ code: number; out: string } | null> {
  return new Promise((resolve) => {
    const child = nodeSpawn(program, args, { env: childEnv({ LC_ALL: "C" }), stdio: ["ignore", "pipe", "ignore"], shell: false });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 4 * 1024 * 1024) out += d.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

const psRows = (args: string[]) => run("/bin/ps", args);

type InitFacts = { claude_code_version: string; permission_mode: string; tools: string[]; mcp_servers: string[]; plugins: string[] };
/** The init message's facts in exactly their shape, or null (M1a). */
function readInit(m: Record<string, unknown>): InitFacts | null {
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const named = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && typeof (x as { name?: unknown }).name === "string");
  if (typeof m.claude_code_version !== "string" || typeof m.permissionMode !== "string" || !strings(m.tools) || !named(m.mcp_servers) || !named(m.plugins)) return null;
  return {
    claude_code_version: m.claude_code_version,
    permission_mode: m.permissionMode,
    tools: m.tools as string[],
    mcp_servers: (m.mcp_servers as { name: string }[]).map((x) => x.name),
    plugins: (m.plugins as { name: string }[]).map((x) => x.name),
  };
}
