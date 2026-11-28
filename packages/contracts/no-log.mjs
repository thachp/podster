// M8 step 7: the preview access path carries tickets, sessions and state hashes, so the code that makes, signs and
// passes them writes no log line at all, IDs included (the preview plan's 5.3, "Nothing of this is logged"). A text scan,
// as error-codes.mjs is: comments are blanked first, and strings are left, so a log call inside a string literal would be
// reported too, which errs on the safe side.
//
// What counts as a log line: Rust's `console_log!`, `console_error!`, `console_warn!`, `console_debug!` and any other
// `console_*!`, `println!`, `print!`, `eprintln!`, `eprint!` and `dbg!`, and anything of `tracing` or `log` (a path,
// a `use` or one of their macros); TypeScript's `console` reached in any way (`console.log`, `console["log"]`,
// `console?.log`, `globalThis.console`, or `console` passed or bound as a value).
//
// What it can't see: a log call through a function another file defines, or a macro renamed on import.

/** The source with every comment replaced by spaces, keeping line breaks. */
export function blankComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
}

const RUST = [
  /\bconsole_[a-z]+\s*!/,
  /\b(e?println|e?print|dbg)\s*!/,
  /\b(tracing|log)\s*::/,
  /\buse\s+(tracing|log)\b/,
  /\b(trace|debug|info|warn|error)\s*!\s*\(/,
];
const TYPESCRIPT = [/\bconsole\b/];

/** The log lines a source holds, by line number. `rust` picks the patterns. */
export function logLines(source, rust) {
  const found = [];
  blankComments(source).split("\n").forEach((line, i) => {
    if ((rust ? RUST : TYPESCRIPT).some((pattern) => pattern.test(line))) found.push(i + 1);
  });
  return found;
}

/** The text of the Rust function `name` in `source`, from its `fn` to its closing brace, or null. */
export function rustFunction(source, name) {
  const blanked = blankComments(source);
  const start = blanked.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const open = blanked.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === "{") depth += 1;
    else if (blanked[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/**
 * The files of the access path, and in `apps/api/src/workspace.rs` the one function on it. `read(path)` reads a file
 * from the repository's root. Returns the problems found, each naming a file and a line.
 */
export function previewAccessLogProblems(read) {
  const problems = [];
  const whole = ["apps/api/src/preview_access.rs", "apps/api/src/workspace/preview_access.rs", "crates/egress/src/preview_key.rs", "apps/web/lib/preview-access.ts", "apps/web/app/preview-access/route.ts"];
  for (const file of whole) {
    for (const line of logLines(read(file), file.endsWith(".rs"))) problems.push(`${file}:${line}: the preview access path must log nothing`);
  }
  const dispatch = rustFunction(read("apps/api/src/workspace.rs"), "preview_access");
  if (dispatch === null) problems.push("apps/api/src/workspace.rs: the room's preview_access handler wasn't found, so it can't be checked for logs");
  else for (const line of logLines(dispatch, true)) problems.push(`apps/api/src/workspace.rs, fn preview_access, line ${line} of it: the preview access path must log nothing`);
  return problems;
}
