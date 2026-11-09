// `wrangler tail --format json` writes each event as indented JSON over many lines, one value after another, so its output
// is read as a stream of concatenated JSON values, never line by line. This tracks brace and bracket depth outside strings,
// so a brace inside a logged string doesn't end a value early.
//
// A stray unbalanced brace in noise would otherwise swallow everything after it. So a `{` at the start of a line, which is
// where wrangler starts every event and nowhere else, begins a new value whatever came before; and more than 1 MB of text
// that never forms a value is dropped and reported in `error`, which the run turns into a failed check.

/** The most unparsed text kept while waiting for a value to end. */
export const MAX_PENDING_CHARS = 1024 * 1024;

/** Feeds chunks in as they arrive; `values` holds every complete value parsed so far. */
export class JsonStream {
  values = [];
  /** Set once text had to be dropped, so what's read can't be trusted to be everything. */
  error = null;
  #buffer = "";

  push(chunk) {
    this.#buffer += String(chunk);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    let consumed = 0;
    for (let at = 0; at < this.#buffer.length; at++) {
      const c = this.#buffer[at];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        if (depth > 0) inString = true;
      } else if (c === "{" && depth > 0 && at > 0 && this.#buffer[at - 1] === "\n") {
        // A new event at the start of a line: whatever was open before it was noise, and it starts again here.
        start = at;
        depth = 1;
      } else if (c === "{" || c === "[") {
        if (depth === 0) start = at;
        depth += 1;
      } else if ((c === "}" || c === "]") && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          try {
            this.values.push(JSON.parse(this.#buffer.slice(start, at + 1)));
          } catch {
            // Not a value after all, such as a stray bracket in a banner: it's dropped.
          }
          consumed = at + 1;
          start = -1;
        }
      } else if (depth === 0 && c === "\n") {
        // Text between values, such as a banner line, is dropped once its line ends.
        consumed = at + 1;
      }
    }
    this.#buffer = this.#buffer.slice(consumed);
    if (this.#buffer.length > MAX_PENDING_CHARS) {
      this.error = `over ${MAX_PENDING_CHARS} characters of the tail's output never formed a value, and were dropped`;
      this.#buffer = "";
    }
    return this;
  }
}
