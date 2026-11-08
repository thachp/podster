import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentCard } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { A2A_METHODS, MAX_A2A_BODY_BYTES } from "../src/a2a/profile";

const BASE = "https://gateway.test";
const PROFILE = (env as unknown as { TEST_A2A_PROFILE: string }).TEST_A2A_PROFILE;

let seq = 0;
async function rpc(method: string, params: unknown = {}, headers: Record<string, string> = { "content-type": "application/json", "A2A-Version": "1.0" }) {
  const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json<any>() : null };
}
const reason = (body: any) => body?.error?.data?.[0]?.reason ?? body?.error?.message;

/** The profile's operations table: `| \`Method\` | status | ...`. */
function profileTable(): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of PROFILE.split("\n")) {
    const m = /^\| `([A-Za-z]+)` \| (not_yet|off|available) \|/.exec(line);
    if (m) rows[m[1]] = m[2];
  }
  return rows;
}

describe("the Agent Card", () => {
  it("is public, and declares one JSON-RPC 1.0 interface with streaming, push and the extended card off", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    const card = await res.json<any>();
    expect(card.supportedInterfaces).toEqual([{ url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] });
    expect(card.skills).toEqual([]);
    expect(card.description).toMatch(/preview/i);
    // It describes Podster only: no room, task or agent IDs.
    expect(JSON.stringify(card)).not.toMatch(/\b(ws|tsk|agt|org|per)_/);
  });

  it("refuses anything but GET and HEAD", async () => {
    expect((await SELF.fetch(`${BASE}/.well-known/agent-card.json`, { method: "POST" })).status).toBe(405);
  });
});

describe("the card and the profile agree", () => {
  it("lists exactly the profile's operations, with the same status", () => {
    expect(profileTable()).toEqual(A2A_METHODS);
  });

  it("turns a capability on only when the profile turns its operations on", async () => {
    const card = await (await SELF.fetch(`${BASE}/.well-known/agent-card.json`)).json<any>();
    const table = profileTable();
    const on = (...methods: string[]) => methods.some((m) => table[m] !== "off");
    expect(card.capabilities.streaming).toBe(on("SendStreamingMessage", "SubscribeToTask"));
    expect(card.capabilities.pushNotifications).toBe(on("CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"));
    expect(card.capabilities.extendedAgentCard).toBe(on("GetExtendedAgentCard"));
  });
});

describe("every operation refuses, by name", () => {
  const expected: Record<string, RegExp> = {
    SendMessage: /UNSUPPORTED_OPERATION/,
    GetTask: /UNSUPPORTED_OPERATION/,
    ListTasks: /UNSUPPORTED_OPERATION/,
    CancelTask: /UNSUPPORTED_OPERATION/,
    SendStreamingMessage: /UNSUPPORTED_OPERATION/,
    SubscribeToTask: /UNSUPPORTED_OPERATION/,
    CreateTaskPushNotificationConfig: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    GetTaskPushNotificationConfig: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    ListTaskPushNotificationConfigs: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    DeleteTaskPushNotificationConfig: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    GetExtendedAgentCard: /EXTENDED_AGENT_CARD_NOT_CONFIGURED/,
  };
  const params: Record<string, unknown> = {
    SendMessage: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }], taskId: "tsk_x" } },
    SendStreamingMessage: { message: { messageId: "m2", role: "ROLE_USER", parts: [{ text: "hi" }] } },
    GetTask: { id: "tsk_x" },
    CancelTask: { id: "tsk_x" },
    SubscribeToTask: { id: "tsk_x" },
    CreateTaskPushNotificationConfig: { taskId: "tsk_x", url: "https://example.com/hook" },
    GetTaskPushNotificationConfig: { taskId: "tsk_x", id: "c1" },
    ListTaskPushNotificationConfigs: { taskId: "tsk_x" },
    DeleteTaskPushNotificationConfig: { taskId: "tsk_x", id: "c1" },
  };

  it("covers every operation in the profile", () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(A2A_METHODS).sort());
  });

  for (const [method, error] of Object.entries(expected)) {
    it(`${method} answers its named error`, async () => {
      const { status, body } = await rpc(method, params[method] ?? {});
      expect(status).toBe(200);
      expect(body.result).toBeUndefined();
      expect(reason(body)).toMatch(error);
    });
  }

  it("answers a task that exists nowhere exactly as any other, so nothing is revealed", async () => {
    const a = await rpc("GetTask", { id: "tsk_x" });
    const b = await rpc("GetTask", { id: "tsk_" + "y".repeat(40) });
    expect({ ...a.body, id: 0 }).toEqual({ ...b.body, id: 0 });
  });
});

describe("before the handler", () => {
  it("reads no version header as 0.3 and refuses it, and refuses 0.3 and 2.0", async () => {
    for (const version of [undefined, "0.3", "2.0"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (version) headers["A2A-Version"] = version;
      const { body } = await rpc("GetTask", { id: "tsk_x" }, headers);
      expect(reason(body)).toMatch(/VERSION_NOT_SUPPORTED/);
    }
  });

  it("refuses another content type, a body over 64 KB, and anything but POST", async () => {
    expect((await rpc("GetTask", {}, { "content-type": "text/plain", "A2A-Version": "1.0" })).status).toBe(415);
    const big = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0" }, body: "x".repeat(MAX_A2A_BODY_BYTES + 1) });
    expect(big.status).toBe(413);
    expect((await SELF.fetch(`${BASE}/a2a`)).status).toBe(405);
  });

  it("answers malformed JSON and an unknown method as JSON-RPC errors", async () => {
    const bad = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0" }, body: "{not json" });
    expect((await bad.json<any>()).error).toBeDefined();
    const { body } = await rpc("tasks/get", { id: "tsk_x" });
    expect(body.error).toBeDefined();
    expect(body.result).toBeUndefined();
  });

  it("leaves paths under /a2a alone", async () => {
    const res = await SELF.fetch(`${BASE}/a2a/other`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).not.toBe(200);
  });
});

describe("the A2A project's own client", () => {
  it("reads the card and gets the named errors, unpatched", async () => {
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => SELF.fetch(input instanceof Request ? input : String(input), init)) as typeof fetch;
    const client = await new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromAgentCard(
      AgentCard.fromJSON(await (await SELF.fetch(`${BASE}/.well-known/agent-card.json`)).json()),
    );
    await expect(client.getTask({ id: "tsk_x" } as never)).rejects.toThrow(/available yet/);
  });
});
