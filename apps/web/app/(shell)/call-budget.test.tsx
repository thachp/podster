import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { setUrl } from "@/test/next-navigation";

/**
 * The gateway allows a person 120 calls a minute (`RL_ACCOUNT`), and every server render of a page spends some. These pin
 * how many one render of the busiest pages costs, so a new read, or a read repeated per row, fails here first. The shell's
 * `/api/v1/me` and `/api/orgs` and the room's own read are cached for the render, so each counts once however many layouts
 * and pages ask. The session read isn't counted by the gateway's person limit.
 *
 * The viewer here is in one shared organization besides their personal one, in a room with one page of tasks. Each shared
 * organization named adds one read, up to `MAX_NAMED_ORGS`.
 */
const calls = vi.hoisted(() => [] as string[]);
const cached = vi.hoisted(() => new Set<string>());
const replies = new Map<string, GatewayResult<unknown>>();
let room: Record<string, unknown>;

const once = (path: string) => {
  if (!cached.has(path)) calls.push(path);
  cached.add(path);
};

vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    calls.push(path);
    return replies.get(path.split("?")[0]) ?? { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => (once("/api/v1/me"), { ok: true, data: { id: "per_me", org_id: "org_p", orgs: ["org_a", "org_p"], admin_orgs: [], inbox_unread: 1 } }),
  getOrganizations: async () => (
    once("/api/orgs"),
    {
      ok: true,
      data: {
        organizations: [
          { id: "org_a", name: "Org A", personal: 0, role: "member" },
          { id: "org_p", name: "Mine", personal: 1, role: "admin" },
        ],
      },
    }
  ),
}));
vi.mock("@/lib/workroom", () => ({
  loadWorkroom: async (id: string) => (once(`/api/v1/workspaces/${id}`), room),
  canManageWorkroom: (r: { policy_version: number | null }) => r.policy_version !== null,
  isArchived: (r: { status: string }) => r.status === "archived",
}));

const { TasksRead } = await import("./w/[id]/tasks/tasks-read");
const { ArtifactsRead } = await import("./w/[id]/artifacts/artifacts-read");
const { default: Overview } = await import("./w/[id]/overview/page");
const { default: Activity } = await import("./w/[id]/activity/page");
const { default: Attention } = await import("./attention/page");

const params = Promise.resolve({ id: "ws_1" });
const task = { id: "tsk_1", title: "Say hello", status: "submitted", requester: "per_me", reviewer: "per_me", assignee: "agt_1", version: 2, submission_no: 1 };

beforeEach(() => {
  setUrl("/w/ws_1/tasks");
  calls.length = 0;
  cached.clear();
  replies.clear();
  room = { id: "ws_1", name: "Hello World", owner: "per_me", status: "active", policy_version: 3, goal: "Say hello", brief_by: "per_me", members: [{ principal_id: "agt_1", kind: "agent", org_id: "org_p", role: "member" }] };
  replies.set("/api/v1/workspaces/ws_1/tasks", { ok: true, data: { tasks: [task], next_cursor: null } });
  replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_1", name: "Runner" }] } });
  replies.set("/api/orgs/org_a/members", { ok: true, data: { members: [{ person_id: "per_long", name: "Long" }] } });
});

/** Every read a page made, the ones the render shares counted once. */
const spent = () => calls.length;

describe("gateway calls per page render", () => {
  it("Tasks: shell 2, room 1, one page of tasks, the plan, agent names and one organization's people", async () => {
    await TasksRead({ id: "ws_1" });
    expect(calls.toSorted()).toEqual(["/api/agents", "/api/orgs", "/api/orgs/org_a/members", "/api/v1/me", "/api/v1/workspaces/ws_1", "/api/v1/workspaces/ws_1/plan", "/api/v1/workspaces/ws_1/tasks?cursor=&order=newest"].toSorted());
    expect(spent()).toBe(7);
  });

  it("Artifacts: the same as Tasks, with the outputs in place of the plan", async () => {
    await ArtifactsRead({ id: "ws_1" });
    expect(spent()).toBe(7);
  });

  it("Overview, for an owner who can attach files: brief names, roles, files and one page of tasks", async () => {
    await Overview({ params });
    expect(spent()).toBe(8);
  });

  it("Activity: the events, one page of tasks for the filter, and names", async () => {
    await Activity({ params, searchParams: Promise.resolve({}) });
    expect(spent()).toBe(7);
  });

  it("Attention, with three rooms and one unread: inbox, listing, a review read per room, one title read, release and names", async () => {
    replies.set("/api/v1/inbox", { ok: true, data: { events: [{ seq: 1, event_id: "evt_1", workspace_id: "ws_1", type: "task.submitted", task_id: "tsk_1", actor_id: "agt_1", created_at: 1 }], acked_seq: 0, unread: 1, dropped: 0 } });
    replies.set("/api/v1/workspaces", {
      ok: true,
      data: {
        workspaces: ["ws_1", "ws_2", "ws_3"].map((id) => ({ workspace_id: id, workspace_name: id, role: "owner", status: "active" })),
      },
    });
    await Attention();
    expect(spent()).toBe(11);
  });

  it("names ask one read per shared organization, never one per row", async () => {
    replies.set("/api/v1/workspaces/ws_1/tasks", { ok: true, data: { tasks: Array.from({ length: 50 }, (_, index) => ({ ...task, id: `tsk_${index}`, requester: `per_${index}`, assignee: `agt_${index}` })), next_cursor: null } });
    await TasksRead({ id: "ws_1" });
    expect(spent()).toBe(7);
  });
});
