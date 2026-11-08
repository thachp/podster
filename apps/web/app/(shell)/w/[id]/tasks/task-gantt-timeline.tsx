"use client";

import { Zap } from "lucide-react";
import { memo, useEffect, useState, type RefObject } from "react";
import { cn } from "cn";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { arrowPath, dateText, dayNumber, MAX_TIMELINE_DAYS, shortDateText, slackText, spanText, timelineDays, todayIn, type GanttForecast, type GanttPlan } from "./task-gantt-model";
import type { TaskSummary } from "./task-model";
import type { ForecastTask } from "./task-plan-model";

const DAY = 24;
const ROW = 40;
const LABEL = 176;
const HEADER = 44;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
/** Often enough that Today moves soon after midnight. A hidden tab's timers slow down, so showing it again checks too. */
const CLOCK_MS = 60_000;
/** Day 0 of `dayNumber` was a Thursday. */
const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;
const dayText = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const check = () => setNow(Date.now());
    const timer = setInterval(check, CLOCK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return now;
}

/**
 * The plan drawn, with rows in CSS grid and the calendar and links in SVG. It adds nothing the table doesn't say, and the table
 * stays the accessible source, so the drawing itself is hidden from a screen reader and only the bars, which are real links, are
 * not. It scrolls inside its own region, and starts closed on a phone, where the table is the better view.
 */
export function GanttTimeline({ plan, forecast, rows, tableRef }: { plan: GanttPlan; forecast: GanttForecast; rows: TaskSummary[]; tableRef: RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(() => window.innerWidth >= 768);
  const now = useClock();
  const days = timelineDays(forecast);
  const first = dayNumber(forecast.begins_on);
  // Only someone with a start has a Today. A forecast comes with one, and this holds if that ever stops being so.
  const today = plan.start ? todayIn(forecast.timezone, now) : null;
  const todayAt = today === null ? null : dayNumber(today) - first;
  const todayShown = todayAt !== null && todayAt >= 0 && todayAt < days;
  const skip = () => tableRef.current?.focus();
  if (days > MAX_TIMELINE_DAYS) return <p className="text-sm text-muted-foreground">This plan runs too long to draw as a timeline. The table has every date.</p>;
  const width = days * DAY;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded-lg border">
      <summary className="w-fit rounded-sm p-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">Timeline</summary>
      <div className="space-y-2 px-3 pb-3 text-xs text-muted-foreground">
        <p>
          Bars run from earliest start to earliest finish. A filled bar with a lightning icon is critical. The columns marked Sa and Su are weekends, which the plan skips. Arrows join a task to the one that follows it, between the rows loaded here.
          {today ? <> Today is {dateText(today)} in {forecast.timezone}{todayShown ? ", marked with a dashed line" : ", outside this plan's dates"}.</> : null}
        </p>
        <Button type="button" variant="link" className="h-auto p-0" onClick={skip}>
          Skip to the table
        </Button>
        <div role="region" aria-label="Timeline" tabIndex={0} className="max-h-[28rem] overflow-auto rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div style={{ width: LABEL + width }}>
            <div className="sticky top-0 z-30 grid bg-background" aria-hidden style={{ gridTemplateColumns: `${LABEL}px ${width}px`, height: HEADER }}>
              <div className="sticky left-0 z-10 flex items-end border-r border-b bg-background p-2 font-medium">Task</div>
              <Scale days={days} first={first} todayAt={todayShown ? todayAt : null} />
            </div>
            <div className="relative">
              <Calendar days={days} first={first} rows={rows} plan={plan} todayAt={todayShown ? todayAt : null} />
              <ul className="relative">
                {rows.map((task) => (
                  <TimelineRow key={task.id} task={task} scheduled={plan.rows[task.id]?.scheduled} first={first} width={width} />
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}

/** Weeks and weekdays, as text, so a weekend isn't told by color alone. */
function Scale({ days, first, todayAt }: { days: number; first: number; todayAt: number | null }) {
  return (
    <svg width={days * DAY} height={HEADER} className="border-b fill-muted-foreground text-[10px]">
      {Array.from({ length: days }, (_, index) => {
        const weekday = weekdayOf(first + index);
        return (
          <g key={index}>
            {weekday === 1 || index === 0 ? <text x={index * DAY + 2} y={14}>{shortDateText(dayText(first + index))}</text> : null}
            <text x={index * DAY + DAY / 2} y={34} textAnchor="middle">
              {WEEKDAYS[weekday]}
            </text>
          </g>
        );
      })}
      {todayAt !== null ? <line x1={todayAt * DAY + DAY / 2} x2={todayAt * DAY + DAY / 2} y1={18} y2={HEADER} strokeDasharray="4 3" className="stroke-status-amber" /> : null}
    </svg>
  );
}

function Calendar({ days, first, rows, plan, todayAt }: { days: number; first: number; rows: TaskSummary[]; plan: GanttPlan; todayAt: number | null }) {
  const height = rows.length * ROW;
  const rowOf = new Map(rows.map((task, index) => [task.id, index]));
  return (
    <svg aria-hidden width={days * DAY} height={height} className="absolute top-0" style={{ left: LABEL }}>
      <defs>
        <marker id="gantt-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L6 3L0 6Z" className="fill-muted-foreground" />
        </marker>
      </defs>
      {Array.from({ length: days }, (_, index) => (weekdayOf(first + index) % 6 === 0 ? <rect key={index} x={index * DAY} width={DAY} height={height} className="fill-muted" /> : null))}
      {todayAt !== null ? <line x1={todayAt * DAY + DAY / 2} x2={todayAt * DAY + DAY / 2} y1={0} y2={height} strokeDasharray="4 3" className="stroke-status-amber" /> : null}
      {plan.links.map(([from, to]) => {
        const [fromRow, toRow] = [rowOf.get(from), rowOf.get(to)];
        const [before, after] = [plan.rows[from]?.scheduled, plan.rows[to]?.scheduled];
        if (fromRow === undefined || toRow === undefined || !before || !after) return null;
        const fromX = (dayNumber(before.earliest_finish) - first + 1) * DAY;
        const toX = (dayNumber(after.earliest_start) - first) * DAY;
        return <path key={`${from}-${to}`} d={arrowPath(fromX, fromRow * ROW + ROW / 2, toX, toRow * ROW + ROW / 2)} fill="none" markerEnd="url(#gantt-arrow)" className="stroke-muted-foreground" />;
      })}
    </svg>
  );
}

/** Memoized because a long room renders thousands of these, and most changes touch one. A task with no dates gets no bar, because a short bar would claim some. */
const TimelineRow = memo(function TimelineRow({ task, scheduled, first, width }: { task: TaskSummary; scheduled?: ForecastTask; first: number; width: number }) {
  const title = plainName(task.title);
  return (
    <li className="grid" style={{ gridTemplateColumns: `${LABEL}px ${width}px`, height: ROW }}>
      <div className="sticky left-0 z-20 flex items-center border-r border-b bg-background px-2">
        <span className="truncate text-foreground" title={title}>
          {title}
        </span>
      </div>
      <div className="flex items-center border-b">
        {scheduled ? <Bar task={task.id} title={title} scheduled={scheduled} first={first} /> : <span className="px-2 text-muted-foreground">No dates</span>}
      </div>
    </li>
  );
});

function Bar({ task, title, scheduled, first }: { task: string; title: string; scheduled: ForecastTask; first: number }) {
  const span = spanText(scheduled.earliest_start, scheduled.earliest_finish);
  const words = slackText(scheduled);
  const name = `${title}, ${span}, ${words}`;
  return (
    <SheetLink
      param="task"
      target={task}
      aria-label={name}
      title={name}
      style={{ marginLeft: (dayNumber(scheduled.earliest_start) - first) * DAY, width: (dayNumber(scheduled.earliest_finish) - dayNumber(scheduled.earliest_start) + 1) * DAY }}
      className={cn("relative z-10 flex h-6 shrink-0 items-center rounded-sm border px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background", scheduled.critical ? "border-primary bg-primary text-primary-foreground" : "border-status-blue bg-status-blue-surface")}
    >
      {scheduled.critical ? <Zap aria-hidden className="size-3 shrink-0" /> : null}
    </SheetLink>
  );
}
