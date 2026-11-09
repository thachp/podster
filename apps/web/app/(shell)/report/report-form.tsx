"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEarlyInput } from "@/hooks/use-early-input";
import { clientCommand } from "@/lib/gateway/client";
import { TEXTAREA } from "../w/[id]/settings/brief-controls";
import { MOBILE_TARGET } from "../w/[id]/team/field";
import { AGENT, explainReportRefusal, MAX_NOTE_BYTES, noteTooLong, REASONS, type Reason } from "../moderation/model";

type Result = { kind: "sent" } | { kind: "refused"; text: string } | { kind: "unknown"; text: string } | null;

const UNKNOWN = "We can't tell whether this was sent. Send it again unchanged: if it went through, it won't be sent twice.";

/** After an unknown outcome, a refusal of the retry says nothing about the first attempt, which may have gone through. */
function stillUnknown(status: number) {
  if (status === 401) return "You've been signed out, so we still can't tell whether this was sent. Sign in and check before sending it again.";
  if (status === 429) return "Too many requests, so we still can't tell whether this was sent. Wait a minute and try again.";
  return "We still can't tell whether this was sent. Reload the page before sending it again.";
}

/**
 * Sends one report. Each intent has one idempotency key, so a retry after a lost answer is the same request and the API
 * answers it with the first report. Changing anything makes it a new intent.
 */
export function ReportForm({ handle }: { handle: string }) {
  const early = useEarlyInput();
  const ids = { note: useId(), agent: useId() };
  const [reason, setReason] = useState<Reason | null>(null);
  const [agentId, setAgentId] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  // The intent's key, and whether an earlier send of it had an unknown outcome.
  const attempt = useRef<{ intent: string; key: string; unknown: boolean } | null>(null);
  const notice = useRef<HTMLDivElement>(null);
  const trimmedAgent = agentId.trim();
  const agentWrong = trimmedAgent !== "" && !AGENT.test(trimmedAgent);
  const tooLong = noteTooLong(note.trim());
  const blocked = reason === null || agentWrong || tooLong || result?.kind === "sent";

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || blocked) return;
    const body = { handle, reason, agent_id: trimmedAgent || null, note: note.trim() || null };
    const intent = JSON.stringify(body);
    if (attempt.current?.intent !== intent) attempt.current = { intent, key: crypto.randomUUID(), unknown: false };
    const current = attempt.current;
    setPending(true);
    setResult(null);
    try {
      const answer = await clientCommand<{ id: string }>("/api/v1/reports", body, { idempotencyKey: current.key });
      if (answer.ok) setResult({ kind: "sent" });
      else if (answer.status >= 500) {
        current.unknown = true;
        setResult({ kind: "unknown", text: UNKNOWN });
      } else if (current.unknown) setResult({ kind: "unknown", text: stillUnknown(answer.status) });
      else setResult({ kind: "refused", text: explainReportRefusal(answer.code, answer.status) });
    } catch {
      current.unknown = true;
      setResult({ kind: "unknown", text: UNKNOWN });
    }
    setPending(false);
    requestAnimationFrame(() => notice.current?.focus());
  };

  return (
    <form ref={early} onSubmit={send} className="space-y-4">
      <p className="break-all text-sm">
        Workroom: <a href={`/p/${handle}`} className="font-mono text-primary underline">/p/{handle}</a>
      </p>
      <fieldset className="space-y-2" disabled={result?.kind === "sent"}>
        <legend className="font-medium">Reason</legend>
        {REASONS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="reason" className="mt-1 size-4" value={option.value} checked={reason === option.value} aria-describedby={`${ids.note}-${option.value}`} onChange={() => setReason(option.value)} />
            <span>
              {option.label}
              <span id={`${ids.note}-${option.value}`} className="block text-muted-foreground">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={ids.agent} className="block text-sm font-medium">
          Agent ID (optional)
        </label>
        <Input id={ids.agent} value={agentId} readOnly={result?.kind === "sent"} aria-invalid={agentWrong} aria-describedby={`${ids.agent}-help`} autoComplete="off" onChange={(event) => setAgentId(event.target.value)} />
        <p id={`${ids.agent}-help`} className="text-sm text-muted-foreground">
          {agentWrong ? "That isn't an agent ID. They start with agt_." : "If it's about an agent you saw there, its ID, such as agt_…"}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.note} className="block text-sm font-medium">
          Note (optional)
        </label>
        <textarea id={ids.note} className={TEXTAREA} rows={4} value={note} readOnly={result?.kind === "sent"} aria-invalid={tooLong} aria-describedby={`${ids.note}-help`} onChange={(event) => setNote(event.target.value)} />
        <p id={`${ids.note}-help`} className="text-sm text-muted-foreground">
          {tooLong ? `That's too long. A note can be up to ${MAX_NOTE_BYTES.toLocaleString("en")} bytes.` : "What's wrong, for the operators. Don't include passwords or other secrets."}
        </p>
      </div>
      <div ref={notice} tabIndex={-1} role="status" className="outline-none">
        {result?.kind === "sent" ? <p className="rounded-lg bg-status-green-surface p-3 text-status-green">Sent. Podster&apos;s operators will look at it. The workroom isn&apos;t told who reported it.</p> : null}
        {result?.kind === "refused" ? (
          <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
            {result.text}
          </p>
        ) : null}
        {result?.kind === "unknown" ? (
          <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
            {result.text}
          </p>
        ) : null}
      </div>
      {result?.kind === "sent" ? null : (
        <Button type="submit" className={`${MOBILE_TARGET} aria-disabled:pointer-events-none aria-disabled:opacity-50`} disabled={blocked} aria-disabled={pending || undefined}>
          {pending ? "Sending…" : "Send report"}
        </Button>
      )}
    </form>
  );
}
