import { plainName, truncate } from "@/components/agent-content/text";
import { repeatedTitles, type AvailableForecast, type ForecastTask, type PlanRead, type PlanStart, type UnavailableForecast } from "./task-plan-model";

const NAME_CHARS = 80;

/** What a row needs from the plan, boiled down so the screen doesn't keep a read that can be 2 MB. */
export type GanttPlanRow = { days: number | null; predecessors: string[]; scheduled?: ForecastTask };
export type GanttForecast = Omit<AvailableForecast, "tasks" | "critical_paths" | "left_out"> & { paths: string[][]; leftOut: string[] };
export type GanttPlan = {
  rows: Record<string, GanttPlanRow>;
  /** Whether this viewer sees the whole room, as the server decided. */
  whole: boolean;
  /** Whether every edge the viewer may see was read. Without it, an empty list can't say a task has no predecessors. */
  complete: boolean;
  revision?: number;
  /** Left out for anyone the server gives no forecast, and null if the room has no start yet. */
  start?: PlanStart | null;
  forecast: GanttForecast | null;
  unavailable: UnavailableForecast | null;
  /** The links between tasks that have bars, to draw. */
  links: [string, string][];
};

const shortName = (title: string) => {
  const cut = truncate(plainName(title), NAME_CHARS);
  return `${cut.text}${cut.truncated ? "…" : ""}`;
};

/**
 * Only what the server returned. It left out any task or edge this viewer may not read, so a hidden predecessor can't show
 * here. A predecessor with no row is one the server named in an edge but didn't list, an old finished task in a very large
 * room, so it shows by its ID. Titles can repeat, so a repeated one carries its ID too. Every date comes from the forecast,
 * and nothing here works one out.
 */
export function ganttPlan(plan: PlanRead): GanttPlan {
  const titles = new Map(plan.tasks.map((task) => [task.id, task.title]));
  const repeated = repeatedTitles(plan);
  const nameOf = (id: string) => {
    const title = titles.get(id);
    if (title === undefined) return id;
    return repeated.has(plainName(title)) ? `${shortName(title)} (${id})` : shortName(title);
  };
  const available = plan.forecast?.available === true ? plan.forecast : null;
  const scheduled = new Map(available?.tasks.map((task) => [task.id, task]));
  const rows: Record<string, GanttPlanRow> = Object.fromEntries(plan.tasks.map((task) => [task.id, { days: task.duration_days ?? null, predecessors: [], scheduled: scheduled.get(task.id) }]));
  for (const { predecessor, successor } of plan.edges) rows[successor]?.predecessors.push(nameOf(predecessor));
  let forecast: GanttForecast | null = null;
  if (available) {
    const { tasks: _tasks, critical_paths, left_out, ...rest } = available;
    forecast = { ...rest, paths: critical_paths.map((path) => path.map(nameOf)), leftOut: left_out.map(nameOf) };
  }
  return {
    rows,
    whole: plan.plan_revision !== undefined,
    complete: plan.complete,
    revision: plan.plan_revision,
    start: plan.start,
    forecast,
    unavailable: plan.forecast?.available === false ? plan.forecast : null,
    links: plan.edges.filter(({ predecessor, successor }) => scheduled.has(predecessor) && scheduled.has(successor)).map(({ predecessor, successor }) => [predecessor, successor]),
  };
}

/** A task the read didn't reach is unknown, and "Not estimated" would claim someone left it blank. */
export function estimateText(row: GanttPlanRow | undefined, waiting: string) {
  if (!row) return waiting;
  if (row.days === null) return "Not estimated";
  return workingDays(row.days);
}

export const workingDays = (days: number) => `${days} working ${days === 1 ? "day" : "days"}`;

/** What the table leaves out, said once. */
export function ganttPlanNote(plan: GanttPlan | null) {
  if (!plan) return null;
  if (!plan.whole) return "Predecessors show only the tasks you can see.";
  return plan.complete ? null : "Estimates and predecessors cover only the tasks this read reached.";
}

const DAY_MS = 86_400_000;

/** A calendar date as a number of days, with no timezone in it, so it can't shift across midnight. */
export const dayNumber = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
};

/** These only ever word a date the server sent, and read it as the calendar date it is. */
const inCalendar = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
const FULL = inCalendar({ month: "short", day: "numeric", year: "numeric" });
const SHORT = inCalendar({ month: "short", day: "numeric" });
const WITH_WEEKDAY = inCalendar({ weekday: "long", month: "short", day: "numeric", year: "numeric" });
const at = (date: string) => dayNumber(date) * DAY_MS;

export const dateText = (date: string) => FULL.format(at(date));
export const shortDateText = (date: string) => SHORT.format(at(date));

export function spanText(start: string, finish: string) {
  if (start === finish) return dateText(start);
  return start.slice(0, 4) === finish.slice(0, 4) ? `${shortDateText(start)} to ${dateText(finish)}` : `${dateText(start)} to ${dateText(finish)}`;
}

export const slackText = (task: ForecastTask) => (task.critical ? "Critical" : `Slack: ${workingDays(task.slack_days)}`);

/** Says so when a weekend start moved, because the date someone entered isn't the date on the plan. */
export const beginShiftText = (forecast: Pick<AvailableForecast, "start_date" | "begins_on">) =>
  forecast.begins_on === forecast.start_date ? null : `The start date, ${WITH_WEEKDAY.format(at(forecast.start_date))}, isn't a working day, so the plan begins on ${WITH_WEEKDAY.format(at(forecast.begins_on))}.`;

/** Today's calendar date where the room is. A browser without that timezone gets no answer, and so no Today. */
export function todayIn(timezone: string, now: number) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return null;
  }
}

/** When the plan last changed, where the room is. It doesn't cover a task's state or which tasks exist. */
export function changedAtText(at: number | null, timezone: string) {
  if (at === null) return "Not recorded";
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  try {
    return `${new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone }).format(at)}, ${timezone}`;
  } catch {
    return `${new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at)}, UTC`;
  }
}

/** The start of a room's timeline, and how many calendar days it covers. */
export const timelineDays = (forecast: Pick<AvailableForecast, "begins_on" | "finish_date">) => dayNumber(forecast.finish_date) - dayNumber(forecast.begins_on) + 1;

/** Past this, a timeline stops being readable, and the table says everything it would. */
export const MAX_TIMELINE_DAYS = 730;

/** A finish-to-start line. A successor that starts right after has no gap to turn in, so the line runs back around. */
export function arrowPath(fromX: number, fromY: number, toX: number, toY: number, turn = 6) {
  if (toX - fromX >= turn * 2) return `M${fromX} ${fromY}H${toX - turn}V${toY}H${toX}`;
  const between = (fromY + toY) / 2;
  return `M${fromX} ${fromY}H${fromX + turn}V${between}H${toX - turn}V${toY}H${toX}`;
}

const NOTHING_CHANGED = "That didn't save, and nothing changed.";

/** The form only offers what the server is likely to take: to the owner, an admin or a coordinator (issue 507). Rust decides. */
export const offersStart = (plan: GanttPlan, role: string | undefined, archived: boolean, coordinates = false) => plan.start !== undefined && plan.revision !== undefined && !archived && (role === "owner" || role === "admin" || coordinates);

export const startNeedsLatest = (code: string, status: number) => code === "plan_conflict" || code === "unknown" || status >= 500;

export function startProblem(code: string, status: number) {
  if (code === "unknown" || status >= 500) return "We couldn't confirm whether that saved. Load the latest plan to check. Your date and timezone are still here.";
  if (status === 401) return `${NOTHING_CHANGED} Your session has ended. Sign in again.`;
  if (status === 429) return `${NOTHING_CHANGED} Too many requests, so wait a minute and try again.`;
  const reasons: Record<string, string> = {
    plan_conflict: "Someone changed this room's plan after you read it. Your date and timezone are still here. Load the latest plan, check them and save again.",
    invalid_argument: "Choose a date from 2000 to 2100 and a timezone from the list.",
    not_allowed: "Only the room's owner or a human admin can set its start.",
    workspace_archived: "This workroom is archived, so nothing new can happen in it. Its owner or an admin can bring it back.",
  };
  return `${NOTHING_CHANGED} ${reasons[code] ?? "You may no longer be allowed to do this."}`;
}

/** The names a browser knows, with what's already chosen first so it's never missing. The server checks the choice. */
export function timezoneChoices(chosen: string) {
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([chosen, "UTC", ...known])];
}
