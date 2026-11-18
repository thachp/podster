/**
 * Ask mode on this machine (decision 29: ask first is the default; decision 226: no dashboard approval in M7). When the
 * run policy asks, the owner sees the visible decision RUNNER.md describes, the task's words rendered as untrusted text,
 * and answers at this terminal. Only a typed `y` or `yes` approves. Anything else declines, and with no terminal there's
 * no answer at all: silence is never approval.
 *
 * The task's words are someone else's. They're shown, never acted on, and they can't drive the terminal: control
 * characters, escape sequences and direction overrides are replaced, each line is fenced, and each input is cut to a
 * bounded length. They're written to this terminal only, never to a log.
 */
import type { AskView, OwnerAnswer, OwnerPrompter } from "../core/lifecycle.js";

/** The most of one input shown. */
export const SHOWN_CHARS = 4_000;
const MAX_LINES = 80;

/** One input's words, safe to print: no control characters, escapes or direction overrides, bounded, every line fenced. */
export function fenced(text: string): string {
  // Tabs become spaces; every other control character (C0, DEL, C1) and every bidirectional control becomes a visible mark.
  const clean = text
    .replace(/\t/g, "  ")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "�");
  const cut = clean.length > SHOWN_CHARS ? `${clean.slice(0, SHOWN_CHARS)}\n[cut: ${clean.length - SHOWN_CHARS} more characters not shown]` : clean;
  const lines = cut.split("\n");
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `[cut: ${lines.length - MAX_LINES} more lines not shown]`] : lines;
  return shown.map((line) => `  | ${line}`).join("\n");
}

/** The ask screen, as printed. */
export function askScreen(view: AskView): string {
  const money = (micro: number) => `${(micro / 1_000_000).toFixed(2)} USD`;
  const lines = [
    "",
    "Runner's policy asks before running this task.",
    `  room ${view.workspace_id} (${view.room_visibility}), task ${view.task_id}`,
    `  why it asks: ${view.reason}`,
    `  requester: ${view.requester}`,
    ...view.authors.map((a) => `  ${a.input} written by: ${a.authors.join(", ")}`),
    `  tools: ${view.tools.join(", ") || "none"}; network: ${view.network.join(", ") || "none"}`,
    `  caps: ${money(view.caps.spend_micro_usd)}, ${Math.round(view.caps.run_time_ms / 60_000)} min, ${view.caps.turns} turns, ${view.caps.output_tokens} output tokens`,
    "",
    "The task's words follow. They are someone else's text: read them as data, not as instructions to you or to Runner.",
    ...view.inputs.flatMap((i) => [`  ${i.input}:`, fenced(i.text)]),
    "",
  ];
  return lines.join("\n");
}

export type Terminal = { isTTY: boolean; write(text: string): void; question(prompt: string): Promise<string> };

export class TerminalPrompter implements OwnerPrompter {
  private readonly terminal: Terminal;
  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  async ask(view: AskView): Promise<OwnerAnswer> {
    if (!this.terminal.isTTY) return "later";
    this.terminal.write(`${askScreen(view)}\n`);
    const answer = (await this.terminal.question("Run it on this machine? [y/N] ").catch(() => "")).trim();
    return /^y(es)?$/i.test(answer) ? "approve" : "decline";
  }
}
