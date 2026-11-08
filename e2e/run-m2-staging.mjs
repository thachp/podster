// Runs m2-staging.mjs against the local stack, with a stand-in for the scanner, then checks what reached the Workers' logs.
//
//   node run-m2-staging.mjs [--skip-build] [--big]
//
// The stand-in is a small Worker in the same `wrangler dev` session. It takes the API's scan jobs from the local queue, reads the
// file from local R2, and reports to the API's verdict route with a throwaway secret: the EICAR test string is a finding, and
// anything else is clean. So this checks the whole path around the scanner, its queue message, the verdict route and downloads,
// and not ClamAV or the Container, which only staging runs.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, local, prepareStack, startGateway } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const big = process.argv.includes("--big");
const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild: process.argv.includes("--skip-build") });

// A fresh secret each run, shared by the API and the stand-in, and checked to stay out of the logs like the rest.
const scannerSecret = randomBytes(32).toString("hex");
const api = JSON.parse(readFileSync(apiConfig, "utf8"));
writeFileSync(apiConfig, JSON.stringify({ ...api, vars: { ...api.vars, SCANNER_SECRET: scannerSecret } }));

const FINDING = "Stand-in.EICAR-Test-Signature";
const standIn = join(local, "stand-in-scanner.mjs");
writeFileSync(
  standIn,
  `// Written by e2e/run-m2-staging.mjs. Not a scanner: it only tells the EICAR test string from anything else.
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const job = message.body;
      const object = await env.ASSETS.get(job.key);
      if (!object) { message.ack(); continue; }
      const bytes = await object.arrayBuffer();
      const found = new TextDecoder().decode(bytes).includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
      const report = {
        v: 1, workspace_id: job.workspace_id, object_id: job.object_id, key: job.key,
        report: found ? "malware_found" : "no_known_malware", reason: found ? ${JSON.stringify(FINDING)} : "none",
        sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), bytes: bytes.byteLength,
        database: { engine: "stand-in", version: "1", built_at: new Date().toISOString() }, scanned_at: Date.now(),
      };
      const answer = await env.API.fetch("https://api/internal/scan-result", { method: "POST", headers: { "content-type": "application/json", "x-podster-scanner": env.SCANNER_SECRET }, body: JSON.stringify(report) });
      console.log(JSON.stringify({ at: "stand-in-scanner", object: job.object_id, status: answer.status }));
      if (answer.status >= 500) message.retry(); else message.ack();
    }
  },
};
`,
);
const standInConfig = join(local, "stand-in-scanner.wrangler.json");
writeFileSync(
  standInConfig,
  JSON.stringify({
    name: "podster-scanner",
    main: standIn,
    compatibility_date: "2026-08-01",
    // Local only. Never a public URL, even if this config were deployed by mistake.
    workers_dev: false,
    vars: { SCANNER_SECRET: scannerSecret },
    r2_buckets: [{ binding: "ASSETS", bucket_name: "podster-assets" }],
    services: [{ binding: "API", service: "podster-api" }],
    queues: { consumers: [{ queue: "podster-scan", max_batch_size: 1, max_batch_timeout: 1, max_retries: 3 }] },
  }),
);

const port = await freePort();
const base = `http://localhost:${port}`;
const vars = { AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: base, ENABLE_PASSWORD_SIGNIN: "true" };
const { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, inspectorPort: await freePort(), logLevel: "log", extraArgs: ["-c", standInConfig], env: { WRANGLER_REGISTRY_PATH: join(local, "registry") } });

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

// The script adds the names and tokens it uses. Each line is a kind and a value, so a leak is reported by its kind alone.
const secrets = join(local, "m2-secrets.txt");
rmSync(secrets, { force: true });
writeFileSync(secrets, `scanner secret\t${scannerSecret}\nfinding\t${FINDING}\n`);
const code = await new Promise((done) => {
  const proc = spawn(process.execPath, [join(here, "m2-staging.mjs"), "--base-url", base, ...(big ? ["--big"] : [])], { cwd: here, stdio: "inherit", env: { ...process.env, PODSTER_UPLOAD_SECRETS_FILE: secrets } });
  proc.on("exit", (status) => done(status ?? 1));
});
await new Promise((done) => setTimeout(done, 1000));
stop();

const logged = log.join("");
let clean = true;
const report = (passed, title, detail = "") => {
  clean &&= passed;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `:\n${detail}` : ""}`);
};
const verdicts = logged.split("\n").filter((line) => line.includes('"at":"stand-in-scanner"'));
report(verdicts.length > 0 && verdicts.every((line) => line.includes('"status":200')), "the stand-in's reports were each recorded", verdicts.slice(0, 4).join("\n"));
const remembered = existsSync(secrets) ? readFileSync(secrets, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t")) : [];
rmSync(secrets, { force: true });
const leaks = new Map();
for (const [kind, value] of remembered) if (value && logged.includes(value)) leaks.set(kind, (leaks.get(kind) ?? 0) + 1);
// Under the secret and the finding, the script added nothing, so there was nothing to look for.
const kinds = new Set(remembered.map(([kind]) => kind));
report(kinds.has("file name") && kinds.has("upload token") && leaks.size === 0, "no file name, upload token, scanner secret or finding in any log", leaks.size ? [...leaks].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(", ") : `${remembered.length} values looked for`);
// Only that one happened and its error's name, since a raw line could carry anything the Worker held.
const unhandled = logged.split("\n").filter((line) => /uncaught|unhandled/i.test(line));
const names = [...new Set(unhandled.map((line) => line.match(/\b([A-Z][A-Za-z]*Error)\b/)?.[1] ?? "an error with no name"))];
report(unhandled.length === 0, "nothing unhandled in the Workers' logs", unhandled.length ? `${unhandled.length} unhandled: ${names.join(", ")}` : "");
process.exit(code || (clean ? 0 : 1));
