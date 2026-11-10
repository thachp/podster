import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentCard } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { A2A_METHODS, MAX_A2A_BODY_BYTES } from "../src/a2a/profile";
import { requestedVersion } from "../src/a2a";
import { A2A, connect, setUpSchemas, signUp } from "./oauth-helpers";

const BASE = "https://gateway.test";
const PROFILE = (env as unknown as { TEST_A2A_PROFILE: string }).TEST_A2A_PROFILE;

let token = "";
beforeAll(async () => {
  await setUpSchemas();
  token = (await connect(await signUp(), A2A, "a2a")).access;
});

let seq = 0;
async function rpc(method: string, params: unknown = {}, headers: Record<string, string> = { "content-type": "application/json", "A2A-Version": "1.0" }, id: unknown = ++seq) {
  const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { res, status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json<any>() : null };
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
    expect(card.capabilities).toMatchObject({ streaming: false, pushNotifications: false, extendedAgentCard: false });
    // Step 10: the lifecycle extension, declared and not required.
    expect(card.capabilities.extensions).toEqual([
      { uri: "https://podster.dev/a2a/lifecycle/v1", description: expect.any(String), required: false, params: { methods: ["podster.lifecycle.v1.AcceptTask", "podster.lifecycle.v1.DeclineTask", "podster.lifecycle.v1.ReleaseTask", "podster.lifecycle.v1.SubmitTask"] } },
    ]);
    expect(card.skills).toEqual([]);
    // Step 7: the same consent as MCP, for scope `a2a`, with PKCE.
    const scheme = card.securitySchemes.podster.oauth2SecurityScheme;
    expect(scheme.oauth2MetadataUrl).toBe(`${BASE}/.well-known/oauth-authorization-server`);
    expect(scheme.flows.authorizationCode).toMatchObject({ authorizationUrl: `${BASE}/authorize`, tokenUrl: `${BASE}/oauth/token`, scopes: { a2a: expect.any(String) }, pkceRequired: true });
    expect(card.securityRequirements).toEqual([{ schemes: { podster: { list: ["a2a"] } } }]);
    expect(card.description).toMatch(/preview/i);
    // It describes Podster only: no room, task or agent IDs.
    expect(JSON.stringify(card)).not.toMatch(/\b(ws|tsk|agt|org|per)_/);
  });

  it("has a strong ETag, and answers 304 to If-None-Match with it", async () => {
    const first = await SELF.fetch(`${BASE}/.well-known/agent-card.json`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    await first.arrayBuffer();
    const again = await SELF.fetch(`${BASE}/.well-known/agent-card.json`, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
    const other = await SELF.fetch(`${BASE}/.well-known/agent-card.json`, { headers: { "if-none-match": '"0000000000000000"' } });
    expect(other.status).toBe(200);
    await other.arrayBuffer();
    // Several tags, one of them this card's, weakened as Cloudflare may do on compression; and `*`.
    for (const header of [`"0000000000000000", W/${etag}`, "*"]) {
      const matched = await SELF.fetch(`${BASE}/.well-known/agent-card.json`, { headers: { "if-none-match": header } });
      expect(matched.status, header).toBe(304);
      await matched.arrayBuffer();
    }
  });

  it("answers HEAD with the same ETag and no body", async () => {
    const get = await SELF.fetch(`${BASE}/.well-known/agent-card.json`);
    await get.arrayBuffer();
    const head = await SELF.fetch(`${BASE}/.well-known/agent-card.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(await head.text()).toBe("");
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

describe("each operation answers as the profile says", () => {
  // The reads are step 8's, and their own spec covers them. Here, a task that exists nowhere.
  const expected: Record<string, RegExp | "result"> = {
    SendMessage: /TASK_NOT_FOUND/,
    GetTask: /TASK_NOT_FOUND/,
    ListTasks: "result",
    CancelTask: /TASK_NOT_FOUND/,
    SendStreamingMessage: /UNSUPPORTED_OPERATION/,
    SubscribeToTask: /UNSUPPORTED_OPERATION/,
    CreateTaskPushNotificationConfig: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    GetTaskPushNotificationConfig: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    ListTaskPushNotificationConfigs: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    DeleteTaskPushNotificationConfig: /PUSH_NOTIFICATION_NOT_SUPPORTED/,
    GetExtendedAgentCard: /UNSUPPORTED_OPERATION/,
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
    it(`${method} answers as expected`, async () => {
      const { status, body } = await rpc(method, params[method] ?? {});
      expect(status).toBe(200);
      if (error === "result") return expect(body.result).toBeDefined();
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

  it("serves a patch of 1.0 as 1.0, and refuses everything else as before (decision 192)", async () => {
    const asked = async (version: string) => {
      const { body } = await rpc("GetTask", { id: "tsk_" + "0".repeat(32) }, { "content-type": "application/json", "A2A-Version": version });
      return reason(body) ?? "";
    };
    // A patch never counts in negotiation (spec 3.6): each reaches the handler, which finds no such task.
    for (const version of ["1.0", "1.0.0", "1.0.1", "1.0.999"]) expect(await asked(version), version).toMatch(/TASK_NOT_FOUND/);
    // Another minor or major, half a version, an extra part, a prefix, a suffix, nothing, and an overlong value.
    for (const version of ["1.1", "2.0", "1", "1.0.", "1.0.1.1", "v1.0", "1.0-beta", "", "1.0." + "1".repeat(200), "01.0", "1.00", "1.0.01"]) {
      expect(await asked(version), JSON.stringify(version.slice(0, 20))).toMatch(/VERSION_NOT_SUPPORTED/);
    }
    // Spaces around a value aren't part of it: HTTP strips them before the gateway sees the header, as it did before.
    // A repeated header arrives as one list, "1.0, 1.0", which isn't a version.
    const headers = new Headers([["content-type", "application/json"], ["A2A-Version", "1.0"], ["A2A-Version", "1.0"], ["authorization", `Bearer ${token}`]]);
    const repeated = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "tsk_x" } }) });
    expect(reason(await repeated.json())).toMatch(/VERSION_NOT_SUPPORTED/);
  });

  it("refuses each non-version exactly as it refuses 2.0, apart from the value it names", async () => {
    // The SDK's refusal names the version asked for, so that value is replaced before the bodies are compared.
    const refusal = async (headers: Headers, asked: string) => {
      const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "tsk_x" } }) });
      const text = await res.text();
      // Only where the message quotes it, as '<value>', so nothing else in the body is touched.
      return { status: res.status, body: text.split(`'${JSON.stringify(asked).slice(1, -1)}'`).join("'<asked>'") };
    };
    const one = (version: string) => new Headers([["content-type", "application/json"], ["A2A-Version", version], ["authorization", `Bearer ${token}`]]);
    const baseline = await refusal(one("2.0"), "2.0");
    expect(baseline.status).toBe(200);
    expect(reason(JSON.parse(baseline.body))).toMatch(/VERSION_NOT_SUPPORTED/);
    for (const version of ["1.1", ".1.0", "1.0+build", "1.0-beta", "v1.0", "1.0.1.1", "1.0." + "1".repeat(200)]) {
      expect(await refusal(one(version), version), version.slice(0, 20)).toEqual(baseline);
    }
    // A repeated header, one of them 2.0, arrives as "1.0, 2.0": not a version, and refused the same way.
    const repeated = new Headers([["content-type", "application/json"], ["A2A-Version", "1.0"], ["A2A-Version", "2.0"], ["authorization", `Bearer ${token}`]]);
    expect(await refusal(repeated, "1.0, 2.0")).toEqual(baseline);
  });

  it("reads only digits as a version, and bounds them", () => {
    expect(requestedVersion(null)).toBe("0.3");
    expect(requestedVersion("1.0.42")).toBe("1.0");
    expect(requestedVersion("999.999.999999")).toBe("999.999");
    for (const raw of ["1.0.1234567", "１.０", "1.0\n", "1.*", "1.x", "1.0,1.0", "^1.0", ">=1.0", ".1.0", "1.0+build", "1.0, 2.0"]) expect(requestedVersion(raw), raw).toBe(raw);
  });

  it("refuses another content type, a body over 64 KB, and anything but POST", async () => {
    const wrongType = await rpc("GetTask", {}, { "content-type": "text/plain", "A2A-Version": "1.0" });
    expect(wrongType.status).toBe(415);
    // As a JSON-RPC error, so a JSON-RPC client reads it: ContentTypeNotSupportedError, -32005.
    expect(wrongType.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32005 } });
    const big = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0" }, body: "x".repeat(MAX_A2A_BODY_BYTES + 1) });
    expect(big.status).toBe(413);
    expect((await SELF.fetch(`${BASE}/a2a`)).status).toBe(405);
  });

  it("counts a chunked body, which declares no length, and refuses one over 64 KB", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0" }, body, duplex: "half" } as RequestInit);
    expect(res.headers.get("content-length")).not.toBe("0");
    expect(res.status).toBe(413);
  });

  it("checks the version before authentication, so a wrong version needs no token to hear so", async () => {
    const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "0.3" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "t" } }) });
    expect(reason(await res.json<any>())).toMatch(/VERSION_NOT_SUPPORTED/);
  });

  it("refuses a request with no token after those checks, with a challenge naming /a2a's metadata", async () => {
    const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "t" } }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/a2a");
  });

  it("puts A2A-Version on every answer, refusals included", async () => {
    expect((await rpc("GetTask", { id: "t" })).res.headers.get("A2A-Version")).toBe("1.0");
    expect((await rpc("GetTask", { id: "t" }, { "content-type": "application/json" })).res.headers.get("A2A-Version")).toBe("1.0");
    expect((await rpc("GetTask", {}, { "content-type": "text/plain", "A2A-Version": "1.0" })).res.headers.get("A2A-Version")).toBe("1.0");
  });

  it("echoes an id only when it's a string, a number or null", async () => {
    expect((await rpc("GetTask", { id: "t" }, undefined, "abc")).body.id).toBe("abc");
    expect((await rpc("GetTask", { id: "t" }, undefined, 7)).body.id).toBe(7);
    expect((await rpc("GetTask", { id: "t" }, undefined, { evil: true })).body.id).toBeNull();
    expect((await rpc("GetTask", { id: "t" }, { "content-type": "application/json" }, ["x"])).body.id).toBeNull();
  });

  it("answers malformed JSON and an unknown method as JSON-RPC errors", async () => {
    const bad = await SELF.fetch(`${BASE}/a2a`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "1.0" }, body: "{not json" });
    const badText = await bad.text();
    expect(bad.status, badText).toBe(200);
    expect(JSON.parse(badText).error).toBeDefined();
    const { body } = await rpc("tasks/get", { id: "tsk_x" });
    expect(body.error.code).toBe(-32601);
    expect(body.result).toBeUndefined();
  });

  it("leaves paths under /a2a alone", async () => {
    const res = await SELF.fetch(`${BASE}/a2a/other`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).not.toBe(200);
  });
});

describe("the A2A project's own client", () => {
  it("reads the card and gets the named errors, unpatched", async () => {
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return SELF.fetch(input instanceof Request ? input : String(input), { ...init, headers });
    }) as typeof fetch;
    const client = await new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromAgentCard(
      AgentCard.fromJSON(await (await SELF.fetch(`${BASE}/.well-known/agent-card.json`)).json()),
    );
    await expect(client.getTask({ id: "tsk_x" } as never)).rejects.toThrow(/not found/i);
    await expect(client.sendMessage({ message: { messageId: "m", role: 1, parts: [{ content: { $case: "text", value: "hi" } }] } } as never)).rejects.toThrow(/create tasks/);
  });
});
