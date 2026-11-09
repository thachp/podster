"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AgentContent } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import type { GatewayResult } from "@/lib/gateway/result";
import { A2aEndpointSection } from "./a2a-endpoint";
import { ConnectionBadge } from "./connection-badge";
import { InboxOversight, readInbox } from "./inbox-oversight";
import { ParticipationPolicySection } from "./participation-policy";
import { announceStatus, announceWithdrawn, oversightPath, wakeHost, wakeLabel, type AgentConnection, type AgentRoom, type InboxPage } from "./model";

/** The server keeps retrying unreachable rooms on its own, so this only notices when it's finished. */
export const DISCONNECT_CHECK_MS = 15_000;

type Organization = { id: string; name: string };

export type AgentDetail = AgentConnection & {
  inbox: InboxPage | null;
  /** Null when the read failed, which says nothing about where the agent is. */
  rooms: AgentRoom[] | null;
  roomsTruncated: boolean;
  /** The rooms the viewer belongs to, which open as themselves. Null when the read failed, and then nothing is offered. */
  ownRooms: string[] | null;
};

const outage = (result: GatewayResult<unknown>) => !result.ok && (result.status >= 500 || result.status === 429);

async function loadAgent(id: string, signal: AbortSignal): Promise<AgentDetail | null> {
  const path = `/api/agents/${encodeURIComponent(id)}`;
  const agent = await clientQuery<AgentConnection>(path, { signal });
  if (!agent.ok) {
    if (outage(agent)) throw new Error(agent.code);
    // Missing, hidden and not allowed look the same.
    return null;
  }
  const [inbox, rooms, own] = await Promise.all([
    readInbox(id, 0, signal),
    clientQuery<{ rooms: AgentRoom[]; truncated: boolean }>(`/api/v1/agents/${encodeURIComponent(id)}/rooms`, { signal }),
    clientQuery<{ workspaces: { workspace_id: string }[] }>("/api/v1/workspaces", { signal }),
  ]);
  return {
    ...agent.data,
    inbox: inbox.ok ? inbox.data : null,
    rooms: rooms.ok ? rooms.data.rooms : null,
    roomsTruncated: rooms.ok && rooms.data.truncated,
    ownRooms: own.ok ? own.data.workspaces.map((room) => room.workspace_id) : null,
  };
}

export function AgentSheet({ organizations, descriptions }: { organizations: Organization[]; descriptions: Record<string, string> | null }) {
  const organization = (id: string) => organizations.find((org) => org.id === id)?.name;
  return (
    <TargetSheet<AgentDetail>
      param="agent"
      size="md"
      noun="agent"
      load={(id, { signal }) => loadAgent(id, signal)}
      title={(agent) => plainName(agent.name)}
      description={(agent) => `Organization: ${plainName(organization(agent.org_id) ?? agent.org_id)}`}
      version={(agent) => agent.generation}
    >
      {(api) => <AgentDetails api={api} organization={organization(api.data.org_id)} description={descriptions === null ? null : (descriptions[api.data.id] ?? "")} />}
    </TargetSheet>
  );
}

type Confirming = { kind: "disconnect" } | { kind: "withdraw"; room: AgentRoom };

const roomLabel = (room: Pick<AgentRoom, "workspace_name">) => plainName(room.workspace_name);

function AgentDetails({ api, organization, description }: { api: SheetApi<AgentDetail>; organization: string | undefined; description: string | null }) {
  const { data: agent, run, saving } = api;
  const [confirming, setConfirmingState] = useState<Confirming | null>(null);
  const disconnectButton = useRef<HTMLButtonElement | null>(null);
  const connectionHeading = useRef<HTMLHeadingElement | null>(null);
  // The control that opened the dialog, so focus can go back to it.
  const closedFrom = useRef<HTMLElement | null>(null);
  const setConfirming = (next: Confirming | null) => {
    if (next) closedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmingState(next);
  };
  const [notice, setNotice] = useState<string | null>(null);
  // A command whose answer was lost. It may have happened, so neither "done" nor "nothing changed" would be true.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const refreshing = useRef(false);
  // The listing follows a room's own state a moment later, so a confirmed withdrawal shows now.
  const [withdrawn, setWithdrawn] = useState<string[]>([]);
  const name = plainName(agent.name);

  const runRef = useRef(run);
  runRef.current = run;
  const shownStatus = useRef(agent.status);
  shownStatus.current = agent.status;
  // Reloads through the Sheet, so the list behind it refreshes too.
  const reload = () => runRef.current(async () => ({ ok: true, data: null }));
  async function reconcile() {
    const latest = await clientQuery<AgentConnection>(`/api/agents/${encodeURIComponent(agent.id)}`).catch(() => null);
    if (latest?.ok && latest.data.status !== shownStatus.current) await reload();
  }

  // A new status answers the question. So does a refresh the person asked for, once it has read something.
  useEffect(() => setUnconfirmed(false), [agent.status]);
  useEffect(() => {
    if (!refreshing.current) return;
    refreshing.current = false;
    setUnconfirmed(false);
  }, [agent]);

  function refresh() {
    refreshing.current = true;
    void reload();
  }

  useEffect(() => {
    announceStatus(agent.id, agent.status);
  }, [agent.id, agent.status]);

  useEffect(() => {
    if (agent.status !== "disconnecting") return;
    const timer = setInterval(() => void reconcile(), DISCONNECT_CHECK_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.status, agent.id]);

  /**
   * A refusal is an answer, and goes to the Sheet as one. An outage or a lost response isn't: the command may have
   * committed. So the Sheet reloads to show whatever can be read, and this says the outcome is unknown.
   */
  async function attempt(path: (target: string) => string, onDone?: () => void) {
    setNotice(null);
    setUnconfirmed(false);
    // A Refresh whose read failed is still waiting, and this command's reload mustn't count as its answer.
    refreshing.current = false;
    let confirmed = false;
    await run(async ({ target }) => {
      const result = await clientCommand<unknown>(path(target), {}).catch(() => null);
      if (result === null || outage(result)) {
        setUnconfirmed(true);
        return { ok: true as const, data: null };
      }
      confirmed = result.ok;
      if (confirmed) onDone?.();
      return result;
    });
    return confirmed;
  }

  const connection = (verb: "disconnect" | "reconnect") => attempt((target) => `/api/agents/${encodeURIComponent(target)}/${verb}`);

  async function withdraw(room: AgentRoom) {
    const left = () => {
      setWithdrawn((previous) => [...previous, room.workspace_id]);
      announceWithdrawn(agent.id, room.workspace_id);
    };
    if (await attempt((target) => `/api/v1/workspaces/${encodeURIComponent(room.workspace_id)}/members/${encodeURIComponent(target)}/withdraw`, left)) setNotice(`Withdrawn from ${roomLabel(room)}.`);
  }

  const active = agent.status === "active";
  const rooms = agent.rooms?.map((room) => (withdrawn.includes(room.workspace_id) ? { ...room, left: true, status: null } : room)) ?? null;
  const current = rooms?.filter((room) => !room.left) ?? [];
  const past = rooms?.filter((room) => room.left) ?? [];
  const host = wakeHost(agent.wake);

  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}
      {unconfirmed ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          We couldn't confirm that, so it may or may not have gone through. This shows the latest we could read.{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" disabled={saving} onClick={refresh}>
            Refresh
          </Button>
        </p>
      ) : null}

      <section aria-labelledby="agent-connection" className="space-y-2">
        <h3 id="agent-connection" ref={connectionHeading} tabIndex={-1} className="font-medium">
          Connection
        </h3>
        <div aria-live="polite">
          <ConnectionBadge status={agent.status} />
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Agent ID</dt>
          <dd className="font-mono break-all">{agent.id}</dd>
          {organization ? null : (
            <>
              <dt className="text-muted-foreground">Organization ID</dt>
              <dd className="font-mono break-all">{agent.org_id}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Wake</dt>
          <dd className="break-words">
            {wakeLabel(agent.wake)}
            {host ? ` · ${host}` : ""}
          </dd>
        </dl>
        {active ? <p className="text-sm text-muted-foreground">The agent sets its own wake. You can't change it from here yet.</p> : null}
        {agent.status === "disconnecting" ? (
          <div className="space-y-2 rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
            <p>Some workrooms haven't confirmed yet, so this agent isn't fully disconnected. Podster keeps trying, and this updates when every workroom has confirmed.</p>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => void connection("disconnect")}>
              Try now
            </Button>
          </div>
        ) : null}
        {active ? (
          <Button ref={disconnectButton} variant="destructive" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => setConfirming({ kind: "disconnect" })}>
            Disconnect
          </Button>
        ) : null}
        {agent.status === "disconnected" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Reconnecting lets this agent connect again, with new credentials. It gets no workroom access back.</p>
            <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => void connection("reconnect")}>
              Reconnect
            </Button>
          </div>
        ) : null}
      </section>

      <A2aEndpointSection name={name} endpoint={agent.a2a_endpoint} active={active} saving={saving} run={run as SheetApi<unknown>["run"]} onUnconfirmed={() => setUnconfirmed(true)} />

      <ParticipationPolicySection policy={agent.participation_policy} active={active} saving={saving} run={run as SheetApi<unknown>["run"]} onUnconfirmed={() => setUnconfirmed(true)} />

      {description === null ? (
        <p role="alert" className="text-sm">
          Couldn't load what this agent says about its skills.
        </p>
      ) : description ? (
        <section aria-labelledby="agent-skills" className="space-y-2">
          <h3 id="agent-skills" className="font-medium">
            Skills (self-described)
          </h3>
          <AgentContent author={{ name: agent.name, kind: "agent", organization }} body={description} maxLength={2000} />
        </section>
      ) : null}

      <section aria-labelledby="agent-rooms" className="space-y-2">
        <h3 id="agent-rooms" className="font-medium">
          Workrooms
        </h3>
        {rooms === null ? (
          <p role="alert" className="text-sm">
            Couldn't read this agent's workrooms.{" "}
            <Button variant="link" className="h-auto p-0" disabled={saving} onClick={() => void reload()}>
              Try again
            </Button>
          </p>
        ) : !active ? (
          <p className="text-sm text-muted-foreground">{agent.status === "disconnected" ? "It has no workroom access while disconnected." : "Its workroom access is being removed."}</p>
        ) : current.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {current.map((room) => {
              const mine = agent.ownRooms?.includes(room.workspace_id) ?? false;
              return (
                <li key={room.workspace_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{roomLabel(room)}</p>
                    <p className="text-xs text-muted-foreground">
                      {room.status === "archived" ? "Archived · " : "Active · "}
                      Listed role: {room.role}
                    </p>
                    {agent.ownRooms === null ? null : (
                      <Link href={mine ? `/w/${encodeURIComponent(room.workspace_id)}/overview` : oversightPath(room.workspace_id, agent.id)} prefetch={false} className="text-xs text-primary underline" aria-label={mine ? `Open workroom: ${roomLabel(room)}` : `View its tasks, read-only: ${roomLabel(room)}`}>
                        {mine ? "Open workroom" : "View its tasks, read-only"}
                      </Link>
                    )}
                    {/* This list comes from the listing index, which has no scopes. The room's own Team screen shows its owner and admins the real access. */}
                    {mine ? (
                      <Link href={`/w/${encodeURIComponent(room.workspace_id)}/team`} prefetch={false} aria-label={`See Team in ${roomLabel(room)}`} className="ml-3 text-xs text-primary underline">
                        See Team
                      </Link>
                    ) : null}
                  </div>
                  <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={saving} aria-label={`Withdraw from ${roomLabel(room)}`} onClick={() => setConfirming({ kind: "withdraw", room })}>
                    Withdraw
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">This agent isn't in any workroom.</p>
        )}
        {active && agent.ownRooms === null && current.length > 0 ? (
          <p role="alert" className="text-sm">
            Couldn't check which workrooms you're in, so their links are hidden.{" "}
            <Button variant="link" className="h-auto p-0" disabled={saving} onClick={() => void reload()}>
              Try again
            </Button>
          </p>
        ) : null}
        {/* The rows don't say whose room it is, so the link can't be hidden for the viewer's own organization's. */}
        {active && current.some((room) => agent.ownRooms !== null && !agent.ownRooms.includes(room.workspace_id)) ? <p className="text-xs text-muted-foreground">You can read an agent's tasks in another organization's workroom. A workroom of your own organization that you're not in shows as not found.</p> : null}
        {agent.roomsTruncated ? <p className="text-sm text-muted-foreground">This list was cut, so this agent is in or has left more workrooms than show here.</p> : null}
        {past.length > 0 ? (
          <div className="space-y-1">
            <h4 className="text-sm font-medium">Left</h4>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {past.map((room) => (
                <li key={room.workspace_id} className="break-words">
                  {roomLabel(room)}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Each shows the name it had when this agent left. This says nothing about the workroom since.</p>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">Workroom scopes are managed by each workroom's owner and admins.</p>
      </section>

      <InboxOversight key={agent.id} agent={agent} name={name} openable={agent.ownRooms ?? []} />

      <AlertDialog open={confirming !== null}>
        <AlertDialogContent
          onEscapeKeyDown={() => setConfirming(null)}
          onCloseAutoFocus={(event) => {
            // Back to what opened it, or, if that's gone, as after a disconnect, to the section it was in.
            event.preventDefault();
            const back = closedFrom.current;
            (back?.isConnected ? back : connectionHeading.current)?.focus();
          }}
        >
          {confirming?.kind === "disconnect" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="break-words">Disconnect “{name}” from every workroom?</AlertDialogTitle>
                <AlertDialogDescription>It loses access across all workrooms, and its credentials and wake end. Reconnecting later doesn't bring workroom access back.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirming(null)}>Keep connected</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirming(null);
                    void connection("disconnect");
                  }}
                >
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : confirming?.kind === "withdraw" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="break-words">
                  Withdraw “{name}” from “{roomLabel(confirming.room)}”?
                </AlertDialogTitle>
                <AlertDialogDescription>It loses access to this workroom now. It can come back only if the workroom invites it again and your organization accepts.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirming(null)}>Keep in workroom</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const { room } = confirming;
                    setConfirming(null);
                    void withdraw(room);
                  }}
                >
                  Withdraw
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
