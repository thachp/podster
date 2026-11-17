import { afterEach, describe, expect, it, vi } from "vitest";
import { type BudgetRefusal, capFromSettings, type WriteCap } from "../src/budget";
import { type Admission, COUNT_KEY, type CounterNamespace, type CounterStorage, countWrite, WriteCounter, writeCounter } from "../src/counter";

// The write counter (M6 stage 1, S6): one Durable Object for each app, owned by the content Worker, counting that
// app's writes in fixed windows by `podster_core::write_budget`'s rule (`src/budget.ts`, its mirror). Nothing here
// reaches Cloudflare: the object's storage is a stand-in, and its clock is passed in, so no test waits.

const MINUTES_10 = 600_000n;
const OWNERS = capFromSettings("300", "600000") as WriteCap;
const T = 1_763_380_800_000n; // A window's first millisecond: 2025-11-17T12:00:00Z is a multiple of 600,000 ms.

/** The object's storage, as much of it as is used, in memory, with faults the test scripts. */
function storage() {
  const held = new Map<string, unknown>();
  const s = {
    held,
    puts: 0,
    failGet: false,
    failPut: false,
    async get(key: string) {
      if (s.failGet) throw new Error("storage is down");
      return held.get(key);
    },
    async put(key: string, value: unknown) {
      if (s.failPut) throw new Error("storage is down");
      s.puts += 1;
      held.set(key, value);
    },
  };
  return s satisfies CounterStorage;
}

const ADMITTED: Admission = { ok: true };
const spent = (retryAfterMs: bigint): Admission => ({ ok: false, refusal: { code: "write_budget_spent", retryAfterMs } });
const UNKNOWN: Admission = { ok: false, refusal: { code: "write_budget_unknown" } as BudgetRefusal };

describe("one app's count, in its object's storage", () => {
  it("admits exactly the cap in a window, records each admitted write as it admits it, and refuses the rest", async () => {
    const s = storage();
    const cap = capFromSettings("3", "600000") as WriteCap;
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await countWrite(s, cap, T + 10n));
    expect(answers).toEqual([ADMITTED, ADMITTED, ADMITTED, spent(MINUTES_10 - 10n), spent(MINUTES_10 - 10n)]);
    // Three writes recorded, and nothing for a refusal.
    expect(s.puts).toBe(3);
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: String(T), writes: 3 });
  });

  it("holds the owner's figure at its boundary: the 300th write passes and the 301st is refused", async () => {
    const s = storage();
    s.held.set(COUNT_KEY, { window_start_ms: String(T), writes: 299 });
    expect(await countWrite(s, OWNERS, T + 1n)).toEqual(ADMITTED);
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: String(T), writes: 300 });
    expect(await countWrite(s, OWNERS, T + 1n)).toEqual(spent(MINUTES_10 - 1n));
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: String(T), writes: 300 });
  });

  it("starts the next window afresh to the millisecond: refused one under its start, admitted at it", async () => {
    const s = storage();
    s.held.set(COUNT_KEY, { window_start_ms: String(T), writes: 300 });
    expect(await countWrite(s, OWNERS, T + MINUTES_10 - 1n)).toEqual(spent(1n));
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: String(T), writes: 300 });
    expect(await countWrite(s, OWNERS, T + MINUTES_10)).toEqual(ADMITTED);
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: String(T + MINUTES_10), writes: 1 });
  });

  it("refuses every write under a cap of zero, and records nothing", async () => {
    const s = storage();
    const zero = capFromSettings("0", "600000") as WriteCap;
    expect(await countWrite(s, zero, T + 5n)).toEqual(spent(MINUTES_10 - 5n));
    expect([s.puts, s.held.size]).toEqual([0, 0]);
  });

  it("refuses as unknown, and records nothing, when the count can't be read or isn't one it wrote", async () => {
    const s = storage();
    s.failGet = true;
    expect(await countWrite(s, OWNERS, T)).toEqual(UNKNOWN);
    expect(s.puts).toBe(0);
    // Each shape the object never writes is unreadable, not "nothing counted".
    const unreadable = [null, 0, "3", [], {}, { window_start_ms: String(T) }, { writes: 1 }, { window_start_ms: Number(T), writes: 1 }, { window_start_ms: String(T), writes: "1" }, { window_start_ms: String(T), writes: -1 }, { window_start_ms: String(T), writes: 1.5 }, { window_start_ms: String(T), writes: 2 ** 32 }, { window_start_ms: ` ${T}`, writes: 1 }, { window_start_ms: "1e3", writes: 1 }, { window_start_ms: String(2n ** 63n), writes: 1 }, { window_start_ms: String(T), writes: 1, extra: true }];
    for (const value of unreadable) {
      const t = storage();
      t.held.set(COUNT_KEY, value);
      expect(await countWrite(t, OWNERS, T), JSON.stringify(value)).toEqual(UNKNOWN);
      expect([t.puts, t.held.get(COUNT_KEY)], JSON.stringify(value)).toEqual([0, value]);
    }
    // A control: the same storage with a count it did write admits.
    const t = storage();
    t.held.set(COUNT_KEY, { window_start_ms: String(-(2n ** 63n)), writes: 0 });
    expect(await countWrite(t, OWNERS, T)).toEqual(ADMITTED);
  });

  it("doesn't admit a write whose count couldn't be recorded", async () => {
    const s = storage();
    s.failPut = true;
    expect(await countWrite(s, OWNERS, T)).toEqual(UNKNOWN);
    expect(s.held.size).toBe(0);
  });

  it("holds to a count from the next window when the clock goes back a little, and lets a jump of more than a window through", async () => {
    // The doc note owed with ruling 9 (docs/m6-plan.md, "What S6 built"): a count stamped more than one window ahead
    // of the clock is a bad reading and starts afresh, so a server clock that jumps back more than a window can let
    // one window's writes go past the cap. This pins that the counter behaves as written there.
    const s = storage();
    s.held.set(COUNT_KEY, { window_start_ms: String(T + MINUTES_10), writes: 300 });
    // Back into the window before: held to, refused until the held window ends.
    expect(await countWrite(s, OWNERS, T + 1n)).toEqual(spent(2n * MINUTES_10 - 1n));
    // Back more than a window: stale, and 300 more writes pass.
    expect(await countWrite(s, OWNERS, T - 1n)).toEqual(ADMITTED);
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: String(T - MINUTES_10), writes: 1 });
  });
});

/** An admit request as the content Worker sends it. */
const ask = (body: unknown, init: RequestInit = {}) => new Request("https://write-counter.invalid/admit", { method: "POST", body: JSON.stringify(body), ...init });

describe("the counter's object", () => {
  it("answers each decision in its one fixed form, taking the cap from the request and the time from its own clock", async () => {
    const s = storage();
    const clock = { now: T + 10n };
    const counter = new WriteCounter({ storage: s }, {}, () => clock.now);
    const cap = { writes: "2", window_ms: "600000" };
    const answers = [];
    for (let i = 0; i < 3; i += 1) {
      const answer = await counter.fetch(ask(cap));
      answers.push([answer.status, await answer.text()]);
    }
    expect(answers).toEqual([
      [200, '{"admitted":true}'],
      [200, '{"admitted":true}'],
      [200, `{"refused":"write_budget_spent","retry_after_ms":"${MINUTES_10 - 10n}"}`],
    ]);
    s.failGet = true;
    const unknown = await counter.fetch(ask(cap));
    expect([unknown.status, await unknown.text()]).toEqual([200, '{"refused":"write_budget_unknown"}']);
  });

  it("refuses every write as unknown when the cap it was sent is missing or malformed, and reads no count for it", async () => {
    for (const body of [{}, { writes: "2" }, { window_ms: "600000" }, { writes: 2, window_ms: "600000" }, { writes: "2", window_ms: "0" }, { writes: "-1", window_ms: "600000" }, { writes: "2", window_ms: "600000", extra: 1 }, null, "x", []]) {
      const s = storage();
      s.held.set(COUNT_KEY, { window_start_ms: "0", writes: 0 });
      const read = vi.spyOn(s, "get");
      const answer = await new WriteCounter({ storage: s }, {}, () => T).fetch(ask(body));
      expect([answer.status, await answer.text(), read.mock.calls.length, s.puts], JSON.stringify(body)).toEqual([200, '{"refused":"write_budget_unknown"}', 0, 0]);
    }
    const s = storage();
    const notJson = await new WriteCounter({ storage: s }, {}, () => T).fetch(new Request("https://write-counter.invalid/admit", { method: "POST", body: "{" }));
    expect([notJson.status, await notJson.text(), s.puts]).toEqual([200, '{"refused":"write_budget_unknown"}', 0]);
  });

  it("answers nothing but its one request: any other path or method is not found, and counts nothing", async () => {
    const s = storage();
    const counter = new WriteCounter({ storage: s }, {}, () => T);
    for (const request of [new Request("https://write-counter.invalid/admit"), new Request("https://write-counter.invalid/", { method: "POST", body: "{}" }), new Request("https://write-counter.invalid/admit/x", { method: "POST", body: "{}" }), new Request("https://write-counter.invalid/admit", { method: "PUT", body: "{}" })]) {
      const answer = await counter.fetch(request);
      expect([answer.status, await answer.text()], `${request.method} ${request.url}`).toEqual([404, ""]);
    }
    expect([s.puts, s.held.size]).toEqual([0, 0]);
  });

  it("reads the real clock when the runtime makes it, with two arguments", async () => {
    const s = storage();
    const counter = new WriteCounter({ storage: s }, {});
    // A window far longer than the clock has run, so the real time can't cross an edge during the test.
    const answer = await counter.fetch(ask({ writes: "1", window_ms: String(2n ** 62n) }));
    expect(await answer.text()).toBe('{"admitted":true}');
    expect(s.held.get(COUNT_KEY)).toEqual({ window_start_ms: "0", writes: 1 });
  });
});

/** A namespace whose objects are real counters on stand-in storage, one for each name, with every call recorded. */
function namespace() {
  const objects = new Map<string, { counter: WriteCounter; storage: ReturnType<typeof storage> }>();
  const n = {
    objects,
    names: [] as string[],
    clock: { now: T },
    answer: null as null | ((request: Request) => Promise<Response>),
    idFromName(name: string) {
      n.names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      if (!objects.has(name)) {
        const s = storage();
        objects.set(name, { storage: s, counter: new WriteCounter({ storage: s }, {}, () => n.clock.now) });
      }
      const object = objects.get(name)!;
      return { fetch: (request: Request) => (n.answer ? n.answer(request) : object.counter.fetch(request)) };
    },
  };
  return n satisfies CounterNamespace;
}

describe("the content Worker's side of the counter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks one object for each app, named by its label, so apps never share a count", async () => {
    const n = namespace();
    const gate = writeCounter(n, capFromSettings("1", "600000"));
    expect(await gate.admit("k3v9q2")).toEqual(ADMITTED);
    expect(await gate.admit("k3v9q2")).toEqual(spent(MINUTES_10));
    expect(await gate.admit("a7b8c9")).toEqual(ADMITTED);
    expect(n.names).toEqual(["k3v9q2", "k3v9q2", "a7b8c9"]);
    expect([...n.objects.keys()]).toEqual(["k3v9q2", "a7b8c9"]);
  });

  it("refuses every write as unknown, and asks no object, when either setting is missing or malformed", async () => {
    for (const [writes, window] of [[undefined, "600000"], ["300", undefined], [undefined, undefined], ["", "600000"], ["300", "0"], ["300", "ten minutes"], [300, 600000]]) {
      const n = namespace();
      const gate = writeCounter(n, capFromSettings(writes, window));
      expect(await gate.admit("k3v9q2"), `${writes} ${window}`).toEqual(UNKNOWN);
      expect([n.names, n.objects.size], `${writes} ${window}`).toEqual([[], 0]);
    }
  });

  it("refuses as unknown, and never throws, when the Worker was deployed without the counter's binding", async () => {
    // As a deploy from `scripts/deploy-content` was before it carried the counter: no binding, and no settings either.
    const missing = undefined as unknown as CounterNamespace;
    expect(await writeCounter(missing, capFromSettings(undefined, undefined)).admit("k3v9q2")).toEqual(UNKNOWN);
    // The settings set, and the binding still missing.
    expect(await writeCounter(missing, OWNERS).admit("k3v9q2")).toEqual(UNKNOWN);
  });

  it("sends the cap from the settings, as the decimal strings it was read as", async () => {
    const n = namespace();
    const sent: unknown[] = [];
    n.answer = async (request) => {
      sent.push([request.method, request.url, await request.json()]);
      return new Response('{"admitted":true}');
    };
    expect(await writeCounter(n, OWNERS).admit("k3v9q2")).toEqual(ADMITTED);
    expect(sent).toEqual([["POST", "https://write-counter.invalid/admit", { writes: "300", window_ms: "600000" }]]);
  });

  it("takes only the object's exact answers, and anything else, or no answer, as unknown", async () => {
    const odd = [
      [200, ""],
      [200, "{"],
      [200, "null"],
      [200, '{"admitted":false}'],
      [200, '{"admitted":"true"}'],
      [200, '{"admitted":true,"extra":1}'],
      [200, '{"refused":"write_budget_spent"}'],
      [200, '{"refused":"write_budget_spent","retry_after_ms":5}'],
      [200, '{"refused":"write_budget_spent","retry_after_ms":"-5"}'],
      [200, '{"refused":"write_budget_spent","retry_after_ms":"5e3"}'],
      [200, '{"refused":"other"}'],
      [500, '{"admitted":true}'],
      [404, ""],
    ] as const;
    for (const [status, body] of odd) {
      const n = namespace();
      n.answer = async () => new Response(body, { status });
      expect(await writeCounter(n, OWNERS).admit("k3v9q2"), `${status} ${body}`).toEqual(UNKNOWN);
    }
    // A control: the same reader takes the exact forms.
    for (const [body, admission] of [['{"admitted":true}', ADMITTED], ['{"refused":"write_budget_spent","retry_after_ms":"1500"}', spent(1500n)], ['{"refused":"write_budget_unknown"}', UNKNOWN]] as const) {
      const n = namespace();
      n.answer = async () => new Response(body);
      expect(await writeCounter(n, OWNERS).admit("k3v9q2"), body).toEqual(admission);
    }
    // The object's call failing, or the namespace throwing, is unknown too, and never an error.
    const failing = namespace();
    failing.answer = async () => {
      throw new Error("object unreachable");
    };
    expect(await writeCounter(failing, OWNERS).admit("k3v9q2")).toEqual(UNKNOWN);
    const broken = namespace();
    vi.spyOn(broken, "idFromName").mockImplementation(() => {
      throw new Error("no namespace");
    });
    expect(await writeCounter(broken, OWNERS).admit("k3v9q2")).toEqual(UNKNOWN);
  });
});
