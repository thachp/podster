/**
 * Runner's decision on each tool call (M7 step 9(a); the architect's ruling 2 of 2026-11-17; decision 29's condition 2;
 * S-37, S-41). Pure: the run's facts and the call in, allow or refuse out.
 *
 * - **Only Runner's own tools,** by their names in the run policy (`read`, `search`, `write`, `edit`, `shell`), and the
 *   result tool the policy names (spike B ruling 2). Any other name refuses: an SDK's built-in tools, a repository's MCP
 *   tools, subagents and skills included.
 * - **No shell unless the policy names it.** Network is the container's, from the policy's hosts (`run-interface.ts`).
 * - **Every path stays inside the task's folder:** relative, or under `/work`, the folder's own name in both containers
 *   and Claude Code's working folder there; without `..` or empty segments, and without backslashes or control
 *   characters. A `.` segment is dropped, and a folder's path (search's) may end in one `/`. The real run of 2026-11-19
 *   showed a call naming a file the model's own way being refused as outside the folder, so only the one fixed prefix
 *   is taken off; what follows it is checked as any relative path. Git's own folder is refused too, at any depth: Runner's own Git works on
 *   this folder later (step 10), and hooks or config written there would act outside the container. Segments are compared
 *   folded (compatibility-normalised, marks and default-ignorable characters removed, case folded), so no look-alike of
 *   `.git` passes, and a segment ending in a space or a dot is refused, as some file systems drop them (L2 on #459).
 * - **No segment starts with `-`,** so no path reads as an option to the program running a tool (L1 on #459). Step
 *   9(b)'s sandbox runs each tool from an argument array with no shell: search as `rg` with fixed flags, `-e PATTERN --
 *   ./path`; read, write and edit never through a shell.
 * - **Each tool's input in exactly its shape;** anything else refuses.
 * - **The structured result is bounded** here, so an oversize one is refused at the decision point as well as after.
 *
 * Symbolic links can't be judged here; the container, with only the task's folder mounted, is the boundary for them.
 * Agent content is data: a call's input is checked, never followed as instructions, and a decision carries codes only.
 */
import { RESULT_TOOL, type RunFacts, type Tool } from "./policy.js";
import { isChangeType, type ChangeType } from "./pull-text.js";

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

/**
 * A run's structured result: bounded, and only ever data. `change_type` is the kind of change the agent says it made,
 * kept only when it is one of `CHANGE_TYPES`; it picks the pull request title's type and nothing else (`pull-text.ts`).
 */
export type RunResult = { status: "completed" | "blocked"; summary: string; files: string[]; change_type?: ChangeType };

const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Control characters, other than tab and newline in free text. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const PATH_BAD = /[\u0000-\u001f\u007f-\u009f\\]/;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const MARKS = /\p{M}/gu;

/** A segment as a file system might see it: compatibility forms, marks and invisible characters gone, case folded. */
export function foldedSegment(segment: string): string {
  return segment.normalize("NFKD").replace(MARKS, "").replace(IGNORABLE, "").toUpperCase().toLowerCase().normalize("NFKC");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Exactly these keys: every one in `required`, others only from `optional`. */
function shaped(v: unknown, required: string[], optional: string[] = []): v is Obj {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return required.every((k) => Object.hasOwn(v, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
const text = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;

/** The task's folder, as both containers name it: mounted there in the task's, and Claude Code's working folder in its own. */
export const TASK_FOLDER_IN_CONTAINER = "/work";

/**
 * A path inside the task's folder, written plainly: `src/./a.ts` and `/work/src/a.ts` are `src/a.ts`; `.` (the folder),
 * `/work` and a trailing `/` only when a folder is allowed.
 */
export function taskPath(raw: unknown, folderAllowed = false): { ok: true; path: string } | { ok: false; reason: "path_outside_folder" | "path_not_allowed" } {
  const outside = { ok: false as const, reason: "path_outside_folder" as const };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_CHARS || PATH_BAD.test(raw) || /^[A-Za-z]:/.test(raw)) return outside;
  let rel = raw;
  if (rel === TASK_FOLDER_IN_CONTAINER) rel = ".";
  else if (rel.startsWith(`${TASK_FOLDER_IN_CONTAINER}/`)) rel = rel.slice(TASK_FOLDER_IN_CONTAINER.length + 1);
  if (rel.startsWith("/")) return outside;
  if (folderAllowed && rel.endsWith("/")) rel = rel.slice(0, -1);
  if (rel.length === 0) {
    if (!folderAllowed) return outside;
    rel = ".";
  }
  const segments = rel.split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === ".." || segment === "") return outside;
    if (segment === ".") continue;
    const folded = foldedSegment(segment);
    const plain = segment.normalize("NFC").replace(IGNORABLE, "");
    if (folded === ".git" || segment.startsWith("-") || folded.startsWith("-") || /[ .]$/.test(plain) || /[ .]$/.test(folded)) return { ok: false, reason: "path_not_allowed" };
    kept.push(segment);
  }
  if (kept.length === 0) return folderAllowed ? { ok: true, path: "." } : outside;
  return { ok: true, path: kept.join("/") };
}

/**
 * What a refusal tells the model: fixed text for each code, so a model that named a path its own way can name it again
 * the folder's way. Nothing of the call's input is in it.
 */
export function refusalText(reason: ToolRefusal): string {
  switch (reason) {
    case "path_outside_folder":
      return `Runner refused this call: the path is outside the task's folder. Give a path relative to the task's folder, such as notes.txt or src/a.ts; the folder is also ${TASK_FOLDER_IN_CONTAINER}, your working folder.`;
    case "path_not_allowed":
      return "Runner refused this call: that path isn't allowed. Git's own folder, a name starting with - and a name ending in a space or a dot are refused.";
    default:
      return "Runner refused this call.";
  }
}

/**
 * The structured result, bounded: a status, a summary of at most `MAX_SUMMARY_CHARS`, and files inside the folder. An
 * optional `change_type` not on the list is dropped, never a reason to refuse the result: the title's type is then `chore`.
 */
export function parseRunResult(v: unknown): { ok: true; value: RunResult } | { ok: false } {
  if (!shaped(v, ["status", "summary", "files"], ["change_type"])) return { ok: false };
  if (v.status !== "completed" && v.status !== "blocked") return { ok: false };
  if (!text(v.summary, MAX_SUMMARY_CHARS, 1) || CONTROL.test(v.summary)) return { ok: false };
  if (!Array.isArray(v.files) || v.files.length > MAX_RESULT_FILES) return { ok: false };
  const files: string[] = [];
  for (const f of v.files) {
    const path = taskPath(f);
    if (!path.ok || files.includes(path.path)) return { ok: false };
    files.push(path.path);
  }
  return { ok: true, value: { status: v.status, summary: v.summary, files, ...(isChangeType(v.change_type) ? { change_type: v.change_type } : {}) } };
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
