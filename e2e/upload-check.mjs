// Sends real uploads down the real path: gateway, API and R2. It's how to find out what a deployment does with a chunked upload,
// and it gives the object IDs to look up for CPU time. Nothing here reads a database.
//
//   node upload-check.mjs --base-url <gateway> [--big]
//
// A local run signs someone up. Against a deployment, set PODSTER_E2E_COOKIE_A to a person's session cookie. `--big` adds 100 MB
// uploads, declared and chunked. PODSTER_UPLOAD_SECRETS_FILE, if set, gets the name and tokens used, so a caller can check that
// none reached a log.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { AuthAgent, key, Person, Target } from "./lib.mjs";

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const base = flag("--base-url");
if (!base) throw new Error("--base-url is required");
const big = process.argv.includes("--big");
const SECRET_NAME = "secret-name-that-must-not-be-logged.txt";
const remember = (text) => process.env.PODSTER_UPLOAD_SECRETS_FILE && appendFileSync(process.env.PODSTER_UPLOAD_SECRETS_FILE, `${text}\n`);
remember(SECRET_NAME);

const target = new Target(base, { pollMs: 500 });
const cookie = process.env.PODSTER_E2E_COOKIE_A;
const owner = cookie ? new Person(target, "owner", cookie) : await Person.signUp(target, "owner");
const room = await owner.createRoom(`Upload check ${key()}`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const text = (size) => Buffer.alloc(size, "some notes\n");
const CHUNK = 64 * 1024;
const inChunks = (data) => new ReadableStream({
  start() { this.at = 0; },
  pull(controller) {
    if (this.at >= data.length) return controller.close();
    controller.enqueue(new Uint8Array(data.subarray(this.at, this.at + CHUNK)));
    this.at += CHUNK;
  },
});

const rows = [];
let failed = false;
async function check(title, want, make, send) {
  const upload = await make();
  remember(upload.token);
  const started = Date.now();
  let status;
  let body;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, ...send(), signal: AbortSignal.timeout(600_000) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (error) {
    status = `failed: ${error?.cause?.code ?? error?.message}`;
  }
  const passed = status === want;
  failed ||= !passed;
  rows.push({ title, want, got: status, code: body?.error?.code ?? body?.state ?? "", object: upload.id, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  console.log(`${passed ? "ok  " : "FAIL"} ${title}: wanted ${want}, got ${status} ${body?.error?.code ?? body?.state ?? ""} (${upload.id}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
}
const asOwner = (data, over = {}) => () => owner.must("POST", `/v1/workspaces/${room}/uploads`, { name: SECRET_NAME, size: data.length, sha256: sha256(data), ...over });

const small = text(200_000);
const wrong = sha256(randomBytes(32));
await check("declared length, correct hash", 200, asOwner(small), () => ({ body: small }));
await check("chunked with no declared length, correct hash", 200, asOwner(small), () => ({ body: inChunks(small), duplex: "half" }));
await check("chunked, wrong hash", 422, asOwner(small, { sha256: wrong }), () => ({ body: inChunks(small), duplex: "half" }));
await check("declared length, wrong hash", 422, asOwner(small, { sha256: wrong }), () => ({ body: small }));
await check("chunked, longer than announced", 422, asOwner(small), () => ({ body: inChunks(Buffer.concat([small, Buffer.from("x")])), duplex: "half" }));
await check("chunked, shorter than announced", 422, asOwner(small), () => ({ body: inChunks(small.subarray(0, 1000)), duplex: "half" }));
await check("wrong token", 404, async () => ({ ...(await asOwner(small)()), token: "upl_wrong" }), () => ({ body: small }));

const agent = await AuthAgent.connect(target, owner, "Uploading agent");
await owner.addAgent(room, agent);
const version = (await owner.must("GET", `/v1/workspaces/${room}`)).policy_version;
await owner.must("PUT", `/v1/workspaces/${room}/members/${agent.id}/access`, { preset: "coordinator", policy_version: version });
await check("an agent, through its tool", 200, () => agent.must("create_upload", { workspace_id: room, name: SECRET_NAME, size: small.length, sha256: sha256(small) }), () => ({ body: small }));

if (big) {
  // Text, because random bytes aren't a type anyone may upload.
  const file = text(100_000_000);
  await check("100 MB, declared length", 200, asOwner(file), () => ({ body: file }));
  await check("100 MB, chunked with no declared length", 200, asOwner(file), () => ({ body: inChunks(file), duplex: "half" }));
}
console.log(`\n${rows.filter((r) => r.want === r.got).length} of ${rows.length} as wanted. Room ${room}.`);
console.log("For CPU time, read the API's invocation for each object: wrangler tail podster-api --env staging --format json --search upload.stored");
process.exit(failed ? 1 : 0);
