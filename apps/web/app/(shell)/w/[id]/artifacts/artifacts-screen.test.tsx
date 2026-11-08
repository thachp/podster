import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import type { Room } from "../tasks/task-model";
import { currentFilesText, currentVersion, outputProblem, outputStatus, outputTextProblem, readyText, type Output, type OutputsRead, type VersionsRead } from "./artifacts-model";
import { ArtifactsScreen } from "./artifacts-screen";

vi.mock("../tasks/go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const ROOM: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [] };

const output = (over: Partial<Output> = {}): Output => ({ id: "out_1", title: "Design doc", description: "The **API** design <img src=x>", status: "not_started", current: null, ...over });

const read = (outputs: Output[], ready = outputs.filter((o) => o.status === "ready").length): OutputsRead => ({ outputs, ready, total: outputs.length });

type Sent = { method: string; url: string; body: unknown; key: string | null };
let sent: Sent[];
let refuse: { status: number; code: string } | null;
let reads: (url: string) => Response;

beforeEach(() => {
  setUrl("/w/ws_1/artifacts");
  sent = [];
  refuse = null;
  reads = () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") {
      sent.push({ method, url, body: undefined, key: null });
      return reads(url);
    }
    sent.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init.headers).get("idempotency-key") });
    if (refuse) return new Response(JSON.stringify({ error: { code: refuse.code } }), { status: refuse.status });
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (data: OutputsRead, over: { canManage?: boolean; archived?: boolean; taskTitles?: Record<string, string>; histories?: Record<string, VersionsRead> } = {}) =>
  render(<ArtifactsScreen room={ROOM} read={data} me="per_me" names={{ per_rev: "Rae Reviewer" }} orgNames={{}} taskTitles={over.taskTitles ?? {}} histories={over.histories} canManage={over.canManage ?? false} archived={over.archived ?? false} />);
const commandsSent = () => sent.filter((call) => call.method !== "GET");

const rowOf = (title: string) => screen.getByRole("heading", { name: title, level: 2 }).closest("li") as HTMLElement;

describe("the output model", () => {
  it("labels the three states and never calls an unknown one Ready", () => {
    expect(["not_started", "in_review", "ready"].map((status) => outputStatus(status).label)).toEqual(["Not started", "In review", "Ready"]);
    expect(outputStatus("constructor").label).toBe("Unknown state");
  });

  it("counts ready outputs as the API does", () => {
    expect(readyText(1, 3)).toBe("1 of 3 outputs ready");
    expect(readyText(0, 1)).toBe("0 of 1 output ready");
    expect(readyText(0, 0)).toBe("No expected outputs yet.");
  });

  it("takes the history's newest entry as current only when it's the version the listing names", () => {
    const ready = output({ status: "ready", current: { task_id: "tsk_9", submission_no: 2 } });
    expect(currentVersion(ready, { versions: [{ submission_no: 2, approved_at: 5, task_id: "tsk_9", approved_by: "per_rev" }], complete: true })?.approved_by).toBe("per_rev");
    expect(currentVersion(ready, { versions: [{ submission_no: 1, approved_at: 5, task_id: "tsk_9", approved_by: "per_rev" }], complete: true })).toBeUndefined();
    expect(currentVersion(ready, undefined)).toBeUndefined();
  });

  it("says nothing about files the read doesn't speak for", () => {
    expect(currentFilesText(null)).toBeNull();
    expect(currentFilesText({ task_id: "tsk_1", submission_no: 1 })).toBeNull();
    expect(currentFilesText({ task_id: "tsk_1", submission_no: 1, files_available: false })).toMatch(/blocked or removed/);
  });

  it("checks titles and descriptions in bytes, as the API does", () => {
    expect(outputTextProblem(" ", "")).toMatch(/required/);
    expect(outputTextProblem("é".repeat(101), "")).toMatch(/200 bytes/);
    expect(outputTextProblem("x", "x".repeat(4097))).toMatch(/4 KB/);
    expect(outputTextProblem("x".repeat(200), "x".repeat(4096))).toBeNull();
  });

  it.each([
    ["too_many_outputs", 409, /50 at once, and 500 in all, counting removed ones/],
    ["output_in_use", 409, /was Ready once, or a task that isn't finished works toward it/],
    ["output_not_found", 404, /isn't there any more/],
    ["not_allowed", 403, /owner or an admin/],
  ])("words %s plainly", (code, status, words) => {
    expect(outputProblem(code, status)).toMatch(words);
    expect(outputProblem(code, status)).toMatch(/Nothing changed/);
  });
});

describe("Artifacts", () => {
  it("shows every output's title, description and status, with the ready count", () => {
    show(read([output(), output({ id: "out_2", title: "Launch plan", status: "in_review", description: null }), output({ id: "out_3", title: "Pricing", status: "ready", current: { task_id: "tsk_9", submission_no: 2 } })]));
    expect(screen.getByText("1 of 3 outputs ready")).toBeInTheDocument();
    expect(within(rowOf("Design doc")).getByText("Not started")).toBeInTheDocument();
    expect(within(rowOf("Launch plan")).getByText("In review")).toBeInTheDocument();
    expect(within(rowOf("Pricing")).getByText("Ready")).toBeInTheDocument();
  });

  it("keeps someone's description as plain text, and loads nothing from it", () => {
    const { container } = show(read([output()]));
    expect(screen.getByText("The **API** design <img src=x>")).toBeInTheDocument();
    expect(container.querySelector("img, strong")).toBeNull();
  });

  it("names the approved version's task and opens it in the Task Sheet", () => {
    show(read([output({ status: "ready", current: { task_id: "tsk_9", submission_no: 2, approved_at: 1_700_000_000_000, files_available: true } })]), { taskTitles: { tsk_9: "Write the design" } });
    const link = within(rowOf("Design doc")).getByRole("link", { name: "Write the design" });
    expect(within(rowOf("Design doc")).getByText(/submission 2 of/)).toBeInTheDocument();
    expect(within(rowOf("Design doc")).getByText(/Everything in the approved version is still available from its task/)).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/w/ws_1/artifacts?task=tsk_9");
  });

  it("says a newer submission is in review beside the Ready badge, without replacing it", () => {
    show(read([output({ status: "ready", in_review: true, current: { task_id: "tsk_9", submission_no: 1 } }), output({ id: "out_2", title: "Launch plan", status: "in_review", in_review: true })]));
    const ready = rowOf("Design doc");
    expect(within(ready).getByText("Ready")).toBeInTheDocument();
    expect(within(ready).getByText("A newer submission is in review")).toBeInTheDocument();
    // An output with no approved version is simply In review, and says nothing about a newer one.
    expect(within(rowOf("Launch plan")).queryByText("A newer submission is in review")).toBeNull();
  });

  it("says clearly when a Ready output's file is unavailable (decision 138)", () => {
    show(read([output({ status: "ready", current: { task_id: "tsk_9", submission_no: 2, files_available: false } })]));
    const row = rowOf("Design doc");
    expect(within(row).getByText("Ready")).toBeInTheDocument();
    expect(within(row).getByText(/has since been blocked or removed, so it can't be downloaded/)).toBeInTheDocument();
  });

  it("shows a task it can't name by ID, and says nothing about a version it can't see", () => {
    show(read([output({ status: "ready", current: { task_id: "tsk_9", submission_no: 1 } }), output({ id: "out_2", title: "Hidden", status: "ready", current: null })]));
    expect(within(rowOf("Design doc")).getByRole("link", { name: "task tsk_9" })).toBeInTheDocument();
    expect(within(rowOf("Design doc")).queryByText(/files/)).toBeNull();
    expect(within(rowOf("Hidden")).getByText(/from a task your access doesn't show/)).toBeInTheDocument();
    expect(within(rowOf("Hidden")).queryByRole("link")).toBeNull();
  });

  const HISTORY: VersionsRead = {
    versions: [
      { submission_no: 2, approved_at: 1_700_000_200_000, task_id: "tsk_9", approved_by: "per_rev" },
      { submission_no: 1, approved_at: 1_700_000_100_000 },
    ],
    complete: true,
  };

  it("names the reviewer of the approved version, and lists every version newest first, with source task and reviewer where given", async () => {
    const user = userEvent.setup();
    show(read([output({ status: "ready", current: { task_id: "tsk_9", submission_no: 2 } })]), { taskTitles: { tsk_9: "Write the design" }, histories: { out_1: HISTORY } });
    const row = rowOf("Design doc");
    expect(within(row).getByText(/submission 2 of/).parentElement ?? row).toHaveTextContent(/approved by Rae Reviewer/);
    await user.click(within(row).getByText("Version history (2)"));
    const versions = within(row).getAllByRole("listitem");
    expect(versions[0]).toHaveTextContent(/Submission 2\s*Current/);
    expect(within(versions[0]).getByRole("link", { name: "Write the design" })).toHaveAttribute("href", "/w/ws_1/artifacts?task=tsk_9");
    expect(versions[0]).toHaveTextContent(/Reviewer:\s*Rae Reviewer/);
    expect(versions[1]).toHaveTextContent("From a task your access doesn't show.");
    expect(within(versions[1]).queryByRole("link")).toBeNull();
    expect(sent.some((call) => call.url.endsWith("/versions"))).toBe(false);
  });

  it("reads a history that wasn't loaded with the page only when it's opened", async () => {
    const user = userEvent.setup();
    reads = (url) => (url.endsWith("/outputs/out_1/versions") ? new Response(JSON.stringify({ ...HISTORY, complete: false }), { status: 200 }) : new Response("{}", { status: 404 }));
    show(read([output({ status: "ready", current: { task_id: "tsk_9", submission_no: 2 } })]));
    expect(sent).toHaveLength(0);
    await user.click(screen.getByText("Version history"));
    expect(await screen.findByText("Showing the latest 2 versions.")).toBeInTheDocument();
    expect(screen.getByText("Version history (2+)")).toBeInTheDocument();
    expect(sent.filter((call) => call.url === "/api/v1/workspaces/ws_1/outputs/out_1/versions")).toHaveLength(1);
  });

  it("offers a retry when the history doesn't load, and has none for an output that was never Ready", async () => {
    const user = userEvent.setup();
    reads = () => new Response(JSON.stringify({ error: { code: "upstream_unavailable" } }), { status: 503 });
    show(read([output({ status: "ready", current: null }), output({ id: "out_2", title: "Launch plan", status: "in_review" })]));
    expect(within(rowOf("Launch plan")).queryByText(/Version history/)).toBeNull();
    await user.click(within(rowOf("Design doc")).getByText("Version history"));
    expect(await screen.findByText(/Couldn't load the version history/)).toHaveAttribute("role", "alert");
  });

  it("offers no controls to someone who doesn't manage the room, or in an archived room", () => {
    const { unmount } = show(read([output()]));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Define an expected output" })).toBeNull();
    unmount();
    show(read([output()]), { canManage: true, archived: true });
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.getByText(/archived, so its outputs can't change/)).toBeInTheDocument();
  });

  it("lets an admin define one, sending the trimmed title and leaving out an empty description", async () => {
    const user = userEvent.setup();
    show(read([]), { canManage: true });
    expect(screen.getByText(/Define the first one below/)).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Define an expected output" });
    await user.type(within(form).getByLabelText("Title"), "  Launch plan  ");
    await user.click(within(form).getByRole("button", { name: "Define output" }));
    await waitFor(() => expect(commandsSent()).toHaveLength(1));
    expect(commandsSent()[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/outputs", body: { title: "Launch plan" } });
    expect(commandsSent()[0].key).toBeTruthy();
    expect(await screen.findByText(/Defined “Launch plan”/)).toBeInTheDocument();
    expect(routerCalls.refresh).toBeGreaterThan(0);
    expect(within(form).getByLabelText("Title")).toHaveValue("");
  });

  it("says so when the room is full, before trying", () => {
    show(read(Array.from({ length: 50 }, (_, index) => output({ id: `out_${index}`, title: `Output ${index}` }))), { canManage: true });
    expect(screen.getByText(/has 50 expected outputs, the most it can have/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Define output" })).toBeDisabled();
  });

  it("renames with the whole title and description, clearing an emptied description, and returns focus", async () => {
    const user = userEvent.setup();
    show(read([output()]), { canManage: true });
    await user.click(within(rowOf("Design doc")).getByRole("button", { name: "Rename" }));
    const form = screen.getByRole("form", { name: "Rename Design doc" });
    const title = within(form).getByLabelText("Title");
    expect(title).toHaveFocus();
    await user.clear(title);
    await user.type(title, "Design");
    await user.clear(within(form).getByLabelText("Description (optional)"));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(commandsSent()).toHaveLength(1));
    expect(commandsSent()[0]).toMatchObject({ method: "PUT", url: "/api/v1/workspaces/ws_1/outputs/out_1", body: { title: "Design", description: null } });
    await waitFor(() => expect(within(rowOf("Design doc")).getByRole("button", { name: "Rename" })).toHaveFocus());
  });

  it("removes only after confirming, and says why a removal was refused", async () => {
    const user = userEvent.setup();
    refuse = { status: 409, code: "output_in_use" };
    show(read([output()]), { canManage: true });
    await user.click(within(rowOf("Design doc")).getByRole("button", { name: "Remove" }));
    expect(commandsSent()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Remove output" }));
    await waitFor(() => expect(commandsSent()).toHaveLength(1));
    expect(commandsSent()[0]).toMatchObject({ method: "DELETE", url: "/api/v1/workspaces/ws_1/outputs/out_1" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be removed: it was Ready once/);
  });

  it("says when a define may or may not have gone through, and retries with the same key", async () => {
    const user = userEvent.setup();
    refuse = { status: 503, code: "upstream_unavailable" };
    show(read([]), { canManage: true });
    const form = screen.getByRole("form", { name: "Define an expected output" });
    await user.type(within(form).getByLabelText("Title"), "Launch plan");
    await user.click(within(form).getByRole("button", { name: "Define output" }));
    expect(await screen.findByText(/We can't tell whether this saved/)).toBeInTheDocument();
    refuse = null;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(commandsSent()).toHaveLength(2));
    expect(commandsSent()[1].key).toBe(commandsSent()[0].key);
  });
});
