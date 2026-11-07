import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, setUrl } from "@/test/next-navigation";
import { arrowPath, beginShiftText, dateText, ganttPlan, spanText, todayIn } from "./task-gantt-model";
import type { AvailableForecast } from "./task-plan-model";
import type { Room, Task } from "./task-model";
import { TasksScreen, type TasksRead } from "./tasks-screen";

const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, title: `Title ${id}`, instructions: "I", acceptance_criteria: null, requester: "per_me", assignee: "agt_a", reviewer: "per_me", status, version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const room = (): Room => ({ id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] });
const planTask = (id: string, duration_days: number | null = null) => ({ id, title: `Title ${id}`, status: "open", assignee: null, reviewer: "per_me", duration_days });
const fullPlan = { complete: true, plan_revision: 4, tasks: [planTask("a", 3), planTask("b", 1), planTask("c")], edges: [{ predecessor: "a", successor: "b" }] };

let planReply: () => Response | Promise<Response>;
let planReads: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  setUrl("/w/ws_1/tasks?view=gantt");
  planReads = 0;
  planReply = () => json(fullPlan);
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/plan")) {
      planReads += 1;
      return planReply();
    }
    return json(url.endsWith("/ws_1") ? room() : { task: task(url.split("/").at(-1)!, "open"), submissions: [], artifacts: [], messages: [], history: [] });
  });
});

const props = (tasks: Task[], over: Partial<TasksRead> = {}): TasksRead => ({ room: room(), tasks, cursor: null, me: "per_me", names: { agt_a: "Architect" }, ...over });
const show = (tasks: Task[], over: Partial<TasksRead> = {}) => render(<main id="main-content" tabIndex={-1}><TasksScreen {...props(tasks, over)} /></main>);
const rowOf = (name: string) => screen.getByRole("link", { name }).closest("tr")!;
const threeTasks = [task("c", "open", { assignee: null }), task("a", "completed"), task("b", "accepted")];

describe("the Gantt table", () => {
  it("is a real table, with a text state, assignee, estimate with units and predecessor names", async () => {
    show(threeTasks);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Task", "State", "Assignee", "Estimate", "Predecessors", "Planned dates"]);
    await waitFor(() => expect(within(rowOf("Title a")).getByText("3 working days")).toBeInTheDocument());
    expect(within(rowOf("Title b")).getByText("1 working day")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByRole("rowheader")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Architect")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Accepted")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("Not estimated")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("Unassigned")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("None")).toBeInTheDocument();
  });

  it("invents no dates: every planned date is unavailable, and the forecast says so with the fixed capacity text", async () => {
    show([task("a", "completed", { due_at: 1_800_000_000_000 }), task("b", "accepted")]);
    await waitFor(() => expect(within(rowOf("Title a")).getByText("3 working days")).toBeInTheDocument());
    expect(within(rowOf("Title a")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Forecast unavailable" })).toBeInTheDocument();
    expect(screen.getByText("No capacity/resource leveling")).toBeInTheDocument();
    expect(screen.getByText("Estimates include acceptance and review.")).toBeInTheDocument();
    expect(screen.getByRole("table").textContent).not.toMatch(/\b20\d\d\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  });

  it("keeps the list's tasks and order, its filter and the selected task", async () => {
    const tasks = [task("x", "open"), task("y", "submitted"), task("z", "canceled"), task("w", "submitted", { reviewer: "per_other" })];
    setUrl("/w/ws_1/tasks");
    const { unmount } = show(tasks);
    const listed = screen.getAllByRole("link", { name: /^Title / }).map((link) => link.textContent);
    unmount();
    setUrl("/w/ws_1/tasks?view=gantt");
    const again = show(tasks);
    expect(screen.getAllByRole("link", { name: /^Title / }).map((link) => link.textContent)).toEqual(listed);
    again.unmount();
    setUrl("/w/ws_1/tasks?view=gantt&review=mine&task=y");
    show(tasks);
    await screen.findByRole("dialog");
    expect(document.querySelector("tr[aria-current]")?.textContent).toContain("Title y");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("opens the Sheet by keyboard from a real link, and stays on Gantt", async () => {
    const user = userEvent.setup();
    show(threeTasks);
    const link = screen.getByRole("link", { name: "Title b" });
    expect(link).toHaveAttribute("href", "/w/ws_1/tasks?view=gantt&task=b");
    expect(link).toHaveAttribute("data-sheet-launcher", "task:b");
    expect(link.className).toContain("focus-visible:ring-2");
    while (document.activeElement !== link) await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    expect(currentUrl()).toBe("/w/ws_1/tasks?view=gantt&task=b");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/w/ws_1/tasks?view=gantt"));
    await waitFor(() => expect(screen.getByRole("link", { name: "Title b" })).toHaveFocus());
  });

  it("scrolls inside a named region that keys can reach", () => {
    show(threeTasks);
    const region = screen.getByRole("region", { name: "Task plan table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("overflow-x-auto");
    expect(region).toContainElement(screen.getByRole("table"));
  });

  it("shows no table and spends no read on an empty room", () => {
    show([]);
    expect(screen.queryByRole("table")).toBeNull();
    expect(planReads).toBe(0);
  });
});

describe("reading the plan", () => {
  it("reads nothing until someone opens the view, and then through the web's own path", async () => {
    setUrl("/w/ws_1/tasks");
    const user = userEvent.setup();
    show(threeTasks);
    expect(planReads).toBe(0);
    await user.click(screen.getByRole("link", { name: "Gantt" }));
    await waitFor(() => expect(planReads).toBe(1));
    await user.click(screen.getByRole("link", { name: "List" }));
    await user.click(screen.getByRole("link", { name: "Gantt" }));
    expect(planReads).toBe(1);
  });

  it("reads again when the page does, so a saved estimate shows", async () => {
    const { rerender } = render(<TasksScreen {...props(threeTasks)} />);
    await waitFor(() => expect(within(rowOf("Title c")).getByText("Not estimated")).toBeInTheDocument());
    planReply = () => json({ ...fullPlan, tasks: [planTask("a", 3), planTask("b", 1), planTask("c", 8)] });
    rerender(<TasksScreen {...props([...threeTasks])} />);
    await waitFor(() => expect(within(rowOf("Title c")).getByText("8 working days")).toBeInTheDocument());
    expect(planReads).toBe(2);
  });

  it("says loading, not Not estimated, until the read answers", async () => {
    let answer = (_: Response) => {};
    planReply = () => new Promise((done) => (answer = done));
    show(threeTasks);
    expect(screen.getByText("Loading estimates, predecessors and the forecast.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Not estimated")).toBeNull();
    await act(async () => answer(json(fullPlan)));
    expect(screen.queryByText("Loading estimates, predecessors and the forecast.")).toBeNull();
  });

  it("an outage says so, says Unavailable rather than Not estimated, and can try again", async () => {
    planReply = () => json({ error: { code: "x" } }, 503);
    const user = userEvent.setup();
    show(threeTasks);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load estimates and predecessors.");
    expect(screen.queryByText("Not estimated")).toBeNull();
    expect(screen.queryByText("None")).toBeNull();
    expect(within(rowOf("Title b")).getAllByText("Unavailable")).toHaveLength(3);
    planReply = () => json(fullPlan);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(rowOf("Title a")).getByText("3 working days")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an outage on a later read keeps what was read and says it may be old, and a refusal drops it", async () => {
    const { rerender } = render(<TasksScreen {...props(threeTasks)} />);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument());
    planReply = () => json({}, 500);
    rerender(<TasksScreen {...props([...threeTasks])} />);
    await screen.findByText(/so this is what was last loaded/);
    expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument();
    planReply = () => json({}, 403);
    rerender(<TasksScreen {...props([...threeTasks])} />);
    await screen.findByText("Couldn't load estimates and predecessors.");
    expect(within(rowOf("Title b")).queryByText("Title a")).toBeNull();
    expect(within(rowOf("Title a")).queryByText("3 working days")).toBeNull();
  });

  it("a limited viewer is told it's only what they can see, and no predecessors isn't promised", async () => {
    planReply = () => json({ complete: false, tasks: [planTask("a"), planTask("b"), planTask("c")], edges: [] });
    show(threeTasks);
    await screen.findByText("Predecessors show only the tasks you can see.");
    expect(within(rowOf("Title b")).getByText("None listed")).toBeInTheDocument();
    expect(within(rowOf("Title b")).queryByText("None")).toBeNull();
  });

  it("a task the read didn't reach is Unavailable, in a read that says it stopped short", async () => {
    planReply = () => json({ ...fullPlan, complete: false, tasks: [planTask("a", 3)], edges: [] });
    show(threeTasks);
    await screen.findByText("Estimates and predecessors cover only the tasks this read reached.");
    expect(within(rowOf("Title c")).getAllByText("Unavailable")).toHaveLength(3);
    expect(within(rowOf("Title c")).queryByText("Not estimated")).toBeNull();
  });

  it("shows a predecessor's title as the text it is", async () => {
    planReply = () => json({ ...fullPlan, tasks: [{ ...planTask("a"), title: "<b>Bold</b> **really**" }, planTask("b")] });
    show(threeTasks);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("<b>Bold</b> **really**")).toBeInTheDocument());
  });
});

describe("ganttPlan", () => {
  it("only ever names what the read returned, and shows a predecessor it named but didn't list by ID", () => {
    const plan = ganttPlan({ complete: false, plan_revision: 1, tasks: [planTask("b")], edges: [{ predecessor: "old", successor: "b" }, { predecessor: "b", successor: "gone" }] });
    expect(plan.rows).toEqual({ b: { days: null, predecessors: ["old"] } });
  });

  it("keeps only links with a bar at both ends", () => {
    const plan = ganttPlan({ ...fullPlan, edges: [{ predecessor: "a", successor: "b" }, { predecessor: "b", successor: "c" }], forecast: forecast({ tasks: [scheduled("a", "2026-11-02", "2026-11-02"), scheduled("b", "2026-11-03", "2026-11-03")] }) });
    expect(plan.links).toEqual([["a", "b"]]);
  });

  it("cuts a long predecessor title, and tells whole from limited by the revision alone", () => {
    const plan = ganttPlan({ complete: false, tasks: [{ ...planTask("a"), title: "x".repeat(200) }, planTask("b")], edges: [{ predecessor: "a", successor: "b" }] });
    expect(plan.rows.b.predecessors[0].length).toBeLessThanOrEqual(81);
    expect(plan.rows.b.predecessors[0].endsWith("…")).toBe(true);
    expect(plan.whole).toBe(false);
  });
});

// The fixture in docs/spec/TASK-PLANNING.md, cut to what these need: two paths tied at the finish, and one with slack.
const scheduled = (id: string, earliest_start: string, earliest_finish: string, critical = true, slack_days = 0) => ({ id, duration_days: 1, earliest_start, earliest_finish, latest_start: earliest_start, latest_finish: earliest_finish, slack_days, critical });
const forecast = (over: Partial<AvailableForecast> = {}): AvailableForecast => ({
  label: "Baseline plan",
  available: true,
  plan_revision: 4,
  plan_changed_at: Date.UTC(2026, 10, 2, 15, 30),
  start_date: "2026-11-02",
  begins_on: "2026-11-02",
  timezone: "America/New_York",
  calendar: "mon_fri",
  assumptions: ["First assumption.", "Second assumption.", "Third assumption.", "Fourth assumption.", "Fifth assumption."],
  duration_days: 10,
  finish_date: "2026-11-13",
  tasks: [scheduled("a", "2026-11-02", "2026-11-03"), scheduled("b", "2026-11-06", "2026-11-11"), scheduled("c", "2026-11-12", "2026-11-12", false, 1)],
  critical_paths: [["a", "b"], ["c", "b"]],
  critical_paths_cut: false,
  left_out: [],
  ...over,
});
const withForecast = (over: Partial<AvailableForecast> = {}, plan: object = {}) => ({ ...fullPlan, start: { date: "2026-11-02", timezone: "America/New_York" }, plan_changed_at: 1, forecast: forecast(over), ...plan });
const owner = (): Room => ({ ...room(), members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "owner" }] });
const planned = async (over: Partial<AvailableForecast> = {}, plan: object = {}, props2: Partial<TasksRead> = {}) => {
  planReply = () => json(withForecast(over, plan));
  show(threeTasks, props2);
  await screen.findByRole("heading", { name: "Baseline plan" });
};

describe("the forecast panel", () => {
  it("shows what the server worked out, every assumption it sent, and that it's an estimate", async () => {
    await planned();
    const panel = screen.getByRole("heading", { name: "Baseline plan" }).parentElement!;
    expect(within(panel).getByText("Nov 2, 2026")).toBeInTheDocument();
    expect(within(panel).getByText("Nov 13, 2026")).toBeInTheDocument();
    expect(within(panel).getByText("10 working days")).toBeInTheDocument();
    expect(within(panel).getByText("America/New_York")).toBeInTheDocument();
    expect(within(panel).getByText(/An estimate, not a delivery commitment/)).toBeInTheDocument();
    for (const words of ["First", "Second", "Third", "Fourth", "Fifth"]) expect(within(panel).getByText(`${words} assumption.`)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Forecast unavailable" })).toBeNull();
  });

  it("labels the last-changed time for what it covers, in the room's timezone", async () => {
    await planned();
    const label = screen.getByText("Estimates, dependencies or start last changed");
    expect(label.nextElementSibling).toHaveTextContent("Nov 2, 2026, 10:30 AM, America/New_York");
  });

  it("makes a weekend start's move visible, and says nothing when there was none", async () => {
    await planned();
    expect(screen.queryByText(/isn't a working day/)).toBeNull();
    cleanup();
    await planned({ start_date: "2026-11-07", begins_on: "2026-11-09" });
    expect(screen.getByText("The start date, Saturday, Nov 7, 2026, isn't a working day, so the plan begins on Monday, Nov 9, 2026.")).toBeInTheDocument();
  });

  it("names the tasks left out, so a finish doesn't look complete, and tells repeated titles apart", async () => {
    const same = { ...planTask("x"), title: "Same" };
    await planned({ left_out: ["x", "y", "z"] }, { tasks: [...fullPlan.tasks, same, { ...planTask("y"), title: "Same" }, { ...planTask("z"), title: "Other" }] });
    expect(screen.getByText("Left out of this plan: 3 completed tasks with no estimate")).toBeInTheDocument();
    expect(screen.getByText("Same (x)")).toBeInTheDocument();
    expect(screen.getByText("Same (y)")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("lists every tied critical path, and says when there are more", async () => {
    await planned({ critical_paths_cut: true });
    expect(screen.getByText("Critical paths: 2 tied paths")).toBeInTheDocument();
    expect(screen.getByText("Title a, then Title b")).toBeInTheDocument();
    expect(screen.getByText("Title c, then Title b")).toBeInTheDocument();
    expect(screen.getByText(/More tied paths exist/)).toBeInTheDocument();
  });

  it("says why there's no forecast in the server's words, and shows no dates or timeline", async () => {
    planReply = () => json({ ...fullPlan, start: { date: "2026-11-02", timezone: "UTC" }, forecast: { label: "Baseline plan", available: false, reasons: ["missing_estimates"], explanation: "No baseline plan yet. A task still needs an estimate." } });
    show(threeTasks);
    expect(await screen.findByText("No baseline plan yet. A task still needs an estimate.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Forecast unavailable" })).toBeInTheDocument();
    expect(screen.getByText("No capacity/resource leveling")).toBeInTheDocument();
    expect(within(rowOf("Title a")).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Timeline" })).toBeNull();
    expect(screen.queryByText(/Today is/)).toBeNull();
  });

  it("doesn't say unavailable before the read has answered", () => {
    planReply = () => new Promise(() => {});
    show(threeTasks);
    expect(screen.queryByRole("heading", { name: "Forecast unavailable" })).toBeNull();
  });
});

describe("real dates in the table", () => {
  it("shows the span, and critical or slack in words", async () => {
    await planned();
    expect(within(rowOf("Title a")).getByText("Nov 2 to Nov 3, 2026")).toBeInTheDocument();
    expect(within(rowOf("Title a")).getByText("Critical")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("Nov 12, 2026")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("Slack: 1 working day")).toBeInTheDocument();
  });

  it("a task the forecast leaves out says so, rather than showing a date", async () => {
    planReply = () => json(withForecast({ tasks: [scheduled("a", "2026-11-02", "2026-11-03")] }));
    show(threeTasks);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("Not in this plan")).toBeInTheDocument());
  });

  it.each(["Pacific/Kiritimati", "Pacific/Pago_Pago"])("a date stays that date in a browser in %s", (zone) => {
    const held = process.env.TZ;
    process.env.TZ = zone;
    try {
      expect(dateText("2026-11-02")).toBe("Nov 2, 2026");
      expect(spanText("2026-12-31", "2027-01-04")).toBe("Dec 31, 2026 to Jan 4, 2027");
      expect(beginShiftText({ start_date: "2026-11-07", begins_on: "2026-11-09" })).toContain("Saturday, Nov 7, 2026");
    } finally {
      process.env.TZ = held;
    }
  });
});

describe("the timeline", () => {
  const bar = (title: string) => screen.getByRole("link", { name: new RegExp(`^${title}, `) });

  it("draws a bar as a real link to the same Sheet, named in words, in its own scroll region", async () => {
    await planned();
    const region = screen.getByRole("region", { name: "Timeline" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("overflow-auto");
    expect(within(region).queryByRole("table")).toBeNull();
    expect(bar("Title a")).toHaveAccessibleName("Title a, Nov 2 to Nov 3, 2026, Critical");
    expect(bar("Title a")).toHaveAttribute("href", "/w/ws_1/tasks?view=gantt&task=a");
    expect(bar("Title a").className).toContain("focus-visible:ring-2");
    expect(bar("Title c")).toHaveAccessibleName("Title c, Nov 12, 2026, Slack: 1 working day");
  });

  it("places a bar by its dates, across a weekend, and marks critical with more than color", async () => {
    await planned();
    expect(bar("Title b")).toHaveStyle({ marginLeft: "96px", width: "144px" });
    expect(bar("Title a").querySelector("svg")).not.toBeNull();
    expect(bar("Title c").querySelector("svg")).toBeNull();
  });

  it("gives no bar to a task with no dates", async () => {
    await planned({ tasks: [scheduled("a", "2026-11-02", "2026-11-03")] });
    expect(within(screen.getByRole("region", { name: "Timeline" })).getByText("Title b")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Title b, / })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Timeline" })).getAllByText("No dates")).toHaveLength(2);
  });

  it("marks weekends in text as well as shading, and draws only the links it has both ends of", async () => {
    await planned({}, { edges: [{ predecessor: "a", successor: "b" }, { predecessor: "b", successor: "c" }, { predecessor: "hidden", successor: "a" }] });
    const region = screen.getByRole("region", { name: "Timeline" });
    expect(within(region).getAllByText("Sa")).toHaveLength(1);
    expect(within(region).getAllByText("Su")).toHaveLength(1);
    expect(within(region).getAllByText("Tu")).toHaveLength(2);
    expect(within(region).getAllByText("Th")).toHaveLength(2);
    expect(region.querySelectorAll("rect")).toHaveLength(2);
    expect(region.querySelectorAll('path[marker-end]')).toHaveLength(2);
    expect(screen.getByText(/columns marked Sa and Su are weekends/)).toBeInTheDocument();
  });

  it("draws no line for a link to a task that isn't a row here", async () => {
    planReply = () => json(withForecast({}, { edges: [{ predecessor: "a", successor: "b" }] }));
    show([task("a", "open")]);
    const region = await screen.findByRole("region", { name: "Timeline" });
    expect(region.querySelectorAll("path[marker-end]")).toHaveLength(0);
  });

  it("marks Today in the room's timezone, and says so when it's outside the plan", async () => {
    // Still Nov 4 in New York, so a browser or server clock in UTC would say the wrong day.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 5, 2) });
    try {
      await planned();
      expect(screen.getByText(/Today is Nov 4, 2026 in America\/New_York, marked with a dashed line/)).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Timeline" }).querySelectorAll('line[stroke-dasharray]')).toHaveLength(2);
      cleanup();
      vi.setSystemTime(Date.UTC(2027, 0, 5));
      await planned();
      expect(screen.getByText(/outside this plan's dates/)).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Timeline" }).querySelectorAll('line[stroke-dasharray]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["on its timer", () => vi.advanceTimersByTime(60_000)],
    ["when the tab shows again", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("moves Today past the room's midnight in a tab left open, %s", async (_, wake) => {
    // 11:30 PM on Nov 4 in New York, which is already Nov 5 in UTC.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: Date.UTC(2026, 10, 5, 4, 30) });
    try {
      await planned();
      expect(screen.getByText(/Today is Nov 4, 2026 in America/)).toBeInTheDocument();
      vi.setSystemTime(Date.UTC(2026, 10, 5, 5, 30));
      act(() => wake());
      expect(screen.getByText(/Today is Nov 5, 2026 in America/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops its clock when it's gone", async () => {
    planReply = () => json(withForecast());
    const shown = render(<TasksScreen {...props(threeTasks)} />);
    await screen.findByRole("region", { name: "Timeline" });
    const stopped = vi.spyOn(globalThis, "clearInterval");
    const removed = vi.spyOn(document, "removeEventListener");
    shown.unmount();
    expect(stopped).toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    stopped.mockRestore();
    removed.mockRestore();
  });

  it("keeps two identical assumptions without a clash", async () => {
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await planned({ assumptions: ["The same words.", "The same words."] });
      expect(screen.getAllByText("The same words.")).toHaveLength(2);
      expect(complaints.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    } finally {
      complaints.mockRestore();
    }
  });

  it("works out Today where the room is, not where the browser is", () => {
    const at = Date.UTC(2026, 10, 7, 3);
    expect(todayIn("America/New_York", at)).toBe("2026-11-06");
    expect(todayIn("Asia/Tokyo", at)).toBe("2026-11-07");
    expect(todayIn("Not/AZone", at)).toBeNull();
  });

  it("has no Today for a viewer with no start", async () => {
    planReply = () => {
      const { start: _start, ...rest } = withForecast();
      return json(rest);
    };
    show(threeTasks);
    await screen.findByRole("region", { name: "Timeline" });
    expect(screen.queryByText(/Today is/)).toBeNull();
    expect(screen.getByRole("region", { name: "Timeline" }).querySelectorAll('line[stroke-dasharray]')).toHaveLength(0);
  });

  it("keeps the table as the source, and lets a keyboard skip the bars to reach it", async () => {
    const user = userEvent.setup();
    await planned();
    await user.click(screen.getByRole("button", { name: "Skip to the table" }));
    expect(screen.getByRole("region", { name: "Task plan table" })).toHaveFocus();
  });

  it("starts closed on a phone", async () => {
    const held = window.innerWidth;
    window.innerWidth = 375;
    try {
      await planned();
      expect(screen.getByRole("region", { name: "Timeline", hidden: true }).closest("details")).not.toHaveAttribute("open");
    } finally {
      window.innerWidth = held;
    }
  });

  it("says a plan too long to draw is in the table", async () => {
    await planned({ finish_date: "2029-01-01" });
    expect(screen.getByText(/runs too long to draw/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Timeline" })).toBeNull();
    expect(within(rowOf("Title a")).getByText("Nov 2 to Nov 3, 2026")).toBeInTheDocument();
  });

  it("routes an arrow around when there's no gap to turn in", () => {
    expect(arrowPath(0, 20, 48, 60)).toBe("M0 20H42V60H48");
    expect(arrowPath(48, 20, 48, 60)).toBe("M48 20H54V40H42V60H48");
  });
});

describe("the findings from the first Gantt review", () => {
  it("says it's checking while it re-reads, and keeps the rows", async () => {
    const { rerender } = render(<TasksScreen {...props(threeTasks)} />);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument());
    let answer = (_: Response) => {};
    planReply = () => new Promise((done) => (answer = done));
    rerender(<TasksScreen {...props([...threeTasks])} />);
    expect(await screen.findByText("Checking for changes. This is what was last loaded.")).toHaveAttribute("role", "status");
    expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument();
    await act(async () => answer(json(fullPlan)));
    expect(screen.queryByText(/Checking for changes/)).toBeNull();
  });

  it("tells apart predecessors with the same title, by ID", async () => {
    planReply = () => json({ ...fullPlan, tasks: [{ ...planTask("a"), title: "Same" }, { ...planTask("c"), title: "Same" }, planTask("b")], edges: [{ predecessor: "a", successor: "b" }, { predecessor: "c", successor: "b" }] });
    show(threeTasks);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("Same (a)")).toBeInTheDocument());
    expect(within(rowOf("Title b")).getByText("Same (c)")).toBeInTheDocument();
  });

  it.each([403, 404])("a %i offers no Try again, because it can't help", async (status) => {
    planReply = () => json({}, status);
    show(threeTasks);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load estimates and predecessors.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([500, 429])("a %i does offer it", async (status) => {
    planReply = () => json({}, status);
    show(threeTasks);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("setting the room's start", () => {
  let sentStart: { url: string; body: Record<string, unknown>; key: string | null }[];
  let startReply: () => Response;
  const asOwner = async (plan: object = { ...fullPlan, start: null, forecast: { label: "Baseline plan", available: false, reasons: ["no_start"], explanation: "No baseline plan yet. Set the room's start date and timezone." } }, over: Partial<TasksRead> = {}) => {
    planReply = () => json(plan);
    show(threeTasks, { room: owner(), ...over });
    await screen.findByText(/No baseline plan yet|Baseline plan/);
  };

  beforeEach(() => {
    sentStart = [];
    startReply = () => json({ start: { date: "2026-11-09", timezone: "UTC" }, plan_revision: 5, plan_changed_at: 2 });
    const reads = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        sentStart.push({ url, body: JSON.parse(init.body as string), key: new Headers(init.headers).get("idempotency-key") });
        return startReply();
      }
      return reads(url, init);
    });
  });

  it("is offered to an owner or admin, and to nobody the server gives no start", async () => {
    await asOwner();
    expect(screen.getByRole("button", { name: "Set start date" })).toBeInTheDocument();
    cleanup();
    planReply = () => json({ ...fullPlan, start: null, forecast: { label: "Baseline plan", available: false, reasons: ["no_start"], explanation: "Set it." } });
    show(threeTasks);
    await screen.findByText("Set it.");
    expect(screen.queryByRole("button", { name: /start date/ })).toBeNull();
    cleanup();
    planReply = () => json({ complete: false, tasks: [], edges: [], forecast: { label: "Baseline plan", available: false, reasons: ["not_available"], explanation: "Not for this view." } });
    show(threeTasks, { room: owner() });
    await screen.findByText("Not for this view.");
    expect(screen.queryByRole("button", { name: /start date/ })).toBeNull();
    cleanup();
    planReply = () => json({ ...fullPlan, forecast: { label: "Baseline plan", available: false, reasons: ["not_available"], explanation: "Whole, but no forecast." } });
    show(threeTasks, { room: owner() });
    await screen.findByText("Whole, but no forecast.");
    expect(screen.queryByRole("button", { name: /start date/ })).toBeNull();
    cleanup();
    await asOwner(undefined, { room: { ...owner(), status: "archived" } });
    expect(screen.queryByRole("button", { name: /start date/ })).toBeNull();
  });

  it("sends the date, timezone and revision, says it saved, returns focus and reads the plan again", async () => {
    const user = userEvent.setup();
    await asOwner();
    await user.click(screen.getByRole("button", { name: "Set start date" }));
    expect(screen.getByLabelText("Start date")).toHaveFocus();
    await user.type(screen.getByLabelText("Start date"), "2026-11-09");
    await user.selectOptions(screen.getByLabelText("Timezone"), "UTC");
    const readsBefore = planReads;
    planReply = () => json(withForecast());
    await user.click(screen.getByRole("button", { name: "Save start" }));
    expect(sentStart[0].url).toBe("/api/v1/workspaces/ws_1/plan/start");
    expect(sentStart[0].body).toEqual({ start_date: "2026-11-09", timezone: "UTC", plan_revision: 4 });
    expect(sentStart[0].key).toBeTruthy();
    await screen.findByRole("heading", { name: "Baseline plan" });
    expect(planReads).toBe(readsBefore + 1);
  });

  it("starts from the room's own start, and Cancel sends nothing", async () => {
    const user = userEvent.setup();
    await asOwner(withForecast());
    await user.click(screen.getByRole("button", { name: "Change start date" }));
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-11-02");
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/New_York");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sentStart).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Change start date" })).toHaveFocus();
  });

  it("a conflict keeps what's typed, offers the latest plan, and saves against its new revision", async () => {
    const user = userEvent.setup();
    await asOwner();
    startReply = () => json({ error: { code: "plan_conflict" } }, 409);
    await user.click(screen.getByRole("button", { name: "Set start date" }));
    await user.type(screen.getByLabelText("Start date"), "2026-11-09");
    await user.click(screen.getByRole("button", { name: "Save start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Someone changed this room's plan/);
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-11-09");
    planReply = () => json({ ...fullPlan, plan_revision: 9, start: null, forecast: { label: "Baseline plan", available: false, reasons: ["no_start"], explanation: "No baseline plan yet." } });
    await user.click(screen.getByRole("button", { name: "Load the latest plan" }));
    await waitFor(() => expect(planReads).toBe(2));
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-11-09");
    startReply = () => json({ start: {}, plan_revision: 10, plan_changed_at: 2 });
    await user.click(screen.getByRole("button", { name: "Save start" }));
    await waitFor(() => expect(sentStart).toHaveLength(2));
    expect(sentStart[1].body.plan_revision).toBe(9);
  });

  it("an unknown outcome keeps its key, so saving the same thing can't apply twice", async () => {
    const user = userEvent.setup();
    await asOwner();
    startReply = () => json({}, 500);
    await user.click(screen.getByRole("button", { name: "Set start date" }));
    await user.type(screen.getByLabelText("Start date"), "2026-11-09");
    await user.click(screen.getByRole("button", { name: "Save start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't confirm/);
    await user.click(screen.getByRole("button", { name: "Save start" }));
    await waitFor(() => expect(sentStart).toHaveLength(2));
    expect(sentStart[1].key).toBe(sentStart[0].key);
  });

  it("a refusal says why and changes nothing on screen", async () => {
    const user = userEvent.setup();
    await asOwner();
    startReply = () => json({ error: { code: "invalid_argument" } }, 400);
    await user.click(screen.getByRole("button", { name: "Set start date" }));
    await user.type(screen.getByLabelText("Start date"), "2026-11-09");
    await user.click(screen.getByRole("button", { name: "Save start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing changed.*Choose a date/);
    expect(screen.queryByRole("button", { name: "Load the latest plan" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Baseline plan" })).toBeNull();
  });
});
