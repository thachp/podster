import type { GatewayResult } from "@/lib/gateway/result";
import { loadTasks } from "../w/[id]/tasks/load-tasks";
import type { Task } from "../w/[id]/tasks/task-model";
import { asksForApprovals, parseApprovals, reviewsFor, type ApprovalItem, type Inbox, type ReviewItem, type RoomEntry } from "./attention-model";

type Query = <T>(path: string) => Promise<GatewayResult<T>>;

/**
 * There's no query across rooms for "reviews assigned to me", so this asks each room, against the person's limit of 120
 * calls a minute. A render costs 2 for the shell (the session read isn't counted), 3 for the inbox, listing and agent
 * names, 1 per shared organization named (`MAX_NAMED_ORGS`), 1 per room asked, and up to `MAX_TITLE_READS`, plus 1 for each
 * room the listing hasn't caught up with. That's 35 at these limits. Opening and closing a task's Sheet doesn't render this
 * page again, but a decision does, and adds the Sheet's own reads, so about 3 decisions a minute use it all up. With 3 rooms,
 * one unread and one shared organization it's 11, the release read below included (`call-budget.test.tsx` pins it). It
 * stops here and says so.
 *
 * Release approvals (M6 step 10(b)) add 1 read while release is off for the deployment, which is everywhere today, when
 * the first room the person owns or administers answers: it answers as a route that doesn't exist, and that says it for
 * every room. If that room can't be read (the person left it, say), the rest are asked too, so it is at most
 * `MAX_APPROVAL_ROOMS`, off or on: at most 45 a render at these limits.
 */
export const MAX_ROOMS = 20;

/** Titles only make a row readable, so they get the smallest share. Past this, a row names its room and not its task. */
export const MAX_TITLE_READS = 5;

/** Rooms asked for release approvals, past which the screen says how many weren't. */
export const MAX_APPROVAL_ROOMS = 10;

/**
 * Release approvals waiting on this person. `unavailable` while release is off for the deployment; `none` when they own
 * and administer no room, so nothing can wait on them; `failed` without the room listing, which says where to ask.
 */
export type Approvals =
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "failed" }
  | { state: "read"; items: ApprovalItem[]; failedRooms: number; fullRooms: number; uncheckedRooms: number };

export type Attention = {
  inbox: Inbox | null;
  reviews: ReviewItem[] | null;
  /** Rooms that couldn't be read. What's listed is then only part of the answer, and the screen must say so. */
  failedRooms: number;
  /** Rooms with more submissions than one page, so there may be reviews past it. */
  fullRooms: number;
  /** Rooms not asked at all, past `MAX_ROOMS`. */
  uncheckedRooms: number;
  roomNames: Record<string, string>;
  taskTitles: Record<string, string>;
  approvals: Approvals;
};

/** Hidden or gone since the listing was written. Read models lag, and only the room itself decides. Not a failure. */
const isGone = (result: { status: number }) => result.status === 403 || result.status === 404;

export async function loadAttention(query: Query, me: string): Promise<Attention> {
  const [inboxResult, roomsResult] = await Promise.all([query<Inbox>("/api/v1/inbox?limit=50"), query<{ workspaces: RoomEntry[] }>("/api/v1/workspaces")]);
  const inbox = inboxResult.ok ? inboxResult.data : null;
  const roomNames: Record<string, string> = {};
  // Nothing can be decided in an archived room. The listing can lag, and the room would still refuse.
  const archived = new Set<string>();
  if (roomsResult.ok) {
    for (const room of roomsResult.data.workspaces) {
      roomNames[room.workspace_id] = room.workspace_name;
      if (room.status === "archived") archived.add(room.workspace_id);
    }
  }

  // The listing can lag behind a room this person was just added to, and the inbox knows about those.
  const inboxRooms = new Set(inbox?.events.map((event) => event.workspace_id) ?? []);
  const rooms = [...new Set([...Object.keys(roomNames), ...inboxRooms])];
  const asked = rooms.slice(0, MAX_ROOMS);
  const titled = new Set([...inboxRooms].slice(0, MAX_TITLE_READS));

  const taskTitles: Record<string, string> = {};
  let failedRooms = 0;
  let fullRooms = 0;
  const reviews: ReviewItem[] = [];
  await Promise.all(
    asked.map(async (workspace) => {
      // Without the listing or the inbox event there's no name to show yet, and the room's own read has it.
      if (!roomNames[workspace]) {
        const room = await query<{ name: string }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}`);
        if (room.ok) roomNames[workspace] = room.data.name;
      }
      const submitted = await loadTasks(query, workspace, "&status=submitted&mine=true", 1);
      if (!submitted.ok) {
        if (!isGone(submitted)) failedRooms += 1;
        return;
      }
      if (submitted.data.more && !archived.has(workspace)) fullRooms += 1;
      if (!archived.has(workspace)) for (const task of reviewsFor(submitted.data.tasks, me)) reviews.push({ workspace, workspaceName: roomNames[workspace] ?? workspace, task });
      remember(taskTitles, submitted.data.tasks);
      // Inbox events carry IDs only. A title makes a row readable, and it's worth one more read only where there's something unread.
      if (titled.has(workspace)) {
        const mine = await query<{ tasks: Task[] }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/tasks?mine=true`);
        if (mine.ok) remember(taskTitles, mine.data.tasks);
      }
    }),
  );

  const approvals = roomsResult.ok ? await loadApprovals(query, roomsResult.data.workspaces, roomNames) : ({ state: "failed" } as const);

  return {
    inbox,
    // Without the listing, this can't say what's in rooms it never heard of, so it says nothing rather than too little.
    reviews: roomsResult.ok ? reviews.toReversed() : null,
    failedRooms,
    fullRooms,
    uncheckedRooms: rooms.length - asked.length,
    roomNames,
    taskTitles,
    approvals,
  };
}

/** The room listing's own answer for "release is off for the deployment": the route answers exactly as one that doesn't exist. */
const releaseOff = (result: { ok: boolean; status?: number; code?: string }) => !result.ok && result.status === 404 && result.code === "not_found";

async function loadApprovals(query: Query, listed: RoomEntry[], roomNames: Record<string, string>): Promise<Approvals> {
  const rooms = listed.filter((room) => asksForApprovals(room.role)).map((room) => room.workspace_id);
  if (rooms.length === 0) return { state: "none" };
  const asked = rooms.slice(0, MAX_APPROVAL_ROOMS);
  const read = (workspace: string) => query<unknown>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/release-approvals`);
  // Release is switched on or off for the whole deployment, so any room's "no such route" says it for every room. The
  // first room is asked alone, so today that is one read; only if it answers something else are the rest asked.
  const first = await read(asked[0]);
  if (releaseOff(first)) return { state: "unavailable" };
  const answers = [first, ...(await Promise.all(asked.slice(1).map(read)))];
  if (answers.some(releaseOff)) return { state: "unavailable" };
  const items: ApprovalItem[] = [];
  let failedRooms = 0;
  let fullRooms = 0;
  answers.forEach((answer, index) => {
    const workspace = asked[index];
    if (!answer.ok) {
      // A room that couldn't be read, whether it failed, the person left it or their role changed since the listing, is
      // counted, so the screen never calls a list it couldn't read empty (review standard 3).
      failedRooms += 1;
      return;
    }
    const parsed = parseApprovals(answer.data);
    if (!parsed) {
      failedRooms += 1;
      return;
    }
    if (parsed.more) fullRooms += 1;
    for (const release of parsed.releases) items.push({ workspace, workspaceName: roomNames[workspace] ?? workspace, release });
  });
  items.sort((a, b) => b.release.requested_at - a.release.requested_at);
  return { state: "read", items, failedRooms, fullRooms, uncheckedRooms: rooms.length - asked.length };
}

function remember(titles: Record<string, string>, tasks: Task[]) {
  for (const task of tasks) titles[task.id] = task.title;
}
