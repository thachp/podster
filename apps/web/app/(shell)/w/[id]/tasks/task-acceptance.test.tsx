import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import type { Room, Task, TaskDetail } from "./task-model";
import { TaskSheet } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const ROOM: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] };

const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "Design the API", instructions: "Write it", acceptance_criteria: null, requester: "per_r", assignee: "per_me", reviewer: "per_r", status: "offered", version: 3, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const detail = (over: Partial<Task> = {}): TaskDetail => ({ task: task(over), submissions: [], artifacts: [], files: [], messages: [], history: [] });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];
let answer: (url: string, method: string) => Response;

beforeEach(() => {
  calls = [];
  setUrl("/w/ws_1/tasks?task=tsk_1");
  answer = () => json(200, detail());
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined, key: new Headers(init?.headers).get("idempotency-key") });
    return answer(url, method);
  });
});

const commands = () => calls.filter((call) => call.method !== "GET");

const open = async (me = "per_me") => {
  render(
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="task" target="tsk_1">
          Open
        </SheetLink>
      </main>
      <TaskSheet me={me} names={{}} room={ROOM} resolve={(target) => ({ workspace: ROOM.id, task: target })} />
    </>,
  );
  await screen.findByRole("heading", { name: "Design the API" });
};

describe("answering an offer", () => {
  it("is offered only to the one the task is offered to", async () => {
    await open("per_other");
    expect(screen.queryByRole("button", { name: "Accept task" })).toBeNull();
  });

  it("accepts against the version read, and says what's next", async () => {
    const user = userEvent.setup();
    await open();
    answer = (url, method) => (method === "POST" ? json(200, task({ status: "accepted", version: 4 })) : json(200, detail({ status: "accepted", version: 4 })));
    await user.click(screen.getByRole("button", { name: "Accept task" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/accept", body: { version: 3 } });
    expect(commands()[0].key).toBeTruthy();
    expect(await screen.findByText("Accepted. You can submit your work when it's ready.")).toBeInTheDocument();
    expect(await screen.findByRole("form", { name: "Submit work" })).toBeInTheDocument();
  });

  it("declines only with a reason, and Back returns focus to Decline", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Decline" }));
    const field = screen.getByLabelText("Why are you declining?");
    expect(field).toHaveFocus();
    expect(screen.getByRole("button", { name: "Decline task" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Decline" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Decline" }));
    await user.type(screen.getByLabelText("Why are you declining?"), "  Not my area  ");
    answer = (url, method) => (method === "POST" ? json(200, task({ status: "open", assignee: null, version: 4 })) : json(200, detail({ status: "open", assignee: null, version: 4 })));
    await user.click(screen.getByRole("button", { name: "Decline task" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/decline", body: { version: 3, reason: "Not my area" } });
    expect(await screen.findByText(/Declined. The task is open again/)).toBeInTheDocument();
  });

  it("treats an edit since reading as a conflict, not an acceptance", async () => {
    const user = userEvent.setup();
    await open();
    answer = (url, method) => (method === "POST" ? refused(409, "version_conflict") : json(200, detail()));
    await user.click(screen.getByRole("button", { name: "Accept task" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(screen.queryByText(/Accepted\./)).toBeNull();
  });

  it("says a refusal changed nothing", async () => {
    const user = userEvent.setup();
    await open();
    answer = (url, method) => (method === "POST" ? refused(403, "not_allowed") : json(200, detail()));
    await user.click(screen.getByRole("button", { name: "Accept task" }));
    expect(await screen.findByText(/nothing changed. Only the person this task is offered to/)).toBeInTheDocument();
  });
});
