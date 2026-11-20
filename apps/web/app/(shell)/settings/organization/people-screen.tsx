"use client";

import Link from "next/link";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { authoritySoundingName, chosenNameLabel, plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand } from "@/lib/gateway/client";
import type { GatewayResult } from "@/lib/gateway/result";
import { textNameOf } from "../../w/[id]/tasks/task-model";
import { ConfirmAction } from "../../w/[id]/team/confirm-action";
import { FIELD, MOBILE_TARGET } from "../../w/[id]/team/field";
import { explainOrgRefusal, joinLink, orgRoleLabel, type LostCredentials, type OrgInvitation, type OrgMember } from "./model";

export type PeopleProps = {
  org: { id: string; name: string; personal: boolean; admin: boolean };
  me: string;
  members: OrgMember[];
  /** Null if that read failed. Only asked for an admin of a shared organization. */
  invitations: OrgInvitation[] | null;
  /** Null if that read failed. */
  lostCredentials: LostCredentials[] | null;
  /** The agent read stopped at its limit, so that list may be missing some. */
  lostCredentialsPartial?: boolean;
};

type Notice = { ok: boolean; text: string } | null;

/** Sends one command and reports what the server said. Never optimistic: the lists change only on the refresh. */
function useCommands() {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  async function send<T>(path: string, body: unknown, success: string, method?: "PUT" | "DELETE"): Promise<GatewayResult<T> | null> {
    let result: GatewayResult<T> | null = null;
    try {
      result = await clientCommand<T>(path, body, { method });
    } catch {
      setNotice({ ok: false, text: explainOrgRefusal("network") });
    }
    if (result?.ok) {
      setNotice({ ok: true, text: success });
      router.refresh();
    } else if (result) {
      setNotice({ ok: false, text: explainOrgRefusal(result.code, result.status) });
    }
    return result;
  }

  return { notice, noticeRef, send };
}

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Names are whatever their owners chose, so they're plain text. A blank one falls back to the ID. */
const personLabel = (member: Pick<OrgMember, "person_id" | "name"> | undefined, id: string, me: string) => (id === me ? "You" : plainName(member?.name || id));

function RemovalEffects({ who }: { who: "they" | "you" }) {
  const they = who === "they";
  return (
    <span className="block space-y-2">
      <span className="block">{they ? "They lose access on their next request." : "You lose access straight away."}</span>
      <span className="block font-medium text-foreground">{they ? "Every credential they connected stops working." : "Every credential you connected stops working."} Agents using those credentials can't act until an admin links a new one, and rejoining doesn't restore them by itself.</span>
      <span className="block">{they ? "Organization invitations they made end." : "Organization invitations you made end."} In each workroom, {they ? "they're" : "you're"} removed under the departure rules and {they ? "their" : "your"} workroom invitations are withdrawn.</span>
      <span className="block rounded-md bg-status-amber-surface p-2 text-status-amber">
        {they ? "A workroom they own stays on record as theirs, but they can't use it, and rejoining doesn't give it back." : "A workroom you own stays on record as yours, but you can't use it, and rejoining doesn't give it back."} {they ? "It then appears under Workrooms whose owner left here, where an admin can name a new owner. Ask them to transfer anything they own first." : "An admin of this organization can then name a new owner. To choose who takes over, transfer it first from its settings."}
      </span>
    </span>
  );
}

export function PeopleScreen({ org, me, members, invitations, lostCredentials, lostCredentialsPartial = false }: PeopleProps) {
  const router = useRouter();
  const { notice, noticeRef, send } = useCommands();
  const orgName = plainName(org.name);
  const base = `/api/orgs/${encodeURIComponent(org.id)}`;
  const canManage = org.admin && !org.personal;

  const memberPath = (person: string) => `${base}/members/${encodeURIComponent(person)}`;

  return (
    <div className="space-y-6">
      {/* Always there, because focus moves here when a result removes the control that asked. */}
      <div ref={noticeRef} tabIndex={-1} role="status" className="rounded-lg outline-none empty:hidden">
        {notice?.ok ? <p className="rounded-lg bg-status-green-surface p-3 break-words text-status-green">{notice.text}</p> : null}
        {notice && !notice.ok ? (
          <p role="alert" className="rounded-lg bg-status-danger-surface p-3 break-words text-status-danger">
            {notice.text}
          </p>
        ) : null}
      </div>

      <section aria-labelledby="org-people" className="space-y-3">
        <h2 id="org-people" className="text-lg font-medium break-words">
          People in {orgName}
        </h2>
        {org.personal ? <p className="text-sm text-muted-foreground">A personal organization is only you. To work with other people, create an organization below and invite them to it.</p> : null}
        <ul className="divide-y rounded-lg border">
          {members.map((member) => {
            const self = member.person_id === me;
            const name = personLabel(member, member.person_id, me);
            const nameId = `org-member-${member.person_id}`;
            return (
              <li key={member.person_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div id={nameId} className="min-w-0 flex-1 basis-56 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium break-words">
                    <span className="min-w-0 break-words">{name}</span>
                    {!self && authoritySoundingName(name) ? <Badge variant="outline">{chosenNameLabel("person")}</Badge> : null}
                  </p>
                  {/* Team adds a person by this ID, so it stays where people can copy it. */}
                  <p className="text-xs break-all text-muted-foreground">
                    {member.person_id} · Joined {dateOf(member.created_at)}
                  </p>
                </div>
                <Badge variant="secondary">{orgRoleLabel(member.role)}</Badge>
                {!org.personal ? (
                  <div className="flex flex-wrap gap-2">
                    {canManage && member.role !== "admin" ? (
                      <ConfirmAction
                        label="Make admin"
                        describedBy={nameId}
                        title={<>Make “{name}” an admin of “{orgName}”?</>}
                        description="Admins can invite and remove people, change roles and manage the organization's agents."
                        confirm="Make admin"
                        focusAfter={noticeRef}
                        action={() => send(memberPath(member.person_id), { role: "admin" }, "They're now an admin of this organization.", "PUT")}
                      />
                    ) : null}
                    {canManage && member.role === "admin" ? (
                      <ConfirmAction
                        label={self ? "Stop being admin" : "Remove admin"}
                        describedBy={nameId}
                        title={self ? <>Stop being an admin of “{orgName}”?</> : <>Remove “{name}” as an admin of “{orgName}”?</>}
                        description={self ? "You stay as a member. Organization invitations you made end for good, and you can't manage people any more." : "They stay as a member. Organization invitations they made end for good, even if they become an admin again."}
                        confirm={self ? "Stop being admin" : "Remove admin"}
                        focusAfter={noticeRef}
                        action={() => send(memberPath(member.person_id), { role: "member" }, self ? "You're no longer an admin. You stay as a member." : "They're no longer an admin. They stay as a member.", "PUT")}
                      />
                    ) : null}
                    {self ? (
                      <ConfirmAction
                        label="Leave"
                        describedBy={nameId}
                        variant="ghost"
                        destructive
                        title={<>Leave “{orgName}”?</>}
                        description={<RemovalEffects who="you" />}
                        confirm="Leave organization"
                        focusAfter={noticeRef}
                        action={async () => {
                          const result = await send(memberPath(member.person_id), undefined, "You left this organization.", "DELETE");
                          if (result?.ok) router.replace("/settings/organization?left=1");
                        }}
                      />
                    ) : canManage ? (
                      <ConfirmAction
                        label="Remove"
                        describedBy={nameId}
                        variant="ghost"
                        destructive
                        title={<>Remove “{name}” from “{orgName}”?</>}
                        description={<RemovalEffects who="they" />}
                        confirm="Remove from organization"
                        focusAfter={noticeRef}
                        action={() => send(memberPath(member.person_id), undefined, "Removed. Their access has ended and the credentials they connected no longer work. Their workrooms apply this shortly.", "DELETE")}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!org.admin && !org.personal ? <p className="text-sm text-muted-foreground">Only this organization's admins can invite people or change roles.</p> : null}
      </section>

      {canManage ? <InviteSection base={base} members={members} me={me} invitations={invitations} send={send} focusAfter={noticeRef} /> : null}
      {org.admin ? <LostCredentialsSection agents={lostCredentials} partial={lostCredentialsPartial} /> : null}
    </div>
  );
}

type Send = ReturnType<typeof useCommands>["send"];
type Created = { id: string; token: string; role: string; expires_at: number };

function InviteSection({ base, members, me, invitations, send, focusAfter }: { base: string; members: OrgMember[]; me: string; invitations: OrgInvitation[] | null; send: Send; focusAfter: RefObject<HTMLElement | null> }) {
  const early = useEarlyInput();
  const [role, setRole] = useState<"member" | "admin">("member");
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const names = Object.fromEntries(members.flatMap((member) => (member.name ? [[member.person_id, member.name]] : [])));
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  // The link is what the person has to act on, and it may be far from the message above.
  useEffect(() => {
    if (link) linkRef.current?.focus();
  }, [link]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setLink(null);
    setCopied(false);
    const result = await send<Created>(`${base}/invitations`, { role }, "Invitation created. Copy its link now: it's shown only once.");
    if (result?.ok) setLink({ id: result.data.id, url: joinLink(window.location.origin, result.data.token) });
    // Refused or lost: nothing to copy, and focus should be on why.
    else focusAfter.current?.focus();
    setPending(false);
  };

  const copy = async () => {
    linkRef.current?.select();
    try {
      await navigator.clipboard.writeText(linkRef.current?.value ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby="org-invitations" className="space-y-4">
      <div>
        <h2 id="org-invitations" className="text-lg font-medium">
          Invite someone
        </h2>
        <p className="text-sm text-muted-foreground">Podster doesn't send email for this. Create a link and send it to them yourself. Whoever opens it first and accepts joins, so send it privately.</p>
      </div>
      {link ? (
        <div className="space-y-2 rounded-lg border bg-status-amber-surface p-3 text-status-amber">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Invitation link. It's shown only once, so copy it now.</span>
            <Input ref={linkRef} readOnly value={link.url} onFocus={(event) => event.target.select()} className="bg-background text-foreground" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className={MOBILE_TARGET} onClick={copy}>
              Copy link
            </Button>
            <Button type="button" size="sm" variant="outline" className={`text-foreground ${MOBILE_TARGET}`} onClick={() => setLink(null)}>
              Done
            </Button>
            <span role="status" className="text-sm">
              {copied ? "Copied." : ""}
            </span>
          </div>
        </div>
      ) : null}
      <form ref={early} onSubmit={create} className="space-y-3 rounded-lg border p-3">
        <label className="block max-w-sm space-y-1 text-sm">
          <span>Role when they join</span>
          <select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as "member" | "admin")}>
            <option value="member">Member</option>
            <option value="admin">Admin: can invite and remove people</option>
          </select>
        </label>
        <p className="text-sm text-muted-foreground">It expires after 7 days, and ends for good if you stop being an admin. Joining adds them to no workroom.</p>
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending}>
          {pending ? "Creating…" : "Create invitation link"}
        </Button>
      </form>
      <div className="space-y-2">
        <h3 className="font-medium">Waiting to be accepted</h3>
        {invitations === null ? <ReadFailure /> : null}
        {invitations?.length === 0 ? <p className="text-sm text-muted-foreground">No invitations are waiting.</p> : null}
        {invitations && invitations.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div id={invitation.id} className="min-w-0 flex-1 basis-56 space-y-0.5">
                  <p className="font-medium">{orgRoleLabel(invitation.role)} invitation</p>
                  <p className="break-words text-muted-foreground">
                    Created by {textNameOf(invitation.created_by, me, names)} · Expires {new Date(invitation.expires_at).toUTCString()}
                  </p>
                </div>
                <ConfirmAction
                  label="Withdraw"
                  describedBy={invitation.id}
                  title="Withdraw this invitation?"
                  description="Its link stops working. Anyone who already joined with it stays."
                  confirm="Withdraw invitation"
                  destructive
                  focusAfter={focusAfter}
                  action={async () => {
                    const result = await send(`${base}/invitations/${encodeURIComponent(invitation.id)}`, undefined, "Invitation withdrawn. Its link no longer works.", "DELETE");
                    // A link that no longer works shouldn't still ask to be copied.
                    if (result?.ok && link?.id === invitation.id) setLink(null);
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function LostCredentialsSection({ agents, partial }: { agents: LostCredentials[] | null; partial: boolean }) {
  if (agents?.length === 0 && !partial) return null;
  return (
    <section aria-labelledby="org-lost-credentials" className="space-y-2">
      <h2 id="org-lost-credentials" className="text-lg font-medium">
        Credentials that stopped working
      </h2>
      {agents === null ? (
        <ReadFailure />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Whoever connected these left the organization, so these credentials are refused. Add an agent again to bring it back.</p>
          {partial ? <p role="status" className="text-sm">Your organizations have more agents than we can read here, so some may be missing from this list.</p> : null}
          <ul className="divide-y rounded-lg border empty:hidden">
            {agents.map((agent) => (
              <li key={agent.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span className="min-w-0 break-words font-medium">{plainName(agent.name)}</span>
                <span className="text-muted-foreground">
                  {agent.count} {agent.count === 1 ? "credential" : "credentials"} refused
                </span>
              </li>
            ))}
          </ul>
          <Link href="/agents/connect" prefetch={false} className="text-sm text-primary underline">
            Add an agent
          </Link>
        </>
      )}
    </section>
  );
}
