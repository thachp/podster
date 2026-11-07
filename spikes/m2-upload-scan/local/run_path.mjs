// Streams the fixtures through web, gateway and API to R2 in local Workers, then waits for the scanner's verdicts.
// Local R2 and local service bindings are real workerd code paths, but this isn't Cloudflare's network. Run it against a
// deployment with SPIKE_URL and SPIKE_TOKEN set, and it does the same without starting anything.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "fixtures");
const token = process.env.SPIKE_TOKEN ?? "local-spike-token";
const deployed = Boolean(process.env.SPIKE_URL);
const base = process.env.SPIKE_URL ?? "http://127.0.0.1:18787";
const scanWaitMs = Number(process.env.SCAN_WAIT_MS ?? 600_000);
const rows = [];
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sha256 = (file) =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => done(hash.digest("hex"))).on("error", fail);
  });

/** A raw request, because fetch won't send a length that disagrees with its body or stop partway. */
function raw(method, path, headers, write, timeoutMs = 300_000) {
  const url = new URL(path, base);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done) => {
    const req = send(url, { method, headers: { "x-spike-token": token, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let body = text;
        try {
          body = JSON.parse(text);
        } catch {}
        done({ status: res.statusCode, body });
      });
    });
    req.on("error", (error) => done({ status: 0, error: error.code ?? error.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed_out")));
    write(req);
  });
}

async function upload(file, { sha, id = randomUUID() } = {}) {
  const path = join(fixtures, file);
  const size = statSync(path).size;
  const started = Date.now();
  const hash = sha ?? (await sha256(path));
  const res = await raw("PUT", `/objects/${id}`, { "content-length": size, "x-sha256": hash }, (req) => createReadStream(path).pipe(req));
  return { id, size, ms: Date.now() - started, ...res };
}

async function verdict(id) {
  const until = Date.now() + scanWaitMs;
  while (Date.now() < until) {
    const res = await raw("GET", `/results/${id}`, {}, (req) => req.end());
    if (res.status === 200) return res.body;
    await new Promise((done) => setTimeout(done, 1000));
  }
  return { verdict: "timed_out" };
}

async function waitForServer() {
  for (let i = 0; i < 300; i += 1) {
    const res = await raw("GET", "/objects/none", {}, (req) => req.end());
    if (res.status === 200) return;
    if (dev && dev.exitCode !== null) throw new Error("wrangler dev exited: see results/wrangler.log");
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("the local Workers didn't start");
}

/** Deletes everything under the spike's two prefixes, a batch at a time. */
export async function emptyBucket() {
  let deleted = 0;
  for (let round = 0; round < 100; round += 1) {
    const res = await raw("POST", "/cleanup", {}, (req) => req.end());
    if (res.status !== 200) return { deleted, left: -1, status: res.status };
    if (res.body.deleted === 0) return { deleted, left: 0 };
    deleted += res.body.deleted;
  }
  return { deleted, left: -1 };
}

let dev;
if (!deployed) {
  const wrangler = join(root, "node_modules/.bin/wrangler");
  // Local only: wrangler never deploys this file, and it's ignored by git.
  writeFileSync(join(root, "scanner/.dev.vars"), "FORCE_FAILURE_PREFIX=fail-\n");
  dev = spawn(wrangler, ["dev", "-c", "web/wrangler.jsonc", "-c", "gateway/wrangler.jsonc", "-c", "api/wrangler.jsonc", "-c", "scanner/wrangler.jsonc", "--port", "18787", "--var", `SPIKE_TOKEN:${token}`, "--persist-to", join(root, "results/.wrangler")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "results/wrangler.log"), "");
  for (const stream of [dev.stdout, dev.stderr]) stream.on("data", (chunk) => appendFileSync(join(root, "results/wrangler.log"), chunk));
  process.on("exit", () => dev.kill("SIGTERM"));
}

await waitForServer();

// No token, no answer.
const refused = await (await fetch(new URL("/objects/none", base))).status;
check(refused === 404, `without the token: ${refused}`);

// What's refused before a byte is read.
const overId = randomUUID();
const tooBig = await upload("over-100mb.bin", { sha: "0".repeat(64), id: overId });
check(tooBig.status === 413, `100,000,001 bytes: ${tooBig.status} ${JSON.stringify(tooBig.body ?? tooBig.error)} in ${tooBig.ms} ms`);
const afterBig = await raw("GET", `/objects/${overId}`, {}, (req) => req.end());
check(afterBig.body.present === false, "over the limit leaves no object");
const noLength = await raw("PUT", `/objects/${randomUUID()}`, { "transfer-encoding": "chunked", "x-sha256": "00" }, (req) => {
  req.write("hello");
  req.end();
});
check(noLength.status === 411, `no declared length: ${noLength.status}`);

// A body that isn't what it claims.
const wrongHash = await upload("clean-small.txt", { sha: "0".repeat(64) });
check(wrongHash.status === 422 && wrongHash.body.object_present === false, `a wrong hash: ${wrongHash.status} ${JSON.stringify(wrongHash.body)}`);
const afterWrong = await raw("GET", `/objects/${wrongHash.id}`, {}, (req) => req.end());
check(afterWrong.body.present === false, "a wrong hash leaves no object");

// An upload that stops partway.
const stoppedId = randomUUID();
const stopped = await raw("PUT", `/objects/${stoppedId}`, { "content-length": 50_000_000, "x-sha256": "0".repeat(64) }, (req) => {
  req.write(Buffer.alloc(1_000_000));
  setTimeout(() => req.destroy(), 1500);
});
await new Promise((done) => setTimeout(done, 3000));
const afterStop = await raw("GET", `/objects/${stoppedId}`, {}, (req) => req.end());
check(afterStop.body.present === false, `an upload cut off partway leaves no object (the client saw ${stopped.status || stopped.error})`);

// The whole path, and the verdict at the far end of it.
const expected = {
  "clean-small.txt": "clean",
  "clean-100mb.bin": "clean",
  "eicar.txt": "blocked",
  "eicar-in-nested-zip.zip": "blocked",
  "eicar-past-limit.zip": "blocked",
  "bomb-flat-2gb.zip": "blocked",
  "bomb-wide-655gb.zip": "blocked",
  "encrypted.zip": "blocked",
  "truncated.zip": "blocked",
};
for (const [file, wanted] of Object.entries(expected)) {
  const up = await upload(file);
  check(up.status === 200 && up.body.bytes === up.size, `${file} stored: ${up.status} in ${up.ms} ms`);
  if (file === "clean-100mb.bin") {
    const mb = up.body.wasm_peak_bytes / 1_000_000;
    check(up.body.wasm_peak_bytes < 20_000_000, `100 MB passed through ${mb.toFixed(1)} MB of Wasm memory, largest chunk ${up.body.largest_chunk} bytes, ${up.body.chunks} chunks`);
  }
  const started = Date.now();
  const result = await verdict(up.id);
  check(result.verdict === wanted, `${file}: ${result.verdict}${result.reason ? ` (${result.reason})` : ""}, ${Date.now() - started} ms after storing`);
  rows.push({ file, bytes: up.size, upload_ms: up.ms, api: up.body, verdict_after_ms: Date.now() - started, result });
}

// No verdict after retries is `failed`, which is never a pass. Only a local run can force it.
if (!deployed) {
  const up = await upload("clean-small.txt", { id: `fail-${randomUUID()}` });
  const started = Date.now();
  const result = await verdict(up.id);
  check(result.verdict === "failed" && result.reason === "no_verdict_after_retries", `a scanner that never answers: ${result.verdict} (${result.reason}), ${Date.now() - started} ms after storing`);
}

// What only a deployment settles, also recorded locally for comparison.
for (const kind of ["probe", "probe-update"]) {
  const id = randomUUID();
  await raw("POST", `/probes/${kind}/${id}`, {}, (req) => req.end());
  const result = await verdict(id);
  console.log(`     ${kind}: ${JSON.stringify(result)}`.slice(0, 900));
  rows.push({ kind, result });
}

const out = join(root, "results", deployed ? "path-deployed.json" : "path-local.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`wrote ${out}; ${failures.length} failed`);
if (!deployed) {
  // The same cleanup teardown uses.
  const emptied = await emptyBucket();
  check(emptied.left === 0, `cleanup removed ${emptied.deleted} objects and left ${emptied.left}`);
}
process.exit(failures.length === 0 ? 0 : 1);
