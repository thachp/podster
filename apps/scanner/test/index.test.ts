import { afterEach, describe, expect, it, vi } from "vitest";
import { PER_ROOM_PER_BATCH, SURPLUS_DELAY_SECONDS } from "../src/fair";

// The real Container can't start here, and none of this needs it: every scan below finds the Container not ready, so it's retried.
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => ({ fetch: async () => new Response(JSON.stringify({ error: "starting" }), { status: 503 }) }),
}));

const { default: scanner } = await import("../src/index");

const job = (room: string, n: number) => ({ v: 1, workspace_id: room, object_id: `obj_${room}_${n}`, key: `rooms/${room}/objects/obj_${room}_${n}/a`, size: 1, sha256: "a".repeat(64), queued_at: Date.now() });

function batch(queue: string, bodies: unknown[]) {
  const seen = bodies.map(() => ({ acked: 0, retried: 0 }));
  const messages = bodies.map((body, i) => ({ id: String(i), timestamp: new Date(), body, attempts: 1, ack: () => void seen[i].acked++, retry: () => void seen[i].retried++ }));
  return { batch: { queue, messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>, seen };
}

function env(sendBatch = vi.fn(async (_: MessageSendRequest<unknown>[]) => undefined)) {
  return { env: { ASSETS: {}, API: {}, CLAMAV: {}, SCANNER_SECRET: "s", SCAN: { send: vi.fn(), sendBatch } } as never, sendBatch };
}

afterEach(() => vi.restoreAllMocks());

describe("the queue handler", () => {
  it("acks what the dead-letter queue holds, logging only IDs, and sends nothing back", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { batch: b, seen } = batch("podster-scan-dlq-staging", [job("ws_a", 0)]);
    const { env: e, sendBatch } = env();
    await scanner.queue(b, e);
    expect(seen).toEqual([{ acked: 1, retried: 0 }]);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ at: "scanner", workspace_id: "ws_a", object_id: "obj_ws_a_0", outcome: "gave_up", attempts: 1 });
  });

  it("sends a room's surplus back through the queue binding, with its delay when another room shares the batch, and every message ends once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bodies = [...Array.from({ length: PER_ROOM_PER_BATCH + 3 }, (_, i) => job("ws_a", i)), job("ws_b", 0)];
    const { batch: b, seen } = batch("podster-scan", bodies);
    const { env: e, sendBatch } = env();
    await scanner.queue(b, e);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0][0]).toEqual(bodies.slice(PER_ROOM_PER_BATCH, PER_ROOM_PER_BATCH + 3).map((body) => ({ body: { ...body, tries: 0 }, delaySeconds: SURPLUS_DELAY_SECONDS })));
    // The kept ones found the Container not ready, so they're retried. The surplus was sent back, so it's acked.
    expect(seen).toEqual([...Array(PER_ROOM_PER_BATCH).fill({ acked: 0, retried: 1 }), ...Array(3).fill({ acked: 1, retried: 0 }), { acked: 0, retried: 1 }]);
  });

  it("sends a lone room's surplus back with no delay, so an idle scanner doesn't wait on it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bodies = Array.from({ length: PER_ROOM_PER_BATCH + 2 }, (_, i) => job("ws_a", i));
    const { batch: b } = batch("podster-scan", bodies);
    const { env: e, sendBatch } = env();
    await scanner.queue(b, e);
    expect(sendBatch.mock.calls[0][0]).toEqual(bodies.slice(PER_ROOM_PER_BATCH).map((body) => ({ body: { ...body, tries: 0 } })));
  });

  it("logs its own alert when sending back fails, and retries those instead", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch: b, seen } = batch("podster-scan", Array.from({ length: PER_ROOM_PER_BATCH + 1 }, (_, i) => job("ws_a", i)));
    const { env: e } = env(vi.fn(async () => {
      throw new Error("queue unavailable");
    }));
    await scanner.queue(b, e);
    expect(error.mock.calls.map((c) => JSON.parse(c[0] as string))).toContainEqual({ at: "scanner", outcome: "requeue_failed", count: 1 });
    expect(seen.at(-1)).toEqual({ acked: 0, retried: 1 });
  });
});
