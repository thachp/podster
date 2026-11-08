import type { ListTasksRequest, ListTasksResponse, Task, TaskState } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import { statusesFor, toA2aTask } from "./tasks";

/**
 * M3 step 8: `GetTask` and `ListTasks`, through the same API reads as MCP's `get_task`, `list_tasks` and
 * `list_workspaces`. The room's own access check decides every read. The gateway only finds the room and translates.
 */

/** One read of the API as the calling agent. The gateway resolved who that is from the token, and nothing else. */
export type ApiReads = {
  getTask(workspaceId: string, taskId: string): Promise<{ status: number; body: any }>;
  listTasks(workspaceId: string, query: { cursor?: number; order: "newest" }): Promise<{ status: number; body: any }>;
  listWorkspaces(): Promise<{ status: number; body: any }>;
};

/**
 * An A2A task ID is `<workspace_id>:<task_id>`, and the context ID is the same (ADR 0007, as amended in step 8). The room
 * is a selector only: the room decides whether the caller sees the task. Any other shape is a task that doesn't exist.
 */
const ROOM = /^ws_[0-9a-f]{32}$/;
const TASK = /^tsk_[0-9a-f]{32}$/;

export const a2aTaskId = (workspaceId: string, taskId: string) => `${workspaceId}:${taskId}`;

export function parseA2aTaskId(id: unknown): { workspaceId: string; taskId: string } | null {
  if (typeof id !== "string") return null;
  const parts = id.split(":");
  if (parts.length !== 2 || !ROOM.test(parts[0]) || !TASK.test(parts[1])) return null;
  return { workspaceId: parts[0], taskId: parts[1] };
}

const notFound = () => new TaskNotFoundError("Task not found.");

/** What the API says when the caller can't see a task or isn't in its room. All of it reads as a missing task. */
const HIDDEN = new Set(["task_not_found", "workspace_not_found", "not_allowed", "access_revoked", "agent_disconnected"]);

function refusal(status: number, body: any): Error {
  if (status === 404 || status === 403 || HIDDEN.has(body?.error?.code)) return notFound();
  return new Error("Podster couldn't read this task right now.");
}

/** The API returns at most the 20 newest messages with a task. */
export const MAX_HISTORY = 20;

export async function readTask(api: ApiReads, callerId: string, id: string, historyLength?: number): Promise<Task> {
  const parsed = parseA2aTaskId(id);
  if (!parsed) throw notFound();
  const { status, body } = await api.getTask(parsed.workspaceId, parsed.taskId);
  if (status !== 200) throw refusal(status, body);
  return toA2aTask(id, body.task, callerId, { messages: body.messages, history: body.history, historyLength: Math.min(historyLength ?? MAX_HISTORY, MAX_HISTORY) });
}

/** The most rooms one `ListTasks` looks across. Past that, the profile says the list is incomplete. */
export const MAX_ROOMS = 50;
const MAX_PAGE = 50;
/** A cursor's room, the API cursor of the page it was in, and how many matching tasks of that page were already sent. */
type Cursor = { v: 1; ws: string; c: number; skip: number; f: string };

const encode = (c: Cursor) => btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decode(token: string, filter: string): Cursor {
  try {
    const c = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
    const ok = c?.v === 1 && ROOM.test(c.ws) && Number.isInteger(c.c) && c.c >= 0 && Number.isInteger(c.skip) && c.skip >= 0 && c.skip < MAX_PAGE * 2 && c.f === filter;
    if (ok) return c;
  } catch {
    // Falls through to the refusal.
  }
  throw new RequestMalformedError("That pageToken isn't one Podster gave for this filter.");
}

/**
 * The caller's tasks across their rooms: room by room, in the order `list_workspaces` gives, and newest first within a
 * room. It isn't one list sorted by status time across rooms, which the profile says. A `contextId` narrows it to one task.
 * Each room's own check decides what's in it. Client `tenant` is never read.
 */
export async function listTasks(api: ApiReads, callerId: string, params: ListTasksRequest): Promise<ListTasksResponse> {
  const statuses = statusesFor(params.status as TaskState | undefined);
  const filter = statuses ? statuses.join(",") : "*";
  const pageSize = Math.min(Math.max(params.pageSize ?? MAX_PAGE, 1), MAX_PAGE);
  const historyLength = Math.min(params.historyLength ?? 0, MAX_HISTORY);
  const matches = (status: string) => !statuses || statuses.includes(status);

  if (params.contextId) {
    // A context is one task. A context the caller can't see is just an empty list.
    const one = await readTask(api, callerId, params.contextId, historyLength).catch((error) => {
      if (error instanceof TaskNotFoundError) return null;
      throw error;
    });
    const tasks = one && matches(String(one.metadata?.["podster.dev/status"])) ? [one] : [];
    return { tasks, nextPageToken: "", pageSize, totalSize: tasks.length };
  }

  const rooms = await api.listWorkspaces();
  if (rooms.status !== 200) throw new Error("Podster couldn't list your rooms right now.");
  const ids: string[] = (rooms.body?.workspaces ?? []).map((w: any) => w.workspace_id).filter((id: unknown) => typeof id === "string" && ROOM.test(id)).slice(0, MAX_ROOMS);

  let at: Cursor = params.pageToken ? decode(params.pageToken, filter) : { v: 1, ws: ids[0] ?? "", c: 0, skip: 0, f: filter };
  let index = ids.indexOf(at.ws);
  const out: Task[] = [];
  // A room the caller has left since the cursor was made ends the list rather than guessing where to go on.
  while (index >= 0 && index < ids.length && out.length < pageSize) {
    const ws = ids[index];
    const { status, body } = await api.listTasks(ws, { cursor: at.c || undefined, order: "newest" });
    if (status !== 200) {
      // A room that now refuses the caller is skipped, as if it weren't theirs.
      index += 1;
      at = { v: 1, ws: ids[index] ?? "", c: 0, skip: 0, f: filter };
      continue;
    }
    const found = ((body?.tasks ?? []) as { id: string; status: string }[]).filter((t) => matches(t.status));
    const rest = found.slice(at.skip);
    const room = rest.slice(0, pageSize - out.length);
    for (const t of room) out.push(toA2aTask(a2aTaskId(ws, t.id), t, callerId));
    if (room.length < rest.length) {
      // This API page has more than fits: come back to the same page and skip what was sent.
      at = { ...at, skip: at.skip + room.length };
      return { tasks: out, nextPageToken: encode(at), pageSize, totalSize: out.length };
    }
    const next = body?.next_cursor;
    if (typeof next === "number" && next > 0) {
      at = { v: 1, ws, c: next, skip: 0, f: filter };
    } else {
      index += 1;
      at = { v: 1, ws: ids[index] ?? "", c: 0, skip: 0, f: filter };
    }
  }
  const more = index >= 0 && index < ids.length;
  return { tasks: out, nextPageToken: more ? encode(at) : "", pageSize, totalSize: out.length };
}
