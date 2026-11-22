/**
 * Runner's record of offers, as pure functions over its state: what an inbox page and a task listing change. No I/O.
 *
 * Inbox events and listed tasks are Podster's content. Only IDs, a sequence, an event type, a status and a version are
 * taken from them, each checked for its shape; a task's title, instructions and everything else it says are dropped here,
 * so they never reach the record or a log.
 */
import { isId, type Offer, type RoleCheck, type RunnerState } from "./state.js";

/** Most offers kept. Past this, those least recently changed are dropped first. */
export const OFFERS_KEPT = 5000;
const TYPE = /^[a-z][a-z0-9_.]{0,63}$/;
/** Event types that put a task in the record. Any other event only updates a task already there. */
const STARTS = new Set(["task.offered", "task.changes_requested"]);
/**
 * Event types with no task that Runner records (issue 522): an invite to one of a room's role openings. The event names
 * only the room, so the room is recorded to be read with `list_role_openings`. Any other event with no task moves only
 * the cursor, as before.
 */
export const ROLE_NOTICES = new Set(["role.invited"]);
/** Most rooms kept to read for role invites. Past this, those least recently changed are dropped first. */
export const ROLE_CHECKS_KEPT = 500;
/** Task statuses the listing reports for a task Runner may have to act on. */
export const LISTED = new Set(["offered", "accepted"]);

export type InboxEvent = { seq: number; type: string; workspace_id: string; task_id: string | null };

/** An inbox page's events, each checked. One with a bad sequence makes the page unusable; any other bad field drops only its IDs. */
export function readEvents(page: unknown): { events: InboxEvent[]; dropped: number } | null {
  if (!page || typeof page !== "object") return null;
  const { events, dropped } = page as Record<string, unknown>;
  if (!Array.isArray(events)) return null;
  const read: InboxEvent[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") return null;
    const { seq, type, workspace_id, task_id } = event as Record<string, unknown>;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
    read.push({
      seq,
      type: typeof type === "string" && TYPE.test(type) ? type : "unknown",
      workspace_id: isId(workspace_id) ? workspace_id : "",
      task_id: isId(task_id) ? task_id : null,
    });
  }
  return { events: read, dropped: typeof dropped === "number" && Number.isSafeInteger(dropped) && dropped >= 0 ? dropped : 0 };
}

const key = (workspace: string, task: string) => `${workspace}/${task}`;

function bounded(offers: Record<string, Offer>): Record<string, Offer> {
  const entries = Object.entries(offers);
  if (entries.length <= OFFERS_KEPT) return offers;
  entries.sort(([, a], [, b]) => b.updated_at - a.updated_at);
  return Object.fromEntries(entries.slice(0, OFFERS_KEPT));
}

/**
 * The record after an inbox page: each event at or below the cursor is skipped, each offer recorded, and the cursor moved
 * to the newest sequence. The caller saves this before it acknowledges anything.
 */
export function applyEvents(state: RunnerState, events: InboxEvent[], now: number): RunnerState {
  const offers = { ...state.offers };
  let checks = state.role_checks ?? {};
  let cursor = state.inbox_cursor;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= cursor) continue;
    cursor = event.seq;
    // A role invite has no task: it's recorded by its room, in the same save as the cursor, so it's never acknowledged
    // unrecorded (issue 522).
    if (!event.task_id && event.workspace_id && ROLE_NOTICES.has(event.type)) checks = markRoleCheck(checks, event.workspace_id, event.seq, now);
    if (!event.task_id || !event.workspace_id) continue;
    const id = key(event.workspace_id, event.task_id);
    const known = offers[id];
    if (known) offers[id] = { ...known, last: event.type, seq: event.seq, updated_at: now };
    else if (STARTS.has(event.type)) offers[id] = { workspace_id: event.workspace_id, task_id: event.task_id, source: "inbox", seq: event.seq, last: event.type, version: null, recorded_at: now, updated_at: now };
  }
  return { ...state, inbox_cursor: cursor, offers: bounded(offers), ...(checks === state.role_checks ? {} : { role_checks: checks }) };
}

/** The rooms to read for role invites, with this one due. Bounded: those least recently changed go first. */
export function markRoleCheck(checks: Record<string, RoleCheck>, workspaceId: string, seq: number | null, now: number): Record<string, RoleCheck> {
  const known = checks[workspaceId];
  const next = { ...checks, [workspaceId]: { workspace_id: workspaceId, seq: seq ?? known?.seq ?? null, due: true, recorded_at: known?.recorded_at ?? now, updated_at: now } };
  const entries = Object.entries(next);
  if (entries.length <= ROLE_CHECKS_KEPT) return next;
  entries.sort(([, a], [, b]) => b.updated_at - a.updated_at);
  return Object.fromEntries(entries.slice(0, ROLE_CHECKS_KEPT));
}

export type ListedTask = { id: string; status: string; version: number | null; assignee: string | null };

/** A listed task, by its IDs, status and version only. Null for anything not shaped as a task. */
export function readTask(row: unknown): ListedTask | null {
  if (!row || typeof row !== "object") return null;
  const { id, status, version, assignee } = row as Record<string, unknown>;
  if (!isId(id) || typeof status !== "string" || !/^[a-z_]{1,32}$/.test(status)) return null;
  return { id, status, version: typeof version === "number" && Number.isSafeInteger(version) ? version : null, assignee: isId(assignee) ? assignee : null };
}

/**
 * The record after listing one workspace's tasks for this agent. A task offered to or accepted by this agent is recorded
 * if it isn't already, and every recorded task listed gets its status. When the listing was whole, a recorded task it
 * didn't show is marked `not_listed`: it's no longer this agent's to act on, as far as this listing shows.
 */
export function applyListing(state: RunnerState, agentId: string, workspaceId: string, tasks: ListedTask[], whole: boolean, now: number): RunnerState {
  const offers = { ...state.offers };
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = key(workspaceId, task.id);
    const known = offers[id];
    const ours = task.assignee === agentId && LISTED.has(task.status);
    if (known) {
      seen.add(id);
      offers[id] = { ...known, last: ours ? task.status : `listed_${task.status}`, version: task.version, updated_at: now };
    } else if (ours) {
      seen.add(id);
      offers[id] = { workspace_id: workspaceId, task_id: task.id, source: "reconcile", seq: null, last: task.status, version: task.version, recorded_at: now, updated_at: now };
    }
  }
  if (whole) {
    for (const [id, offer] of Object.entries(offers)) {
      if (offer.workspace_id === workspaceId && !seen.has(id) && offer.last !== "not_listed") offers[id] = { ...offer, last: "not_listed", updated_at: now };
    }
  }
  return { ...state, offers: bounded(offers) };
}
