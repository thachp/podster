// Checks the test A2A server's own rules in Node, with no network: it refuses anything not sealed under RUN_KEY and signed,
// downloads only the gateway's /a2a/files link, and answers SendMessage, GetTask and CancelTask as Podster expects.
//
//   node a2a-test-server/selftest.mjs
import { randomBytes } from "node:crypto";
import { keyCheck, runKey, seal, sign } from "./seal.mjs";
import worker from "./worker.mjs";

const GATEWAY = "https://gateway-staging.podster.dev";
const hexKey = randomBytes(32).toString("hex");
const env = { RUN_KEY: hexKey, GATEWAY_URL: GATEWAY };
const key = await runKey(hexKey);
const secret = `a2asec_${randomBytes(32).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const bearer = await seal(key, { s: secret, a: "a2a-token-for-test", x: now() + 600 });

let failed = 0;
const check = (passed, title, detail = "") => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `: ${detail}` : ""}`);
};

const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
  return new Response("input bytes\n");
};

async function call(body, { path = "/a2a", auth = bearer, signature, at = now() } = {}) {
  const text = JSON.stringify(body);
  const headers = { "content-type": "application/json", "x-podster-signature": signature ?? (await sign(secret, at, text)) };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await worker.fetch(new Request(`https://test.workers.dev${path}`, { method: "POST", headers, body: text }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const send = (message, id = "att_1") => ({ jsonrpc: "2.0", id, method: "SendMessage", params: { message, configuration: { returnImmediately: true } } });
const offer = (text) => ({ messageId: "att_1", role: "ROLE_USER", parts: [{ text, mediaType: "text/markdown" }] });

// The same signature crates/egress makes, from its own known-value test.
check((await sign("secret", 1730600000, "{}")) === "t=1730600000,v1=a53ce417c9caf431331ae71e928a652150ef8a8e04211c583beeddb011769d2b", "signs exactly as crates/egress::sign does");

// ---- refusals ----
const plain = send(offer("# A task"));
check((await call(plain, { auth: null })).status === 401, "no bearer: 401");
const otherKey = await seal(await runKey(randomBytes(32).toString("hex")), { s: secret, x: now() + 600 });
check((await call(plain, { auth: otherKey })).status === 401, "a bearer sealed under another key: 401");
check((await call(plain, { auth: await seal(key, { s: secret, x: now() - 1 }) })).status === 401, "an expired bearer: 401");
check((await call(plain, { auth: `${bearer.slice(0, -2)}AA` })).status === 401, "an altered bearer: 401");
check((await call(plain, { auth: await seal(key, { s: secret, x: now() + 2 * 3600 }) })).status === 401, "a bearer that claims to live past an hour: 401");
check((await call(plain, { signature: await sign("a2asec_wrong", now(), JSON.stringify(plain)) })).status === 401, "a signature under another secret: 401");
check((await call(plain, { at: now() - 900 })).status === 401, "a signature 15 minutes old: 401");
check((await call(plain, { signature: "t=1,v1=zz" })).status === 401, "a malformed signature: 401");
check(fetched.length === 0, "nothing refused fetched anything");
const ready = await (await worker.fetch(new Request("https://test.workers.dev/ready"), env)).json();
check(ready.ready === true && ready.key_check === (await keyCheck(hexKey)), "/ready shows a matching key check value");
const notReady = await (await worker.fetch(new Request("https://test.workers.dev/ready"), {})).json();
check(notReady.ready === false && notReady.key_check === null, "/ready without RUN_KEY says so");
check((await worker.fetch(new Request("https://test.workers.dev/a2a", { method: "POST", body: "{}" }), {})).status === 503, "without RUN_KEY every call is 503");

// ---- an offer with an input file ----
const link = `${GATEWAY}/a2a/files/ws_abc/obj_def`;
const sent = await call(send(offer(`# A task\n\nInput files:\n- in.txt: ${link}\n\nOn Podster: https://app.example/w/ws_abc/tasks`)));
const task = sent.body?.result?.task;
check(sent.status === 200 && /^rt\.o\.[0-9a-z]+\.200-[0-9a-f]{12}\.[0-9a-f]{12}$/.test(task?.id ?? "") && task.status.state === "TASK_STATE_SUBMITTED", "SendMessage answers a SUBMITTED task whose ID records the download", task?.id);
check(fetched.length === 1 && fetched[0].url === link && fetched[0].authorization === "Bearer a2a-token-for-test" && fetched[0].redirect === "manual", "one GET of the /a2a/files link, with the /a2a token, no redirects");
const other = await call(send(offer("Input: https://evil.example/a2a/files/ws_a/obj_b")));
check(/^rt\.o\.[0-9a-z]+\.x\./.test(other.body?.result?.task?.id ?? "") && fetched.length === 1, "a link on another host isn't fetched");

const read = (n, id = task.id) => call({ jsonrpc: "2.0", id: `att_1:${n}`, method: "GetTask", params: { id, historyLength: 0 } });
const one = await read(1);
check(one.body?.result?.status?.state === "TASK_STATE_WORKING" && one.body.result.contextId === task.contextId, "read 1 is WORKING, in the same context");
const two = await read(2);
const parts = two.body?.result?.artifacts?.[0]?.parts ?? [];
check(two.body?.result?.status?.state === "TASK_STATE_COMPLETED" && parts.some((p) => p.url?.startsWith("https://example.com/")) && /Input file: 200-[0-9a-f]{12}/.test(parts[0]?.text ?? ""), "read 2 is COMPLETED, with a note naming the download and one URL artifact");
check((await read(2, "made-up")).body?.error?.code === -32001, "a task it didn't make: TaskNotFound");

// ---- a change request ----
const own = task.id.split(".").at(-1);
const change = await call(send({ ...offer("Changes, please."), referenceTaskIds: [task.id], contextId: task.contextId }, "att_2"));
const changed = change.body?.result?.task;
check(changed?.id?.startsWith("rt.c.") && changed.contextId === task.contextId, "a change request becomes a new task in the referenced task's context", changed?.id);
const after = await call({ jsonrpc: "2.0", id: "att_2:2", method: "GetTask", params: { id: changed.id } });
check(after.body?.result?.artifacts?.[0]?.parts?.[0]?.text?.includes(`Changes for remote task: ${own}.`), "and its completion names the task it changes");

// ---- cancel, Spike C paths, other methods ----
const canceled = await call({ jsonrpc: "2.0", id: "att_1:cancel", method: "CancelTask", params: { id: task.id } });
check(canceled.body?.result?.status?.state === "TASK_STATE_CANCELED", "CancelTask answers CANCELED");
check((await call({ jsonrpc: "2.0", id: 1, method: "ListTasks" })).body?.error?.code === -32601, "another method: method not found");
const redirect = await call(plain, { path: "/a2a/redirect" });
check(redirect.status === 302, "/a2a/redirect answers 302 once the request checks out");
check((await call(plain, { path: "/a2a/redirect", auth: null })).status === 401, "and 401 before that");
const started = Date.now();
check((await call(plain, { path: "/a2a/slow", auth: null })).status === 401 && Date.now() - started < 1000, "/a2a/slow refuses an unsigned request at once");

console.log(`\n${failed === 0 ? "selftest passed" : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
