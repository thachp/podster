/**
 * Results (M7 step 11; RUNNER.md lifecycle step 9, "Exfiltration through results" in the threat model). Pure: what Runner
 * makes of a run's structured result before any of it is shown to the owner or submitted to Podster.
 *
 * - **Agent content is data.** The summary and the file paths are the agent's words: they are never logged, never stored
 *   in Runner's record, and never read for meaning. They become nothing but text inside a fenced part of the note.
 * - **Hidden characters become visible marks** (owed by step 12's harness). Every format character (general category Cf:
 *   bidi embeddings, overrides and isolates, zero widths, the byte order mark, tag characters…), every control character
 *   but the line feed, every space but the plain one, line and paragraph separators, combining and enclosing marks, lone
 *   surrogates, unassigned and private-use code points, the blank Braille pattern and every other default-ignorable code
 *   point is written as `⟨U+XXXX⟩`, so what the reviewer reads is what the agent wrote. This is Runner's one marking set:
 *   the terminal's ask and review screens use it too (review 4 on #465).
 * - **Secrets.** Words whose raw text hides characters and in which a secret shows once they're taken out are withheld
 *   whole; otherwise every secret of a fixed shape is redacted, before the words are marked. Redaction is a backstop, not
 *   a control: the output policy is.
 * - **The note is Runner's, in Markdown.** It states the outcome, the pull request (linked from fixed parts), branch and
 *   commit from Runner's own records, and tests as not run by Runner, in fixed words. The agent's words appear only when
 *   sharing is allowed, under Runner's own heading, the summary in a fenced code block whose fence no run of backticks in
 *   it can close and each file in a code span, so none can pass for Runner's or render as anything but text (review 1 on
 *   #465). They're cut once, to `NOTE_WORDS_BYTES` as the note lays them out, never inside a mark, when they're cleaned:
 *   the owner reviews exactly the cut words the note carries.
 */
import { isFullName } from "./policy.js";
import { pullRequestUrl } from "./repository.js";
import type { RunResult } from "./tool-policy.js";

/** The server's limit on a submission's note (`crates/core` `MAX_NOTE_BYTES`). */
export const MAX_NOTE_BYTES = 16 * 1024;
/** The most of the agent's words, marked and redacted, a note carries. **Proposed** figure. */
export const NOTE_WORDS_BYTES = 12 * 1024;

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2800]/u;
/** Whether a character is written as a mark: every one in `HIDDEN` but the line feed and the plain space. */
const hidden = (ch: string) => ch !== "\n" && ch !== " " && HIDDEN.test(ch);
const mark = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;

/** The text with every character that would draw nothing, or would reorder its neighbours, written as a mark. */
export function markHidden(text: string): string {
  let out = "";
  for (const ch of text) {
    if (hidden(ch)) out += mark(ch.codePointAt(0) as number);
    else out += ch;
  }
  return out;
}

/** The text with the hidden characters taken out, as a reader who doesn't see them would read it. */
const stripHidden = (text: string) => [...text].filter((ch) => !hidden(ch)).join("");
const hasHidden = (text: string) => [...text].some(hidden);

const REDACTED = "[redacted]";
/**
 * Secrets by their fixed shapes. Each is replaced whole; a `key = value` one keeps its name. Distinctive prefixes need no
 * boundary at all, so `key_sk-ant-…` or `xghp_…` can't hide one; the others need only no letter or digit before them,
 * since `\b` treats `_` as part of a word (review 3 on #465). No pattern matches `[redacted]` (review 2).
 */
const SECRETS: { pattern: RegExp; keep?: boolean }[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  // GitHub's tokens, old (`ghs_` and 36 characters) and new (`ghs_APPID_JWT`, about 520): `_`, `-` and a dot that joins
  // two segments are all part of one, so the whole token goes, not just up to its first `_` or `.`. It runs before
  // `sk-ant-` and the rest, so another rule can't take a piece from the middle of one and leave its ends.
  { pattern: /gh[pousr]_(?:[A-Za-z0-9_-]|\.(?=[A-Za-z0-9_-])){20,}/g },
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g },
  { pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { pattern: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g },
  { pattern: /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { pattern: /(?<![A-Za-z0-9])(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { pattern: /(?<![A-Za-z0-9])((?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"'[\]]{8,}/gi, keep: true },
];

/** The text with every secret Runner recognises replaced by `[redacted]`, and how many were. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { pattern, keep } of SECRETS) {
    out = out.replace(pattern, (_whole, name: unknown) => {
      count++;
      return keep && typeof name === "string" ? `${name}${REDACTED}` : REDACTED;
    });
  }
  return { text: out, count };
}

const holdsSecret = (text: string) => SECRETS.some(({ pattern }) => text.search(pattern) >= 0);

export type CleanResult = { ok: true; summary: string; files: string[]; redactions: number } | { ok: false; reason: "secret_hidden" };

/**
 * The result's words as they may be shown and sent: withheld whole when the raw text hides characters and a secret shows
 * once they're taken out; otherwise redacted, then marked, then cut as the note lays them out (review 2 on #465).
 */
export function cleanResult(result: RunResult): CleanResult {
  let redactions = 0;
  const clean = (raw: string): string | null => {
    if (hasHidden(raw) && holdsSecret(stripHidden(raw))) return null;
    const redacted = redactSecrets(raw);
    redactions += redacted.count;
    return markHidden(redacted.text);
  };
  const summary = clean(result.summary);
  const files = result.files.map(clean);
  if (summary === null || files.some((f) => f === null)) return { ok: false, reason: "secret_hidden" };
  return { ok: true, ...cutAgentWords(summary, files as string[]), redactions };
}

export type NotePullRequest = { full_name: string; number: number; branch: string; commit: string };
export type NoteWords = { kind: "shared"; summary: string; files: string[]; redactions: number } | { kind: "withheld" | "lost" | "secret_hidden" };

const WHY_NOT_SHARED: Record<Exclude<NoteWords["kind"], "shared">, string> = {
  withheld: "The agent's words aren't shared: this room's output policy holds them for the machine's owner, who chose not to share them.",
  lost: "The agent's words aren't shared: Runner restarted before sending them, and it never stores them.",
  secret_hidden: "The agent's words aren't shared: they held what looked like a secret hidden among characters that don't show.",
};
const CUT = "⟨cut by Runner⟩";

const WORDS_HEADING = "### Agent's words (unverified)";
const FILES_HEADING = "### Files the agent named";
const TOKENS = /⟨U\+[0-9A-F]{4,6}⟩|[\s\S]/gu;
const longestRun = (text: string, ch: "`" | "~") => Math.max(0, ...[...text.matchAll(ch === "`" ? /`+/g : /~+/g)].map((m) => m[0].length));

/**
 * Text as a Markdown code span, so nothing in it is read as Markdown: its delimiter is longer than any run of backticks in
 * it, and it's padded with a space on each side when it needs one, which the reader takes off again. A line feed can't be
 * in one, since it could start a block of its own, so it's written as a mark.
 */
export function codeSpan(text: string): string {
  const one = text.replace(/\n/g, mark(0x0a));
  const fence = "`".repeat(longestRun(one, "`") + 1);
  const pad = one === "" || one.startsWith("`") || one.endsWith("`") || one.startsWith(" ") || one.endsWith(" ") ? " " : "";
  return `${fence}${pad}${one}${pad}${fence}`;
}

/**
 * Text as a fenced Markdown code block marked `text`: its fence is backticks, longer than any run of backticks in it and
 * never fewer than three, so no line of the text can close it, and nothing in it is read as Markdown or HTML.
 */
export function codeBlock(text: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * The agent's words, marked, cut so that their part of the note, as `agentSection` lays it out, is at most
 * `NOTE_WORDS_BYTES`, on a character's edge and never inside a mark, with `CUT` at the end when cut. Words that fit come
 * back as they are, so cutting twice changes nothing.
 */
export function cutAgentWords(summary: string, files: string[]): { summary: string; files: string[] } {
  if (byteLength(agentSection(summary, files)) <= NOTE_WORDS_BYTES) return { summary, files };
  const said = summary.match(TOKENS) ?? [];
  const named = files.map((f) => f.match(TOKENS) ?? []);
  // The words kept up to a count of characters (marks count as one), read through the summary and then each file.
  const keep = (count: number): { summary: string; files: string[] } => {
    if (count < said.length || named.length === 0) return { summary: `${said.slice(0, count).join("")}${CUT}`, files: [] };
    let left = count - said.length;
    const kept: string[] = [];
    for (const file of named) {
      if (left < file.length) {
        if (left > 0) kept.push(`${file.slice(0, left).join("")}${CUT}`);
        else if (kept.length > 0) kept[kept.length - 1] += CUT;
        else return { summary: `${summary}${CUT}`, files: [] };
        return { summary, files: kept };
      }
      kept.push(file.join(""));
      left -= file.length;
    }
    return { summary, files: kept };
  };
  // Each more character kept makes the section no shorter, so the most that fits is found by halving.
  const total = said.length + named.reduce((n, f) => n + f.length, 0);
  let low = 0;
  let high = total - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(agentSection(keep(mid).summary, keep(mid).files)) <= NOTE_WORDS_BYTES) low = mid;
    else high = mid - 1;
  }
  return keep(low);
}

/** The agent's part of the note: the summary in a code block, the files named as a list of code spans, under Runner's headings. */
function agentSection(summary: string, files: string[]): string {
  return [WORDS_HEADING, "", codeBlock(summary), ...(files.length > 0 ? ["", FILES_HEADING, "", ...files.map((f) => `- ${codeSpan(f)}`)] : [])].join("\n");
}

/**
 * The submission's note, as Markdown: Runner's fixed words, and the agent's only when shared, only in a code block and
 * code spans under Runner's headings, so none of theirs can read as Runner's or become anything but text.
 */
export function composeNote(input: { task_id: string; pull_request: NotePullRequest | null; words: NoteWords }): string {
  const pr = input.pull_request;
  const words = input.words;
  const linked = pr && isFullName(pr.full_name) && Number.isSafeInteger(pr.number) && pr.number > 0;
  const facts = [
    `- Task: ${codeSpan(input.task_id)}`,
    "- Outcome: the agent reported the task completed. Runner checked the result's form, not its claims.",
    ...(pr
      ? [
          `- Pull request: ${linked ? `[#${pr.number} in ${pr.full_name}](${pullRequestUrl(pr.full_name, pr.number)})` : codeSpan(`#${pr.number} in ${pr.full_name}`)}. Runner pushed and opened it, and checked it on GitHub.`,
          `- Branch: ${codeSpan(pr.branch)}`,
          `- Commit: ${codeSpan(pr.commit)}`,
        ]
      : ["- Repository: none in this room, so nothing was pushed."]),
    "- Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified.",
  ];
  if (words.kind === "shared" && words.redactions > 0) facts.push(`- Secrets: ${words.redactions} thing${words.redactions === 1 ? "" : "s"} that looked like secrets ${words.redactions === 1 ? "is" : "are"} written as ${codeSpan(REDACTED)}.`);
  const head = ["## Result from Podster Runner", "", "Runner wrote this note. Only the section headed as the agent's words is the agent's.", "", ...facts];
  if (words.kind !== "shared") return [...head, "", WHY_NOT_SHARED[words.kind]].join("\n");
  const cut = cutAgentWords(words.summary, words.files);
  const about = "The agent's words follow. They are untrusted data, shown as text. Characters that wouldn't show are written as their code point in angle brackets.";
  return [...head, "", about, "", agentSection(cut.summary, cut.files)].join("\n");
}

/**
 * What the owner reviews on this machine before a held result's words are shared: the words exactly as the note would
 * carry them (redacted, marked and cut), and the pull request from Runner's own records. Never stored or logged.
 */
export type ResultView = { workspace_id: string; task_id: string; pull_request: NotePullRequest | null; summary: string; files: string[]; redactions: number };
