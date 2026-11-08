import { consumeFairly, type Queued, type Resend } from "../src/fair";

/** A job body as the API sends it. */
export const job = (room: string, n: number, queued_at = 1) => ({ v: 1, workspace_id: room, object_id: `obj_${room}_${n}`, key: `rooms/${room}/objects/obj_${room}_${n}/a`, size: 1, sha256: "a".repeat(64), queued_at });

/**
 * The queue, batch after batch, as the consumer sees it: up to a hundred of the messages available now, the earliest available
 * first, and what a batch sends back joins it then, or after its delay. Each scan takes `scanMs`. Answers how long until each named
 * job was scanned, how many scans ran before it, and how many messages were sent back in all.
 */
export async function simulate(bodies: unknown[], wanted: string[], scanMs: number, limitMs = 24 * 60 * 60_000) {
  let now = 0;
  let seq = 0;
  let scans = 0;
  let sentBack = 0;
  const queue: { body: unknown; at: number; seq: number }[] = bodies.map((body) => ({ body, at: 0, seq: seq++ }));
  const reached = new Map<string, { scans: number; ms: number }>();
  while (reached.size < wanted.length && queue.length > 0 && now < limitMs) {
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (queue[0].at > now) now = queue[0].at;
    const ready = queue.filter((item) => item.at <= now).slice(0, 100);
    for (const item of ready) queue.splice(queue.indexOf(item), 1);
    const batch: Queued[] = ready.map((item) => ({ body: item.body, attempts: 1, ack() {}, retry() {} }));
    await consumeFairly(batch, {
      now: () => now,
      handle: async (m) => {
        scans++;
        now += scanMs;
        const id = (m.body as { object_id: string }).object_id;
        if (wanted.includes(id) && !reached.has(id)) reached.set(id, { scans, ms: now });
      },
      settle: () => undefined,
      requeue: async (messages: Resend[]) => {
        sentBack += messages.length;
        for (const m of messages) queue.push({ body: m.body, at: now + (m.delaySeconds ?? 0) * 1000, seq: seq++ });
      },
      requeueFailed: () => undefined,
    });
  }
  return { reached, sentBack };
}
