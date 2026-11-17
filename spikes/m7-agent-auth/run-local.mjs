// Spike A, part 1: the stand-in Runner (runner.mjs) as separate Node processes against the real gateway and the release
// build of the API under `wrangler dev`, on this machine only. Reuses e2e/stack.mjs, which keeps everything in e2e/.local
// and throws it away. No Cloudflare account, no token, nothing remote.
//
//   node run-local.mjs [--skip-build]
//
// Writes results/local-<date>.json with each step's outcome, and exits non-zero if any expectation failed.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, groupGone, prepareStack, startGateway } from "../../e2e/stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(here, ".local");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild: process.argv.includes("--skip-build") });
const port = await freePort();
const base = `http://localhost:${port}`;
const vars = {
  AUTH_SECRET: randomBytes(32).toString("base64"),
  ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }),
  BASE_URL: base,
  ENABLE_PASSWORD_SIGNIN: "true",
};
// "log" so the Workers' own console lines are captured, for the check that nothing secret reached them.
const { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, inspectorPort: await freePort(), logLevel: "log" });

const steps = [];
let failed = 0;
function record(step, expected, actual, pass) {
  steps.push({ step, expected, actual, pass });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${step}: ${JSON.stringify(actual)}`);
}

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });

async function signUp() {
  const res = await post("/api/auth/sign-up/email", { email: `${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(16).toString("hex"), name: "Spike owner" });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return cookie;
}

async function waitForStack() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && stack.exitCode === null) {
    try {
      const cookie = await signUp();
      const me = await fetch(`${base}/api/v1/me`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
      if (me.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  console.error(log.join(""));
  throw new Error("the local stack didn't come up");
}

/** Runs runner.mjs as its own process. `onLine` sees each JSON line as it arrives. Resolves with all lines and the exit code. */
function runner(command, stateDir, onLine = () => {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(here, "runner.mjs"), command, "--base", base, "--state", stateDir], { cwd: here, stdio: ["ignore", "pipe", "pipe"] });
    const lines = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        lines.push(line);
        onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("exit", (code) => done({ code, lines, stderr }));
  });
}
const last = (result) => result.lines.at(-1);

let code = 1;
try {
  await waitForStack();
  console.log(`local stack is up at ${base}`);
  const cookie = await signUp();
  const orgs = await (await fetch(`${base}/api/orgs`, { headers: { cookie } })).json();
  const org = orgs.organizations[0].id;
  const runnerState = join(scratch, "runner-a");

  // 1. Sign in from a machine: register, a person claims, the agent calls a capability.
  let approval;
  let claimed;
  const first = await runner("connect", runnerState, async (line) => {
    if (line.event !== "approval_required") return;
    approval = line;
    // What a person does: open the link the agent showed, check the code, pick the organization and connect.
    const link = new URL(line.verification_uri_complete);
    const agentId = link.searchParams.get("agent_id");
    const page = await fetch(link, { headers: { cookie } });
    const res = await post("/claim", { agent_id: agentId, user_code: line.user_code, org_id: org, name: "Spike Runner" }, { cookie });
    claimed = { page_status: page.status, status: res.status, body: await res.json() };
  });
  const podsterAgent = claimed?.body?.agent_id;
  record("1a approval is device authorization, shown to the person by the machine", "method device_authorization; link is /claim", { method: approval?.method, link_path: approval && new URL(approval.verification_uri).pathname, code_in_link_query: approval ? new URL(approval.verification_uri_complete).searchParams.has("code") : null }, approval?.method === "device_authorization");
  record("1b the person's claim succeeds", "200 with a Podster agent ID", { page: claimed?.page_status, status: claimed?.status, agent: podsterAgent }, claimed?.status === 200 && typeof podsterAgent === "string");
  const connected = first.lines.find((l) => l.event === "connected");
  record("1c the SDK's approval wait ends active without a browser", "status active with grants", connected ?? last(first), connected?.status === "active");
  record("1d read_inbox from the first process", "ok", last(first), last(first)?.event === "read_inbox" && last(first)?.ok === true);

  // 2. Restart: a new process with only the stored key, no browser and no person.
  const second = await runner("inbox", runnerState);
  record("2a reconnect by stored key in a new process", `get_identity is ${podsterAgent}, read_inbox ok`, last(second), last(second)?.event === "reconnected" && last(second)?.podster_agent === podsterAgent);
  record("2b the key file is owner-only", "600", last(second)?.file_mode, last(second)?.file_mode === "600");
  const status = await runner("status", runnerState);
  record("2c /agent/status with the host key", "active", last(status), last(status)?.status === "active");

  // 3. A different key under the same agent ID is refused.
  const forged = join(scratch, "runner-forged");
  cpSync(runnerState, forged, { recursive: true });
  const { generateKeypair } = await import("@auth/agent");
  const forgedFile = join(forged, "agent-auth.json");
  const stored = JSON.parse(readFileSync(forgedFile, "utf8"));
  for (const [key, value] of Object.entries(stored)) {
    if (!key.includes(":agent:")) continue;
    const connection = JSON.parse(value);
    connection.agentKeypair = await generateKeypair();
    stored[key] = JSON.stringify(connection);
  }
  writeFileSync(forgedFile, JSON.stringify(stored), { mode: 0o600 });
  const wrongKey = await runner("inbox", forged);
  record("3a another key with the same agent ID", "refused", last(wrongKey), last(wrongKey)?.event === "error");

  // 4. The plugin's own key rotation and disconnect, through the public gateway.
  const rotateCopy = join(scratch, "runner-rotate");
  cpSync(runnerState, rotateCopy, { recursive: true });
  const rotate = await runner("rotate", rotateCopy);
  record("4a SDK rotateAgentKey", "refused: /agent/rotate-key is private", last(rotate), last(rotate)?.event === "error");
  const afterRotate = await runner("inbox", runnerState);
  record("4b the original key still works after the refused rotation", "reconnected", last(afterRotate), last(afterRotate)?.event === "reconnected");
  const disconnectCopy = join(scratch, "runner-disconnect");
  cpSync(runnerState, disconnectCopy, { recursive: true });
  const sdkDisconnect = await runner("disconnect", disconnectCopy);
  const stillActive = await runner("inbox", runnerState);
  record("4c SDK disconnectAgent", "returns, deletes the local copy, but the server keeps the agent (/agent/revoke is private)", { sdk: last(sdkDisconnect), original_after: last(stillActive)?.event }, last(sdkDisconnect)?.event === "sdk_disconnect_returned" && last(stillActive)?.event === "reconnected");

  // 5. The owner disconnects the agent in Podster. The running Runner's next call is refused.
  const disconnect = await post(`/api/agents/${podsterAgent}/disconnect`, {}, { cookie, "idempotency-key": randomBytes(8).toString("hex") });
  record("5a the owner's disconnect in Podster", "200", disconnect.status, disconnect.status === 200);
  const afterDisconnect = await runner("inbox", runnerState);
  record("5b reconnect by key after a disconnect", "refused", last(afterDisconnect), last(afterDisconnect)?.event === "error");
  const statusAfter = await runner("status", runnerState);
  record("5c /agent/status after a disconnect", "revoked or refused", last(statusAfter), last(statusAfter)?.event === "error" || last(statusAfter)?.status === "revoked");

  // 6. Podster's reconnect brings the agent back, not the old key. A new key, claimed onto the same agent, works.
  const reconnect = await post(`/api/agents/${podsterAgent}/reconnect`, {}, { cookie, "idempotency-key": randomBytes(8).toString("hex") });
  const oldKeyAfterReconnect = await runner("inbox", runnerState);
  record("6a the old key after Podster's reconnect", "still refused", { reconnect: reconnect.status, runner: last(oldKeyAfterReconnect) }, reconnect.status === 200 && last(oldKeyAfterReconnect)?.event === "error");
  const freshState = join(scratch, "runner-b");
  let relinked;
  const fresh = await runner("connect", freshState, async (line) => {
    if (line.event !== "approval_required") return;
    const agentId = new URL(line.verification_uri_complete).searchParams.get("agent_id");
    const res = await post("/claim", { agent_id: agentId, user_code: line.user_code, org_id: org, link_agent_id: podsterAgent }, { cookie });
    relinked = { status: res.status, body: await res.json() };
  });
  const freshInbox = await runner("inbox", freshState);
  record("6b a new key claimed onto the same agent", `200, get_identity is ${podsterAgent}`, { claim: relinked, connect: last(fresh), inbox: last(freshInbox) }, relinked?.status === 200 && last(freshInbox)?.podster_agent === podsterAgent);

  // 7. Nothing secret in the Workers' logs or the Runner's output: no private key, no JWT, no approval code.
  const secrets = [];
  for (const dir of [runnerState, freshState]) {
    const all = JSON.parse(readFileSync(join(dir, "agent-auth.json"), "utf8"));
    for (const value of Object.values(all)) {
      const parsed = JSON.parse(value);
      for (const pair of [parsed.keypair, parsed.agentKeypair]) if (pair?.privateKey?.d) secrets.push(pair.privateKey.d);
    }
  }
  const logs = log.join("");
  const outputs = JSON.stringify([first, second, status, wrongKey, rotate, afterRotate, sdkDisconnect, stillActive, afterDisconnect, statusAfter, oldKeyAfterReconnect, fresh, freshInbox].map((r) => r.lines.filter((l) => l.event !== "approval_required")));
  const leaks = {
    private_key_in_logs: secrets.some((d) => logs.includes(d)),
    private_key_in_runner_output: secrets.some((d) => outputs.includes(d)),
    jwt_in_logs: /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/.test(logs),
    approval_code_in_logs: Boolean(approval?.user_code) && logs.includes(approval.user_code),
    approval_code_in_claim_url_logged: /\/claim\?[^\s"]*code=/.test(logs),
  };
  record("7 nothing secret in logs or Runner output", "all false", leaks, Object.values(leaks).every((v) => v === false));
  writeFileSync(join(scratch, "workers.log"), logs);
  code = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  console.error(log.join("").slice(-4000));
} finally {
  stop();
  await groupGone(stack.pid);
  mkdirSync(join(here, "results"), { recursive: true });
  const at = new Date().toISOString();
  const versions = { node: process.version, sdk: JSON.parse(readFileSync(join(here, "node_modules/@auth/agent/package.json"), "utf8")).version, plugin: JSON.parse(readFileSync(join(gateway, "node_modules/@better-auth/agent-auth/package.json"), "utf8")).version };
  writeFileSync(join(here, "results", `local-${at.slice(0, 10)}.json`), `${JSON.stringify({ kind: "local", at, versions, failed, steps }, null, 2)}\n`);
  console.log(`${steps.length - failed} passed, ${failed} failed`);
  if (!existsSync(join(here, "results"))) code = 1;
}
process.exit(code);
