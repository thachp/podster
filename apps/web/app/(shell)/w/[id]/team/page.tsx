import { ReadFailure } from "@/components/shell/read-failure";
import { getIdentity, getOrganizations, gatewayQuery } from "@/lib/gateway/server";
import { canManageWorkroom, isArchived, loadWorkroom } from "@/lib/workroom";
import { loadPeopleNames } from "../tasks/load-tasks";
import { addableAgents, membersOf, toPending, type InvitationRow, type RoleRead } from "./model";
import { TeamScreen, type AgentOption } from "./team-screen";
import { RepositoryGrants } from "./repository-grants";
import { availability, type RepoGrant, type RoomRepository } from "../settings/repository-model";

type AgentRow = AgentOption & { revoked_at: number | null };

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const canManage = canManageWorkroom(room);
  const [identity, organizations, agents, invitations, roles] = await Promise.all([
    getIdentity(),
    getOrganizations(),
    gatewayQuery<{ agents: AgentRow[]; truncated?: boolean }>("/api/agents"),
    canManage ? gatewayQuery<{ invitations: InvitationRow[]; truncated: boolean }>(`/api/v1/workspaces/${id}/invitations`) : null,
    gatewayQuery<RoleRead>(`/api/v1/workspaces/${id}/roles`),
  ]);
  if (!identity.ok) {
    return (
      <section className="max-w-3xl space-y-2">
        <h1 className="text-2xl font-semibold">Team</h1>
        <ReadFailure />
      </section>
    );
  }
  const orgs = organizations.ok ? organizations.data.organizations : [];
  const agentRows = agents.ok ? agents.data.agents : [];
  const people = await loadPeopleNames(gatewayQuery, orgs);
  const roomOrg = room.owner_org ?? null;
  // The grants read is also how this page learns whether managed repositories are switched on: off, it answers as a route
  // that doesn't exist and nothing about repositories shows. Only then is the repository read spent, and only by those who
  // manage access, to learn whether the room has a repository to grant on.
  const grants = availability(await gatewayQuery<{ grants: RepoGrant[] }>(`/api/v1/workspaces/${id}/repository/grants`));
  const repository = grants.kind === "on" && canManage ? availability(await gatewayQuery<RoomRepository>(`/api/v1/workspaces/${id}/repository`)) : null;
  const linked = repository?.kind === "on" ? repository.data.repository !== null : null;
  const isOwner = identity.data.id === room.owner && typeof room.owner_left_at !== "number";
  const names = { ...people, ...Object.fromEntries(agentRows.map((agent) => [agent.id, agent.name])) };
  const team = (
    <TeamScreen
      roomId={id}
      roomName={room.name}
      archived={isArchived(room)}
      owner={room.owner}
      policyVersion={canManage ? room.policy_version : null}
      members={membersOf(room)}
      viewer={{ id: identity.data.id, orgs: identity.data.orgs, adminOrgs: identity.data.admin_orgs }}
      // Only what the viewer's own organizations can name. Other organizations' names have no read yet, so they show as IDs.
      names={names}
      orgNames={Object.fromEntries(orgs.map((org) => [org.id, org.name]))}
      orgs={organizations.ok ? orgs.map(({ id: orgId, name }) => ({ id: orgId, name })) : null}
      // Without knowing the room's organization, listing every agent would offer ones the server refuses, so this reads as a failure.
      agents={agents.ok && roomOrg ? addableAgents(agentRows, roomOrg) : null}
      agentsPartial={agents.ok && agents.data.truncated === true}
      roles={roles.ok ? roles.data : null}
      invitations={invitations?.ok ? { pending: invitations.data.invitations.map(toPending), complete: !invitations.data.truncated } : null}
    />
  );
  if (grants.kind === "off" || (grants.kind === "on" && linked !== true && grants.data.grants.length === 0)) return team;
  return (
    <div className="space-y-8">
      {team}
      {grants.kind === "on" ? (
        <RepositoryGrants
          roomId={id}
          grants={grants.data.grants}
          linked={linked}
          isOwner={isOwner}
          isOrgAdmin={roomOrg !== null && identity.data.admin_orgs.includes(roomOrg)}
          viewerId={identity.data.id}
          policyVersion={canManage ? room.policy_version : null}
          archived={isArchived(room)}
          members={membersOf(room)}
          names={names}
        />
      ) : (
        <section className="max-w-3xl space-y-2">
          <h2 className="text-lg font-medium">Repository access</h2>
          <ReadFailure />
        </section>
      )}
    </div>
  );
}
