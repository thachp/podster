"use client";

import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { visibleText } from "@/lib/public/visible-text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import type { RepoGrant, RoomRepository } from "../settings/repository-model";
import type { LoadedTask } from "./task-sheet";
import type { PullRequestChange } from "./task-change";

/** Every refusal `mergeTask` lists in the contract, and the ones its checks share with other commands, as sentences. */
export function explainMergeRefusal(code: string, status = 400): string {
  switch (code) {
    case "unknown":
      return "We can't tell whether the merge was asked for. Reload the task: if it was, it shows as requested.";
    case "merge_unavailable":
      return "Podster's merge isn't set up right now, so nothing was asked for.";
    case "standing_unknown":
      return "Podster couldn't confirm the workroom owner's standing, so nothing was asked for. Try again in a minute.";
    case "grant_required":
      return "You don't hold a merge grant for this workroom's repository. Its owner grants one on Team. Nothing was asked for.";
    case "grant_expired":
      return "Your merge grant has expired. The workroom's owner can grant it again. Nothing was asked for.";
    case "grant_stale":
      return "Your merge grant came from an owner who no longer holds the repository's delegation. The current owner can grant it again. Nothing was asked for.";
    case "public_participant":
      return "You joined this workroom from its public page, so you can't merge its work. Nothing was asked for.";
    case "self_merge":
      return "You can't merge this task: you, or the person who controls you, also control whoever submitted it. Someone else with a merge grant can. Nothing was asked for.";
    case "self_review":
      return "This commit can't be merged yet: it needs an approving review from someone other than the person who controls its submitter, or one of their agents. Nothing was asked for.";
    case REVIEWER_UNKNOWN:
      return "This commit's approving review came from an agent whose controlling person isn't known, so it needs an approving review from someone else before it can be merged. Nothing was asked for.";
    case REVIEW_AGAIN:
      return "This commit was approved before Podster recorded who reviews a commit, so it needs to be reviewed again before it can be merged. Nothing was asked for.";
    case "controller_departed":
      return "You can't merge this task: the person you act for has left the organization. Nothing was asked for.";
    case "task_not_linked":
      return "This task isn't linked to the workroom's repository, so there's nothing to merge.";
    case "repo_not_ready":
      return "The workroom's repository isn't ready: it may be degraded or suspended. Nothing was asked for. Its owner can see why in Settings.";
    case "not_approved":
      return "This task has no approved submission yet, so there's nothing to merge.";
    case "submission_mismatch":
      return "The approved submission isn't the one shown here any more. Reload the task. Nothing was asked for.";
    case "commit_changed":
      return "The pull request's head has moved off the reviewed commit, so it can't be merged. The way on is a follow-up task with its own review.";
    case "change_not_found":
      return "This task has no pull request on the workroom's repository, so there's nothing to merge.";
    case "review_required":
      return "This approval was made before Podster read the pull request, so it needs a fresh review before it can be merged.";
    case "change_unwatched":
      return "Podster stopped reading this pull request after GitHub kept answering that it wasn't there, so it can't be merged.";
    case "merge_already_requested":
      return "A merge is already under way, or its outcome isn't known yet. Reload to see where it stands.";
    case "already_merged":
      return "This task is already merged.";
    case "merge_request_limit":
      return "This task has been asked to merge as many times as a task is allowed. Nothing was asked for.";
    case "rate_limited":
      return "Too many merges were asked for in this workroom in the last hour. Wait and try again. Nothing was asked for.";
    case "access_revoked":
      return "You're no longer in this workroom, so you can't merge its work.";
    case "agent_disconnected":
      return "This agent's connection has ended, so it can't merge.";
    case "task_not_found":
      return "This task isn't available to you any more.";
    case "invalid_argument":
      return "The reviewed commit isn't a full commit ID, so nothing was asked for. Reload the task.";
    case "workspace_archived":
      return "This workroom is archived, so nothing new can happen in it. Nothing was asked for.";
    case "not_found":
      return "Merging isn't available right now. Nothing was asked for.";
    default:
      return status >= 500 ? "We can't tell whether the merge was asked for. Reload the task: if it was, it shows as requested." : "The merge wasn't asked for. You may no longer be allowed to do this.";
  }
}

/** Why a requested merge ended without merging, from `merge_reason`. Never the provider's own text. */
const FAILURES: Record<string, string> = {
  commit_changed: "the pull request's head moved off the reviewed commit, so the way on is a follow-up task",
  base_changed: "the pull request's base changed since review",
  head_repo_changed: "the pull request's head moved to another repository",
  pull_request_closed: "the pull request was closed",
  pull_request_draft: "the pull request went back to draft",
  merged_elsewhere: "the pull request was merged some other way",
  repo_not_ready: "the workroom's repository wasn't ready",
  provider_refused: "GitHub refused the merge",
  merge_attempts_exhausted: "Podster tried as many times as it's allowed, so someone needs to ask again",
  workspace_archived: "the workroom was archived",
  room_suspended: "the workroom was suspended",
  default_branch_changed: "the repository's default branch changed, so Podster marked the repository degraded",
  unrequested_merge: "it was merged outside Podster",
  // The job rechecks the requester's authority before its call, and these are the refusals that end a request there.
  access_revoked: "whoever asked was no longer in the workroom when it ran, having left or been removed",
  agent_disconnected: "the agent that asked was disconnected before it ran",
  self_merge: "whoever asked turned out to control the task's submitter, and nobody merges work they control",
  self_review: "the commit's approving review came from the person who controls its submitter or one of their agents, or was approved before Podster recorded who reviews, and a merge needs an independent review, given again if it wasn't recorded",
  controller_departed: "the person whoever asked acts for had left the organization",
  task_not_found: "whoever asked could no longer see the task",
  grant_required: "whoever asked no longer held a merge grant when it ran",
  grant_expired: "whoever asked had a merge grant that expired before it ran",
  grant_stale: "whoever asked had a merge grant from an owner who no longer holds the repository's delegation",
  grant_not_found: "whoever asked no longer held a merge grant when it ran",
  public_participant: "whoever asked is in the workroom through a public claim, which can't merge",
  repo_not_linked: "the workroom's repository was no longer linked",
  task_not_linked: "the task was no longer linked to the workroom's repository",
  not_approved: "the task was no longer approved",
  submission_mismatch: "the approved submission changed before it ran",
  change_not_found: "Podster no longer had the task's pull request on record",
  review_required: "the approval needs a fresh review before a merge",
  change_unwatched: "Podster stopped reading the pull request",
  already_merged: "the task was already merged",
  merge_already_requested: "another merge was already under way",
  invalid_argument: "the reviewed commit wasn't a full commit ID",
  unreviewed_merge: "a commit nobody reviewed was merged outside Podster",
};

/**
 * `self_review` for an approval recorded before Podster kept who reviewed it: the same code, which the server tells apart
 * by its message (decision 195). Asking for someone else's review would mislead whoever reviewed it independently, so
 * the control says to review it again. A code of this screen's own, never sent by the server.
 */
export const REVIEW_AGAIN = "self_review_again";
/** `self_review` for a review by an agent whose controlling person isn't known, told apart the same way. */
export const REVIEWER_UNKNOWN = "self_review_reviewer_unknown";
export const reviewAgainRefusal = <T extends { ok: boolean; code?: string; message?: string }>(result: T): T => {
  if (result.ok || result.code !== "self_review") return result;
  if (/reviewed again/.test(result.message ?? "")) return { ...result, code: REVIEW_AGAIN };
  if (/controlling person isn't known/.test(result.message ?? "")) return { ...result, code: REVIEWER_UNKNOWN };
  return result;
};

/** These 503s are answered before anything is recorded, so they're definite refusals, not unknown outcomes. */
const NOTHING_RECORDED = new Set(["merge_unavailable", "standing_unknown"]);
export const definiteMergeRefusal = <T extends { ok: boolean; status?: number; code?: string }>(result: T): T => (!result.ok && result.code && NOTHING_RECORDED.has(result.code) ? { ...result, status: 409 } : result);

export const failureSentence = (code: string | null) => (code && FAILURES[code]) ?? (code ? `the merge stopped (${code})` : "the merge stopped");

/** Commits are shown only as hex, cut to 12 characters. */
export const shortSha = (sha: string | null | undefined) => (sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 12) : null);

/**
 * Whether to offer the merge control. Convenience only: the API checks the grant, the submitter rule, the approval, the
 * reviewed commit and the repository again when asked, and again in its job.
 */
export function mergeOffered(task: LoadedTask["task"], change: PullRequestChange, me: string, holdsMerge: boolean) {
  if (!holdsMerge || task.assignee === me) return false;
  if (typeof task.approved_submission_no !== "number" || !shortSha(change.reviewed_commit_sha)) return false;
  if (change.commit_changed || !change.watched) return false;
  if (change.merge_state === "not_requested") return true;
  // A failed merge may be asked for again, except after the commit changed.
  return change.merge_state === "failed" && change.merge_reason !== "commit_changed" && change.merge_reason !== "unrequested_merge" && change.merge_reason !== "unreviewed_merge";
}

/** A live merge grant of the viewer's own, by the list's display state. Convenience only. */
export const holdsMergeGrant = (grants: RepoGrant[], me: string) => grants.some((grant) => grant.principal_id === me && grant.action === "merge" && grant.state === "live");

/**
 * The merge control (M5 step 9(b), step 7b's route). It reads the viewer's grants and the repository only for a task with
 * an approved, linked change, and asks nothing while managed repositories are off, since such a task read has no `change`.
 */
export function MergeControl({ api, me }: { api: SheetApi<LoadedTask>; me: string }) {
  const { data, run, saving } = api;
  const change = data.change;
  const [holds, setHolds] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const commit = change ? shortSha(change.reviewed_commit_sha) : null;
  // One key per intent: the same task, submission and commit, and the same attempt. A retry after a lost answer reuses it;
  // asking again after a merge ended is a new attempt, named by when the last one ended or was asked for, so it gets a new key.
  const attempt = change ? (change.merge_finished_at ?? change.merge_requested_at ?? 0) : 0;
  const intent = `${data.task.id}:${data.task.approved_submission_no}:${change?.reviewed_commit_sha}:${attempt}`;
  const key = useRef({ intent, value: crypto.randomUUID() });
  if (key.current.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
  const candidate = change !== null && change !== undefined && typeof data.task.approved_submission_no === "number" && commit !== null && data.task.assignee !== me;

  useEffect(() => {
    if (!candidate) return;
    const controller = new AbortController();
    const base = `/api/v1/workspaces/${encodeURIComponent(data.workspace)}/repository`;
    void Promise.all([clientQuery<{ grants: RepoGrant[] }>(`${base}/grants`, { signal: controller.signal }), clientQuery<RoomRepository>(base, { signal: controller.signal })])
      .then(([grants, repository]) => {
        if (controller.signal.aborted) return;
        setHolds(grants.ok && holdsMergeGrant(grants.data.grants, me));
        setBranch(repository.ok && repository.data.repository ? visibleText(repository.data.repository.default_branch) : null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [candidate, data.workspace, me]);

  if (!change || !mergeOffered(data.task, change, me, holds)) return null;
  const target = branch ? `the repository's default branch, ${branch}` : "the repository's default branch";

  const merge = async () => {
    await run(
      async () => reviewAgainRefusal(definiteMergeRefusal(await clientCommand(`/api/v1/workspaces/${encodeURIComponent(data.workspace)}/tasks/${encodeURIComponent(data.task.id)}/merge`, { submission_no: data.task.approved_submission_no, commit_sha: change.reviewed_commit_sha }, { idempotencyKey: key.current.value }))),
      explainMergeRefusal,
    );
    setOpen(false);
  };

  return (
    <div className="space-y-2">
      <p id="merge-what" className="text-sm text-muted-foreground">
        Merging asks Podster to merge reviewed commit {commit} into {target}. Approval alone never merges.
      </p>
      <AlertDialog open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <AlertDialogTrigger asChild>
          <Button type="button" size="sm" aria-describedby="merge-what" disabled={saving} className="max-md:h-11 max-md:px-4">
            {change.merge_state === "failed" ? "Ask to merge again" : "Merge reviewed commit"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent onEscapeKeyDown={(event) => saving && event.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Merge reviewed commit {commit}?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              Podster merges exactly commit <code className="font-mono">{commit}</code>, the one approved in submission {data.task.approved_submission_no}, into {target}, as a merge commit. If the pull request has changed since review, nothing is merged. The repository is public, so the merge is public as soon as it lands.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                void merge();
              }}
            >
              {saving ? "Asking…" : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
