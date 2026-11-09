import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import { AgentSheet } from "./agent-sheet";
import { endpointLabel, endpointUrlProblem } from "./model";

// M3 step 15: an agent's A2A endpoint on its Sheet, for its organization's admin (decision 119).

const ENDPOINT = { url: "https://agent.example.com/a2a/secret-path?k=v", version: 2, enabled: true, consecutive_failures: 0, has_token: true, token_state: "stored", set_at: 1 };
const BASE = { id: "agt_1", org_id: "org_1", name: "Code Agent", generation: 1, status: "active", inbox_unread: 0, wake: null };

let agent: Record<string, unknown> = { ...BASE, a2a_endpoint: ENDPOINT };
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
  agent = { ...BASE, a2a_endpoint: ENDPOINT };
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
const section = async () => within((await screen.findByRole("heading", { name: "A2A endpoint" })).closest("section")!);
const writes = () => calls.filter((c) => c.method !== "GET" && c.url.includes("a2a-endpoint"));

describe("the A2A endpoint on the agent Sheet", () => {
  it("shows its status, host and token state, and never its path, secret or token", async () => {
    render(<Screen />);
    const here = await section();
    expect(here.getByText("On · agent.example.com")).toBeTruthy();
    expect(here.getByText("Token stored")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-path");
    expect(document.body.textContent).not.toContain("k=v");
  });

  it("sets one, with a token, and shows the new signing secret only once", async () => {
    agent = { ...BASE, a2a_endpoint: null };
    answer = (url, method) => (method === "PUT" ? Response.json({ ...ENDPOINT, version: 1, signing_secret: "a2asec_" + "a".repeat(64) }) : undefined);
    const user = userEvent.setup();
    render(<Screen />);
    const here = await section();
    expect(here.getByText("None")).toBeTruthy();
    await user.click(here.getByRole("button", { name: "Set endpoint" }));
    await user.type(here.getByLabelText("Endpoint URL"), "https://agent.example.com/a2a");
    await user.type(here.getByLabelText("Bearer token (optional)"), "tok_x");
    await user.click(here.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/agents/agt_1/a2a-endpoint", method: "PUT", body: { url: "https://agent.example.com/a2a", token: "tok_x" } });
    expect(await here.findByText("a2asec_" + "a".repeat(64))).toBeTruthy();
    expect(here.getByText("Signing secret, shown only now")).toBeTruthy();
    await user.click(here.getByRole("button", { name: "Done" }));
    expect(here.queryByText("a2asec_" + "a".repeat(64))).toBeNull();
  });

  it("checks the URL before sending it, and words the API's refusal", async () => {
    answer = (url, method) => (method === "PUT" ? Response.json({ error: { code: "invalid_endpoint_url" } }, { status: 400 }) : undefined);
    const user = userEvent.setup();
    render(<Screen />);
    const here = await section();
    await user.click(here.getByRole("button", { name: "Change" }));
    await user.type(here.getByLabelText("Endpoint URL"), "http://agent.example.com/a2a");
    await user.click(here.getByRole("button", { name: "Save" }));
    expect((await here.findByRole("alert")).textContent).toContain("https://");
    expect(writes()).toEqual([]);
    await user.clear(here.getByLabelText("Endpoint URL"));
    await user.type(here.getByLabelText("Endpoint URL"), "https://10.0.0.1.example/a2a");
    await user.click(here.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(here.getByRole("alert").textContent).toContain("public HTTPS"));
  });

  it("makes a new signing secret for the same URL, and removes it after a confirmation", async () => {
    answer = (url, method) => (method === "PUT" ? Response.json({ ...ENDPOINT, signing_secret: "a2asec_" + "b".repeat(64) }) : method === "DELETE" ? Response.json({ deleted: true }) : undefined);
    const user = userEvent.setup();
    render(<Screen />);
    const here = await section();
    await user.click(here.getByRole("button", { name: "New signing secret" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "PUT", body: { url: ENDPOINT.url, rotate_secret: true } }));
    expect(await here.findByText("a2asec_" + "b".repeat(64))).toBeTruthy();
    await user.click(here.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(writes().at(-1)).toMatchObject({ url: "/api/agents/agt_1/a2a-endpoint", method: "DELETE" }));
  });

  it("says when it's off after failures or its token can't be used, and offers nothing while disconnected", async () => {
    agent = { ...BASE, status: "disconnected", a2a_endpoint: { ...ENDPOINT, enabled: false, consecutive_failures: 3, token_state: "unreadable" } };
    render(<Screen />);
    const here = await section();
    expect(here.getByText("Off after repeated failures · agent.example.com")).toBeTruthy();
    expect(here.getByText("Token can't be used, so set it again")).toBeTruthy();
    expect(here.getByText("3 in a row")).toBeTruthy();
    expect(here.queryByRole("button", { name: "Change" })).toBeNull();
  });
});

describe("the endpoint helpers", () => {
  it("labels and checks", () => {
    expect(endpointLabel(null)).toBe("None");
    expect(endpointLabel(undefined)).toBe("None");
    expect(endpointUrlProblem("https://a.example/x")).toBeNull();
    for (const bad of ["a.example", "http://a.example", "https://u:p@a.example", "https://a.example:8443/"]) expect(endpointUrlProblem(bad), bad).not.toBeNull();
  });
});
