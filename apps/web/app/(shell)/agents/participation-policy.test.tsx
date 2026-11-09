import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import { AgentSheet } from "./agent-sheet";

// M4 step 11(a): the participation policy on the agent Sheet, for its organization's admins (decision 159).

const BASE = { id: "agt_1", org_id: "org_1", name: "Code Agent", generation: 1, status: "active", inbox_unread: 0, wake: null, participation_policy: "invitations_only" };

let agent: Record<string, unknown> = { ...BASE };
const calls: { url: string; method: string; body: unknown }[] = [];
let answer: (url: string, method: string) => Response | undefined = () => undefined;

function server(url: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
  const special = answer(url, method);
  if (special) return Promise.resolve(special);
  if (url === "/api/agents/agt_1") return Promise.resolve(Response.json(agent));
  if (url === "/api/v1/workspaces") return Promise.resolve(Response.json({ workspaces: [] }));
  if (url === "/api/v1/agents/agt_1/rooms") return Promise.resolve(Response.json({ rooms: [], truncated: false }));
  if (url.startsWith("/api/v1/agents/agt_1/inbox")) return Promise.resolve(Response.json({ events: [], acked_seq: 0, unread: 0, dropped: 0 }));
  return Promise.resolve(Response.json({ error: { code: "not_found" } }, { status: 404 }));
}

beforeEach(() => {
  calls.length = 0;
  agent = { ...BASE };
  answer = () => undefined;
  vi.stubGlobal("fetch", vi.fn(server));
  setUrl("/agents?agent=agt_1");
});

const Screen = () => (
  <>
    <SheetLink param="agent" target="agt_1">
      Open it
    </SheetLink>
    <AgentSheet organizations={[{ id: "org_1", name: "Acme" }]} descriptions={{}} />
  </>
);
const section = async () => within((await screen.findByRole("heading", { name: "Participation policy" })).closest("section")!);
const writes = () => calls.filter((c) => c.method !== "GET" && c.url.includes("participation-policy"));

describe("the participation policy on the agent Sheet", () => {
  it("shows the current policy, and saves a change as the whole value", async () => {
    answer = (_url, method) => {
      if (method !== "PUT") return undefined;
      agent = { ...agent, participation_policy: "public_claims" };
      return Response.json({ policy: "public_claims", set_at: 1 });
    };
    const user = userEvent.setup();
    render(<Screen />);
    const here = await section();
    expect(here.getByRole("radio", { name: /Invitations only \(current\)/ })).toBeChecked();
    const save = here.getByRole("button", { name: "Save policy" });
    expect(save).toBeDisabled();
    await user.click(here.getByRole("radio", { name: /Invitations and public claims/ }));
    await user.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: "/api/agents/agt_1/participation-policy", method: "PUT", body: { policy: "public_claims" } });
    expect(await here.findByText(/can claim openings in public workrooms now/)).toBeInTheDocument();
    await waitFor(() => expect(here.getByRole("radio", { name: /Invitations and public claims \(current\)/ })).toBeChecked());
  });

  it("says tightening it ends no claim already made", async () => {
    agent = { ...BASE, participation_policy: "public_claims" };
    const user = userEvent.setup();
    render(<Screen />);
    const here = await section();
    await user.click(here.getByRole("radio", { name: /Invitations only/ }));
    expect(here.getByRole("note")).toHaveTextContent(/Public claims it already holds stay/);
  });

  it("explains a refusal, and that nothing changed", async () => {
    answer = (_url, method) => (method === "PUT" ? Response.json({ error: { code: "agent_disconnected" } }, { status: 409 }) : undefined);
    const user = userEvent.setup();
    render(<Screen />);
    const here = await section();
    await user.click(here.getByRole("radio", { name: /Invitations and public claims/ }));
    await user.click(here.getByRole("button", { name: "Save policy" }));
    expect(await here.findByRole("alert")).toHaveTextContent(/disconnected, so its policy can't change. Nothing changed/);
  });

  it("can't change while the agent is disconnected", async () => {
    agent = { ...BASE, status: "disconnected" };
    render(<Screen />);
    const here = await section();
    expect(here.getByRole("radio", { name: /Invitations only/ })).toBeDisabled();
    expect(here.queryByRole("button", { name: "Save policy" })).toBeNull();
  });
});
