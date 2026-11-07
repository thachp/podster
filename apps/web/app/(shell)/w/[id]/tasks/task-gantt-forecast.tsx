"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { FIELD_CLASS } from "./task-bits";
import { beginShiftText, changedAtText, dateText, offersStart, startNeedsLatest, startProblem, timezoneChoices, workingDays, type GanttForecast, type GanttPlan } from "./task-gantt-model";

const OPEN_LIST_UP_TO = 5;

/**
 * The one place that says what the forecast is. Every date and word about the plan comes from the server, and all forecasting
 * stays in Rust. A read that hasn't answered says nothing here, so a room with a forecast never flashes "unavailable".
 */
export function GanttForecastPanel({ plan, failed, workspace, role, archived, reload }: { plan: GanttPlan | null; failed: boolean; workspace: string; role: string | undefined; archived: boolean; reload: () => void }) {
  if (!plan && !failed) return null;
  const form = plan && offersStart(plan, role, archived) ? <GanttStartForm plan={plan} workspace={workspace} reload={reload} /> : null;
  if (plan?.forecast) return <AvailablePanel forecast={plan.forecast} form={form} />;
  return (
    <section aria-labelledby="gantt-forecast" className="space-y-1 rounded-lg border p-3 text-sm">
      <h2 id="gantt-forecast" className="font-medium">
        Forecast unavailable
      </h2>
      {plan?.unavailable ? <p className="text-muted-foreground">{plan.unavailable.explanation}</p> : null}
      {plan?.start ? (
        <p>
          Start date: {dateText(plan.start.date)}, {plan.start.timezone}
        </p>
      ) : null}
      <p>No capacity/resource leveling</p>
      <p className="text-muted-foreground">Estimates include acceptance and review.</p>
      {form}
    </section>
  );
}

function AvailablePanel({ forecast, form }: { forecast: GanttForecast; form: React.ReactNode }) {
  const shift = beginShiftText(forecast);
  return (
    <section aria-labelledby="gantt-forecast" className="space-y-2 rounded-lg border p-3 text-sm">
      <h2 id="gantt-forecast" className="font-medium">
        {forecast.label}
      </h2>
      <p className="text-muted-foreground">An estimate, not a delivery commitment. A live forecast is unavailable.</p>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Begins</dt>
        <dd>{dateText(forecast.begins_on)}</dd>
        <dt className="text-muted-foreground">Finish, last working day</dt>
        <dd>{dateText(forecast.finish_date)}</dd>
        <dt className="text-muted-foreground">Longest dependency path</dt>
        <dd>{workingDays(forecast.duration_days)}</dd>
        <dt className="text-muted-foreground">Timezone</dt>
        <dd className="break-words">{forecast.timezone}</dd>
        <dt className="text-muted-foreground">Estimates, dependencies or start last changed</dt>
        <dd>{changedAtText(forecast.plan_changed_at, forecast.timezone)}</dd>
      </dl>
      {shift ? <p className="rounded-lg bg-status-amber-surface p-2 text-status-amber">{shift}</p> : null}
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {forecast.assumptions.map((assumption, index) => (
          <li key={index}>{assumption}</li>
        ))}
      </ul>
      {forecast.leftOut.length > 0 ? <LeftOut names={forecast.leftOut} /> : null}
      {forecast.paths.length > 0 ? <CriticalPaths paths={forecast.paths} cut={forecast.critical_paths_cut} /> : null}
      {form}
    </section>
  );
}

/** So a finish date doesn't look as if it covers them. */
function LeftOut({ names }: { names: string[] }) {
  return (
    <details open={names.length <= OPEN_LIST_UP_TO}>
      <summary className="w-fit rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Left out of this plan: {names.length === 1 ? "1 completed task" : `${names.length} completed tasks`} with no estimate</summary>
      <ul className="list-disc pl-5 break-words">
        {names.map((name, index) => (
          <li key={index}>{name}</li>
        ))}
      </ul>
    </details>
  );
}

function CriticalPaths({ paths, cut }: { paths: string[][]; cut: boolean }) {
  return (
    <details>
      <summary className="w-fit rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Critical paths: {paths.length === 1 ? "1 path" : `${paths.length} tied paths`}</summary>
      <ol className="list-decimal space-y-1 pl-5 break-words">
        {paths.map((path, index) => (
          <li key={index}>{path.join(", then ")}</li>
        ))}
      </ol>
      {cut ? <p className="text-muted-foreground">More tied paths exist than are listed. The table marks every critical task.</p> : null}
    </details>
  );
}

/** Asks the server to change the room's start. Nothing moves on screen until the plan is read again. */
function GanttStartForm({ plan, workspace, reload }: { plan: GanttPlan; workspace: string; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ code: string; status: number } | null>(null);
  const [notice, setNotice] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const focusNext = useRef<"opener" | "date" | null>(null);
  // Keeps its key for a save whose outcome is unknown, so saving the same thing again can't apply twice.
  const unknownKeys = useRef(new Map<string, string>());

  useEffect(() => {
    if (focusNext.current === "date") dateField.current?.focus();
    if (focusNext.current === "opener") opener.current?.focus();
    focusNext.current = null;
  });

  const start = () => {
    setDate(plan.start?.date ?? "");
    setTimezone(plan.start?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
    setProblem(null);
    setNotice("");
    setOpen(true);
    focusNext.current = "date";
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const body = { start_date: date, timezone, plan_revision: plan.revision };
    const intent = JSON.stringify(body);
    const key = unknownKeys.current.get(intent) ?? crypto.randomUUID();
    setSaving(true);
    setProblem(null);
    const result = await clientCommand(`/api/v1/workspaces/${encodeURIComponent(workspace)}/plan/start`, body, { method: "PUT", idempotencyKey: key }).catch(() => ({ ok: false as const, status: 0, code: "unknown" }));
    setSaving(false);
    if (!result.ok) {
      if (result.code === "unknown" || result.status >= 500) unknownKeys.current.set(intent, key);
      if (result.status === 401) goToSignIn();
      setProblem({ code: result.code, status: result.status });
      return;
    }
    unknownKeys.current.delete(intent);
    setOpen(false);
    setNotice("Start saved. Nobody is told, and no task's status changes.");
    focusNext.current = "opener";
    reload();
  };

  return (
    <div className="space-y-2 pt-1">
      <p role="status" className="text-muted-foreground empty:hidden">
        {notice}
      </p>
      {open ? (
        <form onSubmit={save} aria-label="Plan start" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="gantt-start-date">Start date</Label>
              <Input ref={dateField} id="gantt-start-date" type="date" required min="2000-01-01" max="2100-12-31" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
            <div className="min-w-0 space-y-1">
              <Label htmlFor="gantt-start-timezone">Timezone</Label>
              <select id="gantt-start-timezone" required className={FIELD_CLASS} value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                {timezoneChoices(timezone).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-muted-foreground">This is a local calendar date for the whole room. A start on a weekend begins on the next working day.</p>
          {problem ? (
            <p role="alert" className="text-status-amber">
              {startProblem(problem.code, problem.status)}{" "}
              {startNeedsLatest(problem.code, problem.status) ? (
                <Button type="button" variant="link" className="h-auto p-0 text-status-amber underline" onClick={reload}>
                  Load the latest plan
                </Button>
              ) : null}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save start"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setOpen(false);
                setProblem(null);
                focusNext.current = "opener";
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button ref={opener} type="button" variant="outline" onClick={start}>
          {plan.start ? "Change start date" : "Set start date"}
        </Button>
      )}
    </div>
  );
}
