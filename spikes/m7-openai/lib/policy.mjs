// The stand-in for Runner's run policy and result check, for one task. Pure.
//
// A task's policy names the tools it may use, the exact shell commands allowed, and whether writes are allowed.
// `decide` is the decision point every function tool calls before it runs; the model never decides.

export const REFUSAL_TEXT = "Runner refused this tool call. It was not run.";
export const TOOL_OUTPUT_LIMIT = 16 * 1024;

/** The tools' fixed descriptions and strict JSON schemas. */
export const TOOL_SPECS = Object.freeze({
  shell: {
    description: "Run one shell command in the task's folder (/work). Only commands the run allows are run.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
  },
  read_file: {
    description: "Read a text file in the task's folder, by a path relative to it.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  write_file: {
    description: "Write a text file in the task's folder, by a path relative to it, replacing it if it exists.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
});

/** The result tool's schema. Strict mode needs every property required; the bounds are checked by `boundResult`. */
export const RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "failed"] },
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "files"],
  additionalProperties: false,
});

const safePath = (p) =>
  typeof p === "string" && p.length > 0 && p.length <= 200 && !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === ".." || s === "" || s === ".");

/**
 * Decide one call. `policy`: { tools: string[], commands: string[], writes: boolean, stopped?: string }.
 * Returns { allow, rule }.
 */
export function decide(policy, name, input) {
  if (policy.stopped) return { allow: false, rule: `stopped:${policy.stopped}` };
  if (name === "StructuredOutput") return { allow: true, rule: "result" };
  if (!policy.tools.includes(name)) return { allow: false, rule: "tool_not_allowed" };
  if (input === null || typeof input !== "object") return { allow: false, rule: "input" };
  if (name === "shell") {
    return policy.commands.includes(input.command) ? { allow: true, rule: "command_listed" } : { allow: false, rule: "command_not_listed" };
  }
  if (name === "read_file") return safePath(input.path) ? { allow: true, rule: "path" } : { allow: false, rule: "path" };
  if (name === "write_file") {
    if (!policy.writes) return { allow: false, rule: "writes_off" };
    if (!safePath(input.path)) return { allow: false, rule: "path" };
    if (typeof input.content !== "string" || input.content.length > 64 * 1024) return { allow: false, rule: "content" };
    return { allow: true, rule: "path" };
  }
  return { allow: false, rule: "tool_unknown" };
}

/** Runner's own bound on the result, whatever the model's schema check did. */
export function boundResult(r) {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return { ok: false, problems: ["not-object"] };
  const problems = [];
  const keys = Object.keys(r);
  if (keys.some((k) => !["status", "summary", "files"].includes(k))) problems.push("extra-fields");
  if (r.status !== "done" && r.status !== "failed") problems.push("bad-status");
  if (typeof r.summary !== "string" || r.summary.length > 500) problems.push("bad-summary");
  if (!Array.isArray(r.files) || r.files.length > 10 || !r.files.every(safePath)) problems.push("bad-files");
  return { ok: problems.length === 0, problems };
}

/** Bound a tool's output for the model. */
export function boundOutput(text) {
  const s = String(text ?? "");
  return s.length > TOOL_OUTPUT_LIMIT ? `${s.slice(0, TOOL_OUTPUT_LIMIT)}\n[output cut at ${TOOL_OUTPUT_LIMIT} characters]` : s;
}
