"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { plainName } from "@/components/agent-content/text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { FIELD_CLASS } from "./task-bits";
import { RespondToOffer } from "./task-acceptance";
import { SubmitWork } from "./task-files";
import { approvalBlocker, definiteRefusal, verifyProblem } from "./task-files-model";
import { asConflict, changedSince, changeProblem, draftOf, flagged, isArchivedRoom, LIMITS, newRequesterChoices, newReviewerChoices, ownWords, rebaseDraft, reoffers, taskPatch, textNameOf, tooLong, viewerActions, type Names, type Task, type TaskDraft } from "./task-model";
import type { LoadedTask } from "./task-sheet";

type Props = { api: SheetApi<LoadedTask>; me: string; names: Names; role: string | undefined; onNotice: (notice: string | null) => void };

/** An edit in progress, and the task it was started from. */
export type SavedEdit = { readAt: Task; draft: TaskDraft };

const PRIMARY = "min-h-11 sm:min-h-9";

/** Only what this viewer may do now. It's rebuilt for each task version, so nothing here can outlive what it was read against. */
export function TaskActions({ api, me, names, role, onNotice, savedEdit, returnFocus, savedNote }: Props & { savedEdit: RefObject<SavedEdit | null>; returnFocus: RefObject<boolean>; savedNote?: RefObject<string> }) {
  const { task, room } = api.data;
  const archived = isArchivedRoom(room);
  const can = viewerActions(task, me, role, archived);
  const [editing, setEditing] = useState(() => savedEdit.current !== null && can.edit);
  const editButton = useRef<HTMLButtonElement>(null);
  // The form has gone, and focus shouldn't go with it. The button only exists again after this render, and these controls may be starting afresh if the version moved. If this task can't be edited any more, the open tab is the nearest place.
  useEffect(() => {
    if (!editing && returnFocus.current) (editButton.current ?? document.querySelector<HTMLElement>('[role="dialog"] [role="tab"][data-state="active"]'))?.focus();
    returnFocus.current = false;
  }, [editing, returnFocus]);

  if (archived) {
    return (
      <>
        {savedEdit.current ? <UnsavableEdit savedEdit={savedEdit} /> : null}
        <p className="border-t pt-4 text-sm text-muted-foreground">This workroom is archived, so nothing new can happen on this task. Its owner or an admin can bring the workroom back.</p>
      </>
    );
  }
  if (editing) {
    return (
      <section aria-label="Actions" className="space-y-3 border-t pt-4">
        <EditTask
          api={api}
          me={me}
          names={names}
          savedEdit={savedEdit}
          onDone={() => {
            returnFocus.current = true;
            setEditing(false);
          }}
          onNotice={onNotice}
        />
      </section>
    );
  }
  if (!can.review && !can.submit && !can.respond && !can.cancel && !can.assign && !can.edit && !can.setReviewer && !can.setRequester) {
    return (
      <>
        {savedEdit.current ? <UnsavableEdit savedEdit={savedEdit} /> : null}
        <Waiting api={api} me={me} names={names} />
      </>
    );
  }
  return (
    <section aria-label="Actions" className="space-y-3 border-t pt-4">
      {savedEdit.current && !can.edit ? <UnsavableEdit savedEdit={savedEdit} /> : null}
      {can.respond ? <RespondToOffer api={api} onNotice={onNotice} taskPath={taskPath} /> : can.submit ? <SubmitWork api={api} onNotice={onNotice} taskPath={taskPath} savedNote={savedNote} /> : can.review ? <ReviewActions api={api} onNotice={onNotice} /> : <Waiting api={api} me={me} names={names} />}
      {can.assign ? <OfferTask api={api} me={me} names={names} role={role} onNotice={onNotice} /> : null}
      {can.edit ? (
        <Button
          ref={editButton}
          variant="outline"
          className={PRIMARY}
          disabled={api.saving}
          onClick={() => {
            onNotice(null);
            setEditing(true);
          }}
        >
          Edit task
        </Button>
      ) : null}
      {/* Saving either one starts these controls afresh, and a draft shouldn't vanish because of it. */}
      {(can.setReviewer || can.setRequester) && !api.dirty ? <ChangePeople api={api} me={me} names={names} role={role} onNotice={onNotice} /> : null}
      {task.status === "submitted" && (task.requester === me || role === "owner" || role === "admin") ? <p className="text-sm text-muted-foreground">Submitted work can't be edited. Request changes first.</p> : null}
      {can.cancel ? <CancelTask api={api} onNotice={onNotice} /> : null}
    </section>
  );
}

/** The task moved to a state that can't be edited, so all that's left is to give the person their words back. */
function UnsavableEdit({ savedEdit }: { savedEdit: RefObject<SavedEdit | null> }) {
  const [, setDismissed] = useState(false);
  const words = savedEdit.current ? ownWords(savedEdit.current) : [];
  if (words.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="text-status-amber">This task can't be edited now, so your edit wasn't saved. Here's what you wrote, to copy.</p>
      {words.map(({ label, text }) => (
        <div key={label} className="space-y-1">
          <p className="font-medium">{label}</p>
          <p className="break-words whitespace-pre-wrap">{text}</p>
        </div>
      ))}
      <Button
        variant="outline"
        className={PRIMARY}
        onClick={() => {
          savedEdit.current = null;
          setDismissed(true);
        }}
      >
        Dismiss
      </Button>
    </div>
  );
}

/**
 * Edits go out as only what changed, against the version the person read. The warning about re-acceptance shows from the
 * start, so it's not a surprise, and the button repeats it once this edit would actually do that.
 */
function EditTask({ api, me, names, savedEdit, onDone, onNotice }: Pick<Props, "api" | "me" | "names" | "onNotice"> & { savedEdit: RefObject<SavedEdit | null>; onDone: () => void }) {
  const { data, run, saving, setDirty } = api;
  const { task } = data;
  const earlier = useRef(savedEdit.current);
  const [discarding, setDiscarding] = useState(false);
  const [draft, setDraftState] = useState<TaskDraft>(() => (earlier.current ? rebaseDraft(earlier.current.draft, earlier.current.readAt, task) : draftOf(task)));
  const titleRef = useRef<HTMLInputElement>(null);
  const patch = taskPatch(task, draft);
  const changed = Object.keys(patch).length > 0;
  const body = JSON.stringify(patch);
  const key = useIntentKey(`update:${task.version}:${body}`);
  const backToOffered = reoffers(task, patch);
  const assignee = task.assignee ? textNameOf(task.assignee, me, names) : "the assignee";
  const invalid = draft.title.trim() === "" || draft.instructions.trim() === "" || tooLong(draft.title, LIMITS.title) || tooLong(draft.instructions, LIMITS.instructions) || tooLong(draft.criteria, LIMITS.criteria);
  const movedOn = earlier.current ? changedSince(earlier.current.readAt, task) : [];

  useEffect(() => titleRef.current?.focus(), []);
  useEffect(() => {
    setDirty(changed);
    // Only when that answer changes. `setDirty` is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);

  // Read-only while a command or its re-read is out: a draft typed then would answer to a version this form hasn't shown,
  // and could replace someone's edit unseen. Not disabled, which would drop focus.
  const setField = (name: keyof TaskDraft, value: string) => {
    if (saving) return;
    const next = { ...draft, [name]: value };
    setDraftState(next);
    savedEdit.current = { readAt: task, draft: next };
  };

  const finish = () => {
    savedEdit.current = null;
    setDirty(false);
    onDone();
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!changed || invalid) return;
    onNotice(null);
    const result = await run(async (binding) => asConflict(await clientCommand<Task>(taskPath(data, "update"), { version: binding.version, ...patch }, { idempotencyKey: key })), (code, status) => changeProblem("edit", code, status));
    if (!result?.ok) return;
    // Says what the server did, not what this form expected.
    onNotice(task.status === "accepted" && result.data.status === "offered" ? `Saved. ${assignee} has to accept this task again before working on it.` : "Saved your edit.");
    finish();
  };

  return (
    <form onSubmit={save} aria-label="Edit task" className="space-y-3">
      <h3 className="font-medium">Edit task</h3>
      {movedOn.length > 0 ? (
        <p className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          Your text is still here, on top of the latest version. Since you started, this changed: {movedOn.join(", ")}. Check it above before saving.
        </p>
      ) : null}
      {task.status === "accepted" ? (
        <p className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          {backToOffered ? `This edit sends the task back to Awaiting acceptance. ${assignee} has to accept it again before working on it.` : `Changing the instructions or criteria sends this task back to Awaiting acceptance, and ${assignee} has to accept it again. The title and due date don't.`}
        </p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="edit-title">Title</Label>
        <Input ref={titleRef} id="edit-title" required readOnly={saving} value={draft.title} onChange={(event) => setField("title", event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="edit-instructions">Instructions</Label>
        <textarea id="edit-instructions" required rows={6} readOnly={saving} className={FIELD_CLASS} value={draft.instructions} onChange={(event) => setField("instructions", event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="edit-criteria">Acceptance criteria (optional)</Label>
        <textarea id="edit-criteria" rows={3} readOnly={saving} className={FIELD_CLASS} value={draft.criteria} onChange={(event) => setField("criteria", event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="edit-due">Due (informational)</Label>
        <Input id="edit-due" type="datetime-local" readOnly={saving} value={draft.due} onChange={(event) => setField("due", event.target.value)} aria-describedby={task.due_at !== null ? "edit-due-hint" : undefined} />
        {task.due_at !== null ? (
          <p id="edit-due-hint" className="text-xs text-muted-foreground">
            A due date can be changed but not removed yet. Leaving this empty keeps it.
          </p>
        ) : null}
      </div>
      {tooLong(draft.title, LIMITS.title) || tooLong(draft.instructions, LIMITS.instructions) || tooLong(draft.criteria, LIMITS.criteria) ? <p className="text-sm text-status-danger">That's too long. Titles can be 500 bytes, instructions 64 KB and criteria 16 KB.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className={PRIMARY} disabled={saving || !changed || invalid}>
          {saving ? "Saving…" : backToOffered ? "Save and ask for acceptance again" : "Save edit"}
        </Button>
        <Button type="button" variant="outline" className={PRIMARY} disabled={saving} onClick={() => (changed ? setDiscarding(true) : finish())}>
          Cancel
        </Button>
      </div>
      <ConfirmDiscard open={discarding} what={`your edit to “${plainName(task.title)}”`} onKeep={() => setDiscarding(false)} onDiscard={finish} />
    </form>
  );
}

/** Names what's being thrown away, and goes nowhere until the person says so (DESIGN.md, "Sheets"). */
function ConfirmDiscard({ open, what, onKeep, onDiscard }: { open: boolean; what: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <AlertDialogContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Discard {what}?</AlertDialogTitle>
          <AlertDialogDescription>What you wrote won't be saved, and this can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={onDiscard}>Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Tucked away until the task needs it, because most tasks never do. */
function ChangePeople({ api, me, names, role, onNotice }: Props) {
  const { task, room } = api.data;
  const can = viewerActions(task, me, role);
  const need = flagged(task, room, role);
  return (
    <details open={task.needs_attention} className="rounded-lg border p-3">
      <summary className="min-h-6 cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{can.setRequester && can.setReviewer ? "Change reviewer or requester" : can.setRequester ? "Change requester" : "Change reviewer"}</summary>
      <div className="mt-3 space-y-3">
        {can.setReviewer ? <ChangePerson api={api} me={me} names={names} onNotice={onNotice} which="reviewer" choices={newReviewerChoices(room, task, role)} current={task.reviewer} departed={need.reviewer} /> : null}
        {can.setRequester ? <ChangePerson api={api} me={me} names={names} onNotice={onNotice} which="requester" choices={newRequesterChoices(room, task, role)} current={task.requester} departed={need.requester} /> : null}
      </div>
    </details>
  );
}

function ChangePerson({ api, me, names, onNotice, which, choices, current, departed }: Pick<Props, "api" | "me" | "names" | "onNotice"> & { which: "reviewer" | "requester"; choices: string[]; current: string; departed: boolean }) {
  const { data, run, saving } = api;
  const [person, setPerson] = useState("");
  const key = useIntentKey(`${which}:${data.task.version}:${person}`);
  const id = `change-${which}`;

  if (choices.length === 0) return <p className="text-sm text-muted-foreground">Nobody else in this workroom can be the {which}.{which === "reviewer" && data.room.require_person_review ? " It requires a person to review, so add one on Team." : ""}</p>;

  const change = async () => {
    if (!person) return;
    onNotice(null);
    const named = textNameOf(person, me, names);
    const result = await run(async (binding) => asConflict(await clientCommand(taskPath(data, `set-${which}`), { version: binding.version, [which]: person }, { idempotencyKey: key })), (code, status) => changeProblem(which, code, status));
    if (result?.ok) onNotice(person === me ? `You're now the ${which}.` : `${named} is now the ${which}.`);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <Label htmlFor={id}>{departed ? `New ${which}` : `Change ${which}`}</Label>
        <select id={id} className={FIELD_CLASS} value={person} onChange={(event) => setPerson(event.target.value)}>
          <option value="">Choose someone</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {textNameOf(choice, me, names)}
              {choice === current ? " (current)" : ""}
            </option>
          ))}
        </select>
      </div>
      <Button variant="outline" className={PRIMARY} disabled={saving || !person} onClick={change}>
        {saving ? "Saving…" : `Set ${which}`}
      </Button>
    </div>
  );
}

/** Who this is waiting on, for someone who can't act on it. An agent being offline is normal, so nothing here reads as a problem. */
function Waiting({ api, me, names }: Pick<Props, "api" | "me" | "names">) {
  const { task } = api.data;
  const reviewer = textNameOf(task.reviewer, me, names);
  const assignee = task.assignee ? textNameOf(task.assignee, me, names) : null;
  const text =
    task.status === "submitted" ? `Waiting for ${reviewer} to review submission ${task.submission_no}.` : task.status === "offered" && assignee ? `Waiting for ${assignee} to accept. It will see this at its next session or wake.` : task.status === "accepted" && assignee ? `${assignee} is working on this.` : null;
  return text ? <p className="min-w-0 border-t pt-4 text-sm break-words text-muted-foreground">{text}</p> : null;
}

/** A command's path, from the task this Sheet instance loaded, never from what's selected by the time it runs. */
export const taskPath = (data: LoadedTask, action: string) => `/api/v1/workspaces/${encodeURIComponent(data.workspace)}/tasks/${encodeURIComponent(data.task.id)}/${action}`;

/** One key per intent, so retrying after a lost response can't act twice. Changing what's being asked starts a new intent. */
function useIntentKey(intent: string) {
  const key = useRef({ intent, value: crypto.randomUUID() });
  if (key.current.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
  return key.current.value;
}

function ReviewActions({ api, onNotice }: Pick<Props, "api" | "onNotice">) {
  const { data, run, saving, setDirty } = api;
  const submission = data.task.submission_no;
  const [asking, setAsking] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const approveKey = useIntentKey(`verify:${submission}`);
  const changesKey = useIntentKey(`changes:${submission}:${reason}`);
  const trimmed = reason.trim();
  // The reviewer named on a task reads all its submitted files (decision 97), so this is the whole of them.
  const files = (data.files ?? []).filter((file) => file.submission_no === submission);
  const blocker = approvalBlocker(files);

  useEffect(() => {
    if (asking) fieldRef.current?.focus();
  }, [asking]);

  const back = () => {
    setAsking(false);
    setDiscarding(false);
    setReason("");
    setDirty(false);
  };

  const approve = async () => {
    onNotice(null);
    const result = await run(async () => definiteRefusal(asConflict(await clientCommand(taskPath(data, "verify"), { submission_no: submission }, { idempotencyKey: approveKey }))), verifyProblem);
    if (result?.ok) onNotice(`Approved submission ${submission}. This task is completed.`);
  };

  const requestChanges = async () => {
    if (!trimmed) return;
    onNotice(null);
    const result = await run(async () => asConflict(await clientCommand(taskPath(data, "request-changes"), { submission_no: submission, reason: trimmed }, { idempotencyKey: changesKey })));
    if (result?.ok) onNotice(`Requested changes to submission ${submission}.`);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        You're the reviewer. Your decision applies to submission {submission} only
        {files.length > 0 ? `, and approving it records the exact ${files.length === 1 ? "file" : `${files.length} files`} it was submitted with, by SHA-256. Check ${files.length === 1 ? "it" : "them"} in Details.` : "."}
      </p>
      {blocker ? (
        <p id="approve-blocked" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          {blocker}
        </p>
      ) : null}
      {asking ? (
        <div className="space-y-2">
          <Label htmlFor="changes-reason">What needs to change in submission {submission}?</Label>
          <textarea
            ref={fieldRef}
            id="changes-reason"
            rows={4}
            className={FIELD_CLASS}
            readOnly={saving}
            value={reason}
            onChange={(event) => {
              if (saving) return;
              setReason(event.target.value);
              setDirty(event.target.value.length > 0);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button className={PRIMARY} disabled={saving || !trimmed} onClick={requestChanges}>
              {saving ? "Sending…" : `Request changes to submission ${submission}`}
            </Button>
            <Button
              variant="outline"
              className={PRIMARY}
              disabled={saving}
              onClick={() => (reason ? setDiscarding(true) : back())}
            >
              Back
            </Button>
          </div>
          <ConfirmDiscard open={discarding} what={`your request for changes to submission ${submission}`} onKeep={() => setDiscarding(false)} onDiscard={back} />
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/* Not disabled for a file that isn't ready: a refresh can find one while focus is here, and focus mustn't drop. */}
          <Button
            className={`${PRIMARY} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
            disabled={saving}
            aria-disabled={blocker !== null || undefined}
            aria-describedby={blocker ? "approve-blocked" : undefined}
            onClick={() => {
              if (blocker === null) void approve();
            }}
          >
            {saving ? "Approving…" : `Approve submission ${submission}`}
          </Button>
          <Button variant="outline" className={PRIMARY} disabled={saving} onClick={() => setAsking(true)}>
            Request changes
          </Button>
        </div>
      )}
    </div>
  );
}

function OfferTask({ api, me, names, role, onNotice }: Props) {
  const { data, run, saving } = api;
  const { task } = data;
  const agents = (data.room.members ?? []).filter((member) => member.kind === "agent" && member.principal_id !== task.reviewer && member.principal_id !== task.assignee);
  const [assignee, setAssignee] = useState("");
  const key = useIntentKey(`assign:${task.version}:${assignee}`);

  if (agents.length === 0) {
    const manager = role === "owner" || role === "admin";
    return <p className="text-sm text-muted-foreground">{task.assignee ? "No other agent in this workroom can take this." : `No agent in this workroom can take this yet.${manager ? " Add one on the Team tab." : ""}`}</p>;
  }

  const offer = async () => {
    if (!assignee) return;
    onNotice(null);
    const offeredTo = textNameOf(assignee, me, names);
    const result = await run(async (binding) => asConflict(await clientCommand(taskPath(data, "assign"), { version: binding.version, assignee }, { idempotencyKey: key })));
    if (result?.ok) onNotice(`Offered to ${offeredTo}. It will see this at its next session or wake.`);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <Label htmlFor="offer-to">{task.assignee ? "Offer to someone else" : "Offer to"}</Label>
        <select id="offer-to" className={FIELD_CLASS} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="">Choose an agent</option>
          {agents.map((agent) => (
            <option key={agent.principal_id} value={agent.principal_id}>
              {textNameOf(agent.principal_id, me, names)}
            </option>
          ))}
        </select>
      </div>
      <Button variant="outline" className={PRIMARY} disabled={saving || !assignee} onClick={offer}>
        {saving ? "Offering…" : "Offer task"}
      </Button>
    </div>
  );
}

function CancelTask({ api, onNotice }: Pick<Props, "api" | "onNotice">) {
  const { data, run, saving } = api;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const key = useIntentKey(`cancel:${data.task.version}:${reason}`);
  const trimmed = reason.trim();

  const cancel = async () => {
    onNotice(null);
    const result = await run(async (binding) => asConflict(await clientCommand(taskPath(data, "cancel"), { version: binding.version, reason: trimmed }, { idempotencyKey: key })));
    if (result?.ok) onNotice("Canceled this task.");
  };

  return (
    <>
      <Button variant="ghost" className={`${PRIMARY} text-status-danger`} disabled={saving} onClick={() => setOpen(true)}>
        Cancel task
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Cancel “{plainName(data.task.title)}” in “{plainName(data.room.name)}”?</AlertDialogTitle>
            <AlertDialogDescription>The task stops here for good, and the reason goes on its history. Its submissions stay. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Reason</Label>
            <textarea id="cancel-reason" rows={3} className={FIELD_CLASS} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep task</AlertDialogCancel>
            <AlertDialogAction disabled={!trimmed} onClick={cancel}>
              Cancel task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
