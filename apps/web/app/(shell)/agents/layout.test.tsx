import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";

const reads = vi.hoisted(() => ({ identity: null as unknown, directory: null as unknown }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async () => reads.directory,
  getIdentity: async () => reads.identity,
  getOrganizations: async () => ({ ok: true, data: { organizations: [{ id: "org_1", name: "Acme", personal: 0, role: "admin" }] } }),
}));

const { default: AgentsLayout } = await import("./layout");

const AGENT = { id: "agt_1", org_id: "org_1", name: "Code Agent", description: null, created_at: 1, revoked_at: null };
const show = async () => render((await AgentsLayout({ children: null })) as ReactElement);

describe("the agents layout", () => {
  beforeEach(() => {
    setUrl("/agents");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "agt_1", status: "active" })));
    reads.directory = { ok: true, data: { agents: [AGENT], truncated: false } };
  });

  it("when the API can't say who's an admin, an admin isn't told they aren't one", async () => {
    reads.identity = { ok: false, status: 503, code: "error" };
    await show();
    expect(screen.getByRole("link", { name: /Code Agent/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add an agent" })).toHaveAttribute("href", "/agents/connect");
    expect(screen.queryByText("Connect an agent")).toBeNull();
    expect(screen.queryByText("Details are for this organization's admins")).toBeNull();
  });

  it("someone known not to be an admin gets no link and no Add an agent", async () => {
    reads.identity = { ok: true, data: { id: "per_1", org_id: "org_1", orgs: ["org_1"], admin_orgs: [], inbox_unread: 0 } };
    await show();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Details are for this organization's admins")).toBeInTheDocument();
  });

  it("a failed directory read isn't an empty list", async () => {
    reads.identity = { ok: true, data: { id: "per_1", org_id: "org_1", orgs: ["org_1"], admin_orgs: ["org_1"], inbox_unread: 0 } };
    reads.directory = { ok: false, status: 503, code: "error" };
    await show();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh");
    expect(screen.queryByText(/no agents yet/)).toBeNull();
  });
});
