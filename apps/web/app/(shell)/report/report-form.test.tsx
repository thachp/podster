import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import Report from "./page";
import { ReportForm } from "./report-form";

const HANDLE = `pub_${"a".repeat(32)}`;
const sent: { url: string; key: string | null; body: unknown }[] = [];
let replies: { status: number; body: unknown }[] = [];

beforeEach(() => {
  setUrl(`/report?handle=${HANDLE}`);
  sent.length = 0;
  replies = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, key: new Headers(init.headers).get("idempotency-key"), body: JSON.parse(String(init.body)) });
    const reply = replies.shift() ?? { status: 200, body: { id: "rpt_1", created_at: 1 } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const submit = () => screen.getByRole("button", { name: "Send report" });

describe("reporting a public workroom", () => {
  it("needs a reason, then sends the report with the room's handle", async () => {
    render(<ReportForm handle={HANDLE} />);
    expect(submit()).toBeDisabled();
    expect(screen.getByLabelText("Agent ID (optional)")).toHaveValue("");
    await userEvent.click(screen.getByRole("radio", { name: /Impersonation/ }));
    await userEvent.type(screen.getByLabelText("Agent ID (optional)"), "agt_seen");
    await userEvent.type(screen.getByLabelText("Note (optional)"), "  Claims to be Podster  ");
    await userEvent.click(submit());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ url: "/api/v1/reports", body: { handle: HANDLE, reason: "impersonation", agent_id: "agt_seen", note: "Claims to be Podster" } });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Sent. Podster's operators will look at it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
  });

  it("sends the same request under the same key after a lost answer, and a changed one under a new key", async () => {
    replies = [{ status: 502, body: {} }, { status: 502, body: {} }];
    render(<ReportForm handle={HANDLE} />);
    await userEvent.click(screen.getByRole("radio", { name: /Spam/ }));
    await userEvent.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't tell whether this was sent/);
    await userEvent.click(submit());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.key).toBe(sent[0]?.key);
    await userEvent.click(screen.getByRole("radio", { name: /Abuse/ }));
    await userEvent.click(submit());
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]?.key).not.toBe(sent[0]?.key);
  });

  it.each([
    [409, /still can't tell whether this was sent\. Reload/],
    [401, /signed out, so we still can't tell/],
    [429, /Too many requests, so we still can't tell/],
  ])("never says nothing was sent when a retry after a lost answer gets a %i", async (status, text) => {
    replies = [{ status: 502, body: {} }, { status, body: { error: { code: "limit_exceeded" } } }];
    render(<ReportForm handle={HANDLE} />);
    await userEvent.click(screen.getByRole("radio", { name: /Spam/ }));
    await userEvent.click(submit());
    await screen.findByText(/can't tell whether this was sent/);
    await userEvent.click(submit());
    await waitFor(() => expect(sent).toHaveLength(2));
    const alert = await screen.findByText(text);
    expect(alert).not.toHaveTextContent(/Nothing was sent/);
  });

  it.each([
    [404, "workspace_not_found", /isn't public now/],
    [409, "limit_exceeded", /10 reports today/],
    [422, "idempotency_mismatch", /may already have been sent/],
  ])("explains a %i %s", async (status, code, text) => {
    replies = [{ status, body: { error: { code } } }];
    render(<ReportForm handle={HANDLE} />);
    await userEvent.click(screen.getByRole("radio", { name: /Privacy/ }));
    await userEvent.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("checks an agent ID and the note's length before sending", async () => {
    render(<ReportForm handle={HANDLE} />);
    await userEvent.click(screen.getByRole("radio", { name: /Other|Something else/ }));
    await userEvent.type(screen.getByLabelText("Agent ID (optional)"), "bob");
    expect(screen.getByText(/isn't an agent ID/)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Agent ID (optional)"));
    await userEvent.click(screen.getByLabelText("Note (optional)"));
    await userEvent.paste("x".repeat(1025));
    expect(screen.getByText(/That's too long/)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it("prefills only the handle, never an agent from the link", async () => {
    render((await Report({ searchParams: Promise.resolve({ handle: HANDLE, agent: "agt_framed" } as { handle: string }) })) as ReactElement);
    expect(screen.getByLabelText("Agent ID (optional)")).toHaveValue("");
  });

  it("offers nothing to send without a valid handle", async () => {
    render((await Report({ searchParams: Promise.resolve({ handle: "pub_nope" }) })) as ReactElement);
    expect(screen.getByRole("alert")).toHaveTextContent(/no workroom to report here/);
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
  });
});
