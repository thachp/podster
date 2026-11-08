// Runs a2a-staging.mjs against the local stack: the real gateway and the release build of the API under `wrangler dev`.
//
//   node run-a2a-staging.mjs [--skip-build]
//
// It's a rehearsal of the staging run, with the same A2A client. Afterwards it checks that no token reached the Workers'
// logs and that nothing in them was unhandled. The API gets a throwaway A2A_TOKEN_KEY, so endpoint tokens can be stored as on
// staging, and no endpoint token or signing secret may reach the logs either.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, prepareStack, startGateway } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild: process.argv.includes("--skip-build"), apiVars: { A2A_TOKEN_KEY: randomBytes(32).toString("hex") } });

const port = await freePort();
const base = `http://localhost:${port}`;
const vars = { AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: base, ENABLE_PASSWORD_SIGNIN: "true" };
const { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, inspectorPort: await freePort(), logLevel: "log" });

const deadline = Date.now() + 120_000;
for (;;) {
  const up = await fetch(`${base}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (up?.status === 200) break;
  if (Date.now() > deadline || stack.exitCode !== null) {
    console.error(log.join("").slice(-3000));
    stop();
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 500));
}

const code = await new Promise((done) => {
  const proc = spawn(process.execPath, [join(here, "a2a-staging.mjs"), "--base-url", base], { cwd: here, stdio: "inherit", env: process.env });
  proc.on("exit", (status) => done(status ?? 1));
});
await new Promise((done) => setTimeout(done, 1000));
stop();

const logged = log.join("");
let clean = true;
const report = (passed, title, detail = "") => {
  clean &&= passed;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `: ${detail}` : ""}`);
};
// Access tokens are `<user>:<grant>:<secret>`, and the secret part never belongs in a log.
const tokenLike = logged.match(/[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{24,}/g) ?? [];
report(tokenLike.length === 0, "no access token in any log", tokenLike.length ? `${tokenLike.length} found` : "");
const endpointSecrets = (logged.match(/a2asec_[0-9a-f]{8,}|e2eA2aTok_[0-9a-f]{8,}/g) ?? []).length;
report(endpointSecrets === 0, "no endpoint token or signing secret in any log", endpointSecrets ? `${endpointSecrets} found` : "");
const unhandled = logged.split("\n").filter((line) => /uncaught|unhandled/i.test(line));
const names = [...new Set(unhandled.map((line) => line.match(/\b([A-Z][A-Za-z]*Error)\b/)?.[1] ?? "an error with no name"))];
report(unhandled.length === 0, "nothing unhandled in the Workers' logs", unhandled.length ? `${unhandled.length} unhandled: ${names.join(", ")}` : "");
process.exit(code || (clean ? 0 : 1));
