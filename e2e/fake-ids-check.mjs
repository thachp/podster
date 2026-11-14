// A static check that no two API spec files can use the same ID at a shared stand-in.
//
//   node fake-ids-check.mjs [--self-test]
//
// The stand-ins in apps/api/test (`fake-github.ts`, `fake-github-release.ts`, and `fake-content.ts`'s upload part) run
// once, in the test run's own process, for every spec file at the same time, and keep their state by repository ID or
// by script name. Two files under one ID wipe each other's reset, seed and fault mid-test, and pass only by timing:
// `release-read` and `release-driver` both used 987650777. So every ID comes from `apps/api/test/fake-ids.ts`, a block
// per file by its own name, and this check holds that:
//
// - registry: every entry of `FAKE_ID_BLOCKS` reads as `"name": { block: N, tag: "xx" }`; no block, tag or name is
//   used twice; a tag is two lowercase letters, so one label prefix is never the start of another; each name is a spec
//   file's.
// - not-own: a spec file calls `fakeIds(...)` only with its own name, so two files can't share a block.
// - unregistered: a spec file that keys a stand-in (it names `github-fake.example.com` or
//   `github-release-fake.example.com`, or `content-fake.example.com` with a `script=`) calls `fakeIds("<its name>")`.
// - literal: such a file gives a name like a repository or a gate (`REPO`, `REPO_ID`, `nextRepo`, `gate`) a number of
//   six digits or more, or asks the stand-in about `?repo=` and a number, rather than an ID from its block.
//
// Why a static check rather than the stand-in refusing a second file's claim: the stand-in only sees control calls, and
// only when both files run in one process, so a clash between files run apart, or reached by a call that doesn't carry
// the claim, would still pass. This fails the PR that writes the clash, every time, without running anything.
//
// KNOWN GAPS: an ID computed from another (`REPO_ID + 1`) is trusted to stay in its file's block, as one written into a
// test's body (a `pulls` entry, `{ id: 42 }`) is; a stand-in reached under another host name isn't seen.
//
// Exit 1 if anything is found.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(here, "../apps/api/test");

/** Problems in the registry's source, given the spec files' names (without `.spec.ts`). */
export function registryProblems(source, specNames) {
  const problems = [];
  const body = source.match(/export const FAKE_ID_BLOCKS = \{\n([\s\S]*?)\n\} as const;/);
  if (!body) return ["registry: fake-ids.ts has no `export const FAKE_ID_BLOCKS = { ... } as const;`"];
  const seen = { name: new Map(), block: new Map(), tag: new Map() };
  for (const line of body[1].split("\n")) {
    if (!line.trim()) continue;
    const entry = line.match(/^ {2}"([a-z0-9-]+)": \{ block: (\d+), tag: "([^"]*)" \},$/);
    if (!entry) { problems.push(`registry: an entry that doesn't read as \`"name": { block: N, tag: "xx" },\`: ${line.trim()}`); continue; }
    const [, name, block, tag] = entry;
    for (const [kind, value] of [["name", name], ["block", block], ["tag", tag]]) {
      const before = seen[kind].get(value);
      if (before) problems.push(`registry: ${kind} ${value} is ${before}'s and ${name}'s`);
      else seen[kind].set(value, name);
    }
    if (Number(block) < 1) problems.push(`registry: ${name}'s block must be 1 or more`);
    if (!/^[a-z]{2}$/.test(tag)) problems.push(`registry: ${name}'s tag ${JSON.stringify(tag)} isn't two lowercase letters`);
    if (!specNames.includes(name)) problems.push(`registry: ${name} has no ${name}.spec.ts`);
  }
  return problems;
}

const KEYS_A_FAKE = /github-fake\.example\.com|github-release-fake\.example\.com|content-fake\.example\.com[^\n]*script=/;
const LITERAL_ID = /\b(\w*(?:repo|REPO|Repo|gate|Gate|GATE)\w*)\s*=\s*\d[\d_]{5,}\b|\?repo=\d/;

/** Problems in one spec file, by its name (without `.spec.ts`), given the registry's names. */
export function specProblems(name, source, registered) {
  const problems = [];
  const asked = [...source.matchAll(/\bfakeIds\(\s*(["'`])([^"'`]*)\1\s*\)/g)].map((m) => m[2]);
  for (const other of asked) if (other !== name) problems.push(`not-own: ${name}.spec.ts takes ${other}'s IDs; a file takes only its own`);
  if (!KEYS_A_FAKE.test(source)) return problems;
  if (!asked.includes(name)) problems.push(`unregistered: ${name}.spec.ts uses a shared stand-in without fakeIds("${name}")`);
  if (!registered.includes(name)) problems.push(`unregistered: ${name} isn't in fake-ids.ts's FAKE_ID_BLOCKS`);
  source.split("\n").forEach((line, i) => {
    const found = line.match(LITERAL_ID);
    if (found) problems.push(`literal: ${name}.spec.ts:${i + 1} gives a stand-in's ID as a number of its own (${found[0].trim()}); take it from fakeIds("${name}")`);
  });
  return problems;
}

/** Every problem, from the registry's source and the spec files' sources by name. */
export function check(registrySource, specs) {
  const names = Object.keys(specs);
  const registered = [...registrySource.matchAll(/^ {2}"([a-z0-9-]+)":/gm)].map((m) => m[1]);
  return [...registryProblems(registrySource, names), ...names.flatMap((name) => specProblems(name, specs[name], registered))];
}

function selfTest() {
  let failed = 0;
  const is = (title, got, wanted) => {
    const passed = JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} ${title}${passed ? "" : `\n     wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`}`);
  };
  const registry = (...entries) => `export const FAKE_ID_BLOCKS = {\n${entries.join("\n")}\n} as const;\n`;
  const good = registry(`  "a": { block: 1, tag: "aa" },`, `  "b": { block: 2, tag: "bb" },`);
  const user = (name, more = "") => `const IDS = fakeIds("${name}");\nconst REPO = IDS.id(0);\nfetch(\`https://github-release-fake.example.com/reset?repo=\${REPO}\`);\n${more}`;
  const kinds = (problems) => problems.map((p) => p.split(":")[0]);

  is("two files, each with its own block, pass", check(good, { a: user("a"), b: user("b") }), []);
  is("a file that touches no stand-in needs no block", check(good, { a: user("a"), b: user("b"), c: "const REPO_ID = 987654321;\n" }), []);
  is("the clash that came in: two files each giving 987650777 to the release stand-in", kinds(check(good, {
    a: "const REPO = 987650777;\nfetch(`https://github-release-fake.example.com/reset?repo=${REPO}`);\n",
    b: "const REPO = 987650777;\nfetch(`https://github-release-fake.example.com/seed?repo=${REPO}`);\n",
  })), ["unregistered", "literal", "unregistered", "literal"]);
  is("a file that takes another file's block fails", kinds(check(good, { a: user("a"), b: user("a") })), ["not-own", "unregistered"]);
  is("a file that keys the stand-in under its own name but adds a number of its own fails", kinds(check(good, { a: user("a", "const OTHER_REPO = 987_650_778;\n"), b: user("b") })), ["literal"]);
  is("a random start of its own is still a number of its own", kinds(check(good, { a: user("a", "let nextRepo = 11_000_000 + Math.floor(Math.random() * 1_000_000) * 10;\n"), b: user("b") })), ["literal"]);
  is("a gate number of its own fails", kinds(check(good, { a: user("a", "  const gate = 900_000 + Math.floor(Math.random() * 90_000);\n"), b: user("b") })), ["literal"]);
  is("asking the stand-in about a written repository number fails", kinds(check(good, { a: user("a", "fetch('https://github-fake.example.com/agent-tokens?repo=4242');\n"), b: user("b") })), ["literal"]);
  is("the general stand-in and the provider's upload part count too", kinds(check(good, {
    a: "fetch(`https://github-fake.example.com/agent-gate?repo=${x}`);\n",
    b: "fetch(`https://content-fake.example.com/upload-state?script=${s}`);\n",
  })), ["unregistered", "unregistered"]);
  is("the provider's shared reset, keyed by nothing, needs no block", check(good, { a: user("a"), b: user("b"), takedown: "fetch(`https://content-fake.example.com${path}`);\n" }), []);
  is("a file that keys a stand-in and isn't in the registry fails", kinds(check(good, { a: user("a"), b: user("b"), c: user("c") })), ["unregistered"]);
  is("one block twice fails", kinds(check(registry(`  "a": { block: 1, tag: "aa" },`, `  "b": { block: 1, tag: "bb" },`), { a: user("a"), b: user("b") })), ["registry"]);
  is("one tag twice fails, and so does one that isn't two lowercase letters", kinds(check(registry(`  "a": { block: 1, tag: "aa" },`, `  "b": { block: 2, tag: "aa" },`, `  "c": { block: 3, tag: "c" },`), { a: user("a"), b: user("b"), c: user("c") })), ["registry", "registry"]);
  is("one name twice fails", kinds(check(registry(`  "a": { block: 1, tag: "aa" },`, `  "a": { block: 2, tag: "bb" },`), { a: user("a") })), ["registry"]);
  is("block 0 fails", kinds(check(registry(`  "a": { block: 0, tag: "aa" },`), { a: user("a") })), ["registry"]);
  is("an entry with no spec file fails", kinds(check(registry(`  "a": { block: 1, tag: "aa" },`, `  "gone": { block: 2, tag: "gg" },`), { a: user("a") })), ["registry"]);
  is("an entry written another way fails, rather than going unread", kinds(check(registry(`  "a": { block: 1, tag: "aa" },`, `  b: { block: 2, tag: "bb" },`), { a: user("a") })), ["registry"]);
  is("a registry that can't be found fails", kinds(check("export const BLOCKS = {};\n", {})), ["registry"]);

  const real = check(readFileSync(join(TEST_DIR, "fake-ids.ts"), "utf8"), readSpecs());
  is("the real registry and specs pass", real, []);

  console.log(failed ? `\n${failed} failed` : "\nfake-ids-check self-test: all passed");
  return failed ? 1 : 0;
}

function readSpecs() {
  const specs = {};
  for (const file of readdirSync(TEST_DIR).sort()) if (file.endsWith(".spec.ts")) specs[file.slice(0, -".spec.ts".length)] = readFileSync(join(TEST_DIR, file), "utf8");
  return specs;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--self-test")) process.exit(selfTest());
  const registry = join(TEST_DIR, "fake-ids.ts");
  const problems = existsSync(registry) ? check(readFileSync(registry, "utf8"), readSpecs()) : ["registry: apps/api/test/fake-ids.ts is missing"];
  for (const problem of problems) console.log(problem);
  console.log(problems.length ? `\nfake-ids-check: ${problems.length} found` : "fake-ids-check: passed: every spec file that keys a shared stand-in takes its IDs from its own block");
  process.exit(problems.length ? 1 : 0);
}
