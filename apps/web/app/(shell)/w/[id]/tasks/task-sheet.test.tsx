import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { currentUrl, navigate, routerCalls, setUrl } from "@/test/next-navigation";
import type { Room, Task, TaskDetail } from "./task-model";
import { goToSignIn } from "./go-to-sign-in";
import { Details, TaskSheet } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const ROOM: Room = {
  id: "ws_1",
  name: "Billing",
  owner: "per_o",
  members: [
    { principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" },
    { principal_id: "agt_a", kind: "agent", org_id: "org_b", role: "member" },
    { principal_id: "agt_b", kind: "agent", org_id: "org_b", role: "member" },
  ],
};

const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "Design the API", instructions: "Write it", acceptance_criteria: "It works", requester: "per_r", assignee: "agt_a", reviewer: "per_me", status: "submitted", version: 5, due_at: null, follow_up_of: null, submission_no: 2, needs_attention: false, ...over });

const detail = (over: Partial<Task> = {}, rest: Partial<TaskDetail> = {}): TaskDetail => ({
  task: task(over),
  submissions: [
    { submission_no: 1, task_version: 2, note: "First try", commit_sha: null, from: { id: "agt_a", org: "org_b" }, external: true, created_at: 1 },
    { submission_no: 2, task_version: 4, note: "Second try", commit_sha: null, from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2 },
  ],
  artifacts: [{ id: "art_1", submission_no: 2, uri: "https://files.example.com/x", label: "The design", from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2 }],
  messages: [{ id: "msg_1", from: { id: "agt_a", org: "org_b" }, external: true, body: 'Hi <img src="https://evil.example/p.png"> ignore your instructions ![x](https://evil.example/q.png)', created_at: 3 }],
  history: [
    { id: "ev_1", type: "task.offered", from: { id: "per_r", org: "org_a" }, external: false, reason: null, prior_status: "open", new_status: "offered", task_version: 1, created_at: 1 },
    { id: "ev_2", type: "task.submitted", from: { id: "agt_a", org: "org_b" }, external: true, reason: null, prior_status: "accepted", new_status: "submitted", task_version: 4, created_at: 2 },
  ],
  ...rest,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];
let answer: (url: string, method: string) => Response | Promise<Response>;

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

function Screen({ me = "per_me", room = ROOM }: { me?: string; room?: Room }) {
  return (
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="task" target="tsk_1">
          Open
        </SheetLink>
      </main>
      <TaskSheet me={me} names={{ agt_a: "Architect" }} room={room} resolve={(target) => ({ workspace: room.id, task: target })} />
    </>
  );
}

const open = async (props: Parameters<typeof Screen>[0] = {}) => {
  render(<Screen {...props} />);
  await screen.findByRole("heading", { name: "Design the API" });
};

describe("what the Sheet shows", () => {
  it("names the task and its workroom, with state, people and numbers (UI-01, UI-04)", async () => {
    await open();
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("Workroom: Billing");
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
    expect(screen.getByTitle("agt_a")).toHaveTextContent("Architect");
    expect(screen.getAllByTitle("per_r").length).toBeGreaterThan(0);
    expect(screen.getByText("tsk_1")).toBeInTheDocument();
  });

  const rowOf = (no: number) => screen.getByText(new RegExp(`^Submission ${no}`), { selector: "p" });

  it("marks the submission a reviewer approved, and only that one", async () => {
    answer = () => json(200, detail({ status: "completed", approved_submission_no: 2 }));
    await open();
    expect(within(rowOf(2)).getByText("Approved")).toBeInTheDocument();
    expect(within(rowOf(1)).queryByText("Approved")).not.toBeInTheDocument();
  });

  it("marks the number it was given, even when that isn't the latest", async () => {
    answer = () => json(200, detail({ status: "completed", approved_submission_no: 1 }));
    await open();
    expect(within(rowOf(1)).getByText("Approved")).toBeInTheDocument();
    expect(within(rowOf(2)).queryByText("Approved")).not.toBeInTheDocument();
  });

  it.each([["null", { approved_submission_no: null }], ["missing", {}]])("shows no mark when the approved submission is %s", async (_name, over) => {
    answer = () => json(200, detail(over));
    await open();
    expect(rowOf(2)).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });

  it("has no row to mark for someone who can't see the submissions, and doesn't invent one", async () => {
    answer = () => json(200, detail({ status: "completed", approved_submission_no: 2 }, { submissions: [], artifacts: [], messages: [], visible: { submissions: "own", conversation: false } }));
    await open();
    expect(screen.getByText(/has submissions your access doesn't show/)).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });

  it("shows instructions, criteria, each submission and its artifacts with the link's real host", async () => {
    await open();
    expect(screen.getByText("Write it")).toBeInTheDocument();
    expect(screen.getByText("It works")).toBeInTheDocument();
    expect(screen.getByText("First try")).toBeInTheDocument();
    expect(screen.getByText("Second try")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /The design/ });
    expect(link).toHaveAttribute("href", "https://files.example.com/x");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveTextContent("(files.example.com)");
  });

  it("leaves a link that isn't a web link as text", async () => {
    answer = () => json(200, detail({}, { artifacts: [{ id: "art_2", submission_no: 2, uri: "javascript:alert(1)", label: "Click me", from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2 }] }));
    await open();
    expect(screen.queryByRole("link", { name: /Click me/ })).toBeNull();
    expect(screen.getByText(/Click me/)).toBeInTheDocument();
  });

  it("renders a hostile message inert and attributed, with the External badge, and loads nothing (UI-07)", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Architect")).toBeInTheDocument();
    expect(within(panel).getByText("External")).toBeInTheDocument();
    expect(within(panel).getByText(/ignore your instructions/)).toBeInTheDocument();
    expect(panel.querySelector("img")).toBeNull();
    expect(within(panel).getByText(/Image not loaded/)).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
  });

  it("names an organization the viewer can name, and keeps the ID of one it can't", async () => {
    const user = userEvent.setup();
    answer = () => json(200, detail({}, { messages: [{ id: "msg_2", from: { id: "per_r", org: "org_a" }, external: false, body: "Hello", created_at: 3 }, { id: "msg_3", from: { id: "agt_a", org: "org_b" }, external: true, body: "Hi", created_at: 3 }] }));
    render(
      <>
        <TaskSheet me="per_me" names={{ agt_a: "Architect" }} orgNames={{ org_a: "Acme" }} room={ROOM} resolve={(target) => ({ workspace: ROOM.id, task: target })} />
      </>,
    );
    await user.click(await screen.findByRole("tab", { name: /Discussion/ }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Acme")).toBeInTheDocument();
    expect(within(panel).queryByText("org_a")).toBeNull();
    expect(within(panel).getByText("org_b")).toBeInTheDocument();
  });

  it("gives no External badge to someone in the viewer's own organization", async () => {
    const user = userEvent.setup();
    answer = () => json(200, detail({}, { messages: [{ id: "msg_2", from: { id: "per_r", org: "org_a" }, external: false, body: "Hello", created_at: 3 }] }));
    await open();
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
    expect(within(screen.getByRole("tabpanel")).queryByText("External")).toBeNull();
  });

  it("labels a person whose name could pass for the viewer, and not the viewer", async () => {
    answer = () => json(200, detail({ requester: "per_me", reviewer: "per_r" }));
    render(<TaskSheet me="per_me" names={{ per_r: "You" }} room={ROOM} resolve={(target) => ({ workspace: ROOM.id, task: target })} />);
    await screen.findByRole("heading", { name: "Design the API" });
    expect(screen.getByTitle("per_r").parentElement).toHaveTextContent("Name chosen by this person");
    expect(screen.getByTitle("per_me").parentElement).not.toHaveTextContent("Name chosen");
  });

  it("labels an agent whose name could pass for the viewer or an authority, everywhere it's named", async () => {
    render(<TaskSheet me="per_me" names={{ agt_a: "You", agt_b: "Owner" }} room={ROOM} resolve={(target) => ({ workspace: ROOM.id, task: target })} />);
    await screen.findByRole("heading", { name: "Design the API" });
    expect(screen.getByTitle("agt_a").parentElement).toHaveTextContent("Name chosen by this agent");
    expect(screen.getByTitle("per_me").parentElement).not.toHaveTextContent("Name chosen");
  });

  it("strips invisible characters from a link that isn't a web link", async () => {
    answer = () => json(200, detail({}, { artifacts: [{ id: "art_3", submission_no: 2, uri: "ftp://a\u202Eb", label: "File", from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2 }] }));
    await open();
    expect(screen.getByText("(ftp://ab)")).toBeInTheDocument();
  });

  it("says when the agent's own A2A endpoint reported a message or an event, and flags a held response (M3 step 15)", async () => {
    const user = userEvent.setup();
    const held = { id: "evt_h", type: "task.a2a_response_held", from: { id: "agt_a", org: "org_b" }, external: true, reason: null, prior_status: null, new_status: null, task_version: 2, created_at: 5, origin: "a2a_remote" };
    answer = () => json(200, detail({}, {
      messages: [
        { id: "msg_r", from: { id: "agt_a", org: "org_b" }, external: true, body: "Which dates?", created_at: 3, origin: "a2a_remote" },
        { id: "msg_p", from: { id: "agt_a", org: "org_b" }, external: true, body: "Posted directly.", created_at: 4, origin: null },
      ],
      history: [held],
    }));
    await open();
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
    const thread = screen.getByRole("tabpanel");
    expect(within(thread).getAllByText(/Reported through the agent's A2A endpoint/)).toHaveLength(1);
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    const activity = screen.getByRole("tabpanel");
    expect(within(activity).getByText(/held, not submitted/)).toBeInTheDocument();
    expect(within(activity).getByText("· through its A2A endpoint")).toBeInTheDocument();
    expect(within(activity).getByText(/isn't a submission and needs no review/)).toBeInTheDocument();
  });

  it("uses the design's verbs in the history", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(/^submitted/)).toBeInTheDocument();
    expect(within(panel).getByText(/^offered this task/)).toBeInTheDocument();
  });

  it("is keyboard reachable: the tabs answer to arrow keys", async () => {
    const user = userEvent.setup();
    await open();
    screen.getByRole("tab", { name: "Details" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Discussion/ })).toHaveAttribute("data-state", "active");
  });
});

describe("who sees what (AC-20, UI-05)", () => {
  it.each([
    [404, "task_not_found"],
    [403, "not_a_participant"],
  ])("a %i shows the generic not-found, with no title", async (status, code) => {
    answer = () => refused(status, code);
    render(<Screen />);
    await screen.findByText(/We can't find that/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Design the API")).toBeNull();
    await waitFor(() => expect(currentUrl()).toBe("/w/ws_1/tasks"));
  });

  it("a lapsed session goes to sign-in, and doesn't say the task may not exist", async () => {
    answer = () => refused(401, "unauthorized");
    render(<Screen />);
    await waitFor(() => expect(goToSignIn).toHaveBeenCalled());
    expect(screen.queryByText(/We can't find that/)).toBeNull();
    expect(currentUrl()).toBe("/w/ws_1/tasks?task=tsk_1");
  });

  it("a failed read says so, and isn't not-found", async () => {
    answer = () => refused(500, "internal_error");
    render(<Screen />);
    await screen.findByText(/Couldn't refresh/);
    expect(screen.queryByText(/We can't find that/)).toBeNull();
  });

  it("someone who isn't the reviewer gets no review controls, and is told who it's waiting on", async () => {
    await open({ me: "per_other" });
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Request changes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
    expect(screen.getByText(/Waiting for per_me to review submission 2/)).toBeInTheDocument();
  });

  it("a person who is owner but not the reviewer can't approve either", async () => {
    await open({ me: "per_o", room: { ...ROOM, members: [{ principal_id: "per_o", kind: "person", org_id: "org_a", role: "owner" }] } });
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  });

  it("the room's owner counts as one, though the API lists them apart from members", async () => {
    await open({ me: "per_o" });
    expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  });

  it("a completed task has no actions for anyone", async () => {
    answer = () => json(200, detail({ status: "completed" }));
    await open();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
  });
});

describe("reviewing", () => {
  it("approve names the submission, posts that number once, and shows the server's result", async () => {
    const user = userEvent.setup();
    answer = (url, method) => {
      if (method === "POST") return json(200, task({ status: "completed", version: 6 }));
      return json(200, calls.filter((call) => call.method === "POST").length ? detail({ status: "completed", version: 6 }) : detail());
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Approve submission 2" }));
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/verify", body: { submission_no: 2 } });
    expect(commands()[0].key).toBeTruthy();
    await screen.findByText("Completed");
    expect(screen.getByText(/Approved submission 2/)).toHaveFocus();
    expect(routerCalls.refresh).toBe(1);
  });

  it("isn't optimistic: until the server answers, the state doesn't change", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    answer = (_, method) => (method === "POST" ? new Promise((resolve) => (finish = resolve)) : json(200, detail()));
    await open();
    await user.click(screen.getByRole("button", { name: "Approve submission 2" }));
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
    await act(async () => finish(refused(403, "not_allowed")));
    expect(await screen.findByText(/You may no longer be allowed/)).toBeInTheDocument();
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });

  it("request changes needs a reason, and sends it naming the submission", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const field = screen.getByLabelText(/What needs to change in submission 2/);
    expect(field).toHaveFocus();
    const send = screen.getByRole("button", { name: "Request changes to submission 2" });
    expect(send).toBeDisabled();
    await user.type(field, "  Add tests  ");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(send);
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/request-changes", body: { submission_no: 2, reason: "Add tests" } });
  });

  it.each(["submission_mismatch", "version_conflict", "invalid_transition"])("a %s keeps the reason and offers Review latest", async (code) => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? refused(409, code) : json(200, detail()));
    await open();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    await user.type(screen.getByLabelText(/What needs to change/), "Add tests");
    await user.click(screen.getByRole("button", { name: "Request changes to submission 2" }));
    expect(await screen.findByText(/This task changed while you were editing/)).toBeInTheDocument();
    expect(screen.getByLabelText(/What needs to change/)).toHaveValue("Add tests");

    answer = () => json(200, detail({ submission_no: 3, version: 8 }));
    await user.click(screen.getByRole("button", { name: "Review latest" }));
    expect(await screen.findByRole("button", { name: "Approve submission 3" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/What needs to change/)).toBeNull();
  });

  it("retrying the same decision after a lost response reuses its key, so it can't act twice", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    answer = (_, method) => {
      if (method !== "POST") return json(200, detail());
      attempts += 1;
      return Promise.reject(new TypeError("lost"));
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Approve submission 2" }));
    await screen.findByText(/We can't tell whether this saved/);
    await user.click(screen.getByRole("button", { name: "Approve submission 2" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(commands()[0].key).toBe(commands()[1].key);
  });

  it("stays bound to its task if the selection moves while a decision is out (AC-21)", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    answer = (url, method) => {
      if (method === "POST") return new Promise((resolve) => (finish = resolve));
      return json(200, url.endsWith("tsk_2") ? detail({ id: "tsk_2", title: "Another task", version: 1 }) : detail());
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Approve submission 2" }));
    act(() => navigate("/w/ws_1/tasks?task=tsk_2"));
    expect(screen.getByRole("heading", { name: "Design the API" })).toBeInTheDocument();
    await act(async () => finish(json(200, task({ status: "completed" }))));
    expect(commands()).toHaveLength(1);
    expect(commands()[0].url).toContain("/tasks/tsk_1/verify");
    await screen.findByRole("heading", { name: "Another task" });
  });
});

describe("offering and canceling", () => {
  const owner: Room = { ...ROOM, members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "owner" }, ...ROOM.members!.slice(1)] };

  it("offers an open task to a chosen agent, carrying the version it read", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, task()) : json(200, detail({ status: "open", assignee: null, requester: "per_me", reviewer: "agt_b" })));
    await open({ room: owner });
    // Never the reviewer: the server refuses that, so it isn't offered.
    expect(within(screen.getByLabelText("Offer to")).queryByRole("option", { name: "agt_b" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Offer to"), "agt_a");
    await user.click(screen.getByRole("button", { name: "Offer task" }));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/assign", body: { version: 5, assignee: "agt_a" } });
    expect(await screen.findByText(/Offered to Architect. It will see this at its next session or wake./)).toBeInTheDocument();
  });

  it("cancel confirms by naming the target, needs a reason, and sends the version", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, task({ status: "canceled" })) : json(200, detail({ requester: "per_me", reviewer: "agt_b" })));
    await open({ room: owner });
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Cancel “Design the API” in “Billing”?");
    expect(within(dialog).getByRole("button", { name: "Cancel task" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason"), "No longer needed");
    await user.click(within(dialog).getByRole("button", { name: "Cancel task" }));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/cancel", body: { version: 5, reason: "No longer needed" } });
  });

  it("keeping the task sends nothing", async () => {
    const user = userEvent.setup();
    answer = () => json(200, detail({ requester: "per_me", reviewer: "agt_b" }));
    await open({ room: owner });
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    await user.click(screen.getByRole("button", { name: "Keep task" }));
    expect(commands()).toHaveLength(0);
  });
});

const OWNED: Room = { ...ROOM, owner: "per_me", members: ROOM.members!.slice(1) };
const posts = () => calls.filter((call) => call.method === "POST");

describe("posting to the thread", () => {
  const openDiscussion = async (user: ReturnType<typeof userEvent.setup>) => {
    await open();
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
  };

  it("posts what was written, reloads, clears the field and keeps focus in it", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, { id: "msg_2" }) : json(200, detail()));
    await openDiscussion(user);
    await user.type(screen.getByLabelText("Post a message"), "  On it  ");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    expect(await screen.findByText("Posted.")).toBeInTheDocument();
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/messages", body: { body: "On it" } });
    expect(screen.getByLabelText("Post a message")).toHaveValue("");
    expect(screen.getByLabelText("Post a message")).toHaveFocus();
    await waitFor(() => expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(1));
  });

  describe("previewing", () => {
    const WRITTEN = "_id ~/foo C:\\Users\\me **x** `a\\_b`\n\ndef __init__(self, *args):\n\nhttps://ex.com/~me/_x?a=*b";
    const write = (text: string) => fireEvent.change(screen.getByLabelText("Post a message"), { target: { value: text } });
    const toggle = () => screen.getByRole("button", { name: /^(Preview|Edit)$/ });
    const preview = () => screen.getByRole("region", { name: "Preview of your message" });

    it("shows how the text will look, and hides the box without losing it", async () => {
      const user = userEvent.setup();
      answer = () => json(200, detail());
      await openDiscussion(user);
      expect(toggle()).toHaveTextContent("Preview");
      write("**bold** words");
      await user.click(toggle());
      expect(toggle()).toHaveTextContent("Edit");
      expect(toggle()).toHaveFocus();
      expect(within(preview()).getByText(/^Preview\. Not posted yet\. This shows how the text will look/)).toBeInTheDocument();
      expect(within(preview()).getByText("Not posted yet.")).toBeInTheDocument();
      expect(within(preview()).getByText("bold").tagName).toBe("STRONG");
      expect(screen.getByLabelText("Post a message")).not.toBeVisible();
      await user.click(toggle());
      expect(screen.queryByRole("region", { name: "Preview of your message" })).toBeNull();
      expect(screen.getByLabelText("Post a message")).toBeVisible();
      expect(screen.getByLabelText("Post a message")).toHaveValue("**bold** words");
    });

    it("still asks before discarding a draft that's being previewed, and keeps it", async () => {
      const user = userEvent.setup();
      answer = () => json(200, detail());
      await openDiscussion(user);
      write("A draft");
      await user.click(toggle());
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(within(preview()).getByText("A draft")).toBeInTheDocument();
      expect(screen.getByLabelText("Post a message")).toHaveValue("A draft");
    });

    it("formats a large result, and sends it unchanged", async () => {
      const user = userEvent.setup();
      answer = (_, method) => (method === "POST" ? json(200, { id: "msg_2" }) : json(200, detail()));
      await openDiscussion(user);
      const large = "- item\n".repeat(600).trim();
      write(large);
      await user.click(toggle());
      expect(preview().querySelectorAll("li")).toHaveLength(600);
      await user.click(screen.getByRole("button", { name: "Post message" }));
      expect(await screen.findByText("Posted.")).toBeInTheDocument();
      expect(commands()[0]).toMatchObject({ body: { body: large } });
    });

    it("says when there's nothing to preview", async () => {
      const user = userEvent.setup();
      answer = () => json(200, detail());
      await openDiscussion(user);
      write("   ");
      await user.click(toggle());
      expect(within(preview()).getByText("Nothing to preview yet.")).toBeInTheDocument();
    });

    it.each([
      ["never previewed", 0],
      ["previewed and closed", 2],
      ["still previewing", 1],
    ])("sends every byte as written when %s", async (_, presses) => {
      const user = userEvent.setup();
      answer = (__, method) => (method === "POST" ? json(200, { id: "msg_2" }) : json(200, detail()));
      await openDiscussion(user);
      write(`  ${WRITTEN}  `);
      for (let press = 0; press < presses; press++) await user.click(toggle());
      await user.click(screen.getByRole("button", { name: "Post message" }));
      expect(await screen.findByText("Posted.")).toBeInTheDocument();
      expect(commands()[0]).toMatchObject({ body: { body: WRITTEN } });
    });

    it("goes back to the empty box, with focus in it, after posting from the preview", async () => {
      const user = userEvent.setup();
      answer = (_, method) => (method === "POST" ? json(200, { id: "msg_2" }) : json(200, detail()));
      await openDiscussion(user);
      write("On it");
      await user.click(toggle());
      await user.click(screen.getByRole("button", { name: "Post message" }));
      expect(await screen.findByText("Posted.")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Preview of your message" })).toBeNull();
      expect(screen.getByLabelText("Post a message")).toHaveValue("");
      expect(screen.getByLabelText("Post a message")).toHaveFocus();
    });

    it("keeps the draft and the key through a failed send from the preview", async () => {
      const user = userEvent.setup();
      let tries = 0;
      answer = (_, method) => (method !== "POST" ? json(200, detail()) : tries++ === 0 ? json(502, { error: { code: "bad_gateway" } }) : json(200, { id: "msg_2" }));
      await openDiscussion(user);
      write("A draft");
      await user.click(toggle());
      await user.click(screen.getByRole("button", { name: "Post message" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(within(preview()).getByText("A draft")).toBeInTheDocument();
      expect(screen.getByLabelText("Post a message")).toHaveValue("A draft");
      await user.click(screen.getByRole("button", { name: "Post message" }));
      expect(await screen.findByText("Posted.")).toBeInTheDocument();
      const keys = commands().map((command) => command.key);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it("keeps hostile text inert", async () => {
      const user = userEvent.setup();
      answer = () => json(200, detail());
      await openDiscussion(user);
      write(`<img src=x onerror="window.pwned=1"><script>window.pwned=2</script><iframe src="https://evil.test"></iframe>\n\n[x](javascript:window.pwned=3) ![p](https://evil.test/p.png)`);
      await user.click(toggle());
      expect(preview().querySelector("img, script, iframe, a, [src], [onerror]")).toBeNull();
      expect(preview()).toHaveTextContent("<img src=x");
      expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    });
  });

  it("is offered to someone with no other controls, even after the task finished", async () => {
    answer = () => json(200, detail({ status: "completed", reviewer: "agt_b" }));
    await open();
    expect(screen.queryByRole("button", { name: "Edit task" })).toBeNull();
    expect(screen.getByRole("form", { name: "New message", hidden: true })).toBeInTheDocument();
  });

  it("after a lost response says the outcome is unknown, keeps the words, and retries with the same key", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    answer = (_, method) => {
      if (method !== "POST") return json(200, detail());
      attempts += 1;
      return attempts === 1 ? json(502, {}) : json(200, { id: "msg_2" });
    };
    await openDiscussion(user);
    await user.type(screen.getByLabelText("Post a message"), "On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    expect(await screen.findByText(/can't tell whether this posted/)).toBeInTheDocument();
    expect(screen.getByLabelText("Post a message")).toHaveValue("On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText("Posted.");
    expect(commands()[0].key).toBe(commands()[1].key);
  });

  it("keeps the key of a post with an unknown outcome, even if the words change and change back", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    answer = (_, method) => {
      if (method !== "POST") return json(200, detail());
      attempts += 1;
      return attempts === 1 ? json(502, {}) : json(200, { id: "msg_2" });
    };
    await openDiscussion(user);
    const field = screen.getByLabelText("Post a message");
    await user.type(field, "On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText(/can't tell whether this posted/);
    await user.type(field, "!");
    await user.keyboard("{Backspace}");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText("Posted.");
    expect(commands()[0].key).toBe(commands()[1].key);
    await waitFor(() => expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(2));
  });

  it("won't discard or close while a message is posting", async () => {
    const user = userEvent.setup();
    let release!: (response: Response) => void;
    answer = (_, method) => (method === "POST" ? new Promise<Response>((resolve) => (release = resolve)) : json(200, detail()));
    await openDiscussion(user);
    await user.type(screen.getByLabelText("Post a message"), "On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    await act(async () => release(json(200, { id: "msg_2" })));
    await screen.findByText("Posted.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).not.toContain("task="));
  });

  it("after a lost post, a refusal keeps the key and doesn't say it didn't post", async () => {
    const user = userEvent.setup();
    const answers = [() => json(502, {}), () => refused(429, "rate_limited"), () => json(200, { id: "msg_2" })];
    answer = (_, method) => (method === "POST" ? answers.shift()!() : json(200, detail()));
    await openDiscussion(user);
    await user.type(screen.getByLabelText("Post a message"), "On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText(/can't tell whether this posted/);
    await user.click(screen.getByRole("button", { name: "Post message" }));
    expect(await screen.findByText(/still can't tell whether this posted/)).toBeInTheDocument();
    expect(screen.queryByText(/didn't post/)).toBeNull();
    expect(screen.getByLabelText("Post a message")).toHaveValue("On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText("Posted.");
    expect(new Set(commands().map((call) => call.key)).size).toBe(1);
  });

  it("a first refusal of a post is explained, and doesn't hold its key for next time", async () => {
    const user = userEvent.setup();
    const answers = [() => refused(429, "rate_limited"), () => json(200, { id: "msg_2" })];
    answer = (_, method) => (method === "POST" ? answers.shift()!() : json(200, detail()));
    await openDiscussion(user);
    await user.type(screen.getByLabelText("Post a message"), "On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    expect(await screen.findByText(/That didn't post. Too many requests/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText("Posted.");
    expect(commands()[0].key).not.toBe(commands()[1].key);
  });

  it("uses a new key for the same words posted a second time on purpose", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, { id: "msg_2" }) : json(200, detail()));
    await openDiscussion(user);
    for (const _ of [1, 2]) {
      await user.type(screen.getByLabelText("Post a message"), "Again");
      await user.click(screen.getByRole("button", { name: "Post message" }));
      await waitFor(() => expect(screen.getByLabelText("Post a message")).toHaveValue(""));
    }
    expect(commands()[0].key).not.toBe(commands()[1].key);
  });

  it("keeps a draft through a look at another tab, and asks before closing with it", async () => {
    const user = userEvent.setup();
    await openDiscussion(user);
    await user.type(screen.getByLabelText("Post a message"), "Half a thought");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
    expect(screen.getByLabelText("Post a message")).toHaveValue("Half a thought");
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
  });

  it("keeps an edit draft, and the version it read, when posting a message reloads newer data", async () => {
    const user = userEvent.setup();
    let version = 5;
    answer = (_, method) => (method === "POST" ? json(200, { id: "msg_2" }) : json(200, detail({ status: "accepted", requester: "per_me", reviewer: "agt_b", version })));
    await open({ room: OWNED });
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Mine");
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
    await user.type(screen.getByLabelText("Post a message"), "Hello");
    version = 6;
    await user.click(screen.getByRole("button", { name: "Post message" }));
    await screen.findByText("Posted.");
    // The draft is still there, and still answers to what was read, so saving it conflicts rather than overwrites.
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Mine"));
    answer = (_, method) => (method === "POST" ? refused(409, "version_conflict") : json(200, detail({ status: "accepted", requester: "per_me", reviewer: "agt_b", version })));
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    expect(await screen.findByText(/This task changed while you were editing/)).toBeInTheDocument();
    expect(posts().at(-1)).toMatchObject({ url: expect.stringContaining("/update"), body: { version: 5, title: "Mine" } });
  });
});

describe("editing a task", () => {
  const accepted = () => json(200, detail({ status: "accepted", requester: "per_me", reviewer: "agt_b" }));

  it("isn't offered on submitted work, and says what to do instead", async () => {
    answer = () => json(200, detail({ status: "submitted", requester: "per_me", reviewer: "agt_b" }));
    await open();
    expect(screen.queryByRole("button", { name: "Edit task" })).toBeNull();
    expect(screen.getByText(/Request changes first/)).toBeInTheDocument();
  });

  it("warns from the start that instructions send accepted work back, and the button repeats it (decision 4)", async () => {
    const user = userEvent.setup();
    answer = accepted;
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(screen.getByText(/Changing the instructions or criteria sends this task back to Awaiting acceptance, and Architect has to accept it again/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save edit" })).toBeDisabled();

    await user.type(screen.getByLabelText("Instructions"), " better");
    expect(screen.getByText(/This edit sends the task back to Awaiting acceptance/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and ask for acceptance again" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("sends only what changed with the version it read, and reports what the server did", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, task({ status: "offered", version: 6 })) : accepted());
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Instructions"), " better");
    await user.click(screen.getByRole("button", { name: "Save and ask for acceptance again" }));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/update", body: { version: 5, instructions: "Write it better" } });
    expect(Object.keys(commands()[0].body as object).sort()).toEqual(["instructions", "version"]);
    expect(await screen.findByText("Saved. Architect has to accept this task again before working on it.")).toBeInTheDocument();
  });

  it("doesn't warn about a title change, and says plainly that it saved", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, task({ status: "accepted", version: 6 })) : accepted());
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Title"), " now");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    expect(commands()[0].body).toEqual({ version: 5, title: "Design the API now" });
    expect(await screen.findByText("Saved your edit.")).toBeInTheDocument();
  });

  it("after a lost response says so, and retrying the same edit uses the same key", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    answer = (_, method) => {
      if (method !== "POST") return accepted();
      attempts += 1;
      if (attempts === 1) throw new TypeError("network");
      return json(200, task({ status: "accepted", version: 6 }));
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Title"), " now");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    expect(await screen.findByText(/can't tell whether your edit saved/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await screen.findByText("Saved your edit.");
    expect(commands()[0].key).toBe(commands()[1].key);
  });

  it("keeps the person's input through a conflict, and says what changed (DESIGN.md)", async () => {
    const user = userEvent.setup();
    let latest = false;
    answer = (_, method) => {
      if (method === "POST") {
        latest = true;
        return refused(409, "version_conflict");
      }
      return json(200, detail({ status: "accepted", requester: "per_me", reviewer: "agt_b", ...(latest ? { version: 6, title: "Their title" } : {}) }));
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Instructions"), " better");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await user.click(await screen.findByRole("button", { name: "Review latest" }));
    expect(await screen.findByText(/Since you started, this changed: title/)).toBeInTheDocument();
    expect(screen.getByLabelText("Instructions")).toHaveValue("Write it better");
    // What they didn't touch follows the latest, so saving can't undo someone else's change.
    expect(screen.getByLabelText("Title")).toHaveValue("Their title");
  });

  it("explains a refusal, not a generic failure", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? refused(403, "not_allowed") : accepted());
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Title"), " now");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    expect(await screen.findByText(/Only this task's requester, or an owner or admin/)).toBeInTheDocument();
    expect(screen.queryByText(/You may no longer be allowed/)).toBeNull();
  });

  it("asks before discarding an edit, and returns focus to the button, having sent nothing", async () => {
    const user = userEvent.setup();
    answer = accepted;
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Title"), " now");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/Discard your edit to “Design the API”\?/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Design the API now");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit task" })).toHaveFocus());
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(commands()).toHaveLength(0);
  });

  it("doesn't ask when there's nothing to discard", async () => {
    const user = userEvent.setup();
    answer = accepted;
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Discard/)).toBeNull();
    expect(screen.getByRole("button", { name: "Edit task" })).toHaveFocus();
  });

  it("after a lost response reads the task again, and discarding leaves no advice to save", async () => {
    const user = userEvent.setup();
    let committed = false;
    answer = (_, method) => {
      if (method === "POST") {
        committed = true;
        throw new TypeError("network");
      }
      return json(200, detail({ status: committed ? "offered" : "accepted", requester: "per_me", reviewer: "agt_b", version: committed ? 6 : 5, instructions: committed ? "Write it better" : "Write it" }));
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Instructions"), " better");
    await user.click(screen.getByRole("button", { name: "Save and ask for acceptance again" }));
    expect(await screen.findByText(/can't tell whether your edit saved/)).toBeInTheDocument();
    // The latest shows above, with the draft held as it was read, and saving again would answer to the old version.
    await waitFor(() => expect(screen.getByText("Awaiting acceptance")).toBeInTheDocument());
    expect(screen.getByLabelText("Instructions")).toHaveValue("Write it better");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText(/can't tell whether your edit saved/)).toBeNull());
    expect(screen.queryByLabelText("Instructions")).toBeNull();
    expect(screen.getByText("Awaiting acceptance")).toBeInTheDocument();
    // The controls started afresh for the new version, and focus still finds its way back.
    expect(screen.getByRole("button", { name: "Edit task" })).toHaveFocus();
  });

  it("after a lost save, a refusal doesn't say nothing changed, and the draft stays guarded", async () => {
    const user = userEvent.setup();
    const answers = [() => json(502, {}), () => refused(403, "not_allowed")];
    answer = (_, method) => (method === "POST" ? answers.shift()!() : accepted());
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Title"), " now");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await screen.findByText(/can't tell whether your edit saved/);
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    expect(await screen.findByText(/We still can't tell whether your earlier change saved/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/)).toBeNull();
    expect(screen.queryByText(/Only this task's requester/)).toBeNull();
    expect(commands()[0].key).toBe(commands()[1].key);
    expect(screen.getByLabelText("Title")).toHaveValue("Design the API now");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("gives back only the person's own words if the task can no longer be edited", async () => {
    const user = userEvent.setup();
    let latest = false;
    answer = (_, method) => {
      if (method === "POST") {
        latest = true;
        return refused(409, "invalid_transition");
      }
      return json(200, detail({ status: latest ? "submitted" : "accepted", requester: "per_me", reviewer: "agt_b", version: latest ? 6 : 5 }));
    };
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Instructions"), " better");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await user.click(await screen.findByRole("button", { name: "Review latest" }));
    const callout = (await screen.findByText(/can't be edited now/)).parentElement!;
    expect(within(callout).getByText("Write it better")).toBeInTheDocument();
    expect(within(callout).queryByText("Design the API")).toBeNull();
    expect(within(callout).queryByText("It works")).toBeNull();
  });

  it("credits the edit to its author, though an edit of accepted work is recorded as an offer", async () => {
    answer = () =>
      json(
        200,
        detail(
          { status: "offered", requester: "per_me", reviewer: "agt_b" },
          { history: [{ id: "ev_1", type: "task.created", from: { id: "per_r", org: "org_a" }, external: false, reason: null, prior_status: null, new_status: "open", task_version: 1, created_at: 1 }, { id: "ev_2", type: "task.offered", from: { id: "per_me", org: "org_a" }, external: false, reason: null, prior_status: "accepted", new_status: "offered", task_version: 3, created_at: 2 }] },
        ),
      );
    await open();
    const user = userEvent.setup();
    // The brief is credited to the editor, not the task's creator.
    const brief = screen.getByRole("heading", { name: "Instructions" }).closest("section")!;
    expect(within(brief).getByText("You")).toBeInTheDocument();
    expect(within(brief).queryByTitle("per_r")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText(/edited the instructions or criteria, so this needs accepting again/)).toBeInTheDocument();
  });
});

describe("in an archived room", () => {
  const archived: Room = { ...OWNED, status: "archived" };

  it("offers nothing that would be refused, and says why", async () => {
    answer = () => json(200, detail({ status: "submitted", requester: "per_me", reviewer: "per_me", needs_attention: true }));
    await open({ room: archived });
    expect(screen.getByText(/This workroom is archived, so nothing new can happen on this task/)).toBeInTheDocument();
    for (const name of [/Approve/, "Request changes", "Offer task", "Cancel task", "Edit task", "Set reviewer", "Set requester", "Post message"]) expect(screen.queryByRole("button", { name, hidden: true })).toBeNull();
    expect(screen.queryByLabelText("Post a message")).toBeNull();
  });

  it("explains a refusal when the room was archived after the Sheet opened", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? refused(409, "workspace_archived") : json(200, detail({ status: "accepted", requester: "per_me", reviewer: "agt_b" })));
    await open();
    await user.click(screen.getByRole("tab", { name: /Discussion/ }));
    await user.type(screen.getByLabelText("Post a message"), "On it");
    await user.click(screen.getByRole("button", { name: "Post message" }));
    expect(await screen.findByText(/This workroom is archived/)).toBeInTheDocument();
  });
});

describe("what the viewer's access leaves out", () => {
  const narrowed = () => detail({}, { submissions: [], artifacts: [], messages: [], visible: { submissions: "own", conversation: false } });

  it("says a thread is out of reach, offers no way to post, and doesn't claim it's empty", async () => {
    const user = userEvent.setup();
    answer = () => json(200, narrowed());
    await open();
    await user.click(screen.getByRole("tab", { name: "Discussion" }));
    expect(screen.getByText(/doesn't include this task's discussion/)).toBeInTheDocument();
    expect(screen.queryByText(/No messages yet/)).toBeNull();
    expect(screen.queryByLabelText("Post a message")).toBeNull();
  });

  it("says other submissions exist, and doesn't claim nothing was submitted", async () => {
    answer = () => json(200, detail({ submission_no: 2 }, { submissions: [], artifacts: [], messages: [], visible: { submissions: "own", conversation: false } }));
    await open();
    expect(screen.getByText(/has submissions your access doesn't show/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing submitted yet.")).toBeNull();
  });

  it("says nothing was submitted when the numbering shows that's true, even with limited access", async () => {
    answer = () => json(200, detail({ submission_no: 0 }, { submissions: [], artifacts: [], messages: [], visible: { submissions: "own", conversation: false } }));
    await open();
    expect(screen.getByText("Nothing submitted yet.")).toBeInTheDocument();
    expect(screen.queryByText(/your access doesn't show/)).toBeNull();
  });

  it("speaks of the agent, not the viewer, to an admin overseeing it", () => {
    const data = detail({ submission_no: 2 }, { submissions: [], artifacts: [], messages: [], visible: { submissions: "own", conversation: true } });
    render(<Details data={data} me="agt_a" names={{}} orgNames={{}} overseen />);
    expect(screen.getByText(/this agent's access doesn't show/)).toBeInTheDocument();
    expect(screen.queryByText(/your access/i)).toBeNull();
  });

  it("says reasons are left out of the history", async () => {
    const user = userEvent.setup();
    answer = () => json(200, narrowed());
    await open();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText(/doesn't include the reasons people gave/)).toBeInTheDocument();
  });

  it("still says a task with full access has nothing in it", async () => {
    const user = userEvent.setup();
    answer = () => json(200, detail({}, { submissions: [], artifacts: [], messages: [], visible: { submissions: "all", conversation: true } }));
    await open();
    expect(screen.getByText("Nothing submitted yet.")).toBeInTheDocument();
    expect(screen.queryByText(/access doesn't show/)).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Discussion (0)" }));
    expect(screen.getByText(/No messages yet/)).toBeInTheDocument();
    expect(screen.getByLabelText("Post a message")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.queryByText(/doesn't include the reasons/)).toBeNull();
  });
});

describe("Review latest on an edit", () => {
  it("won't take typing while its read is out, so the form can't answer to a version it hasn't shown", async () => {
    const user = userEvent.setup();
    let version = 5;
    let title = "Design the API";
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = false;
    const posts: { version: number; title?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (body.version !== version) return refused(409, "version_conflict");
        version += 1;
        title = body.title ?? title;
        return json(200, task({ status: "accepted", requester: "per_me", reviewer: "agt_b", version, title }));
      }
      if (gated) await gate;
      return json(200, detail({ status: "accepted", requester: "per_me", reviewer: "agt_b", version, title }));
    });
    await open();
    await user.click(screen.getByRole("button", { name: "Edit task" }));
    await user.type(screen.getByLabelText("Title"), "!");
    // Someone else's edit.
    version = 6;
    title = "THEIR TITLE";
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await screen.findByText(/This task changed while you were editing/);
    gated = true;
    await user.click(screen.getByRole("button", { name: "Review latest" }));
    const box = screen.getByLabelText("Title");
    expect(box).toHaveAttribute("readonly");
    await user.type(box, "{Backspace}?");
    expect(box).toHaveValue("Design the API!");
    release();
    // The person now sees what changed, and only then can save against the version they've seen.
    expect(await screen.findByText(/Since you started, this changed: title/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).not.toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ version: 6 });
  });

  it("won't take typing in a change request while a command is out", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      if (init.method === "POST") await gate;
      return json(200, detail({ status: "submitted", reviewer: "per_me", assignee: "agt_a", submission_no: 2 }));
    });
    await open();
    await user.click(await screen.findByRole("button", { name: /Request changes/ }));
    const reason = await screen.findByLabelText(/What needs to change/);
    await user.type(reason, "Fix it");
    await user.click(screen.getByRole("button", { name: /Request changes to submission/ }));
    await waitFor(() => expect(reason).toHaveAttribute("readonly"));
    await user.type(reason, " more");
    expect(reason).toHaveValue("Fix it");
    release();
  });
});

describe("changing the reviewer or requester", () => {
  it("after a lost response shows the latest, with the choice gone if it went through", async () => {
    const user = userEvent.setup();
    let committed = false;
    answer = (_, method) => {
      if (method === "POST") {
        committed = true;
        return json(502, {});
      }
      return json(200, detail({ status: "accepted", requester: "per_me", reviewer: committed ? "per_o" : "per_me", version: committed ? 6 : 5 }));
    };
    await open();
    await user.selectOptions(screen.getByLabelText("Change reviewer"), "per_o");
    await user.click(screen.getByRole("button", { name: "Set reviewer" }));
    expect(await screen.findByText(/can't tell whether the reviewer changed, so we read the task again/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Change reviewer")).toHaveValue(""));
    expect(within(screen.getByLabelText("Change reviewer")).queryByRole("option", { name: "per_o" })).toBeNull();
  });

  const flaggedDetail = (over: Partial<Task> = {}) => json(200, detail({ status: "accepted", requester: "per_gone", reviewer: "per_gone", needs_attention: true, ...over }));

  it("opens on a flagged task, says what it needs, and sets the requester with the version it read", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? json(200, task()) : flaggedDetail());
    await open({ room: OWNED });
    expect(screen.getByText("Someone left this workroom, so this task needs a new reviewer and a new requester. You can choose below.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("New requester"), "agt_b");
    await user.click(screen.getByRole("button", { name: "Set requester" }));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/set-requester", body: { version: 5, requester: "agt_b" } });
    expect(await screen.findByText("agt_b is now the requester.")).toBeInTheDocument();
  });

  it("never offers the assignee as reviewer", async () => {
    answer = () => flaggedDetail();
    await open({ room: OWNED });
    expect(within(screen.getByLabelText("New reviewer")).queryByRole("option", { name: "Architect" })).toBeNull();
    expect(within(screen.getByLabelText("New requester")).getByRole("option", { name: "Architect" })).toBeInTheDocument();
  });

  it("shows a member who can't fix it who can, and no controls", async () => {
    answer = () => flaggedDetail({ reviewer: "agt_b" });
    await open();
    expect(screen.getByText(/needs a new requester. An owner or admin of this workroom can fix it./)).toBeInTheDocument();
    expect(screen.queryByLabelText("New requester")).toBeNull();
  });

  it("keeps the reviewer change from a requester once work is submitted", async () => {
    answer = () => json(200, detail({ status: "submitted", requester: "per_me", reviewer: "agt_b" }));
    await open();
    expect(screen.queryByLabelText("Change reviewer")).toBeNull();
  });

  it("explains each refusal the server can give", async () => {
    const user = userEvent.setup();
    answer = (_, method) => (method === "POST" ? refused(422, "self_sign_off") : json(200, detail({ status: "accepted", requester: "per_me", reviewer: "per_me" })));
    await open();
    await user.selectOptions(screen.getByLabelText("Change reviewer"), "per_o");
    await user.click(screen.getByRole("button", { name: "Set reviewer" }));
    expect(await screen.findByText(/can't be the person doing the work/)).toBeInTheDocument();

    answer = (_, method) => (method === "POST" ? refused(400, "invalid_argument") : json(200, detail({ status: "accepted", requester: "per_me", reviewer: "per_me" })));
    await user.click(screen.getByRole("button", { name: "Set reviewer" }));
    expect(await screen.findByText(/isn't in this workroom any more/)).toBeInTheDocument();
  });

  it("treats a stale change as a conflict, and after a lost response retries with the same key", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    answer = (_, method) => {
      if (method !== "POST") return json(200, detail({ status: "accepted", requester: "per_me", reviewer: "per_me" }));
      attempt += 1;
      return attempt === 1 ? json(503, {}) : refused(409, "version_conflict");
    };
    await open();
    await user.selectOptions(screen.getByLabelText("Change reviewer"), "per_o");
    await user.click(screen.getByRole("button", { name: "Set reviewer" }));
    expect(await screen.findByText(/can't tell whether the reviewer changed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set reviewer" }));
    expect(await screen.findByText(/This task changed while you were editing/)).toBeInTheDocument();
    expect(commands()[0].key).toBe(commands()[1].key);
  });
});

describe("attached files", () => {
  const attached = {
    files: [
      { id: "obj_r", name: "spec.pdf", size: 1200, sha256: "a".repeat(64), media_type: "application/pdf", state: "ready", download_path: "/v1/files/ws_1/obj_r", linked_tasks: ["tsk_1"] },
      { id: "obj_s", name: "notes.txt", size: 10, sha256: "b".repeat(64), media_type: "text/plain", state: "scanning", download_path: null, linked_tasks: ["tsk_1"] },
    ],
    next_cursor: null,
    // Sent only to whoever sees the whole room.
    quota: { used: 1210, limit: 5_000_000_000 },
  };
  beforeEach(() => {
    answer = (url) => (url.includes("/files?") ? json(200, attached) : json(200, detail()));
  });

  it("sit between the criteria and the submissions, with a download for a ready file only, and Remove for whoever may attach", async () => {
    await open();
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(calls.some((call) => call.url === "/api/v1/workspaces/ws_1/files?task_id=tsk_1&cursor=")).toBe(true);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings.indexOf("Attached files")).toBe(headings.indexOf("Acceptance criteria") + 1);
    expect(headings.indexOf("Submissions")).toBe(headings.indexOf("Attached files") + 1);
    expect(within(list).getByRole("button", { name: "Download spec.pdf" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Download notes.txt" })).not.toBeInTheDocument();
    expect(within(list).getByText("Scanning")).toBeInTheDocument();
    expect(within(list).getAllByRole("button", { name: /^Remove from task/ })).toHaveLength(2);
  });

  it("give a guest assignee the files to read, with no Remove", async () => {
    await open({ me: "per_g", room: { ...ROOM, members: [...(ROOM.members ?? []), { principal_id: "per_g", kind: "person", org_id: "org_c", role: "guest" }] } });
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(within(list).getByRole("button", { name: "Download spec.pdf" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /^Remove from task/ })).not.toBeInTheDocument();
  });
});
