"use client";

import { useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { clientQuery } from "@/lib/gateway/client";
import type { OversightRoom } from "../../../agents/model";
import { loadNames, orgNamesOf } from "../../../w/[id]/tasks/load-tasks";
import type { Names, Task } from "../../../w/[id]/tasks/task-model";
import { OverseenTasks } from "./overseen-tasks";

type Result = { tasks: Task[]; next_cursor: string | null };
type Org = { id: string; name: string; personal: number };

/**
 * Nothing about oversight shows until a read has succeeded: a failed one says nothing about whether this viewer has it, and
 * anyone can cause one. After that, a failure keeps what's on screen, an open Sheet included. Names and the room's label
 * are read here once, because the page runs again on every navigation, and they only name things.
 */
export function OversightScreen({ workspace, agent, result, me, orgs }: { workspace: string; agent: string; result: Result | null; me: string; orgs: Org[] }) {
  const lastGood = useRef(result);
  if (result) lastGood.current = result;
  const shown = lastGood.current;
  const allowed = shown !== null;

  const [names, setNames] = useState<Names>({});
  const [roomName, setRoomName] = useState<string | null>(null);
  const orgsRef = useRef(orgs);
  orgsRef.current = orgs;

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    void loadNames(clientQuery, orgsRef.current)
      .then((loaded) => {
        if (current) setNames(loaded);
      })
      .catch(() => undefined);
    void clientQuery<{ rooms: OversightRoom[] }>("/api/v1/oversight/rooms")
      .then((rooms) => {
        // The listing can lag, and then this shows the ID.
        const row = rooms.ok ? rooms.data.rooms.find((entry) => entry.workspace_id === workspace && entry.agent_id === agent) : undefined;
        if (current && row) setRoomName(row.workspace_name);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [allowed, workspace, agent]);

  if (!shown) return <ReadFailure />;

  const roomLabel = roomName === null ? workspace : plainName(roomName);
  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold break-words">Viewing as: {plainName(names[agent] ?? agent)} · read-only oversight</h1>
        <p className="break-words text-muted-foreground">Workroom: {roomLabel}</p>
      </header>
      <p className="rounded-lg border bg-muted/40 p-3 text-sm">This shows what this agent sees of the tasks it's party to, because you administer its organization. It gives you no role in this workroom, doesn't show its other tasks or people, and can't change anything.</p>
      {result === null ? <ReadFailure /> : null}
      <OverseenTasks workspace={workspace} agent={agent} workspaceLabel={roomLabel} initial={shown.tasks} initialCursor={shown.next_cursor} me={me} names={names} orgNames={orgNamesOf(orgs)} />
    </>
  );
}
