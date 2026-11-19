// M7 step 15 (R-17), the staging half: a deployed Podster's nudge, sent through the A2A queue to a public HTTPS address the
// owner controls, answered by an independent A2A 1.0 server, the A2A project's own @a2a-js/sdk 1.3.0 (a2a-sdk-endpoint.mjs).
// The local half is apps/api/test/a2a-nudge-interop.spec.ts and apps/runner/test/nudge-interop.test.ts; ADR 0007's
// "Nudge interoperability (M7 step 15)" says what both show.
//
//   node m7-nudge-interop-staging.mjs --base-url <gateway> --public-origin <https://host> --port <local port> [--allow-host <host>]
//   node m7-nudge-interop-staging.mjs --self-test
//
// **Opt-in, the owner's.** It needs a public HTTPS origin that the owner controls and has forwarded, with the path unchanged,
// to 127.0.0.1:<port> on this machine (a tunnel or reverse proxy the owner runs; this script starts none). It starts the
// SDK server on that port, as a child process with child-env.mjs's allow-listed environment, so it never sees our
// variables. It then:
//
// 1. card discovery: registers `<origin>/ext/<n>` as a nudge endpoint. Podster is configured with the URL directly and
//    fetches no card (decision 120), so none is served.
// 2. control: the agent's `verify_a2a_endpoint`, answered by the owner's glue in front of the SDK; then the owner's opt-in.
// 3. authenticated delivery: an offer, and the nudge it sends, signed and with the endpoint's bearer token, parsed by the
//    SDK as a 1.0 SendMessage with one data part holding IDs only; the SDK's Message answer counts as taken.
// 4. errors: the server holding another token answers 401, which counts as a failure and is retried after 60 s; restoring
//    the token lets the retry through. A server whose SDK card offers only 0.3 answers VersionNotSupportedError, a failure.
//    A plain SDK server can't prove control: it answers the challenge "method not found".
//
// People and agents are made as a2a-staging.mjs makes them: PODSTER_E2E_SIGNUP_SECRET for a test person on staging, or
// PODSTER_E2E_COOKIE_A. It writes a room named "Nudge interop <time>", three agents and three tasks; staging has no delete
// route. Endpoints it set are deleted at the end. No signing secret or token is printed, which it checks at the end.
//
// `--self-test` runs none of that: it starts the SDK server on a free loopback port and drives it as Podster would, with
// signatures made here, to check the server half before an owner's run. It reaches nothing but 127.0.0.1.
import { fork } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import { key, McpAgent, Person, sleep, Target } from "./lib.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node m7-nudge-interop-staging.mjs --base-url <gateway> --public-origin <https://host> --port <local port> [--allow-host <host>]
       node m7-nudge-interop-staging.mjs --self-test

The nudge's A2A interoperability on a deployment (M7 step 15, R-17), against @a2a-js/sdk 1.3.0's own server.
--public-origin is an HTTPS origin the owner controls, forwarded with the path unchanged to 127.0.0.1:<port>.
It writes a room, three agents and three tasks. On staging, set PODSTER_E2E_SIGNUP_SECRET or PODSTER_E2E_COOKIE_A.
--self-test checks the SDK server on loopback only, with no deployment.
Exit codes: 0 when nothing failed, 1 when something did, 2 for a refused argument or host.`);
  process.exit(0);
}
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const here = dirname(fileURLToPath(import.meta.url));

// ---- reporting ----

const results = [];
const record = (status, title, detail = "") => {
  results.push({ status, title });
  console.log(`${{ ok: "ok  ", fail: "FAIL", skip: "skip" }[status]} ${title}${detail ? `: ${detail}` : ""}`);
};
const check = (passed, title, detail) => record(passed ? "ok" : "fail", title, detail);
const section = (name) => console.log(`\n## ${name}`);
async function step(title, run) {
  try {
    await run();
  } catch (error) {
    record("fail", title, String(error?.message ?? error).slice(0, 300));
  }
}

// Everything printed, so the end can check no secret or token is in it.
const written = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return write(chunk, ...rest);
  };
}
const secrets = new Set();
/** The run's room, once made. */
let room;

// ---- the SDK server, a child with the allow-listed environment ----

const received = [];
async function startServer(port) {
  const child = fork(join(here, "a2a-sdk-endpoint.mjs"), [], { cwd: here, env: childEnv({ PORT: port }), stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const listening = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the SDK server didn't start within 15 s")), 15_000);
    child.on("message", (message) => {
      if (message?.listening !== undefined) {
        clearTimeout(timer);
        resolve(message.listening);
      }
      if (message?.received) received.push(message.received);
    });
    child.once("exit", (code) => reject(new Error(`the SDK server exited (${code})`)));
  });
  const heldSecrets = new Map();
  const hold = (path, secret, token = null) => {
    secrets.add(secret);
    if (token) secrets.add(token);
    heldSecrets.set(path, secret);
    child.send({ hold: { path, secret, token } });
  };
  return { port: listening, hold, secretFor: (path) => heldSecrets.get(path), stop: () => child.kill("SIGTERM") };
}
const forTask = (task) => received.filter((r) => r.message?.parts?.[0]?.content?.value?.task_id === task);
async function until(test, ms, every = 2_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value || Date.now() > deadline) return value;
    await sleep(every);
  }
}
const nudgeShape = (r, room, task) => {
  const part = r?.message?.parts?.[0];
  const data = part?.content?.value ?? {};
  return r?.message?.role === 1 && r.message.parts.length === 1 && part.content.$case === "data" && part.mediaType === "application/json" &&
    Object.keys(data).sort().join(",") === "attempt_id,attempt_kind,kind,task_id,workspace_id" && data.kind === "podster.dev/nudge" &&
    data.workspace_id === room && data.task_id === task && data.attempt_kind === "offer" && r.message.messageId === data.attempt_id;
};

// ---- the self-test: loopback only ----

if (args.includes("--self-test")) {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.port}`;
  const secret = `a2asec_${randomBytes(24).toString("hex")}`;
  const sign = (body, s = secret) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", s).update(`${t}.${body}`).digest("hex")}`;
  };
  const post = async (path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0", "x-podster-signature": sign(body), ...headers }, body });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const nudgeBody = (attempt) => JSON.stringify({
    jsonrpc: "2.0", id: attempt, method: "SendMessage",
    params: { message: { messageId: attempt, role: "ROLE_USER", parts: [{ data: { kind: "podster.dev/nudge", workspace_id: "ws_self", task_id: "tsk_self", attempt_id: attempt, attempt_kind: "offer" }, mediaType: "application/json" }], metadata: { "podster.dev/delivery": "nudge" } }, configuration: { returnImmediately: true } },
  });
  const challenge = randomBytes(32).toString("hex");
  const verifyBody = JSON.stringify({ jsonrpc: "2.0", id: challenge, method: "podster.dev/verifyEndpoint", params: { agent_id: "agt_self", version: 1, challenge } });
  server.hold("/ext/1", secret, "tok_self");
  server.hold("/old/1", secret);
  await step("self-test", async () => {
    const proof = await post("/ext/1", verifyBody);
    check(proof.body?.result?.proof === createHmac("sha256", secret).update(`podster-endpoint-proof/1.agt_self.1.${challenge}`).digest("hex"), "the owner's glue answers the challenge with the proof");
    const taken = await post("/ext/1", nudgeBody("att_self"), { authorization: "Bearer tok_self" });
    check(taken.status === 200 && typeof taken.body?.result?.message?.messageId === "string" && !taken.body.error, "the SDK takes a Podster-shaped nudge and answers a Message");
    await until(() => forTask("tsk_self").length > 0, 2_000, 50);
    check(nudgeShape(forTask("tsk_self")[0], "ws_self", "tsk_self"), "the SDK parsed one data part with the IDs");
    check((await post("/ext/1", nudgeBody("att_self_2"), { authorization: "Bearer tok_other" })).status === 401, "a wrong bearer token is refused with 401");
    check((await post("/ext/1", nudgeBody("att_self_3"), { "x-podster-signature": sign(nudgeBody("att_self_3"), "a2asec_other") })).status === 401, "a wrong signature is refused with 401");
    check((await post("/old/1", nudgeBody("att_self_4"))).body?.error?.code === -32009, "the 0.3-only SDK server answers VersionNotSupportedError");
    check((await post("/plain/1", verifyBody)).body?.error?.code === -32601, "the plain SDK server answers the challenge with method not found");
  });
  server.stop();
  finish();
}

// ---- the deployed run ----

const base = (option("--base-url") ?? process.env.PODSTER_E2E_BASE_URL)?.replace(/\/$/, "");
const publicOrigin = option("--public-origin");
const port = Number(option("--port"));
if (!base || !publicOrigin || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Pass --base-url, --public-origin and --port, or --self-test.");
  process.exit(2);
}
let origin;
try {
  origin = new URL(publicOrigin);
} catch {
  console.error("--public-origin isn't a URL.");
  process.exit(2);
}
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.port || !origin.hostname.includes(".")) {
  console.error("--public-origin must be an HTTPS origin on the default port, with no path, such as https://nudge.example.org.");
  process.exit(2);
}
const STAGING = "https://gateway-staging.podster.dev";
const host = new URL(base).hostname;
if (new URL(base).origin !== STAGING && option("--allow-host") !== host) {
  console.error(`Refusing to write test data to ${host}. Pass --allow-host ${host} if that's really intended.`);
  process.exit(2);
}
if (new URL(base).protocol !== "https:") {
  console.error(`Refusing to send session cookies or tokens to ${base} without HTTPS.`);
  process.exit(2);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
if (signupSecret && new URL(base).origin !== STAGING) {
  console.error(`PODSTER_E2E_SIGNUP_SECRET only works against ${STAGING}. Unset it to run against ${host}.`);
  process.exit(2);
}

const target = new Target(base, { pollMs: 1000 });
const ownCookies = [];
const cleanups = [];
let server;
try {
  server = await startServer(port);
  await run();
} catch (error) {
  record("fail", "the run stopped", String(error?.message ?? error).slice(0, 300));
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => null);
  for (const cookie of ownCookies) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  server?.stop();
}
finish();

async function person() {
  if (signupSecret) {
    const cookie = await Person.testSessionCookie(target, "Person A", signupSecret);
    ownCookies.push(cookie);
    return Person.fromCookie(target, "Person A", cookie);
  }
  const cookie = process.env.PODSTER_E2E_COOKIE_A;
  if (!cookie) {
    console.error("A deployed run needs PODSTER_E2E_SIGNUP_SECRET, or PODSTER_E2E_COOKIE_A from a person's sign-in.");
    process.exit(2);
  }
  return Person.fromCookie(target, "Person A", cookie);
}

/** An agent in the room with a nudge endpoint on the SDK server `kind`, its secret and token held there. */
async function nudgeAgent(owner, kind, label, token = null) {
  const agent = await McpAgent.connect(target, owner, label);
  await owner.addAgent(room, agent, "guest");
  const path = `/${kind}/${randomBytes(6).toString("hex")}`;
  const url = `${origin.origin}${path}`;
  const set = await agent.call("set_a2a_endpoint", { url, delivery: "nudge", ...(token ? { token } : {}) });
  if (typeof set.data?.signing_secret === "string") server.hold(path, set.data.signing_secret, token);
  if (!set.ok) throw new Error(`set_a2a_endpoint: ${set.code}`);
  cleanups.push(() => agent.call("delete_a2a_endpoint", {}));
  return { agent, path, url, version: set.data.version };
}
const switchOn = (owner, t) => owner.dash("PUT", `/agents/${t.agent.id}/a2a-endpoint/nudge`, { on: true, version: t.version });
const endpointRead = async (t) => (await t.agent.call("get_a2a_endpoint", {})).data;

async function run() {
  const owner = await person();
  room = await owner.createRoom(`Nudge interop ${new Date().toISOString().slice(0, 19)} ${key().slice(-6)}`);
  console.log(`Room ${room} on ${base}; the SDK server on 127.0.0.1:${server.port}, reached at ${origin.origin}.`);
  const lead = await McpAgent.connect(target, owner, "Nudge interop lead");
  await owner.addAgent(room, lead, "member");
  const offer = async (title, assignee) => (await lead.must("create_task", { workspace_id: room, title, instructions: "From the nudge interoperability run.", assignee })).id;
  const token = `e2eA2aTok_${randomBytes(16).toString("hex")}`;

  section("Control and the owner's opt-in (the extension method, beside A2A)");
  const ext = await nudgeAgent(owner, "ext", "Nudge interop: SDK with glue", token);
  await step("verify", async () => {
    const verified = await ext.agent.call("verify_a2a_endpoint", {});
    check(verified.ok && verified.data?.verified === true, "the agent's verify is answered through the public address with the proof", verified.ok ? verified.data?.reason ?? "" : verified.code);
    const on = await switchOn(owner, ext);
    check(on.status === 200 && on.body?.nudge_on === true, "the owner switches the nudge on for the verified version", `HTTP ${on.status}`);
  });

  section("Authenticated delivery to the A2A project's own server");
  let first;
  await step("delivery", async () => {
    first = await offer("Nudge interop: delivered", ext.agent.id);
    const got = await until(() => forTask(first)[0], 120_000);
    check(nudgeShape(got, room, first), "the SDK parsed the nudge as a 1.0 SendMessage: a user message, one data part, IDs only", got ? "" : "nothing arrived within 2 minutes");
    check(got?.server === "ext" && got?.a2aVersion === "1.0", "it came with A2A-Version 1.0, past the signature and bearer checks", got?.a2aVersion ?? "");
    check(!JSON.stringify(got ?? {}).includes("Nudge interop: delivered"), "no task text in what arrived");
    const read = await until(async () => ((await endpointRead(ext))?.consecutive_failures === 0 ? await endpointRead(ext) : null), 30_000);
    check(read?.enabled === true && read?.consecutive_failures === 0, "the SDK's Message answer counted as taken", read ? `${read.consecutive_failures} failures` : "");
    const task = await lead.must("get_task", { workspace_id: room, task_id: first }, false);
    check(task.task.status === "offered", "and the nudge changed nothing about the task", task.task.status);
  });

  section("Error answers");
  await step("refused, then retried", async () => {
    // The endpoint now wants another token: Podster's is refused with 401.
    const other = `e2eA2aTok_${randomBytes(16).toString("hex")}`;
    const secret = server.secretFor(ext.path);
    server.hold(ext.path, secret, other);
    const second = await offer("Nudge interop: refused, then retried", ext.agent.id);
    const failed = await until(async () => ((await endpointRead(ext))?.consecutive_failures ?? 0) >= 1, 120_000);
    check(failed && forTask(second).length === 0, "a 401 from the server isn't taken: Podster counts a failure", failed ? "" : "no failure counted within 2 minutes");
    server.hold(ext.path, secret, token);
    const retried = await until(() => forTask(second)[0], 180_000, 5_000);
    check(nudgeShape(retried, room, second), "the retry, about a minute later, is taken once the token matches again", retried ? "" : "no retry arrived within 3 minutes");
  });
  await step("a server that offers only A2A 0.3", async () => {
    const old = await nudgeAgent(owner, "old", "Nudge interop: SDK on 0.3 only");
    const verified = await old.agent.call("verify_a2a_endpoint", {});
    if (!verified.data?.verified) return check(false, "the 0.3-only server proves control through the glue", verified.code ?? verified.data?.reason ?? "");
    await switchOn(owner, old);
    const task = await offer("Nudge interop: to 0.3 only", old.agent.id);
    const failed = await until(async () => ((await endpointRead(old))?.consecutive_failures ?? 0) >= 1, 120_000);
    check(failed && forTask(task).length === 0, "the SDK's VersionNotSupportedError isn't taken: Podster counts a failure");
  });
  await step("a plain A2A server", async () => {
    const plain = await nudgeAgent(owner, "plain", "Nudge interop: SDK alone");
    const verified = await plain.agent.call("verify_a2a_endpoint", {});
    check(verified.ok && verified.data?.verified === false, "a plain SDK server can't prove control: it doesn't know the extension method", verified.data?.reason ?? verified.code ?? "");
    const on = await switchOn(owner, plain);
    check(on.status === 409, "so the owner can't switch it on", `HTTP ${on.status} ${on.code ?? ""}`);
  });
}

function finish() {
  const output = written.join("");
  const leaked = [...secrets].filter((value) => value && output.includes(value)).length;
  const shapes = (output.match(/a2asec_[0-9a-f]{8,}|e2eA2aTok_[0-9a-f]{8,}/g) ?? []).length;
  check(leaked === 0 && shapes === 0, "no signing secret or token anywhere in this script's output", `${secrets.size} values checked`);
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`\n${count("ok")} passed, ${count("fail")} failed, ${count("skip")} skipped.${room ? ` Room ${room}.` : ""}`);
  process.exit(count("fail") ? 1 : 0);
}
