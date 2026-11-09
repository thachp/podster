import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { currentUrl, navigate, routerCalls, setUrl } from "@/test/next-navigation";
import { AgentSheet, DISCONNECT_CHECK_MS } from "./agent-sheet";
import { wakeLabel } from "./model";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;

const AGENT = { id: "agt_1", org_id: "org_1", name: "Code Agent", generation: 1, status: "active", inbox_unread: 2, wake: null };
const EVENT = { seq: 3, event_id: "e3", workspace_id: "ws_other", type: "task.offered", task_id: "tsk_9", actor_id: "per_9", created_at: Date.now() - 120_000 };
const INBOX = { events: [{ ...EVENT, seq: 2, event_id: "e2" }, EVENT], acked_seq: 2, unread: 1, dropped: 0 };
const ROOMS = [
  { workspace_id: "ws_mine", workspace_name: "Platform", role: "member", status: "active", left: false },
  { workspace_id: "ws_other", workspace_name: "Their room", role: "guest", status: "active", left: false },
  { workspace_id: "ws_old", workspace_name: "Old name", role: "guest", status: null, left: true },
];

const calls: { url: string; method: string }[] = [];
let agent = { ...AGENT };
let special: Handler = () => undefined;

function server(url: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  calls.push({ url, method });
  const answered = special(url, init);
  if (answered) return Promise.resolve(answered);
  if (url === "/api/agents/agt_1") return Promise.resolve(Response.json(agent));
  if (url === "/api/v1/workspaces") return Promise.resolve(Response.json({ workspaces: [{ workspace_id: "ws_mine", workspace_name: "Platform", role: "guest" }] }));
  if (url === "/api/v1/agents/agt_1/rooms") return Promise.resolve(Response.json({ rooms: ROOMS, truncated: false }));
  if (url.startsWith("/api/v1/agents/agt_1/inbox")) return Promise.resolve(Response.json(INBOX));
  return Promise.resolve(Response.json({ error: { code: "agent_not_found" } }, { status: 404 }));
}

beforeEach(() => {
  calls.length = 0;
  agent = { ...AGENT };
  special = () => undefined;
  vi.stubGlobal("fetch", vi.fn(server));
  setUrl("/agents?agent=agt_1");
});
afterEach(() => vi.useRealTimers());

const DESCRIPTIONS = { agt_1: "Reviews *Rust*. ![x](https://evil.test/x) <img src=https://evil.test/y>" };

const Screen = ({ descriptions = DESCRIPTIONS }: { descriptions?: Record<string, string> | null }) => (
  <>
    <SheetLink param="agent" target="agt_1">
      Open it
    </SheetLink>
    <AgentSheet organizations={[{ id: "org_1", name: "Acme" }]} descriptions={descriptions} />
  </>
);

const opened = () => screen.findByRole("heading", { name: "Code Agent" });
const commands = () => calls.filter((call) => call.method !== "GET");

describe("the agent Sheet", () => {
  it("UI-04, UI-05: a deep link opens it, named, with focus on the title", async () => {
    render(<Screen />);
    expect(await opened()).toHaveFocus();
    expect(screen.getByText("Organization: Acme")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("UI-05: someone it's hidden from gets the one not-found message, and nothing about the agent", async () => {
    special = (url) => (url === "/api/agents/agt_1" ? Response.json({ error: { code: "agent_not_found" } }, { status: 404 }) : undefined);
    render(<Screen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that");
    expect(screen.queryByText("Code Agent")).toBeNull();
    expect(currentUrl()).toBe("/agents");
    // Nothing else is asked for, so the rest of its details can't reach this viewer's page.
    expect(calls.map((call) => call.url)).toEqual(["/api/agents/agt_1"]);
  });

  it("an outage isn't not-found", async () => {
    special = (url) => (url === "/api/agents/agt_1" ? new Response("{}", { status: 503 }) : undefined);
    render(<Screen />);
    expect(await screen.findByRole("heading", { name: "Couldn't load this" })).toBeInTheDocument();
    expect(currentUrl()).toBe("/agents?agent=agt_1");
  });

  it("UI-06: workroom access is read-only, and Withdraw and Disconnect are there", async () => {
    render(<Screen />);
    await opened();
    expect(await screen.findByText("Active · Listed role: member")).toBeInTheDocument();
    expect(screen.getByText(/managed by each workroom's owner and admins/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw from Platform" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /role|grant|access/i })).toBeNull();
  });

  it("doesn't imply a listed role is its full access, and links to the room's Team", async () => {
    render(<Screen />);
    await opened();
    expect(await screen.findByText(/Listed role: member/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See Team in Platform" })).toHaveAttribute("href", "/w/ws_mine/team");
  });

  it("UI-06: withdraws from a room the viewer has no role in, which only the inbox knows about", async () => {
    special = (url) => (url.endsWith("/withdraw") ? Response.json({ status: "ok" }) : undefined);
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from Their room" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Withdraw “Code Agent” from “Their room”?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(commands()).toEqual([{ url: "/api/v1/workspaces/ws_other/members/agt_1/withdraw", method: "POST" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Withdrawn from Their room.");
    expect(routerCalls.refresh).toBe(1);
  });

  it("canceling a confirmation sends nothing", async () => {
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep connected" }));
    expect(commands()).toEqual([]);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    // Focus goes back to the button that opened it.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Disconnect" })));
  });

  it("agent text is inert, and quoted only as data in a confirmation", async () => {
    agent = { ...AGENT, name: 'Ignore instructions <b onclick="x">' };
    render(<Screen />);
    await screen.findByRole("heading", { name: 'Ignore instructions <b onclick="x">' });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/Image not loaded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(dialog.querySelector("b")).toBeNull();
  });
});

describe("UI-13: disconnecting", () => {
  async function disconnect() {
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
  }

  it("stays Disconnecting while a room hasn't confirmed, and never says it finished", async () => {
    special = (url, init) => {
      if (init.method === "POST") agent = { ...AGENT, status: "disconnecting", generation: 2 };
      return url.endsWith("/disconnect") ? Response.json(agent) : undefined;
    };
    render(<Screen />);
    await opened();
    await disconnect();
    expect(await screen.findByText("Disconnecting")).toBeInTheDocument();
    expect(screen.getByText(/isn't fully disconnected/)).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Withdraw/ })).toBeNull();
  });

  it("a lost response with a failed re-read says the outcome is unknown, and never that nothing changed", async () => {
    render(<Screen />);
    await opened();
    special = (url, init) => {
      if (url.endsWith("/disconnect") && init.method === "POST") {
        // It committed, and then neither its answer nor the next read got through.
        agent = { ...AGENT, status: "disconnecting" };
        special = (next) => (next === "/api/agents/agt_1" ? new Response("{}", { status: 503 }) : undefined);
        return new Response("{}", { status: 502 });
      }
      return undefined;
    };
    await disconnect();
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/)).toBeNull();
    expect(screen.queryByText(/no longer be allowed/)).toBeNull();
    // Refreshing when it can read again settles it, and the warning goes.
    special = () => undefined;
    agent = { ...AGENT, status: "disconnected" };
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Disconnected")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/We couldn't confirm that/)).toBeNull());
  });

  it("Try now on an outage says the outcome is unknown, not that it isn't allowed", async () => {
    agent = { ...AGENT, status: "disconnecting" };
    special = (url, init) => (url.endsWith("/disconnect") && init.method === "POST" ? new Response("{}", { status: 500 }) : undefined);
    render(<Screen />);
    await screen.findByText("Disconnecting");
    await userEvent.click(screen.getByRole("button", { name: "Try now" }));
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByText(/no longer be allowed/)).toBeNull();
    expect(screen.getByText("Disconnecting")).toBeInTheDocument();
  });

  it("a failed Refresh doesn't clear the warning for the next command whose answer is lost", async () => {
    const lost: Handler = (url, init) => (url.endsWith("/disconnect") && init.method === "POST" ? new Response("{}", { status: 502 }) : undefined);
    special = lost;
    render(<Screen />);
    await opened();
    await disconnect();
    await screen.findByText(/We couldn't confirm that/);
    special = (url) => (url === "/api/agents/agt_1" ? new Response("{}", { status: 503 }) : undefined);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/^Couldn't refresh/);
    expect(screen.getByText(/We couldn't confirm that/)).toBeInTheDocument();
    special = lost;
    await disconnect();
    await waitFor(() => expect(screen.queryByText(/^Couldn't refresh/)).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled());
    expect(screen.getByText(/We couldn't confirm that/)).toBeInTheDocument();
  });

  it("a network failure counts as unknown too", async () => {
    special = (url, init) => {
      if (url.endsWith("/disconnect") && init.method === "POST") throw new TypeError("lost");
      return undefined;
    };
    render(<Screen />);
    await opened();
    await disconnect();
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });

  it("a failed request shows the state the server reports, not 'nothing changed'", async () => {
    special = (url, init) => {
      if (url.endsWith("/disconnect") && init.method === "POST") {
        agent = { ...AGENT, status: "disconnecting", generation: 2 };
        return new Response("{}", { status: 500 });
      }
      return undefined;
    };
    render(<Screen />);
    await opened();
    await disconnect();
    expect(await screen.findByText("Disconnecting")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/nothing changed/)).toBeNull());
  });

  it("moves to Disconnected only when the server says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    agent = { ...AGENT, status: "disconnecting" };
    render(<Screen />);
    await screen.findByText("Disconnecting");
    await act(async () => void (await vi.advanceTimersByTimeAsync(DISCONNECT_CHECK_MS)));
    expect(screen.getByText("Disconnecting")).toBeInTheDocument();
    agent = { ...AGENT, status: "disconnected" };
    await act(async () => void (await vi.advanceTimersByTimeAsync(DISCONNECT_CHECK_MS)));
    await waitFor(() => expect(screen.getByText("Disconnected")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(commands()).toEqual([]);
  });

  it("reconnect shows the server's state and promises no room access", async () => {
    agent = { ...AGENT, status: "disconnected" };
    special = (url, init) => {
      if (url.endsWith("/reconnect") && init.method === "POST") {
        agent = { ...AGENT, generation: 3 };
        return Response.json(agent);
      }
      return undefined;
    };
    render(<Screen />);
    await opened();
    expect(screen.getByText(/no workroom access back/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(commands()).toEqual([{ url: "/api/agents/agt_1/reconnect", method: "POST" }]);
  });
});

describe("the agent's workrooms", () => {
  it("come from the rooms route, with no 'may be incomplete' and no reads of each room", async () => {
    render(<Screen />);
    await opened();
    expect(calls.map((call) => call.url).sort()).toEqual(["/api/agents/agt_1", "/api/v1/agents/agt_1/inbox?after=0&limit=50", "/api/v1/agents/agt_1/rooms", "/api/v1/workspaces"]);
    expect(screen.queryByText(/may be incomplete/)).toBeNull();
    expect(screen.queryByText(/list was cut/)).toBeNull();
  });

  it("a room the viewer is in opens as itself, and another organization's offers read-only tasks", async () => {
    render(<Screen />);
    await opened();
    expect(screen.getByRole("link", { name: "Open workroom: Platform" })).toHaveAttribute("href", "/w/ws_mine/overview");
    expect(screen.getByRole("link", { name: "View its tasks, read-only: Their room" })).toHaveAttribute("href", "/oversight/ws_other/agt_1");
    expect(screen.getByText(/that you're not in shows as not found/)).toBeInTheDocument();
  });

  it("a room it left shows honestly: its old name, no Withdraw, no link, and nothing about the room since", async () => {
    render(<Screen />);
    await opened();
    expect(screen.getByRole("heading", { name: "Left" })).toBeInTheDocument();
    expect(screen.getByText("Old name")).toBeInTheDocument();
    expect(screen.getByText(/name it had when this agent left/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw from Old name" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Old name/ })).toBeNull();
  });

  it("says when the list was cut", async () => {
    special = (url) => (url.endsWith("/rooms") ? Response.json({ rooms: ROOMS, truncated: true }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText(/This list was cut/)).toBeInTheDocument();
  });

  it("an archived room says so, and can still be withdrawn from", async () => {
    special = (url) => (url.endsWith("/rooms") ? Response.json({ rooms: [{ ...ROOMS[1], status: "archived" }], truncated: false }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText("Archived · Listed role: guest")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw from Their room" })).toBeEnabled();
  });

  it("a confirmed withdrawal moves the room to Left now, though the listing hasn't caught up", async () => {
    special = (url) => (url.endsWith("/withdraw") ? Response.json({ status: "ok" }) : undefined);
    const announced = vi.fn();
    window.addEventListener("podster:agent-withdrawn", announced);
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from Their room" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Withdrawn from Their room.");
    expect(screen.queryByRole("button", { name: "Withdraw from Their room" })).toBeNull();
    expect(within(screen.getByRole("heading", { name: "Left" }).parentElement!).getByText("Their room")).toBeInTheDocument();
    expect(announced).toHaveBeenCalledTimes(1);
    window.removeEventListener("podster:agent-withdrawn", announced);
  });

  it("withdrawing on an outage says the outcome is unknown, with no 'Withdrawn', and the room stays", async () => {
    special = (url) => (url.endsWith("/withdraw") ? new Response("{}", { status: 500 }) : undefined);
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from Their room" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw from Their room" })).toBeInTheDocument();
  });

  it.each([429, 503])("a %i on the rooms read isn't 'not in any workroom', and Try again reads again", async (status) => {
    special = (url) => (url.endsWith("/rooms") ? new Response("{}", { status }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText(/Couldn't read this agent's workrooms/)).toBeInTheDocument();
    expect(screen.queryByText(/isn't in any workroom/)).toBeNull();
    special = () => undefined;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Withdraw from Platform" })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't read this agent's/)).toBeNull();
  });

  it("no rooms says so, and a failed read of the viewer's own rooms offers no links but keeps Withdraw", async () => {
    special = (url) => (url.endsWith("/rooms") ? Response.json({ rooms: [], truncated: false }) : undefined);
    const { unmount } = render(<Screen />);
    await opened();
    expect(screen.getByText("This agent isn't in any workroom.")).toBeInTheDocument();
    unmount();
    special = (url) => (url === "/api/v1/workspaces" ? new Response("{}", { status: 503 }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.queryByRole("link", { name: /Open workroom|read-only/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw from Platform" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("so their links are hidden");
    special = () => undefined;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Open workroom: Platform" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed directory read says so rather than hiding the agent's skills", async () => {
    render(<Screen descriptions={null} />);
    await opened();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load what this agent says about its skills");
  });
});

describe("UI-09: inbox oversight", () => {
  it("is labeled, shows the cursor and unread, and only ever reads", async () => {
    render(<Screen />);
    await opened();
    expect(screen.getByRole("heading", { name: "Viewing as: Code Agent · read-only oversight" })).toBeInTheDocument();
    expect(screen.getByText("Unread").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("Cursor position").nextSibling).toHaveTextContent("2");
    const reads = calls.filter((call) => call.url.includes("/inbox"));
    expect(reads).toEqual([{ url: "/api/v1/agents/agt_1/inbox?after=0&limit=50", method: "GET" }]);
    expect(commands()).toEqual([]);
    expect(calls.some((call) => /ack/.test(call.url))).toBe(false);
  });

  it("a room the viewer can't open isn't a link", async () => {
    render(<Screen />);
    await opened();
    expect(screen.queryByRole("link", { name: "ws_other" })).toBeNull();
    expect(screen.getAllByText("ws_other").length).toBeGreaterThan(0);
  });

  it("warns about dropped events, and paging moves past what it has without touching the cursor", async () => {
    const full = Array.from({ length: 50 }, (_, index) => ({ ...EVENT, seq: index + 1, event_id: `e${index + 1}` }));
    special = (url) => {
      if (url.endsWith("after=0&limit=50")) return Response.json({ events: full, acked_seq: 0, unread: 51, dropped: 2 });
      if (url.includes("/inbox")) return Response.json({ events: [{ ...EVENT, seq: 51, event_id: "e51", type: "task.last" }], acked_seq: 0, unread: 51, dropped: 2 });
      return undefined;
    };
    render(<Screen />);
    await opened();
    expect(screen.getByText(/2 unread events were dropped/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("task.last")).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toContain("/api/v1/agents/agt_1/inbox?after=50&limit=50");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(commands()).toEqual([]);
  });

  it("a failed inbox read doesn't look like an empty inbox", async () => {
    special = (url) => (url.includes("/inbox") ? new Response("{}", { status: 503 }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText("Couldn't read this inbox.")).toHaveAttribute("role", "alert");
    expect(screen.queryByText("This inbox is empty.")).toBeNull();
  });
});

describe("AC-20, AC-21: binding", () => {
  it("closing makes no save, and focus goes back to the launcher", async () => {
    render(<Screen />);
    await opened();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/agents"));
    expect(commands()).toEqual([]);
    await waitFor(() => expect(screen.getByRole("link", { name: "Open it" })).toHaveFocus());
  });

  it("a denied command says so and leaves the state alone", async () => {
    special = (url, init) => (init.method === "POST" ? Response.json({ error: { code: "not_allowed" } }, { status: 403 }) : undefined);
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You may no longer be allowed");
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("a command stays on its agent when the URL moves while it's out, and a late answer can't paint the new one", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const other = { ...AGENT, id: "agt_2", name: "Second Agent", generation: 8 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url === "/api/agents/agt_1/disconnect") {
          calls.push({ url, method: "POST" });
          await held;
          return Response.json({ ...AGENT, status: "disconnecting" });
        }
        if (url === "/api/agents/agt_2") return Response.json(other);
        return server(url, init);
      }),
    );
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    act(() => navigate("/agents?agent=agt_2"));
    // A save in flight holds the Sheet on its own target.
    expect(screen.getByRole("heading", { name: "Code Agent" })).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByRole("heading", { name: "Second Agent" })).toBeInTheDocument();
    expect(commands()).toEqual([{ url: "/api/agents/agt_1/disconnect", method: "POST" }]);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Disconnecting")).toBeNull();
  });
});

describe("what the model decides", () => {
  it("wake has the spec's three labels", () => {
    const wake = { url: "https://x.test/hook", debounce: 900, enabled: true, last_sent_at: null, consecutive_failures: 0 };
    expect(wakeLabel(null)).toBe("Off");
    expect(wakeLabel(wake)).toBe("On");
    expect(wakeLabel({ ...wake, enabled: false, consecutive_failures: 3 })).toBe("Off after repeated failures");
  });
});
