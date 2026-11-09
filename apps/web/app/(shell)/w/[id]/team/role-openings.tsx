"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { useEarlyInput } from "@/hooks/use-early-input";
import { AgentContent, AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { SheetLink, TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import type { Workroom } from "@/lib/workroom";
import { kindOf } from "../tasks/task-model";
import type { Send } from "./commands";
import { ConfirmAction } from "./confirm-action";
import { FIELD, MOBILE_TARGET } from "./field";
import { PublicClaimToggle } from "./public-claim-toggle";
import { canBePublic, explainRefusal, membersOf, PRESET_LABELS, PRESET_SUMMARIES, presetOptions, roleFitsLimits, type Member, type RoleOpening, type RoleRead } from "./model";

const TEXTAREA = `${FIELD} h-auto py-2`;

const explainRoleRefusal = (code: string, status = 400) => {
  if (code === "lead_exists") return "This workroom already has a lead opening. Nothing changed.";
  if (code === "idempotency_mismatch") return "This may already have gone through. Close this and open it again to check before trying again.";
  if (code === "role_not_found") return "That opening isn't there any more. Nothing changed.";
  if (code === "invalid_transition") return "This can't change while someone holds the opening. End their claim first. Nothing changed.";
  return explainRefusal(code, status);
};

function fillOf(role: RoleOpening) {
  if (role.filled !== undefined) return `${role.filled} of ${role.capacity} filled`;
  return role.available ? "Available" : "Not available";
}

type ListProps = {
  base: string;
  room: string;
  /** Null if that read failed. */
  read: RoleRead | null;
  canManage: boolean;
  archived: boolean;
  send: Send;
  label: (id: string) => string;
};

/** Openings come first on Team, vacant ones included. Text in them was written by the room's owner or an admin, and it's data. */
export function RoleOpenings({ base, room, read, canManage, archived, send, label }: ListProps) {
  const roles = read?.roles ?? [];
  return (
    <section aria-labelledby="role-openings" className="space-y-3">
      <div>
        <h2 id="role-openings" className="text-lg font-medium">
          Role openings
        </h2>
        <p className="text-sm text-muted-foreground">A role is a responsibility to fill, not a launched agent. Agents claim an opening themselves once invited, and a claim isn't acceptance of any task.</p>
      </div>
      {read === null ? <ReadFailure /> : null}
      {read !== null && roles.length === 0 ? <p className="text-muted-foreground">{canManage && !archived ? "No openings yet. Add one below." : "No openings yet."}</p> : null}
      {roles.length > 0 ? (
        <ul className="space-y-3">
          {roles.map((role) => {
            const titleId = `role-${role.id}`;
            return (
              <li key={role.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id={titleId} className="min-w-0 break-words font-medium">
                    {plainName(role.title)}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {role.is_lead ? <Badge>Lead coordinator</Badge> : null}
                    <Badge variant="secondary">{PRESET_LABELS[role.preset] ?? role.preset}</Badge>
                    {role.publicly_claimable ? <Badge variant="outline">Claimable publicly</Badge> : null}
                    <span className="text-sm text-muted-foreground">{fillOf(role)}</span>
                  </div>
                </div>
                <AgentContent author={{ name: `Created by ${label(role.created_by)}`, kind: kindOf(role.created_by) }} external={read?.external === true} body={role.responsibilities} />
                {role.mine === "claimed" ? <p className="text-sm">You hold this opening.</p> : null}
                {role.mine === "invited" ? <p className="text-sm">You're invited to this opening.</p> : null}
                {role.holders && role.holders.length > 0 ? (
                  <p className="min-w-0 break-words text-sm">
                    <span className="text-muted-foreground">Held by:</span> {role.holders.map(label).join(", ")}
                  </p>
                ) : null}
                {canManage ? (
                  <Button asChild size="sm" variant="outline" className={MOBILE_TARGET}>
                    <SheetLink param="role" target={role.id} aria-describedby={titleId}>
                      Manage opening
                    </SheetLink>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {canManage && !archived && read !== null ? <AddOpening base={base} room={room} hasLead={roles.some((role) => role.is_lead)} send={send} /> : null}
    </section>
  );
}

function AddOpening({ base, room, hasLead, send }: { base: string; room: string; hasLead: boolean; send: Send }) {
  const early = useEarlyInput();
  const [title, setTitle] = useState("");
  const [responsibilities, setResponsibilities] = useState("");
  const [capacity, setCapacity] = useState("1");
  const [preset, setPreset] = useState("member");
  const [isLead, setIsLead] = useState(false);
  const [claimable, setClaimable] = useState(false);
  const [pending, setPending] = useState(false);
  const openings = Number(capacity);
  const problem = roleFitsLimits(title, responsibilities, isLead ? 1 : openings);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || pending) return;
    setPending(true);
    const body = isLead ? { title: title.trim(), responsibilities: responsibilities.trim(), is_lead: true } : { title: title.trim(), responsibilities: responsibilities.trim(), capacity: openings, preset, ...(claimable && canBePublic(preset, false) ? { publicly_claimable: true } : {}) };
    await send(`${base}/roles`, body, `Opening added to “${room}”. It's empty until an agent you invite claims it.`, {
      focus: true,
      explain: explainRoleRefusal,
      onOk: () => {
        setTitle("");
        setResponsibilities("");
        setCapacity("1");
        setIsLead(false);
        setClaimable(false);
      },
    });
    setPending(false);
  };

  return (
    <form ref={early} onSubmit={add} className="space-y-3 rounded-lg border p-3">
      <h3 className="font-medium">Add an opening</h3>
      <label className="block space-y-1 text-sm">
        <span>Title</span>
        <Input value={title} required onChange={(event) => setTitle(event.target.value)} autoComplete="off" />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Responsibilities</span>
        <textarea className={TEXTAREA} rows={3} required value={responsibilities} onChange={(event) => setResponsibilities(event.target.value)} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 size-4" checked={isLead} disabled={hasLead} onChange={(event) => setIsLead(event.target.checked)} />
        <span>
          This is the lead coordinator
          <span className="block text-muted-foreground">{hasLead ? "This workroom already has a lead opening." : "One opening, with the Coordinator preset. Being lead adds nothing beyond that preset, which can review only when named."}</span>
        </span>
      </label>
      {isLead ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Openings</span>
            <Input type="number" min={1} max={50} value={capacity} onChange={(event) => setCapacity(event.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span>Access preset a claim copies</span>
            <select className={FIELD} value={preset} onChange={(event) => setPreset(event.target.value)}>
              {presetOptions.map((option) => (
                <option key={option} value={option}>
                  {PRESET_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{PRESET_SUMMARIES[isLead ? "coordinator" : preset]}</p>
      <PublicClaimToggle checked={claimable} preset={preset} isLead={isLead} onChange={setClaimable} />
      {problem && (title || responsibilities) ? <p className="text-sm text-status-danger">{problem}</p> : null}
      <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending || problem !== null}>
        {pending ? "Adding…" : "Add opening"}
      </Button>
      <p className="text-sm text-muted-foreground">This doesn't start or wake any agent.</p>
    </form>
  );
}

type Loaded = { role: RoleOpening; members: Member[]; policyVersion: number | null; archived: boolean };

const reachable = (status: number) => status < 500 && status !== 429;

/** Manage one opening. The target comes from the URL and each read goes back to the room, which refuses anything it no longer allows. */
export function RoleSheet({ roomId, roomName, label }: { roomId: string; roomName: string; label: (id: string) => string }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}`;
  return (
    <TargetSheet<Loaded>
      param="role"
      size="md"
      noun="role opening"
      load={async (target, { signal }) => {
        // In this order, on purpose. A draft answers to the room's version, so that must never be newer than the opening shown
        // beside it, or someone else's edit in between could be overwritten. The worst this way is a conflict nobody caused.
        const room = await clientQuery<Workroom>(base, { signal });
        const roles = await clientQuery<RoleRead>(`${base}/roles`, { signal });
        if (!room.ok || !roles.ok) {
          const failed = !room.ok ? room : roles;
          if (!failed.ok && !reachable(failed.status)) throw new Error(failed.code);
          return null;
        }
        const role = roles.data.roles.find((row) => row.id === target);
        const policyVersion = room.data.policy_version ?? null;
        if (!role || policyVersion === null) return null;
        return { role, members: membersOf(room.data), policyVersion, archived: room.data.status === "archived" };
      }}
      title={({ role }) => plainName(role.title)}
      description={() => `Workroom: ${plainName(roomName)}`}
      version={({ policyVersion }) => policyVersion}
    >
      {(api) => <RoleWithStatus key={api.data.role.id} api={api} base={base} label={label} />}
    </TargetSheet>
  );
}

/** The result outlives the form below it, which starts again once a save changes the opening. */
function RoleWithStatus({ api, base, label }: { api: SheetApi<Loaded>; base: string; label: (id: string) => string }) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [done, setDone] = useState("");
  return (
    <div className="space-y-5">
      {/* Focus lands here when a result removes the control that asked. */}
      <p ref={statusRef} tabIndex={-1} role="status" className="rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {done || (api.data.archived ? "This workroom is archived, so its openings can't change." : "")}
      </p>
      <RoleBody key={api.data.role.version} api={api} base={base} label={label} setDone={setDone} statusRef={statusRef} />
    </div>
  );
}

function RoleBody({ api, base, label, setDone, statusRef }: { api: SheetApi<Loaded>; base: string; label: (id: string) => string; setDone: (text: string) => void; statusRef: RefObject<HTMLParagraphElement | null> }) {
  const { data, run, saving, dirty, setDirty, close } = api;
  const { role, members, archived } = data;
  const [title, setTitle] = useState(role.title);
  const [responsibilities, setResponsibilities] = useState(role.responsibilities);
  const [capacity, setCapacity] = useState(String(role.capacity));
  const [preset, setPreset] = useState(role.preset);
  const [isLead, setIsLead] = useState(role.is_lead);
  const [claimable, setClaimable] = useState(role.publicly_claimable === true);
  // What would be saved: the switch only holds where it can apply.
  const claimableNow = claimable && canBePublic(preset, isLead);
  const claimableChanged = claimableNow !== (role.publicly_claimable === true);
  const [invitee, setInvitee] = useState("");
  // One key per intent, so sending the same thing again after an unknown outcome gets the stored answer.
  const keys = useRef(new Map<string, string>());
  const keyFor = (intent: string) => {
    const known = keys.current.get(intent);
    if (known) return known;
    const fresh = crypto.randomUUID();
    keys.current.set(intent, fresh);
    return fresh;
  };
  /** Runs one command, says what it did, and retires its key once it's known to have worked. */
  const act = async (intent: string, send: (key: string, version: number | null) => ReturnType<typeof clientCommand>, success: string) => {
    setDone("");
    const key = keyFor(intent);
    const result = await run(({ version }) => send(key, version), explainRoleRefusal);
    // Past a re-read, an unknown attempt that landed answers this: the version in the body has moved, so it's no longer the
    // same request. Explaining says to check, and the key has done its job either way.
    if (result?.ok || (result && !result.ok && result.code === "idempotency_mismatch")) keys.current.delete(intent);
    if (result?.ok) setDone(success);
    return result;
  };
  const path = `${base}/roles/${encodeURIComponent(role.id)}`;
  const holders = role.holders ?? [];
  const invited = role.invited ?? [];
  const candidates = members.filter((member) => member.kind === "agent" && !holders.includes(member.principal_id) && !invited.includes(member.principal_id));
  const problem = roleFitsLimits(title, responsibilities, isLead ? 1 : Number(capacity));
  const termsChanged = preset !== role.preset || isLead !== role.is_lead;
  const edit = (apply: () => void) => {
    apply();
    keys.current.delete("save");
  };
  // Worked out from the form, because any command's success clears the Sheet's flag, and an invite doesn't save what's typed.
  const edited = title !== role.title || responsibilities !== role.responsibilities || isLead !== role.is_lead || claimableChanged || (!isLead && (capacity !== String(role.capacity) || preset !== role.preset));
  useEffect(() => {
    if (dirty !== edited) setDirty(edited);
  }, [dirty, edited, setDirty]);

  const save = () =>
    act(
      "save",
      (idempotencyKey, version) => clientCommand(path, { policy_version: version, title: title.trim(), responsibilities: responsibilities.trim(), ...(isLead === role.is_lead ? {} : { is_lead: isLead }), ...(isLead ? {} : { capacity: Number(capacity), preset }), ...(claimableChanged ? { publicly_claimable: claimableNow } : {}) }, { method: "PUT", idempotencyKey }),
      "Saved. Everyone in this workroom sees the opening's new details.",
    );
  const invite = async () => {
    const result = await act(`invite:${invitee}`, (idempotencyKey, version) => clientCommand(`${path}/invites`, { policy_version: version, principal_id: invitee }, { idempotencyKey }), `Invited ${label(invitee)}. It claims the opening itself.`);
    if (result?.ok) setInvitee("");
  };

  return (
    <>
      <section aria-labelledby="role-holders" className="space-y-2">
        <h3 id="role-holders" className="font-medium">
          Holders
        </h3>
        {holders.length === 0 ? <p className="text-sm text-muted-foreground">Nobody holds this yet.</p> : null}
        <ul className="space-y-2">
          {holders.map((holder) => (
            <li key={holder} className="flex flex-wrap items-center justify-between gap-2">
              <AuthorLine author={{ name: label(holder), kind: kindOf(holder) }} />
              {archived ? null : (
                <ConfirmAction
                  label="End claim"
                  variant="ghost"
                  destructive
                  disabled={saving}
                  title={<>End “{label(holder)}”'s claim on this opening?</>}
                  description={
                    role.is_lead
                      ? "Its access goes back to what it had, unless someone changed it meanwhile, and then it keeps the narrower. Its other invites end. Its open tasks don't move: to hand those on, change each task's requester, which is recorded. To replace this lead, name the next agent below once this is done, and that agent claims it."
                      : "Its access goes back to what it had, unless someone changed it meanwhile, and then it keeps the narrower. Its other invites end. Its open tasks don't move."
                  }
                  confirm="End claim"
                  focusAfter={statusRef}
                  action={async () => {
                    await act(`end:${holder}`, (idempotencyKey, version) => clientCommand(`${path}/claims/${encodeURIComponent(holder)}`, { policy_version: version }, { method: "DELETE", idempotencyKey }), `Claim ended for ${label(holder)}. Its open tasks haven't moved.`);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      {archived ? null : (
        <section aria-labelledby="role-invites" className="space-y-2">
          <h3 id="role-invites" className="font-medium">
            Invited
          </h3>
          <p className="text-sm text-muted-foreground">An invited agent claims the opening itself, and nobody can claim for it. An invite grants nothing until then.</p>
          {invited.length === 0 ? <p className="text-sm text-muted-foreground">Nobody's invited.</p> : null}
          <ul className="space-y-2">
            {invited.map((agent) => (
              <li key={agent} className="flex flex-wrap items-center justify-between gap-2">
                <AuthorLine author={{ name: label(agent), kind: kindOf(agent) }} />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={MOBILE_TARGET}
                  disabled={saving}
                  aria-label={`Withdraw invite to ${label(agent)}`}
                  onClick={() => void act(`withdraw:${agent}`, (idempotencyKey, version) => clientCommand(`${path}/invites/${encodeURIComponent(agent)}`, { policy_version: version }, { method: "DELETE", idempotencyKey }), `Invite to ${label(agent)} withdrawn.`)}
                >
                  Withdraw
                </Button>
              </li>
            ))}
          </ul>
          {candidates.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
                <span>Invite an agent in this workroom</span>
                <select className={FIELD} value={invitee} disabled={saving} onChange={(event) => setInvitee(event.target.value)}>
                  <option value="">Choose an agent</option>
                  {candidates.map((member) => (
                    <option key={member.principal_id} value={member.principal_id}>
                      {label(member.principal_id)}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="button" size="sm" className={MOBILE_TARGET} disabled={saving || !invitee} onClick={() => void invite()}>
                Invite
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No other agents in this workroom to invite. Bring one in below, or use an invitation link that names this opening.</p>
          )}
        </section>
      )}

      {archived ? null : (
        <section aria-labelledby="role-details" className="space-y-3">
          <h3 id="role-details" className="font-medium">
            Details
          </h3>
          <fieldset disabled={saving} className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span>Title</span>
              <Input value={title} onChange={(event) => edit(() => setTitle(event.target.value))} autoComplete="off" />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Responsibilities</span>
              <textarea className={TEXTAREA} rows={4} value={responsibilities} onChange={(event) => edit(() => setResponsibilities(event.target.value))} />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 size-4" checked={isLead} disabled={holders.length > 0} onChange={(event) => edit(() => setIsLead(event.target.checked))} />
              <span>
                This is the lead coordinator
                <span className="block text-muted-foreground">{holders.length > 0 ? "This can change only while nobody holds the opening." : "One opening, with the Coordinator preset. A workroom has one lead."}</span>
              </span>
            </label>
            {isLead ? null : (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span>Openings</span>
                  <Input type="number" min={1} max={50} value={capacity} onChange={(event) => edit(() => setCapacity(event.target.value))} />
                </label>
                <label className="space-y-1 text-sm">
                  <span>Access preset a claim copies</span>
                  <select className={FIELD} value={preset} onChange={(event) => edit(() => setPreset(event.target.value))}>
                    {presetOptions.map((option) => (
                      <option key={option} value={option}>
                        {PRESET_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <PublicClaimToggle checked={claimable} preset={preset} isLead={isLead} onChange={(next) => edit(() => setClaimable(next))} />
            {Number(capacity) < holders.length ? <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">Lowering this removes nobody. It only stops further claims.</p> : null}
            {termsChanged ? (
              <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">
                Changing the preset or lead mark withdraws invites to this opening and takes it off pending invitation links. {holders.length > 0 ? "Holders keep the access they copied." : ""}
              </p>
            ) : null}
            {problem && edited ? <p className="text-sm text-status-danger">{problem}</p> : null}
          </fieldset>
        </section>
      )}

      <footer className="space-y-3 border-t pt-4">
        <div className="flex flex-wrap justify-end gap-2">
          {archived ? null : (
            <ConfirmAction
              label="Close opening"
              variant="ghost"
              destructive
              disabled={saving || holders.length > 0}
              title={<>Close “{plainName(role.title)}”?</>}
              description="It disappears from this workroom, and its invites and any invitation links' mention of it end."
              confirm="Close opening"
              focusAfter={statusRef}
              action={async () => {
                const result = await act("close", (idempotencyKey, version) => clientCommand(path, { policy_version: version }, { method: "DELETE", idempotencyKey }), "Opening closed.");
                if (result?.ok) close();
              }}
            />
          )}
          <Button type="button" variant="outline" className={MOBILE_TARGET} disabled={saving} onClick={close}>
            Cancel
          </Button>
          {archived ? null : (
            <Button type="button" className={MOBILE_TARGET} disabled={!dirty || saving || problem !== null} onClick={() => void save()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>
        {holders.length > 0 && !archived ? <p className="text-sm text-muted-foreground">An opening can be closed once nobody holds it.</p> : null}
      </footer>
    </>
  );
}
