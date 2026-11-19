// M7 step 15 (R-17), Runner's half: the A2A project's own JavaScript client, @a2a-js/sdk pinned at 1.3.0 (A2A 1.0), sends
// a nudge to Runner's real loopback listener and must accept what Runner answers. Neither the client nor anything it
// sends comes from Runner or Podster: the request is the SDK's own serialization of the message Podster's `nudge_body`
// writes, parsed by the SDK first. Only the signature is added, by a fetch wrapper made with node:crypto, as the owner's
// proxy would pass Podster's through. ADR 0007, "Nudge interoperability (M7 step 15)", says what this does and doesn't show.
import { createHmac } from "node:crypto";
import { AgentCard, Role, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { afterEach, describe, expect, it } from "vitest";
import { NudgeBell, NudgeEndpoint, RATE_BURST, type NudgeRegistration } from "../src/core/nudge.js";
import { systemClock } from "../src/core/runtime.js";
import { startNudgeListener, type NudgeListener } from "../src/node/nudge-listener.js";

const AGENT = "agt_interop_runner";
const SECRET = `a2asec_${"7".repeat(48)}`;
const PATH = "/podster/nudge";
const REG: NudgeRegistration = { url: `https://runner.example.com${PATH}`, agent_id: AGENT, version: 1, secret: SECRET };
const ROOM = "ws_interop_room";

/** The `params` of the API's `nudge_body`, byte for byte as Podster writes them. */
const podsterParams = (attempt: string, data: Record<string, unknown> = {}) => ({
  message: {
    messageId: attempt,
    role: "ROLE_USER",
    parts: [{ data: { kind: "podster.dev/nudge", workspace_id: ROOM, task_id: "tsk_interop", attempt_id: attempt, attempt_kind: "offer", ...data }, mediaType: "application/json" }],
    metadata: { "podster.dev/task": `${ROOM}:tsk_interop`, "podster.dev/attempt": attempt, "podster.dev/delivery": "nudge" },
  },
  configuration: { returnImmediately: true },
});

type Sent = { headers: Headers; body: string };
const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

const open: { listener: NudgeListener; stop: AbortController }[] = [];
afterEach(async () => {
  for (const { stop, listener } of open.splice(0)) {
    stop.abort();
    await listener.closed;
  }
});

/**
 * Runner's real endpoint on a real loopback listener, and an SDK client for it. The client is made from a card written
 * here, as A2A's direct configuration: Runner serves no card, and Podster is configured by the registration.
 * `rewrite` changes the signed request as a test needs: its headers, or a signature under another secret.
 */
async function setup(opts: { secret?: string; version?: string | null; signedAt?: (now: number) => number } = {}) {
  let rings = 0;
  const bell = new NudgeBell();
  const ring = bell.ring.bind(bell);
  bell.ring = () => {
    rings++;
    ring();
  };
  const lines: string[] = [];
  const endpoint = new NudgeEndpoint({ registration: () => REG, path: PATH, clock: systemClock, log: (at, outcome, fields) => void lines.push(JSON.stringify({ at, outcome, ...fields })), bell });
  const stop = new AbortController();
  const listener = await startNudgeListener({ port: 0, endpoint, signal: stop.signal });
  open.push({ listener, stop });
  const base = `http://127.0.0.1:${listener.port}`;
  const sent: Sent[] = [];
  const signing: typeof fetch = async (input, init) => {
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    const t = (opts.signedAt ?? ((now) => now))(Math.floor(Date.now() / 1000));
    headers.set("x-podster-signature", sign(opts.secret ?? SECRET, t, body));
    if (opts.version === null) headers.delete("a2a-version");
    else if (opts.version !== undefined) headers.set("a2a-version", opts.version);
    sent.push({ headers, body });
    return fetch(input, { ...init, headers });
  };
  const card = AgentCard.fromJSON({
    name: "Runner nudge endpoint (direct configuration)",
    description: "Runner's listener, as the owner registered it. Runner serves no card.",
    version: "0.0.1",
    supportedInterfaces: [{ url: `${base}${PATH}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  });
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { transports: [new JsonRpcTransportFactory({ fetchImpl: signing })], preferredTransports: ["JSONRPC"] }));
  const client = await factory.createFromAgentCard(card);
  return { client, base, sent, lines, rings: () => rings };
}

/** Podster's nudge, as the SDK reads it: a typed 1.0 `SendMessageRequest`, which the client then writes out itself. */
const nudge = (attempt: string, data: Record<string, unknown> = {}) => SendMessageRequest.fromJSON(podsterParams(attempt, data));
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { envelopeCode?: number };
  }
  throw new Error("expected the client to fail");
};

describe("a conforming A2A 1.0 client delivering a nudge to Runner's listener", () => {
  it("reads Podster's nudge as a valid 1.0 SendMessage: one data part, the IDs and the metadata", () => {
    const parsed = nudge("att_interop_parse");
    expect(parsed.message?.role).toBe(Role.ROLE_USER);
    expect(parsed.message?.messageId).toBe("att_interop_parse");
    expect(parsed.message?.parts).toHaveLength(1);
    expect(parsed.message?.parts[0].content).toEqual({ $case: "data", value: { kind: "podster.dev/nudge", workspace_id: ROOM, task_id: "tsk_interop", attempt_id: "att_interop_parse", attempt_kind: "offer" } });
    expect(parsed.message?.parts[0].mediaType).toBe("application/json");
    expect(parsed.message?.metadata).toEqual({ "podster.dev/task": `${ROOM}:tsk_interop`, "podster.dev/attempt": "att_interop_parse", "podster.dev/delivery": "nudge" });
    expect(parsed.configuration?.returnImmediately).toBe(true);
  });

  it("is taken: the client accepts Runner's answer as a 1.0 agent Message, and the bell rings once", async () => {
    const h = await setup();
    const answer = await h.client.sendMessage(nudge("att_interop_one"));
    expect("messageId" in answer).toBe(true);
    const message = answer as { messageId: string; role: Role; parts: { content?: { $case: string; value: unknown } }[] };
    expect(message.role).toBe(Role.ROLE_AGENT);
    expect(message.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(message.parts.map((p) => p.content?.$case)).toEqual(["text"]);
    expect(h.rings()).toBe(1);
    // What went over the wire was the SDK's, with its own JSON-RPC id and its 1.0 version header.
    const [sent] = h.sent;
    expect(sent.headers.get("a2a-version")).toBe("1.0");
    expect(sent.headers.get("content-type")).toMatch(/^application\/json/);
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({ jsonrpc: "2.0", method: "SendMessage", id: expect.any(Number) });
    expect(body.params.message.parts[0].data).toEqual({ kind: "podster.dev/nudge", workspace_id: ROOM, task_id: "tsk_interop", attempt_id: "att_interop_one", attempt_kind: "offer" });
    expect(h.lines.map((l) => JSON.parse(l).outcome)).toEqual(["nudged"]);
  });

  it("is answered again for a retried attempt, which the client also accepts, and rings nothing more", async () => {
    const h = await setup();
    await h.client.sendMessage(nudge("att_interop_retry"));
    const again = await h.client.sendMessage(nudge("att_interop_retry"));
    expect((again as { role: Role }).role).toBe(Role.ROLE_AGENT);
    expect(h.rings()).toBe(1);
    expect(h.lines.map((l) => JSON.parse(l).outcome)).toEqual(["nudged", "duplicate"]);
  });

  it("serves no Agent Card: the client can't discover the endpoint, and needn't to deliver", async () => {
    const h = await setup();
    const fromUrl = new ClientFactory().createFromUrl(h.base);
    await expect(fromUrl).rejects.toThrow();
    expect(h.rings()).toBe(0);
  });
});

describe("Runner's error answers, as a conforming client reads them", () => {
  it("refuses a request whose signature is under another secret or too old at the HTTP layer, with 401, which the client raises", async () => {
    for (const opts of [{ secret: `a2asec_${"8".repeat(48)}` }, { signedAt: (now: number) => now - 3600 }]) {
      const h = await setup(opts);
      const error = await failure(h.client.sendMessage(nudge("att_interop_forged")));
      expect(error.message).toMatch(/HTTP error for SendMessage! Status: 401/);
      expect(h.rings()).toBe(0);
    }
  });

  it("answers anything but a Podster nudge with JSON-RPC invalid params (-32602), which the client maps to its own error", async () => {
    const h = await setup();
    const text = SendMessageRequest.fromJSON({ message: { messageId: "att_interop_text", role: "ROLE_USER", parts: [{ text: "Please run this." }] } });
    for (const request of [text, nudge("att_interop_kind", { kind: "podster.dev/other" }), nudge("att_interop_extra", { title: "Leak" })]) {
      const error = await failure(h.client.sendMessage(request));
      expect([error.name, error.envelopeCode]).toEqual(["RequestMalformedError", -32602]);
    }
    expect(h.rings()).toBe(0);
  });

  it("answers an A2A method it doesn't take with method not found (-32601)", async () => {
    const h = await setup();
    const error = await failure(h.client.getTask({ tenant: "", id: "tsk_interop" }));
    expect([error.name, error.envelopeCode]).toEqual(["RequestMalformedError", -32601]);
    expect(h.rings()).toBe(0);
  });

  it("answers a request for another A2A version, or none (read as 0.3), with VersionNotSupportedError (-32009), and serves a 1.0 patch", async () => {
    for (const version of ["0.3", null, "1.1", "2.0"]) {
      const h = await setup({ version });
      const error = await failure(h.client.sendMessage(nudge(`att_interop_v${String(version).replace(".", "")}`)));
      expect([version, error.name, error.envelopeCode]).toEqual([version, "VersionNotSupportedError", -32009]);
      expect(h.rings()).toBe(0);
    }
    const patch = await setup({ version: "1.0.3" });
    expect(((await patch.client.sendMessage(nudge("att_interop_patch"))) as { role: Role }).role).toBe(Role.ROLE_AGENT);
    expect(patch.rings()).toBe(1);
  });

  it("refuses past its rate at the HTTP layer, with 429, before reading the body", async () => {
    const h = await setup();
    for (let n = 0; n < RATE_BURST; n++) await h.client.sendMessage(nudge(`att_interop_rate_${n}`));
    const error = await failure(h.client.sendMessage(nudge("att_interop_rate_over")));
    expect(error.message).toMatch(/Status: 429/);
    expect(h.rings()).toBe(RATE_BURST);
  });
});
