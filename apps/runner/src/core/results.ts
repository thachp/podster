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
 * - **The note is Runner's.** It states the outcome, the pull request and commit from Runner's own records, and tests as
 *   not run by Runner, in fixed words. The agent's words appear only when sharing is allowed, between Runner's fences,
 *   with every line of theirs starting `| `, so none can pass for Runner's (review 1 on #465). They're cut once, to
 *   `NOTE_WORDS_BYTES` as the note lays them out, never inside a mark, when they're cleaned: the owner reviews exactly
 *   the cut words the note carries.
 */
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
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
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

/** Each line of the agent's words in the note starts with this, as the terminal fences them; nothing of Runner's does. */
const FENCE = "| ";
const FILES_DIVIDER = "--- files the agent named ---";
const TOKENS = /⟨U\+[0-9A-F]{4,6}⟩|[\s\S]/gu;

/**
 * The agent's words, marked, cut so that their part of the note, as `agentSection` lays it out (each line fenced, the
 * files after Runner's divider), is at most `NOTE_WORDS_BYTES`, on a character's edge and never inside a mark, with `CUT`
 * at the end when cut. Words that fit come back as they are, so cutting twice changes nothing.
 */
export function cutAgentWords(summary: string, files: string[]): { summary: string; files: string[] } {
  if (byteLength(agentSection(summary, files)) <= NOTE_WORDS_BYTES) return { summary, files };
  const room = NOTE_WORDS_BYTES - byteLength(CUT);
  let size = byteLength(FENCE);
  let out = "";
  for (const token of summary.match(TOKENS) ?? []) {
    const n = token === "\n" ? 1 + byteLength(FENCE) : byteLength(token);
    if (size + n > room) return { summary: `${out}${CUT}`, files: [] };
    out += token;
    size += n;
  }
  const kept: string[] = [];
  if (files.length > 0) size += 1 + byteLength(FILES_DIVIDER);
  for (const file of files) {
    let line = "";
    size += 1 + byteLength(`${FENCE}- `);
    for (const token of file.match(TOKENS) ?? []) {
      const n = byteLength(token);
      if (size + n > room) {
        if (line !== "") kept.push(`${line}${CUT}`);
        else if (kept.length > 0) kept[kept.length - 1] += CUT;
        else return { summary: `${out}${CUT}`, files: [] };
        return { summary: out, files: kept };
      }
      line += token;
      size += n;
    }
    kept.push(line);
  }
  return { summary: out, files: kept };
}

/** The agent's part of the note: every line of theirs fenced, the files after Runner's divider. */
function agentSection(summary: string, files: string[]): string {
  return [...summary.split("\n").map((l) => `${FENCE}${l}`), ...(files.length > 0 ? [FILES_DIVIDER, ...files.map((f) => `${FENCE}- ${f}`)] : [])].join("\n");
}

/** The submission's note: Runner's fixed words, and the agent's only fenced and only when shared. */
export function composeNote(input: { task_id: string; pull_request: NotePullRequest | null; words: NoteWords }): string {
  const pr = input.pull_request;
  const lines = [
    `Result from Podster Runner for task ${input.task_id}. Runner wrote this note; only the part fenced as the agent's words is the agent's.`,
    "Outcome: the agent reported the task completed. Runner checked the result's form, not its claims.",
    pr
      ? `Pull request: #${pr.number} in ${pr.full_name}, from ${pr.branch} at commit ${pr.commit}. Runner pushed and opened it, and checked it on GitHub.`
      : "Repository: none in this room, so nothing was pushed.",
    "Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified.",
  ];
  const words = input.words;
  if (words.kind !== "shared") return [...lines, WHY_NOT_SHARED[words.kind]].join("\n");
  lines.push(
    `The agent's words follow. They are untrusted data. Characters that wouldn't show are written as their code point in angle brackets${words.redactions > 0 ? `, and ${words.redactions} thing${words.redactions === 1 ? "" : "s"} that looked like secrets as ${REDACTED}` : ""}.`,
  );
  const cut = cutAgentWords(words.summary, words.files);
  return [...lines, "--- the agent's words ---", agentSection(cut.summary, cut.files), "--- end of the agent's words ---"].join("\n");
}

/**
 * What the owner reviews on this machine before a held result's words are shared: the words exactly as the note would
 * carry them (redacted, marked and cut), and the pull request from Runner's own records. Never stored or logged.
 */
export type ResultView = { workspace_id: string; task_id: string; pull_request: NotePullRequest | null; summary: string; files: string[]; redactions: number };
