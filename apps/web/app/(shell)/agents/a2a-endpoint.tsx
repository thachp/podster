"use client";

import { useId, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import type { SheetApi } from "@/components/sheet/target-sheet";
import type { GatewayResult } from "@/lib/gateway/result";
import { endpointHost, endpointLabel, endpointUrlProblem, TOKEN_LABEL, type A2aEndpoint } from "./model";

/** What the Sheet gives this section: its runner, so a change reloads the agent, and whether something's already running. */
type Props = {
  name: string;
  endpoint: A2aEndpoint | undefined;
  active: boolean;
  saving: boolean;
  run: SheetApi<unknown>["run"];
  onUnconfirmed: () => void;
};

const outage = (result: GatewayResult<unknown>) => !result.ok && (result.status >= 500 || result.status === 429);

const REFUSALS: Record<string, string> = {
  invalid_endpoint_url: "That URL can't be used: it must be public HTTPS on a DNS name, with no IP address, port or credentials.",
  token_storage_unavailable: "Podster can't store a token right now. Set the endpoint without one, or try again later.",
  agent_disconnected: "This agent is disconnected, so its endpoint can't be set.",
};

/**
 * The agent's A2A endpoint on its Sheet (M3 step 15, decision 119): where Podster sends it task offers. An organization admin
 * can see it, set it and remove it, as the agent can. The signing secret is shown once, right after a set makes one, and the
 * token is write-only: neither is ever read back.
 */
export function A2aEndpointSection({ name, endpoint, active, saving, run, onUnconfirmed }: Props) {
  const ids = { url: useId(), token: useId(), problem: useId() };
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const host = endpointHost(endpoint);
  const path = (target: string) => `/api/agents/${encodeURIComponent(target)}/a2a-endpoint`;

  async function send(body: unknown, method: "PUT" | "DELETE") {
    setProblem(null);
    let answered: GatewayResult<{ signing_secret?: string }> | null = null;
    await run(async ({ target }) => {
      const result = await clientCommand<{ signing_secret?: string }>(path(target), body, { method }).catch(() => null);
      if (result === null || outage(result)) {
        onUnconfirmed();
        return { ok: true as const, data: null };
      }
      answered = result;
      // This section words its own refusals, so the Sheet only reloads.
      return { ok: true as const, data: null };
    });
    return answered as GatewayResult<{ signing_secret?: string }> | null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const wrong = endpointUrlProblem(url);
    if (wrong) return setProblem(wrong);
    const result = await send({ url: url.trim(), ...(token ? { token } : {}) }, "PUT");
    if (!result) return;
    if (!result.ok) return setProblem(REFUSALS[result.code] ?? "Podster couldn't set it.");
    setSecret(result.data.signing_secret ?? null);
    setEditing(false);
    setToken("");
  }

  async function rotate() {
    if (!endpoint) return;
    const result = await send({ url: endpoint.url, rotate_secret: true }, "PUT");
    if (result?.ok) setSecret(result.data.signing_secret ?? null);
    else if (result) setProblem(REFUSALS[result.code] ?? "Podster couldn't make a new secret.");
  }

  async function remove() {
    setRemoving(false);
    setSecret(null);
    const result = await send(undefined, "DELETE");
    if (result && !result.ok) setProblem("Podster couldn't remove it.");
  }

  return (
    <section aria-labelledby="agent-a2a" className="space-y-2">
      <h3 id="agent-a2a" className="font-medium">
        A2A endpoint
      </h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="break-words">
          {endpointLabel(endpoint)}
          {host ? ` · ${host}` : ""}
        </dd>
        {endpoint ? (
          <>
            <dt className="text-muted-foreground">Token</dt>
            <dd className={endpoint.token_state === "unreadable" ? "text-status-amber" : undefined}>{TOKEN_LABEL[endpoint.token_state]}</dd>
            {endpoint.consecutive_failures > 0 ? (
              <>
                <dt className="text-muted-foreground">Failed sends</dt>
                <dd>{endpoint.consecutive_failures} in a row</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">Podster sends task offers here, and reads back what the agent reports. It grants nothing in any workroom.</p>
      {endpoint && !endpoint.enabled ? <p className="text-sm text-status-amber">Off, so nothing is sent. Setting it again turns it back on.</p> : null}

      {secret ? (
        <div role="status" className="space-y-1 rounded-lg border p-3 text-sm">
          <p className="font-medium">Signing secret, shown only now</p>
          <p className="font-mono break-all">{secret}</p>
          <p className="text-xs text-muted-foreground">Give it to the agent to check each request's signature. Podster won't show it again: if it's lost, make a new one.</p>
          <Button variant="outline" size="sm" onClick={() => setSecret(null)}>
            Done
          </Button>
        </div>
      ) : null}
      {problem ? (
        <p role="alert" id={ids.problem} className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}

      {active && editing ? (
        <form className="space-y-2" onSubmit={save} noValidate>
          <div className="space-y-1">
            <Label htmlFor={ids.url}>Endpoint URL</Label>
            <Input id={ids.url} type="url" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={problem ? ids.problem : undefined} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.token}>Bearer token (optional)</Label>
            <Input id={ids.token} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            <p className="text-xs text-muted-foreground">Stored encrypted and never shown again. Leave it empty to keep the one stored for the same URL.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11 sm:min-h-9" disabled={saving}>
              Save
            </Button>
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : active ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => { setUrl(""); setProblem(null); setEditing(true); }}>
            {endpoint ? "Change" : "Set endpoint"}
          </Button>
          {endpoint ? (
            <>
              <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => void rotate()}>
                New signing secret
              </Button>
              <Button variant="destructive" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={removing}>
        <AlertDialogContent onEscapeKeyDown={() => setRemoving(false)}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Remove “{name}”'s A2A endpoint?</AlertDialogTitle>
            <AlertDialogDescription>Podster stops sending it offers, and its signing secret and token are deleted. Offers already sent stop being read back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRemoving(false)}>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
