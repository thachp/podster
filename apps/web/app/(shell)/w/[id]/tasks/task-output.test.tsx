import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import { eventVerb, auditAction } from "../activity/model";
import type { Room, Task, TaskDetail } from "./task-model";
import { verbFor } from "./task-model";
import { outputLinkProblem } from "./task-output";
import { TaskSheet } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const ROOM: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] };

const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "Design the API", instructions: "Write it", acceptance_criteria: null, requester: "per_me", assignee: "agt_a", reviewer: "per_r", status: "accepted", version: 3, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const detail = (over: Partial<Task> = {}, output: TaskDetail["expected_output"] = { id: "out_1", title: "Design doc", removed: false }): TaskDetail => ({ task: task(over), expected_output: output, submissions: [], artifacts: [], files: [], messages: [], history: [] });
const OUTPUTS = { outputs: [{ id: "out_1", title: "Design doc", description: null, status: "not_started", current: null }, { id: "out_2", title: "Launch <b>plan</b>", description: null, status: "not_started", current: null }], ready: 0, total: 2 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];
let answer: (url: string, method: string) => Response;

beforeEach(() => {
  calls = [];
  setUrl("/w/ws_1/tasks?task=tsk_1");
  answer = (url) => (url.endsWith("/outputs") ? json(200, OUTPUTS) : json(200, detail()));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined, key: new Headers(init?.headers).get("idempotency-key") });
    return answer(url, method);
  });
});

const commands = () => calls.filter((call) => call.method !== "GET");

const open = async (me = "per_me", room = ROOM) => {
  render(
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="task" target="tsk_1">
          Open
        </SheetLink>
      </main>
      <TaskSheet me={me} names={{}} room={room} resolve={(target) => ({ workspace: room.id, task: target })} />
    </>,
  );
  await screen.findByRole("heading", { name: "Design the API" });
};

const expand = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByText("Change expected output"));
  return screen.findByLabelText("Expected output");
};

describe("a task's expected output", () => {
  it("shows the output a task works toward, a removed one as removed, and none", async () => {
    await open();
    expect(screen.getByText("Expected output", { selector: "dt" }).nextElementSibling).toHaveTextContent("Design doc");
  });

  it.each([
    [{ id: "out_1", title: "Old", removed: true }, "Old (removed)"],
    [null, "None"],
  ] as const)("names %o as %s", async (output, text) => {
    answer = (url) => (url.endsWith("/outputs") ? json(200, OUTPUTS) : json(200, detail({}, output)));
    await open();
    expect(screen.getByText("Expected output", { selector: "dt" }).nextElementSibling).toHaveTextContent(text);
  });

  it("loads the choices only when asked, and sets one against the version read", async () => {
    const user = userEvent.setup();
    await open();
    expect(calls.some((call) => call.url.endsWith("/outputs"))).toBe(false);
    const select = await expand(user);
    expect(screen.getByRole("option", { name: "Launch <b>plan</b>" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set output" })).toBeDisabled();
    await user.selectOptions(select, "out_2");
    answer = (url, method) => (method === "PUT" ? json(200, task({ version: 4 })) : url.endsWith("/outputs") ? json(200, OUTPUTS) : json(200, detail({ version: 4 }, { id: "out_2", title: "Launch <b>plan</b>", removed: false })));
    await user.click(screen.getByRole("button", { name: "Set output" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toMatchObject({ method: "PUT", url: "/api/v1/workspaces/ws_1/tasks/tsk_1/expected-output", body: { version: 3, output_id: "out_2" } });
    expect(commands()[0].key).toBeTruthy();
    expect(await screen.findByText("This task now works toward “Launch <b>plan</b>”.")).toBeInTheDocument();
  });

  it("sends null for none", async () => {
    const user = userEvent.setup();
    await open();
    await user.selectOptions(await expand(user), "");
    answer = (url, method) => (method === "PUT" ? json(200, task({ version: 4 })) : json(200, detail({ version: 4 }, null)));
    await user.click(screen.getByRole("button", { name: "Set output" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0].body).toEqual({ version: 3, output_id: null });
  });

  it.each(["version_conflict", "invalid_transition"])("treats %s as a conflict, and retries the new version with a new key", async (code) => {
    const user = userEvent.setup();
    await open();
    await user.selectOptions(await expand(user), "out_2");
    answer = (url, method) => (method === "PUT" ? refused(409, code) : url.endsWith("/outputs") ? json(200, OUTPUTS) : json(200, detail({ version: 5 })));
    await user.click(screen.getByRole("button", { name: "Set output" }));
    expect(await screen.findByText(/This task changed while you were editing/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review latest" }));
    await waitFor(() => expect(screen.getByText("Expected output", { selector: "dt" })).toBeInTheDocument());
    await user.selectOptions(await expand(user), "out_2");
    answer = (url, method) => (method === "PUT" ? json(200, task({ version: 6 })) : url.endsWith("/outputs") ? json(200, OUTPUTS) : json(200, detail({ version: 6 })));
    await user.click(screen.getByRole("button", { name: "Set output" }));
    await waitFor(() => expect(commands()).toHaveLength(2));
    expect(commands()[1].body).toEqual({ version: 5, output_id: "out_2" });
    expect(commands()[1].key).not.toBe(commands()[0].key);
  });

  it("says why a refusal changed nothing", async () => {
    const user = userEvent.setup();
    await open();
    await user.selectOptions(await expand(user), "out_2");
    answer = (url, method) => (method === "PUT" ? refused(404, "output_not_found") : url.endsWith("/outputs") ? json(200, OUTPUTS) : json(200, detail()));
    await user.click(screen.getByRole("button", { name: "Set output" }));
    expect(await screen.findByText(/nothing changed. That output isn't there any more/)).toBeInTheDocument();
  });

  it("isn't offered to someone who's neither the requester nor an admin", async () => {
    answer = () => json(200, detail({ requester: "per_r", reviewer: "per_x" }));
    await open();
    expect(screen.queryByText("Change expected output")).toBeNull();
  });

  it("isn't offered once the task is submitted (decision 137)", async () => {
    answer = () => json(200, detail({ status: "submitted", submission_no: 1, assignee: "agt_a", reviewer: "per_r" }));
    await open();
    expect(screen.queryByText("Change expected output")).toBeNull();
  });

  it("offers a retry when the choices don't load", async () => {
    const user = userEvent.setup();
    answer = (url) => (url.endsWith("/outputs") ? json(503, { error: { code: "upstream_unavailable" } }) : json(200, detail()));
    await open();
    await user.click(screen.getByText("Change expected output"));
    expect(await screen.findByText(/Couldn't load this workroom's outputs/)).toHaveAttribute("role", "alert");
  });
});

describe("output words", () => {
  it("labels the four output events in the room's activity, the audit log and the task's history", () => {
    expect(["output.defined", "output.updated", "output.removed", "task.output_changed"].map(eventVerb)).toEqual(["defined an expected output", "renamed an expected output", "removed an expected output", "changed a task's expected output"]);
    for (const type of ["output.defined", "output.updated", "output.removed", "task.output_changed"]) expect(auditAction(type)).not.toBe(type);
    expect(verbFor({ type: "task.output_changed", prior_status: null })).toBe("changed the expected output");
  });

  it("words a lost answer as unknown", () => {
    expect(outputLinkProblem("unknown", 0)).toMatch(/can't tell whether the expected output changed/);
  });
});
