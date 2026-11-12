// A stand-in for staging, for m6-staging-selftest.mjs only. Loaded with `node --import` before m6-staging.mjs, it
// replaces fetch, so no request leaves this machine: every one is answered here, and none is passed on. At exit it
// prints how many requests it answered, how many were the test sign-up, and how many signed a session out.
//
// M6_STANDIN picks what staging does:
// - drop-signup: the signed-out preflight answers as staging does; the test sign-up's request arrives, and its answer is
//   lost in transport.
// - edge-down: every request answers 502, as Cloudflare's edge does when the Worker is down.
// - phases: enough of staging for M6-S04's two phases: sessions, organizations, rooms, tasks and their events, the
//   departure rule, MCP's OAuth and tool calls, and the API's 404 for every other route. Its state is kept in the file
//   M6_STANDIN_STATE, so a second process sees what the first made, as staging would across a deploy. With
//   M6_STANDIN_FORGET=1 it forgets every session first, as staging does once a test session ends.
//
// Waits of the run's own pacing, half a second to five seconds, are made at once, so the self-test sleeps on nothing.
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.M6_STANDIN;
if (!["drop-signup", "edge-down", "phases"].includes(mode)) throw new Error(`M6_STANDIN must be drop-signup, edge-down or phases, not ${mode}`);

const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (run, ms, ...rest) => realTimeout(run, ms >= 500 && ms <= 5000 ? 0 : ms, ...rest);

const counts = { requests: 0, signUps: 0, signOuts: 0 };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const notFound = () => json(404, { error: { code: "not_found", message: "not_found" } });

const stateFile = process.env.M6_STANDIN_STATE;
const blank = { next: 1, sessions: {}, people: {}, orgs: {}, rooms: {}, agents: {}, clients: {}, codes: {}, tokens: {} };
let state = blank;
if (mode === "phases") {
  if (!stateFile) throw new Error("M6_STANDIN_STATE must name the stand-in's state file");
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    state = structuredClone(blank);
  }
  if (process.env.M6_STANDIN_FORGET === "1") state.sessions = {};
}
const id = (prefix) => `${prefix}_${String(state.next++).padStart(6, "0")}${"a".repeat(10)}`;
const random = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

function event(room, type, task) {
  room.seq += 1;
  room.events.push({ seq: room.seq, id: id("evt"), type, task_id: task?.id ?? null, created_at: Date.now() });
}
const taskOut = (task) => ({ ...task });

/** The person a dashboard request's cookie names, or null. */
function personOf(headers) {
  const cookie = headers.get("cookie") ?? "";
  const token = cookie.match(/session_token=([^;]+)/)?.[1];
  return token && state.sessions[token] ? state.people[state.sessions[token]] : null;
}

function dashboard(method, path, headers, body) {
  if (path === "/api/v1/workspaces" && method === "GET" && !headers.get("cookie")) return json(401, { error: { code: "sign_in_required", message: "sign_in_required" } });
  if (path === "/api/auth/sign-up/e2e" && method === "POST") {
    const person = { id: id("per"), personalOrg: id("org") };
    state.people[person.id] = person;
    state.orgs[person.personalOrg] = { id: person.personalOrg, personal: true, owner: person.id };
    const token = random();
    state.sessions[token] = person.id;
    return json(200, { user_id: person.id, email: "stand-in" }, { "set-cookie": `__Secure-better-auth.session_token=${token}; Max-Age=7200; Path=/; HttpOnly; Secure; SameSite=Lax` });
  }
  if (path === "/api/auth/sign-out" && method === "POST") {
    const token = (headers.get("cookie") ?? "").match(/session_token=([^;]+)/)?.[1];
    if (token && state.sessions[token]) {
      delete state.sessions[token];
      counts.signOuts++;
    }
    return json(200, { success: true });
  }
  const person = personOf(headers);
  if (!person) return json(401, { error: { code: "sign_in_required", message: "sign_in_required" } });
  if (path === "/api/orgs" && method === "GET") return json(200, { organizations: Object.values(state.orgs).filter((org) => org.owner === person.id).map((org) => ({ id: org.id, personal: org.personal })) });
  if (path === "/api/orgs" && method === "POST") {
    const org = { id: id("org"), personal: false, owner: person.id };
    state.orgs[org.id] = org;
    return json(200, { id: org.id });
  }
  if (path === "/api/v1/me") return json(200, { id: person.id });
  if (path === "/api/v1/workspaces" && method === "POST") {
    const room = { id: id("ws"), name: body?.name, owner: person.id, policy_version: 1, members: [], tasks: {}, events: [], seq: 0 };
    state.rooms[room.id] = room;
    return json(200, { id: room.id });
  }
  const agentDisconnect = path.match(/^\/api\/agents\/([^/]+)\/disconnect$/);
  if (agentDisconnect && method === "POST") {
    const agent = state.agents[agentDisconnect[1]];
    if (!agent || agent.owner !== person.id) return json(404, { error: { code: "agent_not_found" } });
    agent.disconnected = true;
    for (const room of Object.values(state.rooms)) {
      if (!room.members.includes(agent.id)) continue;
      room.members = room.members.filter((member) => member !== agent.id);
      for (const task of Object.values(room.tasks)) {
        if (task.assignee !== agent.id || !["offered", "accepted"].includes(task.status)) continue;
        Object.assign(task, { status: "open", assignee: null, version: task.version + 1 });
        event(room, "task.assignee_departed", task);
      }
    }
    return json(200, { status: "disconnected" });
  }
  const inRoom = path.match(/^\/api\/v1\/workspaces\/([^/]+)(\/.*)?$/);
  const room = inRoom && state.rooms[inRoom[1]];
  if (!room || room.owner !== person.id) return inRoom ? json(404, { error: { code: "workspace_not_found" } }) : notFound();
  const rest = inRoom[2] ?? "";
  if (rest === "" && method === "GET") return json(200, { id: room.id, name: room.name, policy_version: room.policy_version, visibility: "private" });
  if (rest === "/members" && method === "POST") {
    room.members.push(body.principal_id);
    return json(200, { principal_id: body.principal_id });
  }
  if (rest === "/visibility" && method === "GET") return json(200, { visibility: "private", workflow: "general" });
  if (rest.startsWith("/audit?") && method === "GET") return json(200, { audit: room.events.map((e) => ({ seq: e.seq, action: e.type })), next_cursor: null });
  if (rest.startsWith("/events?") && method === "GET") {
    const after = Number(new URLSearchParams(rest.split("?")[1]).get("after") ?? 0);
    return json(200, { events: room.events.filter((e) => e.seq > after).slice(0, 50) });
  }
  if (rest === "/tasks" && method === "POST") {
    const task = { id: id("tsk"), title: body.title, requester: person.id, reviewer: person.id, assignee: body.assignee ?? null, status: body.assignee ? "offered" : "open", version: 1 };
    room.tasks[task.id] = task;
    event(room, "task.created", task);
    if (task.assignee) event(room, "task.offered", task);
    return json(200, taskOut(task));
  }
  const onTask = rest.match(/^\/tasks\/([^/]+)(\/[a-z-]+)?$/);
  const task = onTask && room.tasks[onTask[1]];
  if (!task) return notFound();
  if (!onTask[2] && method === "GET") return json(200, { task: taskOut(task) });
  if (onTask[2] === "/assign" && method === "POST") {
    if (body.version !== task.version || !["open", "offered"].includes(task.status)) return json(409, { error: { code: "version_conflict" } });
    Object.assign(task, { status: "offered", assignee: body.assignee, version: task.version + 1 });
    event(room, "task.offered", task);
    return json(200, taskOut(task));
  }
  if (onTask[2] === "/verify" && method === "POST") {
    if (task.status !== "submitted") return json(409, { error: { code: "invalid_transition" } });
    Object.assign(task, { status: "completed", version: task.version + 1 });
    event(room, "task.completed", task);
    return json(200, taskOut(task));
  }
  return notFound();
}

const TOOLS = ["get_identity", "get_workspace", "get_task", "accept_task", "submit_task"];

function tool(agent, name, args) {
  const result = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const refusal = (text) => ({ content: [{ type: "text", text }], isError: true });
  if (!TOOLS.includes(name)) return refusal(`MCP error -32602: Tool ${name} not found`);
  if (name === "get_identity") return result({ id: agent.id, org_id: agent.org });
  const room = state.rooms[args.workspace_id];
  if (!room || !room.members.includes(agent.id)) return refusal("workspace_not_found");
  if (name === "get_workspace") return result({ id: room.id, name: room.name, policy_version: room.policy_version });
  const task = room.tasks[args.task_id];
  if (!task) return refusal("task_not_found");
  if (name === "get_task") return result({ task: taskOut(task) });
  if (task.assignee !== agent.id || args.version !== task.version) return refusal("version_conflict");
  const [from, to, type] = name === "accept_task" ? ["offered", "accepted", "task.accepted"] : ["accepted", "submitted", "task.submitted"];
  if (task.status !== from) return refusal("invalid_transition");
  Object.assign(task, { status: to, version: task.version + 1 });
  event(room, type, task);
  return result(taskOut(task));
}

function oauthAndMcp(base, method, path, headers, text) {
  if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
  if (path === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (path === "/register" && method === "POST") {
    const client = { ...JSON.parse(text), client_id: id("cli"), client_id_issued_at: Math.floor(Date.now() / 1000) };
    state.clients[client.client_id] = true;
    return json(201, client);
  }
  if (path === "/authorize" && method === "POST") {
    const person = personOf(headers);
    if (!person) return json(401, { error: { code: "sign_in_required" } });
    const form = new URLSearchParams(text);
    const agent = { id: id("agt"), org: form.get("org_id"), owner: person.id, name: form.get("agent_name"), disconnected: false };
    state.agents[agent.id] = agent;
    const code = random();
    state.codes[code] = agent.id;
    return new Response(null, { status: 302, headers: { location: `https://e2e-client.invalid/cb?code=${code}` } });
  }
  if (path === "/token" && method === "POST") {
    const form = new URLSearchParams(text);
    const agent = state.codes[form.get("code")];
    if (!agent) return json(400, { error: "invalid_grant" });
    delete state.codes[form.get("code")];
    const token = random();
    state.tokens[token] = agent;
    return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: random() });
  }
  if (path === "/mcp") {
    const agent = state.agents[state.tokens[(headers.get("authorization") ?? "").replace(/^Bearer /, "")]];
    if (!agent || agent.disconnected) return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(text);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const answer = (result) => json(200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") return answer({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "0" } });
    if (message.method === "tools/list") return answer({ tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) });
    if (message.method === "tools/call") return answer(tool(agent, message.params.name, message.params.arguments ?? {}));
    return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
  return null;
}

globalThis.fetch = async (input, init = {}) => {
  counts.requests++;
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const path = url.pathname;
  const method = (init.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? request?.headers);
  if (path === "/api/auth/sign-up/e2e") counts.signUps++;
  if (mode === "edge-down") return new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  if (path === "/.well-known/agent-configuration") return json(200, { version: "stand-in" });
  if (mode === "drop-signup") {
    if (path === "/api/v1/workspaces") return json(401, { error: { code: "sign_in_required", message: "sign_in_required" } });
    if (path === "/api/auth/sign-up/e2e") throw new TypeError("fetch failed", { cause: new Error("the stand-in dropped the answer") });
    return notFound();
  }
  const text = init.body === undefined || init.body === null ? (request ? await request.text() : "") : String(init.body);
  const full = path + url.search;
  const mcp = oauthAndMcp(url.origin, method, path, headers, text);
  if (mcp) return mcp;
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return dashboard(method, full, headers, body);
};

console.log(`stand-in for staging: ${mode}; nothing leaves this machine`);
process.on("exit", () => {
  if (mode === "phases") writeFileSync(stateFile, JSON.stringify(state));
  console.log(`stand-in counted: ${counts.requests} requests, ${counts.signUps} test sign-ups, ${counts.signOuts} sign-outs`);
});
