import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import type { RepoGrant } from "../settings/repository-model";
import { RepositoryGrants, type GrantsProps } from "./repository-grants";

const grant = (over: Partial<RepoGrant> = {}): RepoGrant => ({ id: "pg_1", principal_id: "agt_1", action: "push", delegated_by: "per_owner", created_at: Date.UTC(2026, 10, 1), expires_at: null, revoked_at: null, state: "live", ...over });

const props = (over: Partial<GrantsProps> = {}): GrantsProps => ({
  roomId: "ws_1",
  grants: [grant(), grant({ id: "pg_2", principal_id: "per_m", action: "merge", expires_at: Date.UTC(2027, 0, 1), state: "stale" })],
  linked: true,
  isOwner: true,
  isOrgAdmin: false,
  viewerId: "per_owner",
  policyVersion: 7,
  archived: false,
  members: [
    { principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" },
    { principal_id: "per_m", kind: "person", org_id: "org_a", role: "member" },
  ],
  names: { agt_1: "Code Agent", per_m: "Mia" },
  ...over,
});

const sent: { method: string; url: string; body: unknown; key: string | null }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/team");
  sent.length = 0;
  reply = { status: 200, body: grant() };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null, key: new Headers(init.headers).get("idempotency-key") });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the grants list", () => {
  it("lists who holds push or merge, who gave it and when it expires, with state labelled as display only", () => {
    render(<RepositoryGrants {...props()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Code Agent · Push");
    expect(rows[0]).toHaveTextContent("Given by You on 2026-11-01 · No expiry");
    expect(rows[0]).toHaveTextContent("As last read: Live");
    expect(rows[1]).toHaveTextContent("Mia · Merge");
    expect(rows[1]).toHaveTextContent("Expires 2027-01-01");
    expect(rows[1]).toHaveTextContent("As last read: Its giver no longer holds the delegation");
    expect(screen.getByText(/the person behind a task's submitter can't merge that task/)).toBeInTheDocument();
  });

  it("offers the owner a take-back on every grant, and an admin who isn't the organization's admin none", () => {
    const { unmount } = render(<RepositoryGrants {...props()} />);
    expect(screen.getAllByRole("button", { name: "Take back" })).toHaveLength(2);
    unmount();
    render(<RepositoryGrants {...props({ isOwner: false, viewerId: "per_adm" })} />);
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.getByText(/Only this workroom's owner can grant repository access/)).toBeInTheDocument();
  });

  it("offers an organization's admin every take-back, and a holder who manages access their own", () => {
    const { unmount } = render(<RepositoryGrants {...props({ isOwner: false, isOrgAdmin: true, viewerId: "per_adm" })} />);
    expect(screen.getAllByRole("button", { name: "Take back" })).toHaveLength(2);
    unmount();
    render(<RepositoryGrants {...props({ isOwner: false, viewerId: "per_m" })} />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).queryByRole("button", { name: "Take back" })).toBeNull();
    expect(within(rows[1]!).getByRole("button", { name: "Take back" })).toBeInTheDocument();
  });

  it("takes a grant back only after a confirmation that names it", async () => {
    render(<RepositoryGrants {...props()} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Take back" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Take back Code Agent's push access?");
    expect(sent).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Take back" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "/api/v1/workspaces/ws_1/repository/grants/pg_1", body: { policy_version: 7 } });
    expect(await screen.findByText("Grant taken back.")).toBeInTheDocument();
  });

  it("shows a holder without the room's version their grant, and no take-back the API couldn't take", () => {
    render(<RepositoryGrants {...props({ isOwner: false, viewerId: "agt_1", policyVersion: null, linked: null, grants: [grant()] })} />);
    expect(screen.getByText("You · Push")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("giving a grant", () => {
  it("sends the participant, the action and an expiry within a year, under the room's version", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 12), toFake: ["Date"] });
    render(<RepositoryGrants {...props({ grants: [] })} />);
    expect(screen.getByText("Nobody holds repository access yet.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Participant"), "per_m");
    await userEvent.click(screen.getByLabelText("Merge"));
    await userEvent.type(screen.getByLabelText("Expires (optional)"), "2027-11-10");
    expect(screen.getByText("Choose a day at most a year from now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Expires (optional)"));
    await userEvent.type(screen.getByLabelText("Expires (optional)"), "2026-11-09");
    expect(screen.getByText("Choose a day that hasn't ended yet, in UTC.")).toBeInTheDocument();
    // Today hasn't ended, so the API's "after now" takes it.
    await userEvent.clear(screen.getByLabelText("Expires (optional)"));
    await userEvent.type(screen.getByLabelText("Expires (optional)"), "2026-11-10");
    expect(screen.getByRole("button", { name: "Grant" })).toBeEnabled();
    await userEvent.clear(screen.getByLabelText("Expires (optional)"));
    await userEvent.type(screen.getByLabelText("Expires (optional)"), "2027-06-30");
    await userEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/repository/grants", body: { policy_version: 7, principal_id: "per_m", action: "merge", expires_at: Date.UTC(2027, 5, 30, 23, 59, 59) } });
    expect(await screen.findByText("Granted merge to Mia.")).toBeInTheDocument();
  });

  it("sends no expiry when none is chosen", async () => {
    render(<RepositoryGrants {...props({ grants: [] })} />);
    await userEvent.selectOptions(screen.getByLabelText("Participant"), "agt_1");
    await userEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ policy_version: 7, principal_id: "agt_1", action: "push" });
  });

  it("shows the API's refusal as a sentence, a public-claim participant's included", async () => {
    reply = { status: 403, body: { error: { code: "grantee_public", message: "grantee_public" } } };
    render(<RepositoryGrants {...props({ grants: [] })} />);
    await userEvent.selectOptions(screen.getByLabelText("Participant"), "agt_1");
    await userEvent.click(screen.getByRole("button", { name: "Grant" }));
    // It says what to do next, and the form keeps the choice so the owner can pick someone else.
    expect(await screen.findByRole("alert")).toHaveTextContent("They joined from the public page, so they can't hold repository access. Choose a participant who joined by invitation or was added directly. Nothing changed.");
    expect(screen.getByLabelText("Participant")).toBeEnabled();
  });

  it("isn't offered without a linked repository, in an archived room, or to anyone but the owner", () => {
    const { unmount } = render(<RepositoryGrants {...props({ linked: false, grants: [] })} />);
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.getByText(/once this workroom's repository is set up/)).toBeInTheDocument();
    unmount();
    const archived = render(<RepositoryGrants {...props({ archived: true })} />);
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    archived.unmount();
    render(<RepositoryGrants {...props({ isOwner: false })} />);
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  });

  it("announces the expiry's problem through a live region it's described by", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 12), toFake: ["Date"] });
    render(<RepositoryGrants {...props({ grants: [] })} />);
    const field = screen.getByLabelText("Expires (optional)");
    await userEvent.type(field, "2028-01-01");
    const message = screen.getByText("Choose a day at most a year from now.");
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(field).toHaveAccessibleDescription("Choose a day at most a year from now.");
  });

  it("never offers a participant who joined through a public claim, and says why they're unavailable", () => {
    render(<RepositoryGrants {...props({ grants: [], members: [{ principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member", public_claim: false }, { principal_id: "agt_pub", kind: "agent", org_id: "org_b", role: "guest", public_claim: true }] })} />);
    const options = within(screen.getByLabelText("Participant")).getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(options).toEqual(["", "agt_1"]);
    expect(screen.getByText(/Unavailable: they joined from the public page/)).toBeInTheDocument();
    expect(screen.getByText(/agt_pub/)).toBeInTheDocument();
  });

  it("offers everyone when the read doesn't say how they joined, and still shows the API's refusal", async () => {
    reply = { status: 400, body: { error: { code: "grantee_public", message: "grantee_public" } } };
    render(<RepositoryGrants {...props({ grants: [] })} />);
    expect(screen.queryByText(/Unavailable:/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Participant"), "agt_1");
    await userEvent.click(screen.getByRole("button", { name: "Grant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a participant who joined by invitation or was added directly.");
  });

  it("shows hostile names as text", () => {
    render(<RepositoryGrants {...props({ names: { agt_1: "<b>Owner</b>‮", per_m: "Mia" } })} />);
    expect(screen.getAllByText(/<b>Owner<\/b> · Push/)).toHaveLength(1);
    expect(document.querySelector("b")).toBeNull();
  });
});
