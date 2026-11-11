"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { plainName } from "@/components/agent-content/text";
import { ACTION_LABELS, dayOf, expiryFromDay, explainGrantRefusal, GRANT_STATE_LABELS, type RepoGrant } from "../settings/repository-model";
import { CommandNotice, useCommands } from "./commands";
import { ConfirmAction } from "./confirm-action";
import { FIELD, MOBILE_TARGET } from "./field";
import type { Member } from "./model";

export type GrantsProps = {
  roomId: string;
  grants: RepoGrant[];
  /** Whether the room has a linked repository, from the repository read; null when this viewer can't read it. */
  linked: boolean | null;
  /** Hints only: the API decides who may give and take back each grant. */
  runsRepository: boolean;
  /** Administers the room's organization and is in the room: may take any grant back. */
  isOrgAdmin: boolean;
  viewerId: string;
  /** Null unless the viewer manages access: the commands need it, and the API sends it to no one else. */
  policyVersion: number | null;
  archived: boolean;
  members: Member[];
  names: Record<string, string>;
};

/**
 * Repository grants in Manage access (M5 step 9(b), ADR 0009). Shown only while the server answers the grants read, so with
 * managed repositories switched off nothing here renders. Each grant's `state` is the API's display value: it decides
 * nothing here, and every use of a grant is checked again from current authority.
 */
export function RepositoryGrants({ roomId, grants, linked, runsRepository, isOrgAdmin, viewerId, policyVersion, archived, members, names }: GrantsProps) {
  const commands = useCommands(policyVersion);
  const { send, clear } = commands;
  const ids = { who: useId(), action: useId(), expiry: useId(), expiryHint: useId(), merge: useId() };
  const after = useRef<HTMLDivElement>(null);
  const [who, setWho] = useState("");
  const [action, setAction] = useState<RepoGrant["action"]>("push");
  const [day, setDay] = useState("");
  const [pending, setPending] = useState(false);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/repository/grants`;
  const label = (id: string) => (id === viewerId ? "You" : plainName(names[id] ?? id));
  const expiry = expiryFromDay(day, Date.now());
  const mayGrant = runsRepository && linked === true && !archived && policyVersion !== null;
  // Someone who joined through a public claim can't hold repository access, so they're never offered. The flag is the room
  // read's, for those who manage access; the API refuses such a grant with `grantee_public` whatever the form shows.
  const offered = members.filter((member) => member.public_claim !== true);
  const unavailable = members.filter((member) => member.public_claim === true);

  const give = async () => {
    if (pending || !who || expiry.problem) return;
    setPending(true);
    const body: Record<string, unknown> = { principal_id: who, action };
    if (expiry.at !== null) body.expires_at = expiry.at;
    await send(base, body, `Granted ${ACTION_LABELS[action].toLowerCase()} to ${label(who)}.`, { focus: true, explain: explainGrantRefusal, onOk: () => setDay("") });
    setPending(false);
  };

  const take = (grant: RepoGrant) => send(`${base}/${encodeURIComponent(grant.id)}`, {}, "Grant taken back.", { method: "DELETE", explain: explainGrantRefusal });

  // Taking back needs the room's policy version, which the API sends only to those who manage access.
  const mayTake = (grant: RepoGrant) => policyVersion !== null && (runsRepository || isOrgAdmin || grant.principal_id === viewerId);

  return (
    <section aria-labelledby={`${ids.who}-title`} className="max-w-3xl space-y-3">
      <h2 id={`${ids.who}-title`} className="text-lg font-medium">
        Repository access
      </h2>
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      <p className="text-sm text-muted-foreground">Push lets an agent get a short-lived token for its own tasks. Merge lets a participant ask Podster to merge an approved task. Only this workroom&apos;s owner and admins grant either, and a grant counts only while whoever gave it still is one.</p>
      <p id={ids.merge} className="text-sm text-muted-foreground">
        A merge grant never lets anyone merge work they control: the person behind a task&apos;s submitter can&apos;t merge that task.
      </p>

      {grants.length === 0 ? (
        <p>{linked === true ? "Nobody holds repository access yet." : "You hold no repository access here."}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {grants.map((grant) => (
            <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0 flex-1 basis-56 space-y-0.5 text-sm">
                <p className="break-all font-medium">
                  {label(grant.principal_id)} · {ACTION_LABELS[grant.action]}
                </p>
                <p className="text-muted-foreground">
                  Given by <span className="break-all">{label(grant.delegated_by)}</span> on {dayOf(grant.created_at)} · {grant.expires_at === null ? "No expiry" : `Expires ${dayOf(grant.expires_at)}`}
                </p>
                {/* Display only: the API checks the grant again at every use. */}
                <p className="text-muted-foreground">As last read: {GRANT_STATE_LABELS[grant.state] ?? grant.state}</p>
              </div>
              {mayTake(grant) ? (
                <ConfirmAction
                  label="Take back"
                  destructive
                  title={`Take back ${label(grant.principal_id)}'s ${ACTION_LABELS[grant.action].toLowerCase()} access?`}
                  description="Any repository token issued under it is revoked. Their place in this workroom doesn't change."
                  confirm="Take back"
                  action={() => take(grant)}
                  focusAfter={after}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {mayGrant ? (
        <form
          className="space-y-3 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void give();
          }}
        >
          <h3 className="font-medium">Grant repository access</h3>
          <div className="space-y-1">
            <label htmlFor={ids.who} className="text-sm font-medium">
              Participant
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
              <option value="">Choose a participant</option>
              {offered.map((member) => (
                <option key={member.principal_id} value={member.principal_id}>
                  {member.principal_id} · {label(member.principal_id)} ({member.kind === "agent" ? "agent" : "person"})
                </option>
              ))}
            </select>
            {unavailable.length > 0 ? (
              <div className="text-sm text-muted-foreground">
                <p>Unavailable: they joined from the public page, so they can&apos;t hold repository access.</p>
                <ul className="list-disc pl-5">
                  {unavailable.map((member) => (
                    <li key={member.principal_id} className="break-all">
                      {member.principal_id} · {label(member.principal_id)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Access</legend>
            {(["push", "merge"] as const).map((choice) => (
              <label key={choice} className="flex items-center gap-2 text-sm">
                <input type="radio" name={ids.action} className="size-4" value={choice} checked={action === choice} disabled={pending} aria-describedby={choice === "merge" ? ids.merge : undefined} onChange={() => setAction(choice)} />
                {ACTION_LABELS[choice]}
              </label>
            ))}
          </fieldset>
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
            {pending ? "Granting…" : "Grant"}
          </Button>
        </form>
      ) : null}
      {runsRepository && linked === false ? <p className="text-sm text-muted-foreground">Grants can be given once this workroom&apos;s repository is set up, in Settings.</p> : null}
      {!runsRepository && policyVersion !== null ? <p className="text-sm text-muted-foreground">Only this workroom&apos;s owner and admins can grant repository access. They, an admin of this workroom&apos;s organization or the holder can take a grant back.</p> : null}
    </section>
  );
}
