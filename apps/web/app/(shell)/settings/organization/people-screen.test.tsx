import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, routerCalls, setUrl } from "@/test/next-navigation";
import { joinLink, explainOrgRefusal } from "./model";
import { PeopleScreen, type PeopleProps } from "./people-screen";

const props: PeopleProps = {
  org: { id: "org_a", name: "Acme", personal: false, admin: true },
  me: "per_me",
  members: [
    { person_id: "per_me", role: "admin", created_at: 0, name: "Pat" },
    { person_id: "per_sam", role: "member", created_at: 0, name: "Sam" },
    { person_id: "per_noname", role: "member", created_at: 0, name: null },
  ],
  invitations: [{ id: "oin_1", role: "member", created_by: "per_sam", created_at: 0, expires_at: 86_400_000 }],
  lostCredentials: [],
};

const sent: { method: string; url: string; body: unknown }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/settings/organization");
  sent.length = 0;
  reply = { status: 200, body: {} };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

const row = (name: string | RegExp) => screen.getByText(name).closest("li") as HTMLElement;

describe("people in an organization", () => {
  it("names people, keeps the ID to copy, and falls back to it", () => {
    render(<PeopleScreen {...props} />);
    expect(within(row("Sam")).getByText(/per_sam/)).toBeInTheDocument();
    expect(within(row("You")).getByText(/per_me/)).toBeInTheDocument();
    expect(screen.getAllByText(/per_noname/).length).toBeGreaterThan(0);
  });

  it("warns what removing someone ends, including a room they own, before it does anything", async () => {
    const user = userEvent.setup();
    render(<PeopleScreen {...props} />);
    await user.click(within(row("Sam")).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Every credential they connected stops working");
    expect(dialog).toHaveTextContent("Workrooms whose owner left");
    expect(sent).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Remove from organization" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("credentials they connected no longer work"));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "/api/orgs/org_a/members/per_sam" });
    expect(routerCalls.refresh).toBeGreaterThan(0);
  });

  it("says why the last admin can't be changed, and doesn't pretend it worked", async () => {
    const user = userEvent.setup();
    reply = { status: 409, body: { error: { code: "last_admin" } } };
    render(<PeopleScreen {...props} />);
    await user.click(within(row("You")).getByRole("button", { name: "Stop being admin" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop being admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least one admin");
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/orgs/org_a/members/per_me", body: { role: "member" } });
  });

  it("changes a role through the server", async () => {
    const user = userEvent.setup();
    render(<PeopleScreen {...props} />);
    await user.click(within(row("Sam")).getByRole("button", { name: "Make admin" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(sent[0]).toMatchObject({ method: "PUT", body: { role: "admin" } }));
  });

  it("shows a link once, with the token only in the fragment", async () => {
    const user = userEvent.setup();
    reply = { status: 200, body: { id: "oin_2", token: "oin_2.secret", role: "admin", expires_at: 1 } };
    render(<PeopleScreen {...props} />);
    await user.selectOptions(screen.getByLabelText("Role when they join"), "admin");
    await user.click(screen.getByRole("button", { name: "Create invitation link" }));
    const link = await screen.findByLabelText(/shown only once/);
    expect(link).toHaveValue(`${window.location.origin}/join#oin_2.secret`);
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/orgs/org_a/invitations", body: { role: "admin" } });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText(/shown only once/)).toBeNull();
  });

  it("names who made an invitation, and withdraws it", async () => {
    const user = userEvent.setup();
    render(<PeopleScreen {...props} />);
    expect(row(/Created by Sam/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw invitation" }));
    await waitFor(() => expect(sent[0]).toMatchObject({ method: "DELETE", url: "/api/orgs/org_a/invitations/oin_1" }));
  });

  it("offers a member only leaving", () => {
    render(<PeopleScreen {...props} org={{ ...props.org, admin: false }} invitations={null} lostCredentials={null} members={[{ person_id: "per_me", role: "member", created_at: 0, name: "Pat" }, props.members[1]]} />);
    expect(within(row("You")).getByRole("button", { name: "Leave" })).toBeInTheDocument();
    expect(within(row("Sam")).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create invitation link" })).toBeNull();
    expect(screen.getByText(/Only this organization's admins/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add an agent" })).toBeNull();
  });

  it("leaves, and goes to what's still theirs", async () => {
    const user = userEvent.setup();
    render(<PeopleScreen {...props} />);
    await user.click(within(row("You")).getByRole("button", { name: "Leave" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("A workroom you own stays on record as yours");
    await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));
    await waitFor(() => expect(currentUrl()).toBe("/settings/organization?left=1"));
  });

  it("offers nothing in a personal organization", () => {
    render(<PeopleScreen {...props} org={{ ...props.org, personal: true }} invitations={null} members={[props.members[0]]} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/personal organization is only you/)).toBeInTheDocument();
  });

  it("lists agents whose credentials stopped working, and says when it can't tell", () => {
    const { rerender } = render(<PeopleScreen {...props} lostCredentials={[{ id: "agt_1", name: "Builder", count: 2 }]} />);
    expect(row("Builder")).toHaveTextContent("2 credentials refused");
    expect(screen.getByRole("link", { name: "Add an agent" })).toHaveAttribute("href", "/agents/connect");
    expect(screen.queryByText(/Connect an agent/)).toBeNull();
    rerender(<PeopleScreen {...props} lostCredentials={null} />);
    expect(within(screen.getByRole("region", { name: "Credentials that stopped working" })).getByRole("alert")).toBeInTheDocument();
  });

  it("clears the link when its own invitation is withdrawn, and not for another", async () => {
    const user = userEvent.setup();
    reply = { status: 200, body: { id: "oin_new", token: "oin_new.secret", role: "member", expires_at: 1 } };
    const withdraw = async (name: RegExp) => {
      await user.click(within(row(name)).getByRole("button", { name: "Withdraw" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw invitation" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    };
    render(<PeopleScreen {...props} invitations={[props.invitations![0], { ...props.invitations![0], id: "oin_new", created_by: "per_me" }]} />);
    await user.click(screen.getByRole("button", { name: "Create invitation link" }));
    await screen.findByLabelText(/shown only once/);
    reply = { status: 200, body: {} };
    await withdraw(/Created by Sam/);
    expect(screen.getByLabelText(/shown only once/)).toBeInTheDocument();
    await withdraw(/Created by You/);
    expect(screen.queryByLabelText(/shown only once/)).toBeNull();
  });

  it("labels a person whose name could pass for an authority or the viewer, but not the viewer", () => {
    render(<PeopleScreen {...props} members={[{ person_id: "per_me", role: "admin", created_at: 0, name: "Admin Pat" }, { person_id: "per_x", role: "member", created_at: 0, name: "You" }]} invitations={[{ ...props.invitations![0], created_by: "per_x" }]} />);
    expect(screen.getByText(/per_x/).closest("li")).toHaveTextContent("Name chosen by this person");
    expect(screen.getByText(/per_me/).closest("li")).not.toHaveTextContent("Name chosen");
    expect(screen.getByText(/Created by You \(name chosen by this person\)/)).toBeInTheDocument();
  });

  it("doesn't blame the other person when a viewer's own access may be what ended", async () => {
    const user = userEvent.setup();
    reply = { status: 404, body: { error: { code: "not_found" } } };
    render(<PeopleScreen {...props} />);
    await user.click(screen.getByRole("button", { name: "Create invitation link" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("you may no longer be in this organization");
  });

  it("says the credentials list may be incomplete, even when it's empty", () => {
    render(<PeopleScreen {...props} lostCredentialsPartial />);
    expect(screen.getByText(/some may be missing from this list/)).toBeInTheDocument();
  });

  it("doesn't claim nothing changed after a server error", () => {
    expect(explainOrgRefusal("anything", 503)).toMatch(/can't tell/);
    expect(joinLink("https://a.test", "t")).toBe("https://a.test/join#t");
  });
});
