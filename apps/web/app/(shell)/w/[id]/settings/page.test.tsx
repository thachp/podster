import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { boundaryProblems, clientComponents } from "@/test/client-boundary";

const state = vi.hoisted(() => ({ room: null as unknown, me: "per_owner", asked: [] as string[], repository: { ok: false, status: 404, code: "not_found" } as unknown, release: { ok: false, status: 404, code: "not_found" } as unknown, hostname: { ok: true, data: { request: null } } as unknown, visibility: { ok: false, status: 404, code: "not_found" } as unknown }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    if (path === "/api/v1/workspaces/ws_1") return { ok: true, data: state.room };
    if (path.includes("/audit")) return { ok: true, data: { audit: [], next_cursor: null } };
    if (path === "/api/v1/workspaces/ws_1/repository") return state.repository;
    if (path === "/api/v1/workspaces/ws_1/release-config") {
      if (state.release === "throw") throw new Error("connection lost");
      return state.release;
    }
    if (path === "/api/v1/workspaces/ws_1/app-hostname") {
      if (state.hostname === "throw") throw new Error("connection lost");
      return state.hostname;
    }
    if (path === "/api/v1/workspaces/ws_1/visibility") return state.visibility;
    if (path === "/api/orgs/org_a/members") return { ok: true, data: { members: [{ person_id: "per_heir", name: "Heir" }] } };
    return { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => ({ ok: true, data: { id: state.me, org_id: "org_a", orgs: ["org_a"], admin_orgs: [] } }),
  getOrganizations: async () => ({ ok: true, data: { organizations: [{ id: "org_a", name: "Acme", personal: 0, role: "admin" }] } }),
  signInPath: (next: string) => `/sign-in?next=${next}`,
}));

const { default: Settings } = await import("./page");
const page = () => Settings({ params: Promise.resolve({ id: "ws_1" }), searchParams: Promise.resolve({}) });
const show = async () => render((await page()) as ReactElement);
const member = (principal_id: string, kind: string, role: string, org_id = "org_a") => ({ principal_id, kind, role, org_id });

describe("workroom settings' ownership section", () => {
  beforeEach(() => {
    setUrl("/w/ws_1/settings");
    state.me = "per_owner";
    state.asked.length = 0;
    state.repository = { ok: false, status: 404, code: "not_found" };
    state.room = {
      id: "ws_1",
      name: "Launch room",
      owner: "per_owner",
      owner_org: "org_a",
      status: "active",
      policy_version: 3,
      members: [member("per_heir", "person", "admin"), member("per_plain", "person", "member"), member("agt_admin", "agent", "admin"), member("per_outside", "person", "admin", "org_b")],
    };
  });

  it("offers only human admins in the workroom's organization, by name and ID", async () => {
    await show();
    const offered = screen.getAllByRole("option").map((option) => option.textContent);
    expect(offered).toEqual(["Choose an admin", "per_heir · Heir"]);
  });

  it("shows IDs if the names can't be read", async () => {
    (state.room as { members: unknown[] }).members = [member("per_unnamed", "person", "admin")];
    await show();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose an admin", "per_unnamed"]);
  });

  it("doesn't spend a read on names for someone who can't transfer", async () => {
    state.me = "per_heir";
    await show();
    expect(screen.queryByLabelText("New owner")).toBeNull();
    expect(screen.getByText("Only this workroom's owner can transfer it.")).toBeInTheDocument();
    expect(state.asked).not.toContain("/api/orgs/org_a/members");
  });

  it("says when the owner has left", async () => {
    state.me = "per_heir";
    (state.room as { owner_left_at: number }).owner_left_at = Date.UTC(2026, 10, 3);
    await show();
    expect(screen.getByText(/The owner left this workroom's organization on 2026-11-03/)).toBeInTheDocument();
  });
});

describe("workroom settings' repository section", () => {
  beforeEach(() => {
    setUrl("/w/ws_1/settings");
    state.me = "per_owner";
    state.asked.length = 0;
    state.room = { id: "ws_1", name: "Launch room", owner: "per_owner", owner_org: "org_a", status: "active", policy_version: 3, members: [] };
  });

  it("with managed repositories off, is as it was before them, after the one read that says so", async () => {
    state.repository = { ok: false, status: 404, code: "not_found" };
    await show();
    expect(screen.getByRole("heading", { name: "Repository and release" })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Repository" })).toBeNull();
    expect(screen.queryByLabelText("Repository name")).toBeNull();
    expect(state.asked.filter((path) => path.includes("/repository"))).toEqual(["/api/v1/workspaces/ws_1/repository"]);
  });

  it("with them on, shows the repository section in place of that", async () => {
    state.repository = { ok: true, data: { request: null, repository: null, delegated: true } };
    await show();
    expect(screen.getByRole("heading", { name: "Repository" })).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.getByLabelText("Repository name")).toBeInTheDocument();
  });

  it("offers an admin who isn't the owner the same form", async () => {
    state.me = "per_admin";
    (state.room as { members: unknown[] }).members = [member("per_admin", "person", "admin")];
    state.repository = { ok: true, data: { request: null, repository: null, delegated: true } };
    await show();
    expect(screen.getByLabelText("Repository name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a repository" })).toBeInTheDocument();
    expect(screen.queryByText(/Only this workroom's owner and admins can create its repository/)).toBeNull();
  });

  it("offers a recorded owner who left the organization nothing to ask with", async () => {
    state.repository = { ok: true, data: { request: null, repository: null } };
    (state.room as { owner_left_at: number }).owner_left_at = 1;
    await show();
    expect(screen.queryByLabelText("Repository name")).toBeNull();
  });

  it("says it couldn't read the section when the read fails, rather than calling it off", async () => {
    state.repository = { ok: false, status: 500, code: "error" };
    await show();
    expect(screen.getByRole("heading", { name: "Repository" })).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).toBeNull();
  });
});

describe("workroom settings' release section", () => {
  const releaseConfig = (over: object = {}) => ({ enabled: false, approval_policy: "person", environments: ["production"], default_host: null, custom_host: null, version: 2, set_by: null, updated_at: null, ...over });
  const visibilityRead = (visibility: "public" | "private") => ({
    ok: true,
    data: { visibility, public_handle: null, published_at: null, published_on: null, topic: null, public_claims_paused: false, suspension: null, public_rooms_enabled: true, view_hash: "a".repeat(64), preview: { archived: false, context: null, goal: null, name: "Launch room", openings: [], outputs: [], participant_count: 1, person_review: true, topic: null, workflow: "general" } },
  });
  const readyRepository = { ok: true, data: { request: null, repository: { id: "rl_1", provider: "github", provider_repo_id: 1, full_name: "podsterdev/x", visibility: "public", default_branch: "main", status: "ready", status_reason: null, created_at: 1, verified_at: 1, updated_at: 1 }, delegated: true } };

  beforeEach(() => {
    setUrl("/w/ws_1/settings");
    state.me = "per_owner";
    state.asked.length = 0;
    state.room = { id: "ws_1", name: "Launch room", owner: "per_owner", owner_org: "org_a", status: "active", policy_version: 3, members: [] };
    state.repository = { ok: false, status: 404, code: "not_found" };
    state.release = { ok: false, status: 404, code: "not_found" };
    state.hostname = { ok: true, data: { request: null } };
    state.visibility = visibilityRead("private");
  });

  it("with release switched off, as on every deployment today, shows it as Unavailable rather than an error, and reads no custom domain", async () => {
    state.repository = readyRepository;
    await show();
    const section = screen.getByRole("region", { name: "Release" });
    expect(section).toHaveTextContent("Unavailable");
    expect(section).toHaveTextContent("Release isn't available on this Podster deployment");
    expect(screen.queryByText("Couldn't refresh.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch release/ })).toBeNull();
    expect(state.asked).toContain("/api/v1/workspaces/ws_1/release-config");
    expect(state.asked).not.toContain("/api/v1/workspaces/ws_1/app-hostname");
  });

  it("with repositories and release both off, keeps the one section it had before them", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Repository and release" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Release" })).toBeNull();
  });

  it("with release on, a private room's owner sees Needs approval with the reason, and the custom domain is read", async () => {
    state.repository = readyRepository;
    state.release = { ok: true, data: releaseConfig() };
    await show();
    const section = screen.getByRole("region", { name: "Release" });
    expect(section).toHaveTextContent("Needs approval");
    expect(section).toHaveTextContent("The workroom has to be public.");
    expect(screen.getByRole("button", { name: "Switch release on" })).toHaveAttribute("aria-disabled", "true");
    expect(state.asked).toContain("/api/v1/workspaces/ws_1/app-hostname");
  });

  it("with release on, a public room with a ready repository is Not configured until switched on, then Ready", async () => {
    state.repository = readyRepository;
    state.visibility = visibilityRead("public");
    state.release = { ok: true, data: releaseConfig() };
    const first = await show();
    expect(screen.getByRole("region", { name: "Release" })).toHaveTextContent("Not configured");
    expect(screen.getByRole("button", { name: "Switch release on" })).toBeEnabled();
    first.unmount();
    state.release = { ok: true, data: releaseConfig({ enabled: true }) };
    await show();
    expect(screen.getByRole("region", { name: "Release" })).toHaveTextContent("Ready");
    expect(screen.getByRole("button", { name: "Switch release off" })).toBeInTheDocument();
  });

  it("a release read that fails says so, rather than Unavailable", async () => {
    state.repository = readyRepository;
    state.release = { ok: false, status: 500, code: "error" };
    await show();
    const section = screen.getByRole("region", { name: "Release" });
    expect(section).toHaveTextContent("Couldn't refresh.");
    expect(section).not.toHaveTextContent("Unavailable");
  });
  it("reads 409 release_not_available as Unavailable, like the 404", async () => {
    state.repository = readyRepository;
    state.release = { ok: false, status: 409, code: "release_not_available" };
    await show();
    expect(screen.getByRole("region", { name: "Release" })).toHaveTextContent("Unavailable");
    expect(state.asked).not.toContain("/api/v1/workspaces/ws_1/app-hostname");
  });

  it("a release read that throws fails only its own section, and the page still renders", async () => {
    state.repository = readyRepository;
    state.release = "throw";
    await show();
    const section = screen.getByRole("region", { name: "Release" });
    expect(section).toHaveTextContent("Couldn't refresh.");
    expect(section).not.toHaveTextContent("Unavailable");
    expect(screen.getByRole("heading", { name: "Ownership" })).toBeInTheDocument();
  });

  it("a hostname read that throws fails only the custom domain", async () => {
    state.repository = readyRepository;
    state.release = { ok: true, data: releaseConfig({ enabled: true }) };
    state.hostname = "throw";
    await show();
    const section = screen.getByRole("region", { name: "Release" });
    expect(section).toHaveTextContent("Ready");
    expect(section).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByLabelText("Hostname")).toBeNull();
  });

  it("an admin who is a person is offered the controls; a member, or an owner who left the organization, sees the state and none", async () => {
    state.repository = readyRepository;
    state.visibility = visibilityRead("public");
    state.release = { ok: true, data: releaseConfig() };
    state.me = "per_admin";
    (state.room as { members: unknown[] }).members = [member("per_admin", "person", "admin"), member("per_member", "person", "member")];
    const admin = await show();
    expect(screen.getByRole("button", { name: "Switch release on" })).toBeInTheDocument();
    admin.unmount();
    state.me = "per_member";
    const plain = await show();
    const section = screen.getByRole("region", { name: "Release" });
    expect(section).toHaveTextContent("Not configured");
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByLabelText("Hostname")).toBeNull();
    expect(section).toHaveTextContent("Only this workroom's owner and admins can change release.");
    plain.unmount();
    state.me = "per_owner";
    (state.room as { owner_left_at: number }).owner_left_at = 1;
    await show();
    expect(within(screen.getByRole("region", { name: "Release" })).queryByRole("button")).toBeNull();
  });

  it("names who last changed release from the viewer's organizations, and never shows a bare ID", async () => {
    state.repository = readyRepository;
    state.release = { ok: true, data: releaseConfig({ enabled: true, set_by: "per_heir", updated_at: Date.UTC(2026, 10, 12) }) };
    await show();
    expect(screen.getByText("2026-11-12 by Heir")).toBeInTheDocument();
    expect(state.asked).toContain("/api/orgs/org_a/members");
  });
  // Rendering in jsdom never serializes a client component's props, so a function prop passes here and fails for real
  // with a 500. This walks what the page returns, as React would send it, for each state that renders the section.
  it("sends its client components only props React can serialize, in every release state", async () => {
    const clients = await clientComponents();
    state.repository = readyRepository;
    state.hostname = { ok: true, data: { request: { id: "hr_1", hostname: "app.example.com", state: "pending", challenge_name: "_podster-challenge.app.example.com", challenge_value: "v", requested_by: "per_heir", requested_at: 1, expires_at: 2, end_reason: null } } };
    for (const release of [{ ok: false, status: 404, code: "not_found" }, { ok: true, data: releaseConfig() }, { ok: true, data: releaseConfig({ enabled: true, set_by: "per_heir", updated_at: 1 }) }, { ok: false, status: 500, code: "error" }]) {
      state.release = release;
      expect(boundaryProblems(await page(), clients)).toEqual([]);
    }
  });
});
