import { describe, expect, it } from "vitest";
import type { Task } from "../w/[id]/tasks/task-model";
import { acknowledgeUpTo, describeEvent, type InboxEvent } from "./attention-model";
import { loadAttention, MAX_ROOMS, MAX_TITLE_READS } from "./load-attention";

const task = (id: string, over: Partial<Task> = {}) => ({ id, title: `Title ${id}`, status: "submitted", reviewer: "per_me", submission_no: 1, ...over });
const ok = (data: unknown) => ({ ok: true as const, data });
const fail = (status: number) => ({ ok: false as const, status, code: "x" });
const event = (over: Partial<InboxEvent> = {}): InboxEvent => ({ seq: 1, event_id: "e", workspace_id: "ws_1", type: "task.submitted", task_id: "tsk_1", actor_id: "agt_a", created_at: 1, ...over });
const emptyInbox = { events: [], acked_seq: 0, unread: 0, dropped: 0 };

function stub(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const query = async <T,>(path: string) => {
    asked.push(path);
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    return (hit ? hit[1] : fail(404)) as never as import("@/lib/gateway/result").GatewayResult<T>;
  };
  return { query, asked };
}

const page = (tasks: unknown[]) => ok({ tasks, next_cursor: null });

describe("loadAttention", () => {
  it("leaves out reviews in an archived room, where nothing can be decided", async () => {
    const { query } = stub({
      "/api/v1/inbox": ok(emptyInbox),
      "/api/v1/workspaces/ws_1/tasks": page([task("a")]),
      "/api/v1/workspaces/ws_2/tasks": page([task("b")]),
      "/api/v1/workspaces": ok({
        workspaces: [
          { workspace_id: "ws_1", workspace_name: "One", role: "member", status: "archived" },
          { workspace_id: "ws_2", workspace_name: "Two", role: "member", status: "active" },
        ],
      }),
    });
    const result = await loadAttention(query, "per_me");
    expect(result.reviews?.map((item) => item.task.id)).toEqual(["b"]);
    expect(result.taskTitles.a).toBe("Title a");
  });

  it("finds reviews by asking each room's current state, newest first, for this person only", async () => {
    const { query, asked } = stub({
      "/api/v1/inbox": ok(emptyInbox),
      "/api/v1/workspaces/ws_1/tasks": page([task("a"), task("b", { reviewer: "per_x" }), task("c")]),
      "/api/v1/workspaces/ws_2/tasks": page([task("d", { status: "completed" })]),
      "/api/v1/workspaces": ok({
        workspaces: [
          { workspace_id: "ws_1", workspace_name: "One", role: "member" },
          { workspace_id: "ws_2", workspace_name: "Two", role: "member" },
        ],
      }),
    });
    const result = await loadAttention(query, "per_me");
    expect(result.reviews?.map((item) => [item.workspaceName, item.task.id])).toEqual([
      ["One", "c"],
      ["One", "a"],
    ]);
    expect(result.failedRooms).toBe(0);
    expect(asked).toContain("/api/v1/workspaces/ws_1/tasks?cursor=&status=submitted&mine=true");
  });

  it("a room that fails is counted, so an empty answer can't look complete", async () => {
    const { query } = stub({
      "/api/v1/inbox": ok(emptyInbox),
      "/api/v1/workspaces/ws_1/tasks": fail(500),
      "/api/v1/workspaces": ok({ workspaces: [{ workspace_id: "ws_1", workspace_name: "One", role: "member" }] }),
    });
    const result = await loadAttention(query, "per_me");
    expect(result.reviews).toEqual([]);
    expect(result.failedRooms).toBe(1);
  });

  it("a room the person has lost isn't a failure: the listing lags, and it's simply gone", async () => {
    const { query } = stub({
      "/api/v1/inbox": ok(emptyInbox),
      "/api/v1/workspaces/ws_1/tasks": fail(403),
      "/api/v1/workspaces": ok({ workspaces: [{ workspace_id: "ws_1", workspace_name: "One", role: "member" }] }),
    });
    expect((await loadAttention(query, "per_me")).failedRooms).toBe(0);
  });

  it("without the room listing it gives no review answer at all", async () => {
    const { query } = stub({ "/api/v1/inbox": ok(emptyInbox), "/api/v1/workspaces": fail(500) });
    expect((await loadAttention(query, "per_me")).reviews).toBeNull();
  });

  it("a failed inbox doesn't take reviews with it", async () => {
    const { query } = stub({ "/api/v1/inbox": fail(500), "/api/v1/workspaces/ws_1/tasks": page([task("a")]), "/api/v1/workspaces": ok({ workspaces: [{ workspace_id: "ws_1", workspace_name: "One", role: "member" }] }) });
    const result = await loadAttention(query, "per_me");
    expect(result.inbox).toBeNull();
    expect(result.reviews).toHaveLength(1);
  });

  it("reaches a room the listing hasn't caught up with, through the inbox", async () => {
    const { query } = stub({
      "/api/v1/inbox": ok({ ...emptyInbox, events: [event({ workspace_id: "ws_new" })], unread: 1 }),
      "/api/v1/workspaces/ws_new/tasks": page([task("a")]),
      "/api/v1/workspaces/ws_new": ok({ name: "New room" }),
      "/api/v1/workspaces": ok({ workspaces: [] }),
    });
    const result = await loadAttention(query, "per_me");
    expect(result.reviews?.[0]).toMatchObject({ workspace: "ws_new", workspaceName: "New room" });
    expect(result.roomNames.ws_new).toBe("New room");
    expect(result.taskTitles.a).toBe("Title a");
  });

  it("reads one page of submissions per room, and says when there's more", async () => {
    const { query, asked } = stub({
      "/api/v1/inbox": ok(emptyInbox),
      "/api/v1/workspaces/ws_1/tasks": ok({ tasks: [task("a")], next_cursor: "tsk_a" }),
      "/api/v1/workspaces": ok({ workspaces: [{ workspace_id: "ws_1", workspace_name: "One", role: "member" }] }),
    });
    const result = await loadAttention(query, "per_me");
    expect(result.fullRooms).toBe(1);
    expect(result.failedRooms).toBe(0);
    expect(result.reviews).toHaveLength(1);
    expect(asked.filter((path) => path.includes("/tasks"))).toHaveLength(1);
  });

  it("keeps a full page within its budget, however many rooms have unread updates", async () => {
    const workspaces = Array.from({ length: MAX_ROOMS }, (_, i) => ({ workspace_id: `ws_${i}`, workspace_name: `Room ${i}`, role: "member" }));
    const events = workspaces.map((room, i) => event({ seq: i + 1, event_id: `e${i}`, workspace_id: room.workspace_id }));
    const { query, asked } = stub({ "/api/v1/inbox": ok({ ...emptyInbox, events, unread: events.length }), "/api/v1/workspaces/": page([]), "/api/v1/workspaces": ok({ workspaces }) });
    await loadAttention(query, "per_me");
    expect(asked).toHaveLength(2 + MAX_ROOMS + MAX_TITLE_READS);
  });

  it("stops at its limit and says how many it didn't ask", async () => {
    const workspaces = Array.from({ length: MAX_ROOMS + 3 }, (_, i) => ({ workspace_id: `ws_${i}`, workspace_name: `Room ${i}`, role: "member" }));
    const { query, asked } = stub({ "/api/v1/inbox": ok(emptyInbox), "/api/v1/workspaces?": ok({}), "/api/v1/workspaces/": page([]), "/api/v1/workspaces": ok({ workspaces }) });
    const result = await loadAttention(query, "per_me");
    expect(result.uncheckedRooms).toBe(3);
    expect(asked.filter((path) => path.includes("/tasks"))).toHaveLength(MAX_ROOMS);
  });
});

describe("inbox wording", () => {
  it("acknowledges up to the newest shown, whatever order they're in", () => {
    expect(acknowledgeUpTo([event({ seq: 9 }), event({ seq: 4 }), event({ seq: 7 })])).toBe(9);
  });
  it("uses names we know, and an unknown event claims nothing", () => {
    expect(describeEvent(event(), "per_me", { agt_a: "Architect" })).toBe("Architect submitted work for review");
    expect(describeEvent(event({ actor_id: "per_me", type: "task.canceled" }), "per_me", {})).toBe("You canceled a task");
    expect(describeEvent(event({ type: "task.future", actor_id: null }), "per_me", {})).toBe("Someone made a change");
  });
});
