// Checks lib.mjs's `Target` against a local server that resets a connection the way Cloudflare's edge does now and then:
// a request written to a kept-alive connection is answered with a reset, before any byte of a response. Only a request
// that can't do a second thing is sent again, once, and the output says so; anything else fails as it did.
import { createServer } from "node:http";
import { Target, safeToRepeat } from "./lib.mjs";

const seen = [];
let resetMode = "none"; // "reused": reset a request on a connection that carried one before; "all": reset every request.
const server = createServer((req, res) => {
  const socket = req.socket;
  socket.uses = (socket.uses ?? 0) + 1;
  seen.push(`${req.method} ${req.url}`);
  req.resume();
  req.on("end", () => {
    if (resetMode === "all" || (resetMode === "reused" && socket.uses > 1)) {
      resetMode = resetMode === "all" ? "all" : "none";
      return socket.resetAndDestroy();
    }
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const target = new Target(`http://127.0.0.1:${server.address().port}`, { pollMs: 0 });

const said = [];
const log = console.log;
console.log = (...args) => said.push(args.join(" "));

const mcp = (method, params) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const json = { "content-type": "application/json" };
const cases = [
  ["a GET", "/api/orgs", {}, true],
  ["a room command with an idempotency key", "/api/v1/workspaces/ws_a/tasks", { method: "POST", headers: { ...json, "idempotency-key": "k1" }, body: "{}" }, true],
  ["a room command without a key", "/api/v1/workspaces/ws_a/tasks", { method: "POST", headers: json, body: "{}" }, false],
  ["an agent's repository token, key or not", "/api/v1/workspaces/ws_a/tasks/tsk_a/repo-access", { method: "POST", headers: { ...json, "idempotency-key": "k2" }, body: "{}" }, false],
  ["a POST outside a room, key or not", "/api/orgs", { method: "POST", headers: { ...json, "idempotency-key": "k3" }, body: "{}" }, false],
  ["the consent form", "/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "org_id=org_a" }, false],
  ["an inbox read that acks", "/api/v1/inbox?ack=true", {}, false],
  ["an MCP tool call with an idempotency key", "/mcp", { method: "POST", headers: json, body: mcp("tools/call", { name: "create_task", arguments: { idempotency_key: "k4" } }) }, true],
  ["an MCP tool call without one", "/mcp", { method: "POST", headers: json, body: mcp("tools/call", { name: "create_task", arguments: {} }) }, false],
  ["an MCP read", "/mcp", { method: "POST", headers: json, body: mcp("tools/call", { name: "list_tasks", arguments: {} }) }, true],
  ["MCP's read_inbox, which can ack", "/mcp", { method: "POST", headers: json, body: mcp("tools/call", { name: "read_inbox", arguments: {} }) }, false],
  ["MCP's initialize", "/mcp", { method: "POST", headers: json, body: mcp("initialize", {}) }, false],
  ["MCP's tools/list", "/mcp", { method: "POST", headers: json, body: mcp("tools/list") }, true],
];

// Node's fetch hands a connection back to its pool a turn after the body is read; until then a request opens another.
const warm = async () => {
  await (await target.http("/warm")).text();
  await new Promise((done) => setImmediate(done));
};

const results = [];
const check = (ok, name) => results.push([ok, name]);

for (const [name, path, init, repeats] of cases) {
  check(safeToRepeat(target.base + path, init) === repeats, `${name} is ${repeats ? "" : "not "}safe to repeat`);
  await warm(); // leaves a kept-alive connection for the next request to reuse
  seen.length = 0;
  said.length = 0;
  resetMode = "reused";
  let error;
  try {
    await (await target.http(path, init)).text();
  } catch (caught) {
    error = caught;
  }
  if (repeats) {
    check(!error && seen.length === 2, `${name}, reset on a reused connection, is sent once more and answered (sent ${seen.length})`);
    check(said.length === 1 && said[0].includes(`${init.method ?? "GET"} ${new URL(target.base + path).pathname} once more`), `${name}'s second send is in the output`);
  } else {
    check(error?.cause?.code === "ECONNRESET" && seen.length === 1, `${name}, reset on a reused connection, fails as it did and is sent once (sent ${seen.length})`);
    check(said.length === 0, `${name} says nothing of a second send`);
  }
}

// A reset on a new connection isn't this failure, and a GET is still sent once.
const fresh = createServer((req) => req.socket.resetAndDestroy());
await new Promise((done) => fresh.listen(0, "127.0.0.1", done));
seen.length = 0;
const freshTarget = new Target(`http://127.0.0.1:${fresh.address().port}`, { pollMs: 0 });
let freshError;
let freshSeen = 0;
fresh.on("request", () => freshSeen++);
try {
  await freshTarget.http("/api/orgs");
} catch (caught) {
  freshError = caught;
}
check(freshError?.cause?.code === "ECONNRESET" && freshSeen === 1, `a GET reset on a new connection fails and is sent once (sent ${freshSeen})`);

// A GET reset again on its second send isn't sent a third time.
await warm();
seen.length = 0;
resetMode = "all";
let twiceError;
try {
  await target.http("/api/orgs");
} catch (caught) {
  twiceError = caught;
}
resetMode = "none";
check(twiceError?.cause?.code === "ECONNRESET" && seen.length === 2, `a GET reset twice is sent twice, not more (sent ${seen.length})`);

console.log = log;
server.close();
fresh.close();
server.closeAllConnections();
fresh.closeAllConnections();

let failed = 0;
for (const [ok, name] of results) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
