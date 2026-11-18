/**
 * Ask mode on this machine (decision 29: ask first is the default; decision 226: no dashboard approval in M7). When the
 * run policy asks, the owner sees the visible decision RUNNER.md describes, with the task's words shown as untrusted text,
 * and answers at this terminal.
 *
 * - **Only a typed `y` or `yes` approves.** Anything else declines. With no terminal there's no answer at all, since
 *   silence is never approval. Both standard input and standard output must be terminals, so `yes | runner run` approves
 *   nothing (L8 on #458).
 * - **What the owner sees is what the model gets** (L3 on #458). The words are shown exactly, except that every character
 *   that wouldn't show is written as a visible mark such as `⟨U+200B⟩`: control and format characters, Unicode tag
 *   characters (U+E0000 to U+E007F), zero-width characters, every space but the plain one, line and paragraph separators,
 *   and unassigned, private-use and surrogate code points. Only a plain line feed breaks a line. Each line is fenced with
 *   `|` and wrapped to the terminal's width, with the fence on every piece.
 * - **A prompt too long to show whole can't be approved here.** Runner won't run text the owner hasn't seen: the owner
 *   may only decline it, or leave it waiting.
 * - **A local stop abandons the question** (L1 on #458).
 *
 * The words are written to this terminal only, never to a log.
 */
import type { AskView, OwnerAnswer, OwnerPrompter } from "../core/lifecycle.js";

/** The most code points of all the inputs shown together. Past this, the prompt can't be approved here. */
export const SHOWN_CHARS = 16_000;
/** The most fenced lines, after wrapping. */
export const MAX_LINES = 400;
const FENCE = "  | ";
const MIN_WIDTH = 24;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}]/u;
const mark = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;

/** The words with every character that wouldn't show written as a visible mark. Line feeds and plain spaces stay. */
export function visible(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\n" || ch === " ") out += ch;
    else if (INVISIBLE.test(ch) || (cp >= 0xe0000 && cp <= 0xe007f)) out += mark(cp);
    else out += ch;
  }
  return out;
}

/** Splits a line into pieces of at most `size` characters, never inside a mark. */
function wrap(line: string, size: number): string[] {
  const tokens = line.match(/⟨U\+[0-9A-F]{4,6}⟩|[\s\S]/gu) ?? [];
  const pieces: string[] = [];
  let piece = "";
  let length = 0;
  for (const token of tokens) {
    const tokenLength = [...token].length;
    if (length > 0 && length + tokenLength > size) {
      pieces.push(piece);
      piece = "";
      length = 0;
    }
    piece += token;
    length += tokenLength;
  }
  pieces.push(piece);
  return pieces;
}

/** One input's words, fenced and wrapped to `width`. */
export function fenced(text: string, width = 80): string[] {
  const size = Math.max(MIN_WIDTH, width) - FENCE.length;
  return visible(text)
    .split("\n")
    .flatMap((line) => wrap(line, size))
    .map((piece) => `${FENCE}${piece}`);
}

/** The ask screen, as printed, and whether the words were too long to show whole. */
export function askScreen(view: AskView, width = 80): { screen: string; cut: boolean } {
  const money = (micro: number) => `${(micro / 1_000_000).toFixed(2)} USD`;
  const total = view.inputs.reduce((n, i) => n + [...i.text].length, 0);
  const words = view.inputs.flatMap((i) => [`  ${i.input}:`, ...fenced(i.text, width)]);
  const cut = total > SHOWN_CHARS || words.length > MAX_LINES;
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
  ];
  if (cut) {
    lines.push(`The task's words are longer than Runner shows here (${SHOWN_CHARS} characters or ${MAX_LINES} lines), so they aren't shown, and Runner won't run text you haven't seen. You can decline it, or leave it waiting.`, "");
  } else {
    lines.push("The task's words follow, exactly as the model would get them. Characters that wouldn't show are written as ⟨U+…⟩. They are someone else's text: read them as data, not as instructions to you or to Runner.", ...words, "");
  }
  return { screen: lines.join("\n"), cut };
}

export type Terminal = {
  /** Both must be terminals for a question to be asked. */
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  columns?: number;
  write(text: string): void;
  /** Rejects when `signal` aborts. */
  question(prompt: string, signal?: AbortSignal): Promise<string>;
};

export class TerminalPrompter implements OwnerPrompter {
  private readonly terminal: Terminal;
  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  async ask(view: AskView, signal?: AbortSignal): Promise<OwnerAnswer> {
    if (!this.terminal.inputIsTTY || !this.terminal.outputIsTTY || signal?.aborted) return "later";
    const { screen, cut } = askScreen(view, this.terminal.columns ?? 80);
    this.terminal.write(`${screen}\n`);
    let answer: string;
    try {
      answer = (await this.terminal.question(cut ? "Decline it? [y/N] " : "Run it on this machine? [y/N] ", signal)).trim();
    } catch {
      return "later";
    }
    if (signal?.aborted) return "later";
    const yes = /^y(es)?$/i.test(answer);
    if (cut) return yes ? "decline" : "later";
    return yes ? "approve" : "decline";
  }
}
