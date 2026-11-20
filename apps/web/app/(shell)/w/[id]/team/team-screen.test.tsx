import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { TeamScreen, type TeamProps } from "./team-screen";

const props: TeamProps = {
  roomId: "ws_1",
  roomName: "Launch room",
  owner: "per_owner",
  policyVersion: 4,
  members: [
    { principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" },
    { principal_id: "agt_x", kind: "agent", org_id: "org_b", role: "guest" },
    { principal_id: "per_m", kind: "person", org_id: "org_a", role: "member" },
    { principal_id: "per_adm", kind: "person", org_id: "org_a", role: "admin" },
  ],
  viewer: { id: "per_owner", orgs: ["org_a"], adminOrgs: ["org_a"] },
  names: { agt_1: "Code Agent", agt_2: "Spare Agent" },
  orgNames: { org_a: "Org A" },
  orgs: [{ id: "org_a", name: "Org A" }],
  agents: [
    { id: "agt_1", name: "Code Agent", org_id: "org_a" },
    { id: "agt_2", name: "Spare Agent", org_id: "org_a" },
  ],
  invitations: { pending: [{ id: "ivt_1", role: "guest", invitedOrg: null, createdBy: "per_owner", createdAt: 0, expiresAt: 1, workRole: null }], complete: true },
};

const sent: { method: string; url: string; body: unknown }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/team");
  sent.length = 0;
  reply = { status: 200, body: {} };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

afterEach(() => vi.unstubAllGlobals());

const row = (text: string) => screen.getByText(text).closest("li") as HTMLElement;

describe("Team, as the owner", () => {
  it("marks another organization's participants External, and only them", () => {
    render(<TeamScreen {...props} />);
    expect(within(row("agt_x")).getByText("External")).toBeInTheDocument();
    expect(within(row("Code Agent")).queryByText("External")).not.toBeInTheDocument();
  });

  it("offers Manage access for agents, and appointing for people only", () => {
    render(<TeamScreen {...props} />);
    expect(within(row("Code Agent")).getByRole("link", { name: "Manage access" })).toHaveAttribute("href", "/w/ws_1/team?agent=agt_1");
    expect(within(row("Code Agent")).queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
    expect(within(row("per_m")).getByRole("button", { name: "Make admin" })).toBeInTheDocument();
    expect(within(row("per_adm")).getByRole("button", { name: "Remove admin" })).toBeInTheDocument();
  });

  it("appoints an admin only after confirming, and shows the server's answer", async () => {
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("per_m")).getByRole("button", { name: "Make admin" }));
    expect(sent).toEqual([]);
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make admin" }));
    expect(await screen.findByText("They're now an admin of this workroom.")).toBeInTheDocument();
    expect(sent).toEqual([{ method: "POST", url: "/api/v1/workspaces/ws_1/members/per_m/role", body: { policy_version: 4, role: "admin" } }]);
    expect(routerCalls.refresh).toBe(1);
  });

  it("shows a refusal, and doesn't refresh as though something changed", async () => {
    reply = { status: 403, body: { error: { code: "not_allowed" } } };
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("per_m")).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing changed");
    expect(routerCalls.refresh).toBe(0);
  });

  it("doesn't say nothing changed after a server error, which may have come after the commit", async () => {
    reply = { status: 502, body: { error: { code: "bad_gateway" } } };
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("per_m")).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't tell whether this saved.");
  });

  it("shows a failed read of organizations as a failure, not an empty form", () => {
    render(<TeamScreen {...props} orgs={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByRole("button", { name: "Add person" })).not.toBeInTheDocument();
  });

  it("doesn't claim there are no agents left when the list was cut short", () => {
    render(<TeamScreen {...props} agents={[]} agentsPartial />);
    expect(screen.getByText(/may be missing/)).toBeInTheDocument();
    expect(screen.queryByText(/None of this workroom's organization's agents/)).not.toBeInTheDocument();
  });

  it("with no agents left to add, an organization admin is offered Add an agent", () => {
    render(<TeamScreen {...props} agents={[]} />);
    expect(screen.getByRole("link", { name: "Add an agent" })).toHaveAttribute("href", "/agents/connect");
    expect(screen.queryByText(/Connect an agent/)).toBeNull();
  });

  it("with no agents left to add, someone who administers no organization is told who can add one", () => {
    render(<TeamScreen {...props} agents={[]} viewer={{ id: "per_adm", orgs: ["org_a"], adminOrgs: [] }} />);
    expect(screen.queryByRole("link", { name: "Add an agent" })).toBeNull();
    expect(screen.getByText(/An organization admin can add one/)).toBeInTheDocument();
  });

  it("explains a stale page and offers the latest", async () => {
    reply = { status: 409, body: { error: { code: "version_conflict" } } };
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("per_m")).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke access" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review latest" }));
    expect(routerCalls.refresh).toBe(1);
  });

  it("offers only agents not already here, and sends the agent's own organization", async () => {
    render(<TeamScreen {...props} />);
    const select = screen.getByLabelText("Agent");
    expect(within(select).queryByRole("option", { name: /Code Agent/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, "agt_2");
    await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(await screen.findByText(/Agent added/)).toBeInTheDocument();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/v1/workspaces/ws_1/members", body: { policy_version: 4, principal_id: "agt_2", kind: "agent", org_id: "org_a", role: "member" } });
  });

  it("sends another organization to an invitation", async () => {
    reply = { status: 403, body: { error: { code: "invitation_required" } } };
    render(<TeamScreen {...props} />);
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "agt_2");
    await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Send an invitation");
    expect(screen.getByLabelText("Agent")).toHaveValue("agt_2");
  });

  it("shows a new invitation's link once, and defaults to guest", async () => {
    reply = { status: 200, body: { id: "ivt_2", token: "inv_ws_1.ivt_2.secret", role: "guest", expires_at: 1 } };
    render(<TeamScreen {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const link = await screen.findByLabelText(/shown only once/);
    expect(link).toHaveValue(`${window.location.origin}/invitations/inv_ws_1.ivt_2.secret`);
    expect(link).toHaveFocus();
    expect(sent[0].body).toEqual({ policy_version: 4, role: "guest", guest_can_create: false });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText(/shown only once/)).not.toBeInTheDocument();
  });

  it("withdraws a pending invitation by its ID", async () => {
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("ivt_1")).getByRole("button", { name: "Withdraw" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw invitation" }));
    expect(await screen.findByText(/Invitation withdrawn/)).toBeInTheDocument();
    expect(sent[0]).toEqual({ method: "DELETE", url: "/api/v1/workspaces/ws_1/invitations/ivt_1", body: { policy_version: 4 } });
  });

  it("says when the invitation list can't be trusted, instead of showing it as empty", () => {
    render(<TeamScreen {...props} invitations={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/No invitations are pending/)).not.toBeInTheDocument();
  });
});

describe("Team, in an archived room", () => {
  const archived = { ...props, archived: true };

  it("offers only what still works: taking people and links out", () => {
    render(<TeamScreen {...archived} />);
    expect(screen.queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add from your organization" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create invitation" })).not.toBeInTheDocument();
    expect(within(row("per_m")).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(within(row("ivt_1")).getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("marks pending invitations as paused", () => {
    render(<TeamScreen {...archived} />);
    expect(within(row("ivt_1")).getByText("Paused")).toBeInTheDocument();
  });

  it("explains workspace_archived if a stale page tries anyway", async () => {
    reply = { status: 409, body: { error: { code: "workspace_archived" } } };
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("per_m")).getByRole("button", { name: "Make admin" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This workroom is archived");
  });
});

describe("Team, when a response is lost", () => {
  const keys: (string | null)[] = [];

  beforeEach(() => {
    keys.length = 0;
    let failing = true;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)) });
      if (failing) {
        failing = false;
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
  });

  it("says the outcome is unknown, then repeats the same request under the same key", async () => {
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("ivt_1")).getByRole("button", { name: "Withdraw" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't tell whether this saved.");
    expect(routerCalls.refresh).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Invitation withdrawn/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(sent[1]).toEqual(sent[0]);
    expect(routerCalls.refresh).toBe(1);
  });

  it("a stored answer has no token, so it says the link can't be shown and doesn't pretend", async () => {
    reply = { status: 200, body: { id: "ivt_2", role: "guest", expires_at: 1 } };
    render(<TeamScreen {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const alert = await screen.findByText(/Withdraw ivt_2 below and create another/);
    expect(alert).toHaveFocus();
    expect(screen.queryByText(/Copy its link now/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/shown only once/)).not.toBeInTheDocument();
    expect(keys[1]).toBe(keys[0]);
  });

  it("clicking Create invitation again repeats the attempt rather than making a second one", async () => {
    reply = { status: 200, body: { id: "ivt_2", role: "guest", expires_at: 1 } };
    render(<TeamScreen {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await screen.findByText(/Withdraw ivt_2 below/);
    expect(keys[1]).toBe(keys[0]);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("clears the warning once that invitation is withdrawn", async () => {
    reply = { status: 200, body: { id: "ivt_1", role: "guest", expires_at: 1 } };
    render(<TeamScreen {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText(/Withdraw ivt_1 below/);
    await userEvent.click(within(row("ivt_1")).getByRole("button", { name: "Withdraw" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw invitation" }));
    await screen.findByText(/Invitation withdrawn/);
    expect(screen.queryByText(/Withdraw ivt_1 below/)).not.toBeInTheDocument();
  });

  it("a new command gets a new key", async () => {
    render(<TeamScreen {...props} />);
    await userEvent.click(within(row("ivt_1")).getByRole("button", { name: "Withdraw" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw invitation" }));
    await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe("Team's invitation list", () => {
  it("shows status, and says when the list is cut short", () => {
    render(<TeamScreen {...props} invitations={{ pending: props.invitations!.pending, complete: false }} />);
    expect(within(row("ivt_1")).getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText(/more pending invitations than we can list/)).toBeInTheDocument();
  });
});

describe("Team, for others", () => {
  it("an admin can't appoint or touch another admin", () => {
    render(<TeamScreen {...props} viewer={{ id: "per_adm", orgs: ["org_a"], adminOrgs: [] }} />);
    expect(screen.queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove admin" })).not.toBeInTheDocument();
    expect(within(row("per_m")).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(within(row("You")).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Role").at(-1)).not.toHaveTextContent("Admin");
  });

  it("a member has no controls at all", () => {
    render(<TeamScreen {...props} policyVersion={null} invitations={null} viewer={{ id: "per_m", orgs: ["org_a"], adminOrgs: [] }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invitations" })).not.toBeInTheDocument();
  });

  it("an agent's organization admin can open that agent, read-only", () => {
    render(<TeamScreen {...props} policyVersion={null} invitations={null} viewer={{ id: "per_b", orgs: ["org_b"], adminOrgs: ["org_b"] }} />);
    expect(within(row("agt_x")).getByRole("link", { name: "View access" })).toBeInTheDocument();
    expect(within(row("Code Agent")).queryByRole("link")).not.toBeInTheDocument();
  });

  it("UI-07: a hostile agent name stays plain text and gets its label", () => {
    const { container } = render(<TeamScreen {...props} names={{ agt_1: '<img src="https://evil.example/x.png"> Podster Admin' }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(within(row('<img src="https://evil.example/x.png"> Podster Admin')).getByText("Name chosen by this agent")).toBeInTheDocument();
  });
});
