// The project's JavaScript SDK client, in Node, against `npm run dev`. Unpatched: auth is only a fetch that adds a header.
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

const BASE = process.env.SUT ?? "http://localhost:8787";
const authed = (token) => (input, init = {}) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` } });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const reason = (e) => e?.constructor?.name ?? String(e);

await fetch(`${BASE}/spike/reset`, { method: "POST" });
const client = await new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory({ fetchImpl: authed("tok-worker") })] }).createFromUrl(BASE);

const task = await client.getTask({ id: "tsk_accepted" });
check("GetTask", task.id === "tsk_accepted" && task.status?.state === 2, `state ${task.status?.state}`);

const sent = await client.sendMessage({ message: { messageId: crypto.randomUUID(), role: 1, taskId: "tsk_accepted", contextId: "", parts: [{ content: { $case: "text", value: "From the JS SDK." } }], extensions: [], referenceTaskIds: [] }, configuration: { returnImmediately: true } });
const sentTask = "history" in sent ? sent : sent.task;
check("SendMessage to an existing task", sentTask?.history?.at(-1)?.parts?.[0]?.content?.value === "From the JS SDK.");

const list = await client.listTasks({ status: 0 });
check("ListTasks scoped", list.tasks.map((t) => t.id).join() === "tsk_accepted,tsk_done,tsk_offered", list.tasks.map((t) => t.id).join());

try { await client.getTask({ id: "tsk_hidden" }); check("hidden task refused", false); } catch (e) { check("hidden task refused", /TaskNotFound/.test(reason(e)), reason(e)); }
try { await client.sendMessage({ message: { messageId: crypto.randomUUID(), role: 1, parts: [{ content: { $case: "text", value: "new task?" } }] } }); check("no taskId refused", false); } catch (e) { check("no taskId refused", /UnsupportedOperation/.test(reason(e)), reason(e)); }
// The card says streaming is off, so the client is expected to fall back to SendMessage rather than open a stream.
const events = [];
for await (const e of client.sendMessageStream({ message: { messageId: crypto.randomUUID(), role: 1, taskId: "tsk_accepted", parts: [{ content: { $case: "text", value: "stream" } }] } })) events.push(e);
check("streaming off: client falls back to one SendMessage", events.length === 1 && events[0].payload?.$case === "task", `${events.length} event(s)`);

const outsider = await new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory({ fetchImpl: authed("tok-outsider") })] }).createFromUrl(BASE);
check("outsider sees nothing", (await outsider.listTasks({ status: 0 })).tasks.length === 0);
try { await client.listTasks({}); check("status left out is refused, not an empty list", false); } catch (e) { check("status left out is refused, not an empty list", /RequestMalformed/.test(reason(e)), reason(e)); }

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
