"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { isOutage } from "./load-tasks";
import { BlockedLine, PrincipalName, TaskStatusBadge } from "./task-bits";
import { GanttForecastPanel } from "./task-gantt-forecast";
import { estimateText, ganttPlan, ganttPlanNote, slackText, spanText, type GanttPlan, type GanttPlanRow } from "./task-gantt-model";
import { GanttTimeline } from "./task-gantt-timeline";
import { nameOf, type Names, type TaskSummary } from "./task-model";
import type { PlanRead } from "./task-plan-model";
import { groupTasks } from "./task-views";

export type GanttRead = { plan: GanttPlan | null; status: "loading" | "ready" | "failed" | "refused"; reload: () => void };

/**
 * The room's plan, read only once someone opens this view, because it can be large. `firstRead` is the page reading again,
 * which any confirmed change causes, so a saved estimate shows here too. An outage keeps what was read, and a refusal drops
 * it, because access may be gone and titles shouldn't stay on screen.
 */
export function useGanttPlan(workspace: string, on: boolean, firstRead: unknown): GanttRead {
  const [plan, setPlan] = useState<GanttPlan | null>(null);
  const [status, setStatus] = useState<GanttRead["status"]>("loading");
  const [attempt, setAttempt] = useState(0);
  const readFor = useRef<unknown>(null);
  useEffect(() => {
    if (!on || readFor.current === firstRead) return;
    const controller = new AbortController();
    setStatus("loading");
    void (async () => {
      const result = await clientQuery<PlanRead>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/plan`, { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted) return;
      if (result?.ok) {
        readFor.current = firstRead;
        setPlan(ganttPlan(result.data));
        setStatus("ready");
        return;
      }
      if (result?.status === 401) goToSignIn();
      if (result && !isOutage(result)) {
        setPlan(null);
        setStatus("refused");
        return;
      }
      setStatus("failed");
    })();
    return () => controller.abort();
  }, [workspace, on, firstRead, attempt]);
  const reload = useCallback(() => {
    readFor.current = null;
    setAttempt((count) => count + 1);
  }, []);
  return { plan, status, reload };
}

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The same tasks in the same order as the list, as a table, with the Sheet as the only way to act on a task. The table is the
 * accessible source, and the timeline draws what it says. Every date comes from the server. The table scrolls inside its own
 * region, so the page never scrolls sideways.
 */
export function TaskGantt({ blocked = {}, tasks, read, selected, me, names, role, archived, workspace, coordinates = false }: { blocked?: Record<string, string>; tasks: TaskSummary[]; read: GanttRead; selected: string | null; me: string; names: Names; role: string | undefined; archived: boolean; workspace: string; coordinates?: boolean }) {
  const { plan, status, reload } = read;
  const table = useRef<HTMLDivElement>(null);
  const waiting = status === "loading" && !plan ? "Loading" : "Unavailable";
  const note = ganttPlanNote(plan);
  const rows = groupTasks(tasks).flatMap((group) => group.tasks);
  const reading = status === "loading";
  return (
    <div className="space-y-3">
      <GanttForecastPanel plan={plan} failed={status === "failed" || status === "refused"} workspace={workspace} role={role} archived={archived} reload={reload} coordinates={coordinates} />
      {/* Always here, so a screen reader hears it change and a re-read doesn't move the rows. */}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {reading ? (plan ? "Checking for changes. This is what was last loaded." : "Loading estimates, predecessors and the forecast.") : ""}
      </p>
      {status === "failed" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          {plan ? "Couldn't refresh estimates and predecessors, so this is what was last loaded." : "Couldn't load estimates and predecessors."}{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" onClick={reload}>
            Try again
          </Button>
        </p>
      ) : null}
      {/* Trying again can't help, and the words don't say whether it's the room or the viewer's access that changed. */}
      {status === "refused" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          Couldn't load estimates and predecessors.
        </p>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {plan?.forecast && rows.length > 0 ? <GanttTimeline plan={plan} forecast={plan.forecast} rows={rows} tableRef={table} /> : null}
      {rows.length > 0 ? (
        <div ref={table} role="region" aria-label="Task plan table" tabIndex={0} className={cn("overflow-x-auto rounded-lg border focus-visible:ring-offset-2 focus-visible:ring-offset-background", FOCUS)}>
          <table className="w-full min-w-[48rem] border-separate border-spacing-0 text-left text-sm">
            <caption className="sr-only">Each task with its state, assignee, estimate, predecessors and planned dates</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-b bg-background p-3 font-medium">
                  Task
                </th>
                {["State", "Assignee", "Estimate", "Predecessors", "Planned dates"].map((label) => (
                  <th key={label} scope="col" className="border-b p-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <GanttRow key={task.id} task={task} blocked={blocked[task.id]} planRow={plan?.rows[task.id]} waiting={waiting} complete={plan?.complete ?? false} planned={Boolean(plan?.forecast)} selected={task.id === selected} me={me} names={names} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Memoized because a long room renders thousands of these, and most changes touch one. */
const GanttRow = memo(function GanttRow({ task, blocked, planRow, waiting, complete, planned, selected, me, names }: { task: TaskSummary; blocked?: string; planRow?: GanttPlanRow; waiting: string; complete: boolean; planned: boolean; selected: boolean; me: string; names: Names }) {
  const cell = "border-b p-3 align-top";
  return (
    <tr aria-current={selected ? "true" : undefined} className={cn(selected && "bg-muted")}>
      <th scope="row" className={cn(cell, "sticky left-0 z-10 font-normal", selected ? "bg-muted" : "bg-background")}>
        {/* Set on the content, because a long unbroken ID would widen the cell, and this column stays on screen as the table scrolls. */}
        <div className="w-32 sm:w-64">
          <p className="truncate text-xs text-muted-foreground" title={task.id}>
            {task.id}
          </p>
          {/* A title is whatever its author wrote, so it's plain text and wraps. */}
          <SheetLink param="task" target={task.id} className={cn("block min-h-6 rounded-sm font-medium break-words text-primary underline-offset-2 hover:underline", FOCUS)}>
            {plainName(task.title)}
          </SheetLink>
          {task.needs_attention ? <p className="text-xs text-status-amber">Needs a new reviewer or requester</p> : null}
          <BlockedLine status={task.status} words={blocked} />
        </div>
      </th>
      <td className={cell}>
        <TaskStatusBadge status={task.status} />
      </td>
      <td className={cn(cell, "max-w-48")}>{task.assignee ? <PrincipalName id={task.assignee} label={nameOf(task.assignee, me, names)} me={me} /> : "Unassigned"}</td>
      <td className={cn(cell, "whitespace-nowrap")}>{estimateText(planRow, waiting)}</td>
      <td className={cn(cell, "max-w-64 break-words")}>
        {!planRow ? (
          waiting
        ) : planRow.predecessors.length > 0 ? (
          <ul>
            {planRow.predecessors.map((name, index) => (
              <li key={index}>{name}</li>
            ))}
          </ul>
        ) : complete ? (
          "None"
        ) : (
          "None listed"
        )}
      </td>
      <td className={cn(cell, "whitespace-nowrap")}>
        {planRow?.scheduled ? (
          <>
            <span className="block">{spanText(planRow.scheduled.earliest_start, planRow.scheduled.earliest_finish)}</span>
            <span className="block text-xs text-muted-foreground">{slackText(planRow.scheduled)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{planned ? "Not in this plan" : "Unavailable"}</span>
        )}
      </td>
    </tr>
  );
});
