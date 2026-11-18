/**
 * The owner's local stop (decision 29's condition 4 as the owner ruled it on 2026-11-17; S-43). `stop` is a Runner command
 * the machine's owner runs: it writes a stop request into the running Runner's home, naming that Runner's lock by its
 * nonce, and the Runner, which watches for it, ends any run at once and then calls nothing until restarted.
 *
 * It sends no signal to a process ID, so it can never stop some other program that reused one. A stop request naming an
 * earlier Runner's nonce is ignored: the nonce binding is enough, so nothing is cleared when a Runner starts.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockHolder } from "./lock.js";

export const STOP_FILE = "stop.request";
/** How often the request is looked for, beside the folder watch, which isn't reliable on every system. */
export const STOP_POLL_MS = 200;

/**
 * Asks the Runner running from this home to stop. False when none is running: no lock, or a lock held by `pair` or
 * `forget`, which run no task and aren't stopped this way (L2 on #458).
 */
export async function requestStop(home: string): Promise<boolean> {
  const holder = await lockHolder(home);
  if (!holder || holder.command !== "run") return false;
  await writeFile(join(home, STOP_FILE), holder.nonce, { mode: 0o600 });
  return true;
}

/** Clears a stop request left from before this Runner started. */
export async function clearStop(home: string): Promise<void> {
  await rm(join(home, STOP_FILE), { force: true });
}

/** Calls `onStop` once, as soon as a stop request naming `nonce` appears. Answers a function that stops watching. */
export function watchStop(home: string, nonce: string, onStop: () => void): () => void {
  const path = join(home, STOP_FILE);
  let fired = false;
  let checking = false;
  const check = async () => {
    if (fired || checking) return;
    checking = true;
    try {
      const text = await readFile(path, "utf8").catch(() => null);
      if (text !== null && text.trim() === nonce && !fired) {
        fired = true;
        dispose();
        onStop();
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), STOP_POLL_MS);
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(home, () => void check());
    watcher.on("error", () => undefined);
  } catch {
    watcher = null;
  }
  function dispose() {
    clearInterval(timer);
    watcher?.close();
  }
  void check();
  return dispose;
}
