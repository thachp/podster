import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import type { Task } from "../w/[id]/tasks/task-model";
import { AttentionScreen } from "./attention-screen";
import type { InboxEvent } from "./attention-model";
import type { Attention } from "./load-attention";

const task: Task = { id: "tsk_1", title: "Design the API", instructions: "I", acceptance_criteria: null, requester: "per_r", assignee: "agt_a", reviewer: "per_me", status: "submitted", version: 5, due_at: null, follow_up_of: null, submission_no: 2, needs_attention: false };
const event = (seq: number): InboxEvent => ({ seq, event_id: `e${seq}`, workspace_id: "ws_1", type: "task.submitted", task_id: "tsk_1", actor_id: "agt_a", created_at: 1 });

const attention = (over: Partial<Attention> = {}): Attention => ({
  inbox: { events: [], acked_seq: 0, unread: 0, dropped: 0 },
  reviews: [],
  failedRooms: 0,
  fullRooms: 0,
  uncheckedRooms: 0,
  roomNames: { ws_1: "Billing" },
  taskTitles: { tsk_1: "Design the API" },
  approvals: { state: "unavailable" },
  ...over,
});

let posts: { url: string; body: unknown }[];
let reply: () => Response;

beforeEach(() => {
  setUrl("/attention");
  posts = [];
  reply = () => new Response(JSON.stringify({ acked_seq: 3, unread: 0 }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body as string) });
    return reply();
  });
});

const show = (over: Partial<Attention> = {}) => render(<AttentionScreen attention={attention(over)} me="per_me" names={{ agt_a: "Architect" }} />);

describe("Needs attention", () => {
  it("lists a review with its submission and room, opening the Sheet right here", () => {
    show({ reviews: [{ workspace: "ws_1", workspaceName: "Billing", task }] });
    expect(screen.getByText("Design the API")).toBeInTheDocument();
    expect(screen.getByText(/Submission 2 · Billing/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review submission 2 of “Design the API”" })).toHaveAttribute("href", "/attention?task=ws_1.tsk_1");
  });

  it("an empty queue says what belongs here", () => {
    show();
    expect(screen.getByText(/No submissions are waiting for your review/)).toBeInTheDocument();
    expect(screen.getByText(/You're up to date/)).toBeInTheDocument();
  });

  it("doesn't claim there's nothing when a room couldn't be read", () => {
    show({ failedRooms: 2 });
    expect(screen.queryByText(/No submissions are waiting/)).toBeNull();
    expect(screen.getByText(/Couldn't check 2 workrooms/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Try again/);
  });

  it("doesn't claim there's nothing when a room has more than it read", () => {
    show({ fullRooms: 1 });
    expect(screen.queryByText(/No submissions are waiting/)).toBeNull();
    expect(screen.getByText(/1 workroom has more submissions/)).toBeInTheDocument();
  });

  it("a failed read is never an empty list", () => {
    show({ reviews: null, inbox: null });
    expect(screen.queryByText(/No submissions are waiting/)).toBeNull();
    expect(screen.queryByText(/You're up to date/)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("is upfront about the items it can't show yet", () => {
    show();
    expect(screen.getByText(/Role invitations and wake or connection problems/)).toBeInTheDocument();
  });

  it("shows unread updates, newest first, from IDs and system wording alone", () => {
    show({ inbox: { events: [event(1), { ...event(2), type: "task.accepted" }], acked_seq: 0, unread: 2, dropped: 0 } });
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows[0]).toContain("Architect accepted a task");
    expect(rows[1]).toContain("Architect submitted work for review");
    expect(screen.getByRole("heading", { name: "Updates (2 unread)" })).toBeInTheDocument();
  });

  it("says when there's more unread than a page, and when some expired", () => {
    show({ inbox: { events: [event(1)], acked_seq: 0, unread: 60, dropped: 4 } });
    expect(screen.getByText(/Showing the oldest 1 unread/)).toBeInTheDocument();
    expect(screen.getByText(/4 older updates expired/)).toBeInTheDocument();
  });
});

describe("acknowledging", () => {
  const inbox = { events: [event(1), event(3)], acked_seq: 0, unread: 2, dropped: 0 };

  it("moves the cursor to the newest shown, reports the server's unread count, and re-reads the page", async () => {
    const user = userEvent.setup();
    show({ inbox });
    await user.click(screen.getByRole("button", { name: "Acknowledge these 2 updates" }));
    expect(posts).toEqual([{ url: "/api/v1/inbox/ack", body: { up_to: 3 } }]);
    expect(await screen.findByText("Acknowledged. 0 unread.")).toBeInTheDocument();
    expect(routerCalls.refresh).toBe(1);
  });

  it("a refusal says nothing changed, and doesn't refresh", async () => {
    const user = userEvent.setup();
    reply = () => new Response(JSON.stringify({ error: { code: "ack_beyond_inbox" } }), { status: 400 });
    show({ inbox });
    await user.click(screen.getByRole("button", { name: "Acknowledge these 2 updates" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/That didn't save/));
    expect(routerCalls.refresh).toBe(0);
  });

  it.each([
    ["a server error", () => new Response(JSON.stringify({ error: { code: "internal_error" } }), { status: 500 })],
    [
      "a lost response",
      () => {
        throw new TypeError("lost");
      },
    ],
  ])("%s says the outcome is unknown, not that nothing changed", async (_, answer) => {
    const user = userEvent.setup();
    reply = answer;
    show({ inbox });
    await user.click(screen.getByRole("button", { name: "Acknowledge these 2 updates" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/We can't tell whether this was acknowledged/));
    expect(screen.getByRole("alert")).not.toHaveTextContent(/nothing changed/);
    expect(routerCalls.refresh).toBe(0);
  });

  it("says reviews aren't what it clears", () => {
    show({ inbox });
    expect(screen.getByText(/Reviews stay listed until you decide them/)).toBeInTheDocument();
  });

  it("isn't offered with nothing to acknowledge, and reviews don't depend on it", () => {
    show({ reviews: [{ workspace: "ws_1", workspaceName: "Billing", task }] });
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).toBeNull();
    expect(screen.getByText("Design the API")).toBeInTheDocument();
  });
});
