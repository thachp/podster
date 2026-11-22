"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import type { InboxEvent, InboxPage } from "./model";

/** The newest ten first, then ten older at a time (issue 547). */
export const ACTIVITY_PAGE = 10;

/** Titles only make a row readable, so they get a small share: one task listing for each of this many of the viewer's own rooms. */
export const MAX_TITLE_ROOMS = 3;

/**
 * Oversight only ever reads. It asks newest first, by the `before` cursor the API gave, and never sends `ack`, which is
 * what moves the cursor. The gateway refuses `ack` here too, and the API refuses it on this route.
 */
export const readInbox = (agent: string, before: number | null, signal?: AbortSignal) =>
  clientQuery<InboxPage>(`/api/v1/agents/${encodeURIComponent(agent)}/inbox?${before === null ? "order=newest" : `before=${before}`}&limit=${ACTIVITY_PAGE}`, { signal });

const LABELS: Record<string, string> = {
  "task.created": "Created",
  "task.offered": "Offered",
  "task.reassigned": "Offered to someone else",
  "task.updated": "Edited",
  "task.reviewer_changed": "Reviewer changed",
  "task.requester_changed": "Requester changed",
  "task.accepted": "Accepted",
  "task.declined": "Declined",
  "task.released": "Released",
  "task.submitted": "Submitted for review",
  "task.changes_requested": "Changes requested",
  "task.completed": "Approved",
  "task.canceled": "Canceled",
  "task.assignee_departed": "Assignee left",
  "task.needs_attention": "Needs a new reviewer or requester",
  "task.message": "New message",
  "member.added": "Added to the workroom",
  "member.revoked": "Removed from the workroom",
  "member.role_changed": "Role changed",
  "member.access_changed": "Access changed",
};

/** System wording for a type. Inbox events carry no agent text, so nothing here comes from an agent. */
export const activityLabel = (type: string) => LABELS[type] ?? (type.startsWith("task.") ? "Task updated" : "Workroom updated");

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function When({ at }: { at: number }) {
  const date = new Date(at);
  const elapsed = at - Date.now();
  const [unit, size] = STEPS.find(([, ms]) => Math.abs(elapsed) >= ms) ?? ["minute", 60_000];
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()} tabIndex={0} className="rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none">
      {relative.format(Math.round(elapsed / size), unit)}
    </time>
  );
}

type Names = { rooms: Record<string, string>; tasks: Record<string, string> };
const taskKey = (workspace: string, task: string) => `${workspace}/${task}`;

/**
 * A readable row. Room and task names come only from what the viewer can already read: the agent's room listing and
 * their own rooms. Anything else stays unnamed here, and its IDs are under Technical details. A room links only if the
 * viewer can open it.
 */
function ActivityRow({ event, unread, openable, names }: { event: InboxEvent; unread: boolean; openable: string[]; names: Names }) {
  const room = names.rooms[event.workspace_id];
  const task = event.task_id ? names.tasks[taskKey(event.workspace_id, event.task_id)] : undefined;
  const roomText = room === undefined ? "A workroom" : plainName(room);
  return (
    <li className="space-y-1 p-3 text-sm">
      <p className="break-words">
        <span className="font-medium">{activityLabel(event.type)}</span>
        {task !== undefined ? ` · ${plainName(task)}` : event.task_id ? " · a task" : null}
      </p>
      <p className="text-xs break-words text-muted-foreground">
        {openable.includes(event.workspace_id) ? (
          <Link href={`/w/${encodeURIComponent(event.workspace_id)}/overview`} prefetch={false} className="text-primary underline">
            {roomText}
          </Link>
        ) : (
          roomText
        )}
        {" · "}
        <When at={event.created_at} />
        {unread ? " · Unread" : null}
      </p>
    </li>
  );
}

function TechnicalDetails({ page, events }: { page: InboxPage; events: InboxEvent[] }) {
  return (
    <details className="rounded-lg border bg-background p-2 text-xs">
      <summary className="cursor-pointer font-medium">Technical details</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Cursor position</dt>
        <dd>{page.acked_seq}</dd>
        <dt className="text-muted-foreground">Unread</dt>
        <dd>{page.unread}</dd>
      </dl>
      {events.length > 0 ? (
        <ul aria-label="Raw events" className="mt-2 space-y-1 font-mono break-all">
          {events.map((event) => (
            <li key={event.seq}>
              {event.seq} · {event.type} · {event.event_id} · workroom {event.workspace_id}
              {event.task_id ? ` · task ${event.task_id}` : ""} · by {event.actor_id}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

type Task = { id: string; title: string };

/**
 * Recent activity, newest first. Looking is read-only: it never acknowledges anything or moves this agent's cursor, so
 * unread stays as the agent left it. Events give no access to the rooms they name.
 */
export function InboxOversight({ agent, name, openable, roomNames }: { agent: { id: string; inbox: InboxPage | null }; name: string; openable: string[]; roomNames: Record<string, string> }) {
  const [older, setOlder] = useState<InboxEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(agent.inbox?.next_before ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [taskTitles, setTaskTitles] = useState<Record<string, string>>({});
  const askedRooms = useRef(new Set<string>());

  const page = agent.inbox;
  // A refetch of the same agent brings a new first page. Older pages read below the last one would leave a gap under it,
  // so they start over from the new page's own cursor. The ref lets an older read still in flight see it's stale.
  const [shownPage, setShownPage] = useState(page);
  const currentPage = useRef(page);
  currentPage.current = page;
  if (shownPage !== page) {
    setShownPage(page);
    setOlder([]);
    setNextBefore(page?.next_before ?? null);
    setLoading(false);
    setFailed(false);
  }
  const first = page?.events ?? [];
  const seen = new Set<number>();
  // A page can overlap the one before if new events arrived between reads, so each event shows once.
  const events = [...first, ...older].filter((event) => !seen.has(event.seq) && (seen.add(event.seq), true));
  const roomsToName = [...new Set(events.filter((event) => event.task_id && openable.includes(event.workspace_id)).map((event) => event.workspace_id))].join(" ");

  useEffect(() => {
    const wanted = roomsToName.split(" ").filter((room) => room !== "").filter((room) => !askedRooms.current.has(room)).slice(0, Math.max(0, MAX_TITLE_ROOMS - askedRooms.current.size));
    if (wanted.length === 0) return;
    for (const room of wanted) askedRooms.current.add(room);
    const controller = new AbortController();
    for (const room of wanted) {
      void clientQuery<{ tasks: Task[] }>(`/api/v1/workspaces/${encodeURIComponent(room)}/tasks?cursor=&order=newest`, { signal: controller.signal })
        .then((result) => {
          if (!result.ok) return;
          setTaskTitles((known) => ({ ...known, ...Object.fromEntries(result.data.tasks.map((task) => [taskKey(room, task.id), task.title])) }));
        })
        // A title only makes a row readable. Without it, the row still says what happened.
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [roomsToName]);

  async function loadOlder() {
    if (nextBefore === null) return;
    const from = page;
    setLoading(true);
    setFailed(false);
    const result = await readInbox(agent.id, nextBefore).catch(() => null);
    if (currentPage.current !== from) return;
    setLoading(false);
    if (!result?.ok) return setFailed(true);
    setOlder((previous) => [...previous, ...result.data.events]);
    setNextBefore(result.data.next_before ?? null);
  }

  return (
    <section aria-labelledby="agent-activity" className="space-y-2 rounded-lg border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="agent-activity" className="font-medium">
          Recent activity
        </h3>
        {page !== null && page.unread > 0 ? <span className="rounded-full bg-primary px-2 text-xs font-medium text-primary-foreground">{page.unread} unread</span> : null}
      </div>
      <p className="text-sm break-words text-muted-foreground">Read-only oversight of {name}. Viewing doesn't acknowledge anything or change what's unread, and gives you no access to those workrooms.</p>
      {page === null ? (
        <p role="alert" className="text-sm">
          Couldn't read this agent's recent activity.
        </p>
      ) : (
        <>
          {page.dropped > 0 ? (
            <p role="alert" className="rounded-lg bg-status-amber-surface p-2 text-sm text-status-amber">
              {page.dropped === 1 ? "1 unread event was" : `${page.dropped} unread events were`} dropped before this agent read {page.dropped === 1 ? "it" : "them"}.
            </p>
          ) : null}
          {events.length > 0 ? (
            <ul aria-label="Recent activity, newest first" className="divide-y rounded-lg border bg-background">
              {events.map((event) => (
                <ActivityRow key={event.seq} event={event} unread={event.seq > page.acked_seq} openable={openable} names={{ rooms: roomNames, tasks: taskTitles }} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No recent activity.</p>
          )}
          {failed ? (
            <p role="alert" className="text-sm">
              Couldn't load older activity.
            </p>
          ) : null}
          {nextBefore !== null ? (
            <Button variant="outline" size="sm" disabled={loading} aria-busy={loading} onClick={() => void loadOlder()}>
              {loading ? "Loading older activity…" : "Load older activity"}
            </Button>
          ) : events.length > 0 ? (
            <p className="text-xs text-muted-foreground">No older activity.</p>
          ) : null}
          <TechnicalDetails page={page} events={events} />
        </>
      )}
    </section>
  );
}
