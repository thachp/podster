"use client";

import Link from "next/link";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { ApprovalFields, approvalFailure, firstChoice, RequesterName, type ApprovalAgent, type ApprovalOrg } from "../approval-fields";

export type ClaimChoices = { agent_id: string; agent_name: string | null; code: string; orgs: ApprovalOrg[]; agents: ApprovalAgent[] };

/** Who is asking, which organization and what it means. Nothing submits on Enter or takes focus, so confirming is deliberate. */
export function ClaimForm({ choices }: { choices: ClaimChoices }) {
  const early = useEarlyInput();
  const [choice, setChoice] = useState(() => firstChoice(choices.orgs));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ connected: string } | "declined" | null>(null);

  async function confirm() {
    setBusy(true);
    setFailure(null);
    const result = await clientCommand<{ agent_id: string }>("/api/claim", { agent_id: choices.agent_id, user_code: choices.code, org_id: choice.org, name: choice.name, link_agent_id: choice.linkAgent }).catch(() => null);
    setBusy(false);
    if (result?.ok) setOutcome({ connected: result.data.agent_id });
    else setFailure(result ? approvalFailure(result.status, result.code) : approvalFailure(500, "error"));
  }

  /** Only clears the link's cookie, which the page can't reach itself. Nothing was connected whether or not it gets there. */
  async function decline() {
    setBusy(true);
    await clientCommand("/api/claim", { decision: "decline" }).catch(() => null);
    setBusy(false);
    setOutcome("declined");
  }

  if (outcome === "declined") return <p role="status">Nothing was connected. You can close this page, and the agent's request expires by itself.</p>;
  if (outcome)
    return (
      <div role="status" className="space-y-2">
        <p>
          Your agent is connected as <strong className="break-all">{outcome.connected}</strong>. Workroom access is set separately.
        </p>
        <Link className="underline" href="/agents" prefetch={false}>
          Go to Agents
        </Link>
      </div>
    );
  return (
    <form ref={early} className="space-y-4" onSubmit={(event) => event.preventDefault()}>
      <p>
        {choices.agent_name ? (
          <>
            An agent calling itself <RequesterName name={choices.agent_name} chosenBy="this agent" />
          </>
        ) : (
          "An agent"
        )}{" "}
        is asking to join your organization. Podster hasn't verified this name.
      </p>
      <p>
        Only continue if you started this, and your agent showed you this code: <strong className="break-all">{choices.code}</strong>
      </p>
      <p>Confirming makes your organization its owner. It doesn't run or wake the agent, and workroom access is set separately.</p>
      <ApprovalFields orgs={choices.orgs} agents={choices.agents} value={choice} onChange={setChoice} disabled={busy} newAgentLabel="A new agent" />
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy || !choice.org} onClick={confirm}>
          Confirm ownership
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={decline}>
          Not now
        </Button>
      </div>
    </form>
  );
}
