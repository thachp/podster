"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { clientCommand } from "@/lib/gateway/client";
import type { GatewayResult } from "@/lib/gateway/result";
import type { ParticipationPolicy } from "./model";

const outage = (result: GatewayResult<unknown>) => !result.ok && (result.status >= 500 || result.status === 429);

export const POLICY_LABELS: Record<ParticipationPolicy, string> = {
  invitations_only: "Invitations only",
  public_claims: "Invitations and public claims",
};

const REFUSALS: Record<string, string> = {
  agent_disconnected: "This agent is disconnected, so its policy can't change. Nothing changed.",
  not_allowed: "Only an admin of this agent's organization can change this. Nothing changed.",
  agent_not_found: "Only an admin of this agent's organization can change this. Nothing changed.",
};

/**
 * Whether this agent may claim openings in public workrooms without an invitation (M4 step 11(a), decision 159). Only its
 * organization's admins can set it, and Rust checks that against their memberships now. Invitations work either way, and
 * tightening it ends no claim already made.
 */
export function ParticipationPolicySection({ policy, active, saving, run, onUnconfirmed }: { policy: ParticipationPolicy | undefined; active: boolean; saving: boolean; run: SheetApi<unknown>["run"]; onUnconfirmed: () => void }) {
  const ids = { heading: useId(), problem: useId() };
  const current: ParticipationPolicy = policy ?? "invitations_only";
  const [draft, setDraft] = useState<ParticipationPolicy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const value = draft ?? current;
  const changed = value !== current;
  // A reload that shows the saved value ends the draft.
  useEffect(() => setDraft(null), [current]);

  async function save() {
    if (!changed || saving) return;
    setProblem(null);
    setSaved(null);
    let answered: GatewayResult<unknown> | null = null;
    await run(async ({ target }) => {
      const result = await clientCommand<unknown>(`/api/agents/${encodeURIComponent(target)}/participation-policy`, { policy: value }, { method: "PUT" }).catch(() => null);
      if (result === null || outage(result)) {
        onUnconfirmed();
        return { ok: true as const, data: null };
      }
      answered = result;
      return { ok: true as const, data: null };
    });
    const result = answered as GatewayResult<unknown> | null;
    if (!result) return;
    if (result.ok) {
      setSaved(value === "public_claims" ? "Saved. It can claim openings in public workrooms now." : "Saved. It joins only by invitation now. Claims it already made stay.");
      setDraft(null);
    } else setProblem(REFUSALS[result.code] ?? "That didn't save, and nothing changed.");
  }

  return (
    <section aria-labelledby={ids.heading} className="space-y-2">
      <h3 id={ids.heading} className="font-medium">
        Participation policy
      </h3>
      <p className="text-sm text-muted-foreground">Whether it may join public workrooms by claiming an opening there, without an invitation. Invitations, and owners adding it, work either way.</p>
      <fieldset className="space-y-2" disabled={!active || saving}>
        <legend className="sr-only">Participation policy</legend>
        {(["invitations_only", "public_claims"] as const).map((option) => (
          <label key={option} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${ids.heading}-policy`}
              className="mt-1 size-4"
              value={option}
              checked={value === option}
              aria-describedby={`${ids.heading}-${option}`}
              onChange={() => {
                setProblem(null);
                setSaved(null);
                setDraft(option);
              }}
            />
            <span>
              {option === current ? `${POLICY_LABELS[option]} (current)` : POLICY_LABELS[option]}
              <span id={`${ids.heading}-${option}`} className="block text-muted-foreground">{option === "invitations_only" ? "It joins a workroom only when invited or added." : "It can also claim openings marked claimable in public workrooms, as a guest. Each workroom's owner can still remove or block it."}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {changed && value === "invitations_only" ? <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">Public claims it already holds stay. Withdraw it from those workrooms to end them.</p> : null}
      {!active ? <p className="text-sm text-muted-foreground">It goes back to invitations only while disconnected.</p> : null}
      {problem ? (
        <p id={ids.problem} role="alert" className="text-sm text-status-danger">
          {problem}
        </p>
      ) : null}
      {saved ? <p role="status" className="text-sm">{saved}</p> : null}
      {active ? (
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving || !changed} onClick={() => void save()}>
          Save policy
        </Button>
      ) : null}
    </section>
  );
}
