import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimForm, type ClaimChoices } from "./claim-form";

const orgs = [{ id: "org_a", name: "Acme" }];
const choices = (over: Partial<ClaimChoices> = {}): ClaimChoices => ({ agent_id: "plugin_1", agent_name: "Helper", code: "ABCD-EFGH", orgs, agents: [], ...over });
const answer = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("ClaimForm", () => {
  it("says who is asking and shows the code to compare, with names as text", () => {
    const { container } = render(<ClaimForm choices={choices({ agent_name: "<b>Podster Support</b>" })} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container).toHaveTextContent("<b>Podster Support</b>");
    expect(screen.getByText("Name chosen by this agent")).toBeInTheDocument();
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(container).toHaveTextContent("Podster hasn't verified this name");
  });

  it("has no shortcut to confirming", async () => {
    const fetcher = answer(200, { agent_id: "agt_1" });
    vi.stubGlobal("fetch", fetcher);
    render(<ClaimForm choices={choices()} />);
    expect(screen.getByRole("button", { name: "Confirm ownership" })).not.toHaveFocus();
    await userEvent.type(screen.getByLabelText("Name for a new agent"), "Mine{Enter}");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the choice and shows the server's result", async () => {
    const fetcher = answer(200, { agent_id: "agt_1" });
    vi.stubGlobal("fetch", fetcher);
    render(<ClaimForm choices={choices()} />);
    await userEvent.type(screen.getByLabelText("Name for a new agent"), "Mine");
    await userEvent.click(screen.getByRole("button", { name: "Confirm ownership" }));
    expect(await screen.findByRole("status")).toHaveTextContent("agt_1");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ agent_id: "plugin_1", user_code: "ABCD-EFGH", org_id: "org_a", name: "Mine", link_agent_id: "" });
  });

  it("shows a refusal in fixed words and keeps the form", async () => {
    vi.stubGlobal("fetch", answer(403, { error: { code: "not_allowed" } }));
    render(<ClaimForm choices={choices()} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm ownership" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wasn't allowed");
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm ownership" })).toBeEnabled());
  });

  it("for Not now, sends only a decline, which clears the link's cookie, and connects nothing", async () => {
    const fetcher = answer(200, { declined: true });
    vi.stubGlobal("fetch", fetcher);
    render(<ClaimForm choices={choices()} />);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing was connected");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/claim");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ decision: "decline" });
  });

  it("says nothing was connected for Not now even if the decline couldn't be sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    render(<ClaimForm choices={choices()} />);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing was connected");
  });
});
