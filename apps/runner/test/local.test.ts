// M7 step 8 on the owner's machine: the one-Runner-per-agent lock (decision 227), the owner's local stop, the run record on
// disk, and the ask screen. Each runs in a fresh temporary folder.
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AskView } from "../src/core/lifecycle.js";
import { emptyRuns } from "../src/core/runs.js";
import { FileRunStore } from "../src/node/file-runs.js";
import { acquireLock, LOCK_FILE, LockRefused, lockHolder, processAlive, STALE_UNREADABLE_MS } from "../src/node/lock.js";
import { clearStop, requestStop, STOP_FILE, watchStop } from "../src/node/local-stop.js";
import { askScreen, fenced, SHOWN_CHARS, TerminalPrompter } from "../src/node/prompter.js";

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

describe("the run record on disk", () => {
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
    caps: { spend_micro_usd: 2_000_000, run_time_ms: 1_800_000, turns: 40, output_tokens: 50_000, max_tokens: 4_096 },
    inputs: [{ input: "title", text: "Hello\u001b[2J\u001b]0;owned\u0007 world‮\r\nsecond line" }],
  };

  it("shows the task's words fenced, with no escape, control or direction characters, and bounded", () => {
    const screen = askScreen(view);
    expect(screen).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    expect(screen).toContain("  | Hello�[2J�]0;owned� world�");
    expect(screen).toContain("  | second line");
    expect(screen).toMatch(/someone else's text/);
    const long = fenced("x".repeat(SHOWN_CHARS + 50));
    expect(long).toContain("[cut: 50 more characters not shown]");
    expect(fenced(Array.from({ length: 200 }, () => "l").join("\n"))).toContain("[cut: 120 more lines not shown]");
  });

  it("approves only on a typed yes; anything else declines; with no terminal there is no answer", async () => {
    const written: string[] = [];
    const answer = async (typed: string) => new TerminalPrompter({ isTTY: true, write: (t) => void written.push(t), question: async () => typed }).ask(view);
    expect(await answer("y")).toBe("approve");
    expect(await answer("YES")).toBe("approve");
    expect(await answer("")).toBe("decline");
    expect(await answer("sure")).toBe("decline");
    expect(await new TerminalPrompter({ isTTY: false, write: () => undefined, question: async () => "y" }).ask(view)).toBe("later");
  });
});
