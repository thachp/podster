import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The content Worker deploys nowhere until the owner supplies a deploy credential for the second account, and never
// to the account that holds podster.dev (M6 step 4(b), decision 217). These read the package as it is checked in.
//
// Why leaving the IDs out isn't enough, by Cloudflare's documentation: with no `account_id`, wrangler uses the
// account of whoever is logged in, and with no route, `workers_dev` defaults to true. With no configuration file and
// no entry point named, wrangler refuses. So the package has no default-named configuration at all.

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const repo = (path: string) => readFileSync(new URL(`../../${path}`, root), "utf8");

describe("the package can't be deployed by accident", () => {
  it("has no configuration file a bare `wrangler deploy` would find", () => {
    const names = readdirSync(root);
    for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) expect(names, name).not.toContain(name);
    expect(names.filter((name) => /wrangler/i.test(name))).toEqual(["local.wrangler.jsonc"]);
    expect(existsSync(new URL(".dev.vars", root))).toBe(false);
  });

  it("names no account, no route and no environment in the one file it has, and switches both public addresses off", () => {
    const config = JSON.parse(read("local.wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
    expect(Object.keys(config).sort()).toEqual(["compatibility_date", "dispatch_namespaces", "kv_namespaces", "main", "name", "preview_urls", "workers_dev"]);
    expect([config.workers_dev, config.preview_urls]).toEqual([false, false]);
    for (const key of ["account_id", "route", "routes", "env", "vars", "triggers", "services", "d1_databases", "r2_buckets", "durable_objects", "queues", "tail_consumers", "secrets_store_secrets"]) expect(config, key).not.toHaveProperty(key);
    // Its only two bindings, with placeholders that exist on no account.
    expect(config.kv_namespaces).toEqual([{ binding: "SERVE", id: "0".repeat(32) }]);
    expect(config.dispatch_namespaces).toEqual([{ binding: "APPS", namespace: "placeholder-no-such-namespace" }]);
    // Nothing in the file reads as an account's or a namespace's real ID, or names a host of Podster's.
    const text = read("local.wrangler.jsonc");
    expect(text.match(/[0-9a-f]{32}/g)).toEqual(["0".repeat(32)]);
    expect(text).not.toMatch(/podster\.dev|podster\.site|workers\.dev"/);
  });

  it("has no deploy script, no wrangler of its own, and isn't known to the staging deploy", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.scripts).sort()).toEqual(["test", "typecheck"]);
    expect(JSON.stringify(pkg)).not.toMatch(/deploy|wrangler/);
    for (const script of ["scripts/deploy-staging", "scripts/staging-probes"]) expect(repo(script), script).not.toMatch(/apps\/content|podster-content/);
    // CI checks and tests the package and does nothing else with it.
    const ci = repo(".github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  content:"), ci.indexOf("\n  gateway:"));
    expect(job).toContain("working-directory: apps/content");
    expect(job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")).not.toMatch(/deploy|wrangler|secrets\./);
    expect([...job.matchAll(/- run: (.+)/g)].map((match) => match[1])).toEqual(["npm ci", "npm run typecheck", "npm test"]);
  });
});

describe("the Worker reaches nothing but its two bindings", () => {
  const sources = readdirSync(new URL("src/", root)).map((name) => [name, read(`src/${name}`)] as const);

  it("reads one namespace, asks one dispatch namespace, and names no other binding, host or secret", () => {
    expect(sources.map(([name]) => name).sort()).toEqual(["handle.ts", "index.ts", "names.ts"]);
    const all = sources.map(([, text]) => text).join("\n");
    expect([...all.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]).sort()).toEqual(["APPS", "SERVE"]);
    // No write to the namespace, no outbound request of its own, and no storage, cache or timer.
    for (const word of [".put(", ".delete(", ".list(", "fetch(\"", "fetch(`", "caches.", "D1Database", "R2Bucket", "DurableObject", "setTimeout", "setInterval", "process.env", "podster.dev", "Authorization"]) expect(all, word).not.toContain(word);
    // The one `fetch` call is the dispatch namespace's own.
    expect(all.match(/\.fetch\(/g)).toHaveLength(1);
  });

  it("never holds the word that would give a sandboxed page its real origin back", () => {
    const FORBIDDEN = ["allow", "same", "origin"].join("-");
    for (const [name, text] of sources) expect(text, name).not.toContain(FORBIDDEN);
    expect(read("local.wrangler.jsonc")).not.toContain(FORBIDDEN);
  });
});
