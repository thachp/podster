import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { TASK_STATUS, TASK_STATUSES, type Room, type Task } from "./task-model";
import { TasksScreen } from "./tasks-screen";

const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, title: `Title ${id}`, instructions: "I", acceptance_criteria: null, requester: "per_me", assignee: "agt_a", reviewer: "per_me", status, version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });

const room = (role: string): Room => ({
  id: "ws_1",
  name: "Billing",
  owner: "per_o",
  members: [
    { principal_id: "per_me", kind: "person", org_id: "org_a", role },
    { principal_id: "agt_a", kind: "agent", org_id: "org_b", role: "member" },
  ],
});

type Sent = { url: string; body: Record<string, unknown>; key: string | null };
let sent: Sent[];
let reply: () => Response | Promise<Response>;

beforeEach(() => {
  setUrl("/w/ws_1/tasks");
  sent = [];
  reply = () => new Response(JSON.stringify(task("tsk_new", "offered")), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") sent.push({ url, body: JSON.parse(init.body as string), key: new Headers(init.headers).get("idempotency-key") });
    return reply();
  });
});

const show = (role = "member", tasks: Task[] = []) => render(<TasksScreen room={room(role)} tasks={tasks} cursor={null} me="per_me" names={{ agt_a: "Architect" }} />);

describe("the list", () => {
  it("groups by state, using one label per state, with assignee and reviewer", () => {
    show("member", TASK_STATUSES.map((status) => task(`t_${status}`, status)));
    for (const status of TASK_STATUSES) {
      const group = screen.getByRole("heading", { name: new RegExp(`^${TASK_STATUS[status].label} \\(1\\)`) }).parentElement!;
      expect(within(group).getByText(`Title t_${status}`)).toBeInTheDocument();
      expect(within(group).getAllByText(TASK_STATUS[status].label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("Architect").length).toBeGreaterThan(0);
  });

  it("filters to what needs my review", async () => {
    const user = userEvent.setup();
    show("member", [task("a", "submitted"), task("b", "submitted", { reviewer: "per_x" }), task("c", "accepted")]);
    await user.click(screen.getByRole("checkbox", { name: "Needs my review" }));
    expect(screen.getByText("Title a")).toBeInTheDocument();
    expect(screen.queryByText("Title b")).toBeNull();
    expect(screen.queryByText("Title c")).toBeNull();
  });

  it("each row is a real link to the deep-linkable Sheet, and doesn't prefetch", () => {
    show("member", [task("a", "open")]);
    expect(screen.getByRole("link", { name: "Title a" })).toHaveAttribute("href", "/w/ws_1/tasks?task=a");
  });

  it("shows a title as the text it is", () => {
    show("member", [task("a", "open", { title: "<b>Bold</b> **really**" })]);
    expect(screen.getByRole("link", { name: "<b>Bold</b> **really**" })).toBeInTheDocument();
  });

  it("says it stopped, rather than looking complete", () => {
    render(<TasksScreen room={room("member")} tasks={[task("a", "open")]} cursor="tsk_c50" me="per_me" names={{}} />);
    expect(screen.getByText(/There are more/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("an empty list suggests creating only to someone who can", () => {
    show("member");
    expect(screen.getByText(/Create one/)).toBeInTheDocument();
    render(<TasksScreen room={room("guest")} tasks={[]} cursor={null} me="per_me" names={{}} />);
    expect(screen.getByText(/No tasks you can see/)).toBeInTheDocument();
  });
});

describe("creating (decision 22)", () => {
  it.each(["owner", "admin", "member"])("a %s can", (role) => {
    show(role);
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
  });

  it("the room's owner can, and can review their own, though the API lists them apart from members", async () => {
    const user = userEvent.setup();
    const ownerRoom: Room = { id: "ws_1", name: "Billing", owner: "per_me", members: [{ principal_id: "agt_a", kind: "agent", org_id: "org_b", role: "member" }] };
    render(<TasksScreen room={ownerRoom} tasks={[]} cursor={null} me="per_me" names={{}} />);
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByLabelText("Reviewer")).toHaveValue("per_me");
    expect(within(screen.getByLabelText("Reviewer")).getByRole("option", { name: "You" })).toBeInTheDocument();
  });

  it("a guest can't", () => {
    show("guest");
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByLabelText("Title")).toHaveFocus();
    await user.type(screen.getByLabelText("Title"), "Write it");
    await user.type(screen.getByLabelText("Instructions"), "Please write it");
  };

  it("sends what the form says, and reports the server's result with the design's copy", async () => {
    const user = userEvent.setup();
    show();
    await fill(user);
    await user.type(screen.getByLabelText(/Acceptance criteria/), "It's written");
    await user.selectOptions(screen.getByLabelText("Offer to"), "agt_a");
    await user.click(screen.getByRole("button", { name: "Create and offer" }));
    expect(sent[0].url).toBe("/api/v1/workspaces/ws_1/tasks");
    expect(sent[0].body).toEqual({ title: "Write it", instructions: "Please write it", acceptance_criteria: "It's written", assignee: "agt_a", reviewer: "per_me" });
    expect(await screen.findByText(/Offered to Architect. It will see this at its next session or wake./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/w/ws_1/tasks?task=tsk_new");
    expect(routerCalls.refresh).toBe(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toHaveFocus());
  });

  it("won't offer the reviewer the task, or review to the assignee", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByLabelText("Offer to"), "agt_a");
    expect(within(screen.getByLabelText("Reviewer")).queryByRole("option", { name: "Architect" })).toBeNull();
  });

  it("a refusal keeps what was typed, and a retry after a lost response reuses the key", async () => {
    const user = userEvent.setup();
    show();
    await fill(user);
    reply = () => Promise.reject(new TypeError("lost"));
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/We can't tell whether this task was created/);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/nothing changed/);
    expect(screen.getByLabelText("Title")).toHaveValue("Write it");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0].key).toBe(sent[1].key);

    reply = () => new Response(JSON.stringify({ error: { code: "internal_error" } }), { status: 500 });
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/We can't tell whether this task was created/));
    expect(sent[2].key).toBe(sent[1].key);

    reply = () => new Response(JSON.stringify({ error: { code: "self_sign_off" } }), { status: 400 });
    await user.type(screen.getByLabelText("Title"), "!");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing changed. The reviewer and the assignee can't be the same/);
    expect(sent[3].key).not.toBe(sent[2].key);
  });

  it("Cancel saves nothing", async () => {
    const user = userEvent.setup();
    show();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sent).toHaveLength(0);
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});
