// The write counter (M6 stage 1, S6; the architect's ruling of 2026-11-13 on the plan's question 1, and the owner's yes
// of 2026-11-16 to its Durable Object class on the second account). One object for each app, owned by the content
// Worker, counting that app's writes in fixed windows by `podster_core::write_budget`'s rule (`budget.ts`, its
// mirror), strictly for that app.
//
// - **One object for each app, named by the app's label.** The label is what a script's name begins with, and stays
//   the app's across its releases, so a new release doesn't start a fresh count; and a custom hostname's entry names
//   one of the same app's scripts, so its writes share the app's count. A script's name would reset the count with
//   each release.
// - **The cap comes from the content Worker's two settings** with every request, as `admit_write` takes it from its
//   caller. Missing or malformed, the content Worker asks no object and refuses; the object reads the cap again, and
//   refuses any it can't read. Nothing here holds a figure.
// - **The time is the object's own clock**, one clock for each app. *A server clock that jumps back by more than one
//   window can let writes past the cap:* a count stamped more than a window ahead of the clock is taken as a bad
//   reading and starts afresh, by ruling 9 on the stage-1 questions, so that no stored count refuses for more than two
//   windows. A jump back of up to a window is held to.
// - **Reached only from the content Worker.** It has no route: an object is reached only through its namespace's
//   binding, which only this Worker's configuration declares. It answers one request, and nothing else.
// - **Logs nothing.**
//
// Its reads and its write of the count run in one request's turn, with no other wait between them, so the runtime's
// input gate keeps another request from reading the count between them; its output gate holds the answer until the
// write is stored, so a write is admitted only once it is counted.

import { admitWrite, type BudgetRefusal, capFromSettings, type StoredCount, type WriteCap } from "./budget";

/** Whether a write may pass, as the counter answered. */
export type Admission = { ok: true } | { ok: false; refusal: BudgetRefusal };

/** What the content Worker asks before it sends a write on: one write, for one app, by its label. */
export interface WriteGate {
  admit(label: string): Promise<Admission>;
}

/** The one key an object holds: its app's count. */
export const COUNT_KEY = "count";

/** The object's storage, as much of it as is used. */
export interface CounterStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** The namespace's binding, as much of it as is used. */
export interface CounterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

const UNKNOWN: Admission = { ok: false, refusal: { code: "write_budget_unknown" } };
/** The one request the object answers. Its host is under `.invalid`, which is no host: an object's request goes nowhere else. */
const ADMIT_URL = "https://write-counter.invalid/admit";
const I64 = /^-?(?:0|[1-9][0-9]{0,18})$/;
const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);

/** Whether a value is a plain object with exactly these keys. */
const hasExactly = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();

/** An `i64` written as a decimal string, or null. */
function i64Of(value: unknown): bigint | null {
  if (typeof value !== "string" || !I64.test(value)) return null;
  const read = BigInt(value);
  return read >= I64_MIN && read <= I64_MAX ? read : null;
}

/** The count as stored: nothing, the exact form this writes, or unreadable. Never "nothing" for a shape it didn't write. */
function storedOf(value: unknown): StoredCount {
  if (value === undefined) return { kind: "nothing" };
  if (!hasExactly(value, ["window_start_ms", "writes"])) return { kind: "unreadable" };
  const start = i64Of(value.window_start_ms);
  const writes = value.writes;
  if (start === null || typeof writes !== "number" || !Number.isInteger(writes) || writes < 0 || writes > 2 ** 32 - 1) return { kind: "unreadable" };
  return { kind: "counted", windowStartMs: start, writes };
}

/**
 * One write, counted in one app's storage at `nowMs`: admitted, and recorded in the same step, or refused with
 * nothing recorded. A count that can't be read, or can't be recorded, refuses as unknown.
 */
export async function countWrite(storage: CounterStorage, cap: WriteCap, nowMs: bigint): Promise<Admission> {
  let stored: StoredCount;
  try {
    stored = storedOf(await storage.get(COUNT_KEY));
  } catch {
    stored = { kind: "unreadable" };
  }
  const decided = admitWrite(cap, stored, nowMs);
  if (!decided.ok) return { ok: false, refusal: decided.refusal };
  try {
    await storage.put(COUNT_KEY, { window_start_ms: String(decided.value.windowStartMs), writes: decided.value.writes });
  } catch {
    return UNKNOWN;
  }
  return { ok: true };
}

/** An admission as the object answers it: one fixed form for each. */
function answerOf(admission: Admission): Response {
  const body = admission.ok
    ? { admitted: true }
    : admission.refusal.code === "write_budget_spent"
      ? { refused: admission.refusal.code, retry_after_ms: String(admission.refusal.retryAfterMs) }
      : { refused: admission.refusal.code };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** An object's answer, read strictly: anything but one of its fixed forms is unknown. */
async function admissionOf(answer: Response): Promise<Admission> {
  if (answer.status !== 200) return UNKNOWN;
  let body: unknown;
  try {
    body = JSON.parse(await answer.text());
  } catch {
    return UNKNOWN;
  }
  if (hasExactly(body, ["admitted"]) && body.admitted === true) return { ok: true };
  if (hasExactly(body, ["refused", "retry_after_ms"]) && body.refused === "write_budget_spent") {
    const wait = i64Of(body.retry_after_ms);
    if (wait !== null && wait >= 0n) return { ok: false, refusal: { code: "write_budget_spent", retryAfterMs: wait } };
  }
  return UNKNOWN;
}

/** The Durable Object class: one object for each app. */
export class WriteCounter {
  private readonly storage: CounterStorage;
  private readonly now: () => bigint;

  /** The runtime passes the first two; a test passes its own clock as the third. */
  constructor(state: { storage: CounterStorage }, _env: unknown, now: () => bigint = () => BigInt(Date.now())) {
    this.storage = state.storage;
    this.now = now;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || request.url !== ADMIT_URL) return new Response(null, { status: 404 });
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return answerOf(UNKNOWN);
    }
    const cap = hasExactly(body, ["window_ms", "writes"]) ? capFromSettings(body.writes, body.window_ms) : null;
    if (cap === null) return answerOf(UNKNOWN);
    return answerOf(await countWrite(this.storage, cap, this.now()));
  }
}

/**
 * The content Worker's side: asks the app's object to count one write. With no cap, from settings missing or
 * malformed, it asks nothing and refuses. An object that can't be reached, or answers anything but its fixed forms,
 * is unknown, and the write is refused. It never throws.
 */
export function writeCounter(namespace: CounterNamespace, cap: WriteCap | null): WriteGate {
  return {
    async admit(label) {
      if (cap === null) return UNKNOWN;
      try {
        const object = namespace.get(namespace.idFromName(label));
        const asked = new Request(ADMIT_URL, { method: "POST", body: JSON.stringify({ writes: String(cap.writes), window_ms: String(cap.windowMs) }) });
        return await admissionOf(await object.fetch(asked));
      } catch {
        return UNKNOWN;
      }
    },
  };
}
