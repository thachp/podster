// M7 step 14: Runner's side of the inbound nudge. The endpoint's checks (signature and time before anything is parsed,
// replays, size, rate, kind), the verify answer, the bell that only shortens the poll loop's wait, the loopback listener
// and its shutdown, and registration and verify against the stand-in gateway, whose challenge reaches the real listener.
// Signatures and proofs here are made with node:crypto, never with Runner's own code.
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  checkNudgeUrl,
  MAX_NUDGE_BODY_BYTES,
  MAX_NUDGE_URL_BYTES,
  NUDGE_GAP_MS,
  NudgeBell,
  NudgeEndpoint,
  proofFor,
  RATE_BURST,
  SEEN_LIMIT,
  SIGNATURE_WINDOW_S,
  type NudgeRegistration,
} from "../src/core/nudge.js";
import { pair } from "../src/core/pairing.js";
import { Poller, type PollerDeps } from "../src/core/poller.js";
import { MemoryStateStore } from "../src/core/state.js";
import { MemorySecretStore, RunnerStorage } from "../src/core/storage.js";
import { logLine } from "../src/core/runtime.js";
import { alongsidePolling, openNudge, nudgeOptions } from "../src/node/nudge-command.js";
import { parseListen, startNudgeListener } from "../src/node/nudge-listener.js";
import { AGENT, CODE, FakeGateway, ORIGIN, TestClock } from "./fake-gateway.js";

const SECRET = `a2asec_${"5".repeat(48)}`;
const URL_ = "https://runner.example.com/podster/nudge";
const PATH = "/podster/nudge";
const REG: NudgeRegistration = { url: URL_, agent_id: AGENT, version: 3, secret: SECRET };
const ROOM = "ws_room_one";

const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const expectedProof = (secret: string, agent: string, version: number, challenge: string) => createHmac("sha256", secret).update(`podster-endpoint-proof/1.${agent}.${version}.${challenge}`).digest("hex");

/** A nudge exactly as the API's `nudge_body` writes it. */
function nudgeBody(attempt = "att_one", over: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: attempt,
    method: "SendMessage",
    params: {
      message: {
        messageId: attempt,
        role: "ROLE_USER",
        parts: [{ data: { kind: "podster.dev/nudge", workspace_id: ROOM, task_id: "tsk_one", attempt_id: attempt, attempt_kind: "offer", ...over }, mediaType: "application/json" }],
        metadata: { "podster.dev/task": `${ROOM}:tsk_one`, "podster.dev/attempt": attempt, "podster.dev/delivery": "nudge" },
      },
      configuration: { returnImmediately: true },
    },
  });
}
const CHALLENGE = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const verifyBody = (params: Record<string, unknown> = {}) => {
  const all = { agent_id: AGENT, version: 3, challenge: CHALLENGE, ...params };
  return JSON.stringify({ jsonrpc: "2.0", id: all.challenge, method: "podster.dev/verifyEndpoint", params: all });
};

function harness(registration: NudgeRegistration | null = REG) {
  const clock = new TestClock();
  const bell = new NudgeBell();
  let rings = 0;
  const ring = bell.ring.bind(bell);
  bell.ring = () => {
    rings++;
    ring();
  };
  const lines: string[] = [];
  const endpoint = new NudgeEndpoint({ registration: () => registration, path: PATH, clock, log: (at, outcome, fields) => void lines.push(JSON.stringify({ at, outcome, ...fields })), bell });
  const now = () => Math.floor(clock.now() / 1000);
  const post = (body: string | ReadableStream<Uint8Array>, opts: { signature?: string | null; headers?: Record<string, string>; path?: string; method?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    const signature = opts.signature === undefined ? (typeof body === "string" ? sign(SECRET, now(), body) : null) : opts.signature;
    if (signature !== null) headers["x-podster-signature"] = signature;
    return endpoint.handle(new Request(`http://127.0.0.1:9999${opts.path ?? PATH}`, { method: opts.method ?? "POST", headers, body, ...(typeof body === "string" ? {} : { duplex: "half" }) } as RequestInit));
  };
  return { clock, bell, endpoint, lines, rings: () => rings, post, now };
}

describe("the nudge endpoint", () => {
  it("answers the verify challenge with the proof, bound to the agent, the version and the challenge", async () => {
    // The server's own vector (crates/egress nudge.rs, computed with openssl).
    expect(await proofFor("a2asec_test", "agt_a", 3, CHALLENGE)).toBe("75058ca616bb34a72bd9d06c4a1d6b55203f0fdb9009db1dedb068ffd27fa543");
    const h = harness();
    const res = await h.post(verifyBody());
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { id: unknown; result: { proof: string } };
    expect(answer.id).toBe(CHALLENGE);
    expect(answer.result.proof).toBe(expectedProof(SECRET, AGENT, 3, CHALLENGE));
    // Another agent, another version or a malformed challenge gets no proof at all.
    for (const params of [{ agent_id: "agt_someone_else" }, { version: 4 }, { version: "3" }, { challenge: "AB".repeat(32) }, { challenge: "00" }]) {
      const other = h.post(verifyBody(params));
      const body = (await (await other).json()) as Record<string, unknown>;
      expect([params, body.result]).toEqual([params, undefined]);
      expect(body.error).toMatchObject({ code: -32602 });
    }
    // A second challenge's proof differs, so a proof is never reused across challenges.
    const second = "f".repeat(64);
    const again = (await (await h.post(verifyBody({ challenge: second }))).json()) as { result: { proof: string } };
    expect(again.result.proof).toBe(expectedProof(SECRET, AGENT, 3, second));
    expect(again.result.proof).not.toBe(answer.result.proof);
    // Answering a challenge rings nothing.
    expect(h.rings()).toBe(0);
  });

  it("rings the bell once for a signed nudge, and only once for the same attempt", async () => {
    const h = harness();
    const res = await h.post(nudgeBody());
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { id: unknown; result: Record<string, unknown>; error?: unknown };
    expect(answer.id).toBe("att_one");
    expect(answer.error).toBeUndefined();
    expect(answer.result).toEqual(expect.any(Object));
    expect(h.rings()).toBe(1);
    // Podster's retry of the same attempt, freshly signed, is taken and rings nothing more.
    h.clock.at += 60_000;
    const retry = await h.post(nudgeBody());
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { result?: unknown }).result).toEqual(expect.any(Object));
    expect(h.rings()).toBe(1);
    // A change request is a nudge too.
    expect((await h.post(nudgeBody("att_two", { attempt_kind: "change_request" }))).status).toBe(200);
    expect(h.rings()).toBe(2);
    // Logs carry IDs and fixed words only.
    expect(h.lines.join("\n")).not.toMatch(/runner\.example\.com|a2asec|podster\.dev\/nudge|ROLE_USER/);
    expect(h.lines.some((line) => line.includes('"outcome":"nudged"') && line.includes(ROOM) && line.includes("tsk_one"))).toBe(true);
  });

  it("refuses a forged, unsigned or stale request before parsing it, and rings nothing", async () => {
    const h = harness();
    const body = nudgeBody();
    const forged = [
      sign("a2asec_not_the_secret", h.now(), body),
      sign(SECRET, h.now(), `${body} `),
      sign(SECRET, h.now() + 1, body).replace(/^t=\d+/, `t=${h.now()}`),
      `t=${h.now()}`,
      `v1=${"0".repeat(64)}`,
      `t=${h.now()},v1=${"0".repeat(63)}`,
      "",
    ];
    for (const signature of forged) {
      const res = await h.post(body, { signature });
      expect([signature, res.status]).toEqual([signature, 401]);
    }
    expect((await h.post(body, { signature: null })).status).toBe(401);
    // Outside the window either way.
    expect((await h.post(body, { signature: sign(SECRET, h.now() - SIGNATURE_WINDOW_S - 1, body) })).status).toBe(401);
    expect((await h.post(body, { signature: sign(SECRET, h.now() + SIGNATURE_WINDOW_S + 1, body) })).status).toBe(401);
    // A body that isn't JSON at all, under a bad signature, is refused for the signature: it was never parsed.
    const res = await h.post("{not json", { signature: sign("a2asec_wrong", h.now(), "{not json") });
    expect(res.status).toBe(401);
    expect(h.rings()).toBe(0);
    expect(h.lines.every((line) => /"code":"(forged|unsigned|stale)"/.test(line))).toBe(true);
  });

  it("refuses an exact replay, and a replayed challenge", async () => {
    const h = harness();
    const body = nudgeBody();
    const signature = sign(SECRET, h.now(), body);
    expect((await h.post(body, { signature })).status).toBe(200);
    expect((await h.post(body, { signature })).status).toBe(409);
    const verify = verifyBody();
    const signed = sign(SECRET, h.now(), verify);
    expect((await h.post(verify, { signature: signed })).status).toBe(200);
    expect((await h.post(verify, { signature: signed })).status).toBe(409);
    // The same challenge freshly signed is still a replay of the challenge.
    h.clock.at += 1_000;
    const fresh = (await (await h.post(verify)).json()) as Record<string, unknown>;
    expect(fresh.result).toBeUndefined();
    expect(h.rings()).toBe(1);
  });

  it("keeps a bounded memory, and refuses rather than forgets while it's full", async () => {
    const h = harness();
    // Enough distinct attempts to fill it, spaced so the rate limit never answers.
    // Each nudge is remembered twice: by its signature and by its attempt.
    for (let i = 0; i < SEEN_LIMIT / 2; i++) {
      h.clock.at += 1_000;
      const res = await h.post(nudgeBody(`att_${i}`));
      expect([i, res.status]).toEqual([i, 200]);
    }
    h.clock.at += 1_000;
    expect((await h.post(nudgeBody("att_more"))).status).toBe(503);
    // Once the window has passed, the oldest are forgotten and the memory takes more.
    h.clock.at += 2 * SIGNATURE_WINDOW_S * 1000;
    expect((await h.post(nudgeBody("att_more"))).status).toBe(200);
  });

  it("never grows its memory past the bound for retried attempts or challenges, and answers them (review 1)", async () => {
    const h = harness();
    for (let i = 0; i < SEEN_LIMIT / 2; i++) {
      h.clock.at += 1_000;
      expect((await h.post(nudgeBody(`att_${i}`))).status).toBe(200);
    }
    expect(h.endpoint.remembered).toBe(SEEN_LIMIT);
    // Podster's retries of attempts already taken, each freshly signed: answered, nothing rung, nothing remembered.
    const rings = h.rings();
    for (let i = 0; i < 20; i++) {
      h.clock.at += 1_000;
      const res = await h.post(nudgeBody(`att_${i}`));
      expect([i, res.status]).toEqual([i, 200]);
      expect(((await res.json()) as { result?: unknown }).result).toEqual(expect.any(Object));
    }
    expect(h.endpoint.remembered).toBe(SEEN_LIMIT);
    expect(h.rings()).toBe(rings);
  });

  it("refuses a challenge for another version, and sends no proof for either (review 4)", async () => {
    const h = harness();
    for (const version of [2, 4]) {
      const res = await h.post(verifyBody({ version }));
      const text = await res.text();
      const answer = JSON.parse(text) as Record<string, unknown>;
      expect(answer.result).toBeUndefined();
      expect(answer.error).toMatchObject({ code: -32602 });
      for (const v of [2, 3, 4]) expect(text).not.toContain(expectedProof(SECRET, AGENT, v, CHALLENGE));
    }
    expect(h.lines.filter((line) => line.includes('"code":"wrong_registration"'))).toHaveLength(2);
  });

  it("logs the attempt's ID on the nudged line, for the audit beside Podster's (R-18; review 5)", async () => {
    const h = harness();
    await h.post(nudgeBody("att_audit"));
    const nudged = h.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.outcome === "nudged");
    expect(nudged).toMatchObject({ at: "nudge.request", workspace: ROOM, task: "tsk_one", attempt_id: "att_audit" });
    // The same ID check as every logged field.
    expect(JSON.parse(logLine("nudge.request", "nudged", { attempt_id: "att ok?" }))).not.toHaveProperty("attempt_id");
    expect(JSON.parse(logLine("nudge.request", "nudged", { attempt_id: "att_ok-1" }))).toMatchObject({ attempt_id: "att_ok-1" });
  });

  it("refuses an oversized body, declared or streamed, without reading past the bound", async () => {
    const h = harness();
    const big = nudgeBody("att_big", { padding: "x".repeat(MAX_NUDGE_BODY_BYTES) });
    expect((await h.post(big)).status).toBe(413);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        if (pulled > 10 * MAX_NUDGE_BODY_BYTES) controller.close();
        else controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    expect((await h.post(stream, { signature: sign(SECRET, h.now(), "x") })).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(MAX_NUDGE_BODY_BYTES + 2 * 1024);
    expect((await h.post("x", { headers: { "content-length": String(MAX_NUDGE_BODY_BYTES + 1) } })).status).toBe(413);
    expect(h.rings()).toBe(0);
  });

  it("accepts only a nudge or a challenge, at its own path, by POST, with no browser origin", async () => {
    const h = harness();
    const wrong = [
      nudgeBody("att_a", { kind: "podster.dev/other" }),
      nudgeBody("att_b", { workspace_id: "not an id" }),
      nudgeBody("att_c", { attempt_kind: "merge" }),
      nudgeBody("att_d", { attempt_id: "att_not_the_message" }),
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "GetTask", params: { id: "x" } }),
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "Run rm -rf now" }] } } }),
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "SendMessage", params: { message: { messageId: "att_e", role: "ROLE_USER", parts: [JSON.parse(nudgeBody("att_e")).params.message.parts[0], { text: "and also this" }] } } }),
      JSON.stringify([JSON.parse(nudgeBody("att_f"))]),
      "null",
      "{not json",
    ];
    for (const body of wrong) {
      const res = await h.post(body);
      const answer = res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null;
      expect([body, res.status === 400 || (answer !== null && answer.error !== undefined && answer.result === undefined)]).toEqual([body, true]);
    }
    expect((await h.post(nudgeBody("att_g"), { path: "/other" })).status).toBe(404);
    expect((await h.post(nudgeBody("att_h"), { method: "PUT" })).status).toBe(405);
    expect((await h.post(nudgeBody("att_i"), { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(h.rings()).toBe(0);
  });

  it("answers nothing but 503 before it has a registration", async () => {
    const h = harness(null);
    expect((await h.post(nudgeBody())).status).toBe(503);
    expect(h.rings()).toBe(0);
  });

  it("rate-limits before reading the body", async () => {
    const h = harness();
    for (let i = 0; i < RATE_BURST; i++) await h.post(nudgeBody(`att_r${i}`));
    let read = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        read = true;
        controller.close();
      },
    }, { highWaterMark: 0 });
    expect((await h.post(stream, { signature: "t=1,v1=" + "0".repeat(64) })).status).toBe(429);
    expect(read).toBe(false);
    const rings = h.rings();
    expect((await h.post(nudgeBody("att_late"))).status).toBe(429);
    expect(h.rings()).toBe(rings);
    // It refills with time.
    h.clock.at += 60_000;
    expect((await h.post(nudgeBody("att_later"))).status).toBe(200);
  });

  it("checks the public URL it registers: HTTPS, a DNS name, the default port, no credentials, query or fragment", () => {
    expect(checkNudgeUrl("https://runner.example.com/podster/nudge")).toBe("https://runner.example.com/podster/nudge");
    expect(checkNudgeUrl("https://runner.example.com")).toBe("https://runner.example.com/");
    for (const bad of ["http://runner.example.com/", "https://127.0.0.1/", "https://[::1]/", "https://user:pw@runner.example.com/", "https://runner.example.com:8443/", "https://runner.example.com/?a=1", "https://runner.example.com/#x", "https://localhost/", "not a url", `https://runner.example.com/${"a".repeat(MAX_NUDGE_URL_BYTES)}`]) {
      expect([bad, checkNudgeUrl(bad)]).toEqual([bad, null]);
    }
  });

  it("depends on nothing that runs, accepts or fetches: a request can only ring the bell", async () => {
    const text = await readFile(new URL("../src/core/nudge.ts", import.meta.url), "utf8");
    const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./runtime.js", "./state.js", "./storage.js"].sort());
  });
});

describe("the bell", () => {
  it("shortens only a wait after a good poll, never below the gap, and is used once", async () => {
    const clock = new TestClock();
    const bell = new NudgeBell();
    const stop = new AbortController();
    // Rung while a poll ran: the next wait ends at the gap.
    bell.ring();
    await bell.idle(clock, 30_000, stop.signal);
    expect(clock.idles).toEqual([NUDGE_GAP_MS]);
    // Not rung: the whole interval.
    clock.idles = [];
    await bell.idle(clock, 30_000, stop.signal);
    expect(clock.idles).toEqual([NUDGE_GAP_MS, 30_000 - NUDGE_GAP_MS]);
  });

  it("still waits the whole gap when rung partway into it (review 3)", async () => {
    // A clock that moves in 1 s steps, so a ring can land about 1 s into the gap.
    const clock = new TestClock();
    const bell = new NudgeBell();
    const stop = new AbortController();
    const start = clock.now();
    let rang = false;
    const stepping = {
      now: () => clock.now(),
      idle: async (ms: number, signal?: AbortSignal) => {
        for (let left = ms; left > 0 && !signal?.aborted; left -= 1_000) {
          await clock.idle(Math.min(1_000, left), signal);
          if (!rang && clock.now() - start >= 1_000) {
            rang = true;
            bell.ring();
          }
        }
      },
    };
    await bell.idle(stepping, 30_000, stop.signal);
    expect(rang).toBe(true);
    expect(clock.now() - start).toBeGreaterThanOrEqual(NUDGE_GAP_MS);
    expect(clock.now() - start).toBe(NUDGE_GAP_MS);
  });

  it("ends a wait early when rung during it, with a real clock", async () => {
    const { systemClock } = await import("../src/core/runtime.js");
    const bell = new NudgeBell(10);
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => bell.ring(), 50);
    await bell.idle(systemClock, 60_000, stop.signal);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/** A paired Runner against the stand-in gateway, as poller.test.ts makes one. */
async function paired() {
  const clock = new TestClock();
  const gateway = new FakeGateway(clock);
  const secrets = new MemorySecretStore();
  const state = new MemoryStateStore();
  const logged: string[] = [];
  const log: PollerDeps["log"] = (at, outcome, fields) => void logged.push(JSON.stringify({ at, outcome, ...fields }));
  clock.onIdle = () => {
    if (gateway.session === "redeemed") gateway.session = "confirmed";
  };
  expect((await pair({ origin: ORIGIN, fetch: gateway.fetch, secrets, state, clock, log, consent: async () => true, notify: () => undefined }, { agentId: AGENT, code: CODE })).outcome).toBe("connected");
  clock.onIdle = null;
  gateway.calls = [];
  const deps: PollerDeps = { origin: ORIGIN, fetch: gateway.fetch, secrets, state, clock, log, intervalMs: 30_000, graceMs: 600_000 };
  return { clock, gateway, secrets, state, logged, deps };
}

describe("a nudge in the poll loop", () => {
  it("only brings the next ordinary poll forward: the same calls, and nothing from the nudge's IDs", async () => {
    const { clock, gateway, deps, state } = await paired();
    gateway.workspaces = [ROOM];
    const poller = await Poller.open(deps);
    const bell = new NudgeBell();
    const stop = new AbortController();
    let polls = 0;
    gateway.onCall = (capability) => {
      if (capability === "read_inbox") polls++;
    };
    clock.idles = [];
    clock.onIdle = async () => {
      if (polls === 1 && clock.idles.length === 1) {
        // While Runner waits after its first poll, a nudge naming a task the inbox doesn't hold yet.
        gateway.offer(ROOM, "tsk_one");
        const body = nudgeBody("att_x", { task_id: "tsk_not_offered" });
        await new NudgeEndpoint({ registration: () => REG, path: PATH, clock, log: () => undefined, bell }).handle(new Request(`http://127.0.0.1${PATH}`, { method: "POST", headers: { "x-podster-signature": sign(SECRET, Math.floor(clock.now() / 1000), body) }, body }));
      }
      if (polls >= 2) stop.abort();
    };
    expect(await poller.run(stop.signal, bell)).toBe("stopped");
    // The second poll came after the gap, not the interval.
    expect(clock.idles.slice(0, 2)).toEqual([NUDGE_GAP_MS, NUDGE_GAP_MS]);
    expect(gateway.calls.map((c) => c.capability)).toEqual(["get_identity", "list_workspaces", "list_tasks", "read_inbox", "read_inbox", "ack_inbox"]);
    const record = await state.load();
    expect(Object.keys(record.offers)).toEqual([`${ROOM}/tsk_one`]);
    expect(JSON.stringify(record)).not.toContain("tsk_not_offered");
  });

  it("loses no work when a nudge is missed, refused or forged: the timed poll finds the offer (R-03, R-16)", async () => {
    const { clock, gateway, deps, state } = await paired();
    const poller = await Poller.open(deps);
    const bell = new NudgeBell();
    const stop = new AbortController();
    let polls = 0;
    let offered = false;
    gateway.onCall = (capability) => {
      if (capability === "read_inbox") polls++;
    };
    clock.idles = [];
    clock.onIdle = async () => {
      if (polls === 1 && !offered) {
        offered = true;
        gateway.offer(ROOM, "tsk_missed");
        // A forged nudge for it, which is refused; the real one never arrives.
        const body = nudgeBody("att_m", { task_id: "tsk_missed" });
        const res = await new NudgeEndpoint({ registration: () => REG, path: PATH, clock, log: () => undefined, bell }).handle(new Request(`http://127.0.0.1${PATH}`, { method: "POST", headers: { "x-podster-signature": sign("a2asec_forger", Math.floor(clock.now() / 1000), body) }, body }));
        expect(res.status).toBe(401);
      }
      if (polls >= 2) stop.abort();
    };
    await poller.run(stop.signal, bell);
    // The full interval, then the ordinary poll that found it.
    expect(clock.idles.slice(0, 2)).toEqual([NUDGE_GAP_MS, 30_000 - NUDGE_GAP_MS]);
    expect(Object.keys((await state.load()).offers)).toEqual([`${ROOM}/tsk_missed`]);
  });

  it("never shortens a wait after a failed poll, so a nudge can't push past the gateway's backoff", async () => {
    const { clock, gateway, deps } = await paired();
    const poller = await Poller.open(deps);
    const bell = new NudgeBell();
    const stop = new AbortController();
    clock.idles = [];
    gateway.unreachable = true;
    clock.onIdle = () => {
      if (clock.idles.length >= 2) stop.abort();
      bell.ring();
    };
    bell.ring();
    await poller.run(stop.signal, bell);
    expect(clock.idles[0]).toBe(30_000);
  });
});

describe("the listener", () => {
  it("survives a server error after it starts listening: logs a code and closes, and nothing reaches the process (review 2)", async () => {
    const h = harness();
    const stop = new AbortController();
    let server: Server | null = null;
    const lines: string[] = [];
    const listener = await startNudgeListener({ port: 0, endpoint: h.endpoint, signal: stop.signal, log: (at, outcome, fields) => void lines.push(JSON.stringify({ at, outcome, ...fields })), onServer: (s) => void (server = s) });
    const error = Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });
    expect(() => server!.emit("error", error)).not.toThrow();
    await listener.closed;
    expect(lines).toEqual([JSON.stringify({ at: "nudge.listen", outcome: "server_error", code: "emfile" })]);
    await expect(fetch(`http://127.0.0.1:${listener.port}${PATH}`, { method: "POST", body: "x" })).rejects.toThrow();
  });

  it("buffers no more than about the bound however much is sent, and cuts the connection (review 6)", async () => {
    // A greedy reader in place of the endpoint: it reads everything it's given, so what it gets is what was buffered.
    let received = 0;
    let errored = false;
    const greedy = {
      handle: async (request: Request) => {
        const reader = (request.body as ReadableStream<Uint8Array>).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
          }
        } catch {
          errored = true;
        }
        return new Response(null, { status: 413 });
      },
    };
    const stop = new AbortController();
    const sockets: Socket[] = [];
    const listener = await startNudgeListener({ port: 0, endpoint: greedy, signal: stop.signal, onServer: (server) => void server.on("connection", (socket: Socket) => void sockets.push(socket)) });
    const total = 1024 * 1024;
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: listener.port, path: PATH, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(`status ${res.statusCode}`));
      });
      req.on("error", () => resolve("cut"));
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += 16 * 1024;
          if (!req.write(Buffer.alloc(16 * 1024, 0x20))) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    expect(errored).toBe(true);
    expect(received).toBeLessThanOrEqual(MAX_NUDGE_BODY_BYTES + 64 * 1024);
    expect(received).toBeLessThan(total);
    expect(outcome === "cut" || outcome === "status 413").toBe(true);
    // The server's own socket for that request was destroyed once the body passed the bound (delta review 4).
    expect(sockets).toHaveLength(1);
    expect(sockets[0].destroyed).toBe(true);
    stop.abort();
    await listener.closed;
  });

  it("parses only a port or the loopback address with a port", () => {
    expect(parseListen("8787")).toEqual({ port: 8787 });
    expect(parseListen("127.0.0.1:8787")).toEqual({ port: 8787 });
    for (const bad of ["0.0.0.0:8787", "localhost:8787", "[::]:8787", "192.168.1.2:8787", "70000", "0", "", "127.0.0.1", "8787x"]) expect(() => parseListen(bad)).toThrow();
  });

  it("serves the endpoint on loopback, bounds what it reads, and closes on stop", async () => {
    const h = harness();
    const stop = new AbortController();
    const listener = await startNudgeListener({ port: 0, endpoint: h.endpoint, signal: stop.signal });
    expect(listener.port).toBeGreaterThan(0);
    const at = `http://127.0.0.1:${listener.port}${PATH}`;
    const body = nudgeBody();
    const ok = await fetch(at, { method: "POST", headers: { "content-type": "application/json", "x-podster-signature": sign(SECRET, h.now(), body) }, body });
    expect(ok.status).toBe(200);
    expect(h.rings()).toBe(1);
    const big = await fetch(at, { method: "POST", headers: { "x-podster-signature": sign(SECRET, h.now(), "x") }, body: "x".repeat(MAX_NUDGE_BODY_BYTES * 4) }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
    expect(h.rings()).toBe(1);
    stop.abort();
    await listener.closed;
    await expect(fetch(at, { method: "POST", body })).rejects.toThrow();
    // Closing again is harmless.
    await listener.close();
  });
});

describe("registration and verify, against the stand-in gateway", () => {
  async function setUp() {
    const env = await paired();
    const poller = await Poller.open(env.deps);
    const said: string[] = [];
    const stop = new AbortController();
    let port = 0;
    // The owner's proxy: Podster's HTTPS request reaches the loopback listener at the same path.
    env.gateway.deliver = (request) => {
      const url = new URL(request.url);
      return fetch(`http://127.0.0.1:${port}${url.pathname}`, { method: "POST", headers: request.headers, body: request.body, duplex: "half" } as RequestInit);
    };
    const open = (bell?: NudgeBell) =>
      openNudge({ listen: { port: 0 }, url: URL_, poller, secrets: env.secrets, clock: env.clock, log: env.deps.log, say: (line) => void said.push(line), signal: stop.signal, ...(bell ? { bell } : {}), onListening: (p) => void (port = p) });
    return { ...env, poller, said, stop, open };
  }

  it("registers a nudge endpoint, keeps its secret in the key store only, and proves control", async () => {
    const s = await setUp();
    const nudge = await s.open();
    expect(nudge).not.toBeNull();
    expect(s.gateway.endpointSets).toEqual([{ url: URL_, delivery: "nudge" }]);
    expect(s.gateway.endpoint?.control).toBe("verified");
    expect(s.gateway.challenges).toHaveLength(1);
    const secret = s.gateway.endpoint?.secret as string;
    // In the key store, as its own item, and nowhere else.
    const stored = await new RunnerStorage(s.secrets).getNudge();
    expect(stored).toEqual({ url: URL_, agent_id: AGENT, version: 1, secret });
    expect(JSON.stringify(await s.state.load())).not.toContain(secret);
    expect(s.logged.join("\n")).not.toContain(secret);
    expect(s.said.join("\n")).not.toContain(secret);
    expect(s.logged.join("\n")).not.toContain("runner.example.com");
    // The owner is told the version to switch on.
    expect(s.said.join("\n")).toMatch(/version 1/);
    // A good nudge now rings.
    const body = nudgeBody();
    const t = Math.floor(s.clock.now() / 1000);
    const answered = await s.gateway.deliver!(new Request(URL_, { method: "POST", headers: { "x-podster-signature": sign(secret, t, body) }, body }));
    expect(answered.status).toBe(200);
    await nudge!.close();
  });

  it("keeps the registration across starts: the same URL is set again without a new secret, and isn't verified again", async () => {
    const s = await setUp();
    await (await s.open())!.close();
    s.gateway.endpoint!.nudge_on = true;
    const secret = s.gateway.endpoint!.secret;
    const again = await s.open();
    expect(s.gateway.endpointSets).toEqual([{ url: URL_, delivery: "nudge" }, { url: URL_, delivery: "nudge" }]);
    expect(s.gateway.endpoint).toMatchObject({ version: 1, secret, control: "verified", nudge_on: true });
    expect(s.gateway.challenges).toHaveLength(1);
    await again!.close();
  });

  it("rotates the secret only when it holds none for Podster's registration, which needs proof again", async () => {
    const s = await setUp();
    await (await s.open())!.close();
    // The key store lost the item (or `forget` ran and Runner paired again on the same URL).
    await new RunnerStorage(s.secrets).deleteNudge();
    const old = s.gateway.endpoint!.secret;
    const again = await s.open();
    expect(s.gateway.endpointSets.at(-1)).toEqual({ url: URL_, delivery: "nudge", rotate_secret: true });
    expect(s.gateway.endpoint!.secret).not.toBe(old);
    expect((await new RunnerStorage(s.secrets).getNudge())?.secret).toBe(s.gateway.endpoint!.secret);
    expect(s.gateway.endpoint!.control).toBe("verified");
    expect(s.gateway.challenges).toHaveLength(2);
    await again!.close();
  });

  it("goes on polling when the nudge can't be set up, and says so", async () => {
    const s = await setUp();
    s.gateway.executeScript = [503];
    const nudge = await s.open();
    expect(nudge).toBeNull();
    expect(s.said.join("\n")).toMatch(/polling/i);
    // A failed proof keeps the listener but says the nudge stays off.
    const t = await setUp();
    t.gateway.deliver = async () => new Response("no", { status: 502 });
    const unproved = await t.open();
    expect(t.gateway.endpoint?.control).toBe("unverified");
    expect(t.said.join("\n")).toMatch(/couldn't prove/i);
    await unproved?.close();
  });

  it("starts polling before the nudge's setup finishes, and attaches the bell once it does (ruling, review 7)", async () => {
    const s = await setUp();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    s.gateway.onCall = async (capability) => {
      order.push(capability);
      // Registration waits until a poll has read the inbox: if polling waited for setup, this would never finish.
      if (capability === "set_a2a_endpoint") await held;
      if (capability === "read_inbox") release();
    };
    let reads = 0;
    const outcome = await alongsidePolling(
      async (bell) => {
        // The loop stops once the setup is through and one more poll has run.
        const stop = new AbortController();
        s.clock.onIdle = async () => {
          reads = order.filter((c) => c === "read_inbox").length;
          if (s.gateway.challenges.length === 1 && reads >= 2) stop.abort();
          // Lets the listener's real I/O run between polls.
          await new Promise((resolve) => setTimeout(resolve, 1));
        };
        return s.poller.run(stop.signal, bell);
      },
      (bell) => s.open(bell),
    );
    expect(outcome).toBe("stopped");
    expect(order.indexOf("read_inbox")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("read_inbox")).toBeLessThan(order.indexOf("verify_a2a_endpoint"));
    expect(s.gateway.endpoint?.control).toBe("verified");
  });

  it("on Ctrl-C while registration waits on Podster, ends the run at once and never verifies (delta review 1)", async () => {
    const s = await setUp();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    s.gateway.onCall = async (capability) => {
      asked.push(capability);
      if (capability === "set_a2a_endpoint") await held;
    };
    const ctrlC = new AbortController();
    let setup: Promise<unknown> = Promise.resolve();
    const outcome = await alongsidePolling(
      async (bell) => {
        s.clock.onIdle = async () => {
          // The owner's Ctrl-C, once a poll has run and registration is waiting on the gateway.
          if (asked.includes("set_a2a_endpoint")) ctrlC.abort();
          await new Promise((resolve) => setTimeout(resolve, 1));
        };
        return s.poller.run(ctrlC.signal, bell);
      },
      (bell, ended) => (setup = openNudge({ listen: { port: 0 }, url: URL_, poller: s.poller, secrets: s.secrets, clock: s.clock, log: s.deps.log, say: (line) => void s.said.push(line), signal: AbortSignal.any([ctrlC.signal, ended]), bell })),
    );
    // The run ended while the gateway still held the registration.
    expect(outcome).toBe("stopped");
    expect(asked.filter((c) => c === "verify_a2a_endpoint")).toEqual([]);
    release();
    expect(await setup).toBeNull();
    expect(asked).not.toContain("verify_a2a_endpoint");
    expect(s.gateway.challenges).toEqual([]);
  });

  it("goes on polling when setup fails, with one line said (review 7)", async () => {
    const said: string[] = [];
    let polled = false;
    const outcome = await alongsidePolling(
      async () => {
        polled = true;
        return "stopped" as const;
      },
      async () => {
        said.push("Runner couldn't register its nudge endpoint with Podster, so nudges are off for this run. Polling goes on as before.");
        throw new Error("setup failed");
      },
    );
    expect([outcome, polled, said.length]).toEqual(["stopped", true, 1]);
  });

  it("is off unless both options are given, and refuses a bad address or URL before anything is touched", () => {
    expect(nudgeOptions([])).toBeNull();
    expect(nudgeOptions(["--nudge-listen", "8787", "--nudge-url", URL_])).toEqual({ listen: { port: 8787 }, url: URL_ });
    expect(() => nudgeOptions(["--nudge-listen", "8787"])).toThrow(/--nudge-url/);
    expect(() => nudgeOptions(["--nudge-url", URL_])).toThrow(/--nudge-listen/);
    expect(() => nudgeOptions(["--nudge-listen", "0.0.0.0:8787", "--nudge-url", URL_])).toThrow();
    expect(() => nudgeOptions(["--nudge-listen", "8787", "--nudge-url", "http://runner.example.com/"])).toThrow();
  });

  it("is deleted with Runner's other keys by forget", async () => {
    const secrets = new MemorySecretStore();
    const storage = new RunnerStorage(secrets);
    await storage.setNudge(REG);
    expect(await storage.getNudge()).toEqual(REG);
    await storage.deleteAll();
    expect(secrets.values.size).toBe(0);
  });
});
