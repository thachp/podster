import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { goToSignIn } from "./go-to-sign-in";
import { coordinatesPlan } from "./task-model";
import { TaskPlan } from "./task-plan";
import { candidates, durationText, offersEdit, parseDuration, planProblem, type PlanRead } from "./task-plan-model";
import type { LoadedTask } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const row = (id: string, title: string, status = "open", duration_days: number | null = null) => ({ id, title, status, assignee: null, reviewer: "per_r", duration_days });
const whole: PlanRead = {
  complete: true,
  plan_revision: 7,
  plan_changed_at: 1,
  tasks: [row("tsk_1", "This task", "open", 3), row("tsk_2", "First step"), row("tsk_3", "Second step"), row("tsk_4", "Dropped", "canceled")],
  edges: [{ predecessor: "tsk_2", successor: "tsk_1" }],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });

type Call = { url: string; method: string; body: any; key: string | null };
let calls: Call[];
let answers: Record<string, () => Response | Promise<Response>>;
const setUnsaved = vi.fn();
const refresh = vi.fn();
const refreshList = vi.fn();

const apiFor = (over: { status?: string; requester?: string; archived?: boolean; tasks?: string } = {}) =>
  ({
    data: { workspace: "ws_1", task: { id: "tsk_1", requester: over.requester ?? "per_me", status: over.status ?? "open" }, room: { id: "ws_1", name: "R", owner: "per_o", status: over.archived ? "archived" : "active", access: over.tasks ? { tasks: over.tasks } : undefined } },
    setUnsaved,
    setSending: vi.fn(),
    refresh,
    refreshList,
  }) as unknown as SheetApi<LoadedTask>;

const open = async (api = apiFor(), role: string | undefined = "member") => {
  render(<TaskPlan api={api} me="per_me" role={role} />);
  await userEvent.click(screen.getByRole("button", { name: "Show plan" }));
};
const openEditor = async (api = apiFor(), role: string | undefined = "member") => {
  await open(api, role);
  await userEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
};
const saves = () => calls.filter((call) => call.method === "PUT");

beforeEach(() => {
  calls = [];
  setUnsaved.mockClear();
  refresh.mockClear();
  refreshList.mockClear();
  answers = {
    GET: () => json(200, whole),
    PUT: () => json(200, { task_id: "tsk_1", duration_days: 5, predecessors: ["tsk_2", "tsk_3"], plan_revision: 8, plan_changed_at: 2 }),
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : null, key: new Headers(init.headers).get("idempotency-key") });
    return answers[method]();
  });
});

describe("reading a plan", () => {
  it("reads nothing until asked, because the read covers the whole room", async () => {
    render(<TaskPlan api={apiFor()} me="per_me" role="member" />);
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Show plan" }));
    expect(await screen.findByText(/3 working days, including acceptance and review/)).toBeInTheDocument();
    expect(screen.getByText(/First step/)).toBeInTheDocument();
    expect(calls[0].url).toBe("/api/v1/workspaces/ws_1/plan");
    expect(await screen.findByRole("heading", { name: "Plan" })).toHaveFocus();
  });

  it("says Not estimated, and shows titles as plain text", async () => {
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task"), row("tsk_2", "<b>First</b> **step**")] });
    await open();
    expect(await screen.findByText("Not estimated")).toBeInTheDocument();
    expect(screen.getByText(/<b>First<\/b> \*\*step\*\*/)).toBeInTheDocument();
  });

  it("marks a canceled predecessor as unresolved", async () => {
    answers.GET = () => json(200, { ...whole, edges: [{ predecessor: "tsk_4", successor: "tsk_1" }] });
    await open();
    expect(await screen.findByText(/Unresolved until it's removed/)).toBeInTheDocument();
  });

  it("shows someone narrowed what they can see, says so, and offers no edit even to a requester", async () => {
    answers.GET = () => json(200, { complete: false, tasks: [row("tsk_1", "This task", "open", 2)], edges: [] });
    await open();
    expect(await screen.findByText(/shows only tasks you can see/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });

  it("says when a room's plan is too large, and shows a predecessor too old to list as its ID", async () => {
    answers.GET = () => json(200, { ...whole, complete: false, edges: [{ predecessor: "tsk_old", successor: "tsk_1" }] });
    await open();
    expect(await screen.findByText(/too large to read in full/)).toBeInTheDocument();
    expect(screen.getByText("tsk_old")).toBeInTheDocument();
  });

  it("offers no edit on a task the read doesn't hold", async () => {
    answers.GET = () => json(200, { ...whole, complete: false, tasks: [row("tsk_9", "Another")], edges: [] });
    await open();
    expect(await screen.findByText(/too old to be in the room's plan read/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });

  it("says when the read fails, and can try again", async () => {
    answers.GET = () => refused(500, "internal");
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't load the plan");
    answers.GET = () => json(200, whole);
    await userEvent.click(screen.getByRole("button", { name: "Show plan" }));
    expect(await screen.findByText(/3 working days/)).toBeInTheDocument();
  });

  it("signs in again when the session has lapsed", async () => {
    answers.GET = () => refused(401, "unauthenticated");
    await open();
    await waitFor(() => expect(goToSignIn).toHaveBeenCalled());
  });
});

describe("who's offered the form", () => {
  it("offers it to the requester, and to an owner or admin who isn't, and not otherwise", () => {
    expect(offersEdit(whole, "per_me", "per_me", "member", false)).toBe(true);
    expect(offersEdit(whole, "agt_x", "per_me", "admin", false)).toBe(true);
    expect(offersEdit(whole, "agt_x", "per_me", "owner", false)).toBe(true);
    expect(offersEdit(whole, "agt_x", "per_me", "member", false)).toBe(false);
    expect(offersEdit(whole, "per_me", "per_me", "member", true)).toBe(false);
    expect(offersEdit({ ...whole, plan_revision: undefined }, "per_me", "per_me", "admin", false)).toBe(false);
  });

  it("offers a coordinator someone else's task, and not a plain member or a guest (issue 507)", async () => {
    expect(coordinatesPlan({ access: { tasks: "coordinate" } }, "member")).toBe(true);
    expect(coordinatesPlan({ access: { tasks: "all_create" } }, "member")).toBe(false);
    expect(coordinatesPlan({ access: { tasks: "coordinate" } }, "guest")).toBe(false);
    expect(coordinatesPlan({}, "member")).toBe(false);
    expect(offersEdit(whole, "agt_x", "per_me", "member", false, true)).toBe(true);
    expect(offersEdit(whole, "agt_x", "per_me", "member", true, true)).toBe(false);
    for (const [role, tasks, offered] of [["member", "coordinate", true], ["member", "all_create", false], ["guest", "coordinate", false]] as const) {
      await open(apiFor({ requester: "per_o", tasks }), role);
      await screen.findByText(/3 working days, including acceptance and review/);
      expect(screen.queryByRole("button", { name: "Edit plan" }) !== null).toBe(offered);
      cleanup();
    }
  });

  it("shows no form in an archived room", async () => {
    await open(apiFor({ archived: true }));
    await screen.findByText(/3 working days/);
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });
});

describe("editing a plan", () => {
  it("sends the whole plan against the revision it read, and shows what the server answered", async () => {
    await openEditor();
    const days = screen.getByLabelText("Estimate in working days");
    expect(days).toHaveFocus();
    expect(days).toHaveValue("3");
    await userEvent.clear(days);
    await userEvent.type(days, "5");
    await userEvent.click(screen.getByRole("button", { name: "Add Second step" }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(await screen.findByText(/Plan saved/)).toBeInTheDocument();
    expect(saves()[0].url).toBe("/api/v1/workspaces/ws_1/tasks/tsk_1/plan");
    expect(saves()[0].body).toEqual({ plan_revision: 7, duration_days: 5, predecessors: ["tsk_2", "tsk_3"] });
    expect(screen.getByText(/5 working days/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    // The list behind can show what the plan says, so it reads again too.
    expect(refreshList).toHaveBeenCalled();
    // The next save answers to the new revision, without reading the whole room again.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit plan" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Second step" }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1].body.plan_revision).toBe(8);
  });

  it("sends blank as not estimated", async () => {
    await openEditor();
    await userEvent.clear(screen.getByLabelText("Estimate in working days"));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(saves()[0].body.duration_days).toBeNull());
  });

  it("doesn't send anything but a whole number from 1 to 260", async () => {
    await openEditor();
    const days = screen.getByLabelText("Estimate in working days");
    for (const bad of ["0", "261", "1.5", "-2", "abc"]) {
      await userEvent.clear(days);
      await userEvent.type(days, bad);
      expect(days).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "Save plan" })).toBeDisabled();
    }
    expect(saves()).toEqual([]);
    expect(parseDuration(" 260 ")).toBe(260);
    expect(parseDuration("1")).toBe(1);
    expect(parseDuration("")).toBeNull();
    expect(durationText(1)).toContain("1 working day,");
  });

  it("holds the Sheet only while something has changed, and cancelling lets it go", async () => {
    await openEditor();
    expect(setUnsaved).not.toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Add Second step" }));
    expect(setUnsaved).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(setUnsaved).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "Edit plan" })).toHaveFocus();
    expect(saves()).toEqual([]);
  });

  it("on a finished task, offers only removing a predecessor", async () => {
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task", "completed", 3), row("tsk_4", "Dropped", "canceled")], edges: [{ predecessor: "tsk_4", successor: "tsk_1" }] });
    await openEditor(apiFor({ status: "completed" }));
    expect(screen.queryByLabelText("Estimate in working days")).toBeNull();
    expect(screen.queryByLabelText("Add a task that comes first")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove Dropped" }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(saves()[0].body).toEqual({ plan_revision: 7, duration_days: 3, predecessors: [] }));
  });

  it("doesn't offer a finished task's plan when the read may have left links out, and says why", async () => {
    answers.GET = () => json(200, { ...whole, complete: false, tasks: [row("tsk_1", "This task", "completed", 3)], edges: [] });
    await open(apiFor({ status: "completed" }));
    expect(await screen.findByText(/may have links this read leaves out/)).toBeInTheDocument();
    expect(screen.getByText("None shown")).toBeInTheDocument();
    expect(screen.queryByText("Nothing listed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });

  it("still offers an unfinished task's plan when the read is cut, because its list is always whole", async () => {
    answers.GET = () => json(200, { ...whole, complete: false });
    await openEditor();
    expect(screen.getByLabelText("Estimate in working days")).toBeInTheDocument();
  });

  it("treats a task as finished if the Sheet's newer read says so", async () => {
    await openEditor(apiFor({ status: "completed" }));
    expect(screen.queryByLabelText("Estimate in working days")).toBeNull();
  });

  it("restricts the form when only the plan read says finished", async () => {
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task", "completed", 3), row("tsk_2", "First step")] });
    await openEditor(apiFor({ status: "open" }));
    expect(screen.queryByLabelText("Estimate in working days")).toBeNull();
    expect(screen.queryByLabelText("Add a task that comes first")).toBeNull();
  });

  it("offers no form on a partial read when only the plan read says finished", async () => {
    answers.GET = () => json(200, { ...whole, complete: false, tasks: [row("tsk_1", "This task", "canceled", 3)], edges: [] });
    await open(apiFor({ status: "open" }));
    expect(await screen.findByText(/may have links this read leaves out/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });

  it("offers no Edit on a finished task with nothing to remove, and says so", async () => {
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task", "completed", 3)], edges: [] });
    await open(apiFor({ status: "completed" }));
    expect(await screen.findByText(/nothing left to change/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });

  it("moves focus somewhere that's still there after Add and Remove, and says what happened", async () => {
    answers.GET = () => json(200, { ...whole, edges: [{ predecessor: "tsk_2", successor: "tsk_1" }, { predecessor: "tsk_4", successor: "tsk_1" }] });
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add Second step" }));
    expect(screen.getByLabelText("Add a task that comes first")).toHaveFocus();
    expect(screen.getByText("Added Second step.")).toHaveAttribute("role", "status");
    // Removing the first moves to what's now first, then the last to the row before it, then the field.
    await userEvent.click(screen.getByRole("button", { name: "Remove First step" }));
    expect(screen.getByRole("button", { name: "Remove Dropped" })).toHaveFocus();
    expect(screen.getByText("Removed First step.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove Second step" }));
    expect(screen.getByRole("button", { name: "Remove Dropped" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Remove Dropped" }));
    expect(screen.getByLabelText("Add a task that comes first")).toHaveFocus();
  });

  it("on a finished task, moves from the last Remove to Save, because there's no field", async () => {
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task", "completed"), row("tsk_4", "Dropped", "canceled")], edges: [{ predecessor: "tsk_4", successor: "tsk_1" }] });
    await openEditor(apiFor({ status: "completed" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Dropped" }));
    expect(screen.getByRole("button", { name: "Save plan" })).toHaveFocus();
  });

  it("stops at 50 predecessors and says so", async () => {
    const others = Array.from({ length: 51 }, (_, n) => row(`tsk_p${n}`, `Task ${n}`));
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task"), ...others], edges: others.slice(0, 50).map((o) => ({ predecessor: o.id, successor: "tsk_1" })) });
    await openEditor();
    expect(screen.getByText(/can come after 50 others at most/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Task 50" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove Task 0" }));
    expect(screen.getByRole("button", { name: "Add Task 50" })).toBeEnabled();
  });

  it("tells tasks with the same title apart on their buttons", async () => {
    answers.GET = () => json(200, { ...whole, tasks: [row("tsk_1", "This task"), row("tsk_5", "Same"), row("tsk_6", "Same")], edges: [] });
    await openEditor();
    expect(screen.getByRole("button", { name: "Add Same (tsk_5)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Same (tsk_6)" })).toBeInTheDocument();
  });

  it("closes the form if a newer read shows this person can't edit any more", async () => {
    answers.PUT = () => refused(409, "plan_conflict");
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add Second step" }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    answers.GET = () => json(200, { complete: false, tasks: [row("tsk_1", "This task")], edges: [] });
    await userEvent.click(await screen.findByRole("button", { name: "Load the latest plan" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit plan" })).toBeNull());
    expect(screen.getByText(/shows only tasks you can see/)).toBeInTheDocument();
    // It says the draft went and why, whatever the reload then says, and focus doesn't fall away with the form.
    expect(await screen.findByText(/form has closed and your edits weren't saved/)).toHaveAttribute("role", "status");
    expect(screen.queryByText(/Your edits are still here/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Plan" })).toHaveFocus();
  });

  it("narrows what can be added, and never offers the task itself or what's chosen", () => {
    const found = candidates(whole, "tsk_1", ["tsk_2"], "");
    expect(found.shown.map((t) => t.id)).toEqual(["tsk_3", "tsk_4"]);
    expect(candidates(whole, "tsk_1", [], "second").shown.map((t) => t.id)).toEqual(["tsk_3"]);
    const many: PlanRead = { ...whole, tasks: Array.from({ length: 30 }, (_, n) => row(`t${n}`, `Task ${n}`)) };
    expect(candidates(many, "tsk_1", [], "")).toMatchObject({ total: 30 });
    expect(candidates(many, "tsk_1", [], "").shown).toHaveLength(10);
  });
});

describe("a refusal", () => {
  const refusedWith = async (status: number, code: string) => {
    answers.PUT = () => refused(status, code);
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add Second step" }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    return screen.findByRole("alert");
  };

  it.each([
    [409, "dependency_cycle", /wait for itself/],
    [422, "limit_exceeded", /reached a limit/],
    [409, "invalid_transition", /has finished/],
    [409, "workspace_archived", /archived/],
    [403, "not_allowed", /requester, or a human admin/],
    [404, "task_not_found", /isn't available any more/],
  ])("says why for %s %s, keeps the edits and takes focus, naming no task", async (status, code, words) => {
    const alert = await refusedWith(status, code);
    expect(alert).toHaveTextContent(words);
    expect(alert).toHaveFocus();
    expect(alert).not.toHaveTextContent(/step|tsk_/);
    expect(screen.getByRole("button", { name: "Remove Second step" })).toBeInTheDocument();
    expect(screen.getByLabelText("Estimate in working days")).toHaveValue("3");
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  it("on a conflict, loads the latest plan and keeps the edits, then saves against it", async () => {
    await refusedWith(409, "plan_conflict");
    expect(screen.getByRole("alert")).toHaveTextContent(/changed this room's plan/);
    answers.GET = () => json(200, { ...whole, plan_revision: 9, tasks: whole.tasks.map((t) => (t.id === "tsk_1" ? { ...t, duration_days: 4 } : t)) });
    answers.PUT = () => json(200, { task_id: "tsk_1", duration_days: 3, predecessors: ["tsk_2", "tsk_3"], plan_revision: 10, plan_changed_at: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Load the latest plan" }));
    expect(await screen.findByText(/This is the latest plan/)).toBeInTheDocument();
    expect(screen.getByText(/4 working days/)).toBeInTheDocument();
    expect(screen.getByLabelText("Estimate in working days")).toHaveValue("3");
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(saves()[1].body.plan_revision).toBe(9));
  });

  it("keeps the problem and says so when loading the latest plan fails, with the save still on the old revision", async () => {
    await refusedWith(409, "plan_conflict");
    answers.GET = () => refused(500, "internal");
    await userEvent.click(screen.getByRole("button", { name: "Load the latest plan" }));
    expect(await screen.findByText(/couldn't load the latest plan/)).toBeInTheDocument();
    expect(screen.queryByText(/This is the latest plan/)).toBeNull();
    expect(screen.getByText(/changed this room's plan/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load the latest plan" })).toBeInTheDocument();
    // It clears once a read works.
    answers.GET = () => json(200, whole);
    await userEvent.click(screen.getByRole("button", { name: "Load the latest plan" }));
    expect(await screen.findByText(/This is the latest plan/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load the latest plan/)).toBeNull();
  });

  it("clears a failed reload's alert when a save then works", async () => {
    await refusedWith(500, "internal");
    answers.GET = () => refused(500, "internal");
    await userEvent.click(screen.getByRole("button", { name: "Load the latest plan" }));
    expect(await screen.findByText(/couldn't load the latest plan/)).toBeInTheDocument();
    answers.PUT = () => json(200, { task_id: "tsk_1", duration_days: 3, predecessors: ["tsk_2", "tsk_3"], plan_revision: 8, plan_changed_at: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(await screen.findByText(/Plan saved/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load the latest plan/)).toBeNull();
  });

  it("after a lost response, can't claim either way, and repeating it uses the same key", async () => {
    await refusedWith(500, "internal");
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't confirm/);
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1].key).toBe(saves()[0].key);
  });

  it("words anything else without promising", () => {
    expect(planProblem("something_new", 400)).toMatch(/nothing changed.*may no longer be allowed/);
    expect(planProblem("x", 429)).toMatch(/Too many requests/);
    expect(planProblem("x", 401)).toMatch(/session has ended/);
  });
});
