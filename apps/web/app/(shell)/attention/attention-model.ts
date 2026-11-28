import { textNameOf, type Names, type Task } from "../w/[id]/tasks/task-model";

export type InboxEvent = { seq: number; event_id: string; workspace_id: string; type: string; task_id: string | null; actor_id: string | null; created_at: number };
export type Inbox = { events: InboxEvent[]; acked_seq: number; unread: number; dropped: number };
export type RoomEntry = { workspace_id: string; workspace_name: string; role: string; status?: string | null };

export type ReviewItem = { workspace: string; workspaceName: string; task: Task };

/** The acknowledgement covers exactly what was on screen. The cursor can't skip, so that's everything up to the newest shown. */
export const acknowledgeUpTo = (events: InboxEvent[]) => events.reduce((newest, event) => Math.max(newest, event.seq), 0);

const SENTENCES: Record<string, string> = {
  "task.offered": "offered a task",
  "task.reassigned": "offered a task to someone else",
  "task.updated": "edited a task",
  "task.reviewer_changed": "changed who reviews a task",
  "task.requester_changed": "changed who requested a task",
  "task.accepted": "accepted a task",
  "task.declined": "declined a task",
  "task.released": "released a task",
  "task.submitted": "submitted work for review",
  "task.changes_requested": "requested changes",
  "task.completed": "approved a task",
  "task.canceled": "canceled a task",
  "task.assignee_departed": "recorded that a task lost its assignee",
  "task.needs_attention": "recorded that someone left, so a task needs a new reviewer or requester",
  "task.message": "posted a message",
};

/** System wording around IDs only. Inbox events carry no agent text, and none goes in here. */
export function describeEvent(event: Pick<InboxEvent, "type" | "actor_id">, me: string, names: Names) {
  const who = event.actor_id ? textNameOf(event.actor_id, me, names) : "Someone";
  return `${who} ${SENTENCES[event.type] ?? "made a change"}`;
}

/**
 * A release awaiting a person's approval, as `listReleaseApprovals` gives it (M6 step 10(b)). IDs, a commit and a time
 * only. M8 step 9 adds, for a release made from a preview, the preview release, its exact build, when that build reached
 * the preview, its storage warning, whether the preview now shows another build, and Podster's fixed words for both
 * (`podster_core::preview_build`). Each is null for a release not made from one, and absent from an older answer.
 */
export type ReleaseApproval = {
  id: string;
  task_id: string | null;
  commit_sha: string;
  state: "awaiting_approval";
  requested_by: string;
  requested_at: number;
  from_preview?: string | null;
  build_id?: string | null;
  preview_served_at?: number | null;
  storage_warning?: boolean | null;
  preview_replaced?: boolean | null;
  preview_notice?: string | null;
  storage_notice?: string | null;
};

/** The build an approval must send back, only for a release made from a preview. Null means approving takes no body. */
export const approvalBuild = (release: ReleaseApproval) => (release.from_preview ? (release.build_id ?? null) : null);

const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || value === null || check(value);
const isText = (value: unknown) => typeof value === "string";
const isFlag = (value: unknown) => typeof value === "boolean";

/** A release made from a preview names a well-formed preview release and its build, or the row isn't one this page can approve. */
const previewFieldsFine = (r: Record<string, unknown>) =>
  optional(r.from_preview, (value) => typeof value === "string" && /^rel_[0-9a-f]{32}$/.test(value)) &&
  optional(r.build_id, (value) => typeof value === "string" && /^bld_[0-9a-f]{32}$/.test(value)) &&
  (r.from_preview === undefined || r.from_preview === null || typeof r.build_id === "string") &&
  optional(r.preview_served_at, (value) => typeof value === "number") &&
  optional(r.storage_warning, isFlag) &&
  optional(r.preview_replaced, isFlag) &&
  optional(r.preview_notice, isText) &&
  optional(r.storage_notice, isText);
export type ApprovalItem = { workspace: string; workspaceName: string; release: ReleaseApproval };

/** Only the room's owner and admins are answered the list; anyone else would be refused, so isn't asked. Display only: the room decides. */
export const asksForApprovals = (role: string) => role === "owner" || role === "admin";

const isApproval = (value: unknown): value is ReleaseApproval => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    /^rel_[0-9a-f]{32}$/.test(r.id) &&
    (r.task_id === null || typeof r.task_id === "string") &&
    typeof r.commit_sha === "string" &&
    /^[0-9a-f]{40}$/.test(r.commit_sha) &&
    r.state === "awaiting_approval" &&
    typeof r.requested_by === "string" &&
    typeof r.requested_at === "number" &&
    previewFieldsFine(r)
  );
};

/** The list's answer, read for shape. Anything else is null, which is a failed read and never "nothing awaiting" (review standard 3). */
export function parseApprovals(body: unknown): { releases: ReleaseApproval[]; more: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const { releases, more } = body as { releases?: unknown; more?: unknown };
  if (!Array.isArray(releases) || typeof more !== "boolean" || !releases.every(isApproval)) return null;
  return { releases, more };
}

/** Reviews this person can decide now. It's read from each room's current state, so a decided review is simply gone, acknowledged or not. */
export const reviewsFor = (tasks: Task[], me: string) => tasks.filter((task) => task.status === "submitted" && task.reviewer === me);
