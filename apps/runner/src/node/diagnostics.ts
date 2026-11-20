/**
 * Runner's local diagnostics file (the owner's request of 2026-11-20): `logs/errors.jsonl` in Runner's home, one JSON
 * line per failure, keyed by time and the run's IDs, with the raw error's message and stack and, for a Docker command,
 * its exit code and the tail of its error output. It is for the machine's owner only:
 *
 * - **Local only.** Nothing reads it but `podster why`; it is never sent to Podster or any network.
 * - **Scrubbed and bounded.** Every text has the exact secret values Runner holds (`known-secrets.ts`: the run's broker
 *   token, a task's GitHub token) redacted, then Runner's secret patterns (`redactSecrets`), and each field is cut to
 *   `MAX_FIELD_BYTES`, 4 KiB (the error output keeps its tail). Error output Docker cut at its own cap has its last word,
 *   which may be the start of a secret, redacted too.
 * - **Private.** The folder is mode 0700, owned by this user and not a link; the file is 0600 (set before the first
 *   write to one that exists), owned by this user, with one link, opened without following a link. Reads check the same.
 * - **Rotated.** Past `MAX_FILE_BYTES` the file moves to `errors.jsonl.1` (and that to `.2`), so at most three are kept.
 *
 * A write that fails is dropped: diagnostics never stop Runner.
 */
import { chmodSync, closeSync, constants, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DetailedError } from "../core/errors.js";
import { RepoPathError } from "../core/repository.js";
import { explain } from "../core/explain.js";
import { redactKnown } from "../core/known-secrets.js";
import { markHidden, redactSecrets } from "../core/results.js";
import { ownFileSync, ownFolderSync } from "./safe-fs.js";
import type { Diagnostics, FailureRecord } from "../core/runtime.js";

export const MAX_FILE_BYTES = 1024 * 1024;
export const KEPT_FILES = 3;
export const MAX_FIELD_BYTES = 4096;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[a-z][a-z0-9_.]{0,63}$/;

/** Text redacted, then cut to `max` UTF-8 bytes: its head, or its tail for an error output. */
export function scrub(text: string, max = MAX_FIELD_BYTES, keep: "head" | "tail" = "head"): string {
  const clean = redactSecrets(redactKnown(text).text).text;
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= max) return clean;
  const cut = keep === "head" ? bytes.subarray(0, max) : bytes.subarray(bytes.byteLength - max);
  // A cut inside a character drops it rather than writing half of one.
  return (keep === "head" ? "" : "[cut]") + cut.toString("utf8").replace(/�/g, "") + (keep === "head" ? "[cut]" : "");
}

/**
 * Output cut at a head cap: its last word, if the cut went through one, is replaced, since it may be the start of a
 * secret too short for any pattern to match (`ghs_`, `sk-ant-`, part of a hex token).
 */
export function cutEdge(text: string): string {
  return text.replace(/[^\s"'`<>()[\]{},;]+$/u, "[cut: partial word redacted]");
}

/** The line written for a failure. */
export function diagnosticLine(failure: FailureRecord, now: number): string {
  const line: Record<string, string | number> = { time: new Date(now).toISOString(), at: CODE.test(failure.at) ? failure.at : "runner", code: /^[a-z][a-z0-9_]{0,63}$/.test(failure.code) ? failure.code : "unknown" };
  if (failure.workspace && ID.test(failure.workspace)) line.workspace = failure.workspace;
  if (failure.task && ID.test(failure.task)) line.task = failure.task;
  if (failure.run_ref && ID.test(failure.run_ref)) line.run_ref = failure.run_ref;
  const error = failure.error;
  if (error instanceof Error) {
    line.message = scrub(error.message);
    if (typeof error.stack === "string") line.stack = scrub(error.stack);
    if (error instanceof DetailedError) {
      if (typeof error.detail.exit_code === "number" && Number.isSafeInteger(error.detail.exit_code)) line.exit_code = error.detail.exit_code;
      if (typeof error.detail.stderr === "string") line.stderr_tail = scrub(error.detail.cut ? cutEdge(error.detail.stderr) : error.detail.stderr, MAX_FIELD_BYTES, "tail");
      if (typeof error.detail.errno === "string") line.errno = scrub(error.detail.errno, 64);
    }
    if (error instanceof RepoPathError) line.transient = error.transient ? 1 : 0;
  } else if (error !== undefined) {
    line.message = scrub(String(error));
  }
  return JSON.stringify(line);
}

export class FileDiagnostics implements Diagnostics {
  readonly folder: string;
  readonly file: string;
  private readonly now: () => number;
  constructor(home: string, now: () => number = () => Date.now()) {
    this.folder = join(home, "logs");
    this.file = join(this.folder, "errors.jsonl");
    this.now = now;
  }

  record(failure: FailureRecord): void {
    try {
      this.write(`${diagnosticLine(failure, this.now())}\n`);
    } catch {
      // Diagnostics never stop Runner.
    }
  }

  private write(line: string) {
    if (!existsSync(this.folder)) mkdirSync(this.folder, { mode: 0o700 });
    // Checked first, so nothing is ever changed through a link: a real folder, the owner's, writable by no one else.
    ownFolderSync(this.folder);
    chmodSync(this.folder, 0o700);
    let size: number;
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      size = ownFileSync(fd).size;
    } finally {
      closeSync(fd);
    }
    if (size > 0 && size + Buffer.byteLength(line) > MAX_FILE_BYTES) this.rotate();
    const out = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      ownFileSync(out);
      // Private before anything is written, whatever mode a file that was there had.
      fchmodSync(out, 0o600);
      writeSync(out, line);
    } finally {
      closeSync(out);
    }
  }

  private rotate() {
    const oldest = `${this.file}.${KEPT_FILES - 1}`;
    if (existsSync(oldest)) rmSync(oldest);
    for (let n = KEPT_FILES - 2; n >= 1; n--) if (existsSync(`${this.file}.${n}`)) renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
    renameSync(this.file, `${this.file}.1`);
  }

  /** The newest failure recorded for a task, as written, or null. Reads this machine's files only. */
  lastFor(task: string): Record<string, unknown> | null {
    if (!ID.test(task)) return null;
    try {
      ownFolderSync(this.folder);
    } catch {
      return null;
    }
    for (const path of [this.file, ...Array.from({ length: KEPT_FILES - 1 }, (_, i) => `${this.file}.${i + 1}`)]) {
      let text: string;
      try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          ownFileSync(fd);
          text = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const lines = text.split("\n").filter((l) => l !== "");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.task === task) return entry;
        } catch {
          // A torn line is skipped.
        }
      }
    }
    return null;
  }
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AT = /^[a-z][a-z0-9_.]{0,63}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A field read back from the file, shown only when it has its fixed shape. */
const shaped = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : "invalid");

/**
 * `podster why`'s lines for a task's newest failure: its time, place and code, each shown only in its fixed shape, the
 * table's explanation, and the entry itself with every control, format and bidi character written as a visible mark, so
 * nothing in the file can rewrite the terminal.
 */
export function whyLines(task: string, entry: Record<string, unknown> | null, file: string): string[] {
  if (!entry) return [`No failure is recorded for ${task} in ${file}.`];
  const code = shaped(entry.code, FAILURE_CODE);
  const e = explain(code);
  return [
    `${shaped(entry.time, TIME)} at ${shaped(entry.at, AT)}: ${e.what} ${e.todo} (code ${code})`,
    `From ${file}, local to this machine and redacted:`,
    markHidden(JSON.stringify(entry, null, 2)),
  ];
}

/** `podster why <task>`: prints the lines and answers the exit code. A task that isn't an ID is refused. */
export function whyCommand(home: string, task: string | undefined, say: (line: string) => void): number {
  if (!task || !ID.test(task)) {
    say("Name a task: `why <tsk_…>`.");
    return 2;
  }
  const diagnostics = new FileDiagnostics(home);
  for (const line of whyLines(task, diagnostics.lastFor(task), diagnostics.file)) say(line);
  return 0;
}
