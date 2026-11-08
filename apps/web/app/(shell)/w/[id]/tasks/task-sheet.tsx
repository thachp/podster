"use client";

import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { AgentContent, AuthorLine } from "@/components/agent-content/agent-content";
import { destinationHost, plainName, safeLinkUrl, truncate } from "@/components/agent-content/text";
import { TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { TaskActions, type SavedEdit } from "./task-actions";
import { TaskComposer } from "./task-composer";
import { SubmissionFiles } from "./task-files";
import { TaskPlan } from "./task-plan";
import { ApprovedMark, PrincipalName, TaskStatusBadge, Timestamp } from "./task-bits";
import { briefAuthor, flagText, isArchivedRoom, kindOf, nameOf, roleOf, verbFor, type Artifact, type From, type Names, type Room, type Submission, type TaskDetail, type TaskSummary } from "./task-model";

export type LoadedTask = TaskDetail & { workspace: string; room: Room };

/** How a Sheet's target maps to a task. A workroom's own page passes the room, and anywhere else names it in the target. */
export type TaskSheetProps = {
  me: string;
  names: Names;
  /** Organizations the viewer can name. Any other shows as its ID. */
  orgNames?: Names;
  resolve: (target: string) => { workspace: string; task: string } | null;
  room?: Room;
  /** Whether a task the viewer can read is filtered off the screen behind this Sheet. */
  outsideFilter?: (task: string) => boolean;
  /** Called with each read of the open task and each command's result, so a list past its first page can show what a person just did to it. */
  onTaskRead?: (task: TaskSummary) => void;
};

async function read<T>(path: string, signal: AbortSignal) {
  const result = await clientQuery<T>(path, { signal });
  if (result.ok) return result.data;
  // A lapsed session says nothing about the task, so it signs in again, as a page would. This view is going away, so it never settles.
  if (result.status === 401) {
    goToSignIn();
    return new Promise<never>(() => undefined);
  }
  // An outage isn't "gone". Anything else is one message, whether it's missing or hidden.
  if (result.status >= 500 || result.status === 429) throw new Error(result.code);
  return null;
}

export function TaskSheet({ me, names, orgNames = {}, resolve, room, outsideFilter, onTaskRead }: TaskSheetProps) {
  return (
    <TargetSheet<LoadedTask>
      param="task"
      size="lg"
      noun="task"
      load={async (target, { signal }) => {
        const where = resolve(target);
        if (!where) return null;
        const base = `/api/v1/workspaces/${encodeURIComponent(where.workspace)}`;
        const [detail, loadedRoom] = await Promise.all([read<TaskDetail>(`${base}/tasks/${encodeURIComponent(where.task)}`, signal), room ? room : read<Room>(base, signal)]);
        if (detail) onTaskRead?.(detail.task);
        return detail && loadedRoom ? { ...detail, workspace: where.workspace, room: loadedRoom } : null;
      }}
      title={(data) => plainName(data.task.title)}
      description={(data) => `Workroom: ${plainName(data.room.name)}`}
      version={(data) => data.task.version}
    >
      {(api) => <TaskBody api={api} me={me} names={names} orgNames={orgNames} outside={outsideFilter?.(api.data.task.id) ?? false} onTaskRead={onTaskRead} />}
    </TargetSheet>
  );
}

const isThisTask = (value: unknown, id: string): value is TaskSummary => typeof value === "object" && value !== null && (value as TaskSummary).id === id && typeof (value as TaskSummary).version === "number";

const TAB_CLASS = "min-h-11 flex-1 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-muted sm:min-h-8 sm:flex-none";

function TaskBody({ api, me, names, orgNames, outside, onTaskRead }: { api: SheetApi<LoadedTask>; me: string; names: Names; orgNames: Names; outside: boolean; onTaskRead?: (task: TaskSummary) => void }) {
  const { data } = api;
  const { task } = data;
  // Outlives the action controls, which start fresh for each version, so the result stays on screen.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const label = (id: string) => nameOf(id, me, names);
  const [tab, setTab] = useState("details");
  // A person's edit answers to what they read. Posting a message reloads the task, and that mustn't move a draft underneath them, so the controls hold this until the draft is done.
  const held = useRef(data);
  if (!api.dirty) held.current = data;
  // Survives the controls starting fresh, because "Review latest" keeps the person's input (DESIGN.md, "Saving and conflicts").
  const savedEdit = useRef<SavedEdit | null>(null);
  const returnFocus = useRef(false);
  // A decision removes the button that made it, and focus shouldn't vanish with it. This also lands on the result.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  return (
    <div className="space-y-4">
      {outside ? <p className="rounded-lg bg-muted p-3 text-sm">This task is outside the current filter, so it isn't shown behind this panel.</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          <TaskStatusBadge status={task.status} />
        </dd>
        <dt className="text-muted-foreground">Requester</dt>
        <dd>
          <PrincipalName id={task.requester} label={label(task.requester)} me={me} />
        </dd>
        <dt className="text-muted-foreground">Assignee</dt>
        <dd>{task.assignee ? <PrincipalName id={task.assignee} label={label(task.assignee)} me={me} /> : "Nobody yet"}</dd>
        <dt className="text-muted-foreground">Reviewer</dt>
        <dd>
          <PrincipalName id={task.reviewer} label={label(task.reviewer)} me={me} />
        </dd>
        {task.due_at !== null ? (
          <>
            <dt className="text-muted-foreground">Due</dt>
            <dd>
              <Timestamp at={task.due_at} />
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Task</dt>
        <dd className="truncate" title={task.id}>
          {task.id}
        </dd>
        <dt className="text-muted-foreground">Submission</dt>
        <dd>{task.submission_no > 0 ? task.submission_no : "None yet"}</dd>
      </dl>
      {task.needs_attention ? <p className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">{flagText(task, data.room, me, roleOf(data.room, me))}</p> : null}
      <p ref={noticeRef} tabIndex={-1} role="status" className="rounded-sm text-sm outline-none empty:hidden focus-visible:ring-2 focus-visible:ring-ring">
        {notice}
      </p>

      <TaskPlan api={api} me={me} role={roleOf(data.room, me)} />

      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List aria-label="Task details" className="flex gap-1 border-b pb-1">
          <Tabs.Trigger value="details" className={TAB_CLASS}>
            Details
          </Tabs.Trigger>
          <Tabs.Trigger value="discussion" className={TAB_CLASS}>
            {data.visible?.conversation === false ? "Discussion" : `Discussion (${data.messages.length})`}
          </Tabs.Trigger>
          <Tabs.Trigger value="activity" className={TAB_CLASS}>
            Activity
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="details" className="mt-4 space-y-4 outline-none">
          <Details data={data} me={me} names={names} orgNames={orgNames} />
        </Tabs.Content>
        {/* Stays mounted, so a draft or a post in flight outlives a look at another tab. */}
        <Tabs.Content value="discussion" forceMount hidden={tab !== "discussion"} className="mt-4 space-y-3 outline-none">
          <Discussion data={data} me={me} names={names} orgNames={orgNames} />
          {isArchivedRoom(data.room) || data.visible?.conversation === false ? null : <TaskComposer api={api} />}
        </Tabs.Content>
        <Tabs.Content value="activity" className="mt-4 outline-none">
          <Activity data={data} me={me} names={names} orgNames={orgNames} />
        </Tabs.Content>
      </Tabs.Root>

      {/* Fresh for each version, so a draft or key from before a change can't go out against what's on screen now. */}
      <TaskActions key={`${held.current.task.version}:${held.current.task.submission_no}`} api={{
          ...api,
          data: held.current,
          // A person can close the Sheet before the read after a command finishes, so the list takes the command's own answer.
          run: (command, explain) =>
            api.run(async (binding) => {
              const result = await command(binding);
              if (result.ok && isThisTask(result.data, task.id)) onTaskRead?.(result.data);
              return result;
            }, explain),
        }} me={me} names={names} role={roleOf(held.current.room, me)} onNotice={setNotice} savedEdit={savedEdit} returnFocus={returnFocus} />
    </div>
  );
}

type SectionProps = { data: TaskDetail; me: string; names: Names; orgNames: Names };

export const author = (from: From, me: string, names: Names, orgNames: Names) => ({ name: nameOf(from.id, me, names), kind: kindOf(from.id), organization: orgNames[from.org] ?? from.org, viewer: from.id === me });

/** `overseen` means an admin is looking through an agent's access, so what's limited is the agent's and not theirs. */
export function Details({ data, me, names, orgNames, overseen = false }: SectionProps & { overseen?: boolean }) {
  const { task } = data;
  // Submissions are numbered, so the task already shows how many there are. Saying "may" would be coy.
  const hiddenSubmissions = data.visible?.submissions === "own" && task.submission_no > data.submissions.length;
  const files = data.files ?? [];
  // The reviewer named on a task gets all its submitted files even when it can't read every submission (decision 97), so a
  // submission can show up here by its files alone.
  const filesOnly = [...new Set(files.map((file) => file.submission_no))].filter((no) => !data.submissions.some((submission) => submission.submission_no === no));
  const rows: (Submission | { submission_no: number; created_at: number; filesOnly: true })[] = [...data.submissions, ...filesOnly.map((no) => ({ submission_no: no, created_at: files.find((file) => file.submission_no === no)?.created_at ?? 0, filesOnly: true as const }))].sort((a, b) => b.submission_no - a.submission_no);
  const brief = briefAuthor(data);
  const briefBy = { name: nameOf(brief.id, me, names), kind: kindOf(brief.id), organization: brief.org ? (orgNames[brief.org] ?? brief.org) : undefined, viewer: brief.id === me };
  return (
    <>
      <section className="space-y-2">
        <h3 className="font-medium">Instructions</h3>
        <AgentContent author={briefBy} external={brief.external} body={task.instructions} />
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Acceptance criteria</h3>
        {/* Read-only, and written by the requester. Any checked box in it is the author's own, and AgentContent says Podster hasn't verified it. */}
        {task.acceptance_criteria ? <AgentContent author={briefBy} external={brief.external} body={task.acceptance_criteria} /> : <p className="text-sm text-muted-foreground">None given.</p>}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Submissions</h3>
        {hiddenSubmissions ? <p className="text-sm text-muted-foreground">{overseen ? "This task has submissions this agent's access doesn't show. Only what it submitted is listed." : filesOnly.length > 0 ? "This task has submissions your access doesn't show in full. As its reviewer, you see their files." : "This task has submissions your access doesn't show. Only what you submitted is listed."}</p> : rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing submitted yet.</p> : null}
        <ol className="space-y-3">
          {rows.map((submission) => (
            <li key={submission.submission_no} className="space-y-2 rounded-lg border p-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Submission {submission.submission_no}
                {submission.submission_no === task.approved_submission_no ? <ApprovedMark /> : null}
                {submission.submission_no === task.submission_no ? <span className="text-xs font-normal text-muted-foreground">Latest</span> : null}
                <span className="text-xs font-normal">
                  <Timestamp at={submission.created_at} />
                </span>
              </p>
              {"filesOnly" in submission ? (
                <p className="text-xs text-muted-foreground">Only its files are shown to you.</p>
              ) : submission.note ? (
                <AgentContent author={author(submission.from, me, names, orgNames)} external={submission.external} body={submission.note} />
              ) : (
                <AuthorLine author={author(submission.from, me, names, orgNames)} external={submission.external} />
              )}
              {!("filesOnly" in submission) && submission.commit_sha ? (
                <p className="text-xs break-all text-muted-foreground">
                  Commit <code className="font-mono">{plainName(submission.commit_sha)}</code>
                </p>
              ) : null}
              <SubmissionFiles files={files.filter((file) => file.submission_no === submission.submission_no)} overseen={overseen} />
              <ArtifactList artifacts={data.artifacts.filter((artifact) => artifact.submission_no === submission.submission_no)} me={me} names={names} orgNames={orgNames} />
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function ArtifactList({ artifacts, me, names, orgNames }: { artifacts: Artifact[]; me: string; names: Names; orgNames: Names }) {
  if (artifacts.length === 0) return null;
  return (
    <ul aria-label="Artifacts" className="space-y-2">
      {artifacts.map((artifact) => {
        const url = safeLinkUrl(artifact.uri);
        return (
          <li key={artifact.id} className="space-y-1 rounded-md bg-muted/50 p-2 text-sm">
            <AuthorLine author={author(artifact.from, me, names, orgNames)} external={artifact.external} />
            {/* The label is the agent's, and only the host shown beside it says where this goes. Never previewed or fetched. */}
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc" className="break-words text-primary underline">
                {plainName(artifact.label)} <span className="break-all text-muted-foreground">({destinationHost(url)})</span>
              </a>
            ) : (
              <p className="break-words">
                {plainName(artifact.label)} <span className="break-all text-muted-foreground">({truncate(plainName(artifact.uri), 2048).text})</span>
              </p>
            )}
            {/* UPLOAD-POLICY.md: Podster doesn't hold a link's content, so an approval can't name an exact version of it. */}
            <p className="text-xs text-muted-foreground">External link, may change since approval</p>
          </li>
        );
      })}
    </ul>
  );
}

/** What a task read returns, and there's no reason to imply a thread stops here. */
const RECENT_MESSAGES = 20;

function Discussion({ data, me, names, orgNames }: SectionProps) {
  if (data.visible?.conversation === false) return <p className="text-sm text-muted-foreground">Your access here doesn't include this task's discussion. Its activity shows when messages were posted.</p>;
  if (data.messages.length === 0) return <p className="text-sm text-muted-foreground">No messages yet. Agents post their progress here, and you can too.</p>;
  return (
    <>
      {data.messages.length >= RECENT_MESSAGES ? <p className="text-xs text-muted-foreground">Showing the latest {RECENT_MESSAGES} messages.</p> : null}
      <ol className="space-y-3">
        {data.messages.map((message) => (
          <li key={message.id} className="space-y-1">
            <AgentContent author={author(message.from, me, names, orgNames)} external={message.external} body={message.body} />
            <p className="text-xs">
              <Timestamp at={message.created_at} />
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

export function Activity({ data, me, names, orgNames }: SectionProps) {
  if (data.history.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;
  return (
    <>
    {data.visible?.conversation === false ? <p className="mb-3 text-sm text-muted-foreground">Your access here doesn't include the reasons people gave.</p> : null}
    <ol className="space-y-3">
      {data.history.toReversed().map((event) => (
        <li key={event.id} className="space-y-1 border-b pb-3 text-sm last:border-b-0">
          <AuthorLine author={author(event.from, me, names, orgNames)} external={event.external} />
          <p>
            {verbFor(event)}{" "}
            <span className="text-xs">
              <Timestamp at={event.created_at} />
            </span>
          </p>
          {event.reason ? <AgentContent author={author(event.from, me, names, orgNames)} external={event.external} body={event.reason} /> : null}
        </li>
      ))}
    </ol>
    </>
  );
}

