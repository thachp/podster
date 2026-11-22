"use client";

import { useEarlyInput } from "@/hooks/use-early-input";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Send } from "./commands";
import { FIELD, MOBILE_TARGET } from "./field";

type Created = { id: string; token?: string; role: string; expires_at: number };

/**
 * Invite a person from another organization by email (decision 239). The owner or an admin types one address and gets a
 * link to send themselves: Podster doesn't email it. Only someone signed in with that address, verified, can accept, as a
 * guest or a member, never admin, and it brings in nobody's agents. Rust decides all of it.
 */
export function PersonInvitation({ base, send, focusAfter }: { base: string; send: Send; focusAfter: RefObject<HTMLDivElement | null> }) {
  const early = useEarlyInput();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"guest" | "member">("guest");
  const [guestCanCreate, setGuestCanCreate] = useState(false);
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (link) linkRef.current?.focus();
  }, [link]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setLink(null);
    setCopied(false);
    const body = { role, invitee: { kind: "person", email: email.trim() }, ...(role === "guest" ? { guest_can_create: guestCanCreate } : {}) };
    // A retry's stored answer never repeats the secret, so there would be nothing to copy: withdraw it below and invite again.
    const success = (created: Created) => (created.token ? "Invitation created. Copy its link now and send it to them yourself: it's shown only once." : "The invitation was created, but its link is shown only once and that answer was lost. Withdraw it below and invite them again.");
    await send<Created>(`${base}/invitations`, body, success, {
      onOk: (created) => {
        if (created.token) {
          setLink(`${window.location.origin}/invitations/${created.token}`);
          setEmail("");
        }
      },
      onDone: (outcome) => {
        if (outcome.kind !== "ok") focusAfter.current?.focus();
      },
      explain: (code, status) =>
        code === "limit_exceeded"
          ? "This workroom has as many person invitations as it can have for now: 20 pending, and 20 a day. Nothing changed."
          : code === "invalid_argument"
            ? "Check the email address and try again. Nothing changed."
            : status === 403
              ? "Only this workroom's owner and admins can invite people. Nothing changed."
              : "That didn't save, and nothing changed.",
    });
    setPending(false);
  };

  const copy = async () => {
    linkRef.current?.select();
    try {
      await navigator.clipboard.writeText(linkRef.current?.value ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-3">
      {link ? (
        <div className="space-y-2 rounded-lg border bg-status-amber-surface p-3 text-status-amber">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Their invitation link. It's shown only once, so copy it now.</span>
            <Input ref={linkRef} readOnly value={link} onFocus={(event) => event.target.select()} className="bg-background text-foreground" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className={MOBILE_TARGET} onClick={copy}>
              Copy link
            </Button>
            <Button type="button" size="sm" variant="outline" className={`text-foreground ${MOBILE_TARGET}`} onClick={() => setLink(null)}>
              Done
            </Button>
            <span role="status" className="text-sm">
              {copied ? "Copied." : ""}
            </span>
          </div>
        </div>
      ) : null}
      <form ref={early} onSubmit={create} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Invite a person</h3>
        <p className="text-sm text-muted-foreground">
          For someone from another organization. Only a person signed in to Podster with this email, verified, can accept, once, within 7 days. They join themselves, never their agents, and get no GitHub, merge, Builds or release access. Send them the link yourself.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Email</span>
            <Input type="email" value={email} required maxLength={254} onChange={(event) => setEmail(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="space-y-1 text-sm">
            <span>Role</span>
            <select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as "guest" | "member")}>
              <option value="guest">Guest: sees only their own tasks</option>
              <option value="member">Member: sees every task and thread</option>
            </select>
          </label>
        </div>
        {role === "guest" ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={guestCanCreate} onChange={(event) => setGuestCanCreate(event.target.checked)} />
            <span>Let them create tasks</span>
          </label>
        ) : null}
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending || !email.trim()}>
          {pending ? "Inviting…" : "Invite person"}
        </Button>
      </form>
    </div>
  );
}
