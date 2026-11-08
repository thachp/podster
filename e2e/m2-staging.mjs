// M2 step 11's staging run: files go up through the gateway, wait for the scanner's verdict, and come back down with their bytes
// and headers checked. It checks the EICAR test string is blocked and that refusals answer as the upload policy says. Then steps 5
// to 8: an input asset linked to a guest's task, a submission with files and its approval, an expected output, and removal. The
// hour sweep and load are listed as skipped, since one run can't show them.
//
//   node m2-staging.mjs --base-url <gateway> [--big] [--verdict-wait-s <seconds>] [--allow-host <host>]
//
// People: locally it signs two people up with passwords. On staging, PODSTER_E2E_SIGNUP_SECRET makes two test people through the
// test sign-up, as journey.mjs does, and their sessions are signed out at the end. Otherwise it needs PODSTER_E2E_COOKIE_A and
// PODSTER_E2E_COOKIE_B, each from a different person's sign-in. `--big` adds a 100 MB file through the scanner. It writes rooms
// and files to the target, and staging has no delete route, so rooms are named "M2 staging <time>".
//
// PODSTER_UPLOAD_SECRETS_FILE, if set, gets the file names and upload tokens used, each with its kind, so a caller can check that
// none reached a log. Nothing here reads a database or a log itself.
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
const waitSeconds = Number(option("--verdict-wait-s") ?? (isLocal ? 30 : 300));
if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
  console.error("--verdict-wait-s takes a number of seconds above 0.");
  process.exit(2);
}
const verdictWaitMs = waitSeconds * 1000;

/** One kind and one value a line, so a caller checking the logs can say what leaked without printing it. */
const remember = (kind, value) => process.env.PODSTER_UPLOAD_SECRETS_FILE && appendFileSync(process.env.PODSTER_UPLOAD_SECRETS_FILE, `${kind}\t${value}\n`);
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
/** What a failed request says underneath "fetch failed": the network's own code and message, such as ECONNRESET or a TLS alert. */
const cause = (error) => {
  const parts = [];
  for (let at = error, depth = 0; at && depth < 4; at = at.cause, depth++) {
    const said = [at.code, at.message].filter(Boolean).join(" ");
    if (said && !parts.includes(said)) parts.push(said);
  }
  return parts.join(": ") || String(error);
};
/** Runs one case, so a failure in it is reported and the rest still run. */
async function step(title, run) {
  try {
    await run();
  } catch (error) {
    record("fail", title, cause(error));
  }
}

// ---- people ----

const ownCookies = [];
let room;
const objects = [];
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
  if (signOut.done) return;
  signOut.done = true;
  let ended = true;
  for (const cookie of ownCookies) {
    await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const after = await target.http("/api/orgs", { headers: { cookie } }).catch(() => null);
    if (after?.status !== 401) ended = false;
  }
  if (ownCookies.length) console.log(ended ? "\nThe test people's sessions are signed out." : "\nWARNING: a test session may still be live. It ends by itself within two hours.");
}

// ---- files ----

/** Sends an upload's bytes. A network failure answers its cause instead of throwing, so a caller can say what happened. */
async function put(created, data) {
  remember("upload token", created.token);
  try {
    const res = await target.http(created.upload_path, { method: "PUT", headers: { authorization: `Bearer ${created.token}` }, body: data, signal: AbortSignal.timeout(600_000) });
    return { id: created.id, status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    return { id: created.id, status: null, failure: cause(error) };
  }
}

/**
 * Creates an upload as this person and sends its bytes. Answers the upload's ID with what the PUT answered. `retry` tries once more
 * with a fresh upload, and so a fresh token, if the network failed, since a large upload from some networks fails on the way.
 */
async function upload(person, room, name, data, { declaredHash = sha256(data), retry = false } = {}) {
  remember("file name", name);
  for (let attempt = 1; ; attempt++) {
    const created = await person.dash("POST", `/v1/workspaces/${room}/uploads`, { name, size: data.length, sha256: declaredHash });
    if (!created.ok) return { created };
    const sent = { created, ...(await put(created.body, data)) };
    if (sent.status !== null || !retry || attempt > 1) return { ...sent, attempts: attempt };
    record("note", `an upload failed on the network, so it's tried once more with a fresh token`, sent.failure);
  }
}
/** What an upload ended as, for a check's detail: a status and code, or the network's cause. */
const outcome = (sent) => (sent.status === null ? `network failure: ${sent.failure}` : `${sent.status ?? sent.created?.status} ${sent.body?.error?.code ?? sent.body?.state ?? sent.created?.code ?? ""}`);

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

// A run stopped partway still signs its test people out.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => signOut().finally(() => process.exit(130)));
}

let failedOutside = false;
try {
  await run();
} catch (error) {
  failedOutside = true;
  console.error(`FAIL the run stopped: ${cause(error)}`);
} finally {
  await signOut();
}
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`\n${count("ok")} passed, ${count("fail")} failed, ${count("skip")} skipped.${room ? ` Room ${room}.` : ""} Files: ${objects.join(", ") || "none"}.`);
if (!isLocal) console.log("For the scanner's side, read its log during a run: cd apps/scanner && npx wrangler tail --env staging --format json");
process.exit(count("fail") || failedOutside ? 1 : 0);

async function run() {
  const [owner, outsider] = await people();
  room = await owner.createRoom(`M2 staging ${new Date().toISOString().slice(0, 19)} ${key().slice(-6)}`);
  console.log(`Room ${room} on ${base}. Verdicts wait up to ${verdictWaitMs / 1000} s.`);

  const clean = text(20_000);
  const CLEAN_NAME = `m2-clean-${key()}.txt`;
  let cleanId;
  section("Scanning");
  await step("a clean text file", async () => {
    const started = Date.now();
    const sent = await upload(owner, room, CLEAN_NAME, clean);
    check(sent.status === 200 && sent.body?.state === "scanning", "a clean text file uploads and waits in scanning", outcome(sent));
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
    check(sent.status === 200, "the EICAR test string uploads", outcome(sent));
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
      const sent = await upload(owner, room, `m2-big-${key()}.txt`, data, { retry: true });
      check(sent.status === 200, "100 MB uploads", `${outcome(sent)} in ${((Date.now() - started) / 1000).toFixed(1)} s, attempts ${sent.attempts ?? 1}`);
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
    check(sent.status === 422 && sent.body?.error?.code === "upload_mismatch", "bytes that don't match the declared hash are refused", `${sent.status ?? sent.created.status} ${sent.body?.error?.code ?? ""}`);
    if (!sent.id) return;
    // Nothing is kept: the file never leaves uploading, so it can be tried again, and it has nothing to download.
    const file = await owner.dash("GET", `/v1/workspaces/${room}/files/${sent.id}`);
    const download = await personDownload(owner, room, sent.id);
    const downloadCode = await errorCode(download);
    check(file.ok && file.body.state === "uploading" && file.body.download_path === null && download.status === 409 && downloadCode === "file_not_available", "and nothing is kept: it's still uploading, with nothing to download", `${file.body?.state ?? file.status}, download ${download.status} ${downloadCode ?? ""}`);
  });

  await laterSteps(owner, room);

  section("Not covered by one run");
  skip("the hour sweep: a file left scanning ends failed", "takes an hour, so one run can't show it");
  skip("scanning under load: many files at once, and how long the last waits", "step 11, once the cases above are in");
}

// ---- steps 5 to 8 ----

/** An agent's view of a file, through `get_asset_link`. */
function agentFile(agent, room, id) {
  return agent.execute("get_asset_link", { workspace_id: room, file_id: id });
}
async function agentDownload(agent, room, id) {
  return target.http(`/v1/files/${room}/${id}`, { headers: { authorization: `Bearer ${await agent.token("get_asset_link")}` } });
}

/** Uploads a file for a task's submission as its assignee, through `create_upload`, and waits for its scan as that agent sees it. */
async function agentUpload(agent, room, task, name, data) {
  remember("file name", name);
  const created = await agent.execute("create_upload", { workspace_id: room, task_id: task, name, size: data.length, sha256: sha256(data), idempotency_key: key() });
  if (!created.ok) return { refused: `${created.status} ${created.code}` };
  const sent = await put(created.data, data);
  if (sent.status !== 200) return { refused: outcome(sent) };
  const deadline = Date.now() + verdictWaitMs;
  for (;;) {
    const file = await agentFile(agent, room, sent.id);
    const state = file.data?.state;
    if ((file.ok && state !== "scanning") || Date.now() > deadline) return { id: sent.id, state: file.ok ? state : `${file.status} ${file.code}` };
    await sleep(isLocal ? 200 : 2000);
  }
}

function taskPath(room, task) {
  return `/v1/workspaces/${room}/tasks/${task}`;
}
/** A task for the agent, from the owner, who is then its requester and reviewer. */
async function offer(owner, room, agent, title) {
  return owner.must("POST", `/v1/workspaces/${room}/tasks`, { title, instructions: "Part of the M2 staging run.", assignee: agent.id });
}

async function laterSteps(owner, room) {
  // One agent limited to its own tasks: a guest sees only the tasks it's part of, and only files linked to those.
  const guest = await AuthAgent.connect(target, owner, "M2 staging guest");
  await owner.addAgent(room, guest, "guest");
  const asset = text(3_000, "an input asset\n");
  const unlinked = text(3_000, "another input asset\n");
  let assetId;
  let otherId;
  let task;
  let taskVersion;
  let output;
  let submittedId;

  section("Step 5: input assets");
  await step("input assets", async () => {
    const sent = await upload(owner, room, `m2-asset-${key()}.txt`, asset);
    const other = await upload(owner, room, `m2-asset-${key()}.txt`, unlinked);
    if (sent.status !== 200 || other.status !== 200) return check(false, "two input assets upload", `${outcome(sent)}; ${outcome(other)}`);
    [assetId, otherId] = [sent.id, other.id];
    objects.push(assetId, otherId);
    const states = [(await verdict(owner, room, assetId, Date.now())).state, (await verdict(owner, room, otherId, Date.now())).state];
    check(states.every((state) => state === "ready"), "two input assets upload and become ready", states.join(", "));
    output = (await owner.must("POST", `/v1/workspaces/${room}/outputs`, { title: "M2 staging output" })).id;
    ({ id: task, version: taskVersion } = await offer(owner, room, guest, "M2 staging task"));
    const before = await agentFile(guest, room, assetId);
    check(!before.ok && before.status === 404 && before.code === "file_not_found", "a guest can't see an input asset before it's linked to its task", `${before.status} ${before.code ?? ""}`);
    const linked = await owner.dash("POST", `/v1/workspaces/${room}/files/${assetId}/links`, { task_id: task });
    check(linked.ok && linked.body.linked === true, "the owner links it to the guest's task", `${linked.status} ${linked.code ?? ""}`);
    const after = await agentFile(guest, room, assetId);
    check(after.ok && after.data.download_path === `/v1/files/${room}/${assetId}` && after.data.linked_tasks?.includes(task), "then the guest sees it, linked to its task, with a download path", after.ok ? `${after.data.download_path}` : `${after.status} ${after.code}`);
    await checkServed(await agentDownload(guest, room, assetId), asset, "the guest, a linked input asset");
    const listed = await guest.execute("list_assets", { workspace_id: room });
    const ids = (listed.data?.files ?? []).map((f) => f.id);
    check(listed.ok && ids.length === 1 && ids[0] === assetId, "the guest's asset list holds only the linked asset", listed.ok ? `${ids.length} listed` : `${listed.status} ${listed.code}`);
    const hidden = await agentFile(guest, room, otherId);
    check(!hidden.ok && hidden.status === 404 && hidden.code === "file_not_found", "an input asset not linked to its task stays hidden from it", `${hidden.status} ${hidden.code ?? ""}`);
    await checkRefused(await agentDownload(guest, room, otherId), 404, "file_not_found", "and doesn't download, as if it didn't exist");
  });

  section("Step 6: submission files");
  await step("submission files", async () => {
    if (!task) return skip("a submission with files", "the task wasn't made");
    const named = await owner.dash("PUT", `${taskPath(room, task)}/expected-output`, { version: taskVersion, output_id: output });
    check(named.ok, "the owner names the expected output on the task", `${named.status} ${named.code ?? ""}`);
    // Each step reads the version the one before answered. If one failed, there's no version to use, so the rest is skipped.
    if (!named.ok) return skip("the rest of the submission", "naming the output failed");
    const accepted = await guest.execute("accept_task", { workspace_id: room, task_id: task, version: named.body.version, idempotency_key: key() });
    check(accepted.ok, "the guest accepts the task", `${accepted.status} ${accepted.code ?? ""}`);
    if (!accepted.ok) return skip("the rest of the submission", "accepting the task failed");
    const work = text(4_000, "the guest's work\n");
    const file = await agentUpload(guest, room, task, `m2-work-${key()}.txt`, work);
    check(file.state === "ready", "the guest uploads a file for its submission, and it's scanned ready", file.refused ?? file.state);
    if (file.state !== "ready") return;
    submittedId = file.id;
    objects.push(file.id);
    const hiddenFromOwner = await owner.dash("GET", `/v1/workspaces/${room}/files/${file.id}`);
    check(hiddenFromOwner.status === 404 && hiddenFromOwner.code === "file_not_found", "until it's submitted, only its uploader sees it", `${hiddenFromOwner.status} ${hiddenFromOwner.code ?? ""}`);
    const submitted = await guest.execute("submit_task", { workspace_id: room, task_id: task, version: accepted.data.version, files: [{ id: file.id, label: "The work" }], idempotency_key: key() });
    check(submitted.ok && submitted.data.status === "submitted", "the guest submits with the file", `${submitted.status} ${submitted.data?.status ?? submitted.code ?? ""}`);
    const read = await owner.must("GET", taskPath(room, task));
    const pinned = (read.files ?? []).find((f) => f.id === file.id);
    check(pinned?.submitted === true && pinned.submission_no === 1 && pinned.sha256 === sha256(work) && pinned.size === work.length, "the reviewer sees the exact version submitted, by hash and size", pinned ? `submission ${pinned.submission_no}, ${pinned.size} bytes` : "not listed");
    if (pinned?.download_path) await checkServed(await personDownload(owner, room, file.id), work, "the reviewer, the submitted file");
    else check(false, "the reviewer can download the submitted file", "no download path");
    const approved = await owner.dash("POST", `${taskPath(room, task)}/verify`, { submission_no: 1 });
    check(approved.ok && approved.body.status === "completed", "the reviewer approves that submission", `${approved.status} ${approved.body?.status ?? approved.code ?? ""}`);

    // A second task, whose file is removed after it's submitted: approval is refused, and changes can still be requested.
    const { id: second, version: secondVersion } = await offer(owner, room, guest, "M2 staging removed before approval");
    const took = await guest.execute("accept_task", { workspace_id: room, task_id: second, version: secondVersion, idempotency_key: key() });
    const gone = await agentUpload(guest, room, second, `m2-gone-${key()}.txt`, text(1_500, "removed before approval\n"));
    if (!took.ok || gone.state !== "ready") return check(false, "a second submission with a file", `${took.status} ${took.code ?? ""}; ${gone.refused ?? gone.state}`);
    objects.push(gone.id);
    const sent = await guest.execute("submit_task", { workspace_id: room, task_id: second, version: took.data.version, files: [{ id: gone.id }], idempotency_key: key() });
    const removed = await owner.dash("POST", `/v1/workspaces/${room}/files/${gone.id}/remove`, {});
    check(sent.ok && removed.ok, "a second submission's file is removed after it's submitted", `${sent.status}, remove ${removed.status} ${removed.code ?? ""}`);
    const refusedApproval = await owner.dash("POST", `${taskPath(room, second)}/verify`, { submission_no: 1 });
    check(refusedApproval.status === 409 && refusedApproval.code === "file_removed", "and approving it is refused", `${refusedApproval.status} ${refusedApproval.code ?? ""}`);
    skip("approval refused after a submitted file is blocked", "only a later scan can block a ready file, and a run can't cause one");
  });

  section("Step 7: expected outputs");
  await step("expected outputs", async () => {
    if (!output || !submittedId) return skip("an approval makes an output ready", "the submission didn't happen");
    const ready = (await owner.must("GET", `/v1/workspaces/${room}/outputs`)).outputs?.find((o) => o.id === output);
    check(ready?.status === "ready" && ready.current?.task_id === task && ready.current.files_available === true, "approving the task makes its expected output ready, with its files available", ready ? `${ready.status}, files_available ${ready.current?.files_available}` : "not listed");
    const removed = await owner.dash("POST", `/v1/workspaces/${room}/files/${submittedId}/remove`, {});
    check(removed.ok && removed.body.state === "removed", "the owner removes the approved file", `${removed.status} ${removed.body?.state ?? removed.code ?? ""}`);
    const after = (await owner.must("GET", `/v1/workspaces/${room}/outputs`)).outputs?.find((o) => o.id === output);
    check(after?.status === "ready" && after.current?.files_available === false, "the output stays ready, and says its files aren't available", after ? `${after.status}, files_available ${after.current?.files_available}` : "not listed");
  });

  section("Step 8: removal");
  await step("removal", async () => {
    if (!assetId) return skip("a removed file stops downloading", "the input asset didn't upload");
    const before = await owner.dash("GET", `/v1/workspaces/${room}/files/${assetId}`);
    check(before.ok && before.body.state === "ready", "an input asset is ready before removal", `${before.body?.state ?? before.status}`);
    const removed = await owner.dash("POST", `/v1/workspaces/${room}/files/${assetId}/remove`, {});
    check(removed.ok && removed.body.state === "removed" && removed.body.sha256 === sha256(asset) && Boolean(removed.body.removed_at), "the owner removes it, and its record and hash are kept", `${removed.status} ${removed.body?.state ?? removed.code ?? ""}`);
    await checkRefused(await personDownload(owner, room, assetId), 410, "file_removed", "it no longer downloads for the owner");
    await checkRefused(await agentDownload(guest, room, assetId), 410, "file_removed", "or for the guest it was linked for");
    const again = await owner.dash("POST", `/v1/workspaces/${room}/files/${assetId}/remove`, {});
    check(again.ok && again.body.state === "removed", "removing it again changes nothing", `${again.status} ${again.body?.state ?? again.code ?? ""}`);
    if (submittedId) await checkRefused(await personDownload(owner, room, submittedId), 410, "file_removed", "an approved submission's removed file no longer downloads either");
  });
}
