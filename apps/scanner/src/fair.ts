/**
 * Fairness between rooms, with nothing here tied to a real queue, so it can be tested.
 *
 * There's one Container and it scans one file at a time, so the order is all there is to share. The consumer takes up to a hundred
 * jobs at once. Before scanning any, it settles what needs no scan, and sends each room's jobs past the first
 * `PER_ROOM_PER_BATCH` back to the queue with a delay, so they leave the front and the jobs behind them come forward. Then it scans
 * what's left a room at a time, one job per room per round, until two minutes have gone, and sends back whatever it didn't reach.
 * Sending back is a new message, not a retry, so the job's own count of failed tries goes with it in the body.
 *
 * Nothing here gives a verdict. A job that waits too long ends as `failed` in its room after the hour, as before.
 */
import { readJob, SCAN_WINDOW_MS } from "./scan";

/** How long one batch keeps scanning before it sends the rest back. A batch also waits for the scan it's in, up to its limits. */
export const BATCH_BUDGET_MS = 2 * 60_000;

/** The most jobs one room gets scanned from one batch. Its others go back with a delay. */
export const PER_ROOM_PER_BATCH = 4;

/**
 * How long a room's surplus stays out of the queue. Long enough for the batches behind it to come forward, short enough that a busy
 * room's own files keep moving.
 */
export const SURPLUS_DELAY_SECONDS = 120;

/** Failed tries a job may have in all, across the messages that carried it, as the queue's own `max_retries` allows one message. */
export const MAX_TRIES = 5;

/** A queued message, as much of it as this needs. */
export type Queued = { body: unknown; attempts: number; ack(): void; retry(): void };

/** A message to send back, and how long the queue should hold it. */
export type Resend = { body: unknown; delaySeconds?: number };

/** Why a job ends without a scan. */
export type Settled = "too_late" | "gave_up";

/** The room a job names, or one shared name for anything that isn't a job, which `scanOne` turns away. */
export function roomOf(body: unknown): string {
  const room = typeof body === "object" && body !== null ? (body as { workspace_id?: unknown }).workspace_id : undefined;
  return typeof room === "string" ? room : "";
}

/** Failed tries before this delivery: those carried in the body from earlier messages, and this message's own. */
export function triesOf(message: Queued): number {
  const carried = typeof message.body === "object" && message.body !== null ? (message.body as { tries?: unknown }).tries : undefined;
  const earlier = Number.isSafeInteger(carried) && (carried as number) > 0 ? (carried as number) : 0;
  return earlier + Math.max(0, message.attempts - 1);
}

/**
 * The body to send back: its failed tries so far, and when it was first sent. A job from an API that didn't stamp that is stamped
 * now, so the hour bounds it as it does every other job, however often it's sent back.
 */
export function resent(message: Queued, now: number): unknown {
  if (typeof message.body !== "object" || message.body === null) return message.body;
  const body = message.body as { queued_at?: unknown };
  const queued_at = typeof body.queued_at === "number" ? body.queued_at : now;
  return { ...body, queued_at, tries: triesOf(message) };
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
  /** Scans one message and acks or retries it. Never throws. */
  handle: (message: Queued) => Promise<void>;
  /** Ends a message with no scan, logging why, and acks it. */
  settle: (message: Queued, why: Settled) => void;
  /** Sends these back to the queue. Throws if they couldn't be sent. */
  requeue: (messages: Resend[]) => Promise<void>;
  /** Says that sending back failed, so it isn't silent. */
  requeueFailed: (count: number) => void;
};

/** What a batch did, for the log. */
export type Consumed = { scanned: number; settled: number; delayed: number; requeued: number; retried: number };

/**
 * Settles, sends back each room's surplus, scans in turns until the budget is spent, then sends back the rest. The first scan always
 * runs, so a batch always makes progress. If sending back fails, those messages are retried instead, which spends a try but loses
 * nothing.
 */
export async function consumeFairly(messages: readonly Queued[], consuming: Consuming): Promise<Consumed> {
  const started = consuming.now();
  const done: Consumed = { scanned: 0, settled: 0, delayed: 0, requeued: 0, retried: 0 };

  // What needs no scan goes first, so it takes no one's turn. Anything that isn't a job is left for `scanOne` to turn away, which
  // is as quick, and doesn't count toward a room's turns either.
  const instant: Queued[] = [];
  const jobs: Queued[] = [];
  for (const message of messages) {
    const job = readJob(message.body);
    if (!job) instant.push(message);
    else if (job.queued_at !== undefined && started - job.queued_at > SCAN_WINDOW_MS) {
      consuming.settle(message, "too_late");
      done.settled++;
    } else if (triesOf(message) > MAX_TRIES) {
      consuming.settle(message, "gave_up");
      done.settled++;
    } else jobs.push(message);
  }
  for (const message of instant) await consuming.handle(message);

  // Each room's surplus leaves the front of the queue at once, decided before any scan, so what's behind it comes forward.
  const kept: Queued[] = [];
  const surplus: Queued[] = [];
  const perRoom = new Map<string, number>();
  for (const message of fairOrder(jobs, (m) => roomOf(m.body))) {
    const room = roomOf(message.body);
    const turns = perRoom.get(room) ?? 0;
    if (turns < PER_ROOM_PER_BATCH) {
      perRoom.set(room, turns + 1);
      kept.push(message);
    } else surplus.push(message);
  }
  if (await sendBack(surplus, SURPLUS_DELAY_SECONDS, consuming, started)) done.delayed += surplus.length;
  else done.retried += surplus.length;

  const unreached: Queued[] = [];
  for (const message of kept) {
    if (done.scanned > 0 && consuming.now() - started >= BATCH_BUDGET_MS) {
      unreached.push(message);
      continue;
    }
    await consuming.handle(message);
    done.scanned++;
  }
  if (await sendBack(unreached, undefined, consuming, started)) done.requeued += unreached.length;
  else done.retried += unreached.length;
  return done;
}

/** Sends messages back and acks them, or retries them if they couldn't be sent. Answers whether they were sent. */
async function sendBack(messages: Queued[], delaySeconds: number | undefined, consuming: Consuming, now: number): Promise<boolean> {
  if (messages.length === 0) return true;
  try {
    await consuming.requeue(messages.map((message) => ({ body: resent(message, now), ...(delaySeconds === undefined ? {} : { delaySeconds }) })));
  } catch {
    consuming.requeueFailed(messages.length);
    for (const message of messages) message.retry();
    return false;
  }
  for (const message of messages) message.ack();
  return true;
}
