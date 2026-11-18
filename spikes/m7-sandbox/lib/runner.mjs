// The stand-in Runner's adapter for the Claude Agent SDK. It owns, as the M7 plan's adapter interface
// says: the decision point for each tool call (a PreToolUse hook that runs `decide`), Runner's own spend,
// turn and run-time caps with a hard stop, cancellation, and parsing the final result. The provider key is
// only in the broker. Two placements of the Claude Code process are tried:
//
// - "outside": the SDK's Claude Code process runs on the host in an empty Runner folder, with every
//   built-in tool removed. The task's only tools are in-process MCP tools whose handlers `docker exec`
//   into the task container, which has no network at all.
// - "inside": the Linux Claude Code binary runs inside the task container (spawnClaudeCodeProcess), with
//   its built-in tools, and reaches the provider only through relay:8080, which forwards to the broker.
//
// The record it returns carries IDs, tool names, rule names, counts and times: no task text, model text,
// command or key.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { childEnv, forbidden } from "../../../e2e/child-env.mjs";
import { startBroker, PLACEHOLDER } from "./broker.mjs";
import { decide, sdkPermissions } from "./policy.mjs";
import { docker, dockerAsync } from "./docker.mjs";

export const MODEL = "claude-haiku-5-5";

const QUIET = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: MODEL,
};

/** SDK-set variables passed on by name, if childEnv's guard doesn't refuse the name. */
function sdkVars(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {}))
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k) && !forbidden(k) && v !== undefined) out[k] = v;
  return out;
}

const now = () => Date.now();

/**
 * @param {object} o
 * @param {string} o.id run ID
 * @param {"outside"|"inside"} o.mode
 * @param {"refuse"|"open"} o.sdkLock the SDK's own permission system: dontAsk with an allow list, or bypass
 * @param {object} o.policy Runner's run policy (see policy.mjs)
 * @param {{usd?:number, turns?:number, ms?:number}} o.caps Runner's caps
 * @param {{maxBudgetUsd?:number, maxTurns?:number}} o.sdkCaps the SDK's own caps
 */
export async function runTask(o) {
  const {
    id, mode, sdkLock, policy, prompt, env: dockerEnvVars, container, scratch, keyFile,
    caps = {}, sdkCaps = {}, systemPrompt, outputFormat, settingSources = [], strictMcpConfig = true,
    builtinTools = ["Bash", "Read", "Write"], relayHost = "relay", verbatimPrompts, canary, maxOutputTokens, brokerClamp, reserve,
  } = o;
  // A per-request output cap. childEnv refuses *TOKEN* names; this is a number, not a secret, so it is
  // added by name after the guard, like the placeholder.
  const outCap = maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) } : {};
  const quiet = QUIET;
  const rec = {
    id, mode, sdkLock, model: MODEL, maxOutputTokens: maxOutputTokens ?? null,
    caps: { usd: caps.usd ?? null, turns: caps.turns ?? null, ms: caps.ms ?? null }, sdkCaps,
    decisions: [], toolUses: [], executions: [], spawn: null, init: null, result: null, times: {},
    assistantMessages: 0, errors: [],
  };
  const t0 = now();
  const abortController = new AbortController();
  let child = null;

  let stopping = null;
  const hardStop = (kind) => (stopping ??= doStop(kind));
  const doStop = async (kind) => {
    rec.times.stopAt = now() - t0;
    rec.stopKind = kind;
    policy.stopped = kind;
    broker.stop(kind);
    abortController.abort();
    // The process tree: killing a `docker exec` client leaves its process running in the container,
    // so Runner's stop kills the task container's processes. The container is rebuilt per task.
    const k = await dockerAsync(dockerEnvVars, ["kill", "--signal", "KILL", container]);
    rec.times.containerKilledAt = now() - t0;
    rec.containerKill = k.status === 0 ? "killed" : "failed";
  };

  const broker = await startBroker({
    keyFile,
    canary,
    maxOutputTokens: brokerClamp ?? null,
    reserve: !!reserve,
    models: [MODEL],
    caps: { usd: caps.usd ?? Infinity, turns: caps.turns ?? Infinity },
    onCap: (kind) => {
      rec.times.capAt = now() - t0;
      hardStop(kind);
    },
  });
  await o.onBroker?.(broker.port);
  rec.times.timerStartAt = now() - t0;
  const timer = caps.ms ? setTimeout(() => hardStop("time"), caps.ms) : null;

  // Runner's decision point: every tool call, built-in or MCP, reaches this before it runs.
  const preToolUse = async (input) => {
    const d = decide(policy, input.tool_name, input.tool_input);
    rec.decisions.push({ toolUseId: input.tool_use_id, tool: input.tool_name, allow: d.allow, rule: d.rule, t: now() - t0, key: JSON.stringify(input.tool_input) });
    if (d.allow) return {}; // no opinion: the SDK's own permission system still decides (second lock)
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Refused by Runner's run policy (${d.rule}).` },
    };
  };

  // Outside: the task's tools, executed in the task container. The handlers deliberately don't recheck
  // the policy, so a refused call that ran would show here.
  const execIn = async (name, args, input) => {
    rec.executions.push({ tool: name, t: now() - t0, key: JSON.stringify(input) });
    const r = await dockerAsync(dockerEnvVars, ["exec", "-i", container, ...args], { timeoutMs: 120_000 });
    return { content: [{ type: "text", text: (r.stdout + r.stderr).slice(0, 2000) || `(exit ${r.status})` }] };
  };
  const taskServer = createSdkMcpServer({
    name: "task",
    version: "0.0.0",
    tools: [
      tool("sh", "Run a shell command in the task's container, in /work.", { command: z.string() }, (a) =>
        execIn("mcp__task__sh", ["sh", "-c", a.command], a),
      ),
      tool("write", "Write a file in the task's container.", { path: z.string(), content: z.string() }, (a) =>
        execIn("mcp__task__write", ["sh", "-c", 'printf %s "$2" > "$1"', "_", a.path, a.content], a),
      ),
    ],
  });

  const runnerDir = mkdtempSync(join(scratch, `run-${id}-`));
  const home = join(runnerDir, "home");
  mkdirSync(home);
  const allow = Object.keys(policy.tools);

  const spawnClaude = (s) => {
    rec.spawn = { command: s.command.split("/").pop(), args: s.args.filter((a) => a.startsWith("--")), sdkEnvNames: Object.keys(s.env ?? {}).sort() };
    if (mode === "outside") {
      const env = { ...childEnv({ ...quiet, ...sdkVars(s.env), HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${broker.port}` }) };
      env.ANTHROPIC_API_KEY = PLACEHOLDER; // childEnv refuses *KEY* names; this is not a secret, the key is in the broker
      Object.assign(env, outCap);
      rec.spawn.childEnvNames = Object.keys(env).sort();
      child = spawn(s.command, s.args, { cwd: runnerDir, env, stdio: ["pipe", "pipe", "pipe"], signal: s.signal });
    } else {
      const inner = { ...quiet, ...sdkVars(s.env), HOME: "/home/task", CLAUDE_CONFIG_DIR: "/home/task/.claude", ANTHROPIC_BASE_URL: `http://${relayHost}:8080`, ANTHROPIC_API_KEY: PLACEHOLDER, ...outCap };
      rec.spawn.childEnvNames = Object.keys(inner).sort();
      const flags = Object.entries(inner).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      child = spawn("docker", ["exec", "-i", "-w", "/work", ...flags, container, "/opt/claude/claude", ...s.args], { env: dockerEnvVars, stdio: ["pipe", "pipe", "pipe"], signal: s.signal });
    }
    child.on("exit", () => (rec.times.processExitAt = now() - t0));
    child.stderr.on("data", () => (rec.stderrBytes = (rec.stderrBytes ?? 0) + 1));
    child.on("error", () => {});
    return child;
  };

  const options = {
    model: MODEL,
    abortController,
    cwd: mode === "outside" ? runnerDir : "/work",
    env: { PATH: process.env.PATH },
    settingSources,
    strictMcpConfig,
    persistSession: false,
    systemPrompt: systemPrompt ?? "You are a task agent. Use only the tools you are given. Be brief.",
    effort: "low",
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    spawnClaudeCodeProcess: spawnClaude,
    ...(mode === "outside"
      ? { tools: [], mcpServers: { task: taskServer } }
      : { tools: builtinTools }),
    ...sdkPermissions(sdkLock, allow),
    ...(sdkCaps.maxTurns ? { maxTurns: sdkCaps.maxTurns } : {}),
    ...(sdkCaps.maxBudgetUsd ? { maxBudgetUsd: sdkCaps.maxBudgetUsd } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(verbatimPrompts !== undefined ? { verbatimPrompts } : {}),
  };

  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "system" && m.subtype === "init") {
        rec.init = {
          claudeCodeVersion: m.claude_code_version, model: m.model, permissionMode: m.permissionMode,
          tools: m.tools, mcpServers: (m.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`),
          slashCommands: (m.slash_commands ?? []).length, agents: m.agents ?? [], skills: (m.skills ?? []).length,
          plugins: (m.plugins ?? []).map((p) => p.name ?? p), outputStyle: m.output_style ?? null,
        };
      }
      if (m.type === "assistant") {
        rec.assistantMessages++;
        for (const b of m.message?.content ?? [])
          if (b.type === "tool_use") rec.toolUses.push({ toolUseId: b.id, tool: b.name, t: now() - t0, key: JSON.stringify(b.input) });
      }
      if (m.type === "result") {
        rec.result = {
          subtype: m.subtype, isError: m.is_error, numTurns: m.num_turns, totalCostUsd: m.total_cost_usd,
          stopReason: m.stop_reason ?? null, permissionDenials: (m.permission_denials ?? []).map((d) => d.tool_name),
          hasStructuredOutput: m.structured_output !== undefined, durationMs: m.duration_ms,
        };
        rec.rawStructured = m.structured_output; // kept in memory for (d); not written to results
        rec.finalText = typeof m.result === "string" ? m.result : null; // in memory only
      }
    }
  } catch (e) {
    rec.errors.push(String(e?.name ?? "Error") + ":" + String(e?.message ?? "").slice(0, 120).replace(/sk-ant-[\w-]+/g, "[redacted]"));
  }
  rec.times.iteratorEndAt = now() - t0;
  if (timer) clearTimeout(timer);
  await new Promise((r) => (child && child.exitCode === null && child.signalCode === null ? child.once("exit", r) && setTimeout(r, 5000) : r()));
  if (stopping) await stopping;
  rec.broker = { ...broker.state };
  await broker.close();
  return rec;
}
