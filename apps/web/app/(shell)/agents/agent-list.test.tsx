import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { AgentList, MAX_STATUS_READS, type AgentRow } from "./agent-list";
import { announceStatus } from "./model";

const row = (over: Partial<AgentRow> = {}): AgentRow => ({ agent: { id: "agt_1", org_id: "org_1", name: "Code Agent", description: null, created_at: 1, revoked_at: null }, organization: "Acme", canOpen: true, ...over });

describe("the agent list", () => {
  const reads = vi.fn(async (url: string) => (url.endsWith("agt_1") ? Response.json({ id: "agt_1", status: "active" }) : Response.json({ error: { code: "x" } }, { status: 503 })));
  beforeEach(() => {
    setUrl("/agents");
    reads.mockClear();
    vi.stubGlobal("fetch", reads);
  });

  it("names the agent and organization, with its status as text, and opens by link", async () => {
    render(<AgentList rows={[row()]} truncated={false} canConnect />);
    expect(screen.getByRole("link", { name: /Code Agent/ })).toHaveAttribute("href", "/agents?agent=agt_1");
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("reads status once, however often it renders, and a Sheet's newer answer replaces it", async () => {
    const rows = [row()];
    const { rerender } = render(<AgentList rows={rows} truncated={false} canConnect />);
    await screen.findByText("Connected");
    rerender(<AgentList rows={[row()]} truncated={false} canConnect />);
    expect(reads).toHaveBeenCalledTimes(1);
    act(() => announceStatus("agt_1", "disconnecting"));
    expect(screen.getByText("Disconnecting")).toBeInTheDocument();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("caps the reads, and a row it couldn't read says how to find out", async () => {
    const many = Array.from({ length: MAX_STATUS_READS + 2 }, (_, index) => row({ agent: { ...row().agent, id: `agt_x${index}` } }));
    render(<AgentList rows={many} truncated={false} canConnect />);
    await waitFor(() => expect(screen.getAllByText("Open for status")).toHaveLength(many.length));
    expect(reads).toHaveBeenCalledTimes(MAX_STATUS_READS);
  });

  it("a non-admin gets no link and no guessed status, even with revoked_at set", () => {
    render(<AgentList rows={[row({ canOpen: false, agent: { ...row().agent, revoked_at: 5 } })]} truncated={false} canConnect={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/^Disconnect/)).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(screen.getByText("Details are for this organization's admins")).toBeInTheDocument();
  });

  it("the empty state offers only what this viewer can do", () => {
    const { rerender } = render(<AgentList rows={[]} truncated={false} canConnect />);
    expect(screen.getByText(/Add one to give it an identity/)).toBeInTheDocument();
    rerender(<AgentList rows={[]} truncated={false} canConnect={false} />);
    expect(screen.queryByText(/Add one to give it an identity/)).toBeNull();
    expect(screen.getByText(/An organization admin can add one/)).toBeInTheDocument();
  });

  it("says when the list was cut", () => {
    render(<AgentList rows={[row()]} truncated canConnect />);
    expect(screen.getByText(/newest 500/)).toBeInTheDocument();
  });
});
