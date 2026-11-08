// M3's A2A run against a deployment, through the A2A project's own JavaScript client, `@a2a-js/sdk`, and not the gateway's
// code. It covers steps 8 to 11:
//
// - discovery from the Agent Card;
// - OAuth to the `/a2a` audience;
// - `GetTask` and `ListTasks`, with paging;
// - `SendMessage`, with a retry;
// - the lifecycle extension, with and without `A2A-Extensions`;
// - the refusals: a hidden task, a stale version, another agent's task;
// - an agent's A2A endpoint with a bearer token (step 11): set, read, rotate, the org admin's read, delete and disconnect.
//   Nothing is sent to it at step 11, so its host is a made-up name under example.com, which passes egress policy.
//
// The token and signing secret must never be shown: not in a read, and not in this script's own output, which it checks at
// the end. A token is `e2eA2aTok_…` and a secret `a2asec_…`, so the local runner can look for both in the Workers' logs.
//
//   node a2a-staging.mjs --base-url <gateway> [--allow-host <host>]
//
// People: locally it signs one person up with a password. On staging, PODSTER_E2E_SIGNUP_SECRET makes a test person through the
// test sign-up, as m2-staging.mjs does, and the session is signed out at the end. Otherwise it needs PODSTER_E2E_COOKIE_A.
// Agents connect over MCP, through the official MCP SDK, to set up tasks, and over A2A with their own OAuth client linked to
// the same agent. It writes a room and tasks, and staging has no delete route, so rooms are named "A2A staging <time>".
//
// The SDK has no call for an extension's own methods, so the lifecycle methods are plain JSON-RPC over fetch, with the
// token from the same OAuth flow. Until the lifecycle extension is deployed they answer "method not found", and those
// cases are skipped.
//
// This is the A2A project's own client, so it isn't an independent implementation (decision 143). It checks that
// Podster works for a real client over the network, which the gateway's own tests can't.
import { AgentCard } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes, randomUUID } from "node:crypto";
import { key, McpAgent, ok, Person, Target } from "./lib.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const base = (option("--base-url") ?? process.env.PODSTER_E2E_BASE_URL)?.replace(/\/$/, "");
if (!base) {
  console.error("Pass --base-url, or set PODSTER_E2E_BASE_URL.");
  process.exit(2);
}
const host = new URL(base).hostname;
const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".test");
const STAGING = "https://gateway-staging.podster.dev";
if (!isLocal && new URL(base).origin !== STAGING && option("--allow-host") !== host) {
  console.error(`Refusing to write test data to ${host}. Pass --allow-host ${host} if that's really intended.`);
  process.exit(2);
}
if (!isLocal && new URL(base).protocol !== "https:") {
  console.error(`Refusing to send session cookies or tokens to ${base} without HTTPS.`);
  process.exit(2);
}
// The test sign-up's secret goes to staging's gateway and nowhere else.
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
if (signupSecret && new URL(base).origin !== STAGING) {
  console.error(`PODSTER_E2E_SIGNUP_SECRET only works against ${STAGING}. Unset it to run against ${host}.`);
  process.exit(2);
}

// Everything this script writes, so the end can check no token or secret is in it. Kept in memory only.
const written = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return write(chunk, ...rest);
  };
}
/** Values that must never be printed, gathered as the run makes them. */
const secrets = new Set();

const target = new Target(base, { pollMs: isLocal ? 150 : 1000 });
const LIFECYCLE = "https://podster.dev/a2a/lifecycle/v1";
const VERSION = "podster.dev/version";
const STATUS = "podster.dev/status";

// ---- reporting ----

const results = [];
const record = (status, title, detail = "") => {
  results.push({ status, title });
  const mark = { ok: "ok  ", fail: "FAIL", skip: "skip", note: "    " }[status];
  console.log(`${mark} ${title}${detail ? `: ${detail}` : ""}`);
};
const check = (passed, title, detail) => record(passed ? "ok" : "fail", title, detail);
const skip = (title, why) => record("skip", title, why);
const section = (name) => console.log(`\n## ${name}`);
const cause = (error) => {
  const parts = [];
  for (let at = error, depth = 0; at && depth < 4; at = at.cause, depth++) {
    const said = [at.code, at.name, at.message].filter(Boolean).join(" ");
    if (said && !parts.includes(said)) parts.push(said);
  }
  return parts.join(": ") || String(error);
};
async function step(title, run) {
  try {
    await run();
  } catch (error) {
    record("fail", title, cause(error));
  }
}
/** What an SDK call threw, as its error class's name, which names the A2A error. */
const thrown = async (call) => {
  try {
    await call();
    return null;
  } catch (error) {
    return error?.constructor?.name ?? String(error);
  }
};

// ---- people ----

const ownCookies = [];
let room;
async function person() {
  if (signupSecret) {
    const cookie = await Person.testSessionCookie(target, "Person A", signupSecret);
    ownCookies.push(cookie);
    return Person.fromCookie(target, "Person A", cookie);
  }
  const a = process.env.PODSTER_E2E_COOKIE_A;
  if (isLocal && !a) return Person.signUp(target, "Person A");
  if (!a) {
    console.error("A deployed run needs PODSTER_E2E_SIGNUP_SECRET, or PODSTER_E2E_COOKIE_A from a person's sign-in.");
    process.exit(2);
  }
  return Person.fromCookie(target, "Person A", a);
}

async function signOut() {
  if (signOut.done) return;
  signOut.done = true;
  let ended = true;
  for (const cookie of ownCookies) {
    await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const after = await target.http("/api/orgs", { headers: { cookie } }).catch(() => null);
    if (after?.status !== 401) ended = false;
  }
  if (ownCookies.length) console.log(ended ? "\nThe test person's session is signed out." : "\nWARNING: a test session may still be live. It ends by itself within two hours.");
}

// ---- an A2A agent: its own OAuth client, linked on consent to an agent that already exists ----

/**
 * OAuth to `/a2a` with the MCP SDK's generic flow, since the A2A SDK runs none: discovery from the 401, registration, PKCE
 * and `resource`. The consent links this new client to `agent`, so its token acts as that agent.
 */
async function a2aToken(owner, agent) {
  const serverUrl = new URL(`${target.base}/a2a`);
  const sdkFetch = (url, init) => target.fetch(url, { redirect: "follow", ...init });
  let authorizationUrl;
  let verifier = "";
  let client;
  let tokens;
  const provider = {
    redirectUrl: "https://e2e-client.invalid/cb",
    clientMetadata: { client_name: `Podster e2e A2A: ${agent.label}`, redirect_uris: ["https://e2e-client.invalid/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    clientInformation: () => client,
    saveClientInformation: (info) => void (client = info),
    tokens: () => tokens,
    saveTokens: (value) => void (tokens = value),
    redirectToAuthorization: (url) => void (authorizationUrl = url),
    saveCodeVerifier: (value) => void (verifier = value),
    codeVerifier: () => verifier,
  };
  ok((await sdkAuth(provider, { serverUrl, fetchFn: sdkFetch })) === "REDIRECT", "A2A discovery from the 401");
  ok(authorizationUrl.searchParams.get("resource") === serverUrl.href, `the authorize URL names ${serverUrl.href}`);
  const approved = await target.http("/authorize", {
    method: "POST",
    headers: { cookie: owner.cookie, origin: target.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ oauth_query: authorizationUrl.search, org_id: owner.org, agent_name: agent.label, link_agent_id: agent.id }),
  });
  ok(approved.status === 302, `A2A consent for ${agent.label}: HTTP ${approved.status}`);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  ok((await sdkAuth(provider, { serverUrl, authorizationCode: code, fetchFn: sdkFetch })) === "AUTHORIZED", "A2A token exchange");
  return tokens.access_token;
}

/** The A2A SDK's client, discovering Podster from its card, with the token on every request. */
async function a2aClient(token) {
  const fetchImpl = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return target.fetch(input, { ...init, headers });
  };
  return new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromUrl(target.base);
}

/** One lifecycle call as plain JSON-RPC, which the SDK has no call for. */
async function lifecycle(token, method, params, { activate = true } = {}) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "1.0", ...(activate ? { "A2A-Extensions": LIFECYCLE } : {}) };
  const res = await target.http("/a2a", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `podster.lifecycle.v1.${method}`, params: { requestId: randomUUID(), ...params } }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, reason: body?.error?.data?.[0]?.reason ?? body?.error?.message, extensions: res.headers.get("A2A-Extensions") };
}

const a2aId = (task) => `${room}:${task}`;
const textMessage = (taskId, value, messageId = randomUUID()) => ({ message: { messageId, role: 1, taskId, contextId: "", parts: [{ content: { $case: "text", value } }], extensions: [], referenceTaskIds: [] } });

// ---- the run ----

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => signOut().finally(() => process.exit(130)));
}

let failedOutside = false;
try {
  await run();
} catch (error) {
  failedOutside = true;
  console.error(`FAIL the run stopped: ${cause(error)}`);
} finally {
  await signOut();
}
// Last, so it covers everything written before it. It never prints what it found, only that it found something.
const output = written.join("");
const leakedValues = [...secrets].filter((value) => output.includes(value)).length;
const leakedShapes = (output.match(/a2asec_[0-9a-f]{8,}|e2eA2aTok_[0-9a-f]{8,}/g) ?? []).length;
check(leakedValues === 0 && leakedShapes === 0, "no endpoint token or signing secret anywhere in this script's output", leakedValues || leakedShapes ? `${leakedValues} known values and ${leakedShapes} lookalikes found` : `${secrets.size} values checked`);
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`\n${count("ok")} passed, ${count("fail")} failed, ${count("skip")} skipped.${room ? ` Room ${room}.` : ""}`);
process.exit(count("fail") || failedOutside ? 1 : 0);

async function run() {
  const owner = await person();
  room = await owner.createRoom(`A2A staging ${new Date().toISOString().slice(0, 19)} ${key().slice(-6)}`);
  console.log(`Room ${room} on ${base}.`);
  const lead = await McpAgent.connect(target, owner, "A2A staging lead");
  const guest = await McpAgent.connect(target, owner, "A2A staging guest");
  await owner.addAgent(room, lead, "member");
  await owner.addAgent(room, guest, "guest");
  const offer = async (title, assignee) => lead.must("create_task", { workspace_id: room, title, instructions: "From the A2A staging run.", ...(assignee ? { assignee } : {}) });
  const offered = (await offer("A2A staging: offered to the guest", guest.id)).id;
  const hidden = (await offer("A2A staging: not the guest's")).id;

  let guestToken;
  let leadToken;
  let guestClient;
  let leadClient;

  section("Discovery and OAuth");
  await step("discovery", async () => {
    const res = await target.http("/.well-known/agent-card.json");
    const card = AgentCard.fromJSON(await res.json());
    const iface = card.supportedInterfaces?.[0];
    check(res.status === 200 && iface?.protocolBinding === "JSONRPC" && iface?.protocolVersion === "1.0" && iface?.url === `${base}/a2a`, "the card names one JSON-RPC 1.0 interface at /a2a", iface ? `${iface.protocolBinding} ${iface.protocolVersion} ${iface.url}` : `HTTP ${res.status}`);
    const scheme = card.securitySchemes?.podster?.scheme;
    check(scheme?.$case === "oauth2SecurityScheme", "the card declares an OAuth scheme", scheme?.$case ?? "none");
    // Compared whole, so a URI that only contains the extension's doesn't count.
    const declared = (card.capabilities?.extensions ?? []).find((e) => e.uri === LIFECYCLE);
    if (declared) check(declared.required === false, "the card declares the lifecycle extension, not required", `required ${declared.required}`);
    else skip("the card declares the lifecycle extension", "not deployed yet (#168)");
  });

  await step("OAuth to /a2a", async () => {
    guestToken = await a2aToken(owner, guest);
    leadToken = await a2aToken(owner, lead);
    check(Boolean(guestToken && leadToken), "each agent gets an /a2a token through the same consent, linked to its existing identity");
    const atMcp = await target.http("/mcp", { method: "POST", headers: { authorization: `Bearer ${guestToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    check(atMcp.status === 401, "an /a2a token is refused at /mcp", `HTTP ${atMcp.status}`);
    guestClient = await a2aClient(guestToken);
    leadClient = await a2aClient(leadToken);
    check(Boolean(guestClient && leadClient), "the SDK's client is built from the card");
  });
  if (!guestClient || !leadClient) return skip("everything after OAuth", "no client");

  section("Reads (step 8)");
  await step("GetTask", async () => {
    const task = await guestClient.getTask({ id: a2aId(offered) });
    check(task.id === a2aId(offered) && task.contextId === a2aId(offered), "GetTask reads the guest's task, with id and contextId <room>:<task>", task.id);
    check(task.status?.state === 1 && task.metadata?.[STATUS] === "offered", "an offered task reads as SUBMITTED, with podster.dev/status", `${task.status?.state} ${task.metadata?.[STATUS]}`);
    const hiddenError = await thrown(() => guestClient.getTask({ id: a2aId(hidden) }));
    const missingError = await thrown(() => guestClient.getTask({ id: a2aId(`tsk_${"0".repeat(32)}`) }));
    check(/TaskNotFound/.test(hiddenError ?? "") && hiddenError === missingError, "a hidden task answers as a missing one", `${hiddenError} / ${missingError}`);
  });

  await step("ListTasks", async () => {
    const mine = await guestClient.listTasks({ status: 0 });
    check(mine.tasks.length === 1 && mine.tasks[0].id === a2aId(offered), "the guest lists only its own task", mine.tasks.map((t) => t.id).join(", "));
    const seen = [];
    let pageToken = "";
    for (let i = 0; i < 10; i++) {
      const page = await leadClient.listTasks({ status: 0, pageSize: 1, ...(pageToken ? { pageToken } : {}) });
      seen.push(...page.tasks.map((t) => t.id));
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    const inRoom = seen.filter((id) => id.startsWith(`${room}:`));
    check(inRoom.includes(a2aId(offered)) && inRoom.includes(a2aId(hidden)) && new Set(inRoom).size === inRoom.length, "the lead pages one task at a time and sees both, each once", `${inRoom.length} in this room`);
  });

  section("Messages (step 9)");
  await step("SendMessage", async () => {
    const before = (await lead.must("list_messages", { workspace_id: room, task_id: offered }, false)).messages.length;
    const messageId = randomUUID();
    const sent = await guestClient.sendMessage(textMessage(a2aId(offered), "From the A2A SDK client.", messageId));
    const sentTask = sent?.history ? sent : sent?.task ?? sent;
    check(sentTask?.id === a2aId(offered), "SendMessage posts to the task and answers it", sentTask?.id ?? JSON.stringify(sent).slice(0, 80));
    await guestClient.sendMessage(textMessage(a2aId(offered), "From the A2A SDK client.", messageId));
    const after = await lead.must("list_messages", { workspace_id: room, task_id: offered }, false);
    check(after.messages.length === before + 1 && after.messages.at(-1)?.from?.id === guest.id, "a retry with the same messageId posts once, as the guest", `${after.messages.length - before} new`);
    const reused = await thrown(() => guestClient.sendMessage(textMessage(a2aId(offered), "Different text.", messageId)));
    check(Boolean(reused), "the same messageId for other text is refused", reused ?? "accepted");
    const noTask = await thrown(() => guestClient.sendMessage({ message: { messageId: randomUUID(), role: 1, parts: [{ content: { $case: "text", value: "Make me a task." } }] } }));
    check(/UnsupportedOperation/.test(noTask ?? ""), "a message with no taskId is refused", noTask ?? "accepted");
    const toHidden = await thrown(() => guestClient.sendMessage(textMessage(a2aId(hidden), "Hi.")));
    check(/TaskNotFound/.test(toHidden ?? ""), "a message to a hidden task answers as missing", toHidden ?? "accepted");
  });

  section("Lifecycle (step 10)");
  await step("lifecycle", async () => {
    const version = (await guestClient.getTask({ id: a2aId(offered) })).metadata?.[VERSION];
    const probe = await lifecycle(guestToken, "AcceptTask", { id: a2aId(offered), version: version ?? 1 }, { activate: false });
    if (probe.body?.error?.code === -32601 || version === undefined) return skip("the lifecycle methods", "not deployed yet (#168)");
    check(/EXTENSION_SUPPORT_REQUIRED/.test(probe.reason ?? ""), "without A2A-Extensions the methods are refused", probe.reason ?? JSON.stringify(probe.body).slice(0, 80));
    const stale = await lifecycle(guestToken, "AcceptTask", { id: a2aId(offered), version: version + 5 });
    check(Boolean(stale.body?.error), "a stale version is refused", stale.reason ?? "accepted");
    const notTheirs = await lifecycle(leadToken, "AcceptTask", { id: a2aId(offered), version });
    check(Boolean(notTheirs.body?.error), "another agent can't accept the guest's offer", notTheirs.reason ?? "accepted");
    const hiddenTry = await lifecycle(guestToken, "AcceptTask", { id: a2aId(hidden), version: 1 });
    check(/TASK_NOT_FOUND/.test(hiddenTry.reason ?? ""), "a hidden task answers as missing", hiddenTry.reason ?? "accepted");
    const accepted = await lifecycle(guestToken, "AcceptTask", { id: a2aId(offered), version });
    check(accepted.body?.result?.metadata?.[STATUS] === "accepted" && accepted.extensions === LIFECYCLE, "with A2A-Extensions the guest accepts, and the answer says the extension is active", accepted.body?.result?.metadata?.[STATUS] ?? accepted.reason);
    const submitted = await lifecycle(guestToken, "SubmitTask", { id: a2aId(offered), version: accepted.body?.result?.metadata?.[VERSION], note: "Done, from the A2A staging run.", artifacts: [{ uri: "https://example.com/a2a-staging", label: "Result" }] });
    check(submitted.body?.result?.metadata?.[STATUS] === "submitted", "then submits a link and a note", submitted.body?.result?.metadata?.[STATUS] ?? submitted.reason);
    const read = await lead.must("get_task", { workspace_id: room, task_id: offered }, false);
    check(read.task.status === "submitted" && read.artifacts?.some((a) => a.uri === "https://example.com/a2a-staging"), "the lead sees the submission over MCP", read.task.status);
    const declinable = (await offer("A2A staging: to decline", guest.id)).id;
    const v = (await guestClient.getTask({ id: a2aId(declinable) })).metadata?.[VERSION];
    const declined = await lifecycle(guestToken, "DeclineTask", { id: a2aId(declinable), version: v, reason: "Not for me." });
    check(declined.body?.result?.metadata?.[STATUS] === "open", "the guest declines another offer with a reason, and it goes back to open", declined.body?.result?.metadata?.[STATUS] ?? declined.reason);
  });

  section("Endpoint (step 11)");
  await endpoint(owner);
}

/** The text of a value, to look for a token or secret in it. */
function shown(value) {
  return JSON.stringify(value ?? null);
}
function hides(value, ...values) {
  return values.every((v) => !shown(value).includes(v));
}

/**
 * Step 11: an agent sets its A2A endpoint with a bearer token through its own `set_a2a_endpoint`. Its own agent, because the
 * disconnect at the end ends it. Nothing is sent to the endpoint until step 12.
 */
async function endpoint(owner) {
  const agent = await McpAgent.connect(target, owner, "A2A staging endpoint");
  const host = `a2a-e2e-${randomBytes(6).toString("hex")}.example.com`;
  const url = `https://${host}/a2a`;
  const token = `e2eA2aTok_${randomBytes(24).toString("hex")}`;
  secrets.add(token);
  const adminPath = `/agents/${agent.id}/a2a-endpoint`;
  let first;
  let secret;

  await step("set with a token", async () => {
    const refused = [];
    for (const bad of ["http://" + host + "/a2a", "https://10.0.0.1/a2a", `https://${host}:8443/a2a`, "https://a2a.internal/a2a"]) {
      const res = await agent.call("set_a2a_endpoint", { url: bad });
      if (res.ok || !/invalid_endpoint_url/.test(res.code ?? "")) refused.push(bad.split("/")[2]);
    }
    check(refused.length === 0, "a URL egress policy refuses can't be set: plain HTTP, an IP, another port, a private name", refused.length ? `accepted or other code: ${refused.join(", ")}` : "");
    const set = await agent.call("set_a2a_endpoint", { url, token });
    if (!set.ok && /token_storage_unavailable/.test(set.code ?? "")) {
      return check(false, "the agent sets its endpoint with a token", "token_storage_unavailable: A2A_TOKEN_KEY isn't set, or isn't 64 hex characters");
    }
    check(set.ok, "the agent sets its endpoint with a token through its own set_a2a_endpoint", set.ok ? "" : set.code);
    if (!set.ok) return;
    first = set.data;
    secret = first.signing_secret;
    if (typeof secret === "string") secrets.add(secret);
    check(/^a2asec_[0-9a-f]{64}$/.test(secret ?? ""), "the answer gives a signing secret once");
    check(first.url === url && first.enabled === true && Number.isInteger(first.version) && first.version >= 1, "the answer has the URL, a version, and the endpoint on", `version ${first.version}, enabled ${first.enabled}`);
    check(first.has_token === true && first.token_state === "stored", "the token is stored", `has_token ${first.has_token}, token_state ${first.token_state}`);
    check(!("token" in first) && hides(first, token), "the answer never has the token");
  });
  if (!first) return skip("the rest of step 11", "no endpoint");

  await step("reads", async () => {
    const read = await agent.call("get_a2a_endpoint", {});
    check(read.ok && read.data?.has_token === true && read.data?.token_state === "stored" && read.data?.version === first.version, "the agent's read shows has_token true and token_state stored", read.ok ? `${read.data?.has_token} ${read.data?.token_state}` : read.code);
    check(read.ok && !("signing_secret" in (read.data ?? {})) && !("token" in (read.data ?? {})) && hides(read.data, token, secret), "the agent's read has neither the token nor the secret");
    const identity = await agent.call("get_identity", {});
    const inIdentity = identity.data?.a2a_endpoint;
    if (identity.ok && inIdentity !== undefined) {
      check(inIdentity?.token_state === "stored" && hides(identity.data, token, secret), "get_identity shows the endpoint, with neither the token nor the secret", inIdentity?.token_state);
    } else {
      check(identity.ok && hides(identity.data, token, secret), "get_identity has neither the token nor the secret", identity.ok ? "" : identity.code);
    }
  });

  let rotated;
  await step("same URL, then rotate", async () => {
    const again = await agent.call("set_a2a_endpoint", { url });
    check(again.ok && again.data?.version === first.version && !("signing_secret" in (again.data ?? {})), "setting the same URL again keeps the version and gives no new secret", again.ok ? `version ${again.data?.version}` : again.code);
    check(again.ok && again.data?.has_token === true && again.data?.token_state === "stored", "and keeps the token", again.ok ? again.data?.token_state : "");
    const rotate = await agent.call("set_a2a_endpoint", { url, rotate_secret: true });
    rotated = rotate.data?.signing_secret;
    if (typeof rotated === "string") secrets.add(rotated);
    check(rotate.ok && /^a2asec_[0-9a-f]{64}$/.test(rotated ?? "") && rotated !== secret, "rotate_secret gives a new secret", rotate.ok ? "" : rotate.code);
    check(rotate.ok && rotate.data?.version === first.version && rotate.data?.token_state === "stored" && hides(rotate.data, token), "rotating keeps the version and the token, and never shows the token", rotate.ok ? `version ${rotate.data?.version}` : "");
  });

  await step("the org admin's read", async () => {
    const read = await owner.dash("GET", adminPath);
    check(read.status === 200 && read.body?.url === url && read.body?.has_token === true && read.body?.token_state === "stored", "an org admin reads it through the person route", `HTTP ${read.status} ${read.body?.token_state ?? read.code ?? ""}`);
    check(read.status === 200 && !("signing_secret" in (read.body ?? {})) && !("token" in (read.body ?? {})) && hides(read.body, token, secret, rotated ?? secret), "the admin's read has neither the token nor either secret");
    const identity = await owner.dash("GET", `/agents/${agent.id}`);
    check(identity.status === 200 && hides(identity.body, token, secret, rotated ?? secret), "nor does the admin's read of the agent", `HTTP ${identity.status}`);
  });

  await step("delete", async () => {
    const deleted = await agent.call("delete_a2a_endpoint", {});
    check(deleted.ok && deleted.data?.deleted === true, "the agent deletes its endpoint", deleted.ok ? "" : deleted.code);
    const mine = await agent.call("get_a2a_endpoint", {});
    const theirs = await owner.dash("GET", adminPath);
    check(mine.ok && mine.data === null && theirs.status === 200 && theirs.body === null, "then neither the agent nor the admin reads one", `${shown(mine.data).slice(0, 20)} / HTTP ${theirs.status} ${shown(theirs.body).slice(0, 20)}`);
  });

  await step("disconnect", async () => {
    const again = await agent.call("set_a2a_endpoint", { url, token });
    if (typeof again.data?.signing_secret === "string") secrets.add(again.data.signing_secret);
    check(again.ok && again.data?.version > first.version && typeof again.data?.signing_secret === "string" && again.data?.token_state === "stored", "after a delete the same URL makes a new version and secret", again.ok ? `version ${again.data?.version}` : again.code);
    const gone = await owner.dash("POST", `/agents/${agent.id}/disconnect`);
    check(gone.status === 200, "the org admin disconnects the agent", `HTTP ${gone.status} ${gone.code ?? ""}`);
    const theirs = await owner.dash("GET", adminPath);
    check(theirs.body === null || theirs.status === 404, "the disconnect removes the endpoint, with its token and secret", `HTTP ${theirs.status} ${shown(theirs.body).slice(0, 20)}`);
  });
}
