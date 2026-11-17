"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { Timestamp } from "../w/[id]/tasks/task-bits";
import { crossRoomTarget, parseCrossRoomTarget, type Names } from "../w/[id]/tasks/task-model";
import { TaskSheet } from "../w/[id]/tasks/task-sheet";
import { acknowledgeUpTo, describeEvent, type InboxEvent } from "./attention-model";
import type { Attention } from "./load-attention";
import { ReleaseApprovals } from "./release-approvals";

export function AttentionScreen({ attention, me, names, orgNames }: { attention: Attention; me: string; names: Names; orgNames?: Names }) {
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Needs attention</h1>
        <p className="text-muted-foreground">Decisions waiting on you across workrooms, and what's happened since you last looked.</p>
      </div>
      <Reviews attention={attention} />
      <ReleaseApprovals approvals={attention.approvals} me={me} names={names} taskTitles={attention.taskTitles} />
      <Updates attention={attention} me={me} names={names} />
      {/* These are real items in the design, and this says so rather than letting an empty screen mean there are none. */}
      <p className="text-xs text-muted-foreground">Role invitations and wake or connection problems on your agents don't show here yet. Check the Agents page for those.</p>
      <TaskSheet me={me} names={names} orgNames={orgNames} resolve={parseCrossRoomTarget} />
    </section>
  );
}

function Reviews({ attention }: { attention: Attention }) {
  const { reviews, failedRooms, fullRooms, uncheckedRooms } = attention;
  const partial = failedRooms > 0 || fullRooms > 0 || uncheckedRooms > 0;
  return (
    <section aria-labelledby="reviews-heading" className="space-y-2">
      <h2 id="reviews-heading" className="text-lg font-medium">
        Reviews assigned to you {reviews ? <span className="font-normal text-muted-foreground">({reviews.length})</span> : null}
      </h2>
      {reviews === null ? <ReadFailure /> : null}
      {failedRooms > 0 ? (
        <div className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          <p>Couldn't check {failedRooms === 1 ? "1 workroom" : `${failedRooms} workrooms`}, so there may be more reviews than this.</p>
          <ReadFailure />
        </div>
      ) : null}
      {fullRooms > 0 ? <p className="text-sm text-muted-foreground">{fullRooms === 1 ? "1 workroom has" : `${fullRooms} workrooms have`} more submissions than this reads, so there may be more reviews. Use Needs my review on its Tasks tab.</p> : null}
      {uncheckedRooms > 0 ? <p className="text-sm text-muted-foreground">Checked your first workrooms only. {uncheckedRooms === 1 ? "1 more wasn't" : `${uncheckedRooms} more weren't`} checked, so open those from Workrooms.</p> : null}
      {reviews?.length === 0 && !partial ? <p className="text-muted-foreground">No submissions are waiting for your review. When an agent submits work you're the reviewer of, it shows up here.</p> : null}
      {reviews && reviews.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {reviews.map(({ workspace, workspaceName, task }) => (
            <li key={`${workspace}:${task.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-medium break-words">{plainName(task.title)}</p>
                <p className="text-sm break-words text-muted-foreground">
                  Submission {task.submission_no} · {plainName(workspaceName)}
                </p>
              </div>
              <SheetLink param="task" target={crossRoomTarget(workspace, task.id)} aria-label={`Review submission ${task.submission_no} of “${plainName(task.title)}”`} className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-9">
                Review
              </SheetLink>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Updates({ attention, me, names }: { attention: Attention; me: string; names: Names }) {
  const { inbox, roomNames, taskTitles } = attention;
  if (!inbox) {
    return (
      <section aria-labelledby="updates-heading" className="space-y-2">
        <h2 id="updates-heading" className="text-lg font-medium">
          Updates
        </h2>
        <ReadFailure />
      </section>
    );
  }
  // Unread events only, oldest first from the API. A person reads the latest first.
  const unread = inbox.events.filter((event) => event.seq > inbox.acked_seq).toReversed();
  return (
    <section aria-labelledby="updates-heading" className="space-y-2">
      <h2 id="updates-heading" className="text-lg font-medium">
        Updates <span className="font-normal text-muted-foreground">({inbox.unread} unread)</span>
      </h2>
      {unread.length === 0 ? <p className="text-muted-foreground">You're up to date. Changes to tasks you're part of show up here.</p> : null}
      {unread.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {unread.map((event) => (
            <UpdateRow key={event.event_id} event={event} me={me} names={names} roomName={roomNames[event.workspace_id]} taskTitle={event.task_id ? taskTitles[event.task_id] : undefined} />
          ))}
        </ul>
      ) : null}
      {inbox.unread > unread.length && unread.length > 0 ? <p className="text-sm text-muted-foreground">Showing the oldest {unread.length} unread. Acknowledge these to see the rest.</p> : null}
      {inbox.dropped > 0 ? <p className="text-sm text-muted-foreground">{inbox.dropped === 1 ? "1 older update" : `${inbox.dropped} older updates`} expired before being read. Each workroom's Tasks tab has the current state.</p> : null}
      {unread.length > 0 ? <Acknowledge events={unread} /> : null}
    </section>
  );
}

function UpdateRow({ event, me, names, roomName, taskTitle }: { event: InboxEvent; me: string; names: Names; roomName?: string; taskTitle?: string }) {
  const sentence = describeEvent(event, me, names);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 text-sm">
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words">{sentence}</p>
        <p className="break-words text-muted-foreground">
          {taskTitle ? <>{plainName(taskTitle)} · </> : null}
          {roomName ? plainName(roomName) : "A workroom"} · <Timestamp at={event.created_at} />
        </p>
      </div>
      {event.task_id ? (
        <SheetLink param="task" target={crossRoomTarget(event.workspace_id, event.task_id)} aria-label={`Open task: ${taskTitle ? plainName(taskTitle) : sentence}`} className="inline-flex min-h-11 items-center rounded-md px-2 text-primary underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-6">
          Open
        </SheetLink>
      ) : null}
    </li>
  );
}

/** A lost response may have come after the cursor moved. Moving it again to the same place does nothing, so retrying is safe. */
const UNKNOWN_ACK = "We can't tell whether this was acknowledged. It's safe to try again.";
const NOT_ACKED = "That didn't save, and nothing changed. Try again.";

/** Moves only this person's own cursor. Reviews stay until they're decided, whatever's acknowledged. */
function Acknowledge({ events }: { events: InboxEvent[] }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const upTo = acknowledgeUpTo(events);

  const acknowledge = async () => {
    setSaving(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await clientCommand<{ acked_seq: number; unread: number }>("/api/v1/inbox/ack", { up_to: upTo });
      if (result.ok) {
        setNotice(`Acknowledged. ${result.data.unread} unread.`);
        router.refresh();
      } else setProblem(result.status >= 500 ? UNKNOWN_ACK : NOT_ACKED);
    } catch {
      setProblem(UNKNOWN_ACK);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={saving} onClick={acknowledge}>
        {saving ? "Acknowledging…" : events.length === 1 ? "Acknowledge this update" : `Acknowledge these ${events.length} updates`}
      </Button>
      <p className="text-xs text-muted-foreground">This clears them from your queue only, and changes nothing for anyone else. Reviews stay listed until you decide them.</p>
      {problem ? (
        <p role="alert" className="text-sm text-status-danger">
          {problem}
        </p>
      ) : null}
      <p role="status" className="text-sm empty:hidden">
        {notice}
      </p>
    </div>
  );
}
