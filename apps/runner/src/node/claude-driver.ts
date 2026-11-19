/**
 * The Claude Agent SDK's driver (M7 step 9(b); the owner's ruling of 2026-11-17; the architect's rulings on spike B and
 * on #460's reviews and real run). It implements `AgentDriver` and decides nothing: the run policy, the task container,
 * the key, the budget and the outcome are `SupervisedAdapter`'s.
 *
 * **Placement: two containers** (the architect's ruling of 2026-11-18 after #460's real run, which superseded the
 * outside placement: on the host, Claude Code loaded three built-in plugins and started `security` as a child even with
 * an empty `HOME`, and a macOS `sandbox-exec` profile didn't close the keychain). Runner keeps the SDK's client side, the
 * broker and the key on the host. Claude Code runs as the SDK's Linux binary in its OWN container per run, apart from the
 * task's container:
 * - on a per-run internal Docker network with no route out; its only peer is a relay container, alias `relay`, which
 *   forwards TCP to Runner's loopback listener on the host and nothing else;
 * - with no host mount at all: its home and config are size-bounded tmpfs (L1 of the review at 1335df4a); no key, only
 *   the listener's per-run token; a numeric non-root UID with the task container's hardening, labelled by run and home,
 *   and killed and reaped the same way;
 * - the relay starts on the run's internal network as `relay` and then joins Docker's default bridge, and no other
 *   network: Docker won't attach a container started with `--network none` to any network, and Docker Desktop reaches
 *   `host.docker.internal` only from a network with a route out. Accepted (L2): a container on the default bridge could
 *   reach the relay, and through it the listener, which still takes nothing without the per-run token;
 * - started with `docker exec`, its environment handed through the exec client's own environment (`--env NAME`), never
 *   its arguments.
 * Claude Code still has `tools: []`; task commands run only in the task container, through Runner's tools.
 *
 * **Fixed settings, with no way to unset them,** built only by `claudeOptions` and checked again by
 * `fixedOptionsRefusal`: `verbatimPrompts: true`, `settingSources: []`, `strictMcpConfig: true`, `persistSession: false`,
 * `tools: []`, the permission mode `dontAsk` with Runner's allow list, `maxTurns`, an output-token cap, the result
 * schema, and the frame as the whole system prompt. The SDK's mode that skips permissions is never named here.
 *
 * **The decision point** is a `PreToolUse` hook for every tool, which only refuses and blocks the call if it fails. A
 * handler runs only a call the hook saw (`hook_bypassed` otherwise, with no fallback for a named ID the hook never saw).
 * Nothing goes through until a valid `init` (held at most `INIT_WAIT_MS`). The run fails on a Claude Code version other
 * than the pinned one, a mode other than `dontAsk`, a tool or MCP server Runner didn't give, a plugin not on
 * `PLUGIN_ALLOWLIST`, and any hook event Runner can't attribute to its own callback (event `PreToolUse`, name
 * `PreToolUse:Callback`, no `origin` field).
 *
 * **Bare mode** (`CLAUDE_CODE_SIMPLE=1`) is what `claudeEngine` always uses. Built-in agents and bundled skills are
 * switched off by environment. The SDK's own environment names pass only from `SDK_ENV_NAMES`, exactly.
 *
 * Logs carry IDs and codes only.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type HookCallback, type Options, type SdkMcpToolDefinition, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CLAUDE_MODEL, CLAUDE_MODELS, CLAUDE_PROFILE, PINNED_CLAUDE_CODE_VERSION, versionRefusal } from "../core/claude-profile.js";
import { RESULT_TOOL } from "../core/policy.js";
import type { AgentDriver, DriverOutcome, DriverRun, DriverSession } from "../core/run-interface.js";
import { silentLogger, type Logger } from "../core/runtime.js";
import { forbidden } from "./child-env.js";
import { startBrokerListener, type BrokerListener, type ListenerDeps } from "./broker-listener.js";
import { homeLabel, IMAGE_ID, LABEL_HOME, LABEL_RUN, LIMITS, type DockerCli } from "./docker-sandbox.js";
import { ensureFolder, freshFolder, removeOwnFolder } from "./safe-fs.js";

/** The SDK's functions the driver uses: the real ones, or a test's stand-in. */
export type ClaudeSdk = { query: typeof query; createSdkMcpServer: typeof createSdkMcpServer; tool: typeof tool };
export const CLAUDE_SDK: ClaudeSdk = { query, createSdkMcpServer, tool };

/** Starting the `docker exec` client that carries Claude Code's standard input and output: the real one, or a stand-in. */
export type ExecClient = SpawnedProcess & { readonly pid?: number; readonly signalCode?: NodeJS.Signals | string | null; stderrBytes?(): number };
export interface ProcessControl {
  spawn(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }): ExecClient;
}

export const MCP_SERVER = "runner";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const REF = /^[A-Za-z0-9_-]{1,128}$/;

/** How long a tool call or model request waits for a valid init before the run fails. */
export const INIT_WAIT_MS = 15_000;
/** The name Claude Code gives an SDK callback hook's events: Runner's own `PreToolUse` callback, and nothing else. */
export const RUNNER_HOOK_NAMES: readonly string[] = Object.freeze(["PreToolUse:Callback"]);
/**
 * Plugins reviewed and allowed to load: exactly the three built into Claude Code 2.1.327, which #460's real run saw load
 * in default and bare mode alike. In Claude Code's own container they reach nothing of the owner's. Pinned with the
 * version: a new Claude Code is admitted only after its plugins are reviewed again. Any other plugin fails the run.
 */
export const PLUGIN_ALLOWLIST: readonly string[] = Object.freeze(["cc-plugin-agents-md", "cc-plugin-privacy", "cc-plugin-plugin-authoring"]);
/** The SDK's own environment names that may reach Claude Code, exactly. */
export const SDK_ENV_NAMES: readonly string[] = Object.freeze(["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_AGENT_SDK_CLIENT_APP"]);

/** Where things are inside Claude Code's container. */
export const CLAUDE_IN_CONTAINER = "/opt/claude/claude";
export const CONTAINER_HOME = "/claude/home";
export const CONTAINER_CONFIG = "/claude/config";
export const CONTAINER_WORK = "/work";
export const RELAY_ALIAS = "relay";
export const RELAY_PORT = 8080;
/** Which container of a run a container is. */
export const LABEL_ROLE = "dev.podster.runner.role";
/** How long Claude Code's containers may outlive a run's time cap, as the task container may. */
const CONTAINER_MARGIN_S = 60;

/** The names of a run's Claude Code container, relay and network. */
export function claudeNames(ref: string) {
  const r = ref.toLowerCase();
  return { container: `podster-cc-${r}`, relay: `podster-relay-${r}`, network: `podster-net-${r}` };
}

const hardening = (uid: number, gid: number) => [
  "--pull", "never",
  "--user", `${uid}:${gid}`,
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--read-only",
  "--pids-limit", String(LIMITS.pids),
  "--memory", LIMITS.memory,
  "--memory-swap", LIMITS.memory,
  "--cpus", LIMITS.cpus,
  "--ulimit", `fsize=${LIMITS.file_bytes}`,
  "--ulimit", "nofile=1024:1024",
  "--ulimit", "core=0",
  "--ipc", "none",
];

const labels = (ref: string, home_label: string, role: string) => ["--label", `${LABEL_RUN}=${ref}`, "--label", `${LABEL_HOME}=${home_label}`, "--label", `${LABEL_ROLE}=${role}`];

/** `docker run` for Claude Code's own container: the run's internal network, tmpfs for everything it writes, no host mount. */
export function claudeRunArgs(o: { ref: string; image: string; uid: number; gid: number; home_label: string; max_seconds: number }): string[] {
  const names = claudeNames(o.ref);
  return [
    "run", "--detach", "--name", names.container,
    ...labels(o.ref, o.home_label, "claude"),
    ...hardening(o.uid, o.gid),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs", `${CONTAINER_WORK}:rw,nosuid,nodev,size=64m`,
    "--tmpfs", `${CONTAINER_HOME}:rw,nosuid,nodev,size=64m,uid=${o.uid},gid=${o.gid},mode=0700`,
    "--tmpfs", `${CONTAINER_CONFIG}:rw,nosuid,nodev,size=64m,uid=${o.uid},gid=${o.gid},mode=0700`,
    "--network", names.network,
    "--workdir", CONTAINER_WORK,
    "--init",
    o.image,
    "sleep", String(o.max_seconds),
  ];
}

/**
 * `docker run` for the relay: on the run's internal network as `relay`, no mount, a fixed TCP forward to the host's
 * listener port, bounded in time. `prepare` then attaches the default bridge, and nothing else.
 */
export function relayRunArgs(o: { ref: string; image: string; uid: number; gid: number; port: number; home_label: string; max_seconds: number }): string[] {
  const names = claudeNames(o.ref);
  return [
    "run", "--detach", "--name", names.relay,
    "--network", names.network,
    "--network-alias", RELAY_ALIAS,
    ...labels(o.ref, o.home_label, "relay"),
    ...hardening(o.uid, o.gid),
    "--add-host", "host.docker.internal:host-gateway",
    "--init",
    o.image,
    "timeout", String(o.max_seconds),
    "socat", `TCP-LISTEN:${RELAY_PORT},fork,reuseaddr`, `TCP:host.docker.internal:${o.port}`,
  ];
}

/** `docker exec` starting Claude Code: its environment by name only, so no value is ever an argument. */
export function claudeExecArgs(ref: string, envNames: readonly string[], args: readonly string[]): string[] {
  return ["exec", "--interactive", "--workdir", CONTAINER_WORK, ...envNames.flatMap((n) => ["--env", n]), claudeNames(ref).container, CLAUDE_IN_CONTAINER, ...args];
}

/** The SDK's name for one of Runner's tools. */
export const sdkToolName = (name: string) => (name === RESULT_TOOL ? RESULT_TOOL : `${MCP_PREFIX}${name}`);
/** Runner's name for a tool the SDK names; anything not Runner's stays marked as not Runner's, so the policy refuses it. */
export function runnerToolName(sdkName: string): string {
  if (sdkName === RESULT_TOOL) return RESULT_TOOL;
  if (sdkName.startsWith(MCP_PREFIX)) return sdkName.slice(MCP_PREFIX.length);
  return `other:${sdkName}`;
}

/** Telemetry, error reports, updates, nonessential traffic and experimental betas off; no built-in agents or skills. */
export const QUIET: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
});

/** Claude Code's whole environment, inside its container. Nothing of Runner's own environment reaches it. */
export function claudeEnv(token: string, maxTokens: number, opts: { bare?: boolean } = {}): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: CONTAINER_HOME,
    CLAUDE_CONFIG_DIR: CONTAINER_CONFIG,
    TMPDIR: "/tmp",
    // Git never looks above Claude Code's own working folder.
    GIT_CEILING_DIRECTORIES: CONTAINER_WORK,
    ...(opts.bare === true ? { CLAUDE_CODE_SIMPLE: "1" } : {}),
    ...QUIET,
    ANTHROPIC_BASE_URL: `http://${RELAY_ALIAS}:${RELAY_PORT}`,
    // The listener's per-run token, as the API key Claude Code sends to it. Never the provider key.
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
}

/** The spawn's environment: Runner's, plus only the SDK's own names in `SDK_ENV_NAMES`, never over Runner's. */
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
  if (Object.keys(env).some((n) => /DBUS|SSH_AUTH|KEYCHAIN|GITHUB|AWS_|CLOUDFLARE|PODSTER|DOCKER/i.test(n))) return "env";
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
  | { kind: "spawned"; run_ref: string }
  | { kind: "init"; run_ref: string; claude_code_version: string; permission_mode: string; tools: string[]; mcp_servers: string[]; plugins: string[]; api_key_source: string; cwd_ok: boolean }
  | { kind: "exec_exit"; run_ref: string; code: number | null; signal: string | null; stderr_bytes: number }
  | { kind: "listener_refused"; run_ref: string; code: string }
  | { kind: "result"; run_ref: string; subtype: string; is_error: boolean }
  | { kind: "hook"; run_ref: string; subtype: string; hook_event: string; hook_name: string; origin: boolean }
  | { kind: "callback"; run_ref: string; tool: string };

type Live = { child: ExecClient | null; exited: Promise<void> | null; listener: BrokerListener | null; abort: AbortController; dir: string };
/** How long a stop waits for the `docker exec` client to exit after it is killed. */
const EXEC_EXIT_WAIT_MS = 5_000;
const exitedOf = (child: ExecClient) => child.exitCode !== null || (child.signalCode ?? null) !== null;

export type ClaudeDriverDeps = {
  home: string;
  installed: { sdk: unknown; claude_code: unknown };
  /** Docker, for the run's network and containers. */
  docker: DockerCli;
  /** The `docker` program, for the exec client that carries Claude Code's standard input and output. */
  dockerProgram: string;
  /** Docker's own settings for that client: `DOCKER_CONFIG`, `DOCKER_HOST`. Nothing else is taken from it. */
  dockerEnv: Record<string, string | undefined>;
  /** Claude Code's image, pinned by its image ID. */
  claudeImage: string;
  uid: number;
  gid: number;
  sdk?: ClaudeSdk;
  processes?: ProcessControl;
  listen?: (deps: ListenerDeps) => Promise<BrokerListener>;
  log?: Logger;
  observe?: (event: DriverObservation) => void;
  /** Bare mode; `claudeEngine` always sets it. */
  bare?: boolean;
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
  private readonly homeLabel: string;
  private readonly live = new Map<string, Live>();

  constructor(deps: ClaudeDriverDeps) {
    const refused = versionRefusal(deps.installed);
    if (refused) throw new Error(`Runner won't run this Claude Agent SDK: ${refused === "sdk_version" ? "the SDK" : "its bundled Claude Code"} isn't the pinned version.`);
    if (!IMAGE_ID.test(deps.claudeImage)) throw new Error("Claude Code's image must be pinned by its sha256 image ID");
    if (!Number.isSafeInteger(deps.uid) || !Number.isSafeInteger(deps.gid) || deps.uid <= 0 || deps.gid < 0) throw new Error("Runner won't run Claude Code's container as root");
    this.deps = deps;
    this.sdk = deps.sdk ?? CLAUDE_SDK;
    this.processes = deps.processes ?? nodeProcesses;
    this.runs = join(deps.home, "runs");
    this.homeLabel = homeLabel(deps.home);
  }

  /** What this driver runs as. */
  get settings(): { bare: boolean; placement: "container" } {
    return { bare: this.deps.bare === true, placement: "container" };
  }

  private log(outcome: string, code?: string) {
    (this.deps.log ?? silentLogger)("adapter.claude", outcome, code ? { code } : {});
  }

  private docker(args: string[]) {
    return this.deps.docker(args, { timeoutMs: LIMITS.docker_ms, maxOutputBytes: 64 * 1024 });
  }

  /** The run's network, relay and Claude Code container; all removed again if any step fails. */
  async prepare(ref: string, port: number, max_seconds: number): Promise<void> {
    if (!REF.test(ref)) throw new Error("run_ref_invalid");
    const names = claudeNames(ref);
    const base = { ref, image: this.deps.claudeImage, uid: this.deps.uid, gid: this.deps.gid, home_label: this.homeLabel, max_seconds };
    const steps = [
      ["network", "create", "--internal", "--label", `${LABEL_RUN}=${ref}`, "--label", `${LABEL_HOME}=${this.homeLabel}`, "--label", `${LABEL_ROLE}=network`, names.network],
      relayRunArgs({ ...base, port }),
      ["network", "connect", "bridge", names.relay],
      claudeRunArgs(base),
    ];
    for (const args of steps) {
      const r = await this.docker(args);
      if (r.code !== 0) {
        await this.teardown(ref).catch(() => undefined);
        throw new Error("claude_container_failed");
      }
    }
  }

  /** Removes the run's Claude Code container, relay and network, by label and by name. */
  async teardown(ref: string): Promise<void> {
    if (!REF.test(ref)) throw new Error("run_ref_invalid");
    const names = claudeNames(ref);
    const ids = await this.list("ps", [`label=${LABEL_RUN}=${ref}`, `label=${LABEL_ROLE}`]);
    const rm = await this.docker(["rm", "--force", ...ids, names.container, names.relay]);
    if (rm.code !== 0 && rm.code !== 1) throw new Error("docker_failed");
    const networks = await this.list("network", [`label=${LABEL_RUN}=${ref}`]);
    if (networks.length > 0) {
      const r = await this.docker(["network", "rm", ...networks]);
      if (r.code !== 0) throw new Error("docker_failed");
    }
  }

  private async list(kind: "ps" | "network", filters: string[]): Promise<string[]> {
    const args = kind === "ps" ? ["ps", "--all", "--quiet", "--no-trunc"] : ["network", "ls", "--quiet", "--no-trunc"];
    const r = await this.docker([...args, ...filters.flatMap((f) => ["--filter", f])]);
    if (r.code !== 0 || r.cut) throw new Error("docker_failed");
    const ids = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (!ids.every((id) => /^[A-Za-z0-9_.-]{1,128}$/.test(id))) throw new Error("docker_failed");
    return ids;
  }

  async begin(session: DriverSession): Promise<DriverRun> {
    const ref = session.run_ref;
    if (!REF.test(ref)) throw new Error("run_ref_invalid");
    await ensureFolder(this.deps.home, this.runs);
    const root = await freshFolder(join(this.runs, ref));
    const live: Live = { child: null, exited: null, listener: null, abort: new AbortController(), dir: root };
    this.live.set(ref, live);
    let failure: string | null = null;
    const fail = (code: string) => {
      if (failure === null) {
        failure = code;
        this.log("failed", code);
      }
      live.abort.abort();
    };
    session.signal.addEventListener("abort", () => live.abort.abort(), { once: true });

    // Nothing goes through until a valid init has been read: a call waits for it, bounded, and a run whose init never
    // comes, or comes malformed, fails.
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

    // The listener stays on the host's loopback; the relay reaches it, so the Host it sees is the relay's.
    live.listener = await (this.deps.listen ?? startBrokerListener)({
      model: async (r) => ((await waitForInit()) ? session.model(r) : { ok: false, refused: "run_stopped" }),
      signal: session.signal,
      host: `${RELAY_ALIAS}:${RELAY_PORT}`,
      onRefuse: (code) => this.deps.observe?.({ kind: "listener_refused", run_ref: ref, code }),
    });
    const max_seconds = Math.ceil(session.limits.run_time_ms / 1000) + CONTAINER_MARGIN_S;
    await this.prepare(ref, live.listener.port, max_seconds);
    const env = claudeEnv(live.listener.token, session.limits.max_tokens, { bare: this.deps.bare });

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
      return decision.allow ? {} : deny;
    };

    const handler = (name: string) => async (args: Record<string, unknown>, extra: unknown) => {
      const meta = (extra as { _meta?: Record<string, unknown> } | null)?._meta?.["claudecode/toolUseId"];
      const queue = pending.get(keyOf(name, args)) ?? [];
      let call_id: string | undefined;
      if (typeof meta === "string") {
        // A named call the hook never saw ends the run, with no fallback to matching by input.
        call_id = checked.has(meta) ? meta : undefined;
        const at = queue.indexOf(meta);
        if (at >= 0) queue.splice(at, 1);
      } else {
        call_id = queue.shift();
      }
      if (!initOk) call_id = undefined;
      if (call_id === undefined) {
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

    // Claude Code starts in its own container: the SDK's command is replaced by Claude Code's Linux binary there.
    const spawn = (s: SpawnOptions): SpawnedProcess => {
      if (live.abort.signal.aborted) throw new Error("halted");
      const inner = spawnEnv(env, s.env);
      const client: Record<string, string> = { ...inner };
      for (const name of ["DOCKER_CONFIG", "DOCKER_HOST"]) {
        const value = this.deps.dockerEnv[name];
        if (value !== undefined) client[name] = value;
      }
      const child = this.processes.spawn(this.deps.dockerProgram, claudeExecArgs(ref, Object.keys(inner), s.args), { cwd: root, env: client });
      live.child = child;
      live.exited = new Promise<void>((resolve) => {
        if (exitedOf(child)) return resolve();
        child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
          // Its exit code and how much it wrote to standard error, never what it wrote.
          this.deps.observe?.({ kind: "exec_exit", run_ref: ref, code, signal: signal ?? null, stderr_bytes: child.stderrBytes?.() ?? 0 });
          if (!initOk && failure === null) fail("exec_exited");
          resolve();
        });
      });
      this.deps.observe?.({ kind: "spawned", run_ref: ref });
      return child;
    };

    const options = claudeOptions({ session, cwd: CONTAINER_WORK, env, mcp, hook, spawn, abortController: live.abort });
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
            this.deps.observe?.({ kind: "init", run_ref: ref, ...init, api_key_source: typeof m.apiKeySource === "string" && /^[A-Za-z_ /]{1,40}$/.test(m.apiKeySource) ? m.apiKeySource : "other", cwd_ok: m.cwd === CONTAINER_WORK });
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
            const origin = Object.hasOwn(m, "origin");
            this.deps.observe?.({ kind: "hook", run_ref: ref, subtype: m.subtype, hook_event: event, hook_name: hookName, origin });
            // Only Runner's own PreToolUse callback may run: by its event, its name, and no origin (failing closed).
            if (event !== "PreToolUse" || !RUNNER_HOOK_NAMES.includes(hookName) || origin) fail("hook_unexpected");
          } else if (m.type === "result") {
            this.deps.observe?.({ kind: "result", run_ref: ref, subtype: typeof m.subtype === "string" && /^[a-z_]{1,40}$/.test(m.subtype) ? m.subtype : "other", is_error: m.is_error === true });
            if (!initOk) fail("init_missing");
            result = m.subtype === "success" ? (m.structured_output ?? null) : null;
          }
        }
      } catch {
        // The SDK's own error carries text from Claude Code: never kept, only that it happened.
        if (failure === null) {
          // An exec client that exited first is the reason; give its exit a moment to be seen.
          if (live.child && !initOk) await Promise.race([live.exited, new Promise((r) => setTimeout(r, 50))]);
          if (failure === null) fail("sdk_error");
        }
      }
      if (failure === null && !initOk) fail("init_missing");
      if (failure !== null) throw new Error(failure);
      return { result };
    })();
    done.catch(() => undefined);

    return { done, cancel: () => this.stop(ref) };
  }

  /** Ends the exec client, the listener and the run's containers and network, at once, and waits for the client to exit. */
  private async stop(ref: string) {
    const live = this.live.get(ref);
    if (live) {
      live.abort.abort();
      if (live.child && !exitedOf(live.child)) live.child.kill("SIGKILL");
      await live.listener?.close();
    }
    await this.teardown(ref);
    if (live?.exited) await Promise.race([live.exited, new Promise((r) => setTimeout(r, EXEC_EXIT_WAIT_MS))]);
  }

  /**
   * Nothing of the run is left: no container, relay or network of it, no `docker exec` client still running (L4), and
   * no listener. A Docker failure is never "gone".
   */
  async confirmGone(run_ref: string): Promise<boolean> {
    if (!REF.test(run_ref)) return false;
    const child = this.live.get(run_ref)?.child;
    if (child && !exitedOf(child)) return false;
    try {
      if ((await this.list("ps", [`label=${LABEL_RUN}=${run_ref}`, `label=${LABEL_ROLE}`])).length > 0) return false;
      if ((await this.list("network", [`label=${LABEL_RUN}=${run_ref}`])).length > 0) return false;
    } catch {
      return false;
    }
    const live = this.live.get(run_ref);
    await live?.listener?.close();
    this.live.delete(run_ref);
    await removeOwnFolder(join(this.runs, run_ref));
    return true;
  }

  /** After a restart (M4 on #459): the run's containers and network go, by label. */
  async reap(run_ref: string): Promise<void> {
    await this.stop(run_ref);
  }

  /** At startup: every Claude Code container, relay and network of this home. */
  async reapAll(): Promise<void> {
    const ids = await this.list("ps", [`label=${LABEL_HOME}=${this.homeLabel}`, `label=${LABEL_ROLE}`]);
    if (ids.length > 0 && (await this.docker(["rm", "--force", ...ids])).code !== 0) throw new Error("docker_failed");
    const networks = await this.list("network", [`label=${LABEL_HOME}=${this.homeLabel}`]);
    if (networks.length > 0 && (await this.docker(["network", "rm", ...networks])).code !== 0) throw new Error("docker_failed");
  }
}

/** The real exec client: from an argument array, never a shell, its errors drained. */
export const nodeProcesses: ProcessControl = {
  spawn(command, args, opts) {
    const child = nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    // Standard error is counted, never kept.
    let stderr = 0;
    child.stderr?.on("data", (d: Buffer) => void (stderr += d.length));
    child.on("error", () => undefined);
    return Object.assign(child, { stderrBytes: () => stderr }) as unknown as ExecClient;
  },
};

type InitFacts = { claude_code_version: string; permission_mode: string; tools: string[]; mcp_servers: string[]; plugins: string[] };
/** The init message's facts in exactly their shape, or null. */
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
