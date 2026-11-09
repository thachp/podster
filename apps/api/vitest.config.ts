import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key per run. Tests sign as the gateway, and the Worker verifies with the public half.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });

// Wake's outbound requests land here, so tests can see them and choose how the far end answers.
const hookRequests: { host: string; path: string; signature: string | null; agent: string | null; authorization: string | null; a2aVersion: string | null; body: string }[] = [];

// GetTask and CancelTask answers a test scripts for each remote task ID (M3 step 13). Each read takes the next one, and the
// last repeats. An answer is a JSON-RPC `result`, or `{ error }`, or `{ raw }` for a body sent as is, or `{ httpStatus }`.
const scripts = new Map<string, unknown[]>();
function scripted(key: string) {
  const answers = scripts.get(key);
  if (!answers?.length) return undefined;
  return answers.length > 1 ? answers.shift() : answers[0];
}

// An A2A endpoint's answers to SendMessage, chosen by path (M3 step 12).
function a2aAnswer(path: string, body: string) {
  const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
  const id = parsed.id ?? null;
  const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
  if (parsed.method === "GetTask" || parsed.method === "CancelTask") {
    const answer: any = scripted(parsed.method === "GetTask" ? parsed.params?.id : `${parsed.params?.id}:cancel`);
    if (answer?.raw !== undefined) return new Response(answer.raw, { headers: { "content-type": "application/json" } });
    if (answer?.error) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: answer.error }));
    if (answer?.httpStatus) return new Response(null, { status: answer.httpStatus });
    return rpc(answer ?? { id: parsed.params?.id, status: { state: parsed.method === "CancelTask" ? "TASK_STATE_CANCELED" : "TASK_STATE_SUBMITTED" } });
  }
  // A server that ignores returnImmediately and answers once its work is done (decision 174), with or without artifacts.
  if (path.startsWith("/a2a/blocking-empty")) return rpc({ task: { id: `remote-${path.split("/").pop()}`, contextId: "c", status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ text: "Task completed successfully" }] } } } });
  if (path.startsWith("/a2a/blocking")) return rpc({ task: { id: `remote-${path.split("/").pop()}`, contextId: "c", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ name: "Reply", parts: [{ text: "Done at once." }, { url: "https://example.com/blocked" }] }] } });
  if (path.startsWith("/a2a/message")) return rpc({ message: { messageId: "m-1", role: "ROLE_AGENT", parts: [{ text: "Noted." }] } });
  if (path.startsWith("/a2a/error")) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "no" } }));
  if (path.startsWith("/a2a/big")) return rpc({ task: { id: "remote-big", status: { state: "TASK_STATE_SUBMITTED" } }, padding: "x".repeat(70 * 1024) });
  if (path.startsWith("/a2a/bad-id")) return rpc({ task: { id: "has a space", status: { state: "TASK_STATE_SUBMITTED" } } });
  if (path.startsWith("/a2a/nothing")) return rpc({});
  return rpc({ task: { id: `remote-${path.split("/").pop()}`, contextId: "c", status: { state: "TASK_STATE_SUBMITTED" } } });
}

async function fakeHook(request: Request) {
  const url = new URL(request.url);
  if (url.hostname === "hook-log.example.com") return new Response(JSON.stringify(hookRequests));
  if (url.hostname === "a2a-script.example.com") {
    const { key, answers } = await request.json() as { key: string; answers: unknown[] };
    scripts.set(key, answers);
    return new Response("ok");
  }
  const body = await request.text();
  hookRequests.push({ host: url.hostname, path: url.pathname, signature: request.headers.get("x-podster-signature"), agent: request.headers.get("user-agent"), authorization: request.headers.get("authorization"), a2aVersion: request.headers.get("a2a-version"), body });
  if (url.hostname === "langgraph.example.com") return langgraph(request, url, body);
  if (url.pathname.startsWith("/hang")) await new Promise((resolve) => setTimeout(resolve, 5000));
  if (url.pathname.startsWith("/fail")) return new Response("no", { status: 500 });
  if (url.pathname.startsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
  if (url.pathname.startsWith("/a2a")) return a2aAnswer(url.pathname, body);
  return new Response("ok");
}

// LangGraph's A2A server, when a2a-langgraph.spec.ts runs against one (decision 143). The API sends to the made-up public name
// langgraph.example.com, which passes egress policy as any agent's endpoint would, and only this test runtime forwards it to
// the local server named by PODSTER_LANGGRAPH_URL. Podster's own egress rules are unchanged.
async function langgraph(request: Request, url: URL, body: string) {
  const base = process.env.PODSTER_LANGGRAPH_URL;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return new Response("no LangGraph server for this run", { status: 502 });
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "a2a-version", "x-podster-signature", "authorization", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return fetch(`${base}${url.pathname}`, { method: request.method, headers, body: request.method === "GET" ? undefined : body, redirect: "manual" });
}

/** Each `path` and `method` in the contract, read line by line, since this package has no YAML parser. */
function contractRoutes() {
  const text = readFileSync(new URL("../../packages/contracts/openapi.yaml", import.meta.url), "utf8");
  const routes: { path: string; method: string; operation: string }[] = [];
  let path = "";
  let method = "";
  for (const line of text.split("\n")) {
    const p = line.match(/^  (\/[^:]+):\s*$/);
    if (p) { path = p[1]; continue; }
    const m = line.match(/^    (get|post|put|delete):/);
    if (m && path) method = m[1].toUpperCase();
    const op = line.match(/operationId: ([A-Za-z0-9]+)/);
    if (op && path && method) { routes.push({ path, method, operation: op[1] }); method = ""; }
  }
  const operations = text.match(/operationId: /g)?.length ?? 0;
  if (routes.length !== operations) throw new Error(`read ${routes.length} routes of ${operations} operations`);
  return routes;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: fakeHook,
        queueProducers: { WAKE: { queueName: "podster-wake-test" }, SCAN: { queueName: "podster-scan-test" }, A2A: { queueName: "podster-a2a-test" } },
        // The test pool can't run the real consumer. This one records what actually crosses the queue.
        workers: [
          {
            name: "wake-queue-recorder",
            modules: true,
            script: `export default { async queue(batch) { for (const message of batch.messages) { await fetch("https://hook-record.example.com/__queue", { method: "POST", body: JSON.stringify(message.body) }); message.ack(); } } };`,
            compatibilityDate: "2026-08-01",
            outboundService: fakeHook,
            queueConsumers: { "podster-wake-test": { maxBatchTimeout: 0.05 }, "podster-scan-test": { maxBatchTimeout: 0.05 }, "podster-a2a-test": { maxBatchTimeout: 0.05 } },
          },
        ],
        bindings: {
          ASSERTION_KEYS: JSON.stringify({ test: pub.x }),
          SCANNER_SECRET: "test-scanner-secret",
          // Test operators only (M4 step 10). Naming real ones is the owner's call.
          OPERATORS: "per_operator_one, per_operator_two",
          // A test value only. The real key is the owner's to set (decision 122).
          A2A_TOKEN_KEY: "0f".repeat(32),
          // Set only by e2e/run-langgraph-check.mjs. Empty, a2a-langgraph.spec.ts skips.
          TEST_LANGGRAPH_ASSISTANT: process.env.PODSTER_LANGGRAPH_URL ? (process.env.PODSTER_LANGGRAPH_ASSISTANT ?? "") : "",
          TEST_WRANGLER: readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
          TEST_D1_SCHEMA: ["0001_membership_index.sql", "0002_room_status.sql", "0003_membership_by_org.sql", "0004_ownerless_rooms.sql", "0005_public_workroom_index.sql", "0006_public_explore_order.sql"].map((name) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8")).join("\n").replace(/--.*$/gm, ""),
          TEST_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
          // Every route the contract lists, for the route-list test (M4 step 7), and the public view's schema.
          TEST_API_ROUTES: JSON.stringify(contractRoutes()),
          TEST_PUBLIC_VIEW_SCHEMA: readFileSync(new URL("../../packages/contracts/public-workroom-view.schema.json", import.meta.url), "utf8"),
        },
      },
    }),
  ],
  test: { testTimeout: 30000 },
});
