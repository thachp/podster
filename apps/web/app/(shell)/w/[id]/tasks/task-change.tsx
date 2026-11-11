import { Timestamp } from "./task-bits";

/** A task's pull request as Podster last read it from GitHub (M5 step 7a). IDs, commit IDs, states and times only. */
export type PullRequestChange = {
  provider_repo_id: number;
  pr_number: number;
  submission_no: number;
  pr_state: "open" | "closed" | "merged" | null;
  pr_draft: boolean | null;
  pr_observed_at: number | null;
  commit_changed_at: number | null;
  watched: boolean;
  observed_head_sha: string | null;
  head_observed_at: number | null;
  head_in_repository: boolean | null;
  base_is_default: boolean | null;
  observed_base_sha: string | null;
  reviewed_commit_sha: string | null;
  reviewed_base_sha: string | null;
  commit_changed: boolean;
  merge_state: "not_requested" | "requested" | "succeeded" | "failed";
  merge_reason: string | null;
  merge_sha: string | null;
  merge_observed_at: number | null;
};

/** docs/spec/DESIGN.md section 4's merge stage. "Commit changed" outranks the rest until a merge is recorded. */
export function mergeLabel(change: Pick<PullRequestChange, "merge_state" | "merge_reason" | "commit_changed">) {
  if (change.merge_reason === "unrequested_merge" || change.merge_reason === "unreviewed_merge") return "Merged outside Podster";
  if (change.merge_state === "succeeded") return "Merged";
  if (change.merge_state === "failed") return "Merge failed";
  if (change.commit_changed) return "Commit changed";
  if (change.merge_state === "requested") return "Merging";
  return "Not requested";
}

const PR_STATES: Record<string, string> = { open: "Open", closed: "Closed", merged: "Merged" };

/** A commit ID as data: only hex is shown, and only its first 12 characters, with the whole on hover. */
function Commit({ sha }: { sha: string | null }) {
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return <span className="text-muted-foreground">Not seen</span>;
  return (
    <code className="font-mono" title={sha}>
      {sha.slice(0, 12)}
    </code>
  );
}

/**
 * The Release panel's pull request and merge stage, read-only. No merge control here yet: merging is M5 step 7b. Nothing
 * from the pull request's content is shown, because the API keeps none of it.
 */
export function TaskChangePanel({ change }: { change: PullRequestChange }) {
  const pr = change.pr_state ? `${PR_STATES[change.pr_state] ?? change.pr_state}${change.pr_draft ? " · Draft" : ""}` : "Not read yet";
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Release</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Pull request</dt>
        <dd>
          #{change.pr_number} · {pr}
          {change.pr_observed_at ? (
            <span className="block text-xs text-muted-foreground">
              Last read <Timestamp at={change.pr_observed_at} />
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Head commit</dt>
        <dd>
          <Commit sha={change.observed_head_sha} />
          {change.head_observed_at ? (
            <span className="block text-xs text-muted-foreground">
              Seen <Timestamp at={change.head_observed_at} />
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Reviewed commit</dt>
        <dd>{change.reviewed_commit_sha ? <Commit sha={change.reviewed_commit_sha} /> : <span className="text-muted-foreground">Not approved yet</span>}</dd>
        <dt className="text-muted-foreground">Merge</dt>
        <dd>
          {mergeLabel(change)}
          {change.merge_sha ? (
            <span className="block text-xs text-muted-foreground">
              Merge commit <Commit sha={change.merge_sha} />
            </span>
          ) : null}
        </dd>
      </dl>
      {change.commit_changed ? (
        <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          Commit changed: the pull request&apos;s head moved off the reviewed commit{change.commit_changed_at ? <> <Timestamp at={change.commit_changed_at} /></> : null}. The approval stands for the commit it named, and the way on is a follow-up task.
        </p>
      ) : null}
      {change.head_in_repository === false ? <p className="text-sm text-status-amber">The head branch is no longer in this workroom&apos;s repository.</p> : null}
      {change.base_is_default === false ? <p className="text-sm text-status-amber">The pull request no longer targets the repository&apos;s default branch.</p> : null}
      {!change.watched ? <p className="text-sm text-muted-foreground">GitHub answered not found several times, so Podster stopped reading this pull request.</p> : null}
      <p className="text-xs text-muted-foreground">What GitHub showed when Podster last read it. GitHub is the source of truth.</p>
    </section>
  );
}
