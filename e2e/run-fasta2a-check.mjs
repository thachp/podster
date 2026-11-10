// Decision 143's backup outbound check: starts pydantic's fasta2a (2.1.1) with the trivial agent in fasta2a/, on 127.0.0.1,
// then runs apps/api's a2a-fasta2a.spec.ts, whose test runtime forwards the made-up endpoint host fasta2a.example.com to it.
//
//   node run-fasta2a-check.mjs --python <a venv's python with fasta2a==2.1.1 and uvicorn==0.38.0>
//
// The owner approved starting it on 2026-11-10. The API's failpoints build must be current (`npm test` in apps/api makes it).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import { freePort } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--python");
const python = at === -1 ? process.env.PODSTER_FASTA2A_PYTHON : process.argv[at + 1];
if (!python) {
  console.error("Pass --python <path to a venv's python with fasta2a>, or set PODSTER_FASTA2A_PYTHON.");
  process.exit(2);
}
const RUN_SECONDS = "2";
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(python, ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
  cwd: join(here, "fasta2a"),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: childEnv({ RUN_SECONDS }),
});
const log = [];
server.stdout.on("data", (chunk) => log.push(String(chunk)));
server.stderr.on("data", (chunk) => log.push(String(chunk)));
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
const deadline = Date.now() + 30_000;
let card;
while (!card) {
  card = await fetch(`${base}/.well-known/agent-card.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (card) break;
  if (Date.now() > deadline || server.exitCode !== null) {
    console.error("fasta2a didn't start.\n" + log.join("").slice(-2000));
    stop();
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 300));
}
console.log(`fasta2a ${base}, card "${card.name}", protocol ${card.protocolVersion ?? "unstated"}.`);
const code = await new Promise((done) => {
  const proc = spawn(join(here, "../apps/api/node_modules/.bin/vitest"), ["run", "test/a2a-fasta2a.spec.ts", "--reporter=verbose"], {
    cwd: join(here, "../apps/api"),
    stdio: "inherit",
    env: { ...process.env, PODSTER_FASTA2A_URL: base, PODSTER_FASTA2A_RUN_SECONDS: RUN_SECONDS },
  });
  proc.on("exit", (status) => done(status ?? 1));
});
stop();
const warnings = log.join("").split("\n").filter((l) => /warning|error|traceback/i.test(l)).length;
console.log(`fasta2a's own log: ${warnings} warning or error lines.`);
process.exit(code);
