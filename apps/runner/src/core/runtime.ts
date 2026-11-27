/**
 * What Runner's core needs from the machine, passed in so tests control it: the clock, and where its log lines go.
 */

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
  idle(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  idle: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/**
 * Runner's log: one JSON line per event, with a fixed event name, a fixed outcome and IDs. Nothing else can be logged:
 * a field outside this list, or a value that isn't an ID or a small number, is dropped before the line is written. So a
 * code, a key, a token or task text can't reach a log through it, whatever a caller passes.
 */
export type LogFields = {
  agent?: string;
  plugin_agent?: string;
  workspace?: string;
  task?: string;
  /** An A2A attempt's ID, from a nudge (M7 step 14), so Runner's log lines up with Podster's audit. */
  attempt_id?: string;
  /** A run's reference, as the task's containers are labelled. */
  run?: string;
  /** A host name the egress proxy allowed or refused: a lower-case DNS name, never a URL, path or address. */
  host?: string;
  seq?: number;
  count?: number;
  status?: number;
  code?: string;
  /** Where on the repository path a failure happened (`RepoStage`, #520): a fixed lower-case word. */
  stage?: string;
  /** Key names a refused answer carried: comma-joined, each `[a-z_]{1,40}` or `?`, at most 10. */
  names?: string;
  /** A refused token's length. */
  length?: number;
  /** Whether a refused token began with three lower-case letters and an underscore. */
  prefix?: string;
  /** The JSON type name of a refused value. */
  type?: string;
  /** How many files a succeeded run left in its HOME and in /tmp, where nothing is kept (counts only). */
  home_files?: number;
  tmp_files?: number;
};
export type Logger = (at: string, outcome: string, fields?: LogFields) => void;

const NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const ID_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const CODE_VALUE = /^[a-z][a-z0-9_]{0,63}$/;
const NAMES_VALUE = /^[a-z_?]{1,40}(,[a-z_?]{1,40}){0,9}$/;
const PREFIX_VALUE = /^(yes|no)$/;
/** A lower-case DNS name of two or more labels whose last starts with a letter, so never an IP address. */
const HOST_VALUE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const STAGE_VALUE = /^[a-z]{1,16}$/;
const TYPE_VALUE = /^(null|array|object|string|number|boolean|undefined|bigint|symbol|function)$/;
const NUMBER_FIELDS = new Set(["seq", "count", "status", "length", "home_files", "tmp_files"]);
const ID_FIELDS = new Set(["agent", "plugin_agent", "workspace", "task", "attempt_id", "run"]);

/** The line a logger writes, with everything that isn't allowed dropped. */
export function logLine(at: string, outcome: string, fields: LogFields = {}): string {
  const line: Record<string, string | number> = { at: NAME.test(at) ? at : "runner", outcome: NAME.test(outcome) ? outcome : "unknown" };
  for (const [name, value] of Object.entries(fields)) {
    if (NUMBER_FIELDS.has(name) && typeof value === "number" && Number.isSafeInteger(value)) line[name] = value;
    else if (ID_FIELDS.has(name) && typeof value === "string" && ID_VALUE.test(value)) line[name] = value;
    else if (name === "names" && typeof value === "string" && NAMES_VALUE.test(value)) line[name] = value;
    else if (name === "host" && typeof value === "string" && HOST_VALUE.test(value)) line[name] = value;
    else if (name === "prefix" && typeof value === "string" && PREFIX_VALUE.test(value)) line[name] = value;
    else if (name === "type" && typeof value === "string" && TYPE_VALUE.test(value)) line[name] = value;
    else if (name === "code" && typeof value === "string" && CODE_VALUE.test(value)) line[name] = value;
    else if (name === "stage" && typeof value === "string" && STAGE_VALUE.test(value)) line[name] = value;
  }
  return JSON.stringify(line);
}

/** A logger writing each line to `write`. */
export const lineLogger = (write: (line: string) => void): Logger => (at, outcome, fields) => write(logLine(at, outcome, fields));

export const silentLogger: Logger = () => undefined;

/**
 * A failure, for the local diagnostics file only (the owner's request of 2026-11-20): where and which code, the IDs, and
 * the raw error, which the file's writer redacts and bounds. Never sent anywhere.
 */
export type FailureRecord = { at: string; code: string; workspace?: string; task?: string; run_ref?: string; error?: unknown };
export interface Diagnostics {
  record(failure: FailureRecord): void;
  /** Where the file is, for the terminal's line. */
  readonly file: string;
}
