import type { GatewayResult } from "@/lib/gateway/result";
import type { PlanRead } from "./plan-summary";
import type { Names, Task } from "./task-model";

type Query = <T>(path: string) => Promise<GatewayResult<T>>;

/**
 * The tasks the viewer may see, as far as `maxPages` of 50. The Tasks page reads one and loads the rest as the person
 * reaches them, from `cursor`. A failure on any page fails the read, rather than looking like a shorter list.
 */
export async function loadTasks(query: Query, workspace: string, filter = "", maxPages = 1): Promise<GatewayResult<{ tasks: Task[]; more: boolean; cursor: string | null }>> {
  const tasks: Task[] = [];
  let cursor: string | null = "";
  for (let page = 0; page < maxPages && cursor !== null; page += 1) {
    const result: GatewayResult<{ tasks: Task[]; next_cursor: string | null }> = await query(`/api/v1/workspaces/${encodeURIComponent(workspace)}/tasks?cursor=${encodeURIComponent(cursor)}${filter}`);
    if (!result.ok) return result;
    tasks.push(...result.data.tasks);
    cursor = result.data.next_cursor;
  }
  return { ok: true, data: { tasks, more: cursor !== null, cursor } };
}

/**
 * One read of the room's plan, to boil down on the server with `planSummary`, so the browser never holds it. It only adds to
 * the page: a failure leaves the counts of what's loaded, labeled partial. It decides nothing about access.
 */
export const loadPlan = (query: Query, workspace: string) => query<PlanRead>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/plan`);

/** Whether a failed read says nothing about access. A success doesn't either, for checking several reads at once. */
export const isOutage = (result: GatewayResult<unknown>) => result.ok || result.status >= 500 || result.status === 429;

type OrgRow = { id: string; name: string; personal: number };

/** One read per organization, however many rows a screen has. Past this many, people there show as IDs. */
export const MAX_NAMED_ORGS = 5;

/**
 * People in the viewer's own organizations, which any member may list. A personal organization holds only its owner, who
 * shows as "You", so it costs no read. A failure just leaves IDs.
 */
export async function loadPeopleNames(query: Query, orgs: OrgRow[]): Promise<Names> {
  const shared = orgs.filter((org) => !org.personal).slice(0, MAX_NAMED_ORGS);
  const results = await Promise.all(shared.map((org) => query<{ members: { person_id: string; name: string | null }[] }>(`/api/orgs/${encodeURIComponent(org.id)}/members`)));
  return Object.fromEntries(results.flatMap((result) => (result.ok ? result.data.members : [])).flatMap((member) => (member.name ? [[member.person_id, member.name]] : [])));
}

/** The names we can show: agents and people in the viewer's own organizations. Nothing yet names anyone else, so a failure here just leaves IDs. */
export async function loadNames(query: Query, orgs: OrgRow[] = []): Promise<Names> {
  const [agents, people] = await Promise.all([query<{ agents: { id: string; name: string }[] }>("/api/agents"), loadPeopleNames(query, orgs)]);
  return { ...people, ...(agents.ok ? Object.fromEntries(agents.data.agents.map((agent) => [agent.id, agent.name])) : {}) };
}

/** The organizations a viewer can name are their own. Any other shows as its ID. */
export const orgNamesOf = (orgs: Pick<OrgRow, "id" | "name">[]): Names => Object.fromEntries(orgs.map((org) => [org.id, org.name]));

/** From the shell's cached read. If it failed, there's just nothing to name with. */
export const orgRows = (result: GatewayResult<{ organizations: OrgRow[] }>) => (result.ok ? result.data.organizations : []);
