// Reads the gateway's TypeScript just enough to check how the pairing routes are wired (M7 step 5(b), ruling L5): that
// the dashboard's passthrough refuses `/v1/pairing` in real code, and that a handler is really called. It's a scanner,
// not a parser: comments are blanked first; strings, template literals and regular expression literals are read whole,
// so a quote or `//` inside one changes nothing; and a match must be a whole expression or array entry, not a substring
// of a longer one.
//
// What it can't see: a regular expression after `)` or `]` (read as division, as TypeScript's grammar mostly does), a
// `${…}` holding a backtick inside a template literal, a call through another name, and a passthrough that refuses
// `/v1/pairing` in a helper it calls.

/** Characters after which a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const KEYWORDS_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)\s*$/;

/** The source with every comment replaced by spaces, keeping line breaks. With `strings`, string contents are blanked too. */
export function blank(source, { strings = false } = {}) {
  let out = "";
  let i = 0;
  const keep = (text) => (out += text);
  const space = (text) => (out += text.replace(/[^\n]/g, " "));
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      space(source.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      space(source.slice(i, stop));
      i = stop;
    } else if (c === "/" && (BEFORE_REGEX.has(out.trimEnd().slice(-1)) || KEYWORDS_BEFORE_REGEX.test(out))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      while (/[a-z]/.test(source[j + 1] ?? "")) j += 1;
      const literal = source.slice(i, j + 1);
      keep(strings ? literal.replace(/[^\n]/g, " ") : literal);
      i = j + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      const literal = source.slice(i, j + 1);
      if (strings) keep(c + literal.slice(1, -1).replace(/[^\n]/g, " ") + (j < source.length ? c : ""));
      else keep(literal);
      i = j + 1;
    } else {
      keep(c);
      i += 1;
    }
  }
  return out;
}

/** The body of a top-level `function name(...) {...}`, braces balanced over blanked text, or null. */
export function functionBody(source, name) {
  const code = blank(source);
  const shape = blank(source, { strings: true });
  const start = new RegExp(`(?:^|[^\\w$.])function\\s+${name}\\s*\\(`).exec(shape);
  if (!start) return null;
  const open = shape.indexOf("{", start.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < shape.length; i++) {
    if (shape[i] === "{") depth++;
    else if (shape[i] === "}" && --depth === 0) return code.slice(open + 1, i);
  }
  return null;
}

/** Whether `allowedPassthrough` refuses `prefix`: `!path.startsWith("prefix")` in its body, or `prefix` as an array entry there. */
export function passthroughRefuses(source, prefix) {
  const body = functionBody(source, "allowedPassthrough");
  if (body === null) return false;
  const quoted = `(["'\`])${prefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\1`;
  return new RegExp(`!\\s*path\\.startsWith\\(\\s*${quoted}\\s*\\)`).test(body) || new RegExp(`[\\[,]\\s*${quoted}\\s*[,\\]]`).test(body);
}

/** Whether `name(` is called in real code: not in a comment or a string, not a declaration, and not a member of something else. */
export function calls(source, name) {
  const code = blank(source, { strings: true });
  const call = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
  for (const match of code.matchAll(call)) {
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, match.index - 20), match.index))) continue;
    return true;
  }
  return false;
}
