"use client";

import { CheckCircle2, Circle, CircleDashed, Eye, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "cn";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { useEarlyInput } from "@/hooks/use-early-input";
import { Input } from "@/components/ui/input";
import { clientQuery } from "@/lib/gateway/client";
import { PrincipalName, Timestamp } from "../tasks/task-bits";
import { nameOf, type Names, type Room } from "../tasks/task-model";
import { TaskSheet } from "../tasks/task-sheet";
import { CommandNotice, useCommands, type Send } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { MOBILE_TARGET } from "../team/field";
import { currentFilesText, currentVersion, OUTPUT_LIMITS, outputProblem, outputStatus, outputTextProblem, readyText, type Output, type OutputsRead, type VersionsRead } from "./artifacts-model";

const ICONS: Record<string, LucideIcon> = { not_started: Circle, in_review: Eye, ready: CheckCircle2 };

const TONES: Record<string, string> = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  violet: "bg-status-violet-surface text-status-violet",
  green: "bg-status-green-surface text-status-green",
};

const TEXTAREA = "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/** A label and an icon, so color is never the only signal. */
export function OutputStatusBadge({ status }: { status: string }) {
  const known = outputStatus(status);
  const Icon = (Object.hasOwn(ICONS, status) && ICONS[status]) || CircleDashed;
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[known.tone] ?? TONES.neutral)}>
      <Icon className="size-3" aria-hidden />
      {known.label}
    </span>
  );
}

type Props = { room: Room; read: OutputsRead; me: string; names: Names; orgNames: Names; taskTitles: Record<string, string>; canManage: boolean; archived: boolean };

/** A read refused for the person's rate limit says so, rather than that something broke. */
export function RateLimited() {
  const router = useRouter();
  return (
    <p role="alert">
      Too many requests just now, so this didn&apos;t load. Wait a minute, then{" "}
      <Button variant="link" className="h-auto p-0" onClick={() => router.refresh()}>
        try again
      </Button>
      .
    </p>
  );
}

/**
 * The room's expected outputs, for every participant (decision 54): title, description and status. The version that made one
 * Ready shows only as far as the read allows, and its files open from its task, whose read applies the file rules again.
 */
export function ArtifactsScreen({ room, read, me, names, orgNames, taskTitles, canManage, archived }: Props) {
  const commands = useCommands(null);
  const base = `/api/v1/workspaces/${encodeURIComponent(room.id)}`;
  const manage = canManage && !archived;
  return (
    <section className="max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Artifacts</h1>
        <p className="text-sm text-muted-foreground">The outputs this workroom is working toward. An output is Ready once a reviewer approves a submission, with a link or a file, from a task that names it.</p>
      </div>
      <p className="font-medium">{readyText(read.ready, read.total)}</p>
      <CommandNotice commands={commands} />
      {read.outputs.length > 0 ? (
        <ul aria-label="Expected outputs" className="space-y-3">
          {read.outputs.map((output) => (
            <OutputRow key={output.id} output={output} base={base} taskTitles={taskTitles} me={me} names={names} manage={manage} send={commands.send} noticeRef={commands.noticeRef} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{manage ? "Define the first one below. A task's requester can then name it on the task." : "None are defined yet. The workroom's owner or an admin defines them."}</p>
      )}
      {manage ? <DefineOutput base={base} send={commands.send} full={read.outputs.length >= OUTPUT_LIMITS.outputs} /> : null}
      {archived ? <p className="text-sm text-muted-foreground">This workroom is archived, so its outputs can't change.</p> : null}
      <TaskSheet me={me} names={names} orgNames={orgNames} room={room} resolve={(target) => ({ workspace: room.id, task: target })} />
    </section>
  );
}

/** A task named by its title when this page has it, and otherwise by its ID: the read already decided the viewer may know it. */
function TaskLink({ id, taskTitles }: { id: string; taskTitles: Record<string, string> }) {
  return (
    <SheetLink param="task" target={id} className="text-primary underline">
      {taskTitles[id] ? plainName(taskTitles[id]) : `task ${id}`}
    </SheetLink>
  );
}

type RowProps = { output: Output; base: string; taskTitles: Record<string, string>; me: string; names: Names; manage: boolean; send: Send; noticeRef: React.RefObject<HTMLDivElement | null> };

/** Which approved version the listing names now. A history read for any other is stale. */
const versionKey = (output: Output) => (output.current ? `${output.current.task_id}:${output.current.submission_no}` : `none:${output.status}`);

function OutputRow({ output, base, taskTitles, me, names, manage, send, noticeRef }: RowProps) {
  // The latest history read, and the version it was read for. An approval since makes it stale, so it's dropped, not shown.
  const [loaded, setLoaded] = useState<{ key: string; read: VersionsRead } | null>(null);
  const history = loaded?.key === versionKey(output) ? loaded.read : undefined;
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const titleId = `output-${output.id}`;
  const filesText = currentFilesText(output.current);
  const path = `${base}/outputs/${encodeURIComponent(output.id)}`;
  const approved = currentVersion(output, history);

  useEffect(() => {
    if (!editing && returnFocus.current) editButton.current?.focus();
    returnFocus.current = false;
  }, [editing]);

  const done = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="min-w-0 break-words font-medium">
          {plainName(output.title)}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <OutputStatusBadge status={output.status} />
          {/* Beside the badge, never instead of it: what was approved stays approved until a newer version is (DESIGN.md). */}
          {output.status === "ready" && output.in_review === true ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="size-3" aria-hidden />A newer submission is in review
            </span>
          ) : null}
        </div>
      </div>
      {/* Someone's text. Plain, so nothing in it becomes a link, an image or markup. */}
      {output.description ? <p className="text-sm break-words whitespace-pre-wrap">{output.description}</p> : null}
      {output.current ? (
        <p className="text-sm break-words">
          <span className="text-muted-foreground">Approved version:</span> submission {output.current.submission_no} of{" "}
          <TaskLink id={output.current.task_id} taskTitles={taskTitles} />
          {approved?.approved_by ? (
            <>
              {", approved by "}
              <PrincipalName id={approved.approved_by} label={nameOf(approved.approved_by, me, names)} me={me} />
            </>
          ) : null}
          {typeof output.current.approved_at === "number" ? (
            <span className="text-xs text-muted-foreground">
              {" "}
              · <Timestamp at={output.current.approved_at} />
            </span>
          ) : null}
        </p>
      ) : output.status === "ready" ? (
        <p className="text-sm text-muted-foreground">Its approved version is from a task your access doesn&apos;t show.</p>
      ) : null}
      {output.status === "ready" ? <VersionHistory key={versionKey(output)} path={path} taskTitles={taskTitles} me={me} names={names} onLoaded={(read) => setLoaded({ key: versionKey(output), read })} /> : null}
      {filesText ? <p className={cn("text-sm", output.current?.files_available === false ? "rounded-lg bg-status-amber-surface p-3 text-status-amber" : "text-muted-foreground")}>{filesText}</p> : null}
      {manage && editing ? <EditOutput output={output} path={path} send={send} onDone={done} /> : null}
      {manage && !editing ? (
        <div className="flex flex-wrap gap-2">
          <Button ref={editButton} type="button" size="sm" variant="outline" className={MOBILE_TARGET} aria-describedby={titleId} onClick={() => setEditing(true)}>
            Rename
          </Button>
          {/* Decision 136 refuses removing an output that was ever Ready, so it isn't offered. */}
          {output.status === "ready" ? null : (
            <ConfirmAction
              label="Remove"
              describedBy={titleId}
              title={<>Remove “{plainName(output.title)}”?</>}
              description="It leaves this list and can't be named on a task again. Its record stays, so a finished task that named it still says so. An output that was ever Ready, or that an unfinished task names, can't be removed."
              confirm="Remove output"
              destructive
              focusAfter={noticeRef}
              action={() => send(path, {}, `Removed “${plainName(output.title)}”.`, { method: "DELETE", explain: outputProblem })}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}

type HistoryState = { phase: "idle" } | { phase: "loading" } | { phase: "failed"; limited: boolean } | { phase: "ready"; read: VersionsRead };

/**
 * Every approval that made this output Ready, newest first, read when opened and never with the page. Keyed by the version
 * the listing names, so an approval since starts it afresh. A version from a task the viewer can't see shows only its number and time, as the read gives.
 */
function VersionHistory({ path, taskTitles, me, names, onLoaded }: { path: string; taskTitles: Record<string, string>; me: string; names: Names; onLoaded: (read: VersionsRead) => void }) {
  const [state, setState] = useState<HistoryState>({ phase: "idle" });
  const loading = useRef(false);

  const load = async () => {
    if (loading.current) return;
    loading.current = true;
    setState({ phase: "loading" });
    const read = await clientQuery<VersionsRead>(`${path}/versions`).catch(() => null);
    loading.current = false;
    if (read?.ok) onLoaded(read.data);
    setState(read?.ok ? { phase: "ready", read: read.data } : { phase: "failed", limited: read?.ok === false && read.status === 429 });
  };

  const count = state.phase === "ready" ? state.read.versions.length : null;
  return (
    <details
      className="rounded-md bg-muted/50 p-2 text-sm"
      onToggle={(event) => {
        if (event.currentTarget.open && state.phase === "idle") void load();
      }}
    >
      <summary className="min-h-6 cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Version history{count !== null ? ` (${count}${state.phase === "ready" && !state.read.complete ? "+" : ""})` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        {state.phase === "loading" || state.phase === "idle" ? <p role="status" className="text-muted-foreground">Loading version history</p> : null}
        {state.phase === "failed" ? (
          <p role="alert" className="text-status-danger">
            {state.limited ? "Too many requests just now, so the version history didn't load. Wait a minute, then try again." : "Couldn't load the version history."}{" "}
            <Button variant="link" className="h-auto p-0 text-status-danger underline" onClick={() => void load()}>
              Try again
            </Button>
          </p>
        ) : null}
        {state.phase === "ready" ? (
          <>
            <ol aria-label="Approved versions, newest first" className="space-y-2">
              {state.read.versions.map((version, index) => (
                <li key={`${version.task_id ?? "hidden"}:${version.submission_no}:${version.approved_at}`} className="space-y-0.5 border-b pb-2 last:border-b-0 last:pb-0">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">Submission {version.submission_no}</span>
                    {index === 0 ? <span className="text-xs text-muted-foreground">Current</span> : null}
                    <span className="text-xs">
                      <Timestamp at={version.approved_at} />
                    </span>
                  </p>
                  {version.task_id ? (
                    <p className="break-words">
                      <span className="text-muted-foreground">Source task:</span> <TaskLink id={version.task_id} taskTitles={taskTitles} />
                      {version.approved_by ? (
                        <>
                          {" "}
                          <span className="text-muted-foreground">· Reviewer:</span> <PrincipalName id={version.approved_by} label={nameOf(version.approved_by, me, names)} me={me} />
                        </>
                      ) : null}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">From a task your access doesn&apos;t show.</p>
                  )}
                </li>
              ))}
            </ol>
            {!state.read.complete ? <p className="text-xs text-muted-foreground">Showing the latest {state.read.versions.length} versions.</p> : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function OutputFields({ idPrefix, title, description, setTitle, setDescription, titleRef }: { idPrefix: string; title: string; description: string; setTitle: (value: string) => void; setDescription: (value: string) => void; titleRef?: React.RefObject<HTMLInputElement | null> }) {
  return (
    <>
      <div className="space-y-1 text-sm">
        <label htmlFor={`${idPrefix}-title`}>Title</label>
        <Input ref={titleRef} id={`${idPrefix}-title`} value={title} required autoComplete="off" onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="space-y-1 text-sm">
        <label htmlFor={`${idPrefix}-description`}>Description (optional)</label>
        <textarea id={`${idPrefix}-description`} className={TEXTAREA} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
    </>
  );
}

function EditOutput({ output, path, send, onDone }: { output: Output; path: string; send: Send; onDone: () => void }) {
  const [title, setTitle] = useState(output.title);
  const [description, setDescription] = useState(output.description ?? "");
  const [pending, setPending] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const problem = outputTextProblem(title, description);
  const problemId = `edit-${output.id}-problem`;

  useEffect(() => titleRef.current?.focus(), []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || pending) return;
    setPending(true);
    const trimmed = description.trim();
    // onOk also runs when Try again succeeds later, so the form closes then too.
    await send(path, { title: title.trim(), description: trimmed === "" ? null : trimmed }, "Saved the output's title and description.", { method: "PUT", focus: true, explain: outputProblem, onOk: onDone });
    setPending(false);
  };

  return (
    <form onSubmit={save} aria-label={`Rename ${plainName(output.title)}`} className="space-y-3 rounded-lg bg-muted/50 p-3">
      <OutputFields idPrefix={`edit-${output.id}`} title={title} description={description} setTitle={setTitle} setDescription={setDescription} titleRef={titleRef} />
      <p className="text-sm text-muted-foreground">Renaming doesn&apos;t change its status: what was approved is the submission, not its wording.</p>
      {problem ? (
        <p id={problemId} className="text-sm text-status-danger">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending || problem !== null} aria-describedby={problem ? problemId : undefined}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="outline" className={MOBILE_TARGET} disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DefineOutput({ base, send, full }: { base: string; send: Send; full: boolean }) {
  // Hands React what was typed before the page hydrated, so the form doesn't look filled in with empty state behind it.
  const early = useEarlyInput();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const problem = outputTextProblem(title, description);

  const define = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || pending || full) return;
    setPending(true);
    const trimmed = description.trim();
    await send(`${base}/outputs`, { title: title.trim(), ...(trimmed ? { description: trimmed } : {}) }, `Defined “${plainName(title.trim())}”. It's Not started until a task names it.`, {
      focus: true,
      explain: outputProblem,
      onOk: () => {
        setTitle("");
        setDescription("");
      },
    });
    setPending(false);
  };

  return (
    <form ref={early} onSubmit={define} aria-labelledby="define-output" className="space-y-3 rounded-lg border p-3">
      <h2 id="define-output" className="font-medium">
        Define an expected output
      </h2>
      {full ? <p className="text-sm text-muted-foreground">This workroom has {OUTPUT_LIMITS.outputs} expected outputs, the most it can have. Remove one that isn&apos;t needed to define another.</p> : null}
      <OutputFields idPrefix="define-output" title={title} description={description} setTitle={setTitle} setDescription={setDescription} />
      {problem && (title !== "" || description !== "") ? (
        <p id="define-output-problem" className="text-sm text-status-danger">
          {problem}
        </p>
      ) : null}
      <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending || full || problem !== null}>
        {pending ? "Defining…" : "Define output"}
      </Button>
    </form>
  );
}
