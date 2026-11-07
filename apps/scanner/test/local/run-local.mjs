// Queue, Worker, local R2 and the real Container together: `node test/local/run-local.mjs`. Needs Docker, and a mirror willing to
// serve current signatures. Not in CI for that reason. The stand-in for the API records what it's sent.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = 8797;
const base = `http://127.0.0.1:${port}`;
const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const wrangler = spawn("npx", ["wrangler", "dev", "--config", join(here, "wrangler.jsonc"), "--port", String(port), "--inspector-port", "0"], { cwd: here, stdio: ["ignore", "pipe", "pipe"], detached: true });
const log = [];
for (const stream of [wrangler.stdout, wrangler.stderr]) stream.on("data", (chunk) => log.push(String(chunk)));

const stop = () => {
  try {
    process.kill(-wrangler.pid);
  } catch {}
};

async function waitFor(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = await check().catch(() => null);
    if (found) return found;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function scan(name, text, expectReport) {
  const id = `obj_${randomUUID().replaceAll("-", "")}`;
  const key = `rooms/ws_local/${id}`;
  await fetch(`${base}/put?key=${key}`, { method: "POST", body: text });
  const sha256 = createHash("sha256").update(text).digest("hex");
  await fetch(`${base}/send`, { method: "POST", body: JSON.stringify({ v: 1, workspace_id: "ws_local", object_id: id, key, size: Buffer.byteLength(text), sha256 }) });
  const started = Date.now();
  const { result, secret, idempotency } = await waitFor(async () => (await fetch(`${base}/result?id=${id}`)).json(), 240_000, name);
  const good = result.report === expectReport && secret === "fake-local-secret" && idempotency === null && /^\d+$/.test(result.database.version);
  console.log(`${good ? "ok  " : "FAIL"} ${name}: ${result.report}, ${result.reason}, database ${result.database.version}, ${Date.now() - started} ms`);
  return good;
}

let code = 1;
try {
  await waitFor(async () => (await fetch(`${base}/nothing`)).status === 404, 600_000, "wrangler dev");
  const results = [await scan("a note, on a cold start", "An ordinary note.\n", "no_known_malware"), await scan("EICAR", eicar, "malware_found")];
  code = results.every(Boolean) ? 0 : 1;
} catch (problem) {
  console.error(String(problem), log.join("").slice(-3000));
} finally {
  stop();
}
process.exit(code);
