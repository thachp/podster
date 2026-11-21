// The spend ledger: one spike process at a time, and a run's whole cap charged before it starts, so a crash or a
// second process can't spend past the budget. Real child processes, a temporary folder, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { Ledger, scratchDir } from "../lib/ledger.mjs";
import { TOTAL_CAP_MICRO_USD } from "../lib/profile.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerUrl = pathToFileURL(join(root, "lib", "ledger.mjs")).href;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "m7o-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run a small script in a separate Node process with the ledger module. */
function child(script, dir) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { Ledger } from ${JSON.stringify(ledgerUrl)};\nconst dir = ${JSON.stringify(dir)};\n${script}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

test("a run's whole cap is charged before it starts and replaced by the real figure after", (t) => {
  const dir = tempDir(t);
  const l = new Ledger(dir).lock();
  t.after(() => l.unlock());
  const id = l.reserve("read", 200_000);
  assert.equal(l.read().total_micro_usd, 200_000);
  assert.equal(l.left(), TOTAL_CAP_MICRO_USD - 200_000);
  assert.equal(l.read().runs[0].settled, false);
  l.settle(id, 1_234);
  assert.equal(l.read().total_micro_usd, 1_234);
  assert.equal(Object.values(l.read().days)[0], 1_234);
  assert.deepEqual([l.read().runs[0].spent_micro_usd, l.read().runs[0].settled], [1_234, true]);
  assert.throws(() => l.settle(id, 0), /no open run/);
});

test("the ledger refuses to reserve or settle without the lock", (t) => {
  const dir = tempDir(t);
  assert.throws(() => new Ledger(dir).reserve("read", 1), /not locked/);
});

test("a process that crashes mid-run leaves its cap charged, and its lock in place", (t) => {
  const dir = tempDir(t);
  // The child locks, reserves a run, then dies without settling or unlocking.
  const r = child(`const l = new Ledger(dir).lock(); l.reserve("edit", 200000); process.kill(process.pid, "SIGKILL");`, dir);
  assert.equal(r.signal, "SIGKILL");
  const view = new Ledger(dir).read();
  assert.equal(view.total_micro_usd, 200_000);
  assert.deepEqual([view.runs[0].scenario, view.runs[0].spent_micro_usd, view.runs[0].settled], ["edit", 200_000, false]);
  // The stale lock refuses the next process, and says how to clear it.
  assert.throws(() => new Ledger(dir).lock(), (err) => /locked by another spike process/.test(err.message) && err.message.includes(join(dir, "spend.lock")));
  // Clearing it by hand, as the message says, lets the next run start with the crashed run still charged.
  rmSync(join(dir, "spend.lock"));
  const next = new Ledger(dir).lock();
  t.after(() => next.unlock());
  assert.equal(next.left(), TOTAL_CAP_MICRO_USD - 200_000);
});

test("a second process is refused while the first holds the lock", async (t) => {
  const dir = tempDir(t);
  // The first process takes the lock and waits; the second tries while it is held.
  const first = spawn(process.execPath, ["--input-type=module", "-e", `import { Ledger } from ${JSON.stringify(ledgerUrl)};\nconst l = new Ledger(${JSON.stringify(dir)}).lock(); l.reserve("read", 200000); console.log("locked"); setTimeout(() => {}, 10000);`], {
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => first.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    first.stdout.on("data", (d) => String(d).includes("locked") && resolve());
    first.on("exit", () => reject(new Error("first process exited early")));
  });
  const second = child(`try { new Ledger(dir).lock().reserve("edit", 200000); console.log("reserved"); } catch (e) { console.error(e.message); process.exit(3); }`, dir);
  assert.equal(second.status, 3);
  assert.match(second.stderr, /locked by another spike process \(pid \d+/);
  assert.doesNotMatch(second.stdout, /reserved/);
  assert.equal(new Ledger(dir).read().runs.length, 1);
});

test("unlock removes the lock so the next process can take it", (t) => {
  const dir = tempDir(t);
  const a = new Ledger(dir).lock();
  a.unlock();
  assert.equal(existsSync(join(dir, "spend.lock")), false);
  const b = new Ledger(dir).lock();
  b.unlock();
});

test("M7O_SCRATCH may name only a folder inside the spike's work/ folder", (t) => {
  const spike = tempDir(t);
  const work = join(spike, "work");
  assert.equal(scratchDir(spike, undefined), work);
  assert.equal(scratchDir(spike, ""), work);
  assert.equal(scratchDir(spike, "run-1"), join(work, "run-1"));
  assert.equal(scratchDir(spike, join(work, "run-2")), join(work, "run-2"));
  for (const bad of ["..", "../results", "/tmp", tmpdir(), join(spike, "workx"), spike]) {
    assert.throws(() => scratchDir(spike, bad), /inside the spike's work\/ folder/, bad);
  }
  // A link inside work/ that points out of it is refused too.
  mkdirSync(work, { recursive: true });
  const outside = tempDir(t);
  symlinkSync(outside, join(work, "escape"));
  assert.throws(() => scratchDir(spike, "escape"), /inside the spike's work\/ folder/);
});
