// M2 step 11's staging run, as far as M2 is built: files go up through the gateway, wait for the scanner's verdict, and come back
// down with their bytes and headers checked. It also checks the EICAR test string is blocked and that refusals answer as the
// upload policy says. Cases for later steps are stubs, listed as skipped, to fill in as each step lands.
//
//   node m2-staging.mjs --base-url <gateway> [--big] [--verdict-wait-s <seconds>] [--allow-host <host>]
//
// People: locally it signs two people up with passwords. On staging, PODSTER_E2E_SIGNUP_SECRET makes two test people through the
// test sign-up, as journey.mjs does, and their sessions are signed out at the end. Otherwise it needs PODSTER_E2E_COOKIE_A and
// PODSTER_E2E_COOKIE_B, each from a different person's sign-in. `--big` adds a 100 MB file through the scanner. It writes rooms
// and files to the target, and staging has no delete route, so rooms are named "M2 staging <time>".
//
// PODSTER_UPLOAD_SECRETS_FILE, if set, gets the file names, upload tokens and scanner words used, so a caller can check that none
// reached a log. Nothing here reads a database or a log itself.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { AuthAgent, key, Person, sleep, Target } from "./lib.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const base = (option("--base-url") ?? process.env.PODSTER_E2E_BASE_URL)?.replace(/\/$/, "");
if (!base) {
  console.error("Pass --base-url, or set PODSTER_E2E_BASE_URL.");
  process.exit(2);
}
const big = args.includes("--big");
const host = new URL(base).hostname;
const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".test");
const STAGING = "https://gateway-staging.podster.dev";
if (!isLocal && new URL(base).origin !== STAGING && option("--allow-host") !== host) {
  console.error(`Refusing to write test data to ${host}. Pass --allow-host ${host} if that's really intended.`);
  process.exit(2);
}
if (!isLocal && new URL(base).protocol !== "https:") {
  console.error(`Refusing to send session cookies to ${base} without HTTPS.`);
  process.exit(2);
}
// The test sign-up's secret goes to staging's gateway and nowhere else.
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
if (signupSecret && new URL(base).origin !== STAGING) {
  console.error(`PODSTER_E2E_SIGNUP_SECRET only works against ${STAGING}. Unset it to run against ${host}.`);
  process.exit(2);
}
// A verdict on staging waits for the Container, which may be starting cold. Locally the stand-in answers in a moment.
const verdictWaitMs = Number(option("--verdict-wait-s") ?? (isLocal ? 30 : 300)) * 1000;

const remember = (text) => process.env.PODSTER_UPLOAD_SECRETS_FILE && appendFileSync(process.env.PODSTER_UPLOAD_SECRETS_FILE, `${text}\n`);
const target = new Target(base, { pollMs: isLocal ? 150 : 1000 });
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const text = (size, line = "some notes\n") => Buffer.alloc(size, line);
// The industry's harmless test string, split so this file isn't itself the signature.
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

// ---- reporting ----

const results = [];
const record = (status, title, detail = "") => {
  results.push({ status, title });
  const mark = { ok: "ok  ", fail: "FAIL", skip: "skip", note: "    " }[status];
  console.log(`${mark} ${title}${detail ? `: ${detail}` : ""}`);
};
const check = (passed, title, detail) => record(passed ? "ok" : "fail", title, detail);
const skip = (title, why) => record("skip", title, why);
const section = (name) => console.log(`\n## ${name}`);
/** Runs one case, so a failure in it is reported and the rest still run. */
async function step(title, run) {
  try {
    await run();
  } catch (error) {
    record("fail", title, error?.message ?? String(error));
  }
}

// ---- people ----

const ownCookies = [];
async function people() {
  if (signupSecret) {
    const made = [];
    for (const label of ["Person A", "Person B"]) {
      const cookie = await Person.testSessionCookie(target, label, signupSecret);
      ownCookies.push(cookie);
      made.push(await Person.fromCookie(target, label, cookie));
    }
    return made;
  }
  const [a, b] = [process.env.PODSTER_E2E_COOKIE_A, process.env.PODSTER_E2E_COOKIE_B];
  if (isLocal && !a && !b) return [await Person.signUp(target, "Person A"), await Person.signUp(target, "Person B")];
  if (!a || !b) {
    console.error("A deployed run needs PODSTER_E2E_SIGNUP_SECRET, or PODSTER_E2E_COOKIE_A and PODSTER_E2E_COOKIE_B from two people's sign-ins.");
    process.exit(2);
  }
  return [await Person.fromCookie(target, "Person A", a), await Person.fromCookie(target, "Person B", b)];
}

async function signOut() {
  let ended = true;
  for (const cookie of ownCookies) {
    await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const after = await target.http("/api/orgs", { headers: { cookie } }).catch(() => null);
    if (after?.status !== 401) ended = false;
  }
  if (ownCookies.length) console.log(ended ? "\nThe test people's sessions are signed out." : "\nWARNING: a test session may still be live. It ends by itself within two hours.");
}

// ---- files ----

/** Creates an upload as this person and sends its bytes. Answers the upload's ID with what the PUT answered. */
async function upload(person, room, name, data, { declaredHash = sha256(data) } = {}) {
  remember(name);
  const created = await person.dash("POST", `/v1/workspaces/${room}/uploads`, { name, size: data.length, sha256: declaredHash });
  if (!created.ok) return { created };
  remember(created.body.token);
  const res = await target.http(created.body.upload_path, { method: "PUT", headers: { authorization: `Bearer ${created.body.token}` }, body: data, signal: AbortSignal.timeout(600_000) });
  const body = await res.json().catch(() => null);
  return { created, id: created.body.id, status: res.status, body };
}

/** Waits for the scanner. Answers the state it settled in and how long that took, or `scanning` if it didn't settle in time. */
async function verdict(person, room, id, started) {
  const deadline = Date.now() + verdictWaitMs;
  for (;;) {
    const file = await person.must("GET", `/v1/workspaces/${room}/files/${id}`);
    if (file.state !== "scanning" || Date.now() > deadline) return { state: file.state, seconds: ((Date.now() - started) / 1000).toFixed(1), file };
    await sleep(isLocal ? 200 : 2000);
  }
}

const personDownload = (person, room, id) => target.http(`/api/v1/files/${room}/${id}`, { headers: { cookie: person.cookie } });
const errorCode = async (res) => (await res.json().catch(() => null))?.error?.code;
const FILE_HEADERS = {
  "x-content-type-options": (v) => v === "nosniff",
  "content-security-policy": (v) => v === "default-src 'none'; sandbox",
  "referrer-policy": (v) => v === "no-referrer",
  "cross-origin-resource-policy": (v) => v === "same-origin",
  "cache-control": (v) => /\bno-store\b/.test(v ?? ""),
  "content-disposition": (v) => /^attachment;/.test(v ?? ""),
};

async function checkServed(res, data, who) {
  check(res.status === 200, `${who}: a ready file downloads`, String(res.status));
  if (res.status !== 200) return;
  const bytes = Buffer.from(await res.arrayBuffer());
  check(bytes.length === data.length && sha256(bytes) === sha256(data), `${who}: with the same bytes`, `${bytes.length} bytes`);
  const wrong = Object.entries(FILE_HEADERS).filter(([name, fits]) => !fits(res.headers.get(name)));
  check(wrong.length === 0, `${who}: with attachment, nosniff, a sandboxing CSP, no-referrer, CORP same-origin and no-store`, wrong.map(([name]) => `${name}: ${res.headers.get(name)}`).join("; "));
}

async function checkRefused(res, status, code, title) {
  const got = await errorCode(res);
  check(res.status === status && got === code, title, `wanted ${status} ${code}, got ${res.status} ${got ?? ""}`);
}

// ---- the run ----

const [owner, outsider] = await people();
const room = await owner.createRoom(`M2 staging ${new Date().toISOString().slice(0, 19)} ${key().slice(-6)}`);
console.log(`Room ${room} on ${base}. Verdicts wait up to ${verdictWaitMs / 1000} s.`);
const objects = [];

const clean = text(20_000);
const CLEAN_NAME = `m2-clean-${key()}.txt`;
let cleanId;
section("Scanning");
await step("a clean text file", async () => {
  const started = Date.now();
  const sent = await upload(owner, room, CLEAN_NAME, clean);
  check(sent.status === 200 && sent.body?.state === "scanning", "a clean text file uploads and waits in scanning", `${sent.status ?? sent.created.status} ${sent.body?.state ?? sent.created.code ?? ""}`);
  if (sent.status !== 200) return;
  cleanId = sent.id;
  objects.push(sent.id);
  // The verdict may already be in, so a 200 here isn't a failure. Only a file still scanning is asked about.
  const early = await personDownload(owner, room, sent.id);
  const earlyCode = await errorCode(early.clone());
  if (early.status === 409) check(earlyCode === "file_not_available", "a file still scanning doesn't download", `409 ${earlyCode}`);
  else record("note", "a file still scanning doesn't download: not asked, as the verdict came first", String(early.status));
  await early.body?.cancel().catch(() => null);
  const settled = await verdict(owner, room, sent.id, started);
  check(settled.state === "ready", "and the scanner makes it ready", `${settled.state} after ${settled.seconds} s`);
});

let blockedId;
await step("the EICAR test string", async () => {
  const started = Date.now();
  const name = `m2-eicar-${key()}.txt`;
  const sent = await upload(owner, room, name, EICAR);
  check(sent.status === 200, "the EICAR test string uploads", `${sent.status ?? sent.created.status} ${sent.created.code ?? ""}`);
  if (sent.status !== 200) return;
  blockedId = sent.id;
  objects.push(sent.id);
  const settled = await verdict(owner, room, sent.id, started);
  check(settled.state === "blocked", "and the scanner blocks it", `${settled.state} after ${settled.seconds} s`);
});

if (big) {
  await step("100 MB of text", async () => {
    const data = text(100_000_000);
    const started = Date.now();
    const sent = await upload(owner, room, `m2-big-${key()}.txt`, data);
    check(sent.status === 200, "100 MB uploads", `${sent.status ?? sent.created.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (sent.status !== 200) return;
    objects.push(sent.id);
    const settled = await verdict(owner, room, sent.id, started);
    check(settled.state === "ready", "and the scanner makes it ready", `${settled.state} after ${settled.seconds} s from the start of its upload`);
    if (settled.state === "ready") await checkServed(await personDownload(owner, room, sent.id), data, "100 MB");
  });
} else skip("100 MB through the scanner", "pass --big");

section("Downloads");
await step("the owner's download", async () => {
  if (!cleanId) return skip("the owner downloads a ready file", "the clean file didn't upload");
  await checkServed(await personDownload(owner, room, cleanId), clean, "the owner");
});

await step("an agent's download", async () => {
  if (!cleanId) return skip("an agent downloads a ready file", "the clean file didn't upload");
  const agent = await AuthAgent.connect(target, owner, "M2 staging agent");
  await owner.addAgent(room, agent);
  const link = await agent.execute("get_asset_link", { workspace_id: room, file_id: cleanId });
  check(link.ok && link.data?.download_path === `/v1/files/${room}/${cleanId}`, "an agent's get_asset_link gives the download path", link.ok ? String(link.data?.download_path) : `${link.status} ${link.code}`);
  const res = await target.http(`/v1/files/${room}/${cleanId}`, { headers: { authorization: `Bearer ${await agent.token("get_asset_link")}` } });
  await checkServed(res, clean, "an agent, with its own credential");
});

section("Refusals");
await step("a blocked file", async () => {
  if (!blockedId) return skip("a blocked file doesn't download", "the EICAR file didn't upload");
  await checkRefused(await personDownload(owner, room, blockedId), 409, "file_not_available", "a blocked file doesn't download");
});
await step("an unknown file", async () => {
  await checkRefused(await personDownload(owner, room, `obj_${randomBytes(16).toString("hex")}`), 404, "file_not_found", "an unknown file answers as one");
});
await step("someone outside the room", async () => {
  if (!cleanId) return skip("someone outside the room can't download", "the clean file didn't upload");
  await checkRefused(await personDownload(outsider, room, cleanId), 404, "workspace_not_found", "someone outside the room can't download, or learn the file exists");
});
await step("no credential", async () => {
  if (!cleanId) return skip("a download with no credential is refused", "the clean file didn't upload");
  await checkRefused(await target.http(`/v1/files/${room}/${cleanId}`), 401, "invalid_credential", "a download with no credential is refused");
});
await step("an executable", async () => {
  const data = text(1_000);
  const created = await owner.dash("POST", `/v1/workspaces/${room}/uploads`, { name: "setup.exe", size: data.length, sha256: sha256(data) });
  check(created.status === 415 && created.code === "executable_refused", "an executable's name is refused before any bytes", `${created.status} ${created.code ?? ""}`);
});
await step("too large", async () => {
  const created = await owner.dash("POST", `/v1/workspaces/${room}/uploads`, { name: "huge.txt", size: 100_000_001, sha256: sha256(Buffer.from("x")) });
  check(created.status === 413 && created.code === "file_too_large", "a file over 100 MB is refused before any bytes", `${created.status} ${created.code ?? ""}`);
});
await step("a wrong hash", async () => {
  const sent = await upload(owner, room, `m2-wrong-${key()}.txt`, text(2_000), { declaredHash: sha256(randomBytes(32)) });
  check(sent.status === 422, "bytes that don't match the declared hash are refused, and nothing is kept", `${sent.status ?? sent.created.status} ${sent.body?.error?.code ?? ""}`);
});

// Each later M2 step fills in its own cases here as it lands. They're listed so a run says what it doesn't cover yet.
section("Later steps");
skip("input assets: link a ready file to a task, and an agent limited to its own tasks sees only linked files", "step 5");
skip("submission files: submit with files, and the reviewer gets the exact versions submitted", "step 6");
skip("expected outputs: a task names one, and approval makes it ready", "step 7");
skip("removal: a removed file stops downloading, and abandoned uploads and unreferenced bytes are cleared", "step 8");
skip("the hour sweep: a file left scanning ends failed", "can't be seen in one run. Check a file from an earlier run, or the room's alarm, by hand");
skip("scanning under load: many files at once, and how long the last waits", "step 11, once the cases above are in");

await signOut();
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`\n${count("ok")} passed, ${count("fail")} failed, ${count("skip")} skipped. Room ${room}. Files: ${objects.join(", ") || "none"}.`);
if (!isLocal) console.log("For the scanner's side, read its log during a run: cd apps/scanner && npx wrangler tail --env staging --format json");
process.exit(count("fail") ? 1 : 0);
