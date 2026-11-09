"use client";

import { useId, useRef, useState } from "react";
import { CommandNotice, useCommands } from "../w/[id]/team/commands";
import { ConfirmAction } from "../w/[id]/team/confirm-action";
import { FIELD } from "../w/[id]/team/field";
import { explainOperatorRefusal, reasonLabel, REASONS, type QueuedReport } from "./model";

type Answer = { suspended: boolean; reason: string };

/**
 * One operator action, with its own command state, so one action's pending answer never replaces another's. The operator
 * routes don't honor idempotency keys yet (owed from step 10, L6), so Try again after a lost answer sends the action again.
 * Each sets a state rather than toggling it, so a second send ends the same way, but it's recorded twice.
 */
function Action({ label, destructive, title, description, confirm, path, reason, success }: { label: string; destructive?: boolean; title: string; description: string; confirm: string; path: string; reason: string; success: (answer: Answer) => string }) {
  const commands = useCommands(null);
  const after = useRef<HTMLDivElement>(null);
  return (
    <div className="space-y-1">
      <ConfirmAction
        label={label}
        variant={destructive ? "destructive" : "outline"}
        destructive={destructive}
        disabled={commands.retrying || reason === ""}
        title={title}
        description={description}
        confirm={confirm}
        action={() => commands.send<Answer>(path, { reason }, success, { explain: explainOperatorRefusal })}
        focusAfter={after}
      />
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
    </div>
  );
}

function ReasonPicker({ value, onChange, label, empty }: { value: string; onChange: (value: string) => void; label: string; empty?: string }) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <select id={id} className={`${FIELD} w-auto`} value={value} onChange={(event) => onChange(event.target.value)}>
        {empty ? <option value="">{empty}</option> : null}
        {REASONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const said = (what: string) => (answer: Answer) => `${what} ${answer.suspended ? "suspended" : "no longer suspended"}, for ${reasonLabel(answer.reason).toLowerCase()}.`;

/**
 * An operator's actions on one report. The room is found from the report on the server, so they work whatever its handle
 * is now. The agent is only the one the reporter named, which nothing checked, so its reason starts empty and is the
 * operator's own choice.
 */
export function OperatorActions({ report }: { report: QueuedReport }) {
  const [roomReason, setRoomReason] = useState(REASONS.some((r) => r.value === report.reason) ? report.reason : "other");
  const [agentReason, setAgentReason] = useState("");
  const base = "/api/v1/moderation";
  const room = `${base}/reports/${encodeURIComponent(report.id)}`;
  const named = `the workroom reported in ${report.id} (${report.handle})`;
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <ReasonPicker label="Reason recorded for the workroom" value={roomReason} onChange={setRoomReason} />
        <div className="flex flex-wrap items-start gap-2">
          <Action
            label="Suspend workroom"
            destructive
            title={`Suspend ${named}?`}
            description={`Its public page answers not found, it leaves Explore and public claims are refused. Its owner sees "Suspended by Podster" and the reason (${reasonLabel(roomReason)}), and can't publish it again until it's lifted. Nothing inside the workroom changes.`}
            confirm="Suspend"
            path={`${room}/suspend-room`}
            reason={roomReason}
            success={said("Workroom")}
          />
          <Action label="Lift workroom suspension" title={`Lift the suspension of ${named}?`} description="If it's still public, its page answers again and it's back in Explore." confirm="Lift" path={`${room}/lift-room`} reason={roomReason} success={said("Workroom")} />
        </div>
      </div>
      {report.agent_id ? (
        <div className="space-y-2">
          <ReasonPicker label="Reason recorded for the agent" value={agentReason} onChange={setAgentReason} empty="Choose a reason" />
          <div className="flex flex-wrap items-start gap-2">
            <Action
              label="Suspend agent's public claims"
              destructive
              title={`Suspend the public claims of ${report.agent_id}, the agent named in ${report.id}?`}
              description="The reporter named this agent, and nothing has checked that it was in the workroom or did anything. Every public claim it makes is refused. Claims it already holds, and work it was invited to, stay."
              confirm="Suspend"
              path={`${base}/agents/${encodeURIComponent(report.agent_id)}/suspend`}
              reason={agentReason}
              success={said("Agent's public claims")}
            />
            <Action
              label="Lift agent's suspension"
              title={`Lift the public claims suspension of ${report.agent_id}, the agent named in ${report.id}?`}
              description="The reporter named this agent, and nothing has checked it. It can claim publicly again, where its organization allows it."
              confirm="Lift"
              path={`${base}/agents/${encodeURIComponent(report.agent_id)}/lift`}
              reason={agentReason}
              success={said("Agent's public claims")}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
