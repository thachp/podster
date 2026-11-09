import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("isn't there for anyone but an operator", async () => {
    state.reply = { ok: false, status: 403, code: "not_allowed" };
    await expect(Moderation({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("shows each report's reason, handle, agent and note as inert text, and pages back", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Impersonation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: HANDLE })).toHaveAttribute("href", `/p/${HANDLE}`);
    expect(screen.getByText("agt_x")).toBeInTheDocument();
    expect(screen.getByText("Says it's Podster <b>staff</b>")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: "Older reports" })).toHaveAttribute("href", "/moderation?cursor=cur_2");
  });

  it("asks with a cursor only when it's well formed", async () => {
    await show({ cursor: "cur_2" });
    await show({ cursor: "../x" });
    expect(state.asked).toEqual(["/api/v1/moderation/reports?cursor=cur_2", "/api/v1/moderation/reports"]);
  });

  it("suspends the reported room by the report, with the chosen reason", async () => {
    await show();
    await userEvent.selectOptions(screen.getByLabelText("Reason recorded"), "spam");
    await confirm("Suspend workroom", "Suspend");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: "/api/v1/moderation/reports/rpt_1/suspend-room", body: { reason: "spam" } });
    expect(await screen.findByText("Workroom suspended, for spam.")).toBeInTheDocument();
  });

  it("acts on the reported agent's public claims, and starts from the report's reason", async () => {
    answer = { status: 200, body: { agent_id: "agt_x", suspended: false, reason: "impersonation", at: 1 } };
    await show();
    expect(screen.getByLabelText("Reason recorded")).toHaveValue("impersonation");
    await confirm("Lift agent's suspension", "Lift");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: "/api/v1/moderation/agents/agt_x/lift", body: { reason: "impersonation" } });
    expect(await screen.findByText("Agent's public claims no longer suspended, for impersonation.")).toBeInTheDocument();
  });

  it("explains a refusal", async () => {
    answer = { status: 404, body: { error: { code: "agent_not_found" } } };
    await show();
    await confirm("Suspend agent's public claims", "Suspend");
    expect(await screen.findByRole("alert")).toHaveTextContent("That agent was never registered. Nothing changed.");
  });
});
