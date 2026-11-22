"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequesterName } from "@/app/(focused)/approval-fields";
import { AgentContent } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clientCommand } from "@/lib/gateway/client";
import { goToSignIn } from "../../../(shell)/w/[id]/tasks/go-to-sign-in";
import { PRESET_LABELS, PRESET_SUMMARIES, roleLabel } from "../../../(shell)/w/[id]/team/model";
import { AcceptInvitationForm, type AcceptAgent } from "./accept-form";
import { PersonInvitationAccept, type PersonPreview } from "./person-accept";

type WorkRole = { title: string; responsibilities: string; preset: string; is_lead: number | boolean; external?: boolean };
type Preview = { workspace_id?: string; workspace_name: string; role: string; guest_can_create: boolean; invited_org_id: string | null; invited_by: string; expires_at: number; work_role?: WorkRole | null; invitee_kind?: "person"; orgs?: string[]; ends_oversight?: boolean };
type Organization = { id: string; name: string };

type State = { phase: "loading" } | { phase: "ready"; preview: Preview } | { phase: "invalid" } | { phase: "failed"; limited: boolean };

const ROLE_MEANING: Record<string, string> = { guest: "sees only its own tasks", member: "sees every task and thread" };

/** One message for every refusal, so a link can't be probed for why it failed. */
export function InvalidLink() {
  return (
    <div role="alert" className="space-y-2 rounded-lg border p-3">
      <p>This invitation link isn't valid. It may have expired or been used or withdrawn, or it may not be meant for you. Ask whoever sent it for a new one.</p>
      <Link href="/workrooms" prefetch={false} className="text-primary underline">
        Go to your workrooms
      </Link>
    </div>
  );
}

/** A read, but a POST so the token stays out of another URL. Nothing about the room arrives until the API has checked the link for this person. */
/** `people` names the viewer's organizations, and which is personal, for a person invitation's choice of who they join as. */
export function InvitationScreen({ token, form, people = { orgNames: {}, personal: null } }: { token: string; form: { organizations: Organization[]; agents: AcceptAgent[]; partial: boolean } | null; people?: { orgNames: Record<string, string>; personal: string | null } }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const onInvalid = useCallback(() => setState({ phase: "invalid" }), []);

  useEffect(() => {
    let current = true;
    setState({ phase: "loading" });
    clientCommand<Preview>("/api/v1/invitations/preview", { token })
      .then((result) => {
        if (!current) return;
        if (result.ok) setState({ phase: "ready", preview: result.data });
        else if (result.status === 401) goToSignIn();
        else if (result.status >= 500 || result.status === 429) setState({ phase: "failed", limited: result.status === 429 });
        else setState({ phase: "invalid" });
      })
      .catch(() => {
        if (current) setState({ phase: "failed", limited: false });
      });
    return () => {
      current = false;
    };
  }, [token, attempt]);

  if (state.phase === "loading") {
    return (
      <div aria-hidden className="space-y-3">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (state.phase === "invalid") return <InvalidLink />;
  if (state.phase === "failed") {
    return (
      <p role="alert">
        {state.limited ? "Too many requests. Wait a minute, then " : "Couldn't load this invitation. "}
        <Button variant="link" className="h-auto p-0" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </p>
    );
  }

  const { preview } = state;
  // A person invitation is for the signed-in person alone, and the API showed it only because their verified email matches.
  if (preview.invitee_kind === "person") {
    return <PersonInvitationAccept token={token} preview={{ ...preview, workspace_id: preview.workspace_id ?? "", orgs: preview.orgs ?? [] } as PersonPreview} orgNames={people.orgNames} personalOrg={people.personal} onInvalid={onInvalid} />;
  }
  const invitedOrg = preview.invited_org_id;
  // A link naming an organization can only be accepted for it, and the API refuses any other.
  const organizations = form ? (invitedOrg ? form.organizations.filter((org) => org.id === invitedOrg) : form.organizations) : [];
  const invitedOrgName = invitedOrg ? (form?.organizations.find((org) => org.id === invitedOrg)?.name ?? invitedOrg) : null;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border p-3">
        <dt className="text-muted-foreground">Workroom</dt>
        <dd className="min-w-0">
          <RequesterName name={preview.workspace_name} chosenBy="whoever made this workroom" />
        </dd>
        <dt className="text-muted-foreground">Invited by</dt>
        <dd className="break-all">{preview.invited_by}</dd>
        <dt className="text-muted-foreground">Your agents join as</dt>
        <dd>
          {roleLabel(preview.role)}
          {ROLE_MEANING[preview.role] ? `: ${ROLE_MEANING[preview.role]}` : ""}
          {preview.role === "guest" ? (preview.guest_can_create ? ". Can create tasks." : ". Can't create tasks.") : ""}
        </dd>
        <dt className="text-muted-foreground">For</dt>
        <dd className="break-words">{invitedOrgName ? plainName(invitedOrgName) : "Any organization whose admin holds this link"}</dd>
        <dt className="text-muted-foreground">Expires</dt>
        <dd>{new Date(preview.expires_at).toUTCString()}</dd>
      </dl>
      {preview.work_role ? (
        <section aria-labelledby="invitation-opening" className="space-y-2 rounded-lg border p-3">
          <h2 id="invitation-opening" className="font-medium">
            Role opening: {plainName(preview.work_role.title)}
            {preview.work_role.is_lead ? " (lead coordinator)" : ""}
          </h2>
          <p className="text-sm">
            An agent joining for the first time is invited to this opening, and can claim it itself. A claim replaces its access with the {PRESET_LABELS[preview.work_role.preset] ?? preview.work_role.preset} preset. {PRESET_SUMMARIES[preview.work_role.preset]}
          </p>
          {/* Our label, not a name anyone chose. The preview doesn't say who, because a forwarded link would show it to anyone. */}
          <AgentContent author={{ name: "This workroom's owner or an admin", kind: "person", viewer: true }} external={preview.work_role.external !== false} body={preview.work_role.responsibilities} />
        </section>
      ) : null}
      <p className="text-sm text-muted-foreground">Podster hasn't checked the workroom's name. It's whatever its owner or admins typed.</p>
      {form ? <AcceptInvitationForm token={token} organizations={organizations} agents={form.agents} partial={form.partial} onInvalid={onInvalid} /> : <p role="alert">Couldn't load your organizations and agents. Refresh this page to try again.</p>}
    </div>
  );
}
