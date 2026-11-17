import { env } from "cloudflare:test";
import { decodeJwt } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { CAPABILITIES, RELEASE_ROUTES_PATH } from "../src/capabilities";
import { A2A_CAPABILITIES, LIFECYCLE_METHODS } from "../src/a2a/lifecycle";
import worker, { a2aCapability, type Env } from "../src/index";
import { a2a, agentOnBoth, BASE, dash, mcpTool, setUpSchemas, signUp, type Person } from "./oauth-helpers";

/**
 * The engineer's three steps over A2A (the architect's ruling of 2026-11-14): claiming a role, a task's repository token,
 * and a submission's commit and pull request. Each is the capability MCP calls, as the same agent, so the API decides
 * exactly as it does for MCP, and these tests show the two protocols ask the same thing and answer the same way.
 *
 * Two kinds of test. Against the real API, which this suite runs with managed repositories off: claiming, and a
 * submission's commit. And against a stand-in API with the gateway's switch on, for what needs a ready repository, which
 * this suite can't make: the stand-in answers one state, MCP and A2A each ask it, and the test compares the request each
 * sent and the answer each gave. Which state gives which code is the API's, and `apps/api/test/repo-access.spec.ts`,
 * `repo-grants.spec.ts` and `task-change.spec.ts` show that on the real rows.
 */

type Agent = Awaited<ReturnType<typeof agentOnBoth>>;
const e = env as unknown as Env & { TEST_CAPABILITIES: string };
const URI = "https://podster.dev/a2a/lifecycle/v1";
const ON = { "A2A-Extensions": URI };
const M = (name: string) => `podster.lifecycle.v1.${name}`;
const reason = (body: any) => body?.error?.data?.[0]?.reason as string | undefined;
const codeOf = (body: any) => body?.error?.data?.[0]?.metadata?.code as string | undefined;
const key = () => crypto.randomUUID();
const hex = () => crypto.randomUUID().replace(/-/g, "");

let owner: Person;
let lead: Agent;
let room: string;

const policyVersion = async (id = room) => (await dash(owner, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
async function join(agentId: string, role = "guest", id = room) {
  expect((await dash(owner, "POST", `/v1/workspaces/${id}/members`, { principal_id: agentId, kind: "agent", org_id: owner.org, role, policy_version: await policyVersion(id) })).status).toBe(200);
}
/** A fresh agent in the room, connected over both protocols, so one identity holds an `/mcp` and an `/a2a` token. */
async function engineer() {
  const agent = await agentOnBoth(owner);
  await join(agent.id);
  return agent;
}
async function opening(capacity = 1) {
  const res = await dash(owner, "POST", `/v1/workspaces/${room}/roles`, { title: "Engineer", responsibilities: "Write the code", preset: "member", capacity, policy_version: await policyVersion() });
  expect(res.status).toBe(200);
  return res.body.id as string;
}
async function invite(role: string, agentId: string) {
  expect((await dash(owner, "POST", `/v1/workspaces/${room}/roles/${role}/invites`, { principal_id: agentId, policy_version: await policyVersion() })).status).toBe(200);
}

const claimA2a = (agent: Agent, params: Record<string, unknown>, headers: Record<string, string> = ON) => a2a(M("ClaimRole"), { requestId: key(), ...params }, agent.a2a, headers);
const claimMcp = (agent: Agent, roleId: string, workspaceId = room, idempotencyKey = key()) => mcpTool(agent.mcp, "claim_role", { workspace_id: workspaceId, role_id: roleId, idempotency_key: idempotencyKey });

beforeAll(async () => {
  await setUpSchemas();
  owner = await signUp();
  lead = await agentOnBoth(owner);
  room = (await dash(owner, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  await join(lead.id, "member");
});

describe("ClaimRole, against the real API", () => {
  it("claims an opening the agent was invited to, as MCP's claim_role does, and the same claim answers the same way", async () => {
    const [overMcp, overA2a] = [await engineer(), await engineer()];
    const [first, second] = [await opening(), await opening()];
    await invite(first, overMcp.id);
    await invite(second, overA2a.id);
    const viaMcp = await claimMcp(overMcp, first);
    const viaA2a = await claimA2a(overA2a, { workspaceId: room, roleId: second });
    expect(viaMcp.code).toBeUndefined();
    expect(viaA2a.body.error).toBeUndefined();
    expect(viaA2a.res.headers.get("A2A-Extensions")).toBe(URI);
    // The same answer, but for whose claim it is.
    expect(viaA2a.body.result).toEqual({ ...viaMcp.data, role_id: second, principal_id: overA2a.id, claimed_at: expect.any(Number) });
    expect(viaA2a.body.result).toMatchObject({ role_id: second, principal_id: overA2a.id, status: "active" });
    // Asked again over the other protocol, each answers as the claim it already holds.
    expect((await claimMcp(overA2a, second)).data).toEqual(viaA2a.body.result);
    expect((await claimA2a(overMcp, { workspaceId: room, roleId: first })).body.result).toEqual(viaMcp.data);
  });

  it("refuses what MCP refuses, with the same code, for the same state, and claims nothing", async () => {
    const [overMcp, overA2a, filler] = [await engineer(), await engineer(), await engineer()];
    const outcome = async (roleId: string, workspaceId = room) => {
      const viaMcp = await claimMcp(overMcp, roleId, workspaceId);
      const viaA2a = await claimA2a(overA2a, { workspaceId, roleId });
      expect(viaA2a.body.result).toBeUndefined();
      expect(reason(viaA2a.body)).toBe(viaMcp.code === "invalid_argument" || viaMcp.code === "idempotency_mismatch" ? "INVALID_PARAMS" : "UNSUPPORTED_OPERATION");
      // A check that both refused alike also requires the refusal expected (review standards, rule 2).
      return [viaMcp.code, codeOf(viaA2a.body)];
    };
    // Not invited: `not_allowed`.
    const uninvited = await opening();
    expect(await outcome(uninvited)).toEqual(["not_allowed", "not_allowed"]);
    // Full: both invited, and someone else holds its one place.
    const full = await opening(1);
    for (const who of [overMcp, overA2a, filler]) await invite(full, who.id);
    expect((await claimMcp(filler, full)).code).toBeUndefined();
    expect(await outcome(full)).toEqual(["role_full", "role_full"]);
    // No such opening, and a room the agent isn't in.
    expect(await outcome(`rol_${"0".repeat(32)}`)).toEqual(["role_not_found", "role_not_found"]);
    const elsewhere = (await dash(owner, "POST", "/v1/workspaces", { name: "Elsewhere" })).body.id as string;
    const [mcpCode, a2aCode] = await outcome(uninvited, elsewhere);
    expect(mcpCode).toMatch(/^[a-z_]+$/);
    expect(a2aCode).toBe(mcpCode);
    // Holding another opening: `already_claimed`.
    const [held1, held2, other] = [await opening(), await opening(), await opening(2)];
    await invite(held1, overMcp.id);
    await invite(held2, overA2a.id);
    for (const who of [overMcp, overA2a]) await invite(other, who.id);
    expect((await claimMcp(overMcp, held1)).code).toBeUndefined();
    expect((await claimA2a(overA2a, { workspaceId: room, roleId: held2 })).body.error).toBeUndefined();
    expect(await outcome(other)).toEqual(["already_claimed", "already_claimed"]);
    // Nothing above took a place: the uninvited and the other openings are still unclaimed by either.
    for (const role of [uninvited, other]) {
      const listed = (await dash(owner, "GET", `/v1/workspaces/${room}/roles`)).body.roles.find((r: any) => r.id === role);
      expect(listed.filled, role).toBe(0);
    }
  });

  it("does a retried requestId once, as MCP does a retried key, and refuses one reused for another opening", async () => {
    const agent = await engineer();
    const [role, another] = [await opening(), await opening()];
    await invite(role, agent.id);
    await invite(another, agent.id);
    const requestId = key();
    const first = await claimA2a(agent, { workspaceId: room, roleId: role, requestId });
    const again = await claimA2a(agent, { workspaceId: room, roleId: role, requestId });
    expect(again.body.result).toEqual(first.body.result);
    const reused = await claimA2a(agent, { workspaceId: room, roleId: another, requestId });
    expect([reason(reused.body), codeOf(reused.body)]).toEqual(["INVALID_PARAMS", "idempotency_mismatch"]);
    // MCP gives the same answers for the same keys.
    const mcpAgent = await engineer();
    const [role2, another2] = [await opening(), await opening()];
    await invite(role2, mcpAgent.id);
    await invite(another2, mcpAgent.id);
    const k = key();
    expect((await claimMcp(mcpAgent, role2, room, k)).code).toBeUndefined();
    expect((await claimMcp(mcpAgent, role2, room, k)).code).toBeUndefined();
    expect((await claimMcp(mcpAgent, another2, room, k)).code).toBe("idempotency_mismatch");
    const holders = (await dash(owner, "GET", `/v1/workspaces/${room}/roles`)).body.roles.filter((r: any) => [role, another, role2, another2].includes(r.id)).map((r: any) => r.filled);
    expect(holders.sort()).toEqual([0, 0, 1, 1]);
  });

  it("refuses the wrong A2A version, the extension unnamed, and anything but its three parameters, and claims nothing", async () => {
    const agent = await engineer();
    const role = await opening();
    await invite(role, agent.id);
    for (const version of ["0.3", "2.0", "1.1"]) {
      expect(reason((await claimA2a(agent, { workspaceId: room, roleId: role }, { ...ON, "A2A-Version": version })).body), version).toBe("VERSION_NOT_SUPPORTED");
    }
    expect(reason((await claimA2a(agent, { workspaceId: room, roleId: role }, {})).body)).toBe("EXTENSION_SUPPORT_REQUIRED");
    // Who claims comes from the token: a principal, scopes or a preset in the request are refused by name, and so is a tenant.
    for (const extra of [{ principalId: lead.id }, { preset: "coordinator" }, { scopes: ["admin"] }, { tenant: "ws_other" }]) {
      const res = await claimA2a(agent, { workspaceId: room, roleId: role, ...extra });
      expect([reason(res.body), res.body.error.message], JSON.stringify(extra)).toEqual(["INVALID_PARAMS", `podster.lifecycle.v1.ClaimRole takes no ${Object.keys(extra)[0]}.`]);
    }
    for (const bad of [{ roleId: role }, { workspaceId: room }, { workspaceId: room, roleId: ".." }, { workspaceId: room, roleId: 7 }, { workspaceId: room, roleId: role, requestId: "has space" }]) {
      expect(reason((await claimA2a(agent, bad)).body), JSON.stringify(bad)).toBe("INVALID_PARAMS");
    }
    const listed = (await dash(owner, "GET", `/v1/workspaces/${room}/roles`)).body.roles.find((r: any) => r.id === role);
    expect(listed.filled).toBe(0);
    // And with all of that fixed, it claims.
    expect((await claimA2a(agent, { workspaceId: room, roleId: role })).body.result.status).toBe("active");
  });
});

describe("SubmitTask's commit, against the real API", () => {
  const make = async (assignee: string) =>
    (await mcpTool(lead.mcp, "create_task", { workspace_id: room, title: "Code", instructions: "x", assignee, idempotency_key: key() })).data.id as string;
  const versionOf = async (agent: Agent, task: string) => (await a2a("GetTask", { id: `${room}:${task}` }, agent.a2a)).body.result.metadata["podster.dev/version"] as number;
  const accepted = async (agent: Agent) => {
    const task = await make(agent.id);
    expect((await a2a(M("AcceptTask"), { id: `${room}:${task}`, version: await versionOf(agent, task), requestId: key() }, agent.a2a, ON)).body.result).toBeDefined();
    return task;
  };
  const submitA2a = async (agent: Agent, task: string, params: Record<string, unknown>, headers: Record<string, string> = ON) =>
    a2a(M("SubmitTask"), { id: `${room}:${task}`, version: await versionOf(agent, task), requestId: key(), note: "Done.", ...params }, agent.a2a, headers);
  const submitMcp = async (agent: Agent, task: string, args: Record<string, unknown>) =>
    mcpTool(agent.mcp, "submit_task", { workspace_id: room, task_id: task, version: await versionOf(agent, task), note: "Done.", idempotency_key: key(), ...args });
  const read = async (task: string) => (await mcpTool(lead.mcp, "get_task", { workspace_id: room, task_id: task })).data;

  it("records the commit a submission names, exactly as MCP's submit_task does", async () => {
    const agent = await engineer();
    const sha = "a".repeat(40);
    const [overMcp, overA2a] = [await accepted(agent), await accepted(agent)];
    expect((await submitMcp(agent, overMcp, { commit_sha: sha })).code).toBeUndefined();
    const res = await submitA2a(agent, overA2a, { commitSha: sha });
    expect(res.body.result.metadata["podster.dev/status"]).toBe("submitted");
    const [a, b] = [await read(overMcp), await read(overA2a)];
    expect(b.task.status).toBe(a.task.status);
    expect(b.submissions.map((s: any) => [s.commit_sha, s.note, s.submitted_by])).toEqual([[sha, "Done.", agent.id]]);
    expect(a.submissions.map((s: any) => [s.commit_sha, s.note, s.submitted_by])).toEqual([[sha, "Done.", agent.id]]);
  });

  it("refuses a commit the API refuses with MCP's code, and one that isn't text before it asks, and submits nothing", async () => {
    const agent = await engineer();
    const [overMcp, overA2a] = [await accepted(agent), await accepted(agent)];
    // An empty commit is the API's `invalid_argument` on any task.
    const viaMcp = await submitMcp(agent, overMcp, { commit_sha: "" });
    const viaA2a = await submitA2a(agent, overA2a, { commitSha: "" });
    expect([viaMcp.code, reason(viaA2a.body), codeOf(viaA2a.body)]).toEqual(["invalid_argument", "INVALID_PARAMS", "invalid_argument"]);
    // Not text: MCP's tool schema refuses it, and so does A2A, before the API is asked.
    expect((await submitMcp(agent, overMcp, { commit_sha: 7 })).code).toBeDefined();
    const notText = await submitA2a(agent, overA2a, { commitSha: 7 });
    expect([reason(notText.body), codeOf(notText.body)]).toEqual(["INVALID_PARAMS", undefined]);
    for (const task of [overMcp, overA2a]) expect((await read(task)).task.status, task).toBe("accepted");
  });

  it("refuses a stale version with MCP's code, and does a retried requestId once", async () => {
    const agent = await engineer();
    const [overMcp, overA2a] = [await accepted(agent), await accepted(agent)];
    const sha = "b".repeat(40);
    const stale = { version: 1 };
    expect((await submitMcp(agent, overMcp, { commit_sha: sha, ...stale })).code).toBe("version_conflict");
    expect(codeOf((await submitA2a(agent, overA2a, { commitSha: sha, ...stale })).body)).toBe("version_conflict");
    const version = await versionOf(agent, overA2a);
    const requestId = key();
    const params = { id: `${room}:${overA2a}`, version, requestId, note: "Done.", commitSha: sha };
    const first = await a2a(M("SubmitTask"), params, agent.a2a, ON);
    const again = await a2a(M("SubmitTask"), params, agent.a2a, ON);
    expect(again.body.result.metadata).toEqual(first.body.result.metadata);
    const other = await a2a(M("SubmitTask"), { ...params, commitSha: "c".repeat(40) }, agent.a2a, ON);
    expect(codeOf(other.body)).toBe("idempotency_mismatch");
    expect((await read(overA2a)).submissions.map((s: any) => s.commit_sha)).toEqual([sha]);
  });

  it("refuses the wrong A2A version, and a lead submitting the engineer's task, and submits nothing", async () => {
    const agent = await engineer();
    const task = await accepted(agent);
    expect(reason((await submitA2a(agent, task, { commitSha: "d".repeat(40) }, { ...ON, "A2A-Version": "0.3" })).body)).toBe("VERSION_NOT_SUPPORTED");
    // The wrong agent: MCP's `not_allowed`, which every lifecycle method reads as a missing task (profile, "Refusals").
    const version = await versionOf(agent, task);
    const byLeadMcp = await mcpTool(lead.mcp, "submit_task", { workspace_id: room, task_id: task, version, note: "x", commit_sha: "d".repeat(40), idempotency_key: key() });
    const byLeadA2a = await a2a(M("SubmitTask"), { id: `${room}:${task}`, version, requestId: key(), note: "x", commitSha: "d".repeat(40) }, lead.a2a, ON);
    expect([byLeadMcp.code, reason(byLeadA2a.body)]).toEqual(["not_allowed", "TASK_NOT_FOUND"]);
    expect((await read(task)).task.status).toBe("accepted");
  });
});

/**
 * A stand-in for the API that answers one state and records every request: its method, path, body, key and whose
 * assertion it carried. The gateway's switch is on, so MCP lists get_repo_access and A2A has GetRepoAccess.
 */
function standIn(answer: (method: string, path: string) => Response) {
  const seen: { method: string; path: string; body: string; key: string | null; sub: string | undefined }[] = [];
  const api = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      // The gateway's read of whether the API answers the release routes (M6 step 6, 6g): no, here, and not one of the
      // calls these tests compare. `deploy-release.spec.ts` tests it.
      if (url.pathname === RELEASE_ROUTES_PATH) return reply(200, { answered: false });
      const assertion = request.headers.get("x-podster-assertion");
      seen.push({ method: request.method, path: url.pathname + url.search, body: await request.text(), key: request.headers.get("idempotency-key"), sub: assertion ? decodeJwt(assertion).sub : undefined });
      return answer(request.method, url.pathname);
    },
  } as unknown as Fetcher;
  return { seen, env: { ...e, API: api, MANAGED_REPOSITORIES: "true" } };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusalOf = (status: number, code: string) => reply(status, { error: { code, message: code } });

async function viaMcp(token: string, name: string, args: Record<string, unknown>, environment: object) {
  const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), environment as never, ctx);
  const parsed = await res.json<any>();
  const text = parsed.result?.content?.[0]?.text;
  return parsed.result?.isError ? { code: text as string, data: undefined as any, raw: parsed } : { code: undefined, data: text ? JSON.parse(text) : undefined, raw: parsed };
}
async function viaA2a(token: string, method: string, params: unknown, environment: object, headers: Record<string, string> = ON) {
  const res = await worker.fetch(new Request(`${BASE}/a2a`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "1.0", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }) }), environment as never, ctx);
  return { res, body: await res.json<any>() };
}

describe("GetRepoAccess, against a stand-in API with managed repositories on", () => {
  const WS = `ws_${hex()}`;
  const TASK = `tsk_${hex()}`;
  const TOKEN = `ghs_fake_${hex()}`;
  const granted = { token: TOKEN, expires_at: 1_900_000_000_000, repository: "podster-test-org/engineering", clone_url: "https://github.com/podster-test-org/engineering.git", permissions: { contents: "write", metadata: "read", pull_requests: "write" }, authority_ends_at: null };
  let agent: Agent;
  beforeAll(async () => {
    agent = await agentOnBoth(owner);
  });
  afterEach(() => vi.restoreAllMocks());

  const both = async (answer: Response | (() => Response)) => {
    const make = typeof answer === "function" ? answer : () => answer.clone();
    const mcp = standIn(() => make());
    const a2aSide = standIn(() => make());
    const overMcp = await viaMcp(agent.mcp, "get_repo_access", { workspace_id: WS, task_id: TASK }, mcp.env);
    const overA2a = await viaA2a(agent.a2a, M("GetRepoAccess"), { id: `${WS}:${TASK}` }, a2aSide.env);
    return { overMcp, overA2a, mcpSeen: mcp.seen, a2aSeen: a2aSide.seen };
  };

  it("gives the token MCP gives, from the same API call, with no key and no-store", async () => {
    const { overMcp, overA2a, mcpSeen, a2aSeen } = await both(reply(200, granted));
    expect(overMcp.data).toEqual(granted);
    expect(overA2a.body.result).toEqual(granted);
    expect(overA2a.res.headers.get("cache-control")).toBe("no-store");
    expect(overA2a.res.headers.get("A2A-Extensions")).toBe(URI);
    // One request each, and the same request: route, empty body, no idempotency key, and the same agent asking.
    expect(a2aSeen).toEqual(mcpSeen);
    expect(a2aSeen).toEqual([{ method: "POST", path: `/v1/workspaces/${WS}/tasks/${TASK}/repo-access`, body: "{}", key: null, sub: agent.id }]);
  });

  it("answers every refusal the API gives MCP with MCP's code, and a task the agent can't act on as a missing one", async () => {
    const named: [number, string][] = [
      [403, "grant_required"], [403, "grant_expired"], [403, "grant_stale"], [403, "public_participant"], [403, "controller_departed"],
      [409, "task_not_linked"], [409, "repo_not_ready"], [409, "task_not_active"], [409, "repo_access_busy"],
      [404, "not_found"], [400, "invalid_argument"],
    ];
    for (const [status, code] of named) {
      const { overMcp, overA2a, mcpSeen, a2aSeen } = await both(refusalOf(status, code));
      expect([overMcp.code, codeOf(overA2a.body)], code).toEqual([code, code]);
      expect(reason(overA2a.body), code).toBe(code === "invalid_argument" ? "INVALID_PARAMS" : "UNSUPPORTED_OPERATION");
      expect(a2aSeen, code).toEqual(mcpSeen);
    }
    // Those every lifecycle method reads as missing: MCP names them, and A2A answers as for a task that doesn't exist.
    for (const [status, code] of [[404, "task_not_found"], [404, "workspace_not_found"], [403, "not_allowed"], [403, "access_revoked"], [403, "agent_disconnected"]] as const) {
      const { overMcp, overA2a } = await both(refusalOf(status, code));
      expect([overMcp.code, reason(overA2a.body), codeOf(overA2a.body)], code).toEqual([code, "TASK_NOT_FOUND", undefined]);
    }
    // Try again later: "Internal error", with MCP's code alongside.
    for (const [status, code] of [[429, "rate_limited"], [503, "standing_unknown"], [503, "repo_access_unavailable"], [502, "provider_unavailable"], [502, "provider_mismatch"]] as const) {
      const { overMcp, overA2a } = await both(refusalOf(status, code));
      expect([overMcp.code, overA2a.body.error.code, overA2a.body.error.message, codeOf(overA2a.body)], code).toEqual([code, -32603, "Internal error", code]);
    }
  });

  it("is a refusal to the agent whose would-be grant was refused grantee_public: it holds no grant, over either protocol", async () => {
    // `grantee_public` refuses the person's grant (repo-grants.spec.ts). The agent then has none, and asks in a room it joined
    // publicly, which policy refuses first.
    const { overMcp, overA2a } = await both(refusalOf(403, "public_participant"));
    expect([overMcp.code, codeOf(overA2a.body)]).toEqual(["public_participant", "public_participant"]);
    // No A2A method gives a grant: that's a person's command, and an agent's token reaches nothing like it.
    expect(Object.values(LIFECYCLE_METHODS)).not.toContain("grant_repository");
    expect(() => a2aCapability({ MANAGED_REPOSITORIES: "true" }, "merge_task")).toThrow();
  });

  it("asks the API every time, sending no key, as MCP does: a retry is the API's to answer", async () => {
    const stand = standIn(() => reply(200, granted));
    for (let n = 0; n < 2; n++) expect((await viaA2a(agent.a2a, M("GetRepoAccess"), { id: `${WS}:${TASK}` }, stand.env)).body.result).toEqual(granted);
    expect(stand.seen.map((s) => [s.path, s.key])).toEqual([[`/v1/workspaces/${WS}/tasks/${TASK}/repo-access`, null], [`/v1/workspaces/${WS}/tasks/${TASK}/repo-access`, null]]);
    // Asking for the token takes only the task. Anything else, a requestId included, is refused, and nothing is asked.
    const quiet = standIn(() => reply(200, granted));
    for (const extra of [{ requestId: key() }, { repository: "other/repo" }, { permissions: { administration: "write" } }, { tenant: "x" }]) {
      const res = await viaA2a(agent.a2a, M("GetRepoAccess"), { id: `${WS}:${TASK}`, ...extra }, quiet.env);
      expect(reason(res.body), JSON.stringify(extra)).toBe("INVALID_PARAMS");
    }
    for (const id of ["not-an-id", `${WS}:tsk_short`, undefined]) expect(reason((await viaA2a(agent.a2a, M("GetRepoAccess"), { id }, quiet.env)).body), String(id)).toBe("TASK_NOT_FOUND");
    expect(quiet.seen).toEqual([]);
  });

  it("refuses the wrong A2A version and the extension unnamed, and asks nothing", async () => {
    const stand = standIn(() => reply(200, granted));
    for (const version of ["0.3", "2.0"]) expect(reason((await viaA2a(agent.a2a, M("GetRepoAccess"), { id: `${WS}:${TASK}` }, stand.env, { ...ON, "A2A-Version": version })).body), version).toBe("VERSION_NOT_SUPPORTED");
    expect(reason((await viaA2a(agent.a2a, M("GetRepoAccess"), { id: `${WS}:${TASK}` }, stand.env, {})).body)).toBe("EXTENSION_SUPPORT_REQUIRED");
    expect(stand.seen).toEqual([]);
  });

  it("passes on only the contract's fields, and a body of any other shape is an internal error, never the body", async () => {
    const extra = await both(reply(200, { ...granted, installation_id: 42 }));
    expect(extra.overA2a.body.result).toEqual(granted);
    const broken = await both(reply(200, { token: TOKEN }));
    expect(broken.overA2a.body.error).toEqual({ code: -32603, message: "Internal error" });
    expect(JSON.stringify(broken.overA2a.body)).not.toContain(TOKEN);
  });

  it("never logs the token, and the logs it does write are seen (the control)", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    await both(reply(200, granted));
    await both(reply(200, { token: TOKEN, expires_at: "soon" }));
    await both(refusalOf(503, "repo_access_unavailable"));
    // The control: the malformed answer's failure was logged, by IDs and a status, so a token in a log would have been seen.
    expect(lines.some((l) => l.includes("a2a.internal_error") && l.includes(agent.id))).toBe(true);
    expect(lines.filter((l) => l.includes(TOKEN))).toEqual([]);
    expect(lines.filter((l) => l.includes("ghs_"))).toEqual([]);
  });

  it("doesn't exist while managed repositories are off: it answers as a method that doesn't, as MCP's tool does, and asks nothing", async () => {
    const stand = standIn(() => reply(200, granted));
    const off = { ...stand.env, MANAGED_REPOSITORIES: undefined };
    for (const headers of [ON, {}]) {
      const asked = await viaA2a(agent.a2a, M("GetRepoAccess"), { id: `${WS}:${TASK}` }, off, headers);
      const none = await viaA2a(agent.a2a, M("NoSuchMethod"), { id: `${WS}:${TASK}` }, off, headers);
      expect(asked.body).toEqual(none.body);
      expect(asked.body.error).toEqual({ code: -32601, message: "Method not found" });
    }
    const overMcp = await viaMcp(agent.mcp, "get_repo_access", { workspace_id: WS, task_id: TASK }, off);
    expect(overMcp.raw.result?.isError ?? Boolean(overMcp.raw.error)).toBe(true);
    expect(stand.seen).toEqual([]);
  });

  it("is on the card only while managed repositories are on, as MCP lists its tool", async () => {
    const card = async (environment: object) => (await (await worker.fetch(new Request(`${BASE}/.well-known/agent-card.json`), environment as never, ctx)).json<any>()).capabilities.extensions[0].params.methods as string[];
    // DeployRelease isn't listed here: the real API answers the release routes nowhere (`deploy-release.spec.ts`).
    const listed = Object.keys(LIFECYCLE_METHODS).filter((m) => m !== M("DeployRelease"));
    expect(await card({ ...e, MANAGED_REPOSITORIES: "true" })).toEqual(listed);
    for (const value of [undefined, "", "TRUE", "yes"]) expect(await card({ ...e, MANAGED_REPOSITORIES: value }), String(value)).toEqual(listed.filter((m) => m !== M("GetRepoAccess")));
  });
});

describe("SubmitTask's pull request, against a stand-in API with managed repositories on", () => {
  const WS = `ws_${hex()}`;
  const TASK = `tsk_${hex()}`;
  const SHA = "e".repeat(40);
  const submitted = { id: TASK, status: "submitted", version: 4 };
  let agent: Agent;
  beforeAll(async () => {
    agent = await agentOnBoth(owner);
  });

  const answering = (submit: () => Response) => (method: string, path: string) =>
    method === "GET" ? reply(200, { task: submitted, messages: [], history: [] }) : path.endsWith("/submit") ? submit() : refusalOf(404, "not_found");
  const both = async (submit: () => Response, args: { commit_sha?: unknown; pr_number?: unknown } = { commit_sha: SHA, pr_number: 7 }) => {
    const mcp = standIn(answering(submit));
    const a2aSide = standIn(answering(submit));
    const overMcp = await viaMcp(agent.mcp, "submit_task", { workspace_id: WS, task_id: TASK, version: 3, note: "Done.", ...args, idempotency_key: key() }, mcp.env);
    const params: Record<string, unknown> = { id: `${WS}:${TASK}`, version: 3, requestId: key(), note: "Done." };
    if (args.commit_sha !== undefined) params.commitSha = args.commit_sha;
    if (args.pr_number !== undefined) params.prNumber = args.pr_number;
    const overA2a = await viaA2a(agent.a2a, M("SubmitTask"), params, a2aSide.env);
    return { overMcp, overA2a, mcpSeen: mcp.seen, a2aSeen: a2aSide.seen };
  };
  /** The submit request each sent, but for its key, which each protocol makes from its own. */
  const submits = (seen: { method: string; path: string; body: string; key: string | null; sub: string | undefined }[]) =>
    seen.filter((s) => s.method === "POST").map(({ key: k, ...rest }) => ({ ...rest, keyed: typeof k === "string" && k.length > 0 }));

  it("submits the commit and the pull request in the same API call as MCP, and reads the task back", async () => {
    const { overMcp, overA2a, mcpSeen, a2aSeen } = await both(() => reply(200, submitted));
    expect(overMcp.code).toBeUndefined();
    expect(overA2a.body.result.metadata["podster.dev/status"]).toBe("submitted");
    expect(submits(a2aSeen)).toEqual(submits(mcpSeen));
    expect(JSON.parse(submits(a2aSeen)[0].body)).toEqual({ version: 3, note: "Done.", commit_sha: SHA, pr_number: 7 });
    expect(submits(a2aSeen)[0]).toMatchObject({ path: `/v1/workspaces/${WS}/tasks/${TASK}/submit`, sub: agent.id, keyed: true });
    expect(a2aSeen.find((s) => s.key !== null)?.key).toMatch(/^a2a-lc:/);
  });

  it("answers every refusal of a submission's commit or pull request with MCP's code", async () => {
    const cases: [number, string][] = [
      [400, "invalid_argument"], [404, "pull_request_not_found"], [409, "pull_request_from_fork"], [409, "pull_request_wrong_base"], [409, "pull_request_not_open"],
      [409, "pull_request_draft"], [409, "commit_changed"], [409, "pull_request_in_use"], [409, "pull_request_changed"], [409, "version_conflict"],
      [409, "repo_not_ready"], [409, "pull_request_unread"],
    ];
    for (const [status, code] of cases) {
      const { overMcp, overA2a, mcpSeen, a2aSeen } = await both(() => refusalOf(status, code));
      expect([overMcp.code, codeOf(overA2a.body)], code).toEqual([code, code]);
      // Never read as a missing task: the task was found, and it's the pull request or the repository that was refused.
      expect(reason(overA2a.body), code).not.toBe("TASK_NOT_FOUND");
      expect(submits(a2aSeen), code).toEqual(submits(mcpSeen));
    }
    for (const [status, code] of [[429, "rate_limited"], [503, "repo_access_unavailable"], [502, "provider_unavailable"]] as const) {
      const { overMcp, overA2a } = await both(() => refusalOf(status, code));
      expect([overMcp.code, overA2a.body.error.message, codeOf(overA2a.body)], code).toEqual([code, "Internal error", code]);
    }
  });

  it("checks the pull request's type as MCP's schema does, before asking, and leaves the rest to the API", async () => {
    for (const bad of ["7", 7.5, null, { n: 7 }]) {
      const { overMcp, overA2a, mcpSeen, a2aSeen } = await both(() => reply(200, submitted), { commit_sha: SHA, pr_number: bad });
      expect(overMcp.raw.result?.isError ?? Boolean(overMcp.raw.error), JSON.stringify(bad)).toBe(true);
      expect(reason(overA2a.body), JSON.stringify(bad)).toBe("INVALID_PARAMS");
      expect([submits(mcpSeen), submits(a2aSeen)], JSON.stringify(bad)).toEqual([[], []]);
    }
    // A whole number the API refuses, such as 0 or -1, is the API's to refuse, and both protocols send it on.
    const { mcpSeen, a2aSeen } = await both(() => refusalOf(400, "invalid_argument"), { commit_sha: SHA, pr_number: -1 });
    expect(submits(a2aSeen)).toEqual(submits(mcpSeen));
    expect(JSON.parse(submits(a2aSeen)[0].body).pr_number).toBe(-1);
  });

  it("drops the pull request unread while managed repositories are off, as MCP's tool drops pr_number", async () => {
    const run = async (via: "mcp" | "a2a", prNumber: unknown) => {
      const stand = standIn(answering(() => reply(200, submitted)));
      const off = { ...stand.env, MANAGED_REPOSITORIES: undefined };
      if (via === "mcp") expect((await viaMcp(agent.mcp, "submit_task", { workspace_id: WS, task_id: TASK, version: 3, note: "Done.", commit_sha: SHA, pr_number: prNumber, idempotency_key: key() }, off)).code).toBeUndefined();
      else expect((await viaA2a(agent.a2a, M("SubmitTask"), { id: `${WS}:${TASK}`, version: 3, requestId: key(), note: "Done.", commitSha: SHA, prNumber }, off)).body.result.metadata["podster.dev/status"]).toBe("submitted");
      return submits(stand.seen);
    };
    // Unread means not checked either: a value that isn't a number is dropped too, as MCP's tool drops it.
    for (const prNumber of [7, "seven"]) {
      const [mcpSent, a2aSent] = [await run("mcp", prNumber), await run("a2a", prNumber)];
      expect(a2aSent, String(prNumber)).toEqual(mcpSent);
      expect(JSON.parse(a2aSent[0].body), String(prNumber)).toEqual({ version: 3, note: "Done.", commit_sha: SHA });
    }
  });
});

describe("what an /a2a token reaches", () => {
  it("is exactly the contract's list, and the engineer's three are on it", () => {
    const contract = parse(e.TEST_CAPABILITIES).a2a as Record<string, string | string[]>;
    expect([...new Set(Object.values(contract).flat())].sort()).toEqual([...A2A_CAPABILITIES].sort());
    for (const [method, capability] of Object.entries(LIFECYCLE_METHODS)) expect(contract[method], method).toBe(capability);
    for (const name of ["claim_role", "get_repo_access", "submit_task"]) expect(A2A_CAPABILITIES as readonly string[]).toContain(name);
    for (const name of A2A_CAPABILITIES) expect(CAPABILITIES.map((c) => c.name), name).toContain(name);
  });

  it("reaches no capability MCP alone has, whatever the switch", () => {
    for (const environment of [{}, { MANAGED_REPOSITORIES: "true" }]) {
      for (const c of CAPABILITIES) {
        if ((A2A_CAPABILITIES as readonly string[]).includes(c.name)) continue;
        expect(() => a2aCapability(environment, c.name), c.name).toThrow();
      }
    }
    expect(() => a2aCapability({}, "get_repo_access")).toThrow();
    expect(a2aCapability({ MANAGED_REPOSITORIES: "true" }, "get_repo_access").name).toBe("get_repo_access");
  });

  it("doesn't reach /mcp, and an /mcp token doesn't reach these methods", async () => {
    const agent = await engineer();
    const role = await opening();
    await invite(role, agent.id);
    const atMcp = await worker.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agent.a2a}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claim_role", arguments: { workspace_id: room, role_id: role, idempotency_key: key() } } }) }), e as never, ctx);
    expect(atMcp.status).toBe(401);
    const atA2a = await a2a(M("ClaimRole"), { workspaceId: room, roleId: role, requestId: key() }, agent.mcp, ON);
    expect(atA2a.status).toBe(401);
    const listed = (await dash(owner, "GET", `/v1/workspaces/${room}/roles`)).body.roles.find((r: any) => r.id === role);
    expect(listed.filled).toBe(0);
  });
});
