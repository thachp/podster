/**
 * Fairness between rooms, with nothing here tied to a real queue, so it can be tested.
 *
 * There's one Container and it scans one file at a time, so the order is all there is to share. The consumer takes up to a hundred
 * jobs at once and scans them a room at a time, one job per room per round, at most `PER_ROOM_PER_BATCH` from any one room, until two
 * minutes have gone. Whatever it didn't reach
 * goes back on the queue, behind what's already there, and is sent again rather than retried, so waiting its turn never uses up a
 * job's retries. So a room with a long backlog moves behind other rooms' jobs instead of staying ahead of them, and a room with one
 * file waits for a few rounds, not for every file ahead of it.
 *
 * Nothing here gives a verdict. A job that waits too long ends as `failed` in its room after the hour, as before, so a busy room's
 * own files can fail closed, but no one else's are pushed out by them.
 */

/**
 * How long one batch keeps scanning before it sends the rest back. A batch also waits for the scan it's in, up to its limits. The
 * shorter this is, the sooner a job deep in the queue reaches a batch, at the cost of sending more jobs back: a lone job behind N
 * others waits about N / 100 batches of this, plus its own round.
 */
export const BATCH_BUDGET_MS = 2 * 60_000;

/**
 * The most one room gets scanned from one batch. A batch of only one room's jobs then ends after a few scans, so a job deep in the
 * queue reaches a batch in minutes however small and fast that room's files are. The time budget alone isn't enough: 2 s scans would
 * keep a busy room in one batch for 60 scans.
 */
export const PER_ROOM_PER_BATCH = 4;

/** A queued message, as much of it as this needs. */
export type Queued = { body: unknown; attempts: number; ack(): void; retry(): void };

/** The room a job names, or one shared name for anything that isn't a job, which `scanOne` turns away. */
export function roomOf(body: unknown): string {
  const room = typeof body === "object" && body !== null ? (body as { workspace_id?: unknown }).workspace_id : undefined;
  return typeof room === "string" ? room : "";
}

/**
 * The batch in turns: the first job of each room in the order rooms first appear, then each room's second, and so on. A room's own
 * jobs keep their order.
 */
export function fairOrder<T>(items: readonly T[], room: (item: T) => string): T[] {
  const rooms = new Map<string, T[]>();
  for (const item of items) {
    const key = room(item);
    const queue = rooms.get(key);
    if (queue) queue.push(item);
    else rooms.set(key, [item]);
  }
  const ordered: T[] = [];
  const turns = [...rooms.values()];
  for (let round = 0; ordered.length < items.length; round++) {
    for (const queue of turns) {
      const next = queue[round];
      if (next !== undefined) ordered.push(next);
    }
  }
  return ordered;
}

export type Consuming = {
  now: () => number;
  /** Scans one message and acks or retries it. */
  handle: (message: Queued) => Promise<void>;
  /** Sends these bodies to the back of the queue. Throws if they couldn't be sent. */
  requeue: (bodies: unknown[]) => Promise<void>;
};

/** What a batch did, for the log. */
export type Consumed = { scanned: number; requeued: number; retried: number };

/**
 * Scans the batch in turns until the budget is spent, then sends the rest back. The first job is always scanned, so a batch always
 * makes progress. If the rest can't be sent back, they're retried instead, which uses one of their retries but loses nothing.
 */
export async function consumeFairly(messages: readonly Queued[], consuming: Consuming): Promise<Consumed> {
  const started = consuming.now();
  const order = fairOrder(messages, (message) => roomOf(message.body));
  const deferred: Queued[] = [];
  const perRoom = new Map<string, number>();
  let scanned = 0;
  for (const message of order) {
    const room = roomOf(message.body);
    const turns = perRoom.get(room) ?? 0;
    if (turns >= PER_ROOM_PER_BATCH || (scanned > 0 && consuming.now() - started >= BATCH_BUDGET_MS)) {
      deferred.push(message);
      continue;
    }
    perRoom.set(room, turns + 1);
    await consuming.handle(message);
    scanned++;
  }
  if (deferred.length === 0) return { scanned, requeued: 0, retried: 0 };
  try {
    await consuming.requeue(deferred.map((message) => message.body));
  } catch {
    for (const message of deferred) message.retry();
    return { scanned, requeued: 0, retried: deferred.length };
  }
  for (const message of deferred) message.ack();
  return { scanned, requeued: deferred.length, retried: 0 };
}
