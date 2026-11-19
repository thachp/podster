// M7 step 8 on the owner's machine: the one-Runner-per-agent lock (decision 227), the owner's local stop, the run record on
// disk, and the ask screen. Each runs in a fresh temporary folder.
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AskView } from "../src/core/lifecycle.js";
import { emptyRuns, MemoryRunStore, newEntry, type RunsState } from "../src/core/runs.js";
import { FileRunStore, forgetRuns } from "../src/node/file-runs.js";
import { acquireLock, LOCK_FILE, LockRefused, lockHolder, processAlive, STALE_UNREADABLE_MS } from "../src/node/lock.js";
import { clearStop, requestStop, STOP_FILE, watchStop } from "../src/node/local-stop.js";
import { askScreen, columnsOf, displayWidth, fenced, MAX_LINES, SHOWN_CHARS, TerminalPrompter, visible, type Terminal } from "../src/node/prompter.js";

const folders: string[] = [];
async function home() {
  const folder = await mkdtemp(join(tmpdir(), "runner-step8-"));
  folders.push(folder);
  return join(folder, "home");
}
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const HOST = "this-machine";
const alive = new Set<number>();
const opts = (pid: number) => ({ pid, host: HOST, isAlive: (p: number) => alive.has(p) });

describe("one Runner per agent: the home's lock", () => {
  it("refuses a second Runner on the same home while the first is alive, and lets it in once the first releases", async () => {
    const h = await home();
    alive.add(101);
    const first = await acquireLock(h, opts(101));
    await expect(acquireLock(h, opts(202))).rejects.toThrow(LockRefused);
    await expect(acquireLock(h, opts(202))).rejects.toThrow(/process 101/);
    expect((await stat(join(h, LOCK_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(h)).mode & 0o777).toBe(0o700);
    await first.release();
    const second = await acquireLock(h, opts(202));
    expect((await lockHolder(h))?.pid).toBe(202);
    await second.release();
    alive.clear();
  });

  it("refuses the same process taking it twice", async () => {
    const h = await home();
    const held = await acquireLock(h, opts(303));
    await expect(acquireLock(h, opts(303))).rejects.toThrow(LockRefused);
    await held.release();
  });

  it("takes over a stale lock whose process is gone, and the old holder's release can't remove the new lock", async () => {
    const h = await home();
    const stale = await acquireLock(h, opts(404));
    // Process 404 is gone (not in `alive`).
    const fresh = await acquireLock(h, opts(505));
    expect((await lockHolder(h))?.pid).toBe(505);
    await stale.release();
    expect((await lockHolder(h))?.pid).toBe(505);
    await fresh.release();
    expect(await lockHolder(h)).toBeNull();
  });

  it("lets only one of two Runners taking over the same stale lock at once win", async () => {
    const h = await home();
    await acquireLock(h, opts(606));
    const results = await Promise.allSettled([acquireLock(h, opts(707)), acquireLock(h, opts(808)), acquireLock(h, opts(909))]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof LockRefused)).toBe(true);
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>).value;
    expect((await lockHolder(h))?.nonce).toBe(winner.holder.nonce);
  });

  it("refuses a lock naming another machine: its process can't be checked from here", async () => {
    const h = await home();
    await acquireLock(h, { pid: 111, host: "another-machine", isAlive: () => false });
    const refused = await acquireLock(h, opts(222)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LockRefused);
    expect(String((refused as Error).message)).toMatch(/another machine/);
    // The other machine's name isn't printed.
    expect(String((refused as Error).message)).not.toContain("another-machine");
  });

  it("refuses an unreadable lock while it may still be being written, and takes over one left by a crash", async () => {
    const h = await home();
    await acquireLock(h, opts(1));
    await writeFile(join(h, LOCK_FILE), "");
    await expect(acquireLock(h, opts(2))).rejects.toThrow(/starting/);
    const old = (Date.now() - STALE_UNREADABLE_MS - 5_000) / 1000;
    await utimes(join(h, LOCK_FILE), old, old);
    const held = await acquireLock(h, opts(2));
    expect((await lockHolder(h))?.pid).toBe(2);
    await held.release();
  });

  it("never removes a takeover guard by itself: it says which file it is", async () => {
    const h = await home();
    await acquireLock(h, opts(1));
    await writeFile(join(h, "run.lock.takeover"), "{}");
    await expect(acquireLock(h, opts(2))).rejects.toThrow(/taking over/);
    const old = (Date.now() - STALE_UNREADABLE_MS - 5_000) / 1000;
    await utimes(join(h, "run.lock.takeover"), old, old);
    await expect(acquireLock(h, opts(2))).rejects.toThrow(/run\.lock\.takeover/);
    expect(await readFile(join(h, "run.lock.takeover"), "utf8")).toBe("{}");
  });

  it("counts this process as alive, and one that doesn't exist as gone", async () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12_345)).toBe(false);
    // With the real check: a second Runner beside this live process refuses.
    const h = await home();
    const held = await acquireLock(h);
    await expect(acquireLock(h, { pid: process.pid + 1 })).rejects.toThrow(LockRefused);
    await held.release();
  });
});

describe("the owner's local stop", () => {
  it("asks the Runner holding the lock to stop, by its nonce, and says when no Runner is there", async () => {
    const h = await home();
    expect(await requestStop(h)).toBe(false);
    const held = await acquireLock(h, opts(1));
    let stopped = 0;
    const unwatch = watchStop(h, held.holder.nonce, () => stopped++);
    expect(await requestStop(h)).toBe(true);
    await expect.poll(() => stopped, { timeout: 2_000 }).toBe(1);
    unwatch();
    // Owner-only.
    expect((await stat(join(h, STOP_FILE))).mode & 0o777).toBe(0o600);
    await held.release();
  });

  it("ignores a stop request left for an earlier Runner, and a new Runner clears it", async () => {
    const h = await home();
    const held = await acquireLock(h, opts(1));
    await writeFile(join(h, STOP_FILE), "0".repeat(32));
    let stopped = 0;
    const unwatch = watchStop(h, held.holder.nonce, () => stopped++);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stopped).toBe(0);
    unwatch();
    await clearStop(h);
    await expect(stat(join(h, STOP_FILE))).rejects.toThrow();
    await held.release();
  });
});

describe("the owner's local stop, during pair and forget (L2)", () => {
  it("says no Runner is running while pair or forget holds the lock", async () => {
    for (const command of ["pair", "forget"] as const) {
      const h = await home();
      const held = await acquireLock(h, { ...opts(1), command });
      expect(await requestStop(h)).toBe(false);
      await held.release();
    }
    const h = await home();
    const run = await acquireLock(h, { ...opts(1), command: "run" });
    expect(await requestStop(h)).toBe(true);
    await run.release();
  });
});

describe("forget's part of the run record (L5)", () => {
  const withEntry = (patch: Partial<ReturnType<typeof newEntry>>, reservations: Record<string, number> = {}): RunsState => {
    const entry = { ...newEntry("ws_a", "tsk_a", 1), ...patch };
    return { ...emptyRuns(), agent_id: "agt_a", ledger: { day: 5, spent_micro_usd: 700, reservations }, entries: { "ws_a/tsk_a": entry } };
  };
  it("refuses while a run may still be going, or budget is reserved, and changes nothing", async () => {
    for (const state of [withEntry({ phase: "held" }), withEntry({ phase: "running" }), withEntry({ phase: "accepting", reservation: "r1" }, { r1: 2 })]) {
      const store = new MemoryRunStore();
      await store.save(state);
      const before = store.text;
      expect(await forgetRuns(store)).toMatch(/run that may still be going|budget reserved/);
      expect(store.text).toBe(before);
    }
  });
  it("otherwise drops every entry and keeps the day's spend", async () => {
    const store = new MemoryRunStore();
    await store.save(withEntry({ phase: "finished" }));
    expect(await forgetRuns(store)).toBeNull();
    const after = await store.load();
    expect(after.entries).toEqual({});
    expect(after.agent_id).toBeNull();
    expect(after.ledger).toEqual({ day: 5, spent_micro_usd: 700, reservations: {} });
  });
});

describe("the run record on disk", () => {
  it("fails loudly, naming the field, on a damaged ledger or entry (L8)", async () => {
    const h = await home();
    const store = new FileRunStore(h);
    const good = { ...emptyRuns(), entries: { "ws_a/tsk_a": newEntry("ws_a", "tsk_a", 1) } };
    await store.save(good);
    expect(await store.load()).toEqual(good);
    const damaged = [
      [{ ...good, ledger: { day: 1, spent_micro_usd: -5, reservations: {} } }, /ledger/],
      [{ ...good, ledger: { day: 1, spent_micro_usd: 0, reservations: { r1: "2" } } }, /ledger\.reservations/],
      [{ ...good, entries: { "ws_a/tsk_a": { ...newEntry("ws_a", "tsk_a", 1), phase: "flying" } } }, /phase/],
      [{ ...good, entries: { "ws_a/tsk_a": { ...newEntry("ws_a", "tsk_a", 1), phase: "accepting" } } }, /decision/],
      [{ ...good, entries: { "ws_b/tsk_a": newEntry("ws_a", "tsk_a", 1) } }, /entries/],
      [{ ...good, entries: { "ws_a/tsk_a": { ...newEntry("ws_a", "tsk_a", 1), reservation: "r9" } } }, /reservation/],
    ] as const;
    for (const [state, field] of damaged) {
      await writeFile(join(h, "runs.json"), JSON.stringify(state));
      const error = await store.load().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/damaged at/);
      expect((error as Error).message).toMatch(field);
    }
  });

  it("is written whole, owner-only, and read back; one it can't read is an error, never a fresh start", async () => {
    const h = await home();
    const store = new FileRunStore(h);
    expect(await store.load()).toEqual(emptyRuns());
    const state = { ...emptyRuns(), next_reservation: 7 };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect((await stat(join(h, "runs.json"))).mode & 0o777).toBe(0o600);
    await writeFile(join(h, "runs.json"), "{not json");
    await expect(store.load()).rejects.toThrow(/can't be read/);
    await writeFile(join(h, "runs.json"), JSON.stringify({ version: 2 }));
    await expect(store.load()).rejects.toThrow(/isn't one/);
  });
});

describe("the ask screen", () => {
  const view: AskView = {
    workspace_id: "ws_room",
    task_id: "tsk_one",
    reason: "author_external",
    room_visibility: "private",
    requester: "per_A@org_one",
    authors: [{ input: "title", authors: ["per_A@org_one"] }],
    tools: ["read", "search"],
    network: [],
    repository: null,
    caps: { spend_micro_usd: 2_000_000, run_time_ms: 1_800_000, turns: 40, output_tokens: 50_000, max_tokens: 4_096 },
    inputs: [{ input: "title", text: "Hello\u001b[2J\u001b]0;owned\u0007 world‮\r\nsecond line" }],
  };

  const term = (typed: string, over: Partial<Terminal> = {}) => {
    const written: string[] = [];
    const asked: string[] = [];
    const terminal: Terminal = { inputIsTTY: true, outputIsTTY: true, columns: 60, write: (t) => void written.push(t), question: async (q) => (asked.push(q), typed), ...over };
    return { terminal, written, asked };
  };

  it("shows what the model gets: every character that wouldn't show as a visible mark, nothing able to drive the terminal (L3)", () => {
    const { screen, cut } = askScreen(view, 80);
    expect(cut).toBe(false);
    expect(screen).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/);
    expect(screen).toContain("  | Hello⟨U+001B⟩[2J⟨U+001B⟩]0;owned⟨U+0007⟩ world⟨U+202E⟩⟨U+000D⟩");
    expect(screen).toContain("  | second line");
    expect(screen).toMatch(/someone else's text/);
  });

  it("shows hidden tag text, zero-width and separator characters as marks (L3)", () => {
    // "rm -rf /" written in Unicode tag characters, invisible on most terminals, between two visible words.
    const hidden = [..."rm -rf /"].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");
    const text = `Fix\u200bthe${hidden}build\u2028now\u00a0\u2060ok\t.`;
    const lines = fenced(text, 200).join("\n");
    expect(lines).toContain("Fix⟨U+200B⟩the⟨U+E0072⟩⟨U+E006D⟩⟨U+E0020⟩⟨U+E002D⟩");
    expect(lines).toContain("build⟨U+2028⟩now⟨U+00A0⟩⟨U+2060⟩ok⟨U+0009⟩.");
    expect(lines).not.toMatch(/[\u{E0000}-\u{E007F}\u200b\u2028\u00a0\u2060\t]/u);
    expect(visible(text).length).toBeGreaterThan(text.length);
  });

  it("wraps each line to the terminal's width with the fence on every piece, never splitting a mark", () => {
    const lines = fenced(`${"a".repeat(100)}\u200b${"b".repeat(30)}`, 40);
    expect(lines.every((l) => l.startsWith("  | ") && [...l].length <= 40 + 6)).toBe(true);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join("")).toContain("⟨U+200B⟩");
    expect(lines.some((l) => /⟨U\+200B$|^ {2}\| [0-9A-F]{0,3}⟩/.test(l))).toBe(false);
  });

  it("wraps by display width: wide characters and emoji take two columns, and the fence stays on every visual row", () => {
    expect(columnsOf("漢".codePointAt(0)!)).toBe(2);
    expect(columnsOf("😀".codePointAt(0)!)).toBe(2);
    expect(columnsOf("Ａ".codePointAt(0)!)).toBe(2);
    expect(columnsOf("a".codePointAt(0)!)).toBe(1);
    const rows = fenced("漢".repeat(76) + "  caps: 0.01 USD", 80);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith("  | ")).toBe(true);
      expect(displayWidth(row)).toBeLessThanOrEqual(80);
    }
    expect(rows.map((r) => r.slice(4)).join("")).toBe("漢".repeat(76) + "  caps: 0.01 USD");
    for (const row of fenced("😀".repeat(100), 40)) expect(displayWidth(row)).toBeLessThanOrEqual(40);
  });

  it("marks combining characters, so none is drawn over the character before it", () => {
    expect(visible("e\u0301 a\u20dd")).toBe("e⟨U+0301⟩ a⟨U+20DD⟩");
  });

  it("approves only on a typed yes; anything else declines", async () => {
    expect(await new TerminalPrompter(term("y").terminal).ask(view)).toBe("approve");
    expect(await new TerminalPrompter(term("YES").terminal).ask(view)).toBe("approve");
    expect(await new TerminalPrompter(term("").terminal).ask(view)).toBe("decline");
    expect(await new TerminalPrompter(term("sure").terminal).ask(view)).toBe("decline");
  });

  it("approves nothing unless both standard input and output are terminals: `yes | runner run` gets no answer (L8)", async () => {
    const piped = term("y", { inputIsTTY: false });
    expect(await new TerminalPrompter(piped.terminal).ask(view)).toBe("later");
    expect(piped.asked).toEqual([]);
    expect(await new TerminalPrompter(term("y", { outputIsTTY: false }).terminal).ask(view)).toBe("later");
  });

  it("never approves words too long to show whole: they can only be declined, or left waiting (L3)", async () => {
    const long = { ...view, inputs: [{ input: "instructions", text: "x".repeat(SHOWN_CHARS + 1) }] };
    expect(askScreen(long).cut).toBe(true);
    expect(askScreen(long).screen).not.toContain("xxxxxxxxxx");
    const yes = term("y");
    expect(await new TerminalPrompter(yes.terminal).ask(long)).toBe("decline");
    expect(yes.asked).toEqual(["Decline it? [y/N] "]);
    expect(await new TerminalPrompter(term("").terminal).ask(long)).toBe("later");
    const many = { ...view, inputs: [{ input: "instructions", text: Array.from({ length: MAX_LINES + 1 }, () => "l").join("\n") }] };
    expect(askScreen(many).cut).toBe(true);
  });

  it("abandons the question on a local stop (L1)", async () => {
    const stop = new AbortController();
    const waiting = term("", { question: (_q, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    const answer = new TerminalPrompter(waiting.terminal).ask(view, stop.signal);
    stop.abort();
    expect(await answer).toBe("later");
    stop.abort();
    expect(await new TerminalPrompter(term("y").terminal).ask(view, stop.signal)).toBe("later");
  });
});
