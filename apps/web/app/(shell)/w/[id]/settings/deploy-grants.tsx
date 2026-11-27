"use client";

import { useId, useRef, useState } from "react";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { plainName } from "@/components/agent-content/text";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD, MOBILE_TARGET } from "../team/field";
import type { Member } from "../team/model";
import { deployCandidates, explainDeployGrantRefusal, type DeployGrants as DeployGrantsRead } from "./release-model";
import { dayOf, expiryFromDay, GRANT_STATE_LABELS } from "./repository-model";
import { StateBadge } from "./state-badge";

export type DeployGrantsProps = {
  roomId: string;
  read: DeployGrantsRead;
  /** The room's policy version: sent only to those who manage access, and the commands need it. */
  policyVersion: number | null;
  viewerId: string | null;
  members: Member[];
  /** Names the server resolved, by principal ID. Anyone not named shows as their ID. */
  names: Record<string, string>;
};

/**
 * Deployment grants in Release (M6 step 6, ADR 0010). A `deploy` grant is the one a release's requester must hold: given
 * by the room's owner or an admin, as a person, to a participant agent not there through a public claim, and it counts
 * only while its giver still is one. Everything here is what the server's reads said, and the form is offered only where
 * they say this viewer manages it. Rust decides each grant again, and checks it again at every release.
 */
export function DeployGrants({ roomId, read, policyVersion, viewerId, members, names }: DeployGrantsProps) {
  const commands = useCommands(policyVersion);
  const { send, clear } = commands;
  const ids = { title: useId(), who: useId(), expiry: useId(), expiryHint: useId() };
  const after = useRef<HTMLDivElement>(null);
  const [who, setWho] = useState("");
  const [day, setDay] = useState("");
  const [pending, setPending] = useState(false);
  const label = (id: string) => (id === viewerId ? "You" : plainName(names[id] ?? id));
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/repository/grants`;
  const expiry = expiryFromDay(day, Date.now());
  const candidates = deployCandidates(members);

  const give = async () => {
    if (pending || !who || expiry.problem) return;
    setPending(true);
    const body: Record<string, unknown> = { principal_id: who, action: "deploy" };
    if (expiry.at !== null) body.expires_at = expiry.at;
    await send(base, body, `Gave ${label(who)} a deployment grant. Each release it asks for still needs the owner's or an admin's approval.`, {
      focus: true,
      explain: explainDeployGrantRefusal,
      onOk: () => {
        setWho("");
        setDay("");
      },
    });
    setPending(false);
  };
  const take = (grantId: string) => send(`${base}/${encodeURIComponent(grantId)}`, {}, "Deployment grant taken back.", { method: "DELETE", explain: explainDeployGrantRefusal });

  return (
    <section aria-labelledby={ids.title} className="space-y-3">
      <h3 id={ids.title} className="pt-2 font-medium">
        Deployment grants
      </h3>
      {read.kind === "off" ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge label="Off" tone="neutral" />
          <span className="text-sm text-muted-foreground">Release is off in this workroom, so nobody can be given a deployment grant. Switch release on first.</span>
        </div>
      ) : null}
      {read.kind === "unavailable" ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge label="Unavailable" tone="neutral" />
          <span className="text-sm text-muted-foreground">Podster doesn&apos;t offer deployment grants in this workroom: it needs a linked repository, and repositories have to be on for this deployment.</span>
        </div>
      ) : null}
      {read.kind === "failed" ? <ReadFailure /> : null}
      {read.kind === "on" ? (
        <>
          <div ref={after} tabIndex={-1} className="outline-none">
            <CommandNotice commands={commands} />
          </div>
          <p className="text-sm text-muted-foreground">An agent with a deployment grant can ask for a release of merged code. It never approves one: the owner or an admin approves each release, as a person. A grant counts only while whoever gave it is still the owner or an admin.</p>
          {read.grants.length === 0 ? (
            <p className="text-sm">Nobody holds a deployment grant here.</p>
          ) : (
            <ul aria-label="Deployment grants" className="divide-y rounded-lg border">
              {read.grants.map((grant) => (
                <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0 flex-1 basis-56 space-y-0.5 text-sm">
                    <p className="break-all font-medium">{label(grant.principal_id)}</p>
                    <p className="text-muted-foreground">
                      Given by <span className="break-all">{label(grant.delegated_by)}</span> on {dayOf(grant.created_at)} · {grant.expires_at === null ? "No expiry" : `Expires ${dayOf(grant.expires_at)}`}
                    </p>
                    {/* Display only: the API checks the grant again at every release. */}
                    <p className="text-muted-foreground">As last read: {GRANT_STATE_LABELS[grant.state] ?? grant.state}</p>
                  </div>
                  {policyVersion !== null ? (
                    <ConfirmAction
                      label="Take back"
                      destructive
                      title={`Take back ${label(grant.principal_id)}'s deployment grant?`}
                      description="They can't ask for a release any more. A release they asked for that isn't live yet fails at its next check. Their place in this workroom doesn't change."
                      confirm="Take back"
                      action={() => take(grant.id)}
                      focusAfter={after}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {read.mayGive ? (
            <form
              aria-label="Give a deployment grant"
              className="space-y-3 rounded-lg border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void give();
              }}
            >
              <h4 className="font-medium">Give a deployment grant</h4>
              <div className="space-y-1">
                <label htmlFor={ids.who} className="text-sm font-medium">
                  Agent
                </label>
                <select
                  id={ids.who}
                  className={FIELD}
                  value={who}
                  disabled={pending}
                  onChange={(event) => {
                    clear();
                    setWho(event.target.value);
                  }}
                >
                  <option value="">Choose an agent</option>
                  {candidates.map((member) => (
                    <option key={member.principal_id} value={member.principal_id}>
                      {member.principal_id} · {label(member.principal_id)}
                    </option>
                  ))}
                </select>
                {candidates.length === 0 ? <p className="text-sm text-muted-foreground">No agent here can hold one. An agent that joined from the public page can&apos;t.</p> : null}
              </div>
              <div className="space-y-1">
                <label htmlFor={ids.expiry} className="text-sm font-medium">
                  Expires (optional)
                </label>
                <input id={ids.expiry} type="date" className={`${FIELD} w-auto`} value={day} disabled={pending} aria-invalid={expiry.problem !== null} aria-describedby={ids.expiryHint} onChange={(event) => setDay(event.target.value)} />
                <p id={ids.expiryHint} aria-live="polite" className={expiry.problem ? "text-sm text-status-danger" : "text-sm text-muted-foreground"}>
                  {expiry.problem ?? "At most a year from now. It ends at the end of that day, UTC. Leave empty for no expiry."}
                </p>
              </div>
              <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending || !who || expiry.problem !== null}>
                {pending ? "Giving…" : "Give the grant"}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
