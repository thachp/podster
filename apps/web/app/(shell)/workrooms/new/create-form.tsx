"use client";

import { useRouter } from "next/navigation";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { TEXTAREA } from "../../w/[id]/settings/brief-controls";
import { FIELD, MOBILE_TARGET } from "../../w/[id]/team/field";
import { canBePublic, PRESET_LABELS, presetOptions, roleFitsLimits } from "../../w/[id]/team/model";
import { PublicClaimToggle } from "../../w/[id]/team/public-claim-toggle";

const MAX_NAME_BYTES = 200;
const MAX_GOAL_BYTES = 2048;
const MAX_CONTEXT_BYTES = 32768;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const UNKNOWN_OUTCOME = "We can't tell whether a workroom was created. Check My workrooms before trying again.";

/** A server error can come after the room was committed, and creating isn't idempotent, so only a refusal means nothing happened. */
export function createProblem(status: number, code: string) {
  if (status === 429) return "Too many requests. Wait a minute and try again.";
  if (status >= 500) return UNKNOWN_OUTCOME;
  if (code === "invalid_argument") return "Check the name, goal and context, and try again.";
  if (code === "limit_exceeded") return "This organization has reached its limit of 20 workrooms, so no workroom was created. Archived workrooms count toward it.";
  return status === 403 ? "That didn't work, and no workroom was created. Only an organization's admins can create its workrooms." : "That didn't work, and no workroom was created.";
}

type RoleDraft = { key: number; title: string; responsibilities: string; capacity: string; preset: string; isLead: boolean; claimable: boolean };

const emptyRole = (key: number): RoleDraft => ({ key, title: "", responsibilities: "", capacity: "1", preset: "member", isLead: false, claimable: false });

/** The switch only holds where Rust would take it. */
export const sendsClaimable = (role: Pick<RoleDraft, "claimable" | "preset" | "isLead">) => role.claimable && canBePublic(role.preset, role.isLead);

/**
 * Where a new room goes. Nothing is public at creation: a room that should be goes to Settings, where its owner sees exactly
 * what the API would publish and confirms it there (decision 146).
 */
export const landingFor = (room: string, visibility: "private" | "public") => (visibility === "public" ? `/w/${room}/settings#settings-visibility` : `/w/${room}/overview`);

/** Each opening costs two requests, and a person has 120 a minute across everything. More than this can wait for Team. */
const MAX_OPENINGS = 20;

type Added = "added" | "refused" | "unknown";
/** What one attempt says, before what's known already. Too many requests means stop and wait. */
type Attempt = Added | "limited";

/**
 * Rooms are made first and openings one at a time after, because each needs the room. Each has its own key, so a retry can't
 * add it twice. A retry that lands on one already added is told the request differs, because the room's version has moved,
 * which says it went through.
 */
async function addOpening(base: string, role: RoleDraft, key: string): Promise<Attempt> {
  try {
    const read = await clientQuery<{ policy_version: number | null }>(base);
    if (!read.ok) return read.status === 429 ? "limited" : read.status >= 500 ? "unknown" : "refused";
    const shape = role.isLead ? { is_lead: true } : { capacity: Number(role.capacity), preset: role.preset, ...(sendsClaimable(role) ? { publicly_claimable: true } : {}) };
    const result = await clientCommand(`${base}/roles`, { policy_version: read.data.policy_version, title: role.title.trim(), responsibilities: role.responsibilities.trim(), ...shape }, { idempotencyKey: key });
    if (result.ok || result.code === "idempotency_mismatch") return "added";
    return result.status === 429 ? "limited" : result.status >= 500 ? "unknown" : "refused";
  } catch {
    return "unknown";
  }
}

export function CreateWorkroomForm({ organization, personal = false }: { organization: string | null; personal?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const nextRole = useRef(0);
  // A room that exists, with what's known of each opening. Sending the form again would make a second room.
  const [madeRoom, setMadeRoom] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, Added>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const keys = useRef(new Map<number, string>());
  const noticeRef = useRef<HTMLDivElement>(null);
  const early = useEarlyInput();
  const addRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const created = useRef(false);
  const trimmed = name.trim();
  const trimmedGoal = goal.trim();
  const trimmedContext = context.trim();
  const tooLong = byteLength(trimmed) > MAX_NAME_BYTES;
  const goalTooLong = byteLength(trimmedGoal) > MAX_GOAL_BYTES;
  const contextTooLong = byteLength(trimmedContext) > MAX_CONTEXT_BYTES;
  const unfinished = roles.filter((role) => results[role.key] !== "added");
  const notConfirmed = unfinished.filter((role) => results[role.key] === "unknown");
  const refused = unfinished.filter((role) => results[role.key] === "refused");
  const notTried = unfinished.filter((role) => results[role.key] === undefined);
  // Nothing changes while it's being sent, and what's sent can't change once the room exists.
  const locked = pending || madeRoom !== null;
  const roleProblems = roles.map((role) => roleFitsLimits(role.title, role.responsibilities, role.isLead ? 1 : Number(role.capacity)));
  const hasLead = roles.some((role) => role.isLead);
  const blocked = !trimmed || tooLong || goalTooLong || contextTooLong || roleProblems.some((problem) => problem !== null);
  const editRole = (key: number, change: Partial<RoleDraft>) => !locked && setRoles((all) => all.map((role) => (role.key === key ? { ...role, ...change } : role)));

  // The new screen replaces this form and takes the focused control with it, which would leave focus on the page body and a
  // screen reader saying nothing. The shell's main region outlives the form. If someone has already moved on, focus stays with them.
  useEffect(
    () => () => {
      if (created.current && (!document.activeElement || document.activeElement === document.body)) document.getElementById("main-content")?.focus();
    },
    [],
  );

  /** Adds whatever isn't known to be added, one at a time, and goes to the room once all of them are. */
  const addOpenings = async (room: string) => {
    const base = `/api/v1/workspaces/${encodeURIComponent(room)}`;
    const known = { ...results };
    const waiting = roles.filter((role) => known[role.key] !== "added" && known[role.key] !== "refused");
    let done = 0;
    setLimited(false);
    for (const role of waiting) {
      done += 1;
      setProgress(`Adding opening ${done} of ${waiting.length}…`);
      const key = keys.current.get(role.key) ?? crypto.randomUUID();
      keys.current.set(role.key, key);
      const attempt = await addOpening(base, role, key);
      if (attempt === "limited") {
        // Sending more would only spend what's left. What's unknown stays so, and what wasn't tried says that.
        setLimited(true);
        break;
      }
      // Authority comes before a stored answer, so a refusal says nothing about an attempt that may already have gone through.
      known[role.key] = known[role.key] === "unknown" && attempt === "refused" ? "unknown" : attempt;
      setResults({ ...known });
    }
    setProgress(null);
    if (roles.every((role) => known[role.key] === "added")) {
      created.current = true;
      router.push(landingFor(room, visibility));
      return;
    }
    setMadeRoom(room);
    setPending(false);
    sending.current = false;
    // The button that asked has just been disabled, which would drop focus and leave a screen reader saying nothing.
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

  const removeOpening = (key: number) => {
    if (locked) return;
    setRoles((all) => all.filter((other) => other.key !== key));
    // The button that asked has gone, so focus goes to where another can be added.
    requestAnimationFrame(() => addRef.current?.focus());
  };

  const retry = async () => {
    if (!madeRoom || sending.current) return;
    sending.current = true;
    setPending(true);
    await addOpenings(madeRoom);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    // Creating isn't idempotent in the API yet, so a second click must not send a second request.
    if (sending.current || blocked || madeRoom) return;
    sending.current = true;
    setPending(true);
    setProblem(null);
    try {
      const result = await clientCommand<{ id: string }>("/api/v1/workspaces", { name: trimmed, ...(trimmedGoal ? { goal: trimmedGoal } : {}), ...(trimmedContext ? { context: trimmedContext } : {}) });
      if (result.ok) {
        await addOpenings(result.data.id);
        return;
      }
      setProblem(createProblem(result.status, result.code));
    } catch {
      setProblem(UNKNOWN_OUTCOME);
    }
    sending.current = false;
    setPending(false);
  };

  return (
    <form ref={early} onSubmit={create} className="space-y-4">
      <label className="block space-y-1">
        <span className="font-medium">Name</span>
        <Input value={name} required autoFocus readOnly={locked} aria-invalid={tooLong} aria-describedby="workroom-name-help" onChange={(event) => setName(event.target.value)} />
      </label>
      <p id="workroom-name-help" className="text-sm text-muted-foreground">
        {tooLong ? "That's too long. Names can be up to 200 bytes." : "People and agents in this workroom will see it."}
      </p>
      <label className="block space-y-1">
        <span className="font-medium">Goal (optional)</span>
        <textarea className={TEXTAREA} rows={2} value={goal} readOnly={locked} aria-invalid={goalTooLong} aria-describedby="workroom-goal-help" onChange={(event) => setGoal(event.target.value)} />
      </label>
      <p id="workroom-goal-help" className="text-sm text-muted-foreground">
        {goalTooLong ? "That's too long. A goal can be up to 2,048 bytes." : "What this workroom is for."}
      </p>
      <label className="block space-y-1">
        <span className="font-medium">Context (optional)</span>
        <textarea className={TEXTAREA} rows={5} value={context} readOnly={locked} aria-invalid={contextTooLong} aria-describedby="workroom-context-help" onChange={(event) => setContext(event.target.value)} />
      </label>
      <p id="workroom-context-help" className="text-sm text-muted-foreground">
        {contextTooLong ? "That's too long. Context can be up to 32,768 bytes." : "Anything participants should know. Everyone in this workroom can read it, and it gives no one any permission."}
      </p>
      <fieldset className="space-y-3" disabled={madeRoom !== null}>
        <legend className="font-medium">Role openings (optional)</legend>
        <p className="text-sm text-muted-foreground">A role is a responsibility to fill, not an agent. You can add these later on Team.</p>
        {roles.map((role, index) => {
          const number = index + 1;
          return (
            <div key={role.key} role="group" aria-label={`Opening ${number}`} className="space-y-3 rounded-lg border p-3">
              <label className="block space-y-1 text-sm">
                <span>Title</span>
                <Input value={role.title} readOnly={locked} onChange={(event) => editRole(role.key, { title: event.target.value })} autoComplete="off" />
              </label>
              <label className="block space-y-1 text-sm">
                <span>Responsibilities</span>
                <textarea className={TEXTAREA} rows={2} value={role.responsibilities} readOnly={locked} onChange={(event) => editRole(role.key, { responsibilities: event.target.value })} />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 size-4" checked={role.isLead} disabled={hasLead && !role.isLead} aria-disabled={locked || undefined} onChange={(event) => editRole(role.key, { isLead: event.target.checked })} />
                <span>
                  Lead coordinator
                  <span className="block text-muted-foreground">One opening, with the Coordinator preset. Being lead adds nothing beyond that preset, which can review only when named.</span>
                </span>
              </label>
              {role.isLead ? null : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span>Openings</span>
                    <Input type="number" min={1} max={50} value={role.capacity} readOnly={locked} onChange={(event) => editRole(role.key, { capacity: event.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>Access preset a claim copies</span>
                    <select className={FIELD} value={role.preset} aria-disabled={locked || undefined} onChange={(event) => editRole(role.key, { preset: event.target.value })}>
                      {presetOptions.map((option) => (
                        <option key={option} value={option}>
                          {PRESET_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <PublicClaimToggle checked={role.claimable} preset={role.isLead ? "coordinator" : role.preset} isLead={role.isLead} disabled={locked} onChange={(claimable) => editRole(role.key, { claimable })} />
              {roleProblems[index] ? <p className="text-sm text-status-danger">{roleProblems[index]}</p> : null}
              <Button type="button" size="sm" variant="ghost" className={MOBILE_TARGET} aria-label={`Remove opening ${number}`} aria-disabled={locked || undefined} onClick={() => removeOpening(role.key)}>
                Remove
              </Button>
            </div>
          );
        })}
        {roles.length >= MAX_OPENINGS ? <p className="text-sm text-muted-foreground">You can add {MAX_OPENINGS} here, and more on Team once the workroom exists.</p> : null}
        <Button ref={addRef} type="button" size="sm" variant="outline" className={`${MOBILE_TARGET} aria-disabled:pointer-events-none aria-disabled:opacity-50`} aria-disabled={roles.length >= MAX_OPENINGS || locked || undefined} onClick={() => {
            // Marked, not really disabled: that would drop focus when the last one it can add goes in.
            if (roles.length < MAX_OPENINGS && !locked) setRoles((all) => [...all, emptyRole((nextRole.current += 1))]);
          }}>
          Add an opening
        </Button>
      </fieldset>
      <fieldset className="space-y-2" disabled={madeRoom !== null}>
        <legend className="font-medium">Visibility</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="visibility" className="mt-1 size-4" value="private" checked={visibility === "private"} onChange={() => !locked && setVisibility("private")} />
          <span>
            Private
            <span className="block text-muted-foreground">Only people and agents added or invited here can open it.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="visibility" className="mt-1 size-4" value="public" checked={visibility === "public"} onChange={() => !locked && setVisibility("public")} />
          <span>
            Public, once you confirm
            <span className="block text-muted-foreground">Its name, goal, context, openings, expected outputs and participant count become readable by anyone. Who's here, tasks, messages and files never do.</span>
          </span>
        </label>
        {visibility === "public" ? (
          <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">
            This creates the workroom private. Settings then shows exactly what would be public, and nothing is public until you confirm it there. A public workroom needs a person to review, which you turn on there too.
          </p>
        ) : null}
      </fieldset>
      <p className="text-sm text-muted-foreground">{organization ? <>Owned by {plainName(organization)}. You can switch organization from your profile menu. You'll be its owner.</> : "Owned by your current organization. You'll be its owner."}</p>
      {personal ? <p className="text-sm text-muted-foreground">This is your personal organization, so nobody can take this workroom over if you can't get back into your account. Use a team organization if it may need a successor.</p> : null}
      <div ref={noticeRef} tabIndex={-1} className="space-y-2 outline-none">
        {madeRoom ? (
          <div role="alert" className="space-y-2 rounded-lg bg-status-amber-surface p-3 text-status-amber">
            <p>
              Your workroom was created, and {roles.length - unfinished.length} of {roles.length} openings are confirmed. Don't create it again.
            </p>
            {notConfirmed.length > 0 ? <p>We can't tell whether these were added, so check Team before adding them yourself: {notConfirmed.map((role) => plainName(role.title)).join(", ")}.</p> : null}
            {limited ? <p>There have been too many requests for now, so wait a minute before trying again.</p> : null}
            {notTried.length > 0 ? <p>These haven't been tried yet: {notTried.map((role) => plainName(role.title)).join(", ")}.</p> : null}
            {refused.length > 0 ? <p>These weren't added: {refused.map((role) => plainName(role.title)).join(", ")}. You can add them on Team.</p> : null}
            <div className="flex flex-wrap items-center gap-3">
              {notConfirmed.length + notTried.length > 0 ? (
                <Button type="button" size="sm" variant="outline" className={`text-foreground ${MOBILE_TARGET}`} aria-disabled={pending || undefined} onClick={() => void retry()}>
                  {pending ? "Trying…" : "Try those again"}
                </Button>
              ) : null}
              <a href={`/w/${madeRoom}/team`} className="underline">
                Go to Team
              </a>
              {visibility === "public" ? (
                <a href={landingFor(madeRoom, "public")} className="underline">
                  Make it public in Settings
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
        {progress ? <p role="status" className="text-sm text-muted-foreground">{progress}</p> : null}
      </div>
      {problem ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {problem}
        </p>
      ) : null}
      {/* While sending this is only marked disabled: really disabling it would drop focus to the body, and a refusal needs focus to still be here. `sending` stops a second request. */}
      <Button type="submit" className={`${MOBILE_TARGET} aria-disabled:pointer-events-none aria-disabled:opacity-50`} disabled={blocked || madeRoom !== null} aria-disabled={pending || undefined}>
        {pending && !madeRoom ? "Creating…" : "Create workroom"}
      </Button>
      {!madeRoom && roleProblems.some((rp) => rp !== null) ? <p className="text-sm text-muted-foreground">Finish or remove each opening above to create this workroom.</p> : null}
      {madeRoom ? <p className="text-sm text-muted-foreground">This workroom exists now. Change its name, goal and context in its Settings.</p> : null}
      <p className="text-sm text-muted-foreground">Agents connect later; this doesn't launch agents.</p>
    </form>
  );
}
