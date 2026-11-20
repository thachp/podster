import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, routerCalls, setUrl } from "@/test/next-navigation";
import { ConnectSheet, WATCH_EVERY_MS } from "./connect-sheet";

const directory = (...ids: string[]) => Response.json({ agents: ids.map((id) => ({ id, org_id: "org_1", name: `Agent ${id}`, description: null, created_at: 1, revoked_at: null })), truncated: false });

let answer: () => Response;
const fetchMock = vi.fn(async (_url: string) => answer());

beforeEach(() => {
  answer = () => directory("agt_old");
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  setUrl("/agents/connect");
});
afterEach(() => vi.useRealTimers());

const sheet = (canConnect = true) => (
  <>
    <a href="/agents/connect" data-connect-launcher>
      launcher
    </a>
    <ConnectSheet gatewayUrl="https://gateway.example.test" canConnect={canConnect} />
  </>
);

describe("adding an agent", () => {
  it("UI-04: has the Sheet's title focus, two named tabs, and the footer's exact words", async () => {
    render(sheet());
    expect(await screen.findByRole("heading", { name: "Add an agent" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "MCP client" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Connect your own agent.*Agent Auth/ })).toBeInTheDocument();
    expect(screen.getByText("Adding an agent gives it no workroom access. That's set separately.")).toBeInTheDocument();
    expect(screen.getByText("Connecting doesn't create, run or wake an agent.")).toBeInTheDocument();
  });

  it("offers Runner pairing first, then connecting an agent you already run", async () => {
    render(sheet());
    const paths = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(paths).toEqual(["Run it on my machine (Podster Runner)", "Connect an agent you already run"]);
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pair with Runner" })).toHaveAttribute("href", "/pairing/new");
    expect(screen.getByText(/npx --ignore-scripts podster@test pair/)).toBeInTheDocument();
    const pair = screen.getByRole("link", { name: "Pair with Runner" });
    const firstTab = screen.getByRole("tab", { name: "MCP client" });
    expect(pair.compareDocumentPosition(firstTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the configured gateway address, not one of its own", async () => {
    render(sheet());
    expect(screen.getByText("https://gateway.example.test/mcp")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Agent Auth/ }));
    expect(screen.getByText("https://gateway.example.test/.well-known/agent-configuration")).toBeInTheDocument();
    expect(screen.getByText(/claim link/)).toBeInTheDocument();
  });

  it("UI-10: tabs work from the keyboard, and Escape returns focus to the launcher", async () => {
    render(sheet());
    await screen.findByRole("heading", { name: "Add an agent" });
    screen.getByRole("tab", { name: "MCP client" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Agent Auth/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/agents"));
    await waitFor(() => expect(screen.getByText("launcher")).toHaveFocus());
  });

  it("copies the address and says so", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(sheet());
    await user.click(screen.getByRole("button", { name: "Copy MCP server address" }));
    expect(writeText).toHaveBeenCalledWith("https://gateway.example.test/mcp");
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("shows Connected only for an agent that arrived after it opened", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(sheet());
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS)));
    expect(screen.queryByText("Connected")).toBeNull();
    answer = () => directory("agt_new", "agt_old");
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS)));
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Agent agt_new")).toBeInTheDocument();
    expect(routerCalls.refresh).toBe(1);
    const count = fetchMock.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS * 3)));
    expect(fetchMock.mock.calls.length).toBe(count);
  });

  it("a name that sounds like Podster stays attributed, not part of the success line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(sheet());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    answer = () => Response.json({ agents: [{ id: "agt_x", org_id: "org_1", name: "Podster Support", description: null, created_at: 1, revoked_at: null }], truncated: false });
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS)));
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Name chosen by this agent")).toBeInTheDocument();
    expect(screen.queryByText(/Connected: /)).toBeNull();
  });

  it("a person who can't add an agent isn't shown steps that would fail, and nothing is polled", () => {
    render(sheet(false));
    expect(screen.getByText(/Only an organization's admins/)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("link", { name: "Pair with Runner" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
