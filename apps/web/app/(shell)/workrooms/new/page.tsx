import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { setupRelease, type ReleaseSwitch } from "../../w/[id]/settings/release-model";
import { AdminsOnly, createAccess } from "./access";
import { CreateWorkroomForm } from "./create-form";

export default async function NewWorkroom() {
  const [identity, organizations] = await Promise.all([getIdentity(), getOrganizations()]);
  // The server takes the organization from who's asking, so this only says which one that is.
  const acting = identity.ok && organizations.ok ? organizations.data.organizations.find((org) => org.id === identity.data.org_id) : undefined;
  const organization = acting?.name ?? null;
  const access = createAccess(identity, organizations);
  // Release's state at setup is the organization's release switch, which answers as a route that doesn't exist while
  // release is off for the deployment. Only someone who may create here reads it; a read that throws is "couldn't check".
  const release =
    access.state === "refused" || !identity.ok
      ? null
      : setupRelease(await gatewayQuery<ReleaseSwitch>(`/api/v1/orgs/${encodeURIComponent(identity.data.org_id)}/release-delegation`).catch(() => null));
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Create a workroom</h1>
      {access.state === "refused" ? (
        <AdminsOnly organization={access.organization} adminOf={access.adminOf} />
      ) : (
        <>
          {access.state === "unknown" ? <p className="text-sm text-muted-foreground">We couldn't check your role just now. Only an organization's admins can create its workrooms, and Podster checks that when you create one.</p> : null}
          <CreateWorkroomForm organization={organization} personal={Boolean(acting?.personal)} release={release ?? "unknown"} />
        </>
      )}
    </section>
  );
}
