"use client";

import { useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { FIELD_CLASS } from "./task-bits";
import { asConflict, type Task } from "./task-model";
import type { LoadedTask } from "./task-sheet";

const PRIMARY = "min-h-11 sm:min-h-9";

const REFUSED: Record<string, string> = {
  not_allowed: "Only the person this task is offered to can accept or decline it.",
  invalid_argument: "Declining needs a reason.",
};

/** What to say when accepting or declining doesn't go through. A lost answer reaches this as "unknown". */
export function respondProblem(change: "accept" | "decline", code: string, status: number) {
  if (code === "unknown" || status >= 500) return `We can't tell whether this task was ${change === "accept" ? "accepted" : "declined"}, so we read it again. Check its status above before trying again.`;
  if (status === 401) return "That didn't save, and nothing changed. Your session has ended. Sign in again.";
  if (status === 429) return "That didn't save, and nothing changed. Too many requests, so wait a minute and try again.";
  if (code === "workspace_archived") return "That didn't save, and nothing changed. This workroom is archived, so nothing new can happen in it.";
  return `That didn't save, and nothing changed. ${REFUSED[code] ?? "You may no longer be allowed to do this."}`;
}

/**
 * The offered assignee's answer. Accepting commits them to the task as it reads now, so it's bound to this version: an edit
 * since they read it is a conflict, not a silent acceptance of new instructions. Declining hands it back with a reason.
 */
export function RespondToOffer({ api, onNotice, taskPath }: { api: SheetApi<LoadedTask>; onNotice: (notice: string | null) => void; taskPath: (data: LoadedTask, action: string) => string }) {
  const { data, run, saving, setDirty } = api;
  const { task } = data;
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const backFocus = useRef(false);
  const trimmed = reason.trim();
  const acceptKey = useIntentKey(`accept:${task.version}`);
  const declineKey = useIntentKey(`decline:${task.version}:${trimmed}`);

  useEffect(() => {
    if (declining) fieldRef.current?.focus();
    else if (backFocus.current) declineButton.current?.focus();
    backFocus.current = false;
  }, [declining]);

  const back = () => {
    backFocus.current = true;
    setDeclining(false);
    setReason("");
    setDirty(false);
  };

  const accept = async () => {
    onNotice(null);
    const result = await run(async (binding) => asConflict(await clientCommand<Task>(taskPath(data, "accept"), { version: binding.version }, { idempotencyKey: acceptKey })), (code, status) => respondProblem("accept", code, status));
    if (result?.ok) onNotice("Accepted. You can submit your work when it's ready.");
  };

  const decline = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    onNotice(null);
    const result = await run(async (binding) => asConflict(await clientCommand<Task>(taskPath(data, "decline"), { version: binding.version, reason: trimmed }, { idempotencyKey: declineKey })), (code, status) => respondProblem("decline", code, status));
    if (result?.ok) onNotice("Declined. The task is open again, and its requester can offer it to someone else.");
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">This task is offered to you. Accepting commits you to it as it reads now: “{plainName(task.title)}”.</p>
      {declining ? (
        <form onSubmit={decline} aria-label="Decline task" className="space-y-2">
          <Label htmlFor="decline-reason">Why are you declining?</Label>
          <textarea
            ref={fieldRef}
            id="decline-reason"
            rows={3}
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
            <Button type="submit" className={PRIMARY} disabled={saving || !trimmed}>
              {saving ? "Declining…" : "Decline task"}
            </Button>
            <Button type="button" variant="outline" className={PRIMARY} disabled={saving} onClick={back}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button className={PRIMARY} disabled={saving} onClick={accept}>
            {saving ? "Accepting…" : "Accept task"}
          </Button>
          <Button ref={declineButton} variant="outline" className={PRIMARY} disabled={saving} onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

/** One key per intent, so retrying after a lost response can't act twice. Changing what's being asked starts a new intent. */
function useIntentKey(intent: string) {
  const key = useRef({ intent, value: crypto.randomUUID() });
  if (key.current.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
  return key.current.value;
}
