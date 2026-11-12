#!/usr/bin/env node
// Spike only. Deploys spike-m6-c-dispatch and its route with wrangler, which gets the allow-listed environment from
// e2e/child-env.mjs plus exactly CLOUDFLARE_ACCOUNT_ID, never this process's whole environment.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, WRANGLER_BIN, wranglerEnv } from "./lib.mjs";

if (process.argv.includes("--help")) {
  console.log("usage: CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev> node deploy.mjs");
  process.exit(0);
}
execFileSync(WRANGLER_BIN, ["deploy", "--config", join(import.meta.dirname, "dispatch", "wrangler.jsonc")], {
  cwd: join(ROOT, "apps", "gateway"),
  env: { ...wranglerEnv(), CI: "true" },
  stdio: "inherit",
});
