// Reads the closed sets `crates/core` defines for release (M6, ADR 0010), by a text scan of its source, so the
// contract's enums and the room's column checks can be compared with them. The rules are the authority: the wire name
// of a value is exactly the string core's own `name()` or `code()` gives it, and nothing here restates one.
//
// The scan reads a `pub enum X { … }` for its variants, the `X::Variant => "text"` arms of the named method, and
// `X::ALL`'s length. It refuses an enum whose variants, arms and `ALL` don't agree, so a variant added without a name
// fails here and not silently.
import { readFileSync } from "node:fs";

const read = (root, file) => readFileSync(new URL(file, root), "utf8").replace(/\/\/[^\n]*/g, "");

/** The names of `type`'s variants, in declaration order, as `method` gives them. */
export function enumNames(source, type, method) {
  const body = source.match(new RegExp(`pub enum ${type} \\{([^}]*)\\}`))?.[1];
  if (body === undefined) throw new Error(`${type}: no such enum`);
  const variants = [...body.matchAll(/^\s*([A-Z]\w*)\s*(?:\([^)]*\))?\s*,/gm)].map((m) => m[1]);
  const start = source.search(new RegExp(`pub fn ${method}\\(&?self\\) -> &'static str`));
  const arms = new Map();
  // The first `fn name`/`fn code` whose arms are this type's: several types in one file each have one.
  for (const found of source.matchAll(new RegExp(`pub fn ${method}\\(&?self\\) -> &'static str \\{([\\s\\S]*?)\\n    \\}`, "g"))) {
    const mine = [...found[1].matchAll(new RegExp(`${type}::(\\w+)(?:\\([^)]*\\))? => "([^"]*)"`, "g"))];
    if (mine.length) { for (const arm of mine) arms.set(arm[1], arm[2]); break; }
  }
  if (start < 0 || !arms.size) throw new Error(`${type}: no ${method}() with its arms`);
  const missing = variants.filter((variant) => !arms.has(variant));
  if (missing.length || arms.size !== variants.length) throw new Error(`${type}: ${method}() doesn't name exactly its variants (${missing.join(", ") || "an arm for no variant"})`);
  const all = source.match(new RegExp(`pub const ALL: \\[${type}; (\\d+)\\]`))?.[1];
  if (all !== undefined && Number(all) !== variants.length) throw new Error(`${type}: ALL holds ${all} of ${variants.length} variants`);
  const names = variants.map((variant) => arms.get(variant));
  if (new Set(names).size !== names.length) throw new Error(`${type}: two variants share a name`);
  return names;
}

/** A `pub const NAME: … = value;` of core's, as text. */
export function constant(source, name) {
  const found = source.match(new RegExp(`pub const ${name}: [^=]+ = "?([^";]+)"?;`))?.[1];
  if (found === undefined) throw new Error(`${name}: no such constant`);
  return found;
}

/** Every closed set and fixed value the contract and the room's tables must equal. `root` is the repository's URL. */
export function coreSets(root) {
  const release = read(root, "crates/core/src/release.rs");
  const requests = read(root, "crates/core/src/hostname_requests.rs");
  const requestStates = enumNames(requests, "HostnameRequestState", "name");
  const open = requests.match(/pub fn is_open\(self\) -> bool \{([\s\S]*?)\n    \}/)?.[1];
  if (!open) throw new Error("HostnameRequestState: no is_open()");
  const variants = [...requests.match(/pub enum HostnameRequestState \{([^}]*)\}/)[1].matchAll(/^\s*([A-Z]\w*),/gm)].map((m) => m[1]);
  return {
    releaseStates: enumNames(release, "ReleaseState", "name"),
    unpublishCauses: enumNames(release, "UnpublishTrigger", "code"),
    approvalPolicies: enumNames(release, "ApprovalPolicy", "name"),
    hostnameRequestStates: requestStates,
    openHostnameRequestStates: variants.flatMap((variant, at) => (new RegExp(`HostnameRequestState::${variant}\\b`).test(open) ? [requestStates[at]] : [])),
    environment: constant(release, "ENVIRONMENT"),
    releaseIdPrefix: constant(release, "RELEASE_ID_PREFIX"),
    maxLabelLen: Number(constant(release, "MAX_LABEL_LEN")),
    maxScriptNameLen: Number(constant(release, "MAX_SCRIPT_NAME_LEN")),
    idLen: Number(constant(release, "ID_LEN")),
  };
}

/** The values of a `column … CHECK (column IN ('a', 'b'))` in the room's migrations, in order. */
export function columnCheck(store, table, column) {
  const create = store.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\);\\n`))?.[1];
  if (create === undefined) throw new Error(`${table}: no such table in the room's migrations`);
  const found = [...create.matchAll(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "g"))];
  if (found.length !== 1) throw new Error(`${table}.${column}: ${found.length} closed checks, not one`);
  return found[0][1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
}
