import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { WHAT_AN_APP_IS } from "../w/[id]/settings/release-model";
import type { ApprovalItem } from "./attention-model";
import type { Approvals } from "./load-attention";
import { APPROVALS_UNAVAILABLE, explainApprovalRefusal, ReleaseApprovals } from "./release-approvals";

// M6 step 10(b): release approvals in Needs attention, wired to approveRelease and declineRelease.

const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const REL = `rel_${"a1".repeat(16)}`;
const item = (over: Partial<ApprovalItem["release"]> = {}): ApprovalItem => ({ workspace: "ws_1", workspaceName: "Billing", release: { id: REL, task_id: "tsk_1", commit_sha: SHA, state: "awaiting_approval", requested_by: "per_r", requested_at: 1, ...over } });
const read = (items: ApprovalItem[], over: Partial<Extract<Approvals, { state: "read" }>> = {}): Approvals => ({ state: "read", items, failedRooms: 0, fullRooms: 0, uncheckedRooms: 0, ...over });

let sent: { url: string; method: string; key: string | null; body: unknown }[];
let reply: () => Response;

beforeEach(() => {
  setUrl("/attention");
  sent = [];
  reply = () => new Response(JSON.stringify({ id: REL, state: "queued" }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", key: new Headers(init?.headers).get("idempotency-key"), body: init?.body });
    return reply();
  });
});

const show = (approvals: Approvals) => render(<ReleaseApprovals approvals={approvals} me="per_me" names={{ per_r: "Rae" }} taskTitles={{ tsk_1: "Ship the todo app" }} />);

describe("release approvals in Needs attention", () => {
  it("says Unavailable while release is off, with nothing to decide and nothing implying serving", () => {
    show({ state: "unavailable" });
    const section = screen.getByRole("region", { name: /Release approvals/ });
    expect(section).toHaveTextContent("Unavailable.");
    expect(section).toHaveTextContent(APPROVALS_UNAVAILABLE);
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("link")).toBeNull();
    expect(section.textContent).not.toMatch(/\blive\b/i);
  });

  it("lists a release by its commit, room, task and who asked, with Approve and Decline", () => {
    show(read([item()]));
    const section = screen.getByRole("region", { name: /Release approvals/ });
    expect(section).toHaveTextContent("Release approvals (1)");
    expect(section).toHaveTextContent("Release of commit a1b2c3d4e5f6");
    expect(section).toHaveTextContent("Ship the todo app · Billing · Asked for by Rae");
    expect(within(section).getByRole("button", { name: "Approve release of commit a1b2c3d4e5f6" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Decline release of commit a1b2c3d4e5f6" })).toBeInTheDocument();
  });

  it("confirms an approval repeating what a released app is, then sends it once with a key, and refreshes", async () => {
    const user = userEvent.setup();
    show(read([item()]));
    await user.click(screen.getByRole("button", { name: "Approve release of commit a1b2c3d4e5f6" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(WHAT_AN_APP_IS);
    expect(dialog).toHaveTextContent("exactly commit a1b2c3d4e5f6");
    expect(sent).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(routerCalls.refresh).toBe(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `/api/v1/workspaces/ws_1/releases/${REL}/approve`, method: "POST", body: undefined });
    expect(sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("declines through its own route, and the confirmation says nothing is uploaded", async () => {
    const user = userEvent.setup();
    show(read([item()]));
    await user.click(screen.getByRole("button", { name: "Decline release of commit a1b2c3d4e5f6" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Nothing is uploaded");
    expect(dialog).not.toHaveTextContent(WHAT_AN_APP_IS);
    await user.click(within(dialog).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe(`/api/v1/workspaces/ws_1/releases/${REL}/decline`);
  });

  it("says why when refused, and retries a lost answer under the same key", async () => {
    const user = userEvent.setup();
    reply = () => new Response(JSON.stringify({ error: { code: "release_not_available", message: "x" } }), { status: 409 });
    show(read([item()]));
    await user.click(screen.getByRole("button", { name: "Approve release of commit a1b2c3d4e5f6" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't available on this Podster deployment yet. Nothing changed.");
    reply = () => new Response("{}", { status: 500 });
    await user.click(screen.getByRole("button", { name: "Approve release of commit a1b2c3d4e5f6" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("We can't tell whether this was recorded"));
    expect(sent).toHaveLength(2);
    expect(sent[0].key).toBe(sent[1].key);
    expect(routerCalls.refresh).toBe(0);
  });

  it("says when it couldn't check every room, and never calls a partial list empty", () => {
    show(read([], { failedRooms: 1, uncheckedRooms: 2 }));
    const section = screen.getByRole("region", { name: /Release approvals/ });
    expect(section).toHaveTextContent("Couldn't check 1 workroom");
    expect(section).toHaveTextContent("2 more weren't checked");
    expect(section).not.toHaveTextContent("No release is waiting");
  });

  it("names each other state plainly", () => {
    const { unmount } = show({ state: "none" });
    expect(screen.getByText(/You don't own or administer a workroom/)).toBeInTheDocument();
    unmount();
    show(read([]));
    expect(screen.getByText("No release is waiting for your approval.")).toBeInTheDocument();
    expect(explainApprovalRefusal("standing_unknown", 503)).toMatch(/Nothing changed/);
    expect(explainApprovalRefusal("not_allowed", 403)).toMatch(/owner and admins/);
  });

  it("passes axe with a release listed and with its confirmation open", async () => {
    const user = userEvent.setup();
    const { container } = show(read([item()]));
    const rules = { rules: { "color-contrast": { enabled: false } } };
    expect((await axe.run(container, rules)).violations.map((v) => v.id)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Approve release of commit a1b2c3d4e5f6" }));
    expect((await axe.run(await screen.findByRole("alertdialog"), rules)).violations.map((v) => v.id)).toEqual([]);
  });
});
