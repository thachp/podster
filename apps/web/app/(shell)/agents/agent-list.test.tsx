import { act, render, screen, waitFor, within } from "@testing-library/react";
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

  describe("disconnected agents", () => {
    const named = (id: string, name: string, revoked_at: number | null = null) => row({ agent: { ...row().agent, id, name, revoked_at } });
    const answers: Record<string, string> = { agt_on: "active", agt_old: "disconnected", agt_going: "disconnecting" };
    const byStatus = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      return answers[id] ? Response.json({ id, status: answers[id] }) : Response.json({ error: { code: "x" } }, { status: 503 });
    });
    beforeEach(() => {
      byStatus.mockClear();
      vi.stubGlobal("fetch", byStatus);
    });
    const main = () => screen.getAllByRole("list")[0];
    const section = () => screen.getByText(/^Disconnected \(\d+\)$/).closest("details") as HTMLDetailsElement;

    it("keeps connected, disconnecting and unknown agents in the main list, and tucks disconnected ones into a closed section with a count", async () => {
      render(<AgentList rows={[named("agt_on", "Gigi"), named("agt_going", "Rex", 3), named("agt_unknown", "Ivy"), named("agt_old", "Gigi", 2)]} truncated={false} canConnect />);
      expect(await screen.findByText("Disconnected (1)")).toBeInTheDocument();
      expect(section().open).toBe(false);
      expect(within(main()).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/agents?agent=agt_on", "/agents?agent=agt_going", "/agents?agent=agt_unknown"]);
      expect(within(main()).getByText("Open for status")).toBeInTheDocument();
      expect(within(section()).getByRole("link", { name: /Gigi/ })).toHaveAttribute("href", "/agents?agent=agt_old");
      expect(within(section()).getByText("Disconnected")).toBeInTheDocument();
    });

    it("never hides an agent before its status is read, nor one a non-admin can't open", () => {
      render(<AgentList rows={[named("agt_old", "Gigi", 2), row({ canOpen: false, agent: { ...row().agent, id: "agt_other", revoked_at: 2 } })]} truncated={false} canConnect />);
      expect(within(main()).getAllByRole("listitem")).toHaveLength(2);
      expect(screen.queryByText(/^Disconnected \(/)).toBeNull();
    });

    it("counts every disconnected agent, and a Sheet's newer answer moves a row either way", async () => {
      answers.agt_old2 = "disconnected";
      render(<AgentList rows={[named("agt_on", "Gigi"), named("agt_old", "Gigi", 2), named("agt_old2", "Old", 1)]} truncated={false} canConnect />);
      expect(await screen.findByText("Disconnected (2)")).toBeInTheDocument();
      act(() => announceStatus("agt_old", "active"));
      expect(screen.getByText("Disconnected (1)")).toBeInTheDocument();
      expect(within(main()).getAllByRole("link").map((link) => link.getAttribute("href"))).toContain("/agents?agent=agt_old");
      act(() => announceStatus("agt_on", "disconnected"));
      expect(screen.getByText("Disconnected (2)")).toBeInTheDocument();
      delete answers.agt_old2;
    });

    it("spends the capped reads on agents the directory marks first, so an old disconnected one still moves", async () => {
      const newer = Array.from({ length: MAX_STATUS_READS }, (_, index) => named(`agt_new${index}`, `New ${index}`));
      render(<AgentList rows={[...newer, named("agt_old", "Gigi", 2)]} truncated={false} canConnect />);
      expect(await screen.findByText("Disconnected (1)")).toBeInTheDocument();
      expect(byStatus).toHaveBeenCalledTimes(MAX_STATUS_READS);
      expect(byStatus.mock.calls[0][0]).toMatch(/agt_old$/);
    });
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
