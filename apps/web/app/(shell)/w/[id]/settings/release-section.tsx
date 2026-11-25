"use client";

import { Check, Copy } from "lucide-react";
import { useId, useRef, useState } from "react";
import { cn } from "cn";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { visibleText } from "@/lib/public/visible-text";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD, MOBILE_TARGET } from "../team/field";
import { CUSTOM_DOMAIN_UNAVAILABLE, dayOf, DEPLOY_GRANTS_UNAVAILABLE, describeHostname, explainReleaseRefusal, holdsName, hostnameProblem, releaseConflict, WHAT_AN_APP_IS, type HostnameRead, type HostnameRequest, type ReleaseView } from "./release-model";
import { StateBadge } from "./state-badge";

/** A day, and who, only where they can be named. */
const byWhom = (day: string, who: string | null) => (who ? `${day} by ${who}` : day);

const Row = ({ term, children, mono = false }: { term: string; children: React.ReactNode; mono?: boolean }) => (
  <>
    <dt className="text-muted-foreground">{term}</dt>
    <dd className={cn("min-w-0 break-all", mono && "font-mono")}>{children}</dd>
  </>
);

/** Which value was copied last, and how it went. One for all the records, so only the last copy says "Copied.". */
type Copied = { what: string; ok: boolean } | null;

/**
 * A value to publish at a DNS provider, in monospace, with a Copy button. The button copies exactly what the server
 * gave, which is what DNS needs; the text shown is the same value with nothing hidden in it. Copying changes nothing.
 */
function CopyText({ value, what, copied, setCopied }: { value: string; what: string; copied: Copied; setCopied: (copied: Copied) => void }) {
  const state = copied?.what !== what ? "idle" : copied.ok ? "copied" : "failed";
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ what, ok: true });
    } catch {
      setCopied({ what, ok: false });
    }
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1 font-mono break-all">{visibleText(value)}</span>
        <Button type="button" variant="outline" size="sm" className={`${MOBILE_TARGET} shrink-0`} aria-label={`Copy ${what}`} onClick={() => void copy()}>
          {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />} Copy
        </Button>
      </span>
      <span role="status" className="text-xs text-muted-foreground">
        {state === "copied" ? "Copied." : state === "failed" ? "Couldn't copy. Select it and copy it yourself." : ""}
      </span>
    </span>
  );
}

/**
 * The two records a room's owner publishes for a custom domain, as the demo's Domains panel lists a record: its type,
 * its name and its value, each to copy. The TXT record proves control and is checked every day; the CNAME points the
 * name at the content domain's fallback origin, the target the server names from its own configuration, never this
 * page's.
 */
function DnsRecords({ request }: { request: HostnameRequest }) {
  const [copied, setCopied] = useState<Copied>(null);
  const shared = { copied, setCopied };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">At the company that runs DNS for {visibleText(request.hostname)}, add these two records:</p>
      <div className="divide-y rounded-md border">
        <section aria-label="TXT record" className="space-y-2 p-3">
          <p className="text-sm font-medium">1. Prove you control the name</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <Row term="Type">TXT</Row>
            <Row term="Name">
              <CopyText value={request.challenge_name} what="TXT record name" {...shared} />
            </Row>
            <Row term="Value">
              <CopyText value={request.challenge_value} what="TXT record value" {...shared} />
            </Row>
          </dl>
        </section>
        <section aria-label="CNAME record" className="space-y-2 p-3">
          <p className="text-sm font-medium">2. Point the name at Podster</p>
          {request.cname_target ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <Row term="Type">CNAME</Row>
              <Row term="Name">
                <CopyText value={request.hostname} what="CNAME record name" {...shared} />
              </Row>
              <Row term="Points to">
                <CopyText value={request.cname_target} what="CNAME record target" {...shared} />
              </Row>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Podster can&apos;t name this record yet: this deployment has no app domain set up.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Release in Workroom Settings (M6 step 10(a), ADR 0010). Its state is what the server's reads say, and its controls are a
 * hint for the owner and admins, as people: Rust decides every command again. Unavailable shows when the deployment answers
 * release's routes as routes that don't exist, and then nothing here offers anything. No address here is a link: whether a
 * release is served isn't in these reads, and a live link shows only where it is real.
 *
 * Every prop crosses from the server page to this client component, so each must be serializable: names arrive as
 * strings the server resolved ("you", a name, or null for nobody named), never as a function.
 */
export function ReleaseSection({ roomId, view, hostname, mayConfigure, archived, setByName = null, requestedByName = null }: { roomId: string; view: ReleaseView; hostname: HostnameRead | null; mayConfigure: boolean; archived: boolean; setByName?: string | null; requestedByName?: string | null }) {
  const commands = useCommands(null);
  const { send, retrying } = commands;
  const after = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  if (view.state === "failed") return <ReadFailure />;
  if (view.state === "unavailable")
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge label={view.label} tone={view.tone} />
        <span className="text-sm text-muted-foreground">{view.text}</span>
      </div>
    );

  const { config } = view;
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/release-config`;
  const setEnabled = (enabled: boolean) =>
    send(base, { enabled, expected_version: config.version }, enabled ? "Release is on. Nothing is published until a release is asked for and approved." : "Release is off. This workroom's app is being unpublished.", {
      method: "PUT",
      explain: explainReleaseRefusal,
      conflict: releaseConflict,
    });
  const controls = mayConfigure && !archived;

  return (
    <div className="space-y-3">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge label={view.label} tone={view.tone} />
        <span className="text-sm">{view.text}</span>
      </div>
      {view.missing.length > 0 ? (
        <ul id={reasonId} className="list-disc space-y-1 pl-5 text-sm">
          {view.missing.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <Row term="Approval">The owner or an admin approves each release, as a person. An agent never does.</Row>
        <Row term="Environment">Production only, from merged and reviewed code. There&apos;s no preview.</Row>
        <Row term="App address" mono={config.default_host !== null}>
          {config.default_host ? visibleText(config.default_host) : <span className="font-sans text-muted-foreground">None yet. Podster gives the app its address.</span>}
        </Row>
        {config.default_host ? <Row term="Live">Not shown here. An address is live only once a release is served there.</Row> : null}
        <Row term="Last changed">{config.updated_at === null ? "Never" : byWhom(dayOf(config.updated_at), setByName)}</Row>
        <Row term="Deployment grants">
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge label="Unavailable" tone="neutral" />
            <span>{DEPLOY_GRANTS_UNAVAILABLE}</span>
          </span>
        </Row>
      </dl>

      {controls && view.state === "not-configured" ? (
        <ConfirmAction
          label="Switch release on"
          disabled={retrying}
          title="Switch release on for this workroom?"
          description={
            <span className="block space-y-2">
              <span className="block">This publishes nothing by itself. A release is made only from code Podster merged, when someone with a deployment grant asks for one, and the owner or an admin approves each one.</span>
              <span className="block">A released app is public, at an address Podster gives it, under Podster&apos;s name. Anyone can open it.</span>
              <span className="block">{WHAT_AN_APP_IS}</span>
            </span>
          }
          confirm="Switch release on"
          action={() => setEnabled(true)}
          focusAfter={after}
        />
      ) : null}
      {controls && view.state === "needs-approval" ? (
        // Marked, not really disabled, so it can take focus and its reasons are read with it. Clicking does nothing.
        <Button type="button" size="sm" variant="outline" aria-disabled aria-describedby={reasonId} className={`${MOBILE_TARGET} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`} onClick={(event) => event.preventDefault()}>
          Switch release on
        </Button>
      ) : null}
      {controls && view.state === "ready" ? (
        <ConfirmAction
          label="Switch release off"
          variant="destructive"
          destructive
          disabled={retrying}
          title="Switch release off for this workroom?"
          description="The app stops being served now, on every address, and anything waiting for approval or uploading ends. Every release's record is kept. Switching it on again publishes nothing until a new release is approved."
          confirm="Switch release off"
          action={() => setEnabled(false)}
          focusAfter={after}
        />
      ) : null}
      {mayConfigure && archived ? <p className="text-sm text-muted-foreground">This workroom is archived, so release can&apos;t be changed.</p> : null}
      {!mayConfigure ? <p className="text-sm text-muted-foreground">Only this workroom&apos;s owner and admins can change release.</p> : null}

      <h3 className="pt-2 font-medium">Custom domain</h3>
      {hostname === "failed" ? <ReadFailure /> : null}
      {hostname === "unavailable" ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge label="Not available yet" tone="neutral" />
          <span className="text-sm text-muted-foreground">{CUSTOM_DOMAIN_UNAVAILABLE}</span>
        </div>
      ) : null}
      {hostname !== null && typeof hostname === "object" ? <CustomDomain roomId={roomId} request={hostname.request} controls={controls} requestedByName={requestedByName} /> : null}

      <p className="text-sm text-muted-foreground">Switching release on grants nobody a deployment, and an agent never approves a release. Release doesn&apos;t serve a private workroom&apos;s app.</p>
    </div>
  );
}

function CustomDomain({ roomId, request, controls, requestedByName }: { roomId: string; request: HostnameRequest | null; controls: boolean; requestedByName: string | null }) {
  const commands = useCommands(null);
  const { send, clear, retrying } = commands;
  const after = useRef<HTMLDivElement>(null);
  const ids = { name: useId(), problem: useId() };
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/app-hostname`;
  const problem = hostnameProblem(name);
  const held = holdsName(request);
  const shown = request ? describeHostname(request) : null;

  const ask = () => send(base, { hostname: name.trim() }, "Asked for the name. Publish the two records shown here; nothing is held until Podster reads the TXT record.", { method: "PUT", explain: explainReleaseRefusal, onOk: () => setName("") });
  const remove = () => send(base, {}, request?.state === "pending" ? "The request is dropped." : "This workroom has stopped using the name. Podster is removing it.", { method: "DELETE", explain: explainReleaseRefusal });

  return (
    <div className="space-y-3">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      {!request ? <p className="text-sm">This workroom has no custom domain. It can have one, once you prove you control it.</p> : null}
      {request && shown ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge label={shown.label} tone={shown.tone} />
            <span className="text-sm">{shown.text}</span>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <Row term="Hostname" mono>
              {visibleText(request.hostname)}
            </Row>
            {request.state === "pending" ? <Row term="Ends">{`${new Date(request.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC, if the TXT record isn't read by then`}</Row> : null}
            <Row term="Asked on">{byWhom(dayOf(request.requested_at), requestedByName)}</Row>
          </dl>
          {request.state === "pending" || request.state === "claimed" ? <DnsRecords request={request} /> : null}
        </>
      ) : null}

      {controls && request && (request.state === "pending" || request.state === "claimed") ? (
        <ConfirmAction
          label={request.state === "pending" ? "Drop this request" : "Remove this domain"}
          variant="outline"
          destructive={request.state === "claimed"}
          disabled={retrying}
          title={request.state === "pending" ? "Drop this hostname request?" : "Remove this custom domain?"}
          description={
            request.state === "pending"
              ? "The record stops counting. Asking again gives a new record."
              : "The app stops being served on this name first, then Podster removes it. A claim never moves on: claiming it again, by anyone, needs a new record."
          }
          confirm={request.state === "pending" ? "Drop the request" : "Remove the domain"}
          action={remove}
          focusAfter={after}
        />
      ) : null}

      {controls && !held ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <label htmlFor={ids.name} className="text-sm font-medium">
              Hostname
            </label>
            <input
              id={ids.name}
              className={`${FIELD} max-w-sm font-mono`}
              value={name}
              maxLength={253}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={touched && problem !== null}
              aria-describedby={ids.problem}
              disabled={retrying}
              onChange={(event) => {
                clear();
                setName(event.target.value);
              }}
              onBlur={() => setTouched(true)}
            />
            <p id={ids.problem} aria-live="polite" className={cn("text-sm", touched && problem ? "text-status-danger" : "text-muted-foreground")}>
              {touched && problem ? problem : "One hostname you control, such as app.example.com. Podster's own domains can't be used."}
            </p>
          </div>
          <ConfirmAction
            label="Ask for this domain"
            disabled={retrying || problem !== null}
            title="Ask to use this hostname?"
            description="Podster gives you a TXT record and a CNAME record to publish at your DNS provider. Nothing is held until Podster reads the TXT record, and the request ends after 72 hours. This maps no address by itself: the app is served there only while release is on and a release is served."
            confirm="Ask for the record"
            action={ask}
            focusAfter={after}
          />
        </div>
      ) : null}
    </div>
  );
}
