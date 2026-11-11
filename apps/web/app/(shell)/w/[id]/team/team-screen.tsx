"use client";

import Link from "next/link";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { textNameOf } from "../tasks/task-model";
import { CommandNotice, useCommands, type Send } from "./commands";
import { ConfirmAction } from "./confirm-action";
import { AccessSheet } from "./access-sheet";
import { FIELD, MOBILE_TARGET } from "./field";
import { accessLabel, isExternal, PRESET_LABELS, PRESET_SUMMARIES, roleLabel, type Member, type PendingInvitation, type RoleRead, type Viewer } from "./model";
import { RoleOpenings, RoleSheet } from "./role-openings";

export type AgentOption = { id: string; name: string; org_id: string };
export type OrgOption = { id: string; name: string };

export type TeamProps = {
  roomId: string;
  roomName: string;
  archived?: boolean;
  owner: string;
  /** Null unless the server says this viewer may manage access. */
  policyVersion: number | null;
  members: Member[];
  viewer: Viewer;
  names: Record<string, string>;
  orgNames: Record<string, string>;
  /** The viewer's organizations, or null if that read failed. */
  orgs: OrgOption[] | null;
  /** Agents of the room's own organization that the viewer's organizations hold, or null if either read failed. */
  agents: AgentOption[] | null;
  /** There are more of the viewer's organizations' agents than the read returned. */
  agentsPartial?: boolean;
  /** Null if that read failed or isn't open to this viewer. */
  invitations: { pending: PendingInvitation[]; complete: boolean } | null;
  /** The room's role openings, or null if that read failed. */
  roles?: RoleRead | null;
};

export function TeamScreen(props: TeamProps) {
  const { roomId, roomName, archived = false, owner, policyVersion, members, viewer, names, orgNames, orgs, agents, agentsPartial = false, invitations, roles = { roles: [], external: false } } = props;
  const canManage = policyVersion !== null;
  const isOwner = viewer.id === owner;
  const commands = useCommands(policyVersion);
  const { noticeRef, send } = commands;
  const room = plainName(roomName);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}`;
  const label = (id: string) => (id === viewer.id ? "You" : plainName(names[id] ?? id));
  const orgLabel = (id: string) => orgNames[id] ?? id;
  const memberIds = new Set(members.map((member) => member.principal_id));

  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Team</h1>
        <CommandNotice commands={commands} />
      </div>

      <RoleOpenings base={base} room={room} read={roles} canManage={canManage} archived={archived} send={send} label={label} />

      <section aria-labelledby="participants" className="space-y-3">
        <h2 id="participants" className="text-lg font-medium">
          Participants
        </h2>
        <ul className="divide-y rounded-lg border">
          <li className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="min-w-0">
              <AuthorLine author={{ name: label(owner), kind: "person", viewer: isOwner }} />
            </div>
            <Badge variant="secondary">Owner</Badge>
          </li>
          {members.map((member) => {
            const nameId = `member-${member.principal_id}`;
            const name = label(member.principal_id);
            const self = member.principal_id === viewer.id;
            return (
              <li key={member.principal_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div id={nameId} className="min-w-0 flex-1 basis-56">
                  <AuthorLine author={{ name, kind: member.kind, organization: orgLabel(member.org_id), viewer: self }} external={isExternal(member.org_id, viewer)} />
                </div>
                <Badge variant="secondary">{accessLabel(member)}</Badge>
                <div className="flex flex-wrap gap-2">
                  {member.kind === "agent" && (canManage || viewer.adminOrgs.includes(member.org_id)) ? (
                    <Button asChild size="sm" variant="outline" className={MOBILE_TARGET}>
                      <SheetLink param="agent" target={member.principal_id} aria-describedby={nameId}>
                        {canManage ? "Manage access" : "View access"}
                      </SheetLink>
                    </Button>
                  ) : null}
                  {member.kind === "person" && isOwner && !archived && member.role !== "admin" ? (
                    <ConfirmAction
                      label="Make admin"
                      describedBy={nameId}
                      title={<>Make “{name}” an admin of “{room}”?</>}
                      description="Admins manage agents' access in this workroom. They can also set up this workroom's repository and grant push or merge on it. They can't appoint other admins."
                      confirm="Make admin"
                      focusAfter={noticeRef}
                      action={() => send(`${base}/members/${encodeURIComponent(member.principal_id)}/role`, { role: "admin" }, "They're now an admin of this workroom.")}
                    />
                  ) : null}
                  {member.kind === "person" && isOwner && !archived && member.role === "admin" ? (
                    <ConfirmAction
                      label="Remove admin"
                      describedBy={nameId}
                      title={<>Remove “{name}” as an admin of “{room}”?</>}
                      description="They stay in the workroom as a member, and can't manage access any more."
                      confirm="Remove admin"
                      focusAfter={noticeRef}
                      action={() => send(`${base}/members/${encodeURIComponent(member.principal_id)}/role`, { role: "member" }, "They're no longer an admin. They stay as a member.")}
                    />
                  ) : null}
                  {member.kind === "person" && !self && (member.role === "admin" ? isOwner : canManage) ? (
                    <ConfirmAction
                      label="Revoke"
                      describedBy={nameId}
                      variant="ghost"
                      destructive
                      title={<>Revoke “{name}” from “{room}”?</>}
                      description="They lose access to this workroom straight away. Tasks follow the departure rules, and history stays."
                      confirm="Revoke access"
                      focusAfter={noticeRef}
                      action={() => send(`${base}/members/${encodeURIComponent(member.principal_id)}`, {}, "Access revoked.", { method: "DELETE" })}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {members.length === 0 && canManage && !archived ? <p className="text-muted-foreground">Nobody else is here yet. Add an agent from your organization, or invite another organization.</p> : null}
        {members.length === 0 && !canManage ? <p className="text-muted-foreground">Nobody else is listed for you here.</p> : null}
        {canManage ? null : <p className="text-sm text-muted-foreground">Only this workroom's owner and appointed admins can change who's here.</p>}
      </section>

      {canManage && !archived ? <AddParticipants base={base} isOwner={isOwner} orgs={orgs} agents={agents} agentsPartial={agentsPartial} orgNames={orgNames} memberIds={memberIds} send={send} /> : null}
      {canManage ? <Invitations openings={roles?.roles ?? []} base={base} room={room} archived={archived} invitations={invitations} orgLabel={orgLabel} label={(id) => textNameOf(id, viewer.id, names)} send={send} focusAfter={noticeRef} /> : null}

      <AccessSheet roomId={roomId} roomName={roomName} viewer={viewer} names={names} orgNames={orgNames} />
      <RoleSheet roomId={roomId} roomName={roomName} label={label} />
    </section>
  );
}

function AddParticipants({ base, isOwner, orgs, agents, agentsPartial, orgNames, memberIds, send }: { base: string; isOwner: boolean; orgs: OrgOption[] | null; agents: AgentOption[] | null; agentsPartial: boolean; orgNames: Record<string, string>; memberIds: Set<string>; send: Send }) {
  const agentForm = useEarlyInput();
  const personForm = useEarlyInput();
  const available = agents?.filter((agent) => !memberIds.has(agent.id)) ?? [];
  const [agent, setAgent] = useState("");
  const [agentRole, setAgentRole] = useState<"member" | "guest">("member");
  const [person, setPerson] = useState("");
  const [personOrg, setPersonOrg] = useState(orgs?.[0]?.id ?? "");
  const [personRole, setPersonRole] = useState<"admin" | "member" | "guest">("member");
  const [pending, setPending] = useState<"agent" | "person" | null>(null);

  const addAgent = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = available.find((option) => option.id === agent);
    if (!chosen) return;
    setPending("agent");
    await send(`${base}/members`, { principal_id: chosen.id, kind: "agent", org_id: chosen.org_id, role: agentRole }, "Agent added. It will see this at its next session or wake.", { focus: true, onOk: () => setAgent("") });
    setPending(null);
  };

  const addPerson = async (event: FormEvent) => {
    event.preventDefault();
    setPending("person");
    await send(`${base}/members`, { principal_id: person.trim(), kind: "person", org_id: personOrg, role: personRole }, "Person added.", { focus: true, onOk: () => setPerson("") });
    setPending(null);
  };

  return (
    <section aria-labelledby="add-participants" className="space-y-4">
      <div>
        <h2 id="add-participants" className="text-lg font-medium">
          Add from your organization
        </h2>
        <p className="text-sm text-muted-foreground">Only the workroom's own organization can be added directly. Invite anyone else below.</p>
      </div>
      <form ref={agentForm} onSubmit={addAgent} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Add an agent</h3>
        {agents === null ? <ReadFailure /> : null}
        {agentsPartial ? <p role="status" className="text-sm">Your organizations have more agents than we can list here, so some of this workroom's may be missing.</p> : null}
        {agents !== null && available.length === 0 && !agentsPartial ? (
          <p className="text-sm text-muted-foreground">
            None of this workroom's organization's agents are left to add.{" "}
            <Link href="/agents/connect" prefetch={false} className="text-primary underline">
              Connect an agent
            </Link>
          </p>
        ) : null}
        {available.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>Agent</span>
              <select className={FIELD} value={agent} required onChange={(event) => setAgent(event.target.value)}>
                <option value="">Choose an agent</option>
                {available.map((option) => (
                  <option key={option.id} value={option.id}>
                    {plainName(option.name)} ({plainName(orgNames[option.org_id] ?? option.org_id)})
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>Role</span>
              <select className={FIELD} value={agentRole} onChange={(event) => setAgentRole(event.target.value as "member" | "guest")}>
                <option value="member">Member</option>
                <option value="guest">Guest</option>
              </select>
            </label>
          </div>
        ) : null}
        {available.length > 0 ? (
          <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending !== null || !agent}>
            {pending === "agent" ? "Adding…" : "Add agent"}
          </Button>
        ) : null}
      </form>
      {orgs === null ? (
        <div className="space-y-2 rounded-lg border p-3">
          <h3 className="font-medium">Add a person</h3>
          <ReadFailure />
        </div>
      ) : (
      <form ref={personForm} onSubmit={addPerson} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Add a person</h3>
        <p className="text-sm text-muted-foreground">People are added by their person ID, because Podster has no directory of an organization's people yet.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>Person ID</span>
            <Input value={person} required onChange={(event) => setPerson(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="space-y-1 text-sm">
            <span>Organization</span>
            <select className={FIELD} value={personOrg} onChange={(event) => setPersonOrg(event.target.value)}>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {plainName(org.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>Role</span>
            <select className={FIELD} value={personRole} onChange={(event) => setPersonRole(event.target.value as "admin" | "member" | "guest")}>
              {isOwner ? <option value="admin">Admin</option> : null}
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </label>
        </div>
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending !== null || !person.trim() || !personOrg}>
          {pending === "person" ? "Adding…" : "Add person"}
        </Button>
      </form>
      )}
    </section>
  );
}

type Created = { id: string; token?: string; role: string; expires_at: number };

function Invitations({ openings, base, room, archived, invitations, orgLabel, label, send, focusAfter }: { openings: RoleRead["roles"]; base: string; room: string; archived: boolean; invitations: TeamProps["invitations"]; orgLabel: (id: string) => string; label: (id: string) => string; send: Send; focusAfter: RefObject<HTMLDivElement | null> }) {
  const early = useEarlyInput();
  const [role, setRole] = useState<"guest" | "member">("guest");
  const [invitedOrg, setInvitedOrg] = useState("");
  const [guestCanCreate, setGuestCanCreate] = useState(false);
  const [opening, setOpening] = useState("");
  const named = openings.find((option) => option.id === opening);
  const openingName = (id: string) => {
    const found = openings.find((option) => option.id === id);
    return found ? `${plainName(found.title)} (${PRESET_LABELS[found.preset] ?? found.preset})` : id;
  };
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lostLink, setLostLink] = useState<string | null>(null);
  const lostLinkRef = useRef<HTMLParagraphElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  // The link is what the person has to act on, and it may be far from the message above.
  useEffect(() => {
    if (link) linkRef.current?.focus();
  }, [link]);

  useEffect(() => {
    if (lostLink) lostLinkRef.current?.focus();
  }, [lostLink]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setLink(null);
    setLostLink(null);
    setCopied(false);
    const body = { role, ...(invitedOrg.trim() ? { invited_org_id: invitedOrg.trim() } : {}), ...(role === "guest" ? { guest_can_create: guestCanCreate } : {}), ...(opening ? { work_role_id: opening } : {}) };
    // A retry's stored answer never repeats the secret, so that link can't be shown again and there's nothing to copy.
    const success = (created: Created) => (created.token ? "Invitation created. Copy its link now: it's shown only once." : null);
    await send<Created>(`${base}/invitations`, body, success, {
      onOk: (created) => {
        // The next link starts with no opening named, so nothing is offered by leftover choice.
        setOpening("");
        if (created.token) setLink(`${window.location.origin}/invitations/${created.token}`);
        else setLostLink(created.id);
      },
      onDone: (outcome) => {
        // Refused or unknown: nothing to copy, and focus should be on why. A retry lands here too.
        if (outcome.kind !== "ok") focusAfter.current?.focus();
      },
    });
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
    <section aria-labelledby="invitations" className="space-y-4">
      <div>
        <h2 id="invitations" className="text-lg font-medium">
          Invitations
        </h2>
        <p className="text-sm text-muted-foreground">An admin of the invited organization accepts and picks which of its agents join. Inviting doesn't add anyone by itself.</p>
      </div>
      {link ? (
        <div className="space-y-2 rounded-lg border bg-status-amber-surface p-3 text-status-amber">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Invitation link. It's shown only once, so copy it now.</span>
            <Input ref={linkRef} readOnly value={link} onFocus={(event) => event.target.select()} className="bg-background text-foreground" />
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
      {lostLink ? (
        <p ref={lostLinkRef} tabIndex={-1} role="alert" className="rounded-lg bg-status-amber-surface p-3 break-words text-status-amber outline-none">
          The invitation was created, but its link is shown only once and that answer was lost. Withdraw {lostLink} below and create another.
        </p>
      ) : null}
      {archived ? (
        <p className="text-sm text-muted-foreground">New invitations wait until this workroom is brought back. Links below can't be used until then, but you can still withdraw them.</p>
      ) : (
      <form ref={early} onSubmit={create} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Create an invitation</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Role for agents who join</span>
            <select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as "guest" | "member")}>
              <option value="guest">Guest: sees only its own tasks</option>
              <option value="member">Member: sees every task and thread</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>Only this organization ID (optional)</span>
            <Input value={invitedOrg} onChange={(event) => setInvitedOrg(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        </div>
        {role === "guest" ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={guestCanCreate} onChange={(event) => setGuestCanCreate(event.target.checked)} />
            <span>Let these guests create tasks</span>
          </label>
        ) : null}
        {openings.length > 0 ? (
          <label className="block space-y-1 text-sm">
            <span>Role opening (optional)</span>
            <select className={FIELD} value={opening} onChange={(event) => setOpening(event.target.value)}>
              <option value="">None</option>
              {openings.map((option) => (
                <option key={option.id} value={option.id}>
                  {plainName(option.title)} ({PRESET_LABELS[option.preset] ?? option.preset}{option.is_lead ? ", lead" : ""})
                </option>
              ))}
            </select>
            <span className="block text-muted-foreground">An agent joining for the first time through this link is invited to it, and claims it itself.</span>
          </label>
        ) : null}
        {named ? (
          <p role="note" className={`rounded-lg p-3 text-sm ${invitedOrg.trim() ? "bg-muted" : "bg-status-amber-surface"}`}>
            A claim copies the {PRESET_LABELS[named.preset] ?? named.preset} preset. {PRESET_SUMMARIES[named.preset]}{" "}
            {invitedOrg.trim() ? "" : "This link names no organization, so an admin of any organization holding it can bring in an agent that can claim this."}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">Without an organization ID, an admin of any organization holding the link can accept it. It expires after 7 days.</p>
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending}>
          {pending ? "Creating…" : "Create invitation"}
        </Button>
      </form>
      )}
      <div className="space-y-2">
        <h3 className="font-medium">Pending</h3>
        {invitations === null ? <ReadFailure /> : null}
        {invitations && !invitations.complete ? <p role="status">This workroom has more pending invitations than we can list here. These are the newest.</p> : null}
        {invitations?.pending.length === 0 ? <p className="text-sm text-muted-foreground">{archived ? "No invitations are pending." : "No invitations are pending. Create one above to bring in another organization's agents."}</p> : null}
        {invitations && invitations.pending.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {invitations.pending.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div id={invitation.id} className="min-w-0 flex-1 basis-56 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{invitation.id}</span>
                    <Badge variant="outline">{archived ? "Paused" : "Pending"}</Badge>
                  </p>
                  <p className="break-words text-muted-foreground">
                    {roleLabel(invitation.role)} · {invitation.workRole ? `Opening: ${openingName(invitation.workRole)} · ` : ""}{invitation.invitedOrg ? `Only ${plainName(orgLabel(invitation.invitedOrg))}` : "Any organization"} · Created by {label(invitation.createdBy)} · Expires {new Date(invitation.expiresAt).toUTCString()}
                  </p>
                </div>
                <ConfirmAction
                  label="Withdraw"
                  describedBy={invitation.id}
                  title={<>Withdraw this invitation to “{room}”?</>}
                  description="Its link stops working. Anyone who already joined with it stays."
                  confirm="Withdraw invitation"
                  destructive
                  focusAfter={focusAfter}
                  action={() => send(`${base}/invitations/${encodeURIComponent(invitation.id)}`, {}, "Invitation withdrawn. Its link no longer works.", { method: "DELETE", onOk: () => setLostLink((current) => (current === invitation.id ? null : current)) })}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
