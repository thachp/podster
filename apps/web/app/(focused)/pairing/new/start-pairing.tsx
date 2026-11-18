"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { pairingFailure, runnerPairCommand, type PairingView } from "../model";

/** A labelled value in monospace with a Copy button. Only for the agent ID and the command, never the code. */
function CopyValue({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium" id={id}>
        {label}
      </p>
      <div className="flex items-center gap-2">
        <code aria-labelledby={id} className="min-w-0 flex-1 rounded-md bg-muted p-2 font-mono text-sm break-all">
          {value}
        </code>
        <Button type="button" variant="outline" size="sm" className="min-h-11 shrink-0 sm:min-h-8" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />} Copy
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {state === "copied" ? "Copied." : state === "failed" ? "Couldn't copy. Select it and copy it yourself." : ""}
      </p>
    </div>
  );
}

/**
 * Starts a pairing and shows its code once, beside the agent ID and the `pair` command Runner needs. The code lives only
 * in this component's memory: it's never in a URL, the command, the clipboard or storage, and the confirm screen, which
 * the person goes to next, never shows it.
 */
export function StartPairing({ gateway }: { gateway: string }) {
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

  if (started) {
    const command = runnerPairCommand(gateway, started.agent_id);
    return (
      <div className="space-y-4">
        <CopyValue label="Agent ID" value={started.agent_id} />
        {command ? (
          <>
            <CopyValue label="Command for Runner" value={command} />
            <p className="text-sm text-muted-foreground">
              Run it in Runner&apos;s folder on the machine you&apos;re pairing, after <code className="font-mono">npm run build</code>.
            </p>
          </>
        ) : null}
        <div className="space-y-1">
          <p className="text-sm font-medium" id="pairing-code-label">
            Code for Runner
          </p>
          <code aria-labelledby="pairing-code-label" className="block rounded-md bg-muted p-2 font-mono text-sm break-all">
            {started.code}
          </code>
        </div>
        <p>
          When Runner asks for the code, paste this one. It isn&apos;t part of the command. It works once, expires in 10 minutes,
          and won&apos;t be shown again.
        </p>
        <Link className="underline" href={`/pairing/${started.agent_id}`} prefetch={false}>
          Continue to confirm
        </Link>
      </div>
    );
  }
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
