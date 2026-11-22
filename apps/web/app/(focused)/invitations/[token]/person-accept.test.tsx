import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { InvitationScreen } from "./invitation-screen";

// A person invitation's page (decision 239): only its addressee gets a preview, and they choose which of their own
// organizations they join as.

const goToSignIn = vi.hoisted(() => vi.fn());
vi.mock("../../../(shell)/w/[id]/tasks/go-to-sign-in", () => ({ goToSignIn }));

const PREVIEW = { workspace_id: "ws_1", workspace_name: "Launch room", invitee_kind: "person", work_role: null, role: "guest", guest_can_create: false, invited_org_id: null, invited_by: "per_a", expires_at: Date.UTC(2026, 10, 29), orgs: ["org_team", "org_me"], ends_oversight: false };
const people = { orgNames: { org_me: "Long", org_team: "Long's team" }, personal: "org_me" };

let replies: (() => Response)[];
const sent: { url: string; body: unknown }[] = [];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  setUrl("/invitations/inv_t");
  sent.length = 0;
  replies = [json(200, PREVIEW)];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return (replies.length > 1 ? replies.shift()! : replies[0])();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("a person invitation", () => {
  it("offers their organizations, personal first, and joins as the one chosen", async () => {
    render(<InvitationScreen token="inv_t" form={null} people={people} />);
    const select = await screen.findByLabelText("Join as");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Long (personal)", "Long's team"]);
    expect(screen.getByText(/Guest: you see only tasks you're part of/)).toBeInTheDocument();
    expect(screen.getByText(/never your agents/)).toBeInTheDocument();
    replies = [json(200, { status: "accepted", principal_id: "per_long", org_id: "org_team", role: "guest" })];
    await userEvent.selectOptions(select, "org_team");
    await userEvent.click(screen.getByRole("button", { name: "Join workroom" }));
    expect(sent[1]).toEqual({ url: "/api/v1/invitations/accept", body: { token: "inv_t", org_id: "org_team" } });
    expect(await screen.findByText("You joined the workroom.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the workroom" })).toHaveAttribute("href", "/w/ws_1");
  });

  it("says accepting ends oversight they have here, for good", async () => {
    replies = [json(200, { ...PREVIEW, ends_oversight: true })];
    render(<InvitationScreen token="inv_t" form={null} people={people} />);
    expect(await screen.findByRole("note")).toHaveTextContent("that oversight doesn't come back, even if you leave");
  });

  it("answers a used or mismatched link as any bad link", async () => {
    render(<InvitationScreen token="inv_t" form={null} people={people} />);
    await screen.findByLabelText("Join as");
    replies = [json(404, { error: { code: "invitation_not_found" } })];
    await userEvent.click(screen.getByRole("button", { name: "Join workroom" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation link isn't valid.");
  });

  it("holds the choice after an unknown outcome, so a retry is the same request", async () => {
    render(<InvitationScreen token="inv_t" form={null} people={people} />);
    await screen.findByLabelText("Join as");
    replies = [json(503, { error: { code: "internal_error" } })];
    await userEvent.click(screen.getByRole("button", { name: "Join workroom" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't tell whether this worked");
    expect(screen.getByLabelText("Join as")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});
