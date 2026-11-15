import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The outbound Worker deploys nowhere until the owner wires it as the dispatch namespace's outbound Worker on the
// second account, and never to the account that holds podster.dev (M6 stage 1; docs/m6-plan.md, "The outbound
// Worker"). These read the package as it is checked in, and hold it to the guard `apps/content` set:
//   - With no configuration file, `wrangler deploy` configures the project and deploys it (Cloudflare's "automatic
//     configuration", since wrangler 4.68). So the package carries a default-named `wrangler.jsonc`.
//   - That file's `account_id` is no account, and holds characters wrangler refuses before any call scoped to an
//     account.
//   - Wrangler uses the file's `account_id` ahead of `CLOUDFLARE_ACCOUNT_ID` in the environment. That was read in
//     wrangler's own source, for the version pinned below, and is read again here.
//   - Wrangler reads a `.wrangler/deploy/config.json` redirect ahead of `wrangler.jsonc`. None may exist here.
// Nothing here stops a person who types a deploy by hand that doesn't use this file. The guard is against accidents
// by scripts and agents.

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const repo = (path: string) => readFileSync(new URL(`../../${path}`, root), "utf8");
const uncommented = (text: string) => text.replace(/^\s*\/\/.*$/gm, "");
const PLACEHOLDER_ACCOUNT = "not an account: this file deploys nowhere";
const FORBIDDEN_KEYS = ["route", "routes", "env", "triggers", "services", "vars", "kv_namespaces", "dispatch_namespaces", "d1_databases", "r2_buckets", "durable_objects", "queues", "tail_consumers", "secrets_store_secrets", "assets", "build", "outbound", "analytics_engine_datasets", "hyperdrive", "ai", "browser", "mtls_certificates", "vectorize", "workflows", "send_email", "unsafe"];

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

describe("the package can't be deployed by accident", () => {
  it("has one wrangler configuration, default-named, and nothing that would be read ahead of it", () => {
    expect(wranglerConfigs()).toEqual(["wrangler.jsonc"]);
    expect(readdirSync(root).filter((name) => /wrangler/i.test(name) && name !== ".wrangler")).toEqual(["wrangler.jsonc"]);
    // **This can't fail in CI:** `.wrangler` is ignored by git. It guards a machine where someone ran a tool here.
    expect(existsSync(new URL(".wrangler/deploy/config.json", root))).toBe(false);
    expect(existsSync(new URL(".wrangler/deploy", root))).toBe(false);
    for (const name of [".dev.vars", ".env"]) expect(existsSync(new URL(name, root)), name).toBe(false);
  });

  it("aims at no account, has no route, environment or binding, and switches both public addresses off", () => {
    const config = JSON.parse(uncommented(read("wrangler.jsonc")));
    expect(Object.keys(config).sort()).toEqual(["account_id", "compatibility_date", "main", "name", "preview_urls", "workers_dev"]);
    expect([config.name, config.main]).toEqual(["podster-outbound", "src/index.ts"]);
    expect([config.workers_dev, config.preview_urls]).toEqual([false, false]);
    for (const key of FORBIDDEN_KEYS) expect(config, key).not.toHaveProperty(key);
    // The placeholder is unchanged, isn't empty, and holds characters outside the ones wrangler takes for an
    // account's ID, so wrangler refuses it before any call scoped to an account.
    expect(config.account_id).toBe(PLACEHOLDER_ACCOUNT);
    expect(/^[A-Za-z0-9_-]+$/.test(config.account_id)).toBe(false);
    // Nothing in the file reads as a real ID, or as a route on any host.
    const text = read("wrangler.jsonc");
    expect(text.match(/[0-9a-f]{32}/g)).toBeNull();
    expect(uncommented(text)).not.toMatch(/podster\.dev|podster\.site|workers\.dev|custom_domain|zone_name|pattern/);
  });

  it("pins the wrangler it was verified on, and reads that installed copy's own source for the two things it rests on", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.devDependencies.wrangler).toBe("4.157.0");
    expect(JSON.parse(read("package-lock.json")).packages["node_modules/wrangler"].version).toBe("4.157.0");
    expect(JSON.parse(read("node_modules/wrangler/package.json")).version).toBe("4.157.0");
    const source = read("node_modules/wrangler/wrangler-dist/cli.js");
    // 1. The file's `account_id` is used ahead of the environment's, and checked for its form on the way.
    const start = source.indexOf("function getActiveAccountId(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, start + 900);
    const [fromFile, fromEnv] = [body.indexOf("config2.account_id"), body.indexOf("getCloudflareAccountIdFromEnv()")];
    expect(fromFile).toBeGreaterThan(0);
    expect(fromEnv).toBeGreaterThan(fromFile);
    expect(body.slice(fromFile, fromEnv)).toMatch(/return validateAccountId\(\s*config2\.account_id,/);
    // 2. That form: letters, digits, `-` and `_` only, or wrangler throws.
    expect(source).toContain("ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/");
    expect(source).toMatch(/function validateAccountId\(accountId, source\) \{\s*if \(!ACCOUNT_ID_PATTERN\.test\(accountId\)\) \{\s*throw new UserError\(/);
  });

  it("has no deploy script, isn't known to any deploy, and CI only checks and tests it", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("@podster/outbound");
    expect(Object.keys(pkg.scripts).sort()).toEqual(["test", "typecheck"]);
    expect(JSON.stringify(pkg)).not.toMatch(/deploy/);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@cloudflare/workers-types", "@types/node", "typescript", "vitest", "wrangler"]);
    expect(pkg.dependencies).toBeUndefined();
    for (const script of ["scripts/deploy-staging", "scripts/staging-probes", "scripts/deploy-content"]) expect(repo(script), script).not.toMatch(/apps\/outbound|podster-outbound/);
    const ci = repo(".github/workflows/ci.yml");
    const [from, to] = [ci.indexOf("\n  outbound:"), ci.indexOf("\n  content:")];
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const job = ci.slice(from, to);
    expect(job).toContain("working-directory: apps/outbound");
    expect(job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")).not.toMatch(/deploy|wrangler|secrets\./);
    expect([...job.matchAll(/- run: (.+)/g)].map((match) => match[1])).toEqual(["npm ci --ignore-scripts", "npm run typecheck", "npm test"]);
  });
});

describe("the Worker reaches nothing", () => {
  const sources = readdirSync(new URL("src/", root)).map((name) => [name, read(`src/${name}`)] as const);
  // The code alone: comments may name what the Worker refuses.
  const all = sources.map(([, text]) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");

  it("has two source files, which import only each other", () => {
    expect(sources.map(([name]) => name).sort()).toEqual(["index.ts", "refuse.ts"]);
    const imports = sources.flatMap(([, text]) => [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]));
    expect(imports).toEqual(["./refuse"]);
  });

  it("makes no request, opens no socket, logs nothing and reads no binding", () => {
    // The only `fetch` is the handler's own name, and it takes no argument.
    expect(all.match(/\bfetch\b/g)).toHaveLength(1);
    expect(all).toMatch(/^ {2}fetch\(\): Response \{$/m);
    for (const word of ["console", "connect(", "cloudflare:sockets", "WebSocket", "env.", "caches", "setTimeout", "setInterval", "waitUntil", "process.", "request.", ".text()", ".json()", ".arrayBuffer()", ".body", "podster.dev"]) expect(all, word).not.toContain(word);
  });
});
