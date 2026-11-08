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
  listTasks(workspaceId: string, query: { cursor?: number; order: "newest"; status?: string }): Promise<{ status: number; body: any }>;
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

/**
 * The API couldn't answer: a 5xx, a 429, or a request it refused as malformed. The client only ever sees "Internal error",
 * and the status is for the gateway's own log, by ID.
 */
export class UpstreamError extends Error {
  constructor(readonly status: number) {
    super("Internal error");
  }
}

/** What the API says when the caller can't see a task or isn't in its room. All of it reads as a missing task. */
const HIDDEN = new Set(["task_not_found", "workspace_not_found", "not_allowed", "access_revoked", "agent_disconnected"]);
const isHidden = (status: number, body: any) => status === 403 || status === 404 || HIDDEN.has(body?.error?.code);

/** The API returns at most the 20 newest messages with a task. */
export const MAX_HISTORY = 20;

export async function readTask(api: ApiReads, callerId: string, id: string, historyLength?: number): Promise<Task> {
  const parsed = parseA2aTaskId(id);
  if (!parsed) throw notFound();
  const { status, body } = await api.getTask(parsed.workspaceId, parsed.taskId);
  if (status !== 200) throw isHidden(status, body) ? notFound() : new UpstreamError(status);
  return toA2aTask(id, body.task, callerId, { messages: body.messages, history: body.history, historyLength: Math.min(historyLength ?? MAX_HISTORY, MAX_HISTORY) });
}

/**
 * The most rooms one `ListTasks` looks across. Rooms past it aren't listed, and the answer says so with
 * `INCOMPLETE_HEADER`, because A2A's list response has no field for it.
 */
export const MAX_LIST_ROOMS = 50;
export const INCOMPLETE_HEADER = "Podster-List-Incomplete";
/** The most API reads one `ListTasks` makes. Reaching it ends the page early, with a token to go on from. */
export const MAX_LIST_CALLS = 60;
const MAX_PAGE = 50;
/** An API cursor is a task's position in its room. Anything past this isn't one Podster gave. */
const MAX_API_CURSOR = 2 ** 40;

/** What a read learned that the A2A answer can't carry, for the route to add as a header. */
export type ReadNotes = { incompleteRooms?: boolean };

/**
 * Where a list goes on from: a room, which of the filter's API statuses it was reading (or every status), the API cursor
 * of the page it was in, and the last task it sent from that page, so the next page starts after it.
 */
type Cursor = { v: 2; ws: string; s: number; c: number; after: string; f: string };

const encode = (c: Cursor) => btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decode(token: string, filter: string, passCount: number): Cursor {
  try {
    const c = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
    const ok =
      c?.v === 2 &&
      ROOM.test(c.ws) &&
      Number.isSafeInteger(c.s) && c.s >= 0 && c.s < passCount &&
      Number.isSafeInteger(c.c) && c.c >= 0 && c.c < MAX_API_CURSOR &&
      (c.after === "" || TASK.test(c.after)) &&
      c.f === filter;
    if (ok) return c;
  } catch {
    // Falls through to the refusal.
  }
  throw new RequestMalformedError("That pageToken isn't one Podster gave for this filter.");
}

/**
 * The caller's tasks across their rooms: rooms in ID order, so renaming one can't reorder paging, and newest first
 * within a room. The API filters by status, once for each Podster status the A2A state means, so the gateway never reads
 * tasks only to drop them. A `contextId` narrows it to one task. Each room's own check decides what's in it. A client's
 * `tenant` is never read.
 */
export async function listTasks(api: ApiReads, callerId: string, params: ListTasksRequest, notes: ReadNotes = {}): Promise<ListTasksResponse> {
  const statuses = statusesFor(params.status as TaskState | undefined);
  const requested = Number(params.pageSize);
  const pageSize = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), MAX_PAGE) : MAX_PAGE;
  const historyLength = Math.min(params.historyLength ?? 0, MAX_HISTORY);
  // A state no Podster task has matches nothing, without asking any room.
  if (statuses && statuses.length === 0) return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };
  const passes: (string | undefined)[] = statuses ?? [undefined];
  const filter = statuses ? statuses.join(",") : "*";

  if (params.contextId) {
    // A context is one task. A context the caller can't see is just an empty list.
    const one = await readTask(api, callerId, params.contextId, historyLength).catch((error) => {
      if (error instanceof TaskNotFoundError) return null;
      throw error;
    });
    const tasks = one && (!statuses || statuses.includes(String(one.metadata?.["podster.dev/status"]))) ? [one] : [];
    return { tasks, nextPageToken: "", pageSize, totalSize: tasks.length };
  }

  const rooms = await api.listWorkspaces();
  if (rooms.status !== 200) throw new UpstreamError(rooms.status);
  const all: string[] = (rooms.body?.workspaces ?? []).map((w: any) => w.workspace_id).filter((id: unknown) => typeof id === "string" && ROOM.test(id)).sort();
  if (all.length > MAX_LIST_ROOMS) notes.incompleteRooms = true;
  const ids = all.slice(0, MAX_LIST_ROOMS);

  let at: Cursor = params.pageToken ? decode(params.pageToken, filter, passes.length) : { v: 2, ws: ids[0] ?? "", s: 0, c: 0, after: "", f: filter };
  let index = ids.indexOf(at.ws);
  const out: Task[] = [];
  let calls = 0;
  const nextRoom = () => {
    index += 1;
    at = { v: 2, ws: ids[index] ?? "", s: 0, c: 0, after: "", f: filter };
  };
  // A room the caller has left since the cursor was made ends the list rather than guessing where to go on.
  while (index >= 0 && index < ids.length && out.length < pageSize) {
    if (calls >= MAX_LIST_CALLS) return { tasks: out, nextPageToken: encode(at), pageSize, totalSize: out.length };
    calls += 1;
    const ws = ids[index];
    const { status, body } = await api.listTasks(ws, { cursor: at.c || undefined, order: "newest", status: passes[at.s] });
    if (status !== 200) {
      // Only a room that now refuses the caller is passed over, as if it weren't theirs. Anything else fails the read,
      // so a list is never silently short.
      if (!isHidden(status, body)) throw new UpstreamError(status);
      nextRoom();
      continue;
    }
    const found = (body?.tasks ?? []) as { id: string; status: string }[];
    // Go on after the last task sent from this page. If that task is no longer on it, the page starts again: a task may
    // repeat, and none still on this page is skipped.
    const resumeAt = at.after ? found.findIndex((t) => t.id === at.after) + 1 : 0;
    const rest = found.slice(resumeAt);
    const room = rest.slice(0, pageSize - out.length);
    for (const t of room) out.push(toA2aTask(a2aTaskId(ws, t.id), t, callerId));
    if (room.length < rest.length) {
      at = { ...at, after: room[room.length - 1].id };
      return { tasks: out, nextPageToken: encode(at), pageSize, totalSize: out.length };
    }
    const next = body?.next_cursor;
    if (typeof next === "number" && next > 0 && next < MAX_API_CURSOR) at = { ...at, c: next, after: "" };
    else if (at.s + 1 < passes.length) at = { ...at, s: at.s + 1, c: 0, after: "" };
    else nextRoom();
  }
  const more = index >= 0 && index < ids.length;
  return { tasks: out, nextPageToken: more ? encode(at) : "", pageSize, totalSize: out.length };
}
