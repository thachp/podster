import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mergeLabel, TaskChangePanel, type PullRequestChange } from "./task-change";

const HEAD = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const change = (over: Partial<PullRequestChange> = {}): PullRequestChange => ({
  provider_repo_id: 1,
  pr_number: 7,
  submission_no: 1,
  pr_state: "open",
  pr_draft: false,
  pr_observed_at: Date.UTC(2026, 10, 10),
  commit_changed_at: null,
  watched: true,
  observed_head_sha: HEAD,
  head_observed_at: Date.UTC(2026, 10, 10),
  head_in_repository: true,
  base_is_default: true,
  observed_base_sha: null,
  reviewed_commit_sha: null,
  reviewed_base_sha: null,
  commit_changed: false,
  merge_state: "not_requested",
  merge_reason: null,
  merge_sha: null,
  merge_observed_at: null,
  ...over,
});

describe("a task's pull request, read-only", () => {
  it("shows the pull request, the head commit and the merge stage, with no merge control", () => {
    render(<TaskChangePanel change={change()} />);
    expect(screen.getByRole("heading", { name: "Release" })).toBeInTheDocument();
    expect(screen.getByText(/#7 · Open/)).toBeInTheDocument();
    expect(screen.getByText(HEAD.slice(0, 12))).toHaveAttribute("title", HEAD);
    expect(screen.getByText("Not approved yet")).toBeInTheDocument();
    expect(screen.getByText("Not requested")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says Commit changed as a label and in words when the head moved off the reviewed commit", () => {
    render(<TaskChangePanel change={change({ reviewed_commit_sha: HEAD, commit_changed: true, commit_changed_at: Date.UTC(2026, 10, 10), observed_head_sha: "f".repeat(40) })} />);
    expect(screen.getByText("Commit changed")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/head moved off the reviewed commit/);
  });

  it("keeps the merge stages apart, and never counts a merge Podster didn't ask for as a success", () => {
    expect(mergeLabel(change({ merge_state: "succeeded" }))).toBe("Merged");
    expect(mergeLabel(change({ merge_state: "failed" }))).toBe("Merge failed");
    expect(mergeLabel(change({ merge_state: "requested" }))).toBe("Merge requested");
    expect(mergeLabel(change({ merge_state: "succeeded", merge_reason: "unrequested_merge" }))).toBe("Merged outside Podster");
    expect(mergeLabel(change({ merge_state: "not_requested", merge_reason: "unreviewed_merge" }))).toBe("Merged outside Podster");
  });

  it("shows a draft, a moved branch, a changed base and an unwatched pull request", () => {
    render(<TaskChangePanel change={change({ pr_draft: true, head_in_repository: false, base_is_default: false, watched: false })} />);
    expect(screen.getByText(/#7 · Open · Draft/)).toBeInTheDocument();
    expect(screen.getByText(/head branch is no longer/)).toBeInTheDocument();
    expect(screen.getByText(/no longer targets the repository's default branch/)).toBeInTheDocument();
    expect(screen.getByText(/stopped reading this pull request/)).toBeInTheDocument();
  });

  it("shows a commit ID only if it looks like one, so other text never renders", () => {
    render(<TaskChangePanel change={change({ observed_head_sha: "<img src=x onerror=alert(1)>" })} />);
    expect(screen.getByText("Not seen")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
