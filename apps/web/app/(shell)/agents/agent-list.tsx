"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AgentContent, AuthorLine } from "@/components/agent-content/agent-content";
import { SheetLink } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clientQuery } from "@/lib/gateway/client";
import { ConnectionBadge } from "./connection-badge";
import { onStatusAnnounced, type AgentConnection, type ConnectionStatus, type DirectoryAgent } from "./model";

export type AgentRow = {
  agent: DirectoryAgent;
  organization: string | undefined;
  /** Whether the viewer administers this agent's organization. The server decides again on every read and command. */
  canOpen: boolean;
};

/** Connection state takes one read per row, so a long list can't spend the person's rate limit. */
export const MAX_STATUS_READS = 12;

/**
 * Connection state, read once per agent. It's here rather than in the layout because the layout runs again on every
 * navigation, Sheets included. It's never guessed from the directory, whose `revoked_at` is set before a disconnect finishes.
 */
function useStatuses(rows: AgentRow[]) {
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus | null>>({});
  const asked = useRef(new Set<string>());
  const ids = rows.filter((row) => row.canOpen).map((row) => row.agent.id);
  const key = ids.join();

  useEffect(() => {
    for (const id of ids) {
      if (asked.current.has(id)) continue;
      if (asked.current.size >= MAX_STATUS_READS) {
        setStatuses((previous) => (id in previous ? previous : { ...previous, [id]: null }));
        continue;
      }
      asked.current.add(id);
      void clientQuery<AgentConnection>(`/api/agents/${encodeURIComponent(id)}`)
        .catch(() => null)
        .then((result) => setStatuses((previous) => (previous[id] ? previous : { ...previous, [id]: result?.ok ? result.data.status : null })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => onStatusAnnounced((id, status) => setStatuses((previous) => ({ ...previous, [id]: status }))), []);
  return statuses;
}

export function AgentList({ rows, truncated, canConnect }: { rows: AgentRow[]; truncated: boolean; canConnect: boolean }) {
  const statuses = useStatuses(rows);
  if (rows.length === 0) {
    return <p className="text-muted-foreground">{canConnect ? "Your organizations have no agents yet. Add one to give it an identity here." : "Your organizations have no agents yet. An organization admin can add one."}</p>;
  }
  return (
    <>
      <ul className="divide-y rounded-lg border">
        {rows.map(({ agent, organization, canOpen }) => {
          const status = statuses[agent.id];
          const author = { name: agent.name, kind: "agent" as const, organization };
          return (
            <li key={agent.id} className="min-w-0 space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {canOpen ? (
                  <SheetLink param="agent" target={agent.id} className="min-w-0 rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none">
                    <AuthorLine author={author} />
                  </SheetLink>
                ) : (
                  <AuthorLine author={author} />
                )}
                {!canOpen ? (
                  <span className="text-xs text-muted-foreground">Details are for this organization's admins</span>
                ) : status === undefined ? (
                  <Skeleton aria-hidden className="h-5 w-20" />
                ) : status === null ? (
                  <span className="text-xs text-muted-foreground">Open for status</span>
                ) : (
                  <ConnectionBadge status={status} />
                )}
              </div>
              {agent.description ? <AgentContent author={author} body={agent.description} maxLength={200} /> : null}
            </li>
          );
        })}
      </ul>
      {truncated ? <p className="text-sm text-muted-foreground">Showing the newest 500 agents. There are more, and there's no way to page to them yet.</p> : null}
    </>
  );
}

/** Opens the one Sheet for adding an agent: Runner pairing first, connecting an agent you already run second. */
export function ConnectLink() {
  return (
    <Button asChild className="min-h-11 sm:min-h-9">
      <Link href="/agents/connect" prefetch={false} scroll={false} data-connect-launcher>
        Add an agent
      </Link>
    </Button>
  );
}
