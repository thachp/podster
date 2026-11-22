"use client";

import Link from "next/link";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { RequesterName } from "@/app/(focused)/approval-fields";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { goToSignIn } from "../../../(shell)/w/[id]/tasks/go-to-sign-in";
import { FIELD, MOBILE_TARGET } from "../../../(shell)/w/[id]/team/field";
import { roleLabel } from "../../../(shell)/w/[id]/team/model";

/** What a person invitation offers its addressee (decision 239). Only they get it: anyone else is told the link isn't valid. */
/** `invited_by_name` is what the inviter calls themselves, from the gateway's own rows: shown as untrusted text, never an email. */
export type PersonPreview = { workspace_id: string; workspace_name: string; role: string; guest_can_create: boolean; invited_by: string; invited_by_name?: string | null; expires_at: number; orgs: string[]; ends_oversight?: boolean };

const ROLE_MEANING: Record<string, string> = { guest: "you see only tasks you're part of, and their threads", member: "you see every task and thread" };

function explain(code: string) {
  switch (code) {
    case "already_member":
      return "You're already in this workroom, so nothing changed.";
    case "not_allowed":
      return "You can't join as that organization. Choose another, or ask whoever invited you for a new invitation. Nothing changed.";
    case "invalid_argument":
      return "You can't join as that organization. Choose another one. Nothing changed.";
    case "limit_exceeded":
      return "This workroom has reached its limit. Nothing changed.";
    case "rate_limited":
      return "Too many requests. Wait a minute and try again.";
    default:
      return "That didn't work, and nothing changed.";
  }
}

const UNKNOWN_OUTCOME = "We can't tell whether this worked. Try again with the same choice: if it did, you'll get that answer.";

/**
 * Accepting a person invitation: the person joins as one of their own organizations other than the workroom's, their
 * personal one first when it's offered. That organization is a label and gets nothing in the workroom. Names are plain data.
 */
export function PersonInvitationAccept({ token, preview, orgNames, personalOrg, onInvalid }: { token: string; preview: PersonPreview; orgNames: Record<string, string>; personalOrg?: string | null; onInvalid: () => void }) {
  const early = useEarlyInput();
  const ordered = [...preview.orgs].sort((a, b) => Number(b === personalOrg) - Number(a === personalOrg));
  const [org, setOrg] = useState(ordered[0] ?? "");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [joined, setJoined] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const orgName = (id: string) => plainName(orgNames[id] ?? id);

  useEffect(() => {
    if (joined) resultRef.current?.focus();
  }, [joined]);

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !org) return;
    setPending(true);
    setProblem(null);
    try {
      const result = await clientCommand<{ status: string }>("/api/v1/invitations/accept", { token, org_id: org });
      if (result.ok) setJoined(true);
      else if (result.status === 401) goToSignIn();
      else if (result.status >= 500) {
        setUnknown(true);
        setProblem(UNKNOWN_OUTCOME);
      } else if (result.code === "invitation_not_found") onInvalid();
      else {
        if (result.status !== 429) setUnknown(false);
        setProblem(explain(result.code));
      }
    } catch {
      setUnknown(true);
      setProblem(UNKNOWN_OUTCOME);
    }
    setPending(false);
  };

  const details = (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border p-3">
      <dt className="text-muted-foreground">Workroom</dt>
      <dd className="min-w-0">
        <RequesterName name={preview.workspace_name} chosenBy="whoever made this workroom" />
      </dd>
      <dt className="text-muted-foreground">Invited by</dt>
      <dd className="min-w-0">{preview.invited_by_name ? <RequesterName name={preview.invited_by_name} chosenBy="the person who invited you" /> : "This workroom's owner or an admin"}</dd>
      <dt className="text-muted-foreground">You join as</dt>
      <dd>
        {roleLabel(preview.role)}
        {ROLE_MEANING[preview.role] ? `: ${ROLE_MEANING[preview.role]}` : ""}
        {preview.role === "guest" ? (preview.guest_can_create ? ". You can create tasks." : ". You can't create tasks.") : ""}
      </dd>
      <dt className="text-muted-foreground">Expires</dt>
      <dd>{new Date(preview.expires_at).toUTCString()}</dd>
    </dl>
  );

  if (joined) {
    return (
      <div className="space-y-4">
        {details}
        <div ref={resultRef} tabIndex={-1} role="status" className="space-y-2 rounded-lg bg-status-green-surface p-3 text-status-green outline-none">
          <p className="font-medium">You joined the workroom.</p>
          <Link href={`/w/${encodeURIComponent(preview.workspace_id)}`} prefetch={false} className="underline">
            Open the workroom
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {details}
      <p className="text-sm text-muted-foreground">Podster hasn't checked the workroom's name. It's whatever its owner or admins typed.</p>
      {preview.orgs.length === 0 ? (
        <p>You can join only as one of your own organizations other than this workroom's, and you have none to offer. Ask whoever invited you to add you to the workroom directly.</p>
      ) : (
        <form ref={early} onSubmit={accept} className="space-y-4">
          <fieldset disabled={unknown} className="space-y-2">
            <label className="block space-y-1">
              <span className="font-medium">Join as</span>
              <select className={FIELD} value={org} required onChange={(event) => setOrg(event.target.value)}>
                {ordered.map((id) => (
                  <option key={id} value={id}>
                    {orgName(id)}
                    {id === personalOrg ? " (personal)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted-foreground">This only says where you're from. That organization gets nothing in the workroom, and its admins don't see it. Leaving that organization ends your place here.</p>
          </fieldset>
          {preview.ends_oversight ? (
            <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
              You oversee your organization's agents in this workroom. Once you join it yourself, you see it only through your own place in it, and that oversight doesn't come back, even if you leave.
            </p>
          ) : null}
          {problem ? (
            <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
              {problem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className={MOBILE_TARGET} disabled={pending || !org}>
              {pending ? "Joining…" : unknown ? "Try again" : "Join workroom"}
            </Button>
            <Button asChild variant="outline" className={MOBILE_TARGET}>
              <Link href="/workrooms" prefetch={false}>
                Not now
              </Link>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">This brings in you only, never your agents. It doesn't grant GitHub, merge, Builds, release or deployment access, and you can't manage who's here.</p>
        </form>
      )}
    </div>
  );
}
