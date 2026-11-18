import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundSignal, setUrl } from "@/test/next-navigation";

const state = vi.hoisted(() => ({ reply: null as unknown, asked: [] as string[] }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    return state.reply;
  },
  rateLimited: () => null,
}));

const { default: Moderation } = await import("./page");
const HANDLE = `pub_${"b".repeat(32)}`;
const report = { id: "rpt_1", handle: HANDLE, agent_id: "agt_x", reason: "impersonation", note: "Says it's ‮Podster <b>staff</b>", created_at: Date.UTC(2026, 10, 9) };
const show = async (params: Record<string, string> = {}) => render((await Moderation({ searchParams: Promise.resolve(params) })) as ReactElement);

const sent: { url: string; body: unknown }[] = [];
let answer: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/moderation");
  state.asked.length = 0;
  state.reply = { ok: true, data: { reports: [report], next_cursor: "cur_2" } };
  sent.length = 0;
  answer = { status: 200, body: { report_id: "rpt_1", suspended: true, reason: "spam", at: 1 } };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function confirm(label: string, button: string) {
  await userEvent.click(screen.getByRole("button", { name: label }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: button }));
}

describe("the operators' queue", () => {
  it.each([403, 401, 429, 500, 502])("isn't there unless the read proved an operator, so a %i is not found too", async (status) => {
    state.reply = { ok: false, status, code: "x" };
    await expect(Moderation({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("shows each report's reason, handle, agent and note as inert text, and pages back", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Impersonation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: HANDLE })).toHaveAttribute("href", `/p/${HANDLE}`);
    expect(screen.getByText("Agent named by the reporter (not checked)")).toBeInTheDocument();
    expect(screen.getByText("agt_x")).toBeInTheDocument();
    expect(screen.getByText("Says it's Podster <b>staff</b>")).toBeInTheDocument();
    expect(screen.getByText("Contained hidden characters")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: "Older reports" })).toHaveAttribute("href", "/moderation?cursor=cur_2");
  });

  it("styles the suspend actions as destructive", async () => {
    await show();
    for (const name of ["Suspend workroom", "Suspend agent's public claims"]) expect(screen.getByRole("button", { name }).className).toMatch(/destructive/);
  });

  it("asks with a cursor only when it's well formed", async () => {
    await show({ cursor: "cur_2" });
    await show({ cursor: "../x" });
    expect(state.asked).toEqual(["/api/v1/moderation/reports?cursor=cur_2", "/api/v1/moderation/reports"]);
  });

  it("suspends the reported room by the report, with the chosen reason", async () => {
    await show();
    await userEvent.selectOptions(screen.getByLabelText("Reason recorded for the workroom"), "spam");
    await userEvent.click(screen.getByRole("button", { name: "Suspend workroom" }));
    expect(await screen.findByRole("alertdialog", { name: `Suspend the workroom reported in rpt_1 (${HANDLE})?` })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: "/api/v1/moderation/reports/rpt_1/suspend-room", body: { reason: "spam" } });
    expect(await screen.findByText("Workroom suspended, for spam.")).toBeInTheDocument();
  });

  it("acts on the named agent only with a reason the operator chose, saying nothing checked it", async () => {
    answer = { status: 200, body: { agent_id: "agt_x", suspended: false, reason: "impersonation", at: 1 } };
    await show();
    expect(screen.getByLabelText("Reason recorded for the agent")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Suspend agent's public claims" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lift agent's suspension" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Reason recorded for the agent"), "impersonation");
    await userEvent.click(screen.getByRole("button", { name: "Suspend agent's public claims" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Suspend the public claims of agt_x, the agent named in rpt_1?" });
    expect(dialog).toHaveTextContent(/nothing has checked/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await confirm("Lift agent's suspension", "Lift");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: "/api/v1/moderation/agents/agt_x/lift", body: { reason: "impersonation" } });
    expect(await screen.findByText("Agent's public claims no longer suspended, for impersonation.")).toBeInTheDocument();
  });

  it("keeps each action's answer to itself", async () => {
    answer = { status: 502, body: {} };
    await show();
    await confirm("Suspend workroom", "Suspend");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    answer = { status: 200, body: { report_id: "rpt_1", suspended: false, reason: "impersonation", at: 1 } };
    await confirm("Lift workroom suspension", "Lift");
    expect(await screen.findByText("Workroom no longer suspended, for impersonation.")).toBeInTheDocument();
    // The suspend's unknown outcome is still there to try again.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("explains a refusal", async () => {
    answer = { status: 404, body: { error: { code: "agent_not_found" } } };
    await show();
    await userEvent.selectOptions(screen.getByLabelText("Reason recorded for the agent"), "spam");
    await confirm("Suspend agent's public claims", "Suspend");
    expect(await screen.findByRole("alert")).toHaveTextContent("That agent was never registered. Nothing changed.");
  });
});

// While release is switched on (M6 step 9) every report has `kind` and `host`, and an app's report names a host and no room.
const appReport = { id: "rpt_2", kind: "app", host: "k3j9x2.podster.site", handle: null, agent_id: null, reason: "abuse", note: "<img src=x onerror=alert(1)> see https://evil.example", created_at: Date.UTC(2026, 10, 13) };
const roomReport = { ...report, kind: "room", host: null };
const strange = { id: "rpt_3", kind: "<b>bundle</b>", host: "javascript:alert(1)", handle: null, agent_id: "agt_y", reason: "spam", note: null, created_at: Date.UTC(2026, 10, 12) };

const accessible = async (container: Element) => {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

describe("apps' reports in the operators' queue", () => {
  beforeEach(() => {
    state.reply = { ok: true, data: { reports: [appReport, roomReport, strange], next_cursor: null } };
    answer = { status: 200, body: { host: "k3j9x2.podster.site", suspended: true, reason: "abuse", at: 1 } };
  });

  const item = (id: string) => screen.getByText(id).closest("li") as HTMLElement;

  it("shows an app's report by its host, as plain text, with only the app's actions", async () => {
    await show();
    const app = within(item("rpt_2"));
    expect(app.getByText("App host")).toBeInTheDocument();
    expect(app.getByText("k3j9x2.podster.site").closest("a")).toBeNull();
    expect(app.queryByRole("link")).toBeNull();
    expect(app.queryByText("Workroom")).toBeNull();
    expect(app.getByText("<img src=x onerror=alert(1)> see https://evil.example")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(app.queryByRole("button", { name: "Suspend workroom" })).toBeNull();
    expect(app.queryByRole("button", { name: "Suspend agent's public claims" })).toBeNull();
    expect(app.getByRole("button", { name: "Suspend app host" }).className).toMatch(/destructive/);
    expect(app.getByLabelText("Reason recorded for the app")).toHaveValue("abuse");
  });

  it("suspends the reported host by the app routes, and lifts it", async () => {
    await show();
    const app = within(item("rpt_2"));
    await userEvent.click(app.getByRole("button", { name: "Suspend app host" }));
    expect(await screen.findByRole("alertdialog", { name: "Suspend the app host reported in rpt_2 (k3j9x2.podster.site)?" })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: "/api/v1/moderation/app-hosts/k3j9x2.podster.site/suspend", body: { reason: "abuse" } });
    expect(await app.findByText("App host suspended, for abuse.")).toBeInTheDocument();
    answer = { status: 200, body: { host: "k3j9x2.podster.site", suspended: false, reason: null, at: null } };
    await userEvent.click(app.getByRole("button", { name: "Lift app host suspension" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Lift" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ url: "/api/v1/moderation/app-hosts/k3j9x2.podster.site/lift", body: { reason: "abuse" } });
    expect(await app.findByText("App host no longer suspended.")).toBeInTheDocument();
  });

  it("explains the app routes' own refusals", async () => {
    answer = { status: 409, body: { error: { code: "release_not_available" } } };
    await show();
    const app = within(item("rpt_2"));
    await userEvent.click(app.getByRole("button", { name: "Suspend app host" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Suspend" }));
    expect(await app.findByRole("alert")).toHaveTextContent("Apps aren't served on this deployment, so there's no host to suspend. Nothing changed.");
  });

  it("keeps a room's report, kind and all, as it was", async () => {
    answer = { status: 200, body: { report_id: "rpt_1", suspended: true, reason: "impersonation", at: 1 } };
    await show();
    const room = within(item("rpt_1"));
    expect(room.getByRole("link", { name: HANDLE })).toHaveAttribute("href", `/p/${HANDLE}`);
    expect(room.getByText("agt_x")).toBeInTheDocument();
    expect(room.queryByText("App host")).toBeNull();
    expect(room.queryByRole("button", { name: "Suspend app host" })).toBeNull();
    await userEvent.click(room.getByRole("button", { name: "Suspend workroom" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: "/api/v1/moderation/reports/rpt_1/suspend-room", body: { reason: "impersonation" } });
  });

  it("shows a kind it doesn't know as inert text, with no action and no link", async () => {
    await show();
    const other = within(item("rpt_3"));
    expect(other.getByText("Not one this page knows, so it offers no action. Nothing in it is shown as a link.")).toBeInTheDocument();
    expect(other.getByText("javascript:alert(1)").closest("a")).toBeNull();
    expect(other.queryByRole("link")).toBeNull();
    expect(other.queryByRole("button")).toBeNull();
    expect(other.queryByRole("combobox")).toBeNull();
    expect(other.queryByText("agt_y")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it.each([
    ["an app's report with no host", { ...appReport, host: null }],
    ["an app's report whose host isn't one", { ...appReport, host: "evil.example/../x" }],
    ["a room's report with no handle", { ...roomReport, handle: null }],
    ["a null kind", { ...roomReport, kind: null }],
  ])("offers no action for %s", async (_name, odd) => {
    state.reply = { ok: true, data: { reports: [odd], next_cursor: null } };
    await show();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Not one this page knows, so it offers no action. Nothing in it is shown as a link.")).toBeInTheDocument();
  });

  it("says what suspending an app host does only when an app's report is on the page", async () => {
    await show();
    expect(screen.getByText(/stops an app host serving/)).toBeInTheDocument();
    state.reply = { ok: true, data: { reports: [roomReport], next_cursor: null } };
    document.body.innerHTML = "";
    await show();
    expect(screen.queryByText(/app host/)).toBeNull();
    expect(screen.getByText(/Suspending hides a workroom's public page or stops an agent's public claims\./)).toBeInTheDocument();
  });

  it("passes axe with each kind on the page", async () => {
    const { container } = await show();
    await accessible(container);
  });
});

