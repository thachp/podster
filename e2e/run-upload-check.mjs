// Runs upload-check.mjs against the local stack, then checks what reached the Workers' logs. `--big` adds 100 MB and reports the
// CPU the local Workers used for it, which also counts the gateway and local storage, so it's a ceiling on the API's own.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, local, prepareStack, startGateway } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skipBuild = process.argv.includes("--skip-build");
const big = process.argv.includes("--big");
const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild });
const port = await freePort();
const base = `http://localhost:${port}`;
const vars = { AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: base, ENABLE_PASSWORD_SIGNIN: "true" };
const { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, inspectorPort: await freePort(), logLevel: "log", env: { WRANGLER_REGISTRY_PATH: join(local, "registry") } });

const deadline = Date.now() + 120_000;
for (;;) {
  const up = await fetch(`${base}/.well-known/agent-configuration`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (up?.status === 200) break;
  if (Date.now() > deadline || stack.exitCode !== null) {
    console.error(log.join("").slice(-3000));
    stop();
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 500));
}

/** CPU seconds used so far by everything this stack started. */
const cpu = () => {
  const lines = execFileSync("ps", ["-g", String(stack.pid), "-o", "time=,command="], { encoding: "utf8" }).split("\n");
  return lines.filter((line) => line.includes("workerd")).reduce((total, line) => {
    const [time] = line.trim().split(/\s+/);
    const parts = time.split(":").map(Number);
    return total + parts.reduce((sum, part) => sum * 60 + part, 0);
  }, 0);
};
const secrets = join(local, "upload-secrets.txt");
rmSync(secrets, { force: true });
const before = cpu();
const code = await new Promise((done) => {
  const proc = spawn(process.execPath, [join(here, "upload-check.mjs"), "--base-url", base, ...(big ? ["--big"] : [])], { cwd: here, stdio: "inherit", env: { ...process.env, PODSTER_UPLOAD_SECRETS_FILE: secrets } });
  proc.on("exit", (status) => done(status ?? 1));
});
if (big) console.log(`Workers' CPU over the whole run, gateway and local storage included: ${(cpu() - before).toFixed(1)} s`);
await new Promise((done) => setTimeout(done, 1000));
stop();

const logged = log.join("");
const lines = logged.split("\n").filter((line) => line.includes('"at":"upload.'));
console.log(`\n${lines.length} upload log lines. For example:\n${lines.slice(0, 2).join("\n")}`);
let clean = lines.length > 0;
if (!clean) console.log("FAIL no upload log lines reached the stack's log, so this check would show nothing");
for (const secret of existsSync(secrets) ? readFileSync(secrets, "utf8").split("\n").filter(Boolean) : []) {
  if (logged.includes(secret)) {
    clean = false;
    console.log(`FAIL a log holds something that must stay out of it: ${secret.slice(0, 8)}...`);
  }
}
if (clean) console.log("ok   no file name or upload token in any log");
process.exit(code || (clean ? 0 : 1));
