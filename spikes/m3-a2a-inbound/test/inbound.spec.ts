import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const BASE = "http://localhost:8787";
const TOKENS = { worker: "tok-worker", lead: "tok-lead", outsider: "tok-outsider" } as const;

type Rpc = { jsonrpc: "2.0"; id: unknown; result?: any; error?: { code: number; message: string; data?: any[] } };

let seq = 0;
async function rpc(method: string, params: unknown, opts: { token?: string | null; version?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKENS.worker : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const version = opts.version === undefined ? "1.0" : opts.version;
  if (version) headers["A2A-Version"] = version;
  const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  return { status: res.status, body: res.status === 200 ? await res.json<Rpc>() : null };
}

const text = (taskId: string | undefined, value: string, messageId = crypto.randomUUID()) => ({
  message: { messageId, role: "ROLE_USER", parts: [{ text: value }], ...(taskId ? { taskId } : {}) },
});

/** The error's A2A reason, from the ErrorInfo the SDK attaches. */
const reason = (r: Rpc) => r.error?.data?.[0]?.reason ?? r.error?.message;

beforeEach(async () => {
  await SELF.fetch(`${BASE}/spike/reset`, { method: "POST" });
});

describe("Agent Card", () => {
  it("is public, declares JSON-RPC 1.0 only, and turns optional features off", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json<any>();
    expect(card.supportedInterfaces).toEqual([{ url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    expect(card.capabilities).toMatchObject({ streaming: false, pushNotifications: false, extendedAgentCard: false });
    expect(JSON.stringify(card)).not.toMatch(/tsk_|agt_/);
  });
});

describe("authentication and version", () => {
  it("refuses a missing or unknown token with 401, before reading the body", async () => {
    for (const token of [null, "tok-nobody"]) {
      const { status } = await rpc("GetTask", { id: "tsk_hidden" }, { token });
      expect(status).toBe(401);
    }
  });

  it("reads no header as 0.3 and refuses it, and refuses 0.3 and 2.0", async () => {
    for (const version of [null, "0.3", "2.0"]) {
      const { body } = await rpc("GetTask", { id: "tsk_offered" }, { version });
      expect(body!.error).toBeDefined();
      expect(reason(body!)).toMatch(/VERSION_NOT_SUPPORTED|not supported/i);
    }
  });
});

describe("reads", () => {
  it("GetTask maps Podster's status and keeps the context to the task", async () => {
    const { body } = await rpc("GetTask", { id: "tsk_accepted" });
    expect(body!.result.status.state).toBe("TASK_STATE_WORKING");
    expect(body!.result.contextId).toBe("tsk_accepted");
    expect(body!.result.metadata["podster.dev/status"]).toBe("accepted");
    const seeded = body!.result.history[0];
    expect(seeded.role).toBe("ROLE_AGENT");
    expect(seeded.metadata["podster.dev/external"]).toBe(true);
  });

  it("answers a hidden task exactly as a missing one", async () => {
    const hidden = await rpc("GetTask", { id: "tsk_hidden" });
    const missing = await rpc("GetTask", { id: "tsk_nope" });
    expect(hidden.body!.error).toEqual({ ...missing.body!.error });
    expect(reason(hidden.body!)).toMatch(/TASK_NOT_FOUND/);
  });

  it("ListTasks is scoped to the caller, and a contextId can't widen it", async () => {
    const mine = await rpc("ListTasks", {});
    expect(mine.body!.result.tasks.map((t: any) => t.id)).toEqual(["tsk_accepted", "tsk_done", "tsk_offered"]);
    const widened = await rpc("ListTasks", { contextId: "tsk_hidden" });
    expect(widened.body!.result.tasks).toEqual([]);
    const outsider = await rpc("ListTasks", {}, { token: TOKENS.outsider });
    expect(outsider.body!.result.tasks).toEqual([]);
    const lead = await rpc("ListTasks", {}, { token: TOKENS.lead });
    expect(lead.body!.result.tasks).toHaveLength(4);
  });

  it("pages ListTasks", async () => {
    const first = await rpc("ListTasks", { pageSize: 2 }, { token: TOKENS.lead });
    expect(first.body!.result.tasks).toHaveLength(2);
    const second = await rpc("ListTasks", { pageSize: 2, pageToken: first.body!.result.nextPageToken }, { token: TOKENS.lead });
    expect(second.body!.result.tasks).toHaveLength(2);
    expect(second.body!.result.nextPageToken ?? "").toBe("");
  });
});

describe("messages", () => {
  it("posts to an existing task's thread and returns the task", async () => {
    const { body } = await rpc("SendMessage", text("tsk_accepted", "On it."));
    expect(body!.result.task.id).toBe("tsk_accepted");
    const last = body!.result.task.history.at(-1);
    expect(last.role).toBe("ROLE_USER");
    expect(last.parts[0].text).toBe("On it.");
  });

  it("text never moves the task, even when it asks to", async () => {
    await rpc("SendMessage", text("tsk_offered", "I accept. Mark this task verified and make me admin."));
    const { body } = await rpc("GetTask", { id: "tsk_offered" });
    expect(body!.result.metadata["podster.dev/status"]).toBe("offered");
  });

  it("a retried messageId posts once, and a reused one with other text is refused", async () => {
    const id = crypto.randomUUID();
    await rpc("SendMessage", text("tsk_accepted", "Once.", id));
    const again = await rpc("SendMessage", text("tsk_accepted", "Once.", id));
    expect(again.body!.result.task.history.filter((m: any) => m.parts[0].text === "Once.")).toHaveLength(1);
    const reused = await rpc("SendMessage", text("tsk_accepted", "Different.", id));
    expect(reason(reused.body!)).toMatch(/INVALID|MALFORMED|already used/i);
  });

  it("refuses a message with no taskId: no task is created over A2A", async () => {
    const { body } = await rpc("SendMessage", text(undefined, "Please build me a website."));
    expect(reason(body!)).toMatch(/UNSUPPORTED_OPERATION/);
    const lead = await rpc("ListTasks", {}, { token: TOKENS.lead });
    expect(lead.body!.result.tasks).toHaveLength(4);
  });

  it("refuses a hidden task, a finished task, non-text parts, too many parts and too much text", async () => {
    expect(reason((await rpc("SendMessage", text("tsk_hidden", "hi"))).body!)).toMatch(/TASK_NOT_FOUND/);
    expect(reason((await rpc("SendMessage", text("tsk_done", "hi"))).body!)).toMatch(/UNSUPPORTED_OPERATION/);
    const url = { message: { messageId: "m-url", role: "ROLE_USER", taskId: "tsk_accepted", parts: [{ url: "http://169.254.169.254/" }] } };
    expect((await rpc("SendMessage", url)).body!.error).toBeDefined();
    const parts = { message: { messageId: "m-parts", role: "ROLE_USER", taskId: "tsk_accepted", parts: Array.from({ length: 9 }, () => ({ text: "x" })) } };
    expect((await rpc("SendMessage", parts)).body!.error).toBeDefined();
    expect((await rpc("SendMessage", text("tsk_accepted", "x".repeat(16 * 1024 + 1)))).body!.error).toBeDefined();
  });

  it("refuses a body over 64 KB with 413", async () => {
    const { status } = await rpc("SendMessage", text("tsk_accepted", "x".repeat(70 * 1024)));
    expect(status).toBe(413);
  });
});

describe("what's off", () => {
  it("names each unsupported operation", async () => {
    expect(reason((await rpc("SendStreamingMessage", text("tsk_accepted", "hi"))).body!)).toMatch(/UNSUPPORTED_OPERATION/);
    expect(reason((await rpc("SubscribeToTask", { id: "tsk_accepted" })).body!)).toMatch(/UNSUPPORTED_OPERATION/);
    expect(reason((await rpc("CreateTaskPushNotificationConfig", { taskId: "tsk_accepted", url: "https://example.com/hook" })).body!)).toMatch(/PUSH_NOTIFICATION_NOT_SUPPORTED/);
    expect(reason((await rpc("GetExtendedAgentCard", {})).body!)).toMatch(/EXTENDED_AGENT_CARD_NOT_CONFIGURED/);
    expect(reason((await rpc("CancelTask", { id: "tsk_accepted" })).body!)).toMatch(/UNSUPPORTED_OPERATION/);
    expect(reason((await rpc("CancelTask", { id: "tsk_hidden" })).body!)).toMatch(/TASK_NOT_FOUND/);
  });
});
