/**
 * Results (M7 step 11; RUNNER.md lifecycle step 9, "Exfiltration through results" in the threat model). Pure: what Runner
 * makes of a run's structured result before any of it is shown to the owner or submitted to Podster.
 *
 * - **Agent content is data.** The summary and the file paths are the agent's words: they are never logged, never stored
 *   in Runner's record, and never read for meaning. They become nothing but text inside a fenced part of the note.
 * - **Hidden characters become visible marks** (owed by step 12's harness). Every format character (general category Cf:
 *   bidi embeddings, overrides and isolates, zero widths, the byte order mark, tag characters…), every control character
 *   but the line feed, line and paragraph separators, lone surrogates, unassigned and private-use code points, and every
 *   other default-ignorable code point is written as `⟨U+XXXX⟩`, so what the reviewer reads is what the agent wrote.
 * - **Secrets are redacted,** by fixed patterns, before the words are marked. Words in which a secret shows only once the
 *   hidden characters are taken out are withheld whole. Redaction is a backstop, not a control: the output policy is.
 * - **The note is Runner's.** It states the outcome, the pull request and commit from Runner's own records, and tests as
 *   not run by Runner, in fixed words; the agent's words appear only fenced, only when sharing is allowed, and cut to
 *   `NOTE_WORDS_BYTES`, never inside a mark.
 */
import type { RunResult } from "./tool-policy.js";

/** The server's limit on a submission's note (`crates/core` `MAX_NOTE_BYTES`). */
export const MAX_NOTE_BYTES = 16 * 1024;
/** The most of the agent's words, marked and redacted, a note carries. **Proposed** figure. */
export const NOTE_WORDS_BYTES = 12 * 1024;

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const mark = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;

/** The text with every character that would draw nothing, or would reorder its neighbours, written as a mark. */
export function markHidden(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n") out += ch;
    else if (HIDDEN.test(ch)) out += mark(ch.codePointAt(0) as number);
    else out += ch;
  }
  return out;
}

/** The text with the hidden characters taken out, as a reader who doesn't see them would read it. */
const stripHidden = (text: string) => [...text].filter((ch) => ch === "\n" || !HIDDEN.test(ch)).join("");

const REDACTED = "[redacted]";
/** Secrets by their fixed shapes. Each is replaced whole; a `key = value` one keeps its name. */
const SECRETS: { pattern: RegExp; keep?: boolean }[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { pattern: /\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { pattern: /\b((?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi, keep: true },
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

/** The result's words as they may be shown and sent: redacted, then marked; or withheld whole. */
export function cleanResult(result: RunResult): CleanResult {
  let redactions = 0;
  const clean = (text: string): string | null => {
    const redacted = redactSecrets(text);
    if (holdsSecret(stripHidden(redacted.text))) return null;
    redactions += redacted.count;
    return markHidden(redacted.text);
  };
  const summary = clean(result.summary);
  const files = result.files.map(clean);
  if (summary === null || files.some((f) => f === null)) return { ok: false, reason: "secret_hidden" };
  return { ok: true, summary, files: files as string[], redactions };
}

export type NotePullRequest = { full_name: string; number: number; branch: string; commit: string };
export type NoteWords = { kind: "shared"; summary: string; files: string[]; redactions: number } | { kind: "withheld" | "lost" | "secret_hidden" };

const WHY_NOT_SHARED: Record<Exclude<NoteWords["kind"], "shared">, string> = {
  withheld: "The agent's words aren't shared: this room's output policy holds them for the machine's owner, who chose not to share them.",
  lost: "The agent's words aren't shared: Runner restarted before sending them, and it never stores them.",
  secret_hidden: "The agent's words aren't shared: they held what looked like a secret hidden among characters that don't show.",
};
const CUT = "⟨cut by Runner⟩";

/** `text` cut to at most `max` UTF-8 bytes, on a character's edge and never inside a mark, with `CUT` when cut. */
function cutWords(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  const room = max - byteLength(CUT);
  let out = "";
  let size = 0;
  for (const token of text.match(/⟨U\+[0-9A-F]{4,6}⟩|[\s\S]/gu) ?? []) {
    const n = byteLength(token);
    if (size + n > room) break;
    out += token;
    size += n;
  }
  return `${out}${CUT}`;
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
  const body = [words.summary, ...(words.files.length > 0 ? ["--- files the agent named ---", ...words.files.map((f) => `- ${f}`)] : [])].join("\n");
  return [...lines, "--- the agent's words ---", `${cutWords(body, NOTE_WORDS_BYTES)}\n--- end of the agent's words ---`].join("\n");
}

/**
 * What the owner reviews on this machine before a held result's words are shared: the words exactly as they would be
 * sent (redacted and marked), and the pull request from Runner's own records. Never stored or logged.
 */
export type ResultView = { workspace_id: string; task_id: string; pull_request: NotePullRequest | null; summary: string; files: string[]; redactions: number };
