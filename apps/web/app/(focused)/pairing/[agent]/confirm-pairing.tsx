"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { pairingFailure, type PairingView } from "../model";

/** While Runner hasn't sent its key or its agent, the screen looks again this often, only while it's in view. */
export const LOOK_EVERY_MS = 5_000;

const ENDED: Record<string, string> = {
  expired: "This pairing expired before it was confirmed. Nothing was connected. Start a new one if you still want to connect Runner.",
  canceled: "This pairing was canceled. Nothing was connected.",
  locked: "This pairing was locked after too many wrong codes. Nothing was connected. Start a new one if you still want to connect Runner.",
};

/** A thumbprint in groups of four, so it can be read aloud and compared with Runner's. The groups are only spacing. */
const grouped = (thumbprint: string) => thumbprint.match(/.{1,4}/g)?.join(" ") ?? thumbprint;

/**
 * The confirm screen. It shows the agent and the key's thumbprint Runner sent, and nothing to type: confirming is one
 * deliberate click that sends the thumbprint shown, and the server's answer is what the screen then shows.
 */
export function ConfirmPairing({ initial }: { initial: PairingView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const waiting = view.status === "pending" || (view.status === "redeemed" && !view.runner_ready);

  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (document.visibilityState === "hidden") return;
      const result = await clientQuery<PairingView>(`/api/pairing/${view.agent_id}`, { signal: controller.signal }).catch(() => null);
      if (result?.ok) setView(result.data);
    }, LOOK_EVERY_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [waiting, view.agent_id]);

  async function command(path: "activate" | "cancel") {
    setBusy(true);
    setFailure(null);
    const body = path === "activate" ? { key_thumbprint: view.key_thumbprint } : {};
    const result = await clientCommand<PairingView>(`/api/pairing/${view.agent_id}/${path}`, body).catch(() => null);
    setBusy(false);
    if (result?.ok) setView(result.data);
    else if (result && !result.ok && result.code === "already_linked") setView({ ...view, status: "activated", link_problem: "already_linked" });
    else setFailure(result ? pairingFailure(result.status, result.code) : pairingFailure(500, "error"));
  }

  /** Reads the session again, which finishes a link whose write was lost. The server's answer is what's shown. */
  async function finish() {
    setBusy(true);
    setFailure(null);
    const result = await clientQuery<PairingView>(`/api/pairing/${view.agent_id}`).catch(() => null);
    setBusy(false);
    if (result?.ok) setView(result.data);
    else setFailure(result ? pairingFailure(result.status, result.code) : pairingFailure(500, "error"));
  }

  const name = <strong className="break-words">{view.name}</strong>;
  if (view.status === "activated" && view.link_problem)
    return <p role="alert">{pairingFailure(409, view.link_problem)}</p>;
  if (view.status === "activated" && view.connected === false)
    return (
      <div className="space-y-3">
        <p role="status">Runner&apos;s key is confirmed, but connecting {name} to your organization didn&apos;t finish.</p>
        {failure ? <p role="alert">{failure}</p> : null}
        <Button type="button" disabled={busy} onClick={() => void finish()}>
          Finish connecting
        </Button>
      </div>
    );
  if (view.status === "activated")
    return (
      <div role="status" className="space-y-2">
        <p>Runner is connected as {name}. It has no workroom access yet, and automatic runs stay off until you set them up on that machine.</p>
        <Link className="underline" href="/agents" prefetch={false}>
          Go to Agents
        </Link>
      </div>
    );
  if (view.status in ENDED)
    return (
      <div role="status" className="space-y-2">
        <p>{ENDED[view.status]}</p>
        <Link className="underline" href="/pairing/new" prefetch={false}>
          Start a new pairing
        </Link>
      </div>
    );
  return (
    <div className="space-y-4">
      <p>
        Pairing Runner as {name}. Confirming makes it an agent of your organization, with Runner&apos;s fixed capabilities and no
        workroom access.
      </p>
      <div aria-live="polite" className="space-y-2">
        {view.status === "pending" ? (
          <p>Waiting for Runner to send its key. Enter the code in Runner on the machine you&apos;re pairing.</p>
        ) : (
          <>
            <p className="text-sm font-medium" id="pairing-key-label">
              Key fingerprint Runner sent
            </p>
            <code aria-labelledby="pairing-key-label" className="block rounded-md bg-muted p-2 font-mono text-sm break-all">
              {grouped(view.key_thumbprint ?? "")}
            </code>
            <p>Only confirm if Runner on your machine shows exactly this fingerprint. If it doesn&apos;t, cancel: someone else may have used the code.</p>
            {view.runner_ready ? null : <p>Waiting for Runner to finish setting up its agent. You can confirm once it has.</p>}
          </>
        )}
      </div>
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        {view.status === "redeemed" ? (
          <Button type="button" disabled={busy || !view.runner_ready} onClick={() => void command("activate")}>
            Confirm this key
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void command("cancel")}>
          Cancel pairing
        </Button>
      </div>
    </div>
  );
}
