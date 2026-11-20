import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptInvitationForm } from "./accept-form";

const orgs = [{ id: "org_a", name: "Org A" }, { id: "org_b", name: "Org B" }];
const agents = [{ id: "agt_a", name: "Agent A", org_id: "org_a" }, { id: "agt_b", name: "<b>Agent B</b>", org_id: "org_b" }];

const onInvalid = vi.fn();
let reply: { status: number; body: unknown };
const sent: unknown[] = [];

beforeEach(() => {
  onInvalid.mockReset();
  sent.length = 0;
  reply = { status: 200, body: { status: "accepted", agents: ["agt_b"] } };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("accepting an invitation", () => {
  it("chooses nothing for the person, and offers only the chosen organization's agents", async () => {
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_b");
    expect(screen.queryByLabelText("Agent A")).not.toBeInTheDocument();
    expect(screen.getByLabelText("<b>Agent B</b>")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeDisabled();
  });

  it("sends the token, organization and agents, then says what happened and what it didn't do", async () => {
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_b");
    await userEvent.click(screen.getByLabelText("<b>Agent B</b>"));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("Your agents joined the workroom.")).toBeInTheDocument();
    expect(sent).toEqual([{ token: "inv_t", org_id: "org_b", agents: ["agt_b"] }]);
    expect(screen.getByText(/doesn't add you to the workroom/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("clears chosen agents when the organization changes", async () => {
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_a");
    await userEvent.click(screen.getByLabelText("Agent A"));
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_b");
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeDisabled();
  });

  it.each([
    ["not_allowed", 403, /can't accept this invitation/],
    ["already_member", 409, /already in this workroom/],
  ])("explains %s", async (code, status, text) => {
    reply = { status, body: { error: { code } } };
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_a");
    await userEvent.click(screen.getByLabelText("Agent A"));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("hands a refused link to the one generic message", async () => {
    reply = { status: 404, body: { error: { code: "invitation_not_found" } } };
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_a");
    await userEvent.click(screen.getByLabelText("Agent A"));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(onInvalid).toHaveBeenCalledOnce());
  });

  it("holds the choice after an unknown outcome, and sends the same choice again", async () => {
    reply = { status: 502, body: { error: { code: "bad_gateway" } } };
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_a");
    await userEvent.click(screen.getByLabelText("Agent A"));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Agent A")).toBeDisabled();
    reply = { status: 200, body: { status: "accepted", agents: ["agt_a"] } };
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your agents joined the workroom.")).toBeInTheDocument();
    expect(sent[1]).toEqual(sent[0]);
  });

  it("keeps holding the choice when a retry is rate limited, which says nothing about the first attempt", async () => {
    reply = { status: 502, body: { error: { code: "bad_gateway" } } };
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_a");
    await userEvent.click(screen.getByLabelText("Agent A"));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await screen.findByRole("alert");
    reply = { status: 429, body: { error: { code: "rate_limited" } } };
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
    expect(screen.getByLabelText("Agent A")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("doesn't say nothing changed after a server error", async () => {
    reply = { status: 502, body: { error: { code: "bad_gateway" } } };
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={orgs} agents={agents} />);
    await userEvent.selectOptions(screen.getByLabelText(/organization/), "org_a");
    await userEvent.click(screen.getByLabelText("Agent A"));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We can't tell whether this worked.");
    expect(alert).not.toHaveTextContent("nothing changed");
  });

  it("doesn't claim an organization has no agents when the list was cut short", () => {
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={[orgs[0]]} agents={[]} partial />);
    expect(screen.getByText(/some may be missing/)).toBeInTheDocument();
    expect(screen.queryByText(/no agents to bring in/)).not.toBeInTheDocument();
  });

  it("tells someone who administers no organization what to do, with no form", () => {
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={[]} agents={[]} />);
    expect(screen.getByText(/need to be an admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a way forward when the organization has no agents", () => {
    render(<AcceptInvitationForm onInvalid={onInvalid} token="inv_t" organizations={[orgs[0]]} agents={[]} />);
    const link = screen.getByRole("link", { name: /Add an agent/ });
    expect(link).toHaveAttribute("href", "/agents/connect");
    // A new tab, so the invitation stays open to come back to.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/reload this page/)).toBeInTheDocument();
  });
});
