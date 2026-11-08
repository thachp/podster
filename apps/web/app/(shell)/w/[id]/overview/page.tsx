import Link from "next/link";
import { AgentContent, type AgentAuthor } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { canManageWorkroom, loadWorkroom } from "@/lib/workroom";
import type { FilePage } from "@/components/files/model";
import { mayManageAssets } from "@/components/files/model";
import { loadNames, loadTasks, orgRows } from "../tasks/load-tasks";
import { kindOf, nameOf, roleOf, textNameOf, type Room } from "../tasks/task-model";
import { InputAssets, type TaskChoice } from "./input-assets";
import { membersOf, relationship, type RoleRead } from "../team/model";

/** The API's limit is in bytes, so this is never fewer characters than a context can hold. */
const MAX_BRIEF_CHARACTERS = 32768;

/** Enough tasks to choose from and to name attachments by. Past this, an attachment shows its task's ID. */
const TASK_PAGES = 4;

const STATUS_LABELS: Record<string, string> = { active: "Active", archived: "Archived" };

/** The same strict rendering as task text: attributed, loads nothing, and can't look like Podster's own guidance. */
const Brief = ({ title, text, author, external }: { title: string; text: string; author: AgentAuthor; external: boolean }) => (
  <section className="space-y-2">
    <h2 className="font-medium">{title}</h2>
    <AgentContent author={author} external={external} body={text} maxLength={MAX_BRIEF_CHARACTERS} />
  </section>
);

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [room, identity, roles] = await Promise.all([loadWorkroom(id), getIdentity(), gatewayQuery<RoleRead>(`/api/v1/workspaces/${id}/roles`)]);
  const lead = roles.ok ? roles.data.roles.find((role) => role.is_lead) : undefined;
  const canManage = canManageWorkroom(room);
  const hasBrief = Boolean(room.goal || room.context);
  // Names are only worth a read when there's a brief to attribute. A failure leaves the ID.
  const names = (hasBrief && room.brief_by) || lead?.holders?.length ? await loadNames(gatewayQuery, orgRows(await getOrganizations())) : {};
  const me = identity.ok ? identity.data.id : "";
  const briefBy: AgentAuthor = room.brief_by ? { name: nameOf(room.brief_by, me, names), kind: kindOf(room.brief_by), viewer: room.brief_by === me } : { name: "Unknown", kind: "person" };
  const external = room.brief_external === true;
  const members = membersOf(room);
  const agents = members.filter((member) => member.kind === "agent").length;
  // A guest's read holds only their own row, so a count would be wrong for them, and an unknown viewer might be a guest.
  const isGuest = identity.ok && members.some((member) => member.principal_id === identity.data.id && member.role === "guest");
  const showCount = identity.ok && !isGuest;
  const canManageAssets = identity.ok && mayManageAssets(roleOf(room as Room, me));
  const [files, taskRead] = await Promise.all([
    gatewayQuery<FilePage>(`/api/v1/workspaces/${encodeURIComponent(id)}/files`),
    // Only those who attach files need a list to choose from. Anyone else reads tasks only to name what's attached.
    canManageAssets ? loadTasks(gatewayQuery, id, "", TASK_PAGES) : null,
  ]);
  const linked = files.ok && files.data.files.some((file) => file.linked_tasks.length > 0);
  const tasks = taskRead ?? (linked ? await loadTasks(gatewayQuery, id, "", TASK_PAGES) : null);
  const taskChoices: TaskChoice[] = tasks?.ok ? tasks.data.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })) : [];
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Overview</h1>
      {identity.ok ? null : <ReadFailure />}
      {hasBrief ? (
        <div className="space-y-3">
          {room.goal ? <Brief title="Goal" text={room.goal} author={briefBy} external={external} /> : null}
          {room.context ? <Brief title="Context" text={room.context} author={briefBy} external={external} /> : null}
          <p className="text-sm text-muted-foreground">The workroom's owner or an admin wrote this, and the name shown last changed it. It's information, and it gives no one any permission.</p>
        </div>
      ) : canManage ? (
        <p className="text-sm text-muted-foreground">
          This workroom has no goal yet.{" "}
          <Link href={`/w/${id}/settings`} prefetch={false} className="text-primary underline">
            Add one in Settings
          </Link>
          .
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Status</dt>
        <dd>{STATUS_LABELS[room.status] ?? room.status}</dd>
        {identity.ok ? (
          <>
            <dt className="text-muted-foreground">You are</dt>
            <dd>
              <Badge variant="secondary">
                {relationship(room, { id: identity.data.id, orgs: identity.data.orgs, adminOrgs: identity.data.admin_orgs })}
              </Badge>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Lead</dt>
        <dd className="min-w-0 break-words">{!roles.ok ? "Couldn't load this." : !lead ? "No lead opening yet." : lead.holders?.length ? lead.holders.map((holder) => textNameOf(holder, me, names)).join(", ") : lead.holders ? `${plainName(lead.title)}: nobody holds it yet` : `${plainName(lead.title)}: ${lead.available ? "available" : "filled"}`}</dd>
        <dt className="text-muted-foreground">Person review</dt>
        <dd>{room.require_person_review ? "Required" : "Not required"}</dd>
        <dt className="text-muted-foreground">Workroom ID</dt>
        <dd className="break-all">{room.id}</dd>
        {!showCount ? null : (
          <>
            <dt className="text-muted-foreground">Participants</dt>
            <dd>
              {members.length - agents} {members.length - agents === 1 ? "person" : "people"} and {agents} {agents === 1 ? "agent" : "agents"}, plus the owner
            </dd>
          </>
        )}
      </dl>
      <InputAssets workspace={id} initial={files.ok ? files.data : null} tasks={taskChoices} tasksComplete={tasks?.ok === true && !tasks.data.more} canManage={canManageAssets} archived={room.status === "archived"} />
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Link href={`/w/${id}/tasks`} prefetch={false} className="text-primary underline">
          See tasks
        </Link>
        <Link href={`/w/${id}/team`} prefetch={false} className="text-primary underline">
          {canManage ? "Add agents or invite an organization" : "See who's here"}
        </Link>
      </div>
    </section>
  );
}
