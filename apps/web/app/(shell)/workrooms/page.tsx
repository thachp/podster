import Link from "next/link";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { roleLabel } from "../w/[id]/team/model";
import { plainLine } from "@/components/agent-content/text";
import { listedRoles, outputsReady, roleTotal, type WorkroomCard } from "./cards";
import { AdminsOnly, createAccess } from "./new/access";

type Listed = { workspace_id: string; workspace_name: string; role: string; status?: string; card: WorkroomCard | null };

function CardDetails({ card }: { card: WorkroomCard }) {
  const goal = card.goal ? plainLine(card.goal) : "";
  const listed = listedRoles(card.roles);
  const outputs = outputsReady(card.outputs);
  return (
    <>
      {goal ? (
        <p className="break-words text-sm">
          <span className="text-muted-foreground">Goal: </span>
          {goal}
          {card.goal_cut ? "…" : ""}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{roleTotal(card.roles)}</p>
      {listed ? (
        <p className="break-words text-sm">
          <span className="text-muted-foreground">Roles: </span>
          {listed}
        </p>
      ) : null}
      {outputs ? <p className="text-sm text-muted-foreground">{outputs}</p> : null}
    </>
  );
}

export default async function MyWorkrooms({ searchParams }: { searchParams?: Promise<{ offset?: string }> } = {}) {
  const offset = (await searchParams)?.offset;
  const read = `/api/v1/workspaces/cards${offset ? `?${new URLSearchParams({ offset })}` : ""}`;
  const [rooms, identity, organizations] = await Promise.all([gatewayQuery<{ workspaces: Listed[]; next_offset?: number }>(read), getIdentity(), getOrganizations()]);
  const access = createAccess(identity, organizations);
  // Rows come off a page after it's cut, so an empty page means no rooms only on the first page with nothing after it.
  const firstPageIsAll = rooms.ok && !(Number(offset) > 0) && !rooms.data.next_offset;
  return (
    <section className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">My workrooms</h1>
        {access.state === "refused" ? null : (
          <Button asChild>
            <Link href="/workrooms/new" prefetch={false}>
              Create a workroom
            </Link>
          </Button>
        )}
      </div>
      {access.state === "refused" ? <AdminsOnly organization={access.organization} adminOf={access.adminOf} /> : null}
      {!rooms.ok ? <ReadFailure /> : null}
      {rooms.ok && rooms.data.workspaces.length === 0 && !firstPageIsAll ? <p className="text-muted-foreground">No workrooms to show on this page.</p> : null}
      {rooms.ok && rooms.data.workspaces.length === 0 && firstPageIsAll ? <p className="text-muted-foreground">{access.state === "refused" ? "You aren't in a workroom yet." : "You aren't in a workroom yet. Create one, then add your agents or invite another organization."}</p> : null}
      {rooms.ok && rooms.data.workspaces.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {rooms.data.workspaces.map((room) => (
            <li key={room.workspace_id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/w/${room.workspace_id}/overview`} prefetch={false} className="min-w-0 break-words font-medium text-primary underline">
                  {room.workspace_name}
                </Link>
                <span className="flex flex-wrap gap-2">
                  {room.card?.external ? <Badge variant="outline">External</Badge> : null}
                  {room.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
                  <Badge variant="secondary">{roleLabel(room.role)}</Badge>
                </span>
              </div>
              {room.card ? <CardDetails card={room.card} /> : (
                <p className="text-sm text-muted-foreground">Couldn't load this workroom's goal and roles.</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {rooms.ok && rooms.data.next_offset ? (
        <Link href={`/workrooms?offset=${rooms.data.next_offset}`} prefetch={false} className="inline-flex min-h-6 items-center text-sm text-primary underline">
          More workrooms
        </Link>
      ) : null}
      {rooms.ok ? <p className="text-sm text-muted-foreground">A new workroom can take a moment to appear here.</p> : null}
    </section>
  );
}
