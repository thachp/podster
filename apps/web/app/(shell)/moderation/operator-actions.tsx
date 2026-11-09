"use client";

import { useId, useRef, useState } from "react";
import { CommandNotice, useCommands } from "../w/[id]/team/commands";
import { ConfirmAction } from "../w/[id]/team/confirm-action";
import { FIELD } from "../w/[id]/team/field";
import { explainOperatorRefusal, reasonLabel, REASONS, type QueuedReport } from "./model";

type Answer = { suspended: boolean; reason: string };

/**
 * An operator's actions on one report. The room is found from the report on the server, so they work whatever its handle
 * is now. Each carries the chosen reason code. A lost answer keeps its key, so Try again can't act twice.
 */
export function OperatorActions({ report }: { report: QueuedReport }) {
  const commands = useCommands(null);
  const { send, retrying } = commands;
  const id = useId();
  const [reason, setReason] = useState(REASONS.some((r) => r.value === report.reason) ? report.reason : "other");
  const after = useRef<HTMLDivElement>(null);
  const base = "/api/v1/moderation";
  const said = (what: string) => (answer: Answer) => `${what} ${answer.suspended ? "suspended" : "no longer suspended"}, for ${reasonLabel(answer.reason).toLowerCase()}.`;
  const act = (path: string, success: (answer: Answer) => string) => send<Answer>(path, { reason }, success, { explain: explainOperatorRefusal });

  return (
    <div className="space-y-2">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm">
          Reason recorded
        </label>
        <select id={id} className={`${FIELD} w-auto`} value={reason} disabled={retrying} onChange={(event) => setReason(event.target.value)}>
          {REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <ConfirmAction
          label="Suspend workroom"
          destructive
          disabled={retrying}
          title="Suspend this workroom's public surface?"
          description={`Its public page answers not found, it leaves Explore and public claims are refused. Its owner sees "Suspended by Podster" and the reason (${reasonLabel(reason)}), and can't publish it again until it's lifted. Nothing inside the workroom changes.`}
          confirm="Suspend"
          action={() => act(`${base}/reports/${encodeURIComponent(report.id)}/suspend-room`, said("Workroom"))}
          focusAfter={after}
        />
        <ConfirmAction
          label="Lift workroom suspension"
          disabled={retrying}
          title="Lift this workroom's suspension?"
          description="If it's still public, its page answers again and it's back in Explore."
          confirm="Lift"
          action={() => act(`${base}/reports/${encodeURIComponent(report.id)}/lift-room`, said("Workroom"))}
          focusAfter={after}
        />
        {report.agent_id ? (
          <>
            <ConfirmAction
              label="Suspend agent's public claims"
              destructive
              disabled={retrying}
              title={`Suspend ${report.agent_id}'s public claims?`}
              description="Every public claim it makes is refused. Claims it already holds, and work it was invited to, stay."
              confirm="Suspend"
              action={() => act(`${base}/agents/${encodeURIComponent(report.agent_id!)}/suspend`, said("Agent's public claims"))}
              focusAfter={after}
            />
            <ConfirmAction
              label="Lift agent's suspension"
              disabled={retrying}
              title={`Lift ${report.agent_id}'s public claims suspension?`}
              description="It can claim publicly again, where its organization allows it."
              confirm="Lift"
              action={() => act(`${base}/agents/${encodeURIComponent(report.agent_id!)}/lift`, said("Agent's public claims"))}
              focusAfter={after}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
