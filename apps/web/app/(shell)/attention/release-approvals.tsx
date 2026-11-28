"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { ReadFailure } from "@/components/shell/read-failure";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { explainReleaseRefusal, WHAT_AN_APP_IS } from "../w/[id]/settings/release-model";
import { Timestamp } from "../w/[id]/tasks/task-bits";
import { crossRoomTarget, textNameOf, type Names } from "../w/[id]/tasks/task-model";
import { PREVIEW_DIFFERENCES, STORAGE_WARNING } from "../w/[id]/ship/preview-model";
import { approvalBuild, type ApprovalItem } from "./attention-model";
import type { Approvals } from "./load-attention";

export const APPROVALS_UNAVAILABLE = "Release isn't available on this Podster deployment, so no release waits for approval. Nothing is published.";

/** What an approval or a decline answered, in words. Each refusal changes nothing, and says so. */
export function explainApprovalRefusal(code: string, status = 400): string {
  // A 503 the room answers on purpose writes nothing; any other 5xx may have been recorded.
  if (status >= 500 && code !== "standing_unknown" && code !== "release_address_pending") return "We can't tell whether this was recorded. Reload to see where the release stands.";
  switch (code) {
    case "release_not_available":
      return "Approving and declining releases isn't available on this Podster deployment yet. Nothing changed.";
    case "not_allowed":
    case "not_a_participant":
      return "Only the workroom's owner and admins can approve or decline a release, as people. Nothing changed.";
    case "invalid_transition":
      return "This release isn't waiting for approval any more. Reload to see where it stands. Nothing changed.";
    case "release_label_taken":
      return "This app's address can't be used, and Podster's operators have been told. Nothing changed.";
    case "release_address_pending":
      return "Podster is still setting up this app's address. Nothing changed. Try again in a minute.";
    case "release_build_changed":
      return "That isn't the build this release was asked for, so Podster approved nothing. Reload to see the build it names. Nothing changed.";
    default:
      return explainReleaseRefusal(code, status);
  }
}

/** What an approval answered when its recheck found the release can't go ahead: it ended, and nothing is published. */
export const APPROVAL_ENDED = "Podster checked this release again and it can't go ahead, so it has ended. Nothing was published.";

const shortSha = (sha: string) => sha.slice(0, 12);

export function ReleaseApprovals({ approvals, me, names, taskTitles }: { approvals: Approvals; me: string; names: Names; taskTitles: Record<string, string> }) {
  const count = approvals.state === "read" ? <span className="font-normal text-muted-foreground">({approvals.items.length})</span> : null;
  return (
    <section aria-labelledby="approvals-heading" className="space-y-2">
      <h2 id="approvals-heading" className="text-lg font-medium">
        Release approvals {count}
      </h2>
      {approvals.state === "unavailable" ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Unavailable.</span> {APPROVALS_UNAVAILABLE}
        </p>
      ) : null}
      {approvals.state === "none" ? <p className="text-muted-foreground">You don't own or administer a workroom, so no release waits on you.</p> : null}
      {approvals.state === "failed" ? <ReadFailure /> : null}
      {approvals.state === "read" ? <Listed approvals={approvals} me={me} names={names} taskTitles={taskTitles} /> : null}
    </section>
  );
}

function Listed({ approvals, me, names, taskTitles }: { approvals: Extract<Approvals, { state: "read" }>; me: string; names: Names; taskTitles: Record<string, string> }) {
  const { items, failedRooms, fullRooms, uncheckedRooms } = approvals;
  const partial = failedRooms > 0 || fullRooms > 0 || uncheckedRooms > 0;
  return (
    <>
      {failedRooms > 0 ? (
        <div className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          <p>Couldn't check {failedRooms === 1 ? "1 workroom" : `${failedRooms} workrooms`}, so more releases may be waiting.</p>
          <ReadFailure />
        </div>
      ) : null}
      {fullRooms > 0 ? <p className="text-sm text-muted-foreground">{fullRooms === 1 ? "1 workroom has" : `${fullRooms} workrooms have`} more releases waiting than this shows. Decide these to see the rest.</p> : null}
      {uncheckedRooms > 0 ? <p className="text-sm text-muted-foreground">Checked your first workrooms only. {uncheckedRooms === 1 ? "1 more wasn't" : `${uncheckedRooms} more weren't`} checked.</p> : null}
      {items.length === 0 && !partial ? <p className="text-muted-foreground">No release is waiting for your approval.</p> : null}
      {items.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <ApprovalRow key={`${item.workspace}:${item.release.id}`} item={item} me={me} names={names} taskTitle={item.release.task_id ? taskTitles[item.release.task_id] : undefined} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

type Verb = "approve" | "decline";

function ApprovalRow({ item, me, names, taskTitle }: { item: ApprovalItem; me: string; names: Names; taskTitle?: string }) {
  const { workspace, workspaceName, release } = item;
  const router = useRouter();
  const [open, setOpen] = useState<Verb | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One key per release and decision, so a retry after a lost answer is the same request.
  const keys = useRef<Record<Verb, string>>({ approve: crypto.randomUUID(), decline: crypto.randomUUID() });
  const commit = shortSha(release.commit_sha);
  const room = plainName(workspaceName);
  const build = approvalBuild(release);

  const decide = async (verb: Verb) => {
    setSaving(true);
    setProblem(null);
    try {
      // A release made from a preview is approved for exactly the build this dialog showed; any other takes no body.
      const body = verb === "approve" && build !== null ? { build } : undefined;
      const result = await clientCommand<{ state?: string }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/releases/${encodeURIComponent(release.id)}/${verb}`, body, { idempotencyKey: keys.current[verb] });
      if (result.ok) {
        setOpen(null);
        // An approval whose recheck failed ends the release. It is said here, and the list isn't refreshed, which
        // would take the row and what it says away.
        if (result.data?.state === "failed") setProblem(APPROVAL_ENDED);
        else router.refresh();
      } else {
        setOpen(null);
        setProblem(explainApprovalRefusal(result.code, result.status));
      }
    } catch {
      setOpen(null);
      setProblem(explainApprovalRefusal("unknown", 500));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium break-words">
            Release of commit{" "}
            <code className="font-mono" title={release.commit_sha}>
              {commit}
            </code>
          </p>
          <p className="text-sm break-words text-muted-foreground">
            {taskTitle ? <>{plainName(taskTitle)} · </> : null}
            {room} · Asked for by {textNameOf(release.requested_by, me, names)} <Timestamp at={release.requested_at} />
          </p>
          {build ? (
            <p className="text-sm break-words text-muted-foreground">
              From the preview, build{" "}
              <code className="font-mono" title={build}>
                {build.slice(0, 12)}
              </code>
              {release.preview_replaced ? " · the preview now shows a different build" : null}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {release.task_id ? (
            <SheetLink param="task" target={crossRoomTarget(workspace, release.task_id)} aria-label={`Open the task for the release of commit ${commit}`} className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-primary underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-9">
              Open task
            </SheetLink>
          ) : null}
          <Confirm
            verb="approve"
            open={open === "approve"}
            onOpenChange={(next) => !saving && setOpen(next ? "approve" : null)}
            saving={saving}
            onConfirm={() => void decide("approve")}
            trigger={`Approve release of commit ${commit}`}
            title={`Approve the release of commit ${commit}?`}
            description={
              build ? (
                <FromPreview release={release} build={build} commit={commit} room={room} who={textNameOf(release.requested_by, me, names)} />
              ) : (
                <>
                  Podster uploads exactly commit <code className="font-mono">{commit}</code> from {room}&apos;s repository and serves it as the workroom&apos;s app, once it has checked again that release is allowed. {WHAT_AN_APP_IS}
                </>
              )
            }
          />
          <Confirm
            verb="decline"
            open={open === "decline"}
            onOpenChange={(next) => !saving && setOpen(next ? "decline" : null)}
            saving={saving}
            onConfirm={() => void decide("decline")}
            trigger={`Decline release of commit ${commit}`}
            title={`Decline the release of commit ${commit}?`}
            description={<>Nothing is uploaded, and the app goes on serving whatever it served. Someone can ask for a new release later.</>}
          />
        </div>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-status-danger">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const timeOf = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The approval dialog for a release made from a preview (the plan's section 10; decisions 255 and 259): the build in full,
 * its commit, when it reached the preview, who asked, a warning if the preview has since moved on, and how the preview
 * differed from production. The notices are this page's own copy of core's fixed words (`podster_core::preview_build`):
 * the server's `preview_notice` and `storage_notice` only say the same, and nothing the server sent is shown as words.
 */
function FromPreview({ release, build, commit, room, who }: { release: ItemRelease; build: string; commit: string; room: string; who: string }) {
  const tested = release.preview_served_at ?? null;
  return (
    <span className="block space-y-2">
      {release.preview_replaced ? (
        <span role="note" className="block rounded-md bg-status-amber-surface p-2 text-status-amber">
          The preview now shows a different build. You are approving <code className="font-mono break-all">{build}</code>
          {tested !== null ? <>, which was tested on {dateOf(tested)}</> : null}.
        </span>
      ) : null}
      <span className="block">
        Podster puts exactly build <code className="font-mono break-all">{build}</code> live as {room}&apos;s app, once it has checked again that release is allowed and that the build it fetches is this one.
      </span>
      <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <span>Commit</span>
        <code className="font-mono">{commit}</code>
        <span>On the preview</span>
        <span>{tested !== null ? timeOf(tested) : "Not recorded"}</span>
        <span>Asked for by</span>
        <span className="break-words">{who}</span>
      </span>
      <span className="block">{PREVIEW_DIFFERENCES}</span>
      {release.storage_warning === true ? <span className="block text-status-amber">{STORAGE_WARNING}</span> : null}
      <span className="block">{WHAT_AN_APP_IS}</span>
    </span>
  );
}

type ItemRelease = ApprovalItem["release"];

function Confirm({ verb, open, onOpenChange, saving, onConfirm, trigger, title, description }: { verb: Verb; open: boolean; onOpenChange: (open: boolean) => void; saving: boolean; onConfirm: () => void; trigger: string; title: string; description: React.ReactNode }) {
  const label = verb === "approve" ? "Approve" : "Decline";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" variant={verb === "approve" ? "default" : "outline"} aria-label={trigger} disabled={saving} className="max-md:h-11 max-md:px-4">
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onEscapeKeyDown={(event) => saving && event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={saving}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {saving ? (verb === "approve" ? "Approving…" : "Declining…") : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
