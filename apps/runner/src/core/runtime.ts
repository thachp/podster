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
  seq?: number;
  count?: number;
  status?: number;
  code?: string;
};
export type Logger = (at: string, outcome: string, fields?: LogFields) => void;

const NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const ID_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const CODE_VALUE = /^[a-z][a-z0-9_]{0,63}$/;
const NUMBER_FIELDS = new Set(["seq", "count", "status"]);
const ID_FIELDS = new Set(["agent", "plugin_agent", "workspace", "task", "attempt_id"]);

/** The line a logger writes, with everything that isn't allowed dropped. */
export function logLine(at: string, outcome: string, fields: LogFields = {}): string {
  const line: Record<string, string | number> = { at: NAME.test(at) ? at : "runner", outcome: NAME.test(outcome) ? outcome : "unknown" };
  for (const [name, value] of Object.entries(fields)) {
    if (NUMBER_FIELDS.has(name) && typeof value === "number" && Number.isSafeInteger(value)) line[name] = value;
    else if (ID_FIELDS.has(name) && typeof value === "string" && ID_VALUE.test(value)) line[name] = value;
    else if (name === "code" && typeof value === "string" && CODE_VALUE.test(value)) line[name] = value;
  }
  return JSON.stringify(line);
}

/** A logger writing each line to `write`. */
export const lineLogger = (write: (line: string) => void): Logger => (at, outcome, fields) => write(logLine(at, outcome, fields));

export const silentLogger: Logger = () => undefined;
