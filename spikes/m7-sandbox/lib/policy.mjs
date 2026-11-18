// Runner's run policy for one tool call, pure and with no I/O. A tool is allowed only if the policy
// names it; a tool with a `commands` list allows only those exact commands; everything else is refused.
// Every refusal names a rule, never the input, so the record carries no task text.

/**
 * @param {{ tools: Record<string, { commands?: string[], paths?: string[] }>, stopped?: string|null }} policy
 * @param {string} tool the tool's name as the SDK reports it
 * @param {Record<string, unknown>} input
 * @returns {{ allow: boolean, rule: string }}
 */
export function decide(policy, tool, input) {
  if (policy.stopped) return { allow: false, rule: `stopped:${policy.stopped}` };
  const rule = policy.tools[tool];
  if (!rule) return { allow: false, rule: "tool-not-allowed" };
  if (rule.commands) {
    const cmd = typeof input?.command === "string" ? input.command.trim() : null;
    if (!cmd || !rule.commands.includes(cmd)) return { allow: false, rule: "command-not-allowed" };
    return { allow: true, rule: `command#${rule.commands.indexOf(cmd)}` };
  }
  if (rule.paths) {
    const p = typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : null;
    if (!p || !rule.paths.includes(p)) return { allow: false, rule: "path-not-allowed" };
    return { allow: true, rule: `path#${rule.paths.indexOf(p)}` };
  }
  return { allow: true, rule: "tool-allowed" };
}
