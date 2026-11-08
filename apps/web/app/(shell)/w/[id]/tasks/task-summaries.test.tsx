import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import type { Room, Task, TaskSummary } from "./task-model";
import { useTaskPages } from "./task-pages";
import { NEWEST_QUERY, REVIEW_QUERY } from "./task-views";

/** Every way a task gets into the list's state, which must not hold instructions: at 64 KB each, a long list would keep hundreds of megabytes. */
const full = (id: string, version = 1): Task => ({ id, title: id, instructions: "LONG", acceptance_criteria: "LONG", requester: "per_me", assignee: null, reviewer: "per_o", status: "open", version, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false });
const room: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] };

const seen = vi.hoisted(() => ({ rows: [] as unknown[], onTaskRead: undefined as undefined | ((task: unknown) => void), onTask: undefined as undefined | ((task: unknown) => void) }));
vi.mock("./task-list", () => ({ TaskList: ({ tasks }: { tasks: TaskSummary[] }) => ((seen.rows = tasks), null) }));
vi.mock("./task-sheet", () => ({ TaskSheet: ({ onTaskRead }: { onTaskRead: (task: unknown) => void }) => ((seen.onTaskRead = onTaskRead), null) }));
vi.mock("./new-task", () => ({ NewTask: ({ onTask }: { onTask: (task: unknown) => void }) => ((seen.onTask = onTask), null) }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => (path.includes("/tasks") ? { ok: true, data: { tasks: [full("a")], next_cursor: null } } : { ok: false, status: 404, code: "x" }),
  getIdentity: async () => ({ ok: true, data: { id: "per_me" } }),
  getOrganizations: async () => ({ ok: true, data: { organizations: [] } }),
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => room }));

const { TasksRead } = await import("./tasks-read");
const { TasksScreen } = await import("./tasks-screen");

const expectSummaries = (rows: unknown[]) => {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).not.toHaveProperty("instructions");
    expect(row).not.toHaveProperty("acceptance_criteria");
  }
};

beforeEach(() => {
  setUrl("/w/ws_1/tasks");
  seen.rows = [];
});

describe("what a list holds", () => {
  it("reads newest first, in the page's own read and later ones", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (path: string) => (paths.push(path), new Response(JSON.stringify({ tasks: [], next_cursor: null }), { status: 200 })));
    const { result } = renderHook(() => useTaskPages("ws_1", NEWEST_QUERY, "tsk_c50", 0, null));
    act(() => result.current.load());
    await waitFor(() => expect(paths).toEqual(["/api/v1/workspaces/ws_1/tasks?cursor=tsk_c50&order=newest"]));
    expect(NEWEST_QUERY).toBe("&order=newest");
    expect(REVIEW_QUERY).toContain(NEWEST_QUERY);
  });

  it("the page's own read", async () => {
    const element = await TasksRead({ id: "ws_1" });
    expectSummaries((element.props as { read: { tasks: unknown[] } }).read.tasks);
  });

  it("a later page", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tasks: [full("b")], next_cursor: null }), { status: 200 }));
    const { result } = renderHook(() => useTaskPages("ws_1", "", "tsk_c50", 0, null));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expectSummaries(result.current.tasks);
  });

  it("a task the Sheet read or a command answered, and a task just created", () => {
    render(<TasksScreen room={room} tasks={[{ ...full("a"), instructions: undefined, acceptance_criteria: undefined } as unknown as TaskSummary]} cursor={null} me="per_me" names={{}} />);
    act(() => seen.onTaskRead?.(full("a", 2)));
    act(() => seen.onTask?.(full("new")));
    expect(seen.rows).toHaveLength(2);
    expectSummaries(seen.rows);
    // On top until a read of the first page has it.
    expect((seen.rows[0] as TaskSummary).id).toBe("new");
  });
});
