import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The content Worker deploys nowhere until the owner supplies a deploy step for the second account, and never to the
// account that holds podster.dev (M6 step 4(b), decision 217; docs/m6-plan.md, "Keeping it from deploying"). These
// read the package as it is checked in.
//
// What the guard rests on:
//   - With no configuration file, `wrangler deploy` configures the project and deploys it (Cloudflare's "automatic
//     configuration", since wrangler 4.68). So the package carries a default-named `wrangler.jsonc`, and with one
//     there, automatic configuration doesn't run.
//   - That file's `account_id` is no account, and holds characters wrangler refuses before any call scoped to an
//     account.
//   - Wrangler uses the file's `account_id` ahead of `CLOUDFLARE_ACCOUNT_ID` in the environment. Cloudflare's
//     documentation doesn't say which wins: it was read in wrangler's own source, for the versions named below.
//   - Wrangler reads a `.wrangler/deploy/config.json` redirect ahead of `wrangler.jsonc`. None may exist here.
// Nothing here stops a person who types a deploy by hand that doesn't use this file. The guard is against accidents
// by scripts and agents, which deploy only through `scripts/deploy-staging`.

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const repo = (path: string) => readFileSync(new URL(`../../${path}`, root), "utf8");
/** The placeholder, exactly. Never empty: wrangler treats an empty `account_id` as none, and falls back to the environment's. */
const PLACEHOLDER_ACCOUNT = "not an account: this file deploys nowhere";
/** The browser run's configuration: test-only, named by one script, never the default. */
const BROWSER_RUN = "test/browser/browser-run-only.wrangler.jsonc";
/** Every wrangler configuration in the package, by its path, wherever it sits. */
function wranglerConfigs(folder = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(new URL(folder, root), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
    if (entry.isDirectory()) found.push(...wranglerConfigs(`${folder}${entry.name}/`));
    else if (/wrangler/i.test(entry.name) && /\.(jsonc?|toml)$/.test(entry.name)) found.push(`${folder}${entry.name}`);
  }
  return found.sort();
}
const parse = (path: string) => JSON.parse(read(path).replace(/^\s*\/\/.*$/gm, ""));

describe("the package can't be deployed by accident", () => {
  it("has the one default-named configuration file, and nothing that would be read ahead of it", () => {
    const names = readdirSync(root);
    expect(names.filter((name) => /wrangler/i.test(name) && name !== ".wrangler")).toEqual(["wrangler.jsonc"]);
    // A redirect file under `.wrangler/deploy` is read ahead of `wrangler.jsonc`, by `deploy` and `dev` alike. The
    // deploy-time configuration for the second account lives outside this folder, so none is ever here.
    // **This can't fail in CI:** `.wrangler` is ignored by git, so a checkout never has one. It is a guard for a
    // machine where someone ran a tool in this folder, which is where a deploy by accident would happen.
    expect(existsSync(new URL(".wrangler/deploy/config.json", root))).toBe(false);
    expect(existsSync(new URL(".wrangler/deploy", root))).toBe(false);
    for (const name of [".dev.vars", ".env"]) expect(existsSync(new URL(name, root)), name).toBe(false);
  });

  it("holds every wrangler configuration in the package to the same guards, the browser run's among them", () => {
    // Two, and no more: the default one, and the browser run's. A third would need its own line here.
    expect(wranglerConfigs()).toEqual([BROWSER_RUN, "wrangler.jsonc"]);
    for (const path of wranglerConfigs()) {
      const config = parse(path);
      expect(config.account_id, path).toBe(PLACEHOLDER_ACCOUNT);
      expect(/^[A-Za-z0-9_-]+$/.test(config.account_id), path).toBe(false);
      expect([config.workers_dev, config.preview_urls], path).toEqual([false, false]);
      for (const key of ["route", "routes", "env", "triggers", "services", "d1_databases", "r2_buckets", "queues", "tail_consumers", "secrets_store_secrets", "assets", "build"]) expect(config, `${path} ${key}`).not.toHaveProperty(key);
      // The write counter's class is the default configuration's alone; the browser run has no Durable Object.
      if (path !== "wrangler.jsonc") for (const key of ["durable_objects", "migrations"]) expect(config, `${path} ${key}`).not.toHaveProperty(key);
      expect(read(path).replace(/^\s*\/\/.*$/gm, ""), path).not.toMatch(/podster\.dev|podster\.site|workers\.dev|custom_domain|zone_name|pattern/);
    }
    // The browser run's: its name says what it is, it has no binding and no variable at all, and its entry is the
    // test-only one beside it.
    const run = parse(BROWSER_RUN);
    expect(Object.keys(run).sort()).toEqual(["account_id", "compatibility_date", "main", "name", "preview_urls", "workers_dev"]);
    expect([run.name, run.main]).toEqual(["podster-content-browser-run-only", "entry.ts"]);
    // The default configuration's entry is the real one, never the test-only one.
    expect(parse("wrangler.jsonc").main).toBe("src/index.ts");
  });

  it("keeps the test-only entry out of everything but the browser run", () => {
    // Nothing in `src/` imports from outside `src/`: the real Worker can't pull in the in-memory serve entries.
    for (const name of readdirSync(new URL("src/", root))) {
      const imports = [...read(`src/${name}`).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const from of imports) expect(from.startsWith("./") && !from.includes(".."), `${name} imports ${from}`).toBe(true);
      expect(read(`src/${name}`), name).not.toMatch(/\btest\b\/|import\(/);
    }
    // Nothing that runs things names the browser run's files: no workflow, no script under `scripts/`, and no
    // `package.json` anywhere in the repository. One script does, the browser run itself.
    const named = /browser-run-only|test\/browser/;
    const repoRoot = new URL("../../", root);
    const walk = (folder: string): string[] => readdirSync(new URL(folder, repoRoot), { withFileTypes: true }).flatMap((entry) => {
      if (["node_modules", ".git", "target", "build", ".wrangler"].includes(entry.name)) return [];
      return entry.isDirectory() ? walk(`${folder}${entry.name}/`) : [`${folder}${entry.name}`];
    });
    const runners = [...walk(".github/"), ...walk("scripts/"), ...["apps/", "packages/", "e2e/", "spikes/"].flatMap(walk).filter((path) => path.endsWith("/package.json") || path === "package.json")];
    expect(runners.length).toBeGreaterThan(20);
    expect(runners).toContain(".github/workflows/ci.yml");
    expect(runners).toContain("scripts/deploy-staging");
    expect(runners).toContain("apps/content/package.json");
    expect(runners).toContain("e2e/package.json");
    for (const path of runners) expect(repo(path), path).not.toMatch(named);
    expect(repo("e2e/content-sandbox.mjs")).toContain(`"--config", "${BROWSER_RUN}"`);
    // And each script that runs it does so on this machine only: the loopback address, local mode, no remote and no
    // tunnel. There are two: the browser run, and the API spike, which names its own test entry beside the same
    // configuration.
    for (const path of ["e2e/content-sandbox.mjs", "e2e/content-sandbox-api.mjs"]) {
      const script = repo(path);
      expect(script, path).toContain(`"--config", "${BROWSER_RUN}"`);
      expect(script, path).toContain('"--ip", "127.0.0.1"');
      expect(script, path).toContain('"--local"');
      expect(script.replace(/^\s*\/\/.*$/gm, ""), path).not.toMatch(/--remote|--tunnel|0\.0\.0\.0|wrangler", \["deploy/);
    }
    // The spike also starts a proxy and a TLS server of its own. Each listens on the loopback address and no other:
    // the one place the script calls `listen` names it.
    const spike = repo("e2e/content-sandbox-api.mjs").replace(/^\s*\/\/.*$/gm, "");
    expect(spike.match(/\.listen\(/g)).toHaveLength(1);
    expect(spike).toContain('server.listen(0, "127.0.0.1"');
    expect(spike).toContain('"dev", "test/browser/api-entry.ts"');
    // No other script under `e2e` starts this package's Worker.
    const starters = walk("e2e/").filter((path) => path.endsWith(".mjs") && repo(path).includes("apps/content") && /wrangler/.test(repo(path)));
    expect(starters.sort()).toEqual(["e2e/content-sandbox-api.mjs", "e2e/content-sandbox.mjs"]);
  });

  it("aims at no account, has no route and no environment, and switches both public addresses off", () => {
    const config = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
    expect(Object.keys(config).sort()).toEqual(["account_id", "compatibility_date", "dispatch_namespaces", "durable_objects", "kv_namespaces", "main", "migrations", "name", "preview_urls", "vars", "workers_dev"]);
    // Its variables: the content domain, a placeholder under `.invalid` that nobody can hold; the write cap's two
    // settings, the owner's figures of 2026-11-16; and the dispatch's two limits, the architect's figures of 2026-11-25.
    // Each a decimal string. The code holds no default for any of them.
    expect(config.vars).toEqual({ CONTENT_DOMAIN: "content-domain.invalid", WRITE_BUDGET_WRITES: "300", WRITE_BUDGET_WINDOW_MS: "600000", APP_LIMIT_CPU_MS: "50", APP_LIMIT_SUBREQUESTS: "50" });
    expect([config.workers_dev, config.preview_urls]).toEqual([false, false]);
    for (const key of ["route", "routes", "env", "triggers", "services", "d1_databases", "r2_buckets", "queues", "tail_consumers", "secrets_store_secrets", "assets", "build"]) expect(config, key).not.toHaveProperty(key);
    // The write counter: one class, this Worker's own (no `script_name`, so it binds no other Worker's class), made
    // by the one migration, as a SQLite-backed class. Declaring it deploys nothing: the guards above still hold.
    expect(config.durable_objects).toEqual({ bindings: [{ name: "WRITE_COUNTER", class_name: "WriteCounter" }] });
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["WriteCounter"] }]);
    // The placeholder is unchanged, isn't empty, and holds characters outside the ones wrangler takes for an
    // account's ID (`/^[A-Za-z0-9_-]+$/` in the versions below), so wrangler refuses it before any call scoped to an account.
    expect(config.account_id).toBe(PLACEHOLDER_ACCOUNT);
    expect(/^[A-Za-z0-9_-]+$/.test(config.account_id)).toBe(false);
    expect(/^[0-9a-f]{32}$/.test(config.account_id)).toBe(false);
    // Its only two bindings, with placeholders that exist on no account.
    expect(config.kv_namespaces).toEqual([{ binding: "SERVE", id: "0".repeat(32) }]);
    expect(config.dispatch_namespaces).toEqual([{ binding: "APPS", namespace: "placeholder-no-such-namespace" }]);
    // Nothing in the file reads as an account's or a namespace's real ID, or as a route on a host of Podster's.
    const text = read("wrangler.jsonc");
    expect(text.match(/[0-9a-f]{32}/g)).toEqual(["0".repeat(32)]);
    expect(text.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/podster\.dev|podster\.site|workers\.dev|custom_domain|zone_name|pattern/);
  });

  it("pins the wrangler it was verified on, and reads that installed copy's own source for the two things it rests on", () => {
    // The package has its own wrangler, at one exact version, so a tool run in this folder never resolves another
    // from a cache or the registry: an older one, such as 4.92.0, has no local check of an account's ID at all.
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.devDependencies.wrangler).toBe("4.157.0");
    expect(JSON.parse(read("package-lock.json")).packages["node_modules/wrangler"].version).toBe("4.157.0");
    expect(JSON.parse(read("node_modules/wrangler/package.json")).version).toBe("4.157.0");
    // Neither of these is a documented promise, so they are read here, in the copy that is installed. If an upgrade
    // flipped the order, a deploy from the committed file would put an unreachable script on the account in the
    // shell, the one that holds podster.dev: no public address, but a script there all the same. An upgrade fails
    // this test until the source is read again.
    const source = read("node_modules/wrangler/wrangler-dist/cli.js");
    // 1. The file's `account_id` is used ahead of the environment's, and checked for its form on the way.
    const start = source.indexOf("function getActiveAccountId(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, start + 900);
    const [fromFile, fromEnv] = [body.indexOf("config2.account_id"), body.indexOf("getCloudflareAccountIdFromEnv()")];
    expect(fromFile).toBeGreaterThan(0);
    expect(fromEnv).toBeGreaterThan(fromFile);
    expect(body.slice(fromFile, fromEnv)).toMatch(/return validateAccountId\(\s*config2\.account_id,/);
    // 2. That form: letters, digits, `-` and `_` only, or wrangler throws. It throws before any call that is scoped
    //    to an account. It is not before every call: wrangler may refresh a login first.
    expect(source).toContain("ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/");
    expect(source).toMatch(/function validateAccountId\(accountId, source\) \{\s*if \(!ACCOUNT_ID_PATTERN\.test\(accountId\)\) \{\s*throw new UserError\(/);
  });

  it("has no deploy script, and isn't known to the staging deploy", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.scripts).sort()).toEqual(["test", "typecheck"]);
    expect(JSON.stringify(pkg)).not.toMatch(/deploy/);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@cloudflare/workers-types", "@types/node", "typescript", "vitest", "wrangler"]);
    expect(pkg.dependencies).toBeUndefined();
    for (const script of ["scripts/deploy-staging", "scripts/staging-probes"]) expect(repo(script), script).not.toMatch(/apps\/content|podster-content/);
    // CI checks and tests the package and does nothing else with it.
    const ci = repo(".github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  content:"), ci.indexOf("\n  gateway:"));
    expect(job).toContain("working-directory: apps/content");
    expect(job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")).not.toMatch(/deploy|wrangler|secrets\./);
    // It installs without running any package's install script: the tests only read wrangler's source.
    expect([...job.matchAll(/- run: (.+)/g)].map((match) => match[1])).toEqual(["npm ci --ignore-scripts", "npm run typecheck", "npm test"]);
  });
});

describe("the Worker reaches nothing but its three bindings", () => {
  const sources = readdirSync(new URL("src/", root)).map((name) => [name, read(`src/${name}`)] as const);

  it("reads one namespace, asks one dispatch namespace and its own write counter, and names no other binding, host or secret", () => {
    expect(sources.map(([name]) => name).sort()).toEqual(["budget.ts", "counter.ts", "handle.ts", "index.ts", "limits.ts", "names.ts", "requests.ts"]);
    const all = sources.map(([, text]) => text).join("\n");
    expect([...new Set([...all.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]))].sort()).toEqual(["APPS", "APP_LIMIT_CPU_MS", "APP_LIMIT_SUBREQUESTS", "CONTENT_DOMAIN", "SERVE", "WRITE_BUDGET_WINDOW_MS", "WRITE_BUDGET_WRITES", "WRITE_COUNTER"]);
    // Nothing is logged for a request but a failed dispatch's line (ADR 0010's "Logs"): one console call, in the entry,
    // with the line's two fields and nothing else. The counter logs nothing.
    expect([...all.matchAll(/\bconsole\b/g)]).toHaveLength(1);
    expect(sources.find(([name]) => name === "index.ts")?.[1]).toContain("log: (line) => console.log(JSON.stringify({ event: line.event, release: line.release })),");
    // No write to the namespace, no outbound request of its own, and no cache or timer.
    for (const word of [".delete(", ".list(", "fetch(\"", "fetch(`", "caches.", "D1Database", "R2Bucket", "setTimeout", "setInterval", "setAlarm", "process.env", "podster.dev", "Authorization"]) expect(all, word).not.toContain(word);
    // The only storage written is the counter's own object's, in the counter, and only by its one key.
    for (const [name, text] of sources) {
      if (name === "counter.ts") continue;
      for (const word of [".put(", "storage.", "DurableObjectState"]) expect(text, `${name} ${word}`).not.toContain(word);
    }
    const counter = read("src/counter.ts");
    expect(counter.match(/\.put\(/g)).toHaveLength(1);
    expect(counter).toContain("await storage.put(COUNT_KEY, ");
    // Durable Objects are named in two files only: the counter's class, and the entry that binds its namespace.
    expect(sources.filter(([, text]) => text.includes("DurableObject")).map(([name]) => name).sort()).toEqual(["counter.ts", "index.ts"]);
    // Two `fetch` calls: the dispatch namespace's own, in the handler, and the write counter's object, in the counter.
    expect(all.match(/\.fetch\(/g)).toHaveLength(2);
    expect(read("src/handle.ts").match(/\.fetch\(/g)).toHaveLength(1);
    expect(counter.match(/\.fetch\(/g)).toHaveLength(1);
  });

  it("exports the counter's class from the Worker's entry, under the name the configuration declares", async () => {
    const entry = await import("../src/index");
    const counter = await import("../src/counter");
    expect(entry.WriteCounter).toBe(counter.WriteCounter);
    expect(Object.keys(entry).sort()).toEqual(["WriteCounter", "default"]);
    // The counter is reached by the handler's one write path, through the binding, and by nothing else.
    expect(read("src/index.ts").match(/env\.WRITE_COUNTER/g)).toHaveLength(1);
  });

  it("keeps the code-apps switch a constant that nothing configures, flipped either way in one line", () => {
    const handle = read("src/handle.ts");
    // Exactly one definition, true or false: turning it off (or on) is a change to this one line alone, and this test
    // holds either way. Nothing else reads a setting for it.
    expect(handle.match(/export const CODE_APPS_ENABLED/g)?.length).toBe(1);
    expect(handle).toMatch(/^export const CODE_APPS_ENABLED: boolean = (true|false);$/m);
    // The Worker's entry reads no binding or variable for it. A host's kind comes from the mark on its serve entry
    // alone (`podster_core::serve_entry`), read in the handler, and nothing the entry passes can say otherwise.
    const index = read("src/index.ts");
    expect(index.replaceAll("CODE_APPS_ENABLED", "")).not.toMatch(/CODE_APPS/i);
    for (const [name, text] of [["index", index], ["handle", handle]]) expect(text, name).not.toMatch(/hostKind/);
    // And it passes the switch itself, the constant, as the request's: never anything else.
    expect(index.match(/codeApps:/g)).toHaveLength(1);
    expect(index).toContain("codeApps: CODE_APPS_ENABLED,");
    expect(read("wrangler.jsonc")).not.toMatch(/CODE_APPS|code_apps/i);
  });

  it("gives every dispatch to a host with code its limits, from two settings with no figure in the code", () => {
    const index = read("src/index.ts");
    expect(index.match(/limits:/g)).toHaveLength(1);
    expect(index).toContain("limits: limitsFromSettings(env.APP_LIMIT_CPU_MS, env.APP_LIMIT_SUBREQUESTS),");
    // The namespace is asked through the entry's one pass-through, which forwards exactly what the handler gives it.
    expect(index).toContain("apps: { get: (name, args, options) => env.APPS.get(name, args, options) },");
    // The figures are the architect's of 2026-11-25, in the committed configuration only: none is in the code.
    for (const [name, text] of sources) expect(text, name).not.toMatch(/cpuMs:\s*[0-9]|subRequests:\s*[0-9]/);
    // The handler asks the namespace in one place, and gives a host with code its limits there.
    const handle = read("src/handle.ts");
    expect(handle.match(/deps\.apps\.get\(/g)).toHaveLength(2);
    expect(handle).toContain("deps.apps.get(script, {}, { limits: { cpuMs: limits.cpuMs, subRequests: limits.subRequests } })");
  });

  it("never holds the word that would give a sandboxed page its real origin back", () => {
    const FORBIDDEN = ["allow", "same", "origin"].join("-");
    for (const [name, text] of sources) expect(text, name).not.toContain(FORBIDDEN);
    expect(read("wrangler.jsonc")).not.toContain(FORBIDDEN);
  });
});
