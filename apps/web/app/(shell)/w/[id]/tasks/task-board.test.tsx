import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { back, currentUrl, setUrl } from "@/test/next-navigation";
import { TASK_STATUSES, type Room, type Task } from "./task-model";
import { KeptTasksScreen, TasksScreen, type TasksRead } from "./tasks-screen";

const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, title: `Title ${id}`, instructions: "I", acceptance_criteria: null, requester: "per_me", assignee: "agt_a", reviewer: "per_me", status, version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const room = (role = "member"): Room => ({ id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role }] });
const read = (tasks: Task[], over: Partial<TasksRead> = {}): TasksRead => ({ room: room(), tasks, cursor: null, me: "per_me", names: { agt_a: "Architect" }, ...over });
const show = (tasks: Task[], over: Partial<TasksRead> = {}) => render(<main id="main-content" tabIndex={-1}><TasksScreen {...read(tasks, over)} /></main>);
const column = (name: RegExp) => screen.getByRole("heading", { name }).parentElement!;

const everyState = TASK_STATUSES.map((status) => task(`t_${status}`, status));

beforeEach(() => {
  setUrl("/w/ws_1/tasks");
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url.endsWith("/ws_1") ? room() : { task: task(url.split("/").at(-1)!, "open"), submissions: [], artifacts: [], messages: [], history: [] }), { status: 200 }));
});

describe("switching views", () => {
  it("opens on the list, says which view is current, and offers Gantt", () => {
    show(everyState);
    expect(screen.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Board" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Gantt" })).toHaveAttribute("href", "/w/ws_1/tasks?view=gantt");
  });

  it("an unknown view is the list", () => {
    setUrl("/w/ws_1/tasks?view=chart");
    show(everyState);
    expect(screen.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "true");
  });

  it("moves by keyboard, stays on the link, keeps the query and announces it, and Back restores it", async () => {
    setUrl("/w/ws_1/tasks?utm=x&review=mine");
    const user = userEvent.setup();
    show(everyState);
    await user.tab();
    while (document.activeElement !== screen.getByRole("link", { name: "Board" })) await user.tab();
    await user.keyboard("{Enter}");
    expect(currentUrl()).toBe("/w/ws_1/tasks?utm=x&review=mine&view=board");
    expect(screen.getByRole("link", { name: "Board" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText(/Board view, showing 1 of 6 tasks/)).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("checkbox", { name: "Needs my review" })).toBeChecked();
    act(() => back());
    expect(screen.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "true");
  });

  it("the links are real ones, so a new tab gets the same view, and a modified click is left to the browser", async () => {
    setUrl("/w/ws_1/tasks?utm=x");
    const user = userEvent.setup();
    show([]);
    const board = screen.getByRole("link", { name: "Board" });
    expect(board).toHaveAttribute("href", "/w/ws_1/tasks?utm=x&view=board");
    await user.keyboard("{Meta>}");
    board.addEventListener("click", (event) => event.preventDefault());
    await user.click(board);
    await user.keyboard("{/Meta}");
    expect(currentUrl()).toBe("/w/ws_1/tasks?utm=x");
  });

  it("the filter lives in the URL, and survives a reload there", async () => {
    const user = userEvent.setup();
    const { unmount } = show([task("a", "submitted"), task("b", "accepted")]);
    await user.click(screen.getByRole("checkbox", { name: "Needs my review" }));
    expect(currentUrl()).toBe("/w/ws_1/tasks?review=mine");
    expect(screen.queryByText("Title b")).toBeNull();
    unmount();
    show([task("a", "submitted"), task("b", "accepted")]);
    expect(screen.getByRole("checkbox", { name: "Needs my review" })).toBeChecked();
    expect(screen.queryByText("Title b")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Needs my review" }));
    expect(currentUrl()).toBe("/w/ws_1/tasks");
  });
});

describe("the board", () => {
  beforeEach(() => setUrl("/w/ws_1/tasks?view=board"));

  it("has the five columns in order, empty ones too, and hides canceled by default", () => {
    show([task("a", "submitted"), task("c", "canceled")]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Open (0)", "Awaiting acceptance (0)", "Accepted (0)", "Awaiting review (1)", "Completed (0)"]);
    expect(within(column(/^Open/)).getByText("No tasks")).toBeInTheDocument();
    expect(screen.queryByText("Title c")).toBeNull();
    expect(screen.getByText(/Canceled tasks hidden \(1\)/)).toBeInTheDocument();
  });

  it("shows canceled when asked, from the URL, and can hide it again", async () => {
    const user = userEvent.setup();
    show([task("c", "canceled")]);
    await user.click(screen.getByRole("link", { name: "Show canceled" }));
    expect(currentUrl()).toBe("/w/ws_1/tasks?view=board&canceled=show");
    expect(within(column(/^Canceled \(1\)/)).getByText("Title c")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hide canceled" })).toHaveFocus();
    await user.click(screen.getByRole("link", { name: "Hide canceled" }));
    expect(screen.queryByText("Title c")).toBeNull();
  });

  it("hiding canceled when none are in scope removes the link, and focus moves to the main content", async () => {
    setUrl("/w/ws_1/tasks?view=board&canceled=show&review=mine");
    const user = userEvent.setup();
    show([task("a", "submitted"), task("c", "canceled")]);
    const hide = screen.getByRole("link", { name: "Hide canceled" });
    hide.focus();
    await user.keyboard("{Enter}");
    expect(currentUrl()).toBe("/w/ws_1/tasks?view=board&review=mine");
    expect(screen.queryByRole("link", { name: /canceled/i })).toBeNull();
    expect(document.getElementById("main-content")).toHaveFocus();
  });

  it("offers no canceled control when there's nothing to show", () => {
    show([task("a", "open")]);
    expect(screen.queryByRole("link", { name: "Show canceled" })).toBeNull();
    expect(screen.queryByText(/Canceled tasks hidden/)).toBeNull();
  });

  it("a card has the canonical ID, title, assignee and honest estimate, and the reviewer only where it matters", () => {
    show([task("tsk_1", "accepted", { assignee: null }), task("tsk_2", "submitted")]);
    const accepted = within(column(/^Accepted/));
    expect(accepted.getByText("tsk_1")).toBeInTheDocument();
    expect(accepted.getByText("Unassigned")).toBeInTheDocument();
    expect(accepted.getByText("Not estimated")).toBeInTheDocument();
    expect(accepted.queryByText("Reviewer")).toBeNull();
    const review = within(column(/^Awaiting review/));
    expect(review.getByText("Architect")).toBeInTheDocument();
    expect(review.getByText("Reviewer").nextElementSibling).toHaveTextContent("You");
  });

  it("nothing can be dragged, and every column holds only links to the Sheet, with no control of its own", () => {
    setUrl("/w/ws_1/tasks?view=board&canceled=show");
    const { container } = show(everyState);
    expect(container.querySelector("[draggable='true']")).toBeNull();
    const columns = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.parentElement!);
    expect(columns).toHaveLength(TASK_STATUSES.length);
    for (const [index, section] of columns.entries()) {
      for (const role of ["button", "checkbox", "combobox", "menuitem", "textbox"]) expect(within(section).queryAllByRole(role)).toEqual([]);
      const links = within(section).getAllByRole("link");
      expect(links, `column ${index}`).toHaveLength(1);
      expect(links[0].getAttribute("href")).toMatch(/[?&]task=t_/);
    }
  });

  it("a truncated ID stays above the card's link, for its tooltip, without becoming a tab stop", async () => {
    const user = userEvent.setup();
    show([task("tsk_1", "submitted")]);
    const id = screen.getByTitle("tsk_1");
    expect(id).toHaveClass("relative", "z-10");
    expect(screen.getByTitle("agt_a").closest("dd")).toHaveClass("relative", "z-10");
    const stops: (Element | null)[] = [];
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      stops.push(document.activeElement);
    }
    expect(stops).toContain(screen.getByRole("link", { name: "Title tsk_1" }));
    expect(stops).not.toContain(id);
    expect(stops).not.toContain(screen.getByTitle("agt_a"));
  });

  it("a title is the text it is, and a long one's link stays one link", () => {
    show([task("a", "open", { title: "<b>Bold</b> **really**" })]);
    expect(screen.getByRole("link", { name: "<b>Bold</b> **really**" })).toHaveAttribute("href", "/w/ws_1/tasks?view=board&task=a");
  });

  it("flags a task needing attention, in words", () => {
    show([task("a", "open", { needs_attention: true })]);
    expect(within(column(/^Open/)).getByText("Needs a new reviewer or requester")).toBeInTheDocument();
  });

  it("a state this code doesn't know still shows, labeled as unknown", () => {
    show([task("a", "paused" as Task["status"])]);
    expect(within(column(/^Unknown state \(1\)/)).getByText("Title a")).toBeInTheDocument();
  });

  it("filters to what needs my review, leaving the columns up", () => {
    setUrl("/w/ws_1/tasks?view=board&review=mine");
    show([task("a", "submitted", { reviewer: "per_x" }), task("b", "accepted")]);
    expect(screen.getByText("No submissions are waiting for your review in this workroom.")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(5);
  });

  it("an empty room says so, and doesn't call it complete", () => {
    show([]);
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
    expect(screen.getByText(/No tasks in scope · 0 of 0 completed/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(5);
  });

  it("on a partial read, finding nothing to review only speaks for what loaded", () => {
    setUrl("/w/ws_1/tasks?view=board&review=mine");
    show([task("b", "accepted")], { cursor: "tsk_c50" });
    expect(screen.getByText(/None of the loaded tasks are waiting for your review. There may be more/)).toBeInTheDocument();
    expect(screen.queryByText("No submissions are waiting for your review in this workroom.")).toBeNull();
  });

  it("labels partial counts on a partial read", () => {
    show([task("a", "open")], { cursor: "tsk_c50" });
    expect(screen.getByRole("heading", { name: "Open (1 loaded)" })).toBeInTheDocument();
    expect(within(column(/^Accepted/)).getByText("None loaded")).toBeInTheDocument();
  });
});

describe("the task Sheet from either view", () => {
  it("a card opens the one Sheet, keeping the view, and closing returns focus to the card", async () => {
    setUrl("/w/ws_1/tasks?view=board");
    const user = userEvent.setup();
    show([task("a", "open")]);
    await user.click(screen.getByRole("link", { name: "Title a" }));
    expect(currentUrl()).toBe("/w/ws_1/tasks?view=board&task=a");
    await screen.findByRole("heading", { name: "Title a", level: 2, hidden: false });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/w/ws_1/tasks?view=board"));
    await waitFor(() => expect(screen.getByRole("link", { name: "Title a" })).toHaveFocus());
  });

  it("a view change under an open Sheet keeps that Sheet, and doesn't load it again", async () => {
    setUrl("/w/ws_1/tasks?task=a");
    const fetches = vi.fn();
    const answer = globalThis.fetch;
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
      fetches(args[0]);
      return answer(...args);
    });
    show([task("a", "open")]);
    await screen.findByRole("dialog");
    await screen.findByText("Requester");
    const reads = fetches.mock.calls.length;
    act(() => window.history.pushState(null, "", "/w/ws_1/tasks?task=a&view=board"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Requester")).toBeInTheDocument();
    expect(fetches.mock.calls.length).toBe(reads);
  });

  it("explains a selected task the filter hides, and focus falls back on close", async () => {
    setUrl("/w/ws_1/tasks?view=board&review=mine&task=b");
    const user = userEvent.setup();
    show([task("a", "submitted"), task("b", "accepted")]);
    expect(await screen.findByText(/outside the current filter/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
  });

  it("says nothing about a task it can't place, past the pages it loaded", async () => {
    setUrl("/w/ws_1/tasks?task=elsewhere");
    show([task("a", "open")], { cursor: "tsk_c50" });
    await screen.findByText("Requester");
    expect(screen.queryByText(/outside the current filter/)).toBeNull();
  });
});

describe("progress on the page", () => {
  const fixture = [...["1", "2", "3"].map((id) => task(id, "completed")), task("4", "submitted"), task("5", "accepted"), task("6", "accepted"), task("7", "offered"), task("8", "open"), task("9", "canceled")];

  it.each(["/w/ws_1/tasks", "/w/ws_1/tasks?view=board"])("is the same on %s, with exact counts for a screen reader", (url) => {
    setUrl(url);
    show(fixture);
    expect(screen.getByText("3 of 8 completed · 38%")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "38");
    expect(bar).toHaveAttribute("aria-valuetext", "3 of 8 completed, 38%");
  });

  it("a filter labels it, and counts only what matches", () => {
    setUrl("/w/ws_1/tasks?review=mine");
    show(fixture);
    expect(screen.getByRole("progressbar", { name: "Progress for filtered tasks" })).toHaveAttribute("aria-valuetext", "0 of 1 completed, 0%");
  });

  it("a guest's says it covers what they can see", () => {
    show(fixture, { room: room("guest") });
    expect(screen.getByRole("progressbar", { name: "Progress for tasks you can see" })).toBeInTheDocument();
  });

  it("a partial read gives loaded counts, and no percentage or bar", () => {
    show(fixture, { cursor: "tsk_c50" });
    expect(screen.getByText(/Loaded tasks only · partial · 3 of 8 loaded tasks completed/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/38%/)).toBeNull();
  });
});

describe("a refresh that fails", () => {
  it("with nothing loaded yet is a failure, not an empty room", () => {
    render(<KeptTasksScreen read={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh");
    expect(screen.queryByText(/No tasks/)).toBeNull();
  });

  it("keeps what was loaded, labeled as stale, and clears when a read succeeds", () => {
    const { rerender } = render(<KeptTasksScreen read={read([task("a", "completed")])} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<KeptTasksScreen read={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/last loaded/);
    expect(screen.getByRole("link", { name: "Title a" })).toBeInTheDocument();
    expect(screen.getByText("1 of 1 completed · 100%")).toBeInTheDocument();
    rerender(<KeptTasksScreen read={read([task("b", "open")])} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Title a")).toBeNull();
  });
});
