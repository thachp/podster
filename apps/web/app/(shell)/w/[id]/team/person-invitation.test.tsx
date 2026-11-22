import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { TeamScreen, type TeamProps } from "./team-screen";

// Inviting a person from another organization by email, an outside person on the Team tab, and leaving (decision 239).

const props: TeamProps = {
  roomId: "ws_1",
  roomName: "Launch room",
  owner: "per_owner",
  roomOrg: "org_a",
  policyVersion: 4,
  members: [
    { principal_id: "per_m", kind: "person", org_id: "org_a", role: "member" },
    { principal_id: "per_long", kind: "person", org_id: "org_long", role: "guest" },
  ],
  viewer: { id: "per_owner", orgs: ["org_a"], adminOrgs: ["org_a"] },
  names: {},
  orgNames: { org_a: "Org A" },
  orgs: [{ id: "org_a", name: "Org A" }],
  agents: [],
  invitations: {
    pending: [
      { id: "ivt_p", role: "member", invitedOrg: null, createdBy: "per_owner", createdAt: 0, expiresAt: 1, workRole: null, email: "long@example.com" },
      { id: "ivt_o", role: "guest", invitedOrg: null, createdBy: "per_owner", createdAt: 0, expiresAt: 1, workRole: null, email: null },
    ],
    complete: true,
  },
};

const sent: { method: string; url: string; body: unknown }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/team");
  sent.length = 0;
  routerCalls.push = 0;
  reply = { status: 200, body: {} };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

afterEach(() => vi.unstubAllGlobals());

const row = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
const personForm = () => screen.getByRole("heading", { name: "Invite a person" }).closest("form") as HTMLElement;

describe("inviting a person", () => {
  it("sends one email as a guest by default, and shows the link once", async () => {
    reply = { status: 200, body: { id: "ivt_2", token: "inv_ws_1.ivt_2.secret", invitee_kind: "person", role: "guest", expires_at: 1 } };
    render(<TeamScreen {...props} />);
    await userEvent.type(within(personForm()).getByLabelText("Email"), " long@example.com ");
    await userEvent.click(within(personForm()).getByRole("button", { name: "Invite person" }));
    expect(sent[0]).toEqual({ method: "POST", url: "/api/v1/workspaces/ws_1/invitations", body: { policy_version: 4, role: "guest", invitee: { kind: "person", email: "long@example.com" }, guest_can_create: false } });
    const link = await screen.findByLabelText(/Their invitation link/);
    expect(link).toHaveValue(`${window.location.origin}/invitations/inv_ws_1.ivt_2.secret`);
    expect(link).toHaveFocus();
  });

  it("offers guest and member only, never admin", () => {
    render(<TeamScreen {...props} />);
    const options = within(within(personForm()).getByLabelText("Role")).getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(options).toEqual(["guest", "member"]);
  });

  it("explains a limit without saying more", async () => {
    reply = { status: 429, body: { error: { code: "limit_exceeded" } } };
    render(<TeamScreen {...props} />);
    await userEvent.type(within(personForm()).getByLabelText("Email"), "x@example.com");
    await userEvent.click(within(personForm()).getByRole("button", { name: "Invite person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("20 pending, and 20 a day");
  });

  it("says a lost link is fixed by inviting again, which replaces it", async () => {
    reply = { status: 200, body: { id: "ivt_2", invitee_kind: "person", role: "guest", expires_at: 1 } };
    render(<TeamScreen {...props} />);
    await userEvent.type(within(personForm()).getByLabelText("Email"), "long@example.com");
    await userEvent.click(within(personForm()).getByRole("button", { name: "Invite person" }));
    expect(await screen.findByText(/a new invitation replaces this one/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Their invitation link/)).not.toBeInTheDocument();
  });

  it("doesn't blame the address alone for a refused invitation", async () => {
    reply = { status: 400, body: { error: { code: "invalid_argument" } } };
    render(<TeamScreen {...props} />);
    await userEvent.type(within(personForm()).getByLabelText("Email"), "long@example.com");
    await userEvent.click(within(personForm()).getByRole("button", { name: "Invite person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the address and the role");
  });

  it("lists a pending person invitation by its address, to those who manage access", () => {
    render(<TeamScreen {...props} />);
    expect(within(row("ivt_p")).getByText(/Person: long@example\.com/)).toBeInTheDocument();
    expect(within(row("ivt_o")).getByText(/Any organization/)).toBeInTheDocument();
  });
});

describe("an outside person on the Team tab", () => {
  it("is marked External and never offered admin", () => {
    render(<TeamScreen {...props} />);
    expect(within(row("per_long")).getByText("External")).toBeInTheDocument();
    expect(within(row("per_long")).queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
    expect(within(row("per_m")).getByRole("button", { name: "Make admin" })).toBeInTheDocument();
  });
});

describe("leaving", () => {
  it("lets a person leave on their own, with no policy version, and goes to their workrooms", async () => {
    const viewer = { id: "per_long", orgs: ["org_long", "org_team"], adminOrgs: ["org_team"] };
    reply = { status: 200, body: { principal_id: "per_long", status: "left" } };
    render(<TeamScreen {...props} policyVersion={null} invitations={null} viewer={viewer} />);
    expect(within(row("You")).getByText(/another organization than this workroom's/)).toBeInTheDocument();
    await userEvent.click(within(row("You")).getByRole("button", { name: "Leave workroom" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("oversight you had of your organization's agents here doesn't come back");
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave workroom" }));
    expect(await screen.findByText("You've left this workroom.")).toBeInTheDocument();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/v1/workspaces/ws_1/leave", body: {} });
    expect(routerCalls.push).toBe(1);
  });

  it("isn't offered to the owner, or on anyone else's row", () => {
    render(<TeamScreen {...props} />);
    expect(screen.queryByRole("button", { name: "Leave workroom" })).not.toBeInTheDocument();
  });
});
