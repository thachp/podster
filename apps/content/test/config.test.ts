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
//   - That file's `account_id` is no account, and holds characters wrangler refuses before it calls anything.
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

describe("the package can't be deployed by accident", () => {
  it("has the one default-named configuration file, and nothing that would be read ahead of it", () => {
    const names = readdirSync(root);
    expect(names.filter((name) => /wrangler/i.test(name) && name !== ".wrangler")).toEqual(["wrangler.jsonc"]);
    // A redirect file under `.wrangler/deploy` is read ahead of `wrangler.jsonc`, by `deploy` and `dev` alike. The
    // deploy-time configuration for the second account lives outside this folder, so none is ever here.
    expect(existsSync(new URL(".wrangler/deploy/config.json", root))).toBe(false);
    expect(existsSync(new URL(".wrangler/deploy", root))).toBe(false);
    for (const name of [".dev.vars", ".env"]) expect(existsSync(new URL(name, root)), name).toBe(false);
  });

  it("aims at no account, has no route and no environment, and switches both public addresses off", () => {
    const config = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
    expect(Object.keys(config).sort()).toEqual(["account_id", "compatibility_date", "dispatch_namespaces", "kv_namespaces", "main", "name", "preview_urls", "workers_dev"]);
    expect([config.workers_dev, config.preview_urls]).toEqual([false, false]);
    for (const key of ["route", "routes", "env", "vars", "triggers", "services", "d1_databases", "r2_buckets", "durable_objects", "queues", "tail_consumers", "secrets_store_secrets", "assets", "build"]) expect(config, key).not.toHaveProperty(key);
    // The placeholder is unchanged, isn't empty, and holds characters outside the ones wrangler takes for an
    // account's ID (`/^[A-Za-z0-9_-]+$/` in the versions below), so wrangler refuses it before it calls anything.
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

  it("was verified against the wrangler versions the repository locks, and fails when one moves", () => {
    // That the file's `account_id` is used ahead of the environment's, and that the placeholder's characters are
    // refused, was read in wrangler 4.157.0's source (`getActiveAccountId` and `ACCOUNT_ID_PATTERN`). It is no
    // documented promise. If an upgrade flipped the order, a deploy from this file would land an unreachable script
    // on the account in the shell, the one that holds podster.dev: no public address, but a script there all the
    // same. So an upgrade of either lock below fails this test until that source is read again and this is updated.
    const locked = (app: string) => JSON.parse(repo(`apps/${app}/package-lock.json`)).packages["node_modules/wrangler"].version;
    expect({ gateway: locked("gateway"), api: locked("api") }).toEqual({ gateway: "4.157.0", api: "4.157.0" });
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
    expect(read("wrangler.jsonc")).not.toContain(FORBIDDEN);
  });
});
