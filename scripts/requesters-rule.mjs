// The rule that staging is never deployed with managed repositories switched on and no list of who may ask for one.
// scripts/deploy-staging refuses on it, and the API's configuration test (through apps/api/vitest.config.ts) fails on it.
//
// The API reads the list in Rust (`RepositoryRequesters::parse` in crates/core/src/provisioning.rs). This mirrors that
// grammar for a value that lets somebody ask. scripts/test/fixtures/requesters-grammar.json holds values each side must
// read the same way: scripts/test/deploy-staging-selftest checks this file against it, and
// crates/policy/tests/repositories.rs checks the Rust.
//
//   node scripts/requesters-rule.mjs apps/api/wrangler.jsonc
//
// It reads the file and nothing else. A variable set by hand on the deployed Worker isn't seen here.

const ENTRY = /^(operators|test-people|per_[A-Za-z0-9_-]+)$/;
const MAX_ENTRY = 128;

/** Whether a value is a well-formed list: a string of entries separated by commas, each `operators`, `test-people` or a person's ID. */
export function validRequesters(value) {
  if (typeof value !== "string" || value === "") return false;
  return value.split(",").every((raw) => {
    const entry = raw.replace(/^ +| +$/g, "");
    return entry.length <= MAX_ENTRY && ENTRY.test(entry);
  });
}

/**
 * Why a Worker's configuration file must not be deployed to staging, or null: its staging variables have
 * MANAGED_REPOSITORIES exactly "true" and REPOSITORY_REQUESTERS absent, not a string, empty or malformed. A file that
 * can't be read as JSON with whole-line comments is a problem too, since nothing can then be said about it.
 */
export function stagingRequestersProblem(configText) {
  let vars;
  try {
    vars = JSON.parse(String(configText).replace(/^\s*\/\/.*$/gm, "")).env?.staging?.vars;
  } catch {
    return "the API's configuration can't be read, so whether its staging block names who may ask for a repository can't be told";
  }
  if (vars?.MANAGED_REPOSITORIES !== "true") return null;
  const list = vars.REPOSITORY_REQUESTERS;
  if (list === undefined) return 'the API\'s staging variables switch MANAGED_REPOSITORIES on and set no REPOSITORY_REQUESTERS, which would let anyone who signs in ask for a repository';
  if (!validRequesters(list)) return "the API's staging variables switch MANAGED_REPOSITORIES on, and REPOSITORY_REQUESTERS isn't a well-formed list (operators, test-people or person IDs, separated by commas)";
  return null;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  let text;
  try {
    text = readFileSync(process.argv[2] ?? "", "utf8");
  } catch {
    console.log(`${process.argv[2] ?? "(no file named)"} can't be read, so whether staging names who may ask for a repository can't be told`);
    process.exit(1);
  }
  const problem = stagingRequestersProblem(text);
  if (problem) {
    console.log(problem);
    process.exit(1);
  }
}
