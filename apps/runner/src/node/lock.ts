/**
 * One Runner per agent on this machine (decision 227; R-23; S-30). A Runner's home holds exactly one paired agent, so a
 * lock on the home is a lock on the agent: `pair`, `run` and `forget` each take it, and a second one on the same home
 * refuses while the first is alive. Across machines this is best effort, as decision 227 accepts: nothing here can see
 * another machine's Runner.
 *
 * The lock is `run.lock` in the home, made with `O_EXCL` so only one process can make it, owner-only, naming the holder's
 * process ID, this machine's name, when it was taken and a random nonce. Nothing secret is in it.
 *
 * **A stale lock is handled safely.** A lock whose holder is gone (a crash, a power cut) is taken over, but only:
 * - when it names this machine, since a process on another one can't be checked; otherwise Runner refuses and says so;
 * - when its process is no longer alive; a live one, or one this user may not signal, refuses, so a reused process ID
 *   errs toward refusing, never toward two Runners;
 * - under a takeover guard, itself made with `O_EXCL`, and only if the lock still holds exactly what was read as stale,
 *   so two Runners taking over at once can't both win.
 * A lock that can't be read is taken over only once it's older than a minute (a crash while it was being written);
 * younger, it may be being written now, and Runner refuses. A takeover guard left by a crash is never removed by Runner:
 * it says so and names the file, and replacing a Runner stays explicit (R-23).
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_FILE = "run.lock";
const GUARD_FILE = "run.lock.takeover";
/** How old an unreadable lock, or a takeover guard, must be before it counts as left by a crash. */
export const STALE_UNREADABLE_MS = 60_000;

export type LockHolder = { pid: number; host: string; started_at: number; nonce: string };

export class LockRefused extends Error {
  readonly holder: LockHolder | null;
  constructor(message: string, holder: LockHolder | null = null) {
    super(message);
    this.name = "LockRefused";
    this.holder = holder;
  }
}

export type LockOptions = {
  pid?: number;
  host?: string;
  now?: () => number;
  /** Whether a process is alive. `kill(pid, 0)`: alive, or alive under another user (EPERM), both count as alive. */
  isAlive?: (pid: number) => boolean;
};

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parse(text: string): LockHolder | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!Number.isSafeInteger(v.pid) || (v.pid as number) <= 0 || typeof v.host !== "string" || !Number.isSafeInteger(v.started_at) || typeof v.nonce !== "string" || !/^[0-9a-f]{32}$/.test(v.nonce)) return null;
    return { pid: v.pid as number, host: v.host, started_at: v.started_at as number, nonce: v.nonce };
  } catch {
    return null;
  }
}

/** Makes `path` with `O_EXCL`, writes `text` and flushes it. False if it exists. */
async function create(path: string, text: string): Promise<boolean> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}

async function readIfThere(path: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type HeldLock = { holder: LockHolder; path: string; release(): Promise<void> };

/** Reads who holds the home's lock, if anyone. */
export async function lockHolder(home: string): Promise<LockHolder | null> {
  const found = await readIfThere(join(home, LOCK_FILE));
  return found ? parse(found.text) : null;
}

/** Takes the home's lock, or refuses with `LockRefused`, saying why. */
export async function acquireLock(home: string, options: LockOptions = {}): Promise<HeldLock> {
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processAlive;
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const path = join(home, LOCK_FILE);
  const guard = join(home, GUARD_FILE);
  const holder: LockHolder = { pid, host, started_at: now(), nonce: randomBytes(16).toString("hex") };
  const text = JSON.stringify(holder);
  const held: HeldLock = {
    holder,
    path,
    async release() {
      // Only our own lock: never one a takeover has since replaced.
      const found = await readIfThere(path);
      if (found && parse(found.text)?.nonce === holder.nonce) await unlink(path).catch(() => undefined);
    },
  };

  for (let round = 0; round < 2; round++) {
    if (await create(path, text)) return held;
    const found = await readIfThere(path);
    if (!found) continue; // Released between the two: try once more.
    const other = parse(found.text);
    if (!other) {
      if (now() - found.mtimeMs < STALE_UNREADABLE_MS) throw new LockRefused(`Another Runner is starting in ${home}. Try again in a minute.`);
    } else {
      if (other.host !== host) throw new LockRefused(`A Runner on another machine holds ${path}. Runner can't check it from here. Stop it there, or remove that file if it isn't running.`, other);
      if (other.pid === pid || isAlive(other.pid)) throw new LockRefused(`Another Runner (process ${other.pid}) is already running for this agent. Stop it first with \`stop\`.`, other);
    }
    // Stale: its holder is gone. Taken over under the guard, only if the lock still holds what was read.
    if (!(await create(guard, text))) {
      const left = await readIfThere(guard);
      if (left && now() - left.mtimeMs >= STALE_UNREADABLE_MS) throw new LockRefused(`A takeover of ${path} didn't finish. If no Runner is running, remove ${guard} and try again.`);
      throw new LockRefused(`Another Runner is taking over ${path}. Try again in a minute.`);
    }
    try {
      const again = await readIfThere(path);
      if (again && again.text === found.text) {
        await unlink(path);
        if (await create(path, text)) return held;
        throw new LockRefused(`Another Runner took ${path} first.`);
      }
    } finally {
      await unlink(guard).catch(() => undefined);
    }
  }
  throw new LockRefused(`Another Runner holds ${path}. Try again in a minute.`);
}
