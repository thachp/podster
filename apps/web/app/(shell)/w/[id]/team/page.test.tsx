import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";

const OFF = { ok: false, status: 404, code: "not_found" };
const state = vi.hoisted(() => ({ room: null as unknown, asked: [] as string[], grants: null as unknown, repository: null as unknown }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    if (path === "/api/v1/workspaces/ws_1") return { ok: true, data: state.room };
    if (path === "/api/v1/workspaces/ws_1/repository/grants") return state.grants;
    if (path === "/api/v1/workspaces/ws_1/repository") return state.repository;
    if (path === "/api/agents") return { ok: true, data: { agents: [] } };
    if (path.endsWith("/invitations")) return { ok: true, data: { invitations: [], truncated: false } };
    if (path.endsWith("/roles")) return { ok: true, data: { roles: [], external: false } };
    return { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => ({ ok: true, data: { id: "per_owner", org_id: "org_a", orgs: ["org_a"], admin_orgs: [] } }),
  getOrganizations: async () => ({ ok: true, data: { organizations: [] } }),
  rateLimited: async () => {
    throw new Error("rate limited");
  },
  signInPath: (next: string) => `/sign-in?next=${next}`,
}));

const { default: Team } = await import("./page");
const show = async () => render((await Team({ params: Promise.resolve({ id: "ws_1" }) })) as ReactElement);
const grant = { id: "pg_1", principal_id: "agt_1", action: "push", delegated_by: "per_owner", created_at: 1, expires_at: null, revoked_at: null, state: "live" };

describe("repository access on Team", () => {
  beforeEach(() => {
    setUrl("/w/ws_1/team");
    state.asked.length = 0;
    state.room = { id: "ws_1", name: "Launch room", owner: "per_owner", owner_org: "org_a", status: "active", policy_version: 3, members: [{ principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" }] };
    state.grants = OFF;
    state.repository = OFF;
  });

  it("shows nothing about repositories while they're off, and spends one read learning that", async () => {
    await show();
    expect(screen.queryByText("Repository access")).toBeNull();
    expect(screen.queryByText(/repository/i)).toBeNull();
    expect(state.asked.filter((path) => path.includes("/repository"))).toEqual(["/api/v1/workspaces/ws_1/repository"]);
  });

  it("never reads the grants while off, so a failing grants read can't add a heading", async () => {
    state.grants = { ok: false, status: 500, code: "error" };
    await show();
    expect(screen.queryByText("Repository access")).toBeNull();
    expect(state.asked).not.toContain("/api/v1/workspaces/ws_1/repository/grants");
  });

  it("shows nothing when neither read can say whether the feature is on", async () => {
    state.repository = { ok: false, status: 429, code: "rate_limited" };
    state.grants = { ok: false, status: 500, code: "error" };
    await show();
    expect(screen.queryByText("Repository access")).toBeNull();
  });

  it("says it couldn't refresh the grants once the feature is known to be on", async () => {
    state.repository = { ok: true, data: { request: null, repository: null } };
    state.grants = { ok: false, status: 500, code: "error" };
    await show();
    expect(screen.getByRole("heading", { name: "Repository access" })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't refresh/)).toBeInTheDocument();
  });

  it("takes a refused repository read as on, for someone who doesn't see the whole room, and shows their own grant", async () => {
    state.repository = { ok: false, status: 403, code: "not_allowed" };
    state.grants = { ok: true, data: { grants: [grant] } };
    await show();
    expect(screen.getByRole("heading", { name: "Repository access" })).toBeInTheDocument();
  });

  it("shows nothing while on with no repository and no grants", async () => {
    state.grants = { ok: true, data: { grants: [] } };
    state.repository = { ok: true, data: { request: null, repository: null, delegated: true } };
    await show();
    expect(screen.queryByText("Repository access")).toBeNull();
  });

  it("shows the grants and the owner's form once the room has a repository", async () => {
    state.grants = { ok: true, data: { grants: [grant] } };
    state.repository = { ok: true, data: { request: null, repository: { id: "rl_1", provider: "github", provider_repo_id: 1, full_name: "podsterdev/x", visibility: "public", default_branch: "main", status: "ready", status_reason: null, created_at: 1, verified_at: 1, updated_at: 1 } } };
    await show();
    expect(screen.getByRole("heading", { name: "Repository access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take back" })).toBeInTheDocument();
  });
});
