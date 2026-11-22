import { gatewayQuery, getOrganizations, requireSession } from "@/lib/gateway/server";
import type { AcceptAgent } from "./accept-form";
import { InvitationScreen } from "./invitation-screen";

export default async function InvitationPage({ params, searchParams }: { params: Promise<{ token?: string }>; searchParams: Promise<Record<string, string>> }) {
  const [{ token = "" }, query] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams(query).toString();
  await requireSession(`/invitations/${token}${search ? `?${search}` : ""}`);
  const [organizations, agents] = await Promise.all([getOrganizations(), gatewayQuery<{ agents: (AcceptAgent & { revoked_at: number | null })[]; truncated?: boolean }>("/api/agents")]);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Workroom invitation</h1>
      <InvitationScreen
        token={token}
        form={
          organizations.ok && agents.ok
            ? { organizations: organizations.data.organizations.filter((org) => org.role === "admin").map(({ id, name }) => ({ id, name })), agents: agents.data.agents.filter((agent) => agent.revoked_at === null).map(({ id, name, org_id }) => ({ id, name, org_id })), partial: agents.data.truncated === true }
            : null
        }
        people={{
          orgNames: organizations.ok ? Object.fromEntries(organizations.data.organizations.map((org) => [org.id, org.name])) : {},
          personal: organizations.ok ? (organizations.data.organizations.find((org) => org.personal === 1)?.id ?? null) : null,
        }}
      />
    </section>
  );
}
