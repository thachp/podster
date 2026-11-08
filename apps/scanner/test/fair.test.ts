import { describe, expect, it } from "vitest";
import { BATCH_BUDGET_MS, consumeFairly, fairOrder, MAX_TRIES, PER_ROOM_PER_BATCH, resent, roomOf, SURPLUS_DELAY_SECONDS, triesOf, type Consuming, type Queued, type Resend } from "../src/fair";
import { SCAN_WINDOW_MS } from "../src/scan";
import { job, simulate } from "./sim";

const NOW = 10 * SCAN_WINDOW_MS;

function message(body: unknown, attempts = 1) {
  const seen = { acked: 0, retried: 0 };
  const queued: Queued = { body, attempts, ack: () => void seen.acked++, retry: () => void seen.retried++ };
  return { queued, seen };
}

/** The slowest whole scan seen on staging, rounded up: a 100 MB file was 16.7 s from storing to verdict. */
const SCAN_MS = 17_000;

/**
 * A consumer that records everything in order. The clock moves only when a scan runs, so nothing here depends on how often the
 * code asks the time.
 */
function recorder(over: Partial<Consuming> & { scanMs?: number } = {}) {
  let now = NOW;
  const events: string[] = [];
  const sent: Resend[] = [];
  const settled: string[] = [];
  let failed = 0;
  const consuming: Consuming = {
    now: () => now,
    handle: async (m) => {
      events.push(`scan ${(m.body as { object_id?: string })?.object_id ?? "?"}`);
      now += over.scanMs ?? SCAN_MS;
      m.ack();
    },
    settle: (m, why) => {
      settled.push(`${(m.body as { object_id: string }).object_id} ${why}`);
      m.ack();
    },
    requeue: async (messages) => {
      events.push(`requeue ${messages.length}${messages[0]?.delaySeconds ? ` after ${messages[0].delaySeconds}s` : ""}`);
      sent.push(...messages);
    },
    requeueFailed: (count) => void (failed += count),
    ...over,
  };
  return { consuming, events, sent, settled, failed: () => failed };
}

const fresh = (room: string, n: number) => job(room, n, NOW - 1000);

describe("turns between rooms", () => {
  it("takes one job per room per round, keeping each room's own order", () => {
    const items = ["a1", "a2", "a3", "b1", "a4", "c1", "b2"].map((name) => ({ name, room: name[0] }));
    expect(fairOrder(items, (item) => item.room).map((item) => item.name)).toEqual(["a1", "b1", "c1", "a2", "b2", "a3", "a4"]);
  });

  it("puts anything that isn't a job in one turn of its own, for scanOne to turn away", () => {
    expect(roomOf({ workspace_id: "ws_1" })).toBe("ws_1");
    for (const body of [null, "x", 1, {}, { workspace_id: 7 }]) expect(roomOf(body)).toBe("");
  });
});

describe("a batch", () => {
  it("sends a busy room's surplus away with a delay before scanning anything, and reaches a lone room in the first round", async () => {
    const batch = [...Array.from({ length: 99 }, (_, i) => fresh("ws_busy", i)), fresh("ws_lone", 0)].map((b) => message(b));
    const r = recorder();
    const done = await consumeFairly(batch.map((m) => m.queued), r.consuming);
    expect(r.events[0]).toBe(`requeue ${99 - PER_ROOM_PER_BATCH} after ${SURPLUS_DELAY_SECONDS}s`);
    expect(r.events.slice(1, 3)).toEqual(["scan obj_ws_busy_0", "scan obj_ws_lone_0"]);
    expect(done).toEqual({ scanned: PER_ROOM_PER_BATCH + 1, settled: 0, delayed: 99 - PER_ROOM_PER_BATCH, requeued: 0, retried: 0 });
    // Every message ends once: scanned and acked, or sent back and acked.
    expect(batch.every((m) => m.seen.acked === 1 && m.seen.retried === 0)).toBe(true);
  });

  it("settles a job already past its hour, or out of tries, without scanning it, sending it back or counting it toward a turn", async () => {
    const late = job("ws_a", 90, NOW - SCAN_WINDOW_MS - 1);
    const spent = { ...fresh("ws_a", 91), tries: MAX_TRIES };
    const batch = [message(late), message(spent, 2), ...Array.from({ length: PER_ROOM_PER_BATCH }, (_, i) => message(fresh("ws_a", i)))];
    const r = recorder();
    const done = await consumeFairly(batch.map((m) => m.queued), r.consuming);
    expect(r.settled).toEqual(["obj_ws_a_90 too_late", "obj_ws_a_91 gave_up"]);
    expect(done).toEqual({ scanned: PER_ROOM_PER_BATCH, settled: 2, delayed: 0, requeued: 0, retried: 0 });
    expect(r.sent).toEqual([]);
  });

  it("hands what isn't a job to scanOne first, without counting it toward a turn", async () => {
    const batch = [message({ v: 1, junk: true }), ...Array.from({ length: PER_ROOM_PER_BATCH }, (_, i) => message(fresh("ws_a", i)))];
    const r = recorder();
    const done = await consumeFairly(batch.map((m) => m.queued), r.consuming);
    expect(r.events[0]).toBe("scan ?");
    expect(done.delayed).toBe(0);
  });

  it("stops at the time budget when many rooms share a batch, and sends the rest back with no delay", async () => {
    const batch = Array.from({ length: 60 }, (_, i) => message(fresh(`ws_${i}`, 0)));
    const r = recorder();
    const done = await consumeFairly(batch.map((m) => m.queued), r.consuming);
    expect(done.scanned).toBe(Math.ceil(BATCH_BUDGET_MS / SCAN_MS));
    expect(done.requeued).toBe(60 - done.scanned);
    expect(r.sent.every((m) => m.delaySeconds === undefined)).toBe(true);
  });

  it("always scans its first job, however long it takes, so a batch always makes progress", async () => {
    const batch = [fresh("ws_a", 0), fresh("ws_b", 0)].map((b) => message(b));
    const r = recorder({ scanMs: 10 * BATCH_BUDGET_MS });
    expect(await consumeFairly(batch.map((m) => m.queued), r.consuming)).toMatchObject({ scanned: 1, requeued: 1 });
  });

  it("retries what it couldn't send back, so nothing is lost, and says so", async () => {
    const batch = Array.from({ length: PER_ROOM_PER_BATCH + 2 }, (_, i) => message(fresh("ws_a", i)));
    const r = recorder({
      requeue: async () => {
        throw new Error("queue unavailable");
      },
    });
    const done = await consumeFairly(batch.map((m) => m.queued), r.consuming);
    expect(done).toMatchObject({ scanned: PER_ROOM_PER_BATCH, delayed: 0, retried: 2 });
    expect(r.failed()).toBe(2);
    expect(batch.map((m) => m.seen)).toEqual([...Array(PER_ROOM_PER_BATCH).fill({ acked: 1, retried: 0 }), { acked: 0, retried: 1 }, { acked: 0, retried: 1 }]);
  });
});

describe("a job's tries and age travel with it", () => {
  it("carries its failed tries into the message sent back, adding this message's own", () => {
    expect(triesOf(message(fresh("ws_a", 0), 1).queued)).toBe(0);
    expect(triesOf(message({ ...fresh("ws_a", 0), tries: 2 }, 3).queued)).toBe(4);
    for (const tries of [-1, 1.5, "3", null]) expect(triesOf(message({ ...fresh("ws_a", 0), tries }, 1).queued), String(tries)).toBe(0);
    expect(resent(message({ ...fresh("ws_a", 0), tries: 2 }, 3).queued, NOW)).toMatchObject({ tries: 4, queued_at: NOW - 1000 });
  });

  it("gives up on a job past its tries across messages, as the dead-letter queue would on one", async () => {
    const r = recorder();
    await consumeFairly([message({ ...fresh("ws_a", 0), tries: MAX_TRIES }, 2).queued], r.consuming);
    expect(r.settled).toEqual(["obj_ws_a_0 gave_up"]);
  });

  it("stamps a job from an API that didn't with when it was first sent back, so the hour still ends it", async () => {
    const { queued_at: _, ...unstamped } = fresh("ws_a", 0);
    expect(resent(message(unstamped).queued, NOW)).toMatchObject({ queued_at: NOW, tries: 0 });
    const batch = Array.from({ length: PER_ROOM_PER_BATCH + 1 }, (_, i) => {
      const { queued_at: __, ...body } = fresh("ws_a", i);
      return message(body);
    });
    const r = recorder();
    await consumeFairly(batch.map((m) => m.queued), r.consuming);
    // One room alone, so no delay.
    expect(r.sent).toEqual([{ body: { ...batch[PER_ROOM_PER_BATCH].queued.body as object, queued_at: NOW, tries: 0 } }]);
    // An hour later that job is past its hour, and is settled without a scan.
    const later = recorder();
    (later.consuming as { now: () => number }).now = () => NOW + SCAN_WINDOW_MS + 1;
    await consumeFairly([message(r.sent[0].body).queued], later.consuming);
    expect(later.settled).toEqual([`obj_ws_a_${PER_ROOM_PER_BATCH} too_late`]);
  });
});

const lone = () => job("ws_lone", 0);
const backlog = (rooms: number, each: number, interleaved: boolean) => {
  const queue: unknown[] = [];
  if (interleaved) for (let i = 0; i < each; i++) for (let r = 0; r < rooms; r++) queue.push(job(`ws_busy_${r}`, i));
  else for (let r = 0; r < rooms; r++) for (let i = 0; i < each; i++) queue.push(job(`ws_busy_${r}`, i));
  return queue;
};

describe("a room alone on an idle queue", () => {
  it("is scanned at about the pace of arrival order, with no delay to wait out", async () => {
    // Without the exception, each batch of 4 would wait 2 minutes for the rest: 100 files of 2 s would take 48 minutes.
    const solo = Array.from({ length: 100 }, (_, i) => job("ws_solo", i));
    const ids = solo.map((body) => body.object_id);
    const { reached } = await simulate(solo, ids, 2_000);
    expect(reached.size).toBe(100);
    const last = Math.max(...[...reached.values()].map((r) => r.ms));
    expect(last).toBeLessThanOrEqual(100 * 2_000 + 60_000);
  });
});

describe("one busy room can't starve another", () => {
  it("scans a lone file behind a thousand of one room's large files well inside the hour, where in arrival order it would take hours", async () => {
    const { reached } = await simulate([...backlog(1, 1000, false), lone()], ["obj_ws_lone_0"], SCAN_MS);
    // In arrival order it's the 1,001st scan, about 4.7 hours at 17 s each.
    expect(reached.get("obj_ws_lone_0")!.ms / 60_000).toBeLessThan(20);
  });

  it("reaches a lone file deep behind three rooms of 1,500 small files each, whichever way they arrived", async () => {
    for (const interleaved of [false, true]) {
      const { reached } = await simulate([...backlog(3, 1500, interleaved), lone()], ["obj_ws_lone_0"], 2_000);
      expect(reached.get("obj_ws_lone_0")?.ms, `interleaved: ${interleaved}`).toBeLessThan(30 * 60_000);
    }
  });

  it("keeps several quiet rooms inside the hour behind two busy ones", async () => {
    const queue = [...backlog(2, 600, true), job("ws_quiet_1", 0), job("ws_quiet_2", 0), job("ws_quiet_3", 0)];
    const wanted = ["obj_ws_quiet_1_0", "obj_ws_quiet_2_0", "obj_ws_quiet_3_0"];
    const { reached } = await simulate(queue, wanted, SCAN_MS);
    for (const id of wanted) expect(reached.get(id)?.ms, id).toBeLessThan(60 * 60_000);
  });
});
