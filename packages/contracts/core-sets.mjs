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

/** The names of the variants a `pub fn question(self) -> bool { matches!(self, X::A | X::B) }` of `type` names, in declaration order. */
export function subset(source, type, question, names) {
  const body = source.match(new RegExp(`pub enum ${type} \\{([^}]*)\\}`))?.[1];
  const variants = [...(body ?? "").matchAll(/^\s*([A-Z]\w*)\s*(?:\([^)]*\))?\s*,/gm)].map((m) => m[1]);
  // The question that asks about this type: several types may have one of the same name.
  const found = [...source.matchAll(new RegExp(`pub fn ${question}\\(self\\) -> bool \\{([\\s\\S]*?)\\n    \\}`, "g"))].map((m) => m[1]).find((text) => text.includes(`${type}::`));
  if (!found || !/^\s*matches!\(\s*self,[\s\S]*\)\s*$/.test(found)) throw new Error(`${type}: no ${question}() that is one matches! on self`);
  const named = variants.flatMap((variant, at) => (new RegExp(`${type}::${variant}\\b`).test(found) ? [names[at]] : []));
  if (!named.length || named.length !== (found.match(new RegExp(`${type}::`, "g")) ?? []).length) throw new Error(`${type}: ${question}() names something that isn't a variant`);
  return named;
}

/** Every closed set and fixed value the contract and the room's tables must equal. `root` is the repository's URL. */
export function coreSets(root) {
  const release = read(root, "crates/core/src/release.rs");
  const requests = read(root, "crates/core/src/hostname_requests.rs");
  const requestStates = enumNames(requests, "HostnameRequestState", "name");
  const releaseStates = enumNames(release, "ReleaseState", "name");
  const claimStates = enumNames(requests, "HostnameClaimState", "name");
  // A task's release status says the room's states in its own words (M6 step 7): `live` is never one of them.
  const releaseStatusStates = enumNames(read(root, "crates/core/src/release_status.rs"), "ReleaseStatusState", "name");
  // Why a release waits, as the status says it while it does (2026-11-24): a closed set of words, never the job's code.
  const releaseWaitings = enumNames(read(root, "crates/core/src/release_status.rs"), "ReleaseWaiting", "name");
  // An app's data deleted (S4 of the store plan): why it is owed, what the commands answer of it, and the owner's words.
  const appStore = readFileSync(new URL("crates/core/src/app_store.rs", root), "utf8");
  const notice = appStore.match(/pub const DATA_DELETED_NOTICE: &str = "([^"\\]+)";/)?.[1];
  if (notice === undefined) throw new Error("DATA_DELETED_NOTICE: no such constant, as one plain literal");
  return {
    deleteCauses: enumNames(read(root, "crates/core/src/app_store.rs"), "DeleteCause", "code"),
    dataStates: enumNames(read(root, "crates/core/src/app_store.rs"), "DataState", "code"),
    dataDeletedNotice: notice,
    releaseStates,
    releaseStatusStates,
    releaseWaitings,
    servingReleaseStates: subset(release, "ReleaseState", "serves", releaseStates),
    hostnameClaimStates: claimStates,
    holdingHostnameClaimStates: subset(requests, "HostnameClaimState", "holds", claimStates),
    unpublishCauses: enumNames(release, "UnpublishTrigger", "code"),
    approvalPolicies: enumNames(release, "ApprovalPolicy", "name"),
    hostnameRequestStates: requestStates,
    // What a room's owner is told of a hostname's setup (2026-11-25): a fixed word, never a provider's own text.
    hostnameSetupStatuses: enumNames(requests, "HostnameSetup", "name"),
    openHostnameRequestStates: subset(requests, "HostnameRequestState", "is_open", requestStates),
    environment: constant(release, "ENVIRONMENT"),
    releaseIdPrefix: constant(release, "RELEASE_ID_PREFIX"),
    maxLabelLen: Number(constant(release, "MAX_LABEL_LEN")),
    maxScriptNameLen: Number(constant(release, "MAX_SCRIPT_NAME_LEN")),
    idLen: Number(constant(release, "ID_LEN")),
    // A task's prompt inputs (M7 step 4): what its provenance names, and what the room records an author for.
    promptInputs: enumNames(read(root, "crates/core/src/task_inputs.rs"), "PromptInput", "name"),
  };
}

/** The values of a `column … CHECK (column IN ('a', 'b'))` in the room's migrations, in order. The table may be made `IF NOT EXISTS`. */
export function columnCheck(store, table, column) {
  const create = store.match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\)(?: WITHOUT ROWID)?;\\n`))?.[1];
  if (create === undefined) throw new Error(`${table}: no such table in the room's migrations`);
  const found = [...create.matchAll(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "g"))];
  if (found.length !== 1) throw new Error(`${table}.${column}: ${found.length} closed checks, not one`);
  return found[0][1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
}
