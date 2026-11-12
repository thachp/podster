import Link from "next/link";
import { notFound } from "next/navigation";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { canManageWorkroom, isArchived, loadWorkroom } from "@/lib/workroom";
import { auditAction, auditTarget, pageAfter } from "../activity/model";
import { loadPeopleNames } from "../tasks/load-tasks";
import { Time } from "../activity/time";
import { membersOf, type AuditRow } from "../team/model";
import { BriefControls } from "./brief-controls";
import { ReviewPolicy } from "./review-policy";
import { RoomControls } from "./room-controls";
import { TransferOwnership } from "./transfer-ownership";
import { VisibilityControls } from "./visibility-controls";
import { RepositorySection } from "./repository-section";
import { availability, type RoomRepository } from "./repository-model";
import { ReleaseSection } from "./release-section";
import { releaseView, type AppHostname, type ReleaseConfig } from "./release-model";
import type { RoomVisibility } from "./visibility-model";

const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
  <section aria-labelledby={id} className="space-y-2">
    <h2 id={id} className="text-lg font-medium">
      {title}
    </h2>
    {children}
  </section>
);

export default async function Settings({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const room = await loadWorkroom(id);
  // Owner and admins only. For anyone else this page isn't there; the API refuses the writes either way.
  if (!canManageWorkroom(room) || room.policy_version === null) notFound();
  const after = pageAfter(query.after);
  // The repository read is also how this page learns whether managed repositories are switched on: off, it answers as a
  // route that doesn't exist, and the page stays as it was before them.
  // Release's configuration read says the same of release (M6): off, it answers as a route that doesn't exist.
  const [identity, audit, visibility, repositoryRead, releaseRead] = await Promise.all([
    getIdentity(),
    gatewayQuery<{ audit: AuditRow[]; next_cursor: number | null }>(`/api/v1/workspaces/${id}/audit?after=${after}`),
    gatewayQuery<RoomVisibility>(`/api/v1/workspaces/${id}/visibility`),
    gatewayQuery<RoomRepository>(`/api/v1/workspaces/${id}/repository`),
    gatewayQuery<ReleaseConfig>(`/api/v1/workspaces/${id}/release-config`),
  ]);
  const repository = availability(repositoryRead);
  const release = releaseView(availability(releaseRead), {
    isPublic: visibility.ok ? visibility.data.visibility === "public" : null,
    repositoryReady: repository.kind === "on" ? repository.data.repository?.status === "ready" : null,
  });
  // The custom domain is read only where release answers at all.
  const hostnameRead = release.state === "unavailable" || release.state === "failed" ? null : await gatewayQuery<AppHostname>(`/api/v1/workspaces/${id}/app-hostname`);
  const hostname = hostnameRead === null ? null : hostnameRead.ok ? hostnameRead.data : "failed";
  const admins = membersOf(room).filter((member) => member.role === "admin");
  const isOwner = identity.ok && identity.data.id === room.owner;
  // Only what to offer. Rust checks all of this again when asked.
  const heirs = membersOf(room).filter((member) => member.role === "admin" && member.kind === "person" && member.org_id === room.owner_org);
  // Names are only worth a read for someone choosing one. A failure leaves IDs.
  const organizations = isOwner && heirs.length > 0 ? await getOrganizations() : null;
  const names = organizations?.ok ? await loadPeopleNames(gatewayQuery, organizations.data.organizations) : {};
  const candidates = heirs.map((member) => ({ id: member.principal_id, name: names[member.principal_id] ?? null }));
  const now = Date.now();
  return (
    <section className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Section id="settings-general" title="General">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Status</dt>
          <dd>{isArchived(room) ? "Archived" : "Active"}</dd>
          <dt className="text-muted-foreground">Visibility</dt>
          <dd>{visibility.ok ? (visibility.data.visibility === "public" ? "Public" : "Private") : "Couldn't read it"}</dd>
        </dl>
        <RoomControls roomId={id} name={room.name} policyVersion={room.policy_version} archived={isArchived(room)} />
      </Section>

      <Section id="settings-visibility" title="Visibility">
        {visibility.ok ? <VisibilityControls roomId={id} state={visibility.data} isOwner={isOwner} archived={isArchived(room)} /> : <ReadFailure />}
      </Section>

      <Section id="settings-brief" title="Goal and context">
        <BriefControls roomId={id} goal={room.goal ?? null} context={room.context ?? null} policyVersion={room.policy_version} archived={isArchived(room)} />
      </Section>

      <Section id="settings-review" title="Review">
        <ReviewPolicy roomId={id} requirePerson={room.require_person_review === true} policyVersion={room.policy_version} archived={isArchived(room)} />
      </Section>

      <Section id="settings-admins" title="Administrators">
        <p className="text-sm text-muted-foreground">Admins manage agents' access in this workroom. Only the owner appoints or removes them.</p>
        {admins.length === 0 ? <p>This workroom has no admins besides its owner.</p> : null}
        {admins.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {admins.map((admin) => (
              <li key={admin.principal_id} className="p-3">
                <AuthorLine author={{ name: identity.ok && admin.principal_id === identity.data.id ? "You" : admin.principal_id, kind: "person", viewer: identity.ok && admin.principal_id === identity.data.id }} />
              </li>
            ))}
          </ul>
        ) : null}
        {identity.ok ? null : <ReadFailure />}
        {isOwner ? (
          <Link href={`/w/${id}/team`} prefetch={false} className="text-primary underline">
            Appoint or remove admins on Team
          </Link>
        ) : null}
      </Section>

      <Section id="settings-ownership" title="Ownership">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="break-all">{isOwner ? "You" : room.owner}</dd>
        </dl>
        {typeof room.owner_left_at === "number" ? (
          <p className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
            The owner left this workroom's organization on {new Date(room.owner_left_at).toISOString().slice(0, 10)}. An admin of that organization can name a new owner from its settings, whether or not they're in this workroom.
          </p>
        ) : null}
        <TransferOwnership roomId={id} name={room.name} policyVersion={room.policy_version} archived={isArchived(room)} isOwner={isOwner} candidates={candidates} />
      </Section>

      {repository.kind === "off" && release.state === "unavailable" ? (
        <Section id="settings-services" title="Repository and release">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Not connected</Badge>
            <span className="text-sm text-muted-foreground">Podster doesn't connect repositories or deployments yet, so nothing in this workroom grants them.</span>
          </div>
        </Section>
      ) : (
        <>
          <Section id="settings-repository" title="Repository">
            {repository.kind === "on" ? <RepositorySection roomId={id} state={repository.data} runsRepository={!isOwner || typeof room.owner_left_at !== "number"} archived={isArchived(room)} /> : null}
            {repository.kind === "failed" ? <ReadFailure /> : null}
            {repository.kind === "off" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">Not connected</Badge>
                <span className="text-sm text-muted-foreground">Podster doesn't connect repositories yet, so nothing in this workroom grants one.</span>
              </div>
            ) : null}
          </Section>
          <Section id="settings-release" title="Release">
            {/* This page is the owner's and admins' alone, and agents have no dashboard, so whoever reads it may configure; Rust checks again. */}
            <ReleaseSection roomId={id} view={release} hostname={hostname} mayConfigure archived={isArchived(room)} />
          </Section>
        </>
      )}

      <Section id="settings-history" title="Access history">
        <p className="text-sm text-muted-foreground">Every change to who's here and what they can do. Nobody can edit it.</p>
        {audit.ok ? (
          <>
            <ol className="divide-y rounded-lg border empty:hidden">
              {audit.data.audit.map((row) => (
                <li key={row.id} className="space-y-0.5 p-3 text-sm">
                  <p className="break-words">
                    <span className="break-all font-medium">{row.actor_id}</span> · {auditAction(row.action)} <span className="break-all">{auditTarget(row.action, row.target_id)}</span>
                  </p>
                  <p className="text-muted-foreground">
                    <Time at={row.created_at} now={now} />
                  </p>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-4">
              {after > 0 ? (
                <Link href={`/w/${id}/settings`} prefetch={false} className="text-primary underline">
                  Back to the start
                </Link>
              ) : null}
              {audit.data.next_cursor !== null ? (
                <Link href={`/w/${id}/settings?after=${audit.data.next_cursor}`} prefetch={false} className="text-primary underline">
                  Later changes
                </Link>
              ) : null}
            </div>
          </>
        ) : (
          <ReadFailure />
        )}
      </Section>
    </section>
  );
}
