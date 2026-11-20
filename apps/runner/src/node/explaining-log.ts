/**
 * Runner's terminal log with a plain-English line under each failure (the owner's request of 2026-11-20). The JSON line is
 * written as before; when its outcome is a failure, a refusal or a stop and it carries a code, the next line says what
 * happened and what to do, from the fixed table in `explain.ts`, and names the local diagnostics file. Nothing but the
 * validated code reaches the explanation, so no task text, error message or secret can.
 */
import { explainLine, FAILURE_OUTCOMES } from "../core/explain.js";
import { logLine, type Logger } from "../core/runtime.js";
import { FileDiagnostics } from "./diagnostics.js";

export function explainingLogger(write: (line: string) => void, diagnosticsFile: string): Logger {
  return (at, outcome, fields = {}) => {
    const line = logLine(at, outcome, fields);
    write(line);
    const code = (JSON.parse(line) as { code?: string }).code;
    if (FAILURE_OUTCOMES.has(outcome) && code !== undefined) write(explainLine(code, diagnosticsFile));
  };
}

/** `run`'s logger and diagnostics for a home: the terminal's explained log, naming that home's diagnostics file. */
export function runLogger(home: string, write: (line: string) => void): { log: Logger; diagnostics: FileDiagnostics } {
  const diagnostics = new FileDiagnostics(home);
  return { log: explainingLogger(write, diagnostics.file), diagnostics };
}
