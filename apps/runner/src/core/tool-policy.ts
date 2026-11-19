/**
 * Runner's decision on each tool call (M7 step 9(a); the architect's ruling 2 of 2026-11-17; decision 29's condition 2;
 * S-37, S-41). Pure: the run's facts and the call in, allow or refuse out.
 *
 * - **Only Runner's own tools,** by their names in the run policy (`read`, `search`, `write`, `edit`, `shell`), and the
 *   result tool the policy names (spike B ruling 2). Any other name refuses: an SDK's built-in tools, a repository's MCP
 *   tools, subagents and skills included.
 * - **No shell unless the policy names it.** Network is the container's, from the policy's hosts (`run-interface.ts`).
 * - **Every path stays inside the task's folder:** relative, without `..` or empty segments, and without backslashes or
 *   control characters. A `.` segment is dropped. Git's own folder is refused too, at any depth: Runner's own Git works on
 *   this folder later (step 10), and hooks or config written there would act outside the container.
 * - **Each tool's input in exactly its shape;** anything else refuses.
 * - **The structured result is bounded** here, so an oversize one is refused at the decision point as well as after.
 *
 * Symbolic links can't be judged here; the container, with only the task's folder mounted, is the boundary for them.
 * Agent content is data: a call's input is checked, never followed as instructions, and a decision carries codes only.
 */
import { RESULT_TOOL, type RunFacts, type Tool } from "./policy.js";

export const MAX_PATH_CHARS = 1_024;
export const MAX_CONTENT_CHARS = 1_000_000;
export const MAX_COMMAND_CHARS = 8_000;
export const MAX_PATTERN_CHARS = 1_000;
export const MAX_SUMMARY_CHARS = 2_000;
export const MAX_RESULT_FILES = 100;

export type ToolCall = { call_id: string; tool: string; input: unknown };

export type AllowedCall =
  | { call_id: string; tool: "read"; path: string }
  | { call_id: string; tool: "search"; pattern: string; path: string }
  | { call_id: string; tool: "write"; path: string; content: string }
  | { call_id: string; tool: "edit"; path: string; old: string; new: string }
  | { call_id: string; tool: "shell"; command: string }
  | { call_id: string; tool: typeof RESULT_TOOL; result: RunResult };

export type ToolRefusal = "call_invalid" | "tool_not_allowed" | "shell_not_allowed" | "input_invalid" | "path_outside_folder" | "path_not_allowed" | "result_invalid" | "run_stopped";

export type ToolDecision = { allow: true; call: AllowedCall } | { allow: false; reason: ToolRefusal };

/** A run's structured result: bounded, and only ever data. */
export type RunResult = { status: "completed" | "blocked"; summary: string; files: string[] };

const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Control characters, other than tab and newline in free text. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const PATH_BAD = /[\u0000-\u001f\u007f-\u009f\\]/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Exactly these keys: every one in `required`, others only from `optional`. */
function shaped(v: unknown, required: string[], optional: string[] = []): v is Obj {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return required.every((k) => Object.hasOwn(v, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
const text = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;

/** A path inside the task's folder, written plainly: `src/./a.ts` is `src/a.ts`; `.` (the folder) only when allowed. */
export function taskPath(raw: unknown, folderAllowed = false): { ok: true; path: string } | { ok: false; reason: "path_outside_folder" | "path_not_allowed" } {
  const outside = { ok: false as const, reason: "path_outside_folder" as const };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_CHARS || PATH_BAD.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return outside;
  const segments = raw.split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === ".." || segment === "") return outside;
    if (segment === ".") continue;
    if (segment.toLowerCase() === ".git") return { ok: false, reason: "path_not_allowed" };
    kept.push(segment);
  }
  if (kept.length === 0) return folderAllowed ? { ok: true, path: "." } : outside;
  return { ok: true, path: kept.join("/") };
}

/** The structured result, bounded: a status, a summary of at most `MAX_SUMMARY_CHARS`, and files inside the folder. */
export function parseRunResult(v: unknown): { ok: true; value: RunResult } | { ok: false } {
  if (!shaped(v, ["status", "summary", "files"])) return { ok: false };
  if (v.status !== "completed" && v.status !== "blocked") return { ok: false };
  if (!text(v.summary, MAX_SUMMARY_CHARS, 1) || CONTROL.test(v.summary)) return { ok: false };
  if (!Array.isArray(v.files) || v.files.length > MAX_RESULT_FILES) return { ok: false };
  const files: string[] = [];
  for (const f of v.files) {
    const path = taskPath(f);
    if (!path.ok || files.includes(path.path)) return { ok: false };
    files.push(path.path);
  }
  return { ok: true, value: { status: v.status, summary: v.summary, files } };
}

/** Whether the run's facts allow this call, and the call as Runner will run it. */
export function decideToolCall(facts: Pick<RunFacts, "tools" | "shell" | "result_tool">, call: unknown): ToolDecision {
  const refuse = (reason: ToolRefusal): ToolDecision => ({ allow: false, reason });
  if (!shaped(call, ["call_id", "tool", "input"]) || typeof call.call_id !== "string" || !CALL_ID.test(call.call_id) || typeof call.tool !== "string") return refuse("call_invalid");
  const call_id = call.call_id;
  const input = call.input;

  if (call.tool === facts.result_tool && call.tool === RESULT_TOOL) {
    const result = parseRunResult(input);
    return result.ok ? { allow: true, call: { call_id, tool: RESULT_TOOL, result: result.value } } : refuse("result_invalid");
  }
  const tool = call.tool as Tool;
  if (tool === "shell") {
    if (!facts.shell || !facts.tools.includes("shell")) return refuse("shell_not_allowed");
    if (!shaped(input, ["command"]) || !text(input.command, MAX_COMMAND_CHARS, 1) || input.command.includes("\u0000")) return refuse("input_invalid");
    return { allow: true, call: { call_id, tool, command: input.command } };
  }
  if ((tool !== "read" && tool !== "search" && tool !== "write" && tool !== "edit") || !facts.tools.includes(tool)) return refuse("tool_not_allowed");

  if (tool === "search") {
    if (!shaped(input, ["pattern"], ["path"]) || !text(input.pattern, MAX_PATTERN_CHARS, 1) || input.pattern.includes("\u0000")) return refuse("input_invalid");
    const path = taskPath(input.path ?? ".", true);
    if (!path.ok) return refuse(path.reason);
    return { allow: true, call: { call_id, tool, pattern: input.pattern, path: path.path } };
  }
  const fields = tool === "read" ? [] : tool === "write" ? ["content"] : ["old", "new"];
  if (!shaped(input, ["path", ...fields]) || !fields.every((f) => text(input[f], MAX_CONTENT_CHARS))) return refuse("input_invalid");
  const path = taskPath(input.path);
  if (!path.ok) return refuse(path.reason);
  if (tool === "read") return { allow: true, call: { call_id, tool, path: path.path } };
  if (tool === "write") return { allow: true, call: { call_id, tool, path: path.path, content: input.content as string } };
  return { allow: true, call: { call_id, tool, path: path.path, old: input.old as string, new: input.new as string } };
}
