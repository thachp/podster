"use client";

import { CheckCircle2, CircleDashed, CircleDot, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { cn } from "cn";
import { visibleText } from "@/lib/public/visible-text";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD } from "../team/field";
import { dayOf, describe, explainRepositoryRefusal, nameProblem, PUBLIC_WARNING, repositoryUrl, retryOffered, type RoomRepository } from "./repository-model";

const TONES = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  amber: "bg-status-amber-surface text-status-amber",
  blue: "bg-status-blue-surface text-status-blue",
  green: "bg-status-green-surface text-status-green",
  danger: "bg-status-danger-surface text-status-danger",
} as const;

const ICONS: Record<keyof typeof TONES, LucideIcon> = { neutral: CircleDashed, amber: TriangleAlert, blue: CircleDot, green: CheckCircle2, danger: XCircle };

/** A label and an icon, so color is never the only signal. */
function StateBadge({ label, tone }: { label: string; tone: keyof typeof TONES }) {
  const Icon = ICONS[tone];
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone])}>
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

function Warning({ name }: { name?: string }) {
  return (
    <span className="block space-y-2">
      {name ? (
        <span className="block">
          Name: <span className="break-all font-mono">{name}</span>
        </span>
      ) : null}
      {PUBLIC_WARNING.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * The room's managed repository in Workroom Settings (M5 step 9(a), ADR 0009). Shown only while the server answers the
 * repository read, so with managed repositories switched off nothing here renders. Everything is the server's state; the
 * owner's and admins' controls are offered from it as a hint, and Rust decides every request.
 */
export function RepositorySection({ roomId, state, runsRepository, archived }: { roomId: string; state: RoomRepository; runsRepository: boolean; archived: boolean }) {
  const commands = useCommands(null);
  const { send, clear, retrying } = commands;
  const ids = { name: useId(), problem: useId(), hint: useId() };
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const after = useRef<HTMLDivElement>(null);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/repository`;
  const shown = describe(state);
  const { request, repository } = state;
  const problem = nameProblem(name);
  const busy = retrying;
  // Display only: present for the owner and admins when the API could read it. The request command checks the delegation again.
  const delegated = state.delegated;
  const mayAsk = runsRepository && !archived && !request && !repository;
  const fullName = repository ? visibleText(repository.full_name) : null;
  const url = repository ? repositoryUrl(repository.full_name) : null;

  const create = () => send(base, { name, visibility: "public" }, "Asked for the repository. Setup runs now; reload to see the result.", { explain: explainRepositoryRefusal, onOk: () => setName("") });
  const retry = () => send(`${base}/retry`, {}, "Setup is running again. Reload to see the result.", { explain: explainRepositoryRefusal });

  return (
    <div className="space-y-3">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge label={shown.label} tone={shown.tone} />
        <span className="text-sm">{shown.text}</span>
      </div>

      {repository ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Repository</dt>
          <dd className="min-w-0 break-all font-mono">
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline">
                {fullName}
              </a>
            ) : (
              fullName
            )}
          </dd>
          <dt className="text-muted-foreground">Visibility</dt>
          <dd>{repository.visibility === "public" ? "Public on GitHub" : "Private on GitHub"}</dd>
          <dt className="text-muted-foreground">Default branch</dt>
          <dd className="min-w-0 break-all font-mono">{visibleText(repository.default_branch)}</dd>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd>{repository.verified_at === null ? "Not yet" : dayOf(repository.verified_at)}</dd>
          {repository.status_reason ? (
            <>
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="break-all font-mono">{visibleText(repository.status_reason)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {request && !repository ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name asked for</dt>
          <dd className="min-w-0 break-all font-mono">{visibleText(request.name)}</dd>
          <dt className="text-muted-foreground">Asked on</dt>
          <dd>{dayOf(request.requested_at)}</dd>
          {request.state === "failed" || request.state === "uncertain" ? (
            <>
              <dt className="text-muted-foreground">Attempts left</dt>
              <dd>{request.attempts_left}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {runsRepository && retryOffered(state) && !archived ? (
        <div className="space-y-1">
          <p id={ids.hint} className="text-sm text-muted-foreground">
            {request?.attempts_left === 1 ? "1 attempt left." : `${request?.attempts_left} attempts left.`} A retry may be refused as too soon: setup waits a minute after a run, doubling up to an hour.
          </p>
          <ConfirmAction label="Retry setup" describedBy={ids.hint} disabled={busy} title="Retry setting up this workroom's repository?" description={<Warning />} confirm="Retry setup" action={retry} focusAfter={after} />
        </div>
      ) : null}
      {runsRepository && request && !repository && (request.state === "failed" || request.state === "uncertain") && request.attempts_left === 0 ? (
        <p className="text-sm text-muted-foreground">Setup has run as many times as a workroom is allowed. A Podster operator can reset it.</p>
      ) : null}

      {mayAsk && delegated === false ? (
        <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          A Podster operator has taken managed repositories away from this workroom&apos;s organization, so a repository can&apos;t be created here. Only an operator can restore it.
        </p>
      ) : null}
      {mayAsk && delegated !== false ? (
        <div className="space-y-2">
          {delegated === undefined ? <p className="text-sm text-muted-foreground">We couldn&apos;t check whether managed repositories are still available to this workroom&apos;s organization. Asking may be refused.</p> : null}
          <div className="space-y-1">
            <label htmlFor={ids.name} className="text-sm font-medium">
              Repository name
            </label>
            <input
              id={ids.name}
              className={`${FIELD} max-w-sm font-mono`}
              value={name}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={touched && problem !== null}
              aria-describedby={`${ids.problem}`}
              disabled={busy}
              onChange={(event) => {
                clear();
                setName(event.target.value);
              }}
              onBlur={() => setTouched(true)}
            />
            <p id={ids.problem} aria-live="polite" className={cn("text-sm", touched && problem ? "text-status-danger" : "text-muted-foreground")}>
              {touched && problem ? problem : "Lower-case letters, digits and hyphens, at most 64 characters. Some names are reserved."}
            </p>
          </div>
          <ConfirmAction label="Create a repository" disabled={busy || problem !== null} title="Create a public repository for this workroom?" description={<Warning name={name} />} confirm="Create public repository" action={create} focusAfter={after} />
        </div>
      ) : null}
      {runsRepository && archived && !request && !repository ? <p className="text-sm text-muted-foreground">This workroom is archived, so a repository can&apos;t be created for it.</p> : null}
      {!runsRepository && !request && !repository ? <p className="text-sm text-muted-foreground">Only this workroom&apos;s owner and admins can create its repository.</p> : null}

      <p className="text-sm text-muted-foreground">Creating a repository grants nobody access to it. The owner and admins grant push or merge to each participant on Team, and Podster never deletes a repository.</p>
    </div>
  );
}
