import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import type { PullRequestChange } from "./task-change";
import type { Room, Task, TaskDetail } from "./task-model";
import { TaskSheet } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

// M6 step 10(b): the Release panel's deployment stage, from the room's release configuration (only to tell whether release
// is on for the deployment) and the task's release status. Never Live unless served (UI-02).

const MERGED = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const APP = "https://k3v9q2.apps.example/";
const ROOM: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] };
const task: Task = { id: "tsk_1", title: "Design the API", instructions: "Write it", acceptance_criteria: null, requester: "per_r", assignee: "agt_a", reviewer: "per_rv", status: "completed", version: 5, due_at: null, follow_up_of: null, submission_no: 2, approved_submission_no: 2, needs_attention: false };
const change = (over: Partial<PullRequestChange> = {}): PullRequestChange => ({ provider_repo_id: 1, pr_number: 7, submission_no: 2, pr_state: "merged", pr_draft: false, pr_observed_at: 1, commit_changed_at: null, watched: true, observed_head_sha: MERGED, head_observed_at: 1, head_in_repository: true, base_is_default: true, observed_base_sha: null, reviewed_commit_sha: MERGED, reviewed_base_sha: null, commit_changed: false, merge_state: "succeeded", merge_reason: null, merge_sha: MERGED, merge_observed_at: 1, merge_requested_by: "per_me", merge_requested_at: 1, merge_finished_at: 2, ...over });
const detail = (over: Partial<PullRequestChange> = {}): TaskDetail => ({ task, change: change(over), submissions: [], artifacts: [], messages: [], history: [] });
const release = (over: Record<string, unknown> = {}) => ({ exists: true, release_id: `rel_${"a1".repeat(16)}`, commit_sha: MERGED, state: "served", observed_at: 5, failure_code: null, served: true, result_url: APP, ...over });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });

let urls: string[];
let reads: { task: () => Response; config: () => Response; status: () => Response };

beforeEach(() => {
  urls = [];
  setUrl("/w/ws_1/tasks?task=tsk_1");
  reads = { task: () => json(200, detail()), config: () => refused(404, "not_found"), status: () => json(200, { release: release() }) };
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    if (url.endsWith("/release-config")) return reads.config();
    if (url.endsWith("/release-status")) return reads.status();
    if (url.includes("/repository")) return refused(403, "not_allowed");
    return reads.task();
  });
});

const stage = async () => {
  render(
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="task" target="tsk_1">
          Open
        </SheetLink>
      </main>
      <TaskSheet me="per_me" names={{}} room={ROOM} resolve={(target) => ({ workspace: "ws_1", task: target })} />
    </>,
  );
  return screen.findByTestId("deployment-stage");
};

describe("the Release panel's deployment stage", () => {
  it("is Unavailable while release is off for the deployment, reads no release status, and implies no serving", async () => {
    const shown = await stage();
    expect(within(shown).getByText("Unavailable")).toBeInTheDocument();
    expect(shown).toHaveTextContent("Merged · Unavailable");
    expect(within(shown).queryByRole("link")).toBeNull();
    expect(shown.textContent).not.toMatch(/\blive\b/i);
    expect(urls.filter((url) => url.endsWith("/release-status"))).toEqual([]);
    expect(urls).toContain("/api/v1/workspaces/ws_1/release-config");
  });

  it("shows Merged · Deployment failed, never live, when the release failed (UI-02)", async () => {
    reads.config = () => refused(403, "not_allowed");
    reads.status = () => json(200, { release: release({ state: "failed", failure_code: "upload_failed", served: false, result_url: null }) });
    const shown = await stage();
    expect(await within(shown).findByText("Merged · Deployment failed")).toBeInTheDocument();
    expect(within(shown).queryByRole("link")).toBeNull();
    expect(shown.textContent).not.toMatch(/Live/);
    expect(urls).toContain("/api/v1/workspaces/ws_1/tasks/tsk_1/release-status");
  });

  it("is Live, linking to the app, only while the room says this commit is served", async () => {
    reads.config = () => json(200, {});
    const shown = await stage();
    expect(await within(shown).findByText("Merged · Live")).toBeInTheDocument();
    expect(within(shown).getByRole("link", { name: /Open the app/ })).toHaveAttribute("href", APP);
  });

  it("isn't Live and has no link while the room is still confirming, even with an address in hand", async () => {
    reads.config = () => json(200, {});
    reads.status = () => json(200, { release: release({ state: "awaiting_confirmation", served: false }) });
    const shown = await stage();
    expect(await within(shown).findByText("Merged · Deploying")).toBeInTheDocument();
    expect(within(shown).queryByRole("link")).toBeNull();
  });

  it("says it couldn't check, not Off, when the status answers in another shape", async () => {
    reads.config = () => json(200, {});
    reads.status = () => json(200, { checks: null });
    const shown = await stage();
    expect(await within(shown).findByText("Merged · Couldn't check")).toBeInTheDocument();
  });

  it("reads no status when it can't tell whether release is on, and says it couldn't check", async () => {
    reads.config = () => refused(500, "error");
    const shown = await stage();
    expect(await within(shown).findByText("Merged · Couldn't check")).toBeInTheDocument();
    expect(within(shown).queryByRole("link")).toBeNull();
    expect(urls.filter((url) => url.endsWith("/release-status"))).toEqual([]);
  });

  it("waits for the merge before reading any release", async () => {
    reads.config = () => json(200, {});
    reads.task = () => json(200, detail({ merge_state: "not_requested", merge_sha: null, merge_finished_at: null }));
    const shown = await stage();
    expect(within(shown).getByText("Waiting for merge")).toBeInTheDocument();
    expect(urls.filter((url) => url.endsWith("/release-status"))).toEqual([]);
  });
});
