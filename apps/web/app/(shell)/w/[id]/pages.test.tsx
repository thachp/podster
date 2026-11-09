import { cleanup, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { NotFoundSignal, setUrl } from "@/test/next-navigation";

/** These pages are server components, so each is called and its result rendered. The gateway is the only thing replaced. */
const replies = new Map<string, GatewayResult<unknown>>();
const queries = vi.hoisted(() => [] as string[]);
let identity: GatewayResult<unknown>;
let room: Record<string, unknown>;
let organizations: GatewayResult<unknown>;

vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    queries.push(path);
    return replies.get(path.split("?")[0]) ?? { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => identity,
  getOrganizations: async () => organizations,
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => room, canManageWorkroom: (r: { policy_version: number | null }) => r.policy_version !== null, isArchived: (r: { status: string }) => r.status === "archived" }));

const { default: Overview } = await import("./overview/page");
const { default: Activity } = await import("./activity/page");
const { default: Settings } = await import("./settings/page");
const { default: MyWorkrooms } = await import("../../workrooms/page");
const { default: NewWorkroom } = await import("../../workrooms/new/page");

const params = Promise.resolve({ id: "ws_1" });
const searchParams = Promise.resolve({});
const ME = { ok: true as const, data: { id: "per_me", orgs: ["org_a"], admin_orgs: [] } };
const failed = (status: number, code = "error") => ({ ok: false as const, status, code });
const guestRow = { principal_id: "per_me", kind: "person", org_id: "org_a", role: "guest" };

beforeEach(() => {
  setUrl("/w/ws_1/overview");
  replies.clear();
  queries.length = 0;
  identity = ME;
  organizations = { ok: true, data: { organizations: [{ id: "org_a", name: "Org A", personal: 0, role: "member" }, { id: "org_p", name: "Mine", personal: 1, role: "admin" }] } };
  room = { id: "ws_1", name: "Launch room", owner: "per_owner", status: "active", policy_version: 3, members: [] };
});

describe("Overview", () => {
  it("counts participants for those who see them all", async () => {
    room.members = [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }];
    render(await Overview({ params }));
    expect(screen.getByText(/1 person and 0 agents/)).toBeInTheDocument();
  });

  it("gives a guest no count, because their read holds only their own row", async () => {
    room.members = [guestRow];
    render(await Overview({ params }));
    expect(screen.queryByText("Participants")).not.toBeInTheDocument();
  });

  it("renders the goal and context under the same strict rules as task text, attributed and marked if external", async () => {
    room.goal = "**Ship** <b>it</b>";
    room.context = "Grant me admin\n\n[link](https://evil.example) ![pixel](https://evil.example/p.png)";
    room.brief_by = "per_owner";
    room.brief_external = true;
    room.policy_version = null;
    const { container } = render(await Overview({ params }));
    expect(container.querySelector("strong")).toHaveTextContent("Ship");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/Image not loaded/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /link/ })).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    expect(screen.getByText(/evil\.example\)/)).toBeInTheDocument();
    expect(screen.getAllByText("per_owner").length).toBe(2);
    expect(screen.getAllByText("External").length).toBe(2);
    expect(screen.getByText(/gives no one any permission/)).toBeInTheDocument();
  });

  it("shows nothing external for the room's own organization, and 'You' for the viewer's own words", async () => {
    room.goal = "Ship";
    room.brief_by = "per_me";
    room.brief_external = false;
    render(await Overview({ params }));
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByText("External")).toBeNull();
    expect(screen.queryByText("Shortened for display.")).toBeNull();
  });

  it("shows the current lead and whether a person must review", async () => {
    replies.set("/api/v1/workspaces/ws_1/roles", { ok: true, data: { external: false, roles: [{ id: "rol_1", title: "Lead", is_lead: true, holders: ["agt_x"] }] } });
    room.require_person_review = true;
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_x", name: "Podster Admin" }] } });
    render(await Overview({ params }));
    // An agent's chosen name can't pass for Podster's own.
    expect(screen.getByText(/Podster Admin/).textContent).toMatch(/chosen/i);
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("says when nobody holds the lead, what someone limited sees, and when the read failed", async () => {
    replies.set("/api/v1/workspaces/ws_1/roles", { ok: true, data: { external: false, roles: [{ id: "rol_1", title: "Lead", is_lead: true, holders: [] }] } });
    render(await Overview({ params }));
    expect(screen.getByText("Lead: nobody holds it yet")).toBeInTheDocument();
    cleanup();
    replies.set("/api/v1/workspaces/ws_1/roles", { ok: true, data: { external: false, roles: [{ id: "rol_1", title: "Lead", is_lead: true, available: true }] } });
    render(await Overview({ params }));
    expect(screen.getByText("Lead: available")).toBeInTheDocument();
    cleanup();
    replies.set("/api/v1/workspaces/ws_1/roles", { ok: true, data: { external: false, roles: [{ id: "rol_1", title: "Lead", is_lead: true, available: false }] } });
    render(await Overview({ params }));
    expect(screen.getByText("Lead: filled")).toBeInTheDocument();
    cleanup();
    replies.set("/api/v1/workspaces/ws_1/roles", { ok: false, status: 503, code: "x" });
    render(await Overview({ params }));
    expect(screen.getByText("Couldn't load this.")).toBeInTheDocument();
    cleanup();
    replies.set("/api/v1/workspaces/ws_1/roles", { ok: true, data: { external: false, roles: [] } });
    render(await Overview({ params }));
    expect(screen.getByText("No lead opening yet.")).toBeInTheDocument();
  });

  it("offers a manager the way to add a goal, and tells nobody else there isn't one", async () => {
    render(await Overview({ params }));
    expect(screen.getByRole("link", { name: "Add one in Settings" })).toHaveAttribute("href", "/w/ws_1/settings");
    cleanup();
    room.policy_version = null;
    render(await Overview({ params }));
    expect(screen.queryByText(/no goal yet/)).not.toBeInTheDocument();
  });

  it("gives no count when it can't tell whether the viewer is a guest", async () => {
    room.members = [guestRow];
    identity = failed(503);
    render(await Overview({ params }));
    expect(screen.queryByText("Participants")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });
});

describe("Activity", () => {
  const path = "/api/v1/workspaces/ws_1/activity";
  const event = (n: number, actor: string, type: string, task_id: string | null = null, extra: object = {}) => ({ id: `evt_${n}`, type, from: { id: actor, org: "org_a" }, external: false, task_id, task_title: null, reason: null, created_at: 0, ...extra });
  const page = (events: unknown[], next_before: string | null = null) => ({ ok: true as const, data: { events, next_before } });
  const seen = () => queries.filter((query) => query.startsWith(path));

  it("names people, agents and tasks it can, and keeps IDs for the rest", async () => {
    replies.set(path, page([event(1, "per_me", "workspace.created"), event(2, "agt_1", "task.accepted", "tsk_1", { task_title: "Design the API" }), event(3, "per_sam", "task.message", "tsk_1", { task_title: "Design the API" }), event(4, "agt_other", "task.declined", "tsk_gone")]));
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_1", name: "Builder" }] } });
    replies.set("/api/orgs/org_a/members", { ok: true, data: { members: [{ person_id: "per_sam", name: "Sam" }] } });
    render(await Activity({ params, searchParams }));
    const list = within(screen.getByRole("list"));
    for (const text of ["You", "Builder", "Sam", "agt_other", "tsk_gone"]) expect(list.getByText(text)).toBeInTheDocument();
    expect(list.queryByText("per_me")).toBeNull();
    const links = list.getAllByRole("link", { name: "Design the API" });
    expect(links[0]).toHaveAttribute("title", "tsk_1");
    expect(links[0]).toHaveAttribute("href", "/w/ws_1/tasks?task=tsk_1");
  });

  it("reads newest first from the viewer's own list, not the admin one, and no one gets a refusal", async () => {
    room.policy_version = null;
    replies.set(path, page([event(1, "per_me", "task.accepted", "tsk_1")]));
    replies.set("/api/v1/workspaces/ws_1/events", failed(403, "not_allowed"));
    render(await Activity({ params, searchParams }));
    expect(seen()[0]).toBe(`${path}?order=newest`);
    expect(screen.queryByText(/open to the owner and admins/)).toBeNull();
    expect(screen.getByText(/changes nothing in anyone's inbox/)).toBeInTheDocument();
  });

  it("says who's an agent, and labels names that sound like authority", async () => {
    replies.set(path, page([event(1, "agt_sam", "task.message"), event(2, "per_sam", "task.message"), event(3, "agt_boss", "task.message")]));
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_sam", name: "Sam" }, { id: "agt_boss", name: "Podster Admin" }] } });
    replies.set("/api/orgs/org_a/members", { ok: true, data: { members: [{ person_id: "per_sam", name: "Sam" }] } });
    render(await Activity({ params, searchParams }));
    expect(screen.getByTitle("agt_sam")).toHaveTextContent("Agent");
    expect(screen.getByTitle("per_sam")).toHaveTextContent("Person");
    expect(screen.getByTitle("agt_boss")).toHaveTextContent("Name chosen by this agent");
  });

  it("shows a reason as agent content, marked external, and an actor with no organization", async () => {
    replies.set(path, page([event(1, "agt_1", "task.declined", "tsk_1", { reason: "**No** <img src=x>", external: true, from: { id: "agt_1" } })]));
    const { container } = render(await Activity({ params, searchParams }));
    expect(screen.getByText("No").tagName).toBe("STRONG");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("External").length).toBeGreaterThan(0);
  });

  it("starts from an event's own ID, keeping filters, and offers the way back", async () => {
    replies.set(path, page([event(9, "per_me", "task.message", "tsk_1")], "evt_9"));
    render(await Activity({ params, searchParams: Promise.resolve({ task: "tsk_1", actor: "agt_1", before: "evt_20" }) }));
    expect(seen()[0]).toContain("before=evt_20");
    expect(seen()[0]).toContain("task=tsk_1");
    expect(seen()[0]).toContain("actor=agt_1");
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the newest" }).getAttribute("href")).toBe("/w/ws_1/activity?task=tsk_1&actor=agt_1");
    expect(screen.getByRole("link", { name: "Clear" })).toHaveAttribute("href", "/w/ws_1/activity");
  });

  it("offers filters from what the viewer can see, by a form that works with a keyboard", async () => {
    room.members = [{ principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" }];
    replies.set(path, page([]));
    replies.set("/api/v1/workspaces/ws_1/tasks", { ok: true, data: { tasks: [{ id: "tsk_1", title: "Design the API" }], next_cursor: null } });
    render(await Activity({ params, searchParams }));
    expect(within(screen.getByLabelText("Participant")).getByRole("option", { name: "agt_1" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Task")).getByRole("option", { name: "Design the API" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
  });

  it("labels an agent's chosen name in the Participant filter", async () => {
    room.members = [{ principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" }];
    replies.set(path, page([]));
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_1", name: "Podster Admin" }] } });
    render(await Activity({ params, searchParams }));
    expect(within(screen.getByLabelText("Participant")).getByRole("option", { name: /Podster Admin \(name chosen by this agent\)/ })).toBeInTheDocument();
  });

  it("resets the filter controls when the filters change without a remount", async () => {
    replies.set(path, page([]));
    const { rerender } = render(await Activity({ params, searchParams: Promise.resolve({ actor: "per_owner" }) }));
    expect(screen.getByLabelText("Participant")).toHaveValue("per_owner");
    rerender(await Activity({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByLabelText("Participant")).toHaveValue("");
  });

  it("never sends a URL's odd values to the API", async () => {
    replies.set(path, page([]));
    render(await Activity({ params, searchParams: Promise.resolve({ task: "x y&admin=1", before: ["a", "b"] }) }));
    expect(seen()[0]).toBe(`${path}?order=newest`);
  });

  it.each([
    [{}, "Nothing has happened here yet."],
    [{ task: "tsk_1" }, /Nothing here matches/],
    [{ before: "evt_1" }, "Nothing before this point."],
  ])("says what an empty page means for %j", async (query, text) => {
    replies.set(path, page([]));
    render(await Activity({ params, searchParams: Promise.resolve(query) }));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("still shows the events, by ID, when names can't be read", async () => {
    organizations = failed(503);
    replies.set(path, page([event(1, "agt_1", "task.accepted", "tsk_1")]));
    render(await Activity({ params, searchParams }));
    expect(within(screen.getByRole("list")).getByText("agt_1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "tsk_1" })).toBeInTheDocument();
  });

  it("says a stale cursor isn't available, and offers the newest", async () => {
    replies.set(path, failed(400, "invalid_argument"));
    render(await Activity({ params, searchParams: Promise.resolve({ before: "evt_gone", task: "tsk_1" }) }));
    expect(screen.getByText(/That page isn't available/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the newest" })).toHaveAttribute("href", "/w/ws_1/activity?task=tsk_1");
  });

  it.each([401, 429, 503])("shows a %i as a failed read", async (status) => {
    replies.set(path, failed(status));
    render(await Activity({ params, searchParams }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });
});

describe("Settings", () => {
  const audit = { ok: true as const, data: { audit: [], next_cursor: null } };
  const preview = { archived: false, context: null, goal: null, name: "Launch room", openings: [], outputs: [], participant_count: 1, person_review: false, topic: null, workflow: "general" };
  const visibility = { ok: true as const, data: { visibility: "private", public_handle: null, published_at: null, published_on: null, topic: null, public_claims_paused: false, suspension: null, public_rooms_enabled: false, preview, view_hash: "a".repeat(64) } };
  beforeEach(() => replies.set("/api/v1/workspaces/ws_1/visibility", visibility));

  it("says a failed visibility read failed, not that the workroom is private", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", audit);
    replies.set("/api/v1/workspaces/ws_1/visibility", failed(503));
    render(await Settings({ params, searchParams }));
    expect(screen.getByText("Couldn't read it")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });

  it("isn't there for someone who can't manage", async () => {
    room.policy_version = null;
    await expect(Settings({ params, searchParams })).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("links the owner to appointing admins", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", audit);
    room.owner = "per_me";
    render(await Settings({ params, searchParams }));
    expect(screen.getByRole("link", { name: /Appoint or remove admins/ })).toBeInTheDocument();
  });

  it("says so when a failed identity read takes the owner's link away", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", audit);
    identity = failed(503);
    render(await Settings({ params, searchParams }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });

  it("shows a failed history read as a failure", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", failed(503));
    render(await Settings({ params, searchParams }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });
});

describe("who's offered creating a workroom", () => {
  const rooms = { ok: true as const, data: { workspaces: [] } };
  const member = { ok: true as const, data: { id: "per_me", org_id: "org_a", orgs: ["org_a", "org_p"], admin_orgs: ["org_p"] } };
  const link = () => screen.queryByRole("link", { name: "Create a workroom" });
  const form = () => screen.queryByRole("button", { name: "Create workroom" });

  beforeEach(() => replies.set("/api/v1/workspaces/cards", rooms));

  it("offers it to an admin of the organization they're working in", async () => {
    identity = { ok: true, data: { ...member.data, org_id: "org_p" } };
    const { unmount } = render(await MyWorkrooms());
    expect(link()).toHaveAttribute("href", "/workrooms/new");
    expect(screen.getByText(/Create one, then add/)).toBeInTheDocument();
    unmount();
    render(await NewWorkroom());
    expect(form()).toBeInTheDocument();
    expect(screen.queryByText(/couldn't check/)).toBeNull();
  });

  it("tells a plain member why, and where they are an admin", async () => {
    identity = member;
    const { unmount } = render(await MyWorkrooms());
    expect(link()).toBeNull();
    expect(screen.getByText(/you're a member of Org A/)).toBeInTheDocument();
    expect(screen.getByText(/You're an admin of Mine/)).toBeInTheDocument();
    expect(screen.queryByText(/Create one, then add/)).toBeNull();
    unmount();
    render(await NewWorkroom());
    expect(form()).toBeNull();
    expect(screen.getByText(/you're a member of Org A/)).toBeInTheDocument();
  });

  it("still refuses a member when organization names can't be read, without naming any", async () => {
    identity = member;
    organizations = failed(503);
    render(await NewWorkroom());
    expect(form()).toBeNull();
    expect(screen.getByText(/the organization you're working in/)).toBeInTheDocument();
    expect(screen.queryByText(/You're an admin of/)).toBeNull();
  });

  it.each([403, 503])("doesn't treat a failed identity read (%i) as a refusal", async (status) => {
    identity = failed(status);
    const { unmount } = render(await MyWorkrooms());
    expect(link()).toBeInTheDocument();
    expect(screen.queryByText(/you're a member of/)).toBeNull();
    unmount();
    render(await NewWorkroom());
    expect(form()).toBeInTheDocument();
    expect(screen.getByText(/couldn't check your role/)).toBeInTheDocument();
  });
});

describe("an archived room", () => {
  const Layout = import("./layout").then((module) => module.default);

  it("says so on every page, and points those who manage it to Settings", async () => {
    room.status = "archived";
    render(await (await Layout)({ params, children: null }));
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bring it back in Settings" })).toHaveAttribute("href", "/w/ws_1/settings");
  });

  it("tells everyone else who can bring it back", async () => {
    room.status = "archived";
    room.policy_version = null;
    render(await (await Layout)({ params, children: null }));
    expect(screen.getByText(/Its owner or an admin can bring it back/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bring it back in Settings" })).not.toBeInTheDocument();
  });

  it("says nothing on an active room", async () => {
    render(await (await Layout)({ params, children: null }));
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  it("marks it in My workrooms", async () => {
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [{ workspace_id: "ws_1", workspace_name: "Launch", role: "owner", status: "archived", card: null }] } });
    render(await MyWorkrooms());
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });
});

describe("My workrooms", () => {
  it("shows a failed read as a failure, not as having no rooms", async () => {
    replies.set("/api/v1/workspaces/cards", failed(503));
    render(await MyWorkrooms());
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/aren't in a workroom/)).not.toBeInTheDocument();
  });

  it("lists rooms as plain text with the viewer's role", async () => {
    const card = { goal: "<b>Ship</b> **it**\u202E", goal_cut: true, external: true, roles: { count: 1, with_openings: 1, filled: 1, capacity: 3, listed: [{ title: "Writers", filled: 1, capacity: 3 }] } };
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [{ workspace_id: "ws_1", workspace_name: "<b>Launch</b>", role: "owner", card }] } });
    render(await MyWorkrooms());
    expect(screen.getByRole("link", { name: "<b>Launch</b>" })).toHaveAttribute("href", "/w/ws_1/overview");
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("External")).toBeInTheDocument();
    expect(screen.getByText(/<b>Ship<\/b> \*\*it\*\*…$/)).toBeInTheDocument();
    expect(screen.getByText("1 of 3 roles filled")).toBeInTheDocument();
    expect(screen.getByText("Writers 1 of 3").textContent).toBe("Roles: Writers 1 of 3");
    expect(screen.queryByRole("link", { name: "More workrooms" })).toBeNull();
  });

  it("shows no counts to someone limited to their own tasks", async () => {
    const card = { goal: null, goal_cut: false, external: false, roles: { count: 2, with_openings: 1, listed: [{ title: "Lead", available: false }, { title: "Writer", available: true }] } };
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [{ workspace_id: "ws_1", workspace_name: "L", role: "guest", card }] } });
    render(await MyWorkrooms());
    expect(screen.getByText("2 roles, 1 with openings")).toBeInTheDocument();
    expect(screen.getByText("Lead full · Writer open").textContent).toBe("Roles: Lead full · Writer open");
    expect(screen.queryByText(/Goal:/)).toBeNull();
  });

  it("shows how many of each room's outputs are ready, and no line for a room with none or no count", async () => {
    const roles = { count: 0, with_openings: 0, filled: 0, capacity: 0, listed: [] };
    const row = (id: string, outputs?: { ready: number; total: number }) => ({ workspace_id: id, workspace_name: id, role: "owner", card: { goal: null, goal_cut: false, external: false, roles, ...(outputs ? { outputs } : {}) } });
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [row("a", { ready: 1, total: 3 }), row("b", { ready: 0, total: 1 }), row("c", { ready: 0, total: 0 }), row("d")] } });
    render(await MyWorkrooms());
    const card = (name: string) => screen.getByRole("link", { name }).closest("li")!;
    expect(within(card("a")).getByText("1 of 3 outputs ready")).toBeInTheDocument();
    expect(within(card("b")).getByText("0 of 1 output ready")).toBeInTheDocument();
    for (const name of ["c", "d"]) expect(within(card(name)).queryByText(/outputs? ready/), name).toBeNull();
  });

  it("keeps a multi-line goal's words apart, and shows no goal when nothing readable is left", async () => {
    const roles = { count: 0, with_openings: 0, filled: 0, capacity: 0, listed: [] };
    const row = (workspace_id: string, goal: string) => ({ workspace_id, workspace_name: workspace_id, role: "member", card: { goal, goal_cut: false, external: false, roles } });
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [row("a", "Ship the beta\nThen write docs"), row("b", "\u200D"), row("c", "\u3164"), row("d", "\u2800\uFE0F\u034F")] } });
    render(await MyWorkrooms());
    expect(screen.getByText(/Ship the beta Then write docs/)).toBeInTheDocument();
    expect(screen.getAllByText(/Goal:/)).toHaveLength(1);
    expect(screen.queryByText(/Unnamed/)).toBeNull();
  });

  it("doesn't say someone has no rooms when a page came back empty", async () => {
    const empty = async (data: object, query = {}) => {
      replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [], ...data } });
      const view = render(await MyWorkrooms({ searchParams: Promise.resolve(query) }));
      const said = view.container.textContent ?? "";
      view.unmount();
      return said;
    };
    // Every row on the page was stale, and there's more.
    const stale = await empty({ next_offset: 20 });
    expect(stale).not.toMatch(/aren't in a workroom/);
    expect(stale).toMatch(/No workrooms to show on this page/);
    // Past the end.
    const past = await empty({}, { offset: "500" });
    expect(past).not.toMatch(/aren't in a workroom/);
    expect(past).toMatch(/No workrooms to show on this page/);
    expect(await empty({})).toMatch(/aren't in a workroom/);
    expect(await empty({}, { offset: "0" })).toMatch(/aren't in a workroom/);
  });

  it("says so when a room can't answer, and keeps the rest of the row", async () => {
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [{ workspace_id: "ws_1", workspace_name: "L", role: "member", card: null }] } });
    render(await MyWorkrooms());
    expect(screen.getByRole("link", { name: "L" })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load this workroom's goal and roles/)).toBeInTheDocument();
  });

  it("asks for the page in the URL, and links to the next", async () => {
    replies.set("/api/v1/workspaces/cards", { ok: true, data: { workspaces: [], next_offset: 40 } });
    render(await MyWorkrooms({ searchParams: Promise.resolve({ offset: "20" }) }));
    expect(screen.getByRole("link", { name: "More workrooms" })).toHaveAttribute("href", "/workrooms?offset=40");
    expect(queries).toContain("/api/v1/workspaces/cards?offset=20");
  });
});
