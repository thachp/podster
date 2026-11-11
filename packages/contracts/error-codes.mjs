// The error codes Podster's API and gateway can answer, collected from their source text with no build step, so
// check.mjs can hold the contract's `Error.code` enum to exactly that set.
//
// What counts as an error code:
//   - In the Rust API and crates: the code in every `ApiError::api(status, "code")`, `ApiError::explained(status,
//     "code", …)` and `refuse(status, "code")`, or a `const NAME: &str = "code"` of the same file passed in its place,
//     and every string in a `code()` method marked `// codes: errors`.
//     Every `code()` method must be marked `// codes: errors`, `// codes: reasons` (reason codes, which are answered
//     as data, never as an error) or `// codes: fields` (names of fields), so a new one can't be left out unnoticed.
//   - The API's own fallback, `internal_error`.
//   - In the gateway: `denied("code", …)`, `error: { code: "code" … }` and `new AgentRefused("code")`.
// A code reached only through internal routes is listed in INTERNAL_ONLY in check.mjs, with why.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const files = (dir, ext) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "target" || name === "test" || name === "tests") return [];
    return statSync(path).isDirectory() ? files(path, ext) : path.endsWith(ext) ? [path] : [];
  });

/** The body of the function whose signature starts at `start`, up to its matching brace. */
function body(text, start) {
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === "{") depth++;
    if (text[at] === "}" && --depth === 0) return text.slice(open, at + 1);
  }
  return text.slice(open);
}

/** `{ codes: Map<code, where>, problems: string[] }` for the repository at `root`. */
export function collectErrorCodes(root) {
  const codes = new Map();
  const problems = [];
  const add = (code, where) => {
    if (!codes.has(code)) codes.set(code, where);
  };
  const rust = [...files(join(root, "apps/api/src"), ".rs"), ...files(join(root, "crates"), ".rs")];
  for (const file of rust) {
    const text = readFileSync(file, "utf8");
    const where = relative(root, file);
    // A code written out, or a constant of this file that holds one.
    const constants = new Map([...text.matchAll(/const ([A-Z_]+): &str = "([a-z_]+)";/g)].map((found) => [found[1], found[2]]));
    for (const found of text.matchAll(/(?:ApiError::(?:api|explained)|\brefuse)\(\s*\d+,\s*(?:"([a-z_]+)"|([A-Z_]+)\b)/g)) {
      const code = found[1] ?? constants.get(found[2]);
      if (code) add(code, where);
      else problems.push(`${where}: an error code from ${found[2]}, which isn't a constant of this file, so it can't be read here`);
    }
    for (const found of text.matchAll(/pub fn code\(&?self\) -> &'static str/g)) {
      const before = text.slice(0, found.index).split("\n").slice(-12).reverse();
      const marker = before.find((line) => /\/\/ codes: /.test(line))?.match(/\/\/ codes: (\w+)/)?.[1];
      const line = text.slice(0, found.index).split("\n").length;
      if (!["errors", "reasons", "fields"].includes(marker)) {
        problems.push(`${where}:${line}: a code() method needs "// codes: errors", "// codes: reasons" or "// codes: fields" above it`);
        continue;
      }
      if (marker !== "errors") continue;
      for (const literal of body(text, found.index).matchAll(/"([a-z_]+)"/g)) add(literal[1], `${where}:${line}`);
    }
  }
  add("internal_error", "apps/api/src/error.rs");
  for (const file of files(join(root, "apps/gateway/src"), ".ts")) {
    const text = readFileSync(file, "utf8");
    const where = relative(root, file);
    for (const pattern of [/\bdenied\(\s*"([a-z_]+)"/g, /error: \{ code: "([a-z_]+)"/g, /new AgentRefused\(\s*"([a-z_]+)"/g]) {
      for (const found of text.matchAll(pattern)) add(found[1], where);
    }
  }
  return { codes, problems };
}
