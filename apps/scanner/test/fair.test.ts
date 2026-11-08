import { describe, expect, it } from "vitest";
import { BATCH_BUDGET_MS, consumeFairly, fairOrder, PER_ROOM_PER_BATCH, roomOf, type Queued } from "../src/fair";

/** A job body as the API sends it, with only what ordering reads mattering here. */
const job = (room: string, n: number) => ({ v: 1, workspace_id: room, object_id: `obj_${room}_${n}`, key: `rooms/${room}/objects/obj_${room}_${n}/a`, size: 1, sha256: "a".repeat(64) });

function message(body: unknown) {
  const seen = { acked: false, retried: false };
  const queued: Queued = { body, attempts: 1, ack: () => void (seen.acked = true), retry: () => void (seen.retried = true) };
  return { queued, seen };
}

/** The slowest whole scan seen on staging, rounded up: a 100 MB file was 16.7 s from storing to verdict. */
const SCAN_MS = 17_000;

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
  it("reaches a lone room's job in the first round, however many a busy room has ahead of it", async () => {
    const batch = [...Array.from({ length: 99 }, (_, i) => job("ws_busy", i)), job("ws_lone", 0)].map(message);
    let now = 0;
    const scanned: string[] = [];
    const requeued: unknown[] = [];
    const done = await consumeFairly(batch.map((m) => m.queued), {
      now: () => now,
      handle: async (m) => {
        scanned.push((m.body as { object_id: string }).object_id);
        now += SCAN_MS;
        m.ack();
      },
      requeue: async (bodies) => void requeued.push(...bodies),
    });
    expect(scanned.slice(0, 2)).toEqual(["obj_ws_busy_0", "obj_ws_lone_0"]);
    // At most a few from the busy room, then the rest go back, in their order, and are acked.
    expect(done.scanned).toBe(PER_ROOM_PER_BATCH + 1);
    expect(done.requeued).toBe(100 - done.scanned);
    expect(requeued).toEqual(batch.map((m) => m.queued.body).filter((b) => !scanned.includes((b as { object_id: string }).object_id)));
    expect(batch.every((m) => m.seen.acked && !m.seen.retried)).toBe(true);
  });

  it("stops at the time budget when many rooms share a batch", async () => {
    const batch = Array.from({ length: 60 }, (_, i) => job(`ws_${i}`, 0)).map(message);
    let now = 0;
    const done = await consumeFairly(batch.map((m) => m.queued), {
      now: () => now,
      handle: async (m) => {
        now += SCAN_MS;
        m.ack();
      },
      requeue: async () => undefined,
    });
    expect(done.scanned).toBe(Math.ceil(BATCH_BUDGET_MS / SCAN_MS));
    expect(done.requeued).toBe(60 - done.scanned);
  });

  it("always scans its first job, even if the budget is gone, so a batch always makes progress", async () => {
    const batch = [job("ws_a", 0), job("ws_b", 0)].map(message);
    let calls = 0;
    const done = await consumeFairly(batch.map((m) => m.queued), {
      now: () => calls++ * BATCH_BUDGET_MS,
      handle: async (m) => m.ack(),
      requeue: async () => undefined,
    });
    expect(done).toEqual({ scanned: 1, requeued: 1, retried: 0 });
  });

  it("retries what it couldn't send back, so nothing is lost", async () => {
    const batch = [job("ws_a", 0), job("ws_a", 1), job("ws_a", 2)].map(message);
    let now = 0;
    const done = await consumeFairly(batch.map((m) => m.queued), {
      now: () => now,
      handle: async (m) => {
        now += BATCH_BUDGET_MS;
        m.ack();
      },
      requeue: async () => {
        throw new Error("queue unavailable");
      },
    });
    expect(done).toEqual({ scanned: 1, requeued: 0, retried: 2 });
    expect(batch.map((m) => m.seen)).toEqual([{ acked: true, retried: false }, { acked: false, retried: true }, { acked: false, retried: true }]);
  });
});

/**
 * The whole queue, batch after batch, as the consumer sees it: up to a hundred from the front, and what a batch sends back goes to
 * the end. Answers how many scans ran before each named job.
 */
async function simulate(queue: unknown[], wanted: string[]) {
  let now = 0;
  let scans = 0;
  const reachedAt = new Map<string, number>();
  while (queue.length > 0 && reachedAt.size < wanted.length) {
    const batch = queue.splice(0, 100).map((body) => message(body).queued);
    await consumeFairly(batch, {
      now: () => now,
      handle: async (m) => {
        scans++;
        now += SCAN_MS;
        const id = (m.body as { object_id: string }).object_id;
        if (wanted.includes(id)) reachedAt.set(id, scans);
        m.ack();
      },
      requeue: async (bodies) => void queue.push(...bodies),
    });
  }
  return reachedAt;
}

describe("one busy room can't starve another", () => {
  it("scans a lone file behind a thousand of one room's files well inside the hour, where in arrival order it would take hours", async () => {
    const queue: unknown[] = [...Array.from({ length: 1000 }, (_, i) => job("ws_busy", i)), job("ws_lone", 0)];
    const reached = await simulate(queue, ["obj_ws_lone_0"]);
    const scans = reached.get("obj_ws_lone_0")!;
    // In arrival order it's the 1,001st scan, about 4.7 hours at 17 s each.
    expect(scans).toBeLessThan(200);
    expect((scans * SCAN_MS) / 60_000).toBeLessThan(60);
  });

  it("scans a lone file behind five thousand small, fast files of one room within minutes", async () => {
    const queue: unknown[] = [...Array.from({ length: 5000 }, (_, i) => job("ws_busy", i)), job("ws_lone", 0)];
    let now = 0;
    let scans = 0;
    let reached = 0;
    while (reached === 0) {
      const batch = queue.splice(0, 100).map((body) => message(body).queued);
      await consumeFairly(batch, {
        now: () => now,
        handle: async (m) => {
          scans++;
          now += 2_000;
          if ((m.body as { object_id: string }).object_id === "obj_ws_lone_0") reached = scans;
          m.ack();
        },
        requeue: async (bodies) => void queue.push(...bodies),
      });
    }
    // A time budget alone would let 2 s scans keep the busy room in each batch for 60 scans, about 100 minutes in all.
    expect((reached * 2_000) / 60_000).toBeLessThan(15);
  });

  it("shares turns among several busy rooms and several quiet ones", async () => {
    const queue: unknown[] = [];
    for (let i = 0; i < 600; i++) queue.push(job("ws_busy_a", i), job("ws_busy_b", i));
    queue.push(job("ws_quiet_1", 0), job("ws_quiet_2", 0), job("ws_quiet_3", 0));
    const wanted = ["obj_ws_quiet_1_0", "obj_ws_quiet_2_0", "obj_ws_quiet_3_0"];
    const reached = await simulate(queue, wanted);
    for (const id of wanted) expect((reached.get(id)! * SCAN_MS) / 60_000, id).toBeLessThan(60);
  });
});
