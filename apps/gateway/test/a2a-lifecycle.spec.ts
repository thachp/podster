import { beforeAll, describe, expect, it } from "vitest";
import { a2a, agentOnBoth, dash, mcpTool, setUpSchemas, signUp, type Person } from "./oauth-helpers";

/**
 * M3 step 10: the lifecycle extension (decision 113, ADR 0007). Accept, decline, release and submit are the existing
 * capabilities, called as the agent, and policy and the state machine decide as they do for MCP.
 */

type Agent = Awaited<ReturnType<typeof agentOnBoth>>;
const URI = "https://podster.dev/a2a/lifecycle/v1";
const ON = { "A2A-Extensions": URI };
const M = (name: string) => `podster.lifecycle.v1.${name}`;
const reason = (body: any) => body?.error?.data?.[0]?.reason ?? body?.error?.message;
const id = (room: string, task: string) => `${room}:${task}`;

let owner: Person;
let lead: Agent;
let guest: Agent;
let room: string;

async function addAgent(agentId: string, role: string) {
  const version = (await dash(owner, "GET", `/v1/workspaces/${room}`)).body.policy_version;
  expect((await dash(owner, "POST", `/v1/workspaces/${room}/members`, { principal_id: agentId, kind: "agent", org_id: owner.org, role, policy_version: version })).status).toBe(200);
}
const make = async (assignee?: string) =>
  (await mcpTool(lead.mcp, "create_task", { workspace_id: room, title: "t", instructions: "x", ...(assignee ? { assignee } : {}), idempotency_key: crypto.randomUUID() })).data.id as string;
const read = async (task: string) => (await a2a("GetTask", { id: id(room, task) }, guest.a2a)).body.result;
const call = (name: string, params: Record<string, unknown>, headers: Record<string, string> = ON, token = guest.a2a) =>
  a2a(M(name), { requestId: crypto.randomUUID(), ...params }, token, headers);
const versionOf = async (task: string) => (await read(task)).metadata["podster.dev/version"] as number;

beforeAll(async () => {
  await setUpSchemas();
  owner = await signUp();
  lead = await agentOnBoth(owner);
  guest = await agentOnBoth(owner);
  room = (await dash(owner, "POST", "/v1/workspaces", { name: "Lifecycle" })).body.id;
  await addAgent(lead.id, "member");
  await addAgent(guest.id, "guest");
});

describe("activation", () => {
  it("refuses the methods unless the extension is named in A2A-Extensions", async () => {
    const task = await make(guest.id);
    const res = await call("AcceptTask", { id: id(room, task), version: await versionOf(task) }, {});
    expect(reason(res.body)).toMatch(/EXTENSION_SUPPORT_REQUIRED/);
    expect((await read(task)).metadata["podster.dev/status"]).toBe("offered");
  });

  it("says it's active in the answer's A2A-Extensions", async () => {
    const task = await make(guest.id);
    const res = await call("AcceptTask", { id: id(room, task), version: await versionOf(task) });
    expect(res.res.headers.get("A2A-Extensions")).toBe(URI);
  });
});

describe("the four commands", () => {
  it("accepts, then submits links and a note, and the task reads as submitted", async () => {
    const task = await make(guest.id);
    const accepted = (await call("AcceptTask", { id: id(room, task), version: await versionOf(task) })).body.result;
    expect(accepted.metadata["podster.dev/status"]).toBe("accepted");
    expect(accepted.status.state).toBe("TASK_STATE_WORKING");
    const submitted = (await call("SubmitTask", { id: id(room, task), version: accepted.metadata["podster.dev/version"], note: "Done.", artifacts: [{ uri: "https://example.com/pr/1", label: "PR" }] })).body.result;
    expect(submitted.metadata["podster.dev/status"]).toBe("submitted");
    const full = (await mcpTool(lead.mcp, "get_task", { workspace_id: room, task_id: task })).data;
    expect(full.artifacts.map((a: any) => a.uri)).toEqual(["https://example.com/pr/1"]);
  });

  it("declines an offer with a reason, which hides it from the guest", async () => {
    const task = await make(guest.id);
    const res = await call("DeclineTask", { id: id(room, task), version: await versionOf(task), reason: "Not mine." });
    expect(res.body.error ?? null).toBeNull();
    // The guest no longer sees it, so the answer is the task as the decline left it, with no thread.
    expect(res.body.result.metadata["podster.dev/status"]).toBe("open");
    expect(res.body.result.history ?? []).toEqual([]);
    expect((await a2a("GetTask", { id: id(room, task) }, guest.a2a)).body.error.data[0].reason).toMatch(/TASK_NOT_FOUND/);
    expect((await mcpTool(lead.mcp, "get_task", { workspace_id: room, task_id: task })).data.task.status).toBe("open");
  });

  it("releases an accepted task with a reason", async () => {
    const task = await make(guest.id);
    const accepted = (await call("AcceptTask", { id: id(room, task), version: await versionOf(task) })).body.result;
    await call("ReleaseTask", { id: id(room, task), version: accepted.metadata["podster.dev/version"], reason: "Can't finish." });
    expect((await mcpTool(lead.mcp, "get_task", { workspace_id: room, task_id: task })).data.task.status).toBe("open");
  });
});

describe("what decides, and what's refused", () => {
  it("lets the state machine refuse a move from the wrong state", async () => {
    const task = await make(guest.id);
    expect(reason((await call("SubmitTask", { id: id(room, task), version: await versionOf(task) })).body)).toMatch(/UNSUPPORTED_OPERATION/);
  });

  it("refuses a stale version", async () => {
    const task = await make(guest.id);
    const v = await versionOf(task);
    expect(reason((await call("AcceptTask", { id: id(room, task), version: v + 5 })).body)).toMatch(/INVALID|MALFORMED|changed/i);
  });

  it("answers a hidden task, a missing one and a malformed ID alike, and changes nothing", async () => {
    const hidden = await make();
    const missing = (await call("AcceptTask", { id: id(room, "tsk_" + "0".repeat(32)), version: 1, requestId: "r-1" })).body.error;
    expect((await call("AcceptTask", { id: id(room, hidden), version: 1, requestId: "r-2" })).body.error).toEqual(missing);
    expect((await call("AcceptTask", { id: hidden, version: 1, requestId: "r-3" })).body.error).toEqual(missing);
    expect((await mcpTool(lead.mcp, "get_task", { workspace_id: room, task_id: hidden })).data.task.status).toBe("open");
  });

  it("does a retried requestId once, and refuses one reused for something else", async () => {
    const task = await make(guest.id);
    const v = await versionOf(task);
    const requestId = crypto.randomUUID();
    expect((await call("AcceptTask", { id: id(room, task), version: v, requestId })).body.result).toBeDefined();
    expect((await call("AcceptTask", { id: id(room, task), version: v, requestId })).body.result.metadata["podster.dev/status"]).toBe("accepted");
    expect(reason((await call("ReleaseTask", { id: id(room, task), version: v + 1, requestId, reason: "x" })).body)).toMatch(/INVALID|MALFORMED|already used/i);
  });

  it("refuses unknown parameters, a missing reason, and bad artifacts", async () => {
    const task = await make(guest.id);
    const v = await versionOf(task);
    const bad: [string, Record<string, unknown>][] = [
      ["AcceptTask", { id: id(room, task), version: v, assignee: lead.id }],
      ["AcceptTask", { id: id(room, task), version: "1" }],
      ["AcceptTask", { id: id(room, task), version: v, requestId: "has space" }],
      ["DeclineTask", { id: id(room, task), version: v }],
      ["SubmitTask", { id: id(room, task), version: v, artifacts: [{ uri: "https://x.test", label: "x", extra: 1 }] }],
      ["SubmitTask", { id: id(room, task), version: v, artifacts: Array.from({ length: 11 }, (_, i) => ({ uri: `https://x.test/${i}`, label: "x" })) }],
    ];
    for (const [name, params] of bad) expect((await call(name, params)).body.error, `${name} ${JSON.stringify(params).slice(0, 60)}`).toBeDefined();
    expect((await read(task)).metadata["podster.dev/status"]).toBe("offered");
  });

  it("can't be used to act on someone else's behalf: a lead can't accept the guest's offer", async () => {
    const task = await make(guest.id);
    const res = await call("AcceptTask", { id: id(room, task), version: await versionOf(task) }, ON, lead.a2a);
    expect(res.body.error).toBeDefined();
    expect((await read(task)).metadata["podster.dev/status"]).toBe("offered");
  });
});
