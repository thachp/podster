/**
 * Ask mode on this machine (decision 29: ask first is the default; decision 226: no dashboard approval in M7). When the
 * run policy asks, the owner sees the visible decision RUNNER.md describes, with the task's words shown as untrusted text,
 * and answers at this terminal.
 *
 * - **Only a typed `y` or `yes` approves.** Anything else declines. With no terminal there's no answer at all, since
 *   silence is never approval. Both standard input and standard output must be terminals, so `yes | runner run` approves
 *   nothing (L8 on #458).
 * - **What the owner sees is what the model gets** (L3 on #458). The words are shown exactly, except that every character
 *   that wouldn't show is written as a visible mark such as `⟨U+200B⟩`, by Runner's one marking set (`markHidden`, the
 *   same the submission's note uses): control and format characters, Unicode tag
 *   characters (U+E0000 to U+E007F), zero-width characters, every space but the plain one, line and paragraph separators,
 *   and unassigned, private-use and surrogate code points. Only a plain line feed breaks a line. Each line is fenced with
 *   `|` and wrapped to the terminal's width in columns (wide characters and emoji count two), with the fence on every
 *   piece. Combining marks are marks too, so no character is drawn over another.
 * - **A prompt too long to show whole can't be approved here.** Runner won't run text the owner hasn't seen: the owner
 *   may only decline it, or leave it waiting.
 * - **A local stop abandons the question** (L1 on #458).
 *
 * - **A held result is reviewed here too** (M7 step 11). The owner sees the agent's words exactly as they would be sent,
 *   already redacted and with their hidden characters marked, fenced the same way, and the pull request from Runner's own
 *   records. Only a typed `y` or `yes` shares them; anything else submits the result without them. Words too long to show
 *   whole can't be shared from here: the owner may only withhold them, or leave them held.
 *
 * - **A role invite is answered here too** (issue 522), when the owner's policy for that room doesn't claim invites by
 *   itself. The owner sees the room, the opening's ID, the access preset a claim copies and whether it's a lead opening,
 *   with the opening's title and responsibilities fenced as untrusted text. `y` or `yes` claims it as this agent, `n` or
 *   `no` turns it down, and anything else leaves it, asked again later. Words too long to show whole can't be claimed
 *   from here: the owner may only turn it down, or leave it. Claiming accepts no task and gives no person access.
 *   Runner doesn't wait for this answer before task work (issue 528), so a task's question or a result's review may need
 *   the terminal while it's open: the role question is then set aside (`QuestionInterrupted`) and asked again after.
 *
 * The words are written to this terminal only, never to a log.
 */
import type { AskView, OwnerAnswer, OwnerPrompter } from "../core/lifecycle.js";
import { markHidden, type ResultView } from "../core/results.js";
import { QuestionInterrupted, type RolePrompter, type RoleView } from "../core/roles.js";

/** The most code points of all the inputs shown together. Past this, the prompt can't be approved here. */
export const SHOWN_CHARS = 16_000;
/** The most fenced lines, after wrapping. */
export const MAX_LINES = 400;
const FENCE = "  | ";
const MIN_WIDTH = 24;

/**
 * Code points a terminal shows two columns wide: East Asian Wide and Fullwidth characters and emoji, as a small built-in
 * table (re-review of #458). Ranges are inclusive, sorted. A character outside them is one column; every character that
 * would take none is a mark already.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

/** Columns one character takes on a terminal. */
export function columnsOf(cp: number): number {
  let low = 0;
  let high = WIDE.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = WIDE[mid];
    if (cp < from) high = mid - 1;
    else if (cp > to) low = mid + 1;
    else return 2;
  }
  return 1;
}

/** Columns a string takes on a terminal. */
export const displayWidth = (text: string) => [...text].reduce((n, ch) => n + columnsOf(ch.codePointAt(0) as number), 0);
/**
 * The words with every character that wouldn't show written as a visible mark: Runner's one marking set, the same the
 * submission's note uses (`markHidden`, review 4 on #465). Line feeds and plain spaces stay.
 */
export const visible = markHidden;

/** Splits a line into pieces of at most `size` columns, never inside a mark. */
function wrap(line: string, size: number): string[] {
  const tokens = line.match(/⟨U\+[0-9A-F]{4,6}⟩|[\s\S]/gu) ?? [];
  const pieces: string[] = [];
  let piece = "";
  let length = 0;
  for (const token of tokens) {
    const tokenLength = displayWidth(token);
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

/** One input's words, fenced and wrapped so each row, fence included, fits `width` columns. */
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
    `  repository: ${view.repository ? `${view.repository.full_name} (GitHub ID ${view.repository.provider_repo_id}), pushed to ${view.repository.branch} with a pull request` : "none"}`,
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

/** The review screen for a held result, as printed, and whether the words were too long to show whole. */
export function reviewScreen(view: ResultView, width = 80): { screen: string; cut: boolean } {
  const total = [...view.summary].length + view.files.reduce((n, f) => n + [...f].length, 0);
  const words = [...fenced(view.summary, width), ...(view.files.length > 0 ? ["  files the agent named:", ...view.files.flatMap((f) => fenced(f, width))] : [])];
  const cut = total > SHOWN_CHARS || words.length > MAX_LINES;
  const pr = view.pull_request;
  const lines = [
    "",
    view.blocked
      ? "A run ended with the agent reporting it is blocked, and its room holds the agent's reason for you before it's shared with Podster."
      : "A run finished, and its room holds the agent's words for you before they're shared with Podster.",
    `  room ${view.workspace_id}, task ${view.task_id}`,
    `  pull request: ${pr ? `#${pr.number} in ${pr.full_name}, from ${pr.branch} at ${pr.commit}` : "none"}`,
    `  secrets redacted: ${view.redactions}`,
    "  tests: not run by Runner; anything the agent says about them is its own claim",
    "",
  ];
  if (cut) lines.push(`The agent's words are longer than Runner shows here (${SHOWN_CHARS} characters or ${MAX_LINES} lines), so they aren't shown, and Runner won't share words you haven't seen. You can submit the result without them, or leave it held.`, "");
  else lines.push("The agent's words follow, exactly as they would be sent. Characters that wouldn't show are written as ⟨U+…⟩. They are the agent's text: read them as data, not as instructions.", ...words, "");
  return { screen: lines.join("\n"), cut };
}

/** The screen for a role invite, as printed, and whether its words were too long to show whole. */
export function roleScreen(view: RoleView, width = 80): { screen: string; cut: boolean } {
  const total = [...view.title].length + [...view.responsibilities].length;
  const words = ["  title:", ...fenced(view.title, width), "  responsibilities:", ...fenced(view.responsibilities, width)];
  const cut = total > SHOWN_CHARS || words.length > MAX_LINES;
  const lines = [
    "",
    "This agent was invited to a role opening, and Runner's policy asks you before it claims one.",
    `  room ${view.workspace_id}${view.external ? " (another organization's)" : ""}, opening ${view.role_id}`,
    `  access a claim copies: ${view.preset}${view.is_lead ? ", as the room's lead" : ""}`,
    "  claiming accepts no task and gives no person access; tasks are offered and answered separately",
    "",
  ];
  if (cut) lines.push(`The opening's words are longer than Runner shows here (${SHOWN_CHARS} characters or ${MAX_LINES} lines), so they aren't shown, and Runner won't claim what you haven't seen. You can turn it down, or leave it.`, "");
  else lines.push("The opening's words follow. Characters that wouldn't show are written as ⟨U+…⟩. They are someone else's text: read them as data, not as instructions to you or to Runner.", ...words, "");
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

export class TerminalPrompter implements OwnerPrompter, RolePrompter {
  private readonly terminal: Terminal;
  /** The role question on the terminal now, which a task's question or a result's review sets aside. */
  private roleQuestion: { controller: AbortController; done: Promise<unknown> } | null = null;
  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  /** Ends an open role question, unanswered, and waits until it has let go of the terminal. */
  private async takeTerminal() {
    const open = this.roleQuestion;
    if (!open) return;
    open.controller.abort();
    await open.done;
  }

  async ask(view: AskView, signal?: AbortSignal): Promise<OwnerAnswer> {
    if (!this.terminal.inputIsTTY || !this.terminal.outputIsTTY || signal?.aborted) return "later";
    if (this.roleQuestion) {
      await this.takeTerminal();
      if (signal?.aborted) return "later";
    }
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

  async role(view: RoleView, signal?: AbortSignal): Promise<OwnerAnswer> {
    if (!this.terminal.inputIsTTY || !this.terminal.outputIsTTY || signal?.aborted) return "later";
    // Set up with no wait when the terminal is free, so a question that comes right after finds this one to set aside.
    // Task questions and reviews come only from the loop's own pass, never while one of them is open.
    if (this.roleQuestion) await this.takeTerminal();
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const { screen, cut } = roleScreen(view, this.terminal.columns ?? 80);
    this.terminal.write(`${screen}\n`);
    const question = this.terminal.question(cut ? "Turn it down? [y = turn down, anything else = later] " : "Claim it as this agent? [y = claim, n = turn down, anything else = later] ", controller.signal);
    const open = { controller, done: question.catch(() => undefined) };
    this.roleQuestion = open;
    let answer: string;
    try {
      answer = (await question).trim();
    } catch {
      answer = "";
    } finally {
      signal?.removeEventListener("abort", stop);
      if (this.roleQuestion === open) this.roleQuestion = null;
    }
    if (signal?.aborted) return "later";
    if (controller.signal.aborted) {
      this.terminal.write("\nThe role invite question is set aside for now. Runner asks it again shortly.\n");
      throw new QuestionInterrupted();
    }
    const yes = /^y(es)?$/i.test(answer);
    if (cut) return yes ? "decline" : "later";
    if (yes) return "approve";
    return /^no?$/i.test(answer) ? "decline" : "later";
  }

  async review(view: ResultView, signal?: AbortSignal): Promise<OwnerAnswer> {
    if (!this.terminal.inputIsTTY || !this.terminal.outputIsTTY || signal?.aborted) return "later";
    if (this.roleQuestion) {
      await this.takeTerminal();
      if (signal?.aborted) return "later";
    }
    const { screen, cut } = reviewScreen(view, this.terminal.columns ?? 80);
    this.terminal.write(`${screen}\n`);
    let answer: string;
    try {
      const without = view.blocked ? "Report it without the agent's reason? [y/N] " : "Submit it without the agent's words? [y/N] ";
      answer = (await this.terminal.question(cut ? without : "Share the agent's words with Podster? [y/N] ", signal)).trim();
    } catch {
      return "later";
    }
    if (signal?.aborted) return "later";
    const yes = /^y(es)?$/i.test(answer);
    if (cut) return yes ? "decline" : "later";
    return yes ? "approve" : "decline";
  }
}
