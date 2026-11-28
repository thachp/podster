import Link from "next/link";
import { gatewayQuery } from "@/lib/gateway/server";
import { canManageWorkroom, isArchived, loadWorkroom } from "@/lib/workroom";
import type { GatewayResult } from "@/lib/gateway/result";
import { loadTasks } from "../tasks/load-tasks";
import type { RoomRepository } from "../settings/repository-model";
import type { RoomVisibility } from "../settings/visibility-model";
import { previewRead } from "./preview-model";
import { PreviewSection } from "./preview-section";

/** A read that threw, such as a lost connection, is a failed read: its section says so, and the page still renders. */
const settled = <T,>(read: Promise<GatewayResult<T>>) => read.catch((): GatewayResult<T> => ({ ok: false, status: 0, code: "read_failed" }));

/** Enough finished tasks to choose a preview from. Past this, the newest are offered. */
const TASK_PAGES = 2;

/**
 * Ship (M8 step 11; docs/m8-preview-plan.md section 10): the room's preview, for anyone the room lets read it. Every
 * control follows an API answer: the preview read says what there is, the release configuration answering this viewer
 * says they're the room's owner or an admin as a person, and the visibility read says whether the room may publish.
 */
export default async function Ship({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const ws = encodeURIComponent(id);
  const [previewAnswer, releaseConfig] = await Promise.all([settled(gatewayQuery<unknown>(`/api/v1/workspaces/${ws}/preview`)), settled(gatewayQuery<unknown>(`/api/v1/workspaces/${ws}/release-config`))]);
  const read = previewRead(previewAnswer);
  const manages = releaseConfig.ok;
  // Only read further where there is a preview card to show.
  const shows = read.kind === "read";
  const [visibility, repository, tasks] = await Promise.all([
    shows && manages ? settled(gatewayQuery<RoomVisibility>(`/api/v1/workspaces/${ws}/visibility`)) : null,
    shows ? settled(gatewayQuery<RoomRepository>(`/api/v1/workspaces/${ws}/repository`)) : null,
    shows ? settled(loadTasks(gatewayQuery, id, "&status=completed&order=newest", TASK_PAGES)) : null,
  ]);
  const isPublic = visibility?.ok ? visibility.data.visibility === "public" : null;
  const fullName = repository?.ok ? (repository.data.repository?.full_name ?? null) : null;
  const finished = tasks?.ok ? tasks.data.tasks.filter((task) => task.status === "completed") : [];
  const taskTitles = Object.fromEntries(finished.map((task) => [task.id, task.title]));
  return (
    <section className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Ship</h1>
      <section aria-labelledby="ship-preview" className="space-y-2">
        <h2 id="ship-preview" className="text-lg font-medium">
          Preview
        </h2>
        <PreviewSection roomId={id} read={read} manages={manages} isPublic={isPublic} archived={isArchived(room)} repository={fullName} tasks={finished.map((task) => ({ id: task.id, title: task.title }))} taskTitles={taskTitles} />
      </section>
      <section aria-labelledby="ship-production" className="space-y-2">
        <h2 id="ship-production" className="text-lg font-medium">
          Production
        </h2>
        <p className="text-sm text-muted-foreground">
          Production is released from merged code, and each release is approved by the owner or an admin in Needs attention.{" "}
          {canManageWorkroom(room) ? (
            <Link href={`/w/${id}/settings`} prefetch={false} className="text-primary underline">
              Release settings
            </Link>
          ) : null}
        </p>
      </section>
    </section>
  );
}
