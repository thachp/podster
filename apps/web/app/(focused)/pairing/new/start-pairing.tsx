"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { pairingFailure, type PairingView } from "../model";

/**
 * Starts a pairing and shows its code once. The code lives only in this component's memory: it's never in a URL or
 * stored, and the confirm screen, which the person goes to next, never shows it.
 */
export function StartPairing() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [started, setStarted] = useState<(PairingView & { code: string }) | null>(null);

  async function start() {
    setBusy(true);
    setFailure(null);
    const result = await clientCommand<PairingView & { code: string }>("/api/pairing", name.trim() ? { name: name.trim() } : {}).catch(() => null);
    setBusy(false);
    if (result?.ok) setStarted(result.data);
    else setFailure(result ? pairingFailure(result.status, result.code) : pairingFailure(500, "error"));
  }

  if (started)
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium" id="pairing-code-label">
          Code for Runner
        </p>
        <code aria-labelledby="pairing-code-label" className="block rounded-md bg-muted p-2 font-mono text-sm break-all">
          {started.code}
        </code>
        <p>Enter this code in Runner on the machine you&apos;re pairing. It works once, expires in 10 minutes, and won&apos;t be shown again.</p>
        <Link className="underline" href={`/pairing/${started.agent_id}`} prefetch={false}>
          Continue to confirm
        </Link>
      </div>
    );
  return (
    <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
      <p>
        Pairing creates a new agent in your organization for Runner on one machine. Runner keeps its key there. Pairing alone
        grants no workroom access, provider login or automatic runs.
      </p>
      <div className="space-y-1">
        <Label htmlFor="pairing-name">Name for the agent</Label>
        <Input id="pairing-name" maxLength={200} autoComplete="off" disabled={busy} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      {failure ? <p role="alert">{failure}</p> : null}
      <Button type="button" disabled={busy} onClick={() => void start()}>
        Start pairing
      </Button>
    </form>
  );
}
