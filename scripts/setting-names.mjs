// The names of the settings the API reads as plain configuration, found in its own source, and the rule that none of
// them is a secret on a deployed Worker. scripts/deploy-staging refuses on that rule before it changes anything.
//
// Why (the deep review of PR #450, 2026-11-18): the API reads `RELEASES`, `HOSTNAME_RESOLVER_URL`,
// `PUBLIC_SUFFIX_RULES`, `CUSTOM_HOSTNAME_*` and `CONTENT_*` through `env.var` and `crate::setting`, which read any
// string binding. A Worker secret of one of those names would switch a feature on, survive every deploy, and never be
// seen by the checks that read apps/api/wrangler.jsonc.
//
// The names aren't listed by hand. A setting's name is either the value of a `const NAME: &str = "NAME";` in a file
// under apps/api/src that reads settings (calls `setting(` or `env.var(`), which is how the release path's modules name
// their settings and the form the API's own tests read them by, or a string literal read directly, as
// `env.var("NAME")` or `setting(env, "NAME")`. A name the source also reads with `env.secret(` is a secret by design
// and is left out, and so is a name in FAILPOINTS_ONLY, below. Today that gives the release path's settings and PUBLIC_ROOMS,
// MANAGED_REPOSITORIES and REPOSITORY_REQUESTERS, which staging sets in wrangler.jsonc and are the same kind of switch.
//
//   node scripts/setting-names.mjs names apps/api/src
//     prints the names, one per line, sorted. Exit 1 if the folder can't be read or gives none, or RELEASES isn't one.
//   node scripts/setting-names.mjs check apps/api/src < secret-list.json
//     reads `wrangler secret list --format json` on stdin. Exit 0 and prints nothing when no secret has one of the
//     names; exit 1 and prints why when one does, or when the list can't be read. Secret names are printed, never values,
//     and `secret list` gives no values.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONST = /const\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([A-Z][A-Z0-9_]*)"\s*;/g;
const READS_SETTING = /\bsetting\s*\(|\benv\s*\.\s*var\s*\(/;
// Read directly by a string literal: `env.var("NAME")`, `setting(env, "NAME")` or `crate::setting(env, "NAME")`.
const LITERAL_READ = /(?:\benv\s*\.\s*var|\bsetting)\s*\(\s*(?:[a-z_][a-z0-9_]*\s*,\s*)?"([A-Z][A-Z0-9_]*)"\s*\)/g;
// Names read only in test builds, under `#[cfg(feature = "failpoints")]`, which staging never builds, so a secret of
// that name changes nothing there. Kept by hand, since telling a `cfg` block's reach from text isn't reliable; a name
// here that the source no longer reads is reported, so the list can't go stale.
export const FAILPOINTS_ONLY = [
  "TEST_STORE_RECONCILE_ACCOUNT", // app_stores.rs, StoreProvider::for_reconcile
];
const SECRET_LITERAL = /\benv\s*\.\s*secret\s*\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g;
const SECRET_BY_NAME = /\benv\s*\.\s*secret\s*\(\s*([A-Z][A-Z0-9_]*)\s*\)/g;

function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.isFile() && entry.name.endsWith(".rs") ? [path] : [];
  });
}

/** The setting names in these sources, given as `{ path: text }`, sorted and without repeats. */
export function settingNames(sources) {
  const settings = new Set();
  const secrets = new Set();
  for (const text of Object.values(sources)) {
    const consts = new Map();
    for (const match of text.matchAll(CONST)) consts.set(match[1], match[2]);
    for (const match of text.matchAll(SECRET_LITERAL)) secrets.add(match[1]);
    for (const match of text.matchAll(SECRET_BY_NAME)) if (consts.has(match[1])) secrets.add(consts.get(match[1]));
    for (const match of text.matchAll(LITERAL_READ)) settings.add(match[1]);
    if (!READS_SETTING.test(text)) continue;
    for (const value of consts.values()) settings.add(value);
  }
  return [...settings].filter((name) => !secrets.has(name)).sort();
}

/** The names a deployed Worker must not hold as secrets: the setting names less those read only in test builds. */
export function guardedNames(sources) {
  return settingNames(sources).filter((name) => !FAILPOINTS_ONLY.includes(name));
}

/** The setting names under a source folder, or a reason they can't be had. */
export function settingNamesIn(dir) {
  let sources;
  try {
    sources = Object.fromEntries(rustFiles(dir).map((path) => [path, readFileSync(path, "utf8")]));
  } catch {
    return { problem: `${dir} can't be read, so which settings the API reads can't be told` };
  }
  const all = settingNames(sources);
  const stale = FAILPOINTS_ONLY.filter((name) => !all.includes(name));
  if (stale.length > 0) return { problem: `FAILPOINTS_ONLY in scripts/setting-names.mjs names ${stale.join(", ")}, which ${dir} no longer reads as a setting` };
  const names = all.filter((name) => !FAILPOINTS_ONLY.includes(name));
  if (names.length === 0) return { problem: `${dir} gives no setting names, so the pattern or the folder is wrong` };
  // A floor, so a broken pattern can't pass by finding the wrong few: the release switch is always among them.
  if (!names.includes("RELEASES")) return { problem: `${dir} gives no RELEASES among its setting names, so the pattern or the folder is wrong` };
  return { names };
}

/** The secret names in `wrangler secret list --format json`'s output, or null if it isn't that. */
export function secretNames(output) {
  const text = String(output).trim();
  const attempts = [text];
  // Anything wrangler prints before the list, such as a banner, is skipped: the list starts on a line of its own.
  const start = text.search(/^\[/m);
  if (start > 0) attempts.push(text.slice(start));
  for (const attempt of attempts) {
    let list;
    try {
      list = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) return null;
    if (!list.every((item) => item !== null && typeof item === "object" && typeof item.name === "string")) return null;
    return list.map((item) => item.name);
  }
  return null;
}

/** Why the deploy must not go ahead, or null: a secret holds a setting's name, or the list can't be read. */
export function secretsProblem(settings, listOutput) {
  const names = secretNames(listOutput);
  if (names === null) return "the API Worker's secret list can't be read, so whether a secret holds a setting's name can't be told";
  const clashes = [...new Set(names.filter((name) => settings.includes(name)))].sort();
  if (clashes.length === 0) return null;
  return `the API Worker on staging holds ${clashes.length === 1 ? "a secret" : "secrets"} named ${clashes.join(", ")}, ` +
    "which the API reads as a plain setting, so it would switch a feature on whatever apps/api/wrangler.jsonc says. " +
    "Deleting it is the owner's to do; nothing on staging changed";
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [mode, dir] = process.argv.slice(2);
  if ((mode !== "names" && mode !== "check") || !dir) {
    console.log("Usage: node scripts/setting-names.mjs names|check <apps/api/src>");
    process.exit(2);
  }
  const found = settingNamesIn(dir);
  if (found.problem) {
    console.log(found.problem);
    process.exit(1);
  }
  if (mode === "names") {
    console.log(found.names.join("\n"));
  } else {
    const problem = secretsProblem(found.names, readFileSync(0, "utf8"));
    if (problem) {
      console.log(problem);
      process.exit(1);
    }
  }
}
