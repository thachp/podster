import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { canManageWorkroom, isArchived, loadWorkroom } from "@/lib/workroom";
import { loadNames, loadTasks, orgNamesOf, orgRows } from "../tasks/load-tasks";
import type { Room } from "../tasks/task-model";
import { NEWEST_QUERY } from "../tasks/task-views";
import type { OutputsRead } from "./artifacts-model";
import { ArtifactsScreen } from "./artifacts-screen";

/**
 * One read of the room's outputs, which every participant may make (decision 54), and one page of tasks, only to name the
 * task an output's current version came from. A task that isn't in that page shows by its ID: the output read already decided
 * whether the viewer may know it.
 */
export async function ArtifactsRead({ id }: { id: string }) {
  const orgs = orgRows(await getOrganizations());
  const [room, identity, outputs, tasks, names] = await Promise.all([loadWorkroom(id), getIdentity(), gatewayQuery<OutputsRead>(`/api/v1/workspaces/${encodeURIComponent(id)}/outputs`), loadTasks(gatewayQuery, id, NEWEST_QUERY), loadNames(gatewayQuery, orgs)]);
  if (!identity.ok || !outputs.ok) {
    return (
      <section className="max-w-3xl space-y-2">
        <h1 className="text-2xl font-semibold">Artifacts</h1>
        <ReadFailure />
      </section>
    );
  }
  const taskTitles = tasks.ok ? Object.fromEntries(tasks.data.tasks.map((task) => [task.id, task.title])) : {};
  return (
    <ArtifactsScreen
      room={room as Room}
      read={outputs.data}
      me={identity.data.id}
      names={names}
      orgNames={orgNamesOf(orgs)}
      taskTitles={taskTitles}
      // Shows the controls. The API refuses anyone else, an agent stored as an admin included.
      canManage={canManageWorkroom(room)}
      archived={isArchived(room)}
    />
  );
}
