import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentForm, type ConsentChoices } from "./consent-form";

const orgs = [{ id: "org_a", name: "Acme" }];
const choices = (over: Partial<ConsentChoices> = {}): ConsentChoices => ({ client_name: "Some client", redirect_hosts: ["client.test"], oauth_query: "?client_id=c", orgs, agents: [], ...over });
const answer = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
const sent = (fetcher: ReturnType<typeof answer>) => JSON.parse(String(fetcher.mock.calls[0][1]?.body));

afterEach(() => vi.unstubAllGlobals());

describe("ConsentForm", () => {
  it("says who is asking, where access goes and what it grants, with names as text", () => {
    const { container } = render(<ConsentForm choices={choices({ client_name: `<img src=x onerror=alert(1)>‮gnp.exe` })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>gnp.exe");
    expect(container.textContent).not.toContain("‮");
    expect(container).toHaveTextContent("Podster hasn't verified this name");
    expect(screen.getByText("client.test")).toBeInTheDocument();
    expect(container).toHaveTextContent("workroom access is set separately");
  });

  it("says when the app asks to act over A2A, and keeps the MCP wording otherwise", () => {
    const { container, unmount } = render(<ConsentForm choices={choices({ protocol: "a2a" })} />);
    expect(container).toHaveTextContent("It will act as the agent over A2A");
    unmount();
    const mcp = render(<ConsentForm choices={choices()} />);
    expect(mcp.container).toHaveTextContent("It can use the agent's tools");
  });

  it("marks a name that sounds official", () => {
    render(<ConsentForm choices={choices({ client_name: "Podster Admin" })} />);
    expect(screen.getByText("Name chosen by this app")).toBeInTheDocument();
  });

  it("has no shortcut to approving: no focus, and Enter sends nothing", async () => {
    const fetcher = answer(200, { redirect_to: "https://client.test/cb?code=c" });
    vi.stubGlobal("fetch", fetcher);
    render(<ConsentForm choices={choices()} leave={() => {}} />);
    expect(screen.getByRole("button", { name: "Connect" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Connect" })).toHaveAttribute("type", "button");
    await userEvent.type(screen.getByLabelText("Name for a new agent"), "Mine{Enter}");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("makes someone in several organizations choose one", async () => {
    const fetcher = answer(200, { redirect_to: "https://client.test/cb?code=c" });
    vi.stubGlobal("fetch", fetcher);
    render(<ConsentForm choices={choices({ orgs: [...orgs, { id: "org_b", name: "Beta" }], agents: [{ id: "agt_a", org_id: "org_a", name: "In Acme" }, { id: "agt_b", org_id: "org_b", name: "In Beta" }] })} leave={() => {}} />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Organization"), "org_b");
    expect(screen.queryByRole("option", { name: "In Acme" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Connect as"), "agt_b");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(sent(fetcher)).toMatchObject({ decision: "approve", oauth_query: "?client_id=c", org_id: "org_b", link_agent_id: "agt_b" });
  });

  it("goes where the gateway says, and stays locked on the way out", async () => {
    vi.stubGlobal("fetch", answer(200, { redirect_to: "https://client.test/cb?code=c" }));
    const leave = vi.fn();
    render(<ConsentForm choices={choices()} leave={leave} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith("https://client.test/cb?code=c"));
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
  });

  it("declines through the gateway, which tells the client", async () => {
    const fetcher = answer(200, { redirect_to: "https://client.test/cb?error=access_denied" });
    vi.stubGlobal("fetch", fetcher);
    const leave = vi.fn();
    render(<ConsentForm choices={choices()} leave={leave} />);
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith("https://client.test/cb?error=access_denied"));
    expect(sent(fetcher)).toEqual({ decision: "decline", oauth_query: "?client_id=c" });
  });

  it("shows a refusal in fixed words and lets the person try again", async () => {
    vi.stubGlobal("fetch", answer(409, { error: { code: "already_linked" } }));
    const leave = vi.fn();
    render(<ConsentForm choices={choices()} leave={leave} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already connected to a different agent");
    expect(leave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("treats a lost connection as a failure, not a decision", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const leave = vi.fn();
    render(<ConsentForm choices={choices()} leave={leave} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("may not have finished");
    expect(leave).not.toHaveBeenCalled();
  });
});
