"use client";

import { useState } from "react";
import { useEarlyInput } from "@/hooks/use-early-input";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { ApprovalFields, approvalFailure, firstChoice, RequesterName, type ApprovalAgent, type ApprovalOrg } from "../../approval-fields";

/** `protocol` says which of the gateway's resources the app asks for. A gateway that doesn't send it is asking for MCP. */
export type ConsentChoices = { client_name: string; redirect_hosts: string[]; oauth_query: string; protocol?: "mcp" | "a2a"; orgs: ApprovalOrg[]; agents: ApprovalAgent[] };

/**
 * Who is asking, which organization and what will be granted. Nothing here submits on Enter or takes focus, so approving
 * is always a deliberate press of the button. The gateway answers with where to send the browser, which is the client's
 * registered address: a fetch can't follow a redirect there, and the page's CSP wouldn't let a form.
 */
export function ConsentForm({ choices, leave = (url: string) => location.assign(url) }: { choices: ConsentChoices; leave?: (url: string) => void }) {
  const early = useEarlyInput();
  const [choice, setChoice] = useState(() => firstChoice(choices.orgs));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function decide(body: object) {
    setBusy(true);
    setFailure(null);
    const result = await clientCommand<{ redirect_to: string }>("/api/consent", { oauth_query: choices.oauth_query, ...body }).catch(() => null);
    // Stays busy on the way out, so a second press can't send a second decision.
    if (result?.ok) return leave(result.data.redirect_to);
    setBusy(false);
    setFailure(result ? approvalFailure(result.status, result.code) : approvalFailure(500, "error"));
  }

  return (
    <form ref={early} className="space-y-4" onSubmit={(event) => event.preventDefault()}>
      <p>
        An app calling itself <RequesterName name={choices.client_name} chosenBy="this app" /> wants to act as an agent in your organization. Podster hasn't verified this name.
      </p>
      <p>
        After you approve, it receives access at <strong className="break-all">{choices.redirect_hosts.join(", ")}</strong>. Only continue if you started this and trust that site.
      </p>
      <p>
        {choices.protocol === "a2a" ? "It will act as the agent over A2A, through Podster's A2A interface," : "It can use the agent's tools"} in any workroom that agent has joined. Connecting doesn't run or wake an agent, and workroom access is set separately.
      </p>
      <ApprovalFields orgs={choices.orgs} agents={choices.agents} value={choice} onChange={setChoice} disabled={busy} newAgentLabel="A new agent, or its existing one" />
      <p className="text-muted-foreground">If this app is already connected to the organization, it keeps its agent and name.</p>
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy || !choice.org} onClick={() => decide({ decision: "approve", org_id: choice.org, link_agent_id: choice.linkAgent, agent_name: choice.name })}>
          Connect
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => decide({ decision: "decline" })}>
          Decline
        </Button>
      </div>
    </form>
  );
}
