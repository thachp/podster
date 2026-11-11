import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import { TaskChangePanel, mergeLabel, type PullRequestChange } from "./task-change";
import { explainMergeRefusal, failureSentence, mergeOffered, REVIEW_AGAIN, REVIEWER_UNKNOWN, reviewAgainRefusal } from "./task-merge";
import type { Room, Task, TaskDetail } from "./task-model";
import { TaskSheet } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const REVIEWED = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const ROOM: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }, { principal_id: "agt_a", kind: "agent", org_id: "org_b", role: "member" }] };
const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "Design the API", instructions: "Write it", acceptance_criteria: null, requester: "per_r", assignee: "agt_a", reviewer: "per_rv", status: "completed", version: 5, due_at: null, follow_up_of: null, submission_no: 2, approved_submission_no: 2, needs_attention: false, ...over });
const change = (over: Partial<PullRequestChange> = {}): PullRequestChange => ({ provider_repo_id: 1, pr_number: 7, submission_no: 2, pr_state: "open", pr_draft: false, pr_observed_at: 1, commit_changed_at: null, watched: true, observed_head_sha: REVIEWED, head_observed_at: 1, head_in_repository: true, base_is_default: true, observed_base_sha: null, reviewed_commit_sha: REVIEWED, reviewed_base_sha: null, commit_changed: false, merge_state: "not_requested", merge_reason: null, merge_sha: null, merge_observed_at: null, merge_requested_by: null, merge_requested_at: null, merge_finished_at: null, ...over });
const detail = (over: Partial<PullRequestChange> | null | "absent" = {}, taskOver: Partial<Task> = {}): TaskDetail => ({ task: task(taskOver), ...(over === "absent" ? {} : { change: over === null ? null : change(over) }), submissions: [], artifacts: [], messages: [], history: [] });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });
const MERGE_GRANT = { id: "pg_1", principal_id: "per_me", action: "merge", delegated_by: "per_o", created_at: 1, expires_at: null, revoked_at: null, state: "live" };
const LINK = { id: "rl_1", provider: "github", provider_repo_id: 1, full_name: "podsterdev/billing", visibility: "public", default_branch: "main", status: "ready", status_reason: null, created_at: 1, verified_at: 1, updated_at: 1 };

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];
let reads: { task: () => Response; grants: () => Response; repository: () => Response; merge: () => Response };

beforeEach(() => {
  calls = [];
  setUrl("/w/ws_1/tasks?task=tsk_1");
  reads = { task: () => json(200, detail()), grants: () => json(200, { grants: [MERGE_GRANT] }), repository: () => json(200, { request: null, repository: LINK }), merge: () => json(200, { task_id: "tsk_1", merge_state: "requested", commit_sha: REVIEWED, submission_no: 2, requested_at: 1 }) };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined, key: new Headers(init?.headers).get("idempotency-key") });
    if (url.endsWith("/repository/grants")) return reads.grants();
    if (url.endsWith("/repository")) return reads.repository();
    if (url.endsWith("/merge")) return reads.merge();
    return reads.task();
  });
});

const open = async (me = "per_me") => {
  render(
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="task" target="tsk_1">
          Open
        </SheetLink>
      </main>
      <TaskSheet me={me} names={{}} room={ROOM} resolve={(target) => ({ workspace: "ws_1", task: target })} />
    </>,
  );
  await screen.findByRole("heading", { name: "Design the API" });
};
const repositoryReads = () => calls.filter((call) => call.url.includes("/repository"));

describe("merging from the task Sheet", () => {
  it("with managed repositories off, the task read has no change, and the Sheet reads nothing more", async () => {
    reads.task = () => json(200, detail("absent"));
    await open();
    expect(screen.queryByRole("heading", { name: "Release" })).toBeNull();
    expect(repositoryReads()).toEqual([]);
  });

  it("offers a merge grant's holder the merge, and confirms it naming the reviewed commit and the default branch before sending", async () => {
    await open();
    const button = await screen.findByRole("button", { name: "Merge reviewed commit" });
    expect(button).toHaveAccessibleDescription(/reviewed commit a1b2c3d4e5f6 into the repository's default branch, main/);
    await userEvent.click(button);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Merge reviewed commit a1b2c3d4e5f6?");
    expect(dialog).toHaveTextContent("into the repository's default branch, main");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    const sent = calls.find((call) => call.method === "POST")!;
    expect(sent).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/merge", body: { submission_no: 2, commit_sha: REVIEWED } });
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses one key per intent: asking again after a lost answer sends the same key", async () => {
    reads.merge = () => json(500, {});
    await open();
    for (let i = 0; i < 2; i++) {
      await userEvent.click(await screen.findByRole("button", { name: "Merge reviewed commit" }));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge" }));
      await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(i + 1));
    }
    const keys = calls.filter((call) => call.method === "POST").map((call) => call.key);
    expect(keys[0]).toBe(keys[1]);
  });

  it("asks again after a failed merge under a new key, and retries that ask under its own", async () => {
    // Once the merge is asked for, the job runs and fails; the Sheet's next read says so, with when it ended.
    let asked = false;
    const firstMerge = reads.merge;
    reads.merge = () => {
      asked = true;
      return firstMerge();
    };
    reads.task = () => json(200, asked ? detail({ merge_state: "failed", merge_reason: "provider_refused", merge_requested_at: 100, merge_finished_at: 200 }) : detail());
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Merge reviewed commit" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    // The control stays mounted. Now the asks are lost answers.
    reads.merge = () => json(500, {});
    for (let i = 0; i < 2; i++) {
      await userEvent.click(await screen.findByRole("button", { name: "Ask to merge again" }));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge" }));
      await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(i + 2));
    }
    const [first, again, retried] = calls.filter((call) => call.method === "POST").map((call) => call.key);
    expect(again).not.toBe(first);
    expect(retried).toBe(again);
  });

  it("sends one request however fast Merge is pressed twice", async () => {
    let answer: (response: Response) => void = () => undefined;
    reads.merge = () => new Promise<Response>((done) => (answer = done)) as unknown as Response;
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Merge reviewed commit" }));
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge" });
    await userEvent.click(confirm);
    await userEvent.click(confirm);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    answer(json(200, { task_id: "tsk_1", merge_state: "requested", commit_sha: REVIEWED, submission_no: 2, requested_at: 1 }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("passes axe with the control offered and with its confirmation open", async () => {
    await open();
    const button = await screen.findByRole("button", { name: "Merge reviewed commit" });
    const rules = { rules: { "color-contrast": { enabled: false } } };
    expect((await axe.run(screen.getByRole("dialog"), rules)).violations.map((v) => v.id)).toEqual([]);
    await userEvent.click(button);
    expect((await axe.run(await screen.findByRole("alertdialog"), rules)).violations.map((v) => v.id)).toEqual([]);
  });

  it("shows the API's refusal as a sentence", async () => {
    reads.merge = () => refused(403, "self_merge");
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Merge reviewed commit" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge" }));
    expect(await screen.findByText(/you, or the person who controls you, also control whoever submitted it/)).toBeInTheDocument();
  });

  it("says a 503 that recorded nothing as a refusal, not an unknown outcome", async () => {
    reads.merge = () => refused(503, "merge_unavailable");
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Merge reviewed commit" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("Podster's merge isn't set up right now, so nothing was asked for.")).toBeInTheDocument();
  });

  it("offers nothing without a live merge grant", async () => {
    reads.grants = () => json(200, { grants: [{ ...MERGE_GRANT, action: "push" }] });
    await open();
    await waitFor(() => expect(repositoryReads().length).toBe(2));
    expect(screen.queryByRole("button", { name: "Merge reviewed commit" })).toBeNull();
  });

  it("names the default branch generically when the viewer can't read the repository", async () => {
    reads.repository = () => refused(403, "not_allowed");
    await open();
    expect(await screen.findByRole("button", { name: "Merge reviewed commit" })).toHaveAccessibleDescription(/into the repository's default branch\. Approval/);
  });
});

describe("who is offered it, as a convenience", () => {
  const base = task();
  it.each([
    ["not requested", change(), true],
    ["failed, may ask again", change({ merge_state: "failed", merge_reason: "provider_refused" }), true],
    ["failed after the commit changed", change({ merge_state: "failed", merge_reason: "commit_changed" }), false],
    ["commit changed", change({ commit_changed: true }), false],
    ["requested", change({ merge_state: "requested" }), false],
    ["outcome unknown", change({ merge_state: "outcome_unknown" }), false],
    ["merged", change({ merge_state: "succeeded" }), false],
    ["unwatched", change({ watched: false }), false],
    ["no reviewed commit", change({ reviewed_commit_sha: null }), false],
  ] as const)("%s", (_name, c, offered) => {
    expect(mergeOffered(base, c, "per_me", true)).toBe(offered);
  });

  it("never to the assignee, without a grant, or before approval", () => {
    expect(mergeOffered(base, change(), "agt_a", true)).toBe(false);
    expect(mergeOffered(base, change(), "per_me", false)).toBe(false);
    expect(mergeOffered(task({ approved_submission_no: null }), change(), "per_me", true)).toBe(false);
  });
});

describe("each merge state, with its times", () => {
  it.each([
    ["requested", { merge_state: "requested", merge_requested_at: 1 }, "Merge requested", /Asked for/],
    ["outcome unknown", { merge_state: "outcome_unknown", merge_requested_at: 1 }, "Merge outcome unknown", /couldn't read GitHub to see what it did/],
    ["merged", { merge_state: "succeeded", merge_requested_at: 1, merge_finished_at: 2, merge_sha: "f".repeat(40) }, "Merged", /Ended/],
    ["failed", { merge_state: "failed", merge_reason: "base_changed", merge_requested_at: 1, merge_finished_at: 2 }, "Merge failed", /The merge didn't happen: the pull request's base changed since review\./],
    ["merged outside Podster", { merge_state: "succeeded", merge_reason: "unrequested_merge", merge_observed_at: 3 }, "Merged outside Podster", /Seen on GitHub/],
  ] as const)("%s", async (_name, over, label, detailText) => {
    const { container } = render(<TaskChangePanel change={change(over as Partial<PullRequestChange>)} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.textContent).toMatch(detailText);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("keeps Commit changed visible until a merge is asked for", () => {
    expect(mergeLabel(change({ commit_changed: true }))).toBe("Commit changed");
  });
});

describe("every code as a sentence", () => {
  it("names every refusal mergeTask lists", () => {
    const generic = explainMergeRefusal("something_new");
    const codes = ["task_not_found", "grant_required", "grant_expired", "grant_stale", "public_participant", "self_merge", "self_review", REVIEW_AGAIN, REVIEWER_UNKNOWN, "controller_departed", "task_not_linked", "repo_not_ready", "not_approved", "submission_mismatch", "commit_changed", "review_required", "change_unwatched", "change_not_found", "merge_already_requested", "already_merged", "standing_unknown", "rate_limited", "merge_request_limit", "merge_unavailable", "invalid_argument", "access_revoked", "agent_disconnected", "workspace_archived", "not_found", "unknown"];
    const sentences = codes.map((code) => explainMergeRefusal(code));
    for (const [index, text] of sentences.entries()) expect(text, codes[index]).not.toBe(generic);
    expect(new Set(sentences).size).toBe(codes.length);
  });

  it("says a commit approved before Podster recorded its reviewer needs reviewing again, not someone else's review", () => {
    const unrecorded = reviewAgainRefusal({ ok: false, status: 403, code: "self_review", message: "This commit was approved before Podster recorded who reviews a commit, so it needs to be reviewed again before it can be merged." });
    expect(unrecorded.code).toBe(REVIEW_AGAIN);
    expect(explainMergeRefusal(unrecorded.code, 403)).toMatch(/reviewed again/);
    expect(explainMergeRefusal(unrecorded.code, 403)).not.toMatch(/someone other than/);
    // Not independent: someone else's review, as before.
    const dependent = reviewAgainRefusal({ ok: false, status: 403, code: "self_review", message: "This commit needs an approving review from someone other than the person who controls its submitter, or another agent that person controls, before it can be merged." });
    expect(dependent.code).toBe("self_review");
    // An agent reviewer whose controlling person isn't known: its own sentence, neither of the other two.
    const unknown = reviewAgainRefusal({ ok: false, status: 403, code: "self_review", message: "This commit's approving review came from an agent whose controlling person isn't known, so it needs an approving review from someone else before it can be merged." });
    expect(unknown.code).toBe(REVIEWER_UNKNOWN);
    expect(explainMergeRefusal(unknown.code, 403)).toMatch(/controlling person isn't known/);
    expect(explainMergeRefusal(unknown.code, 403)).not.toMatch(/reviewed again/);
  });

  it("says a commit needs a review independent of its submitter's person before it's merged (A1)", () => {
    expect(explainMergeRefusal("self_review", 403)).toMatch(/someone other than the person who controls its submitter/);
    expect(failureSentence("self_review")).toMatch(/independent/);
    // A merge the job ended on a review by an agent whose controlling person isn't known says so too.
    expect(failureSentence("self_review")).toMatch(/an agent whose controlling person isn't known/);
  });

  it("says a request ended by the requester's place in the room for leaving and for being removed alike", () => {
    expect(failureSentence("access_revoked")).toMatch(/left or been removed/);
  });

  it("names every reason a merge ended without merging", () => {
    const codes = ["commit_changed", "base_changed", "head_repo_changed", "pull_request_closed", "pull_request_draft", "merged_elsewhere", "repo_not_ready", "provider_refused", "merge_attempts_exhausted", "workspace_archived", "room_suspended", "default_branch_changed", "unrequested_merge", "unreviewed_merge"];
    // And every refusal the job's recheck of the requester's authority can end a request with (core's MergeRefusal and GrantRefusal).
    codes.push("access_revoked", "agent_disconnected", "self_merge", "self_review", "controller_departed", "task_not_found", "grant_required", "grant_expired", "grant_stale", "grant_not_found", "public_participant", "repo_not_linked", "task_not_linked", "not_approved", "submission_mismatch", "change_not_found", "review_required", "change_unwatched", "already_merged", "merge_already_requested", "invalid_argument");
    for (const code of codes) expect(failureSentence(code), code).not.toContain("(");
    expect(failureSentence("new_reason")).toBe("the merge stopped (new_reason)");
  });
});
