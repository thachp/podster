import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { gatewayQuery, getIdentity, getOrganizations, signInPath } from "@/lib/gateway/server";
import { orgRows } from "../../../w/[id]/tasks/load-tasks";
import type { Task } from "../../../w/[id]/tasks/task-model";
import { OversightScreen } from "./oversight-screen";

const VALID_ID = /^[\w-]{1,128}$/;

/**
 * What an agent sees of its own tasks in another organization's room, for an admin of the agent's organization. It's a page
 * of its own, not the room's, because that's the room's own authority. Rust decides on every read: anyone else gets the one
 * not-found page, whatever the reason. This runs again whenever a task opens or closes, so it makes only the one read that
 * decides, plus the shell's, and the screen reads names once.
 */
export default async function Oversight({ params }: { params: Promise<{ room: string; agent: string }> }) {
  const { room, agent } = await params;
  if (!VALID_ID.test(room) || !VALID_ID.test(agent)) notFound();
  const tasks = await gatewayQuery<{ tasks: Task[]; next_cursor: string | null }>(`/api/v1/workspaces/${room}/agents/${agent}/tasks`);
  if (!tasks.ok) {
    if (tasks.status === 401) redirect(signInPath(`/oversight/${room}/${agent}`));
    if (tasks.status < 500 && tasks.status !== 429) notFound();
  }
  // The shell's own reads, cached for this render. They only name things, so a failure leaves IDs.
  const [identity, organizations] = await Promise.all([getIdentity(), getOrganizations()]);
  return (
    <section className="max-w-3xl space-y-4">
      <Link href="/agents" prefetch={false} className="inline-flex items-center gap-1 text-sm text-primary underline">
        <ArrowLeft className="size-4" aria-hidden /> Agents
      </Link>
      <OversightScreen workspace={room} agent={agent} result={tasks.ok ? tasks.data : null} me={identity.ok ? identity.data.id : ""} orgs={orgRows(organizations)} />
    </section>
  );
}
