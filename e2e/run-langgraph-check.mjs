// Decision 143's outbound check: starts LangGraph's own A2A server (`langgraph-api` 0.17.1) with the trivial graph in
// langgraph/, on 127.0.0.1, then runs apps/api's a2a-langgraph.spec.ts, whose test runtime forwards the made-up endpoint host
// langgraph.example.com to it. Podster's real send, read-back and cancel code talk to LangGraph's real answers.
//
//   node run-langgraph-check.mjs --langgraph <path to the `langgraph` CLI in a venv with langgraph-api==0.17.1 and langgraph-cli[inmem]>
//
// The owner approved starting this server locally on 2026-11-09. Nothing else from outside the repository runs. The API's
// failpoints build must be current (`npm test` in apps/api makes it), since the spec drives the queue consumer directly.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import { freePort } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--langgraph");
const cli = at === -1 ? process.env.PODSTER_LANGGRAPH_BIN : process.argv[at + 1];
if (!cli) {
  console.error("Pass --langgraph <path to the langgraph CLI>, or set PODSTER_LANGGRAPH_BIN.");
  process.exit(2);
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(cli, ["dev", "--no-browser", "--no-reload", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: join(here, "langgraph"),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: childEnv({ LANGGRAPH_CLI_NO_ANALYTICS: "1", LANGSMITH_TRACING: "false" }),
});
const log = [];
server.stdout.on("data", (chunk) => log.push(String(chunk)));
server.stderr.on("data", (chunk) => log.push(String(chunk)));
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};

let assistant;
const deadline = Date.now() + 90_000;
while (!assistant) {
  const found = await fetch(`${base}/assistants/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graph_id: "podster_test" }) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  assistant = found?.[0]?.assistant_id;
  if (assistant) break;
  if (Date.now() > deadline || server.exitCode !== null) {
    console.error("LangGraph's server didn't start.\n" + log.join("").slice(-2000));
    stop();
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 1000));
}
const card = await (await fetch(`${base}/a2a/${assistant}/.well-known/agent-card.json`)).json().catch(() => null);
console.log(`LangGraph ${base}, assistant ${assistant}, card protocol ${card?.protocolVersion ?? card?.supportedInterfaces?.[0]?.protocolVersion ?? "unknown"}.`);

const code = await new Promise((done) => {
  const vitest = join(here, "../apps/api/node_modules/.bin/vitest");
  const proc = spawn(vitest, ["run", "test/a2a-langgraph.spec.ts", "--reporter=verbose"], {
    cwd: join(here, "../apps/api"),
    stdio: "inherit",
    env: { ...process.env, PODSTER_LANGGRAPH_URL: base, PODSTER_LANGGRAPH_ASSISTANT: assistant },
  });
  proc.on("exit", (status) => done(status ?? 1));
});
stop();
process.exit(code);
