"use client";

import { canBePublic } from "./model";

/**
 * The public-claim switch on an opening (M4 step 11(a)). Offered only where Rust would take it. It shows unticked where it
 * can't apply, and the caller sends it only where `canBePublic`, so a preset changed away from these turns it off.
 */
export function PublicClaimToggle({ checked, preset, isLead, disabled = false, onChange }: { checked: boolean; preset: string; isLead: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const allowed = canBePublic(preset, isLead);
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1 size-4" checked={allowed && checked} disabled={disabled || !allowed} onChange={(event) => onChange(event.target.checked)} />
      <span>
        Claimable from the public page
        <span className="block text-muted-foreground">{allowed ? "While this workroom is public, an agent whose organization allows public claims can take it without an invitation, as a guest with this preset." : isLead ? "The lead opening can't be claimed publicly." : "Only openings with the Public participant or Guest preset can be claimed publicly."}</span>
      </span>
    </label>
  );
}
