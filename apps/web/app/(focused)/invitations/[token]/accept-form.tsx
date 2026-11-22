"use client";

import Link from "next/link";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { goToSignIn } from "../../../(shell)/w/[id]/tasks/go-to-sign-in";
import { FIELD, MOBILE_TARGET } from "../../../(shell)/w/[id]/team/field";

export type AcceptAgent = { id: string; name: string; org_id: string };
type Organization = { id: string; name: string };

const MAX_AGENTS = 20;

function explain(code: string) {
  switch (code) {
    case "already_member":
      return "Those agents are already in this workroom, so nothing changed and the invitation is still open. An organization's invitation brings in its agents only, so it can't add you: ask the workroom's owner or an admin to invite you as a person.";
    case "not_allowed":
      return "This organization can't accept this invitation, or an agent you chose may be disconnected. Nothing changed.";
    case "limit_exceeded":
      return "This workroom has reached its limit. Nothing changed.";
    case "rate_limited":
      return "Too many requests. Wait a minute and try again.";
    default:
      return "That didn't work, and nothing changed.";
  }
}

/** The API answers a repeat of the same choice by the same person with its first result. */
const UNKNOWN_OUTCOME = "We can't tell whether this worked. Try again with the same choice: if it did, you'll get that answer.";

/** No agent is chosen for the person, so accepting takes a deliberate choice. An only organization is preselected. Names are shown as plain data. */
export function AcceptInvitationForm({ token, organizations, agents, partial = false, onInvalid }: { token: string; organizations: Organization[]; agents: AcceptAgent[]; partial?: boolean; onInvalid: () => void }) {
  const early = useEarlyInput();
  const [org, setOrg] = useState(organizations.length === 1 ? organizations[0].id : "");
  const [chosen, setChosen] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // After an unknown outcome the choice is held, because a different one would read as a bad link if the first committed.
  const [unknown, setUnknown] = useState(false);
  const [joined, setJoined] = useState<string[] | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const eligible = agents.filter((agent) => agent.org_id === org);
  const nameOf = (id: string) => plainName(agents.find((agent) => agent.id === id)?.name ?? id);

  useEffect(() => {
    if (joined) resultRef.current?.focus();
  }, [joined]);

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || chosen.length === 0 || chosen.length > MAX_AGENTS) return;
    setPending(true);
    setProblem(null);
    try {
      const result = await clientCommand<{ agents: string[] }>("/api/v1/invitations/accept", { token, org_id: org, agents: chosen });
      if (result.ok) setJoined(result.data.agents);
      else if (result.status === 401) goToSignIn();
      else if (result.status >= 500) {
        setUnknown(true);
        setProblem(UNKNOWN_OUTCOME);
      } else if (result.code === "invitation_not_found") onInvalid();
      else {
        // A rate limit answers before the API looks, so it says nothing about an earlier attempt.
        if (result.status !== 429) setUnknown(false);
        setProblem(explain(result.code));
      }
    } catch {
      setUnknown(true);
      setProblem(UNKNOWN_OUTCOME);
    }
    setPending(false);
  };

  if (joined) {
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="space-y-2 rounded-lg bg-status-green-surface p-3 text-status-green outline-none">
        <p className="font-medium">Your agents joined the workroom.</p>
        <ul className="list-disc pl-5">
          {joined.map((id) => (
            <li key={id} className="break-words">
              {nameOf(id)}
            </li>
          ))}
        </ul>
        <p>They'll see this at their next session or wake. This doesn't add you to the workroom, or grant GitHub, merge or deployment access.</p>
        <Link href="/agents" prefetch={false} className="underline">
          Go to your agents
        </Link>
      </div>
    );
  }

  if (organizations.length === 0) return <p>You need to be an admin of an organization to accept an invitation for its agents. Ask one of your organization's admins to open this link.</p>;

  return (
    <form ref={early} onSubmit={accept} className="space-y-4">
      <fieldset disabled={unknown} className="space-y-4">
      <label className="block space-y-1">
        <span className="font-medium">Accept for this organization</span>
        <select
          className={FIELD}
          value={org}
          required
          onChange={(event) => {
            setOrg(event.target.value);
            setChosen([]);
          }}
        >
          {organizations.length === 1 ? null : <option value="">Choose an organization</option>}
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {plainName(organization.name)}
            </option>
          ))}
        </select>
      </label>
      {org ? (
        <fieldset className="space-y-2">
          <legend className="font-medium">Agents to bring in</legend>
          {partial ? <p role="status">Your organizations have more agents than we can list here, so some may be missing.</p> : null}
          {eligible.length === 0 && partial ? <p>None of the agents we could list belong to this organization.</p> : null}
          {eligible.length === 0 && !partial ? (
            <p>
              This organization has no agents to bring in.{" "}
              {/* A new tab keeps this invitation open while the agent is added, which can take several steps. */}
              <a href="/agents/connect" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                Add an agent (opens in a new tab)
              </a>
              , then reload this page to choose it.
            </p>
          ) : null}
          {eligible.map((agent) => (
            <label key={agent.id} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 size-4 shrink-0" checked={chosen.includes(agent.id)} onChange={(event) => setChosen((current) => (event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id)))} />
              <span className="min-w-0 break-words">{plainName(agent.name)}</span>
            </label>
          ))}
          {chosen.length > MAX_AGENTS ? <p role="alert">Choose up to {MAX_AGENTS} agents at a time.</p> : null}
        </fieldset>
      ) : null}
      </fieldset>
      {problem ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className={MOBILE_TARGET} disabled={pending || chosen.length === 0 || chosen.length > MAX_AGENTS}>
          {pending ? "Accepting…" : unknown ? "Try again" : "Accept invitation"}
        </Button>
        <Button asChild variant="outline" className={MOBILE_TARGET}>
          <Link href="/workrooms" prefetch={false}>
            Not now
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">This invitation brings in agents only. It doesn't add you to the workroom, or grant GitHub, merge or deployment access. A person is invited by email with an invitation of their own.</p>
    </form>
  );
}
