"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { visibleText } from "@/lib/public/visible-text";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD, MOBILE_TARGET } from "../team/field";
import { StateBadge } from "../settings/state-badge";
import { timeOf } from "../settings/release-model";
import {
  commitUrl,
  explainPreviewRefusal,
  explainPublishRefusal,
  failureWords,
  hostLink,
  HOSTNAME_SETUP_WORDS,
  mergedCommit,
  OPENING_NEEDS_ACCESS,
  PREVIEW_HIDDEN,
  PREVIEW_HOSTNAME_PENDING,
  PREVIEW_UNAVAILABLE,
  PREVIEWS_ARENT_PRODUCTION,
  PREVIEWS_OFF,
  previewState,
  PRIVATE_CANT_PUBLISH,
  shortBuild,
  shortCommit,
  STORAGE_WARNING,
  STORAGE_WARNING_CAVEAT,
  type Preview,
  type PreviewRead,
  type PreviewRelease,
} from "./preview-model";

export type TaskChoice = { id: string; title: string };

/**
 * What the page read besides the preview, each the API's own answer, never a role rule of this page's:
 * - `manages`: the room's release configuration answered this viewer, which it does only for its owner and admins as
 *   people, the same people `requestPreview` and `deletePreview` take. Rust decides both again when asked.
 * - `isPublic`: the room's visibility read, which answers only those who manage it; null where it wasn't answered.
 * - `archived`: the room's status. An archived room takes no new preview.
 * - `repository`: the room's repository's `owner/name`, for commit links only.
 */
export type PreviewSectionProps = { roomId: string; read: PreviewRead; manages: boolean; isPublic: boolean | null; archived: boolean; repository: string | null; tasks: TaskChoice[]; taskTitles: Record<string, string> };

const Row = ({ term, children }: { term: string; children: React.ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{term}</dt>
    <dd className="min-w-0 break-all">{children}</dd>
  </>
);

function CommitRef({ sha, repository }: { sha: string; repository: string | null }) {
  const url = commitUrl(repository, sha);
  const code = (
    <code className="font-mono" title={sha}>
      {shortCommit(sha)}
    </code>
  );
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline" aria-label={`Commit ${shortCommit(sha)} in the repository`}>
      {code}
    </a>
  ) : (
    code
  );
}

function CopyBuild({ build }: { build: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(build);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="font-mono" title={build}>
        {shortBuild(build)}
      </code>
      <Button type="button" variant="outline" size="sm" className={MOBILE_TARGET} aria-label="Copy the full build ID" onClick={() => void copy()}>
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />} Copy
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {state === "copied" ? "Copied." : state === "failed" ? "Couldn't copy. Hover the build to see it in full." : ""}
      </span>
    </span>
  );
}

/**
 * The Ship panel's preview card (M8 step 11; docs/m8-preview-plan.md section 10). Its state is what `getPreview` says,
 * and its controls show only where the API's answers allow them; every command is decided again in Rust, and every
 * refusal is said beside the control that asked. Task titles are shown as plain text, and no host is a link unless it is
 * a plain DNS name the server gave.
 */
export function PreviewSection(props: PreviewSectionProps) {
  const { read } = props;
  if (read.kind === "failed") return <ReadFailure />;
  if (read.kind === "unavailable" || read.kind === "off" || read.kind === "hidden") {
    const text = read.kind === "unavailable" ? PREVIEW_UNAVAILABLE : read.kind === "off" ? PREVIEWS_OFF : PREVIEW_HIDDEN;
    const label = read.kind === "hidden" ? "Not shown to you" : read.kind === "off" ? "Off" : "Unavailable";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge label={label} tone="neutral" />
        <span className="text-sm text-muted-foreground">{text}</span>
      </div>
    );
  }
  return <PreviewCard {...props} preview={read.preview} />;
}

function PreviewCard({ roomId, preview, manages, isPublic, archived, repository, tasks, taskTitles }: PreviewSectionProps & { preview: Preview | null }) {
  const commands = useCommands(null);
  const { send, retrying } = commands;
  const after = useRef<HTMLDivElement>(null);
  const shown = previewState(preview);
  const serving = preview?.serving ?? null;
  const next = preview?.replacement ?? null;
  const titleOf = (task: string) => (taskTitles[task] ? plainName(taskTitles[task]) : task);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}`;
  const link = hostLink(preview?.default_host ?? null);
  const custom = preview?.custom_host ?? null;
  const customLink = custom?.setup_status === "active" ? hostLink(custom.hostname) : null;
  // Only while the read says nothing is in flight or being deleted; the API refuses `preview_in_flight` either way.
  const settled = shown.state === "none" || shown.state === "ready" || shown.state === "replacement-failed" || shown.state === "first-failed";
  const mayAsk = manages && !archived && settled;
  const mayDelete = manages && preview !== null && preview.state === "active";

  const remove = () => send(`${base}/preview`, {}, "The preview is being deleted. Its addresses stop answering, and production is unchanged.", { method: "DELETE", explain: explainPreviewRefusal });

  return (
    <div className="space-y-3">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge label={shown.label} tone={shown.tone} />
        <span className="text-sm">{stateText(shown.state)}</span>
      </div>

      {shown.state === "building" && next ? (
        <p className="text-sm">
          Building {titleOf(next.task_id)} at <CommitRef sha={next.commit_sha} repository={repository} />. It isn&apos;t served yet.
        </p>
      ) : null}
      {shown.state === "first-failed" && next ? (
        <p className="text-sm text-status-amber">
          Making a preview of <CommitRef sha={next.commit_sha} repository={repository} /> failed: {failureWords(next.failure_code)}. Nothing is served.
        </p>
      ) : null}

      {serving ? <Serving serving={serving} repository={repository} title={titleOf(serving.task_id)} /> : null}
      {shown.state === "replacing" && next && serving ? (
        <p className="text-sm">
          Replacing with <CommitRef sha={next.commit_sha} repository={repository} />. The preview still shows <CommitRef sha={serving.commit_sha} repository={repository} /> until the new build answers.
        </p>
      ) : null}
      {shown.state === "replacement-failed" && next && serving ? (
        <p className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          Replacing with <CommitRef sha={next.commit_sha} repository={repository} /> failed: {failureWords(next.failure_code)}. The preview still shows <CommitRef sha={serving.commit_sha} repository={repository} />.
        </p>
      ) : null}

      {serving && preview?.state === "active" ? (
        <div className="space-y-1">
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center text-primary underline">
              Open preview
            </a>
          ) : null}
          {preview.default_host ? (
            <p className="text-sm">
              <code className="font-mono break-all">{visibleText(preview.default_host)}</code> <span className="text-muted-foreground">{OPENING_NEEDS_ACCESS}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">This Podster deployment has no app domain set up, so the preview has no address yet.</p>
          )}
          <div className="space-y-1 rounded-lg border p-3 text-sm">
            <p className="font-medium">Previews aren&apos;t production</p>
            <p className="text-muted-foreground">{PREVIEWS_ARENT_PRODUCTION}</p>
            {serving.storage_warning === true ? (
              <p className="text-status-amber">
                {STORAGE_WARNING} {STORAGE_WARNING_CAVEAT}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {preview !== null && preview.state === "active" ? (
        <section aria-label="Custom preview hostname" className="space-y-1">
          <h3 className="font-medium">Custom preview hostname</h3>
          {custom ? (
            <p className="text-sm">
              {customLink ? (
                <a href={customLink} target="_blank" rel="noopener noreferrer" className="font-mono break-all text-primary underline">
                  {visibleText(custom.hostname)}
                </a>
              ) : (
                <code className="font-mono break-all">{visibleText(custom.hostname)}</code>
              )}{" "}
              · {HOSTNAME_SETUP_WORDS[custom.setup_status]}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">None. It would be separate from the app&apos;s own custom domain.</p>
          )}
          {/* M8 step 10: Connect, Check now and Disconnect go here, on getPreviewHostname and its commands, once they're built. */}
          {manages ? <p className="text-sm text-muted-foreground">{PREVIEW_HOSTNAME_PENDING}</p> : null}
        </section>
      ) : null}

      {mayAsk ? <AskPreview roomId={roomId} tasks={tasks} replacing={serving !== null} repository={repository} send={send} retrying={retrying} after={after} /> : null}
      {manages && archived ? <p className="text-sm text-muted-foreground">This workroom is archived, so it can&apos;t make a new preview. Its preview can still be deleted.</p> : null}

      {mayDelete ? (
        <ConfirmAction
          label="Delete preview"
          variant="destructive"
          destructive
          disabled={retrying}
          title="Delete this workroom's preview?"
          description="Its addresses stop answering, its custom preview hostname is disconnected, and its store's data is deleted. Production is unchanged. A publish already asked for from it still waits for approval of its own build."
          confirm="Delete preview"
          action={remove}
          focusAfter={after}
        />
      ) : null}

      {serving && serving.build_id && preview?.state === "active" ? <Publish roomId={roomId} serving={serving} build={serving.build_id} manages={manages} isPublic={isPublic} archived={archived} /> : null}
    </div>
  );
}

function stateText(state: ReturnType<typeof previewState>["state"]) {
  switch (state) {
    case "none":
      return "This workroom has no preview. A preview runs a finished task's merged commit where only people with a role here can open it. Customers never see it.";
    case "building":
      return "Podster is making the first preview.";
    case "first-failed":
      return "The first preview didn't serve.";
    case "ready":
      return "The preview serves the build below, to people with a role in this workroom.";
    case "replacing":
      return "A new build is on its way. The preview keeps serving the current one until the new one answers.";
    case "replacement-failed":
      return "The last replacement failed, so the preview still serves the build below.";
    default:
      return "Podster is taking the preview down. Production is unchanged.";
  }
}

function Serving({ serving, repository, title }: { serving: PreviewRelease; repository: string | null; title: string }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <Row term="Commit">
        <CommitRef sha={serving.commit_sha} repository={repository} /> · {title}
      </Row>
      <Row term="Build">{serving.build_id ? <CopyBuild build={serving.build_id} /> : <span className="text-muted-foreground">Not recorded</span>}</Row>
      {serving.served_at !== null ? <Row term="On the preview since">{timeOf(serving.served_at)}</Row> : null}
    </dl>
  );
}

type Send = ReturnType<typeof useCommands>["send"];

/**
 * Create or replace: pick a completed task, then its merged commit is read from the task itself. Only a commit Podster's
 * merge recorded is offered; the API checks it again (`commit_not_releasable`).
 */
function AskPreview({ roomId, tasks, replacing, repository, send, retrying, after }: { roomId: string; tasks: TaskChoice[]; replacing: boolean; repository: string | null; send: Send; retrying: boolean; after: React.RefObject<HTMLDivElement | null> }) {
  const ids = { pick: useId(), status: useId() };
  const [task, setTask] = useState("");
  const [commit, setCommit] = useState<{ task: string; sha: string | null } | "reading" | "failed" | null>(null);

  useEffect(() => {
    if (task === "") {
      setCommit(null);
      return;
    }
    const controller = new AbortController();
    setCommit("reading");
    void clientQuery<unknown>(`/api/v1/workspaces/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(task)}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCommit(result.ok ? { task, sha: mergedCommit(result.data) } : "failed");
      })
      .catch(() => {
        if (!controller.signal.aborted) setCommit("failed");
      });
    return () => controller.abort();
  }, [roomId, task]);

  if (tasks.length === 0) return <p className="text-sm text-muted-foreground">No finished task here yet, so there&apos;s nothing merged to preview.</p>;
  const verb = replacing ? "Replace preview" : "Make a preview";
  const ready = typeof commit === "object" && commit !== null && commit.sha !== null && commit.task === task ? commit.sha : null;
  const ask = () =>
    send(`/api/v1/workspaces/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(task)}/preview`, { commit_sha: ready }, replacing ? "Asked. The preview keeps serving the current build until the new one answers." : "Asked. Podster is making the preview.", {
      explain: explainPreviewRefusal,
      onOk: () => setTask(""),
    });

  return (
    <div className="space-y-2">
      <label htmlFor={ids.pick} className="text-sm font-medium">
        {replacing ? "Replace the preview with a finished task" : "Make a preview of a finished task"}
      </label>
      <select id={ids.pick} className={`${FIELD} max-w-md`} value={task} disabled={retrying} aria-describedby={ids.status} onChange={(event) => setTask(event.target.value)}>
        <option value="">Choose a task</option>
        {tasks.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {plainName(choice.title)}
          </option>
        ))}
      </select>
      <p id={ids.status} role="status" className="text-sm text-muted-foreground">
        {commit === "reading" ? "Reading its merged commit…" : null}
        {commit === "failed" ? "Podster couldn't read that task just now. Choose it again to retry." : null}
        {typeof commit === "object" && commit !== null && commit.sha === null ? "Podster hasn't recorded a merged commit for that task, so it can't be previewed." : null}
        {ready ? (
          <>
            Merged commit <CommitRef sha={ready} repository={repository} />.
          </>
        ) : null}
      </p>
      {ready ? (
        <ConfirmAction
          label={verb}
          disabled={retrying}
          title={replacing ? "Replace the preview with this commit?" : "Make a preview of this commit?"}
          description={
            replacing
              ? `Podster builds commit ${shortCommit(ready)} with the preview's own store, apart from production's. The preview keeps serving its current build until the new one answers, and production doesn't move.`
              : `Podster builds commit ${shortCommit(ready)} with a store of its own, apart from production's, and serves it only to people with a role in this workroom. Production doesn't move.`
          }
          confirm={verb}
          action={ask}
          focusAfter={after}
        />
      ) : null}
    </div>
  );
}

/**
 * Publish this build: a release of the preview's own task and commit naming the preview release, so the approval binds to
 * its build. Offered where the room's visibility read said public; a private room says why it can't. Whether this person
 * may ask, by a deployment grant, is the API's to say, and it says it here if not.
 */
function Publish({ roomId, serving, build, manages, isPublic, archived }: { roomId: string; serving: PreviewRelease; build: string; manages: boolean; isPublic: boolean | null; archived: boolean }) {
  const commands = useCommands(null);
  const { send, retrying } = commands;
  const after = useRef<HTMLDivElement>(null);
  if (!manages || archived) return null;
  if (isPublic === false) return <p className="text-sm text-muted-foreground">{PRIVATE_CANT_PUBLISH}</p>;
  if (isPublic !== true) return null;
  const ask = () =>
    send(`/api/v1/workspaces/${encodeURIComponent(roomId)}/releases`, { task_id: serving.task_id, commit_sha: serving.commit_sha, from_preview: serving.id }, `Asked. Build ${shortBuild(build)} waits for the owner or an admin to approve it in Needs attention.`, { explain: explainPublishRefusal });
  return (
    <div className="space-y-2">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      <ConfirmAction
        label="Publish this build"
        disabled={retrying}
        title={`Ask to publish build ${shortBuild(build)}?`}
        description={`Podster puts exactly build ${build} live, once the owner or an admin approves it. Replacing the preview afterwards doesn't change what is approved. ${PREVIEWS_ARENT_PRODUCTION}`}
        confirm="Ask to publish"
        action={ask}
        focusAfter={after}
      />
    </div>
  );
}
