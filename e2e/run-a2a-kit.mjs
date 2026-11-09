// Decision 142: the A2A compatibility kit (a2aproject/a2a-tck) against Podster's inbound A2A, on the local stack.
//
//   node run-a2a-kit.mjs --kit <a2a-tck checkout with its .venv> [--skip-build] [--level must]
//
// The kit's client sends no credentials, and Podster's /a2a needs an agent's OAuth token. So this starts the real gateway and
// API, signs a person up, connects one agent with tasks offered to it, takes the agent's /a2a token through the same consent
// as any client, and puts a small proxy in front of the gateway on 127.0.0.1. The proxy adds that bearer to each request and
// points the agent card's interface URLs at itself. It changes nothing else, and Podster's own checks are untouched. The kit
// runs over JSON-RPC only, the one binding Podster serves.
//
// Results are in the kit's reports/ folder. Profile exceptions (decision 141) are in docs/spec/A2A-PROFILE.md.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkedA2aToken, McpAgent, Person, Target } from "./lib.mjs";
import { freePort, prepareStack, startGateway } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const kit = option("--kit");
if (!kit) {
  console.error("Pass --kit <path to an a2a-tck checkout with its .venv installed>.");
  process.exit(2);
}

const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild: process.argv.includes("--skip-build"), apiVars: { A2A_TOKEN_KEY: randomBytes(32).toString("hex") } });
const port = await freePort();
const base = `http://localhost:${port}`;
const vars = { AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: base, ENABLE_PASSWORD_SIGNIN: "true" };
const { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, inspectorPort: await freePort() });
const deadline = Date.now() + 120_000;
for (;;) {
  const up = await fetch(`${base}/.well-known/agent-card.json`).catch(() => null);
  if (up?.status === 200) break;
  if (Date.now() > deadline || stack.exitCode !== null) {
    console.error(log.join("").slice(-3000));
    stop();
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 500));
}

// One agent with something to read: tasks offered to it, in a room it's a member of.
const target = new Target(base, { pollMs: 150 });
const owner = await Person.signUp(target, "Kit owner");
const room = await owner.createRoom("A2A kit");
const lead = await McpAgent.connect(target, owner, "Kit lead");
const agent = await McpAgent.connect(target, owner, "Kit agent");
await owner.addAgent(room, lead, "member");
await owner.addAgent(room, agent, "member");
for (const title of ["Kit task one", "Kit task two", "Kit task three"]) {
  await lead.must("create_task", { workspace_id: room, title, instructions: "For the compatibility kit.", assignee: agent.id });
}
const token = await linkedA2aToken(target, owner, agent);

const proxyPort = await freePort();
const proxyBase = `http://127.0.0.1:${proxyPort}`;
const proxy = createServer(async (req, res) => {
  try {
    await forward(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_upstream_failed" }));
  }
});
/** One request to the gateway, with the agent's bearer, and the card's URLs pointed at the proxy. */
async function forward(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (!["host", "connection", "content-length", "authorization"].includes(name)) headers.set(name, String(value));
  headers.set("authorization", `Bearer ${token}`);
  const upstream = await fetch(`${base}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: "manual" });
  let body = Buffer.from(await upstream.arrayBuffer());
  if (req.url.includes("agent-card.json")) body = Buffer.from(body.toString("utf8").replaceAll(base, proxyBase));
  const out = {};
  upstream.headers.forEach((value, name) => {
    if (!["content-length", "content-encoding", "transfer-encoding"].includes(name)) out[name] = value;
  });
  res.writeHead(upstream.status, out).end(body);
}
await new Promise((done) => proxy.listen(proxyPort, "127.0.0.1", done));
console.log(`Podster at ${base}, the kit's proxy at ${proxyBase}, room ${room}, agent ${agent.id}.`);

const args = ["run_tck.py", "--sut-host", proxyBase, "--transport", "jsonrpc", ...(option("--level") ? ["--level", option("--level")] : [])];
const code = await new Promise((done) => {
  const proc = spawn(join(kit, ".venv/bin/python"), args, { cwd: kit, stdio: "inherit" });
  proc.on("exit", (status) => done(status ?? 1));
});
proxy.close();
stop();
console.log(`\nThe kit exited ${code}. Its report is in ${join(kit, "reports")}.`);
process.exit(code);
