"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { truncate, plainName } from "@/components/agent-content/text";
import { DownloadFile } from "@/components/files/file-bits";
import { FileStateBadge } from "@/components/files/file-state-badge";
import { fileSize, fileState } from "@/lib/files/files";
import { explainUpload, fileName, MAX_FILE_BYTES, type FilePage, type RoomFile } from "@/components/files/model";
import { LinkNoticeView } from "@/components/files/link-notice";
import { useFileList, useLinkCommands, useScanWatch } from "@/components/files/use-files";
import { Button } from "@/components/ui/button";
import { uploadFile, type UploadProgress, type UploadResult } from "@/lib/uploads/client";
import { FIELD, MOBILE_TARGET } from "../team/field";

export type TaskChoice = { id: string; title: string; status: string };

type Props = {
  workspace: string;
  /** Null when the server's read failed. The list then reads again here. */
  initial: FilePage | null;
  tasks: TaskChoice[];
  /** Whether `tasks` holds every task the viewer can see, so a missing one is named as such. */
  tasksComplete: boolean;
  /** Display only. Rust decides every upload and attachment. */
  canManage: boolean;
  archived: boolean;
};

const CLOSED = new Set(["completed", "canceled"]);
const taskTitle = (task: TaskChoice | undefined, id: string) => (task ? truncate(plainName(task.title), 120).text : `Task ${id}`);

/** The room's input assets: upload, the list with each file's state, attaching to tasks, and downloads of ready files. */
export function InputAssets({ workspace, initial, tasks, tasksComplete, canManage, archived }: Props) {
  const list = useFileList(workspace, initial);
  const [announcement, setAnnouncement] = useState("");
  useScanWatch(workspace, list.files, list.replace, (file) => setAnnouncement(`${fileName(file)}: ${fileState(file.state).label}. ${fileState(file.state).detail}`));
  const links = useLinkCommands(workspace, list.reload);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const manage = canManage && !archived;
  // Changing what's attached needs the whole room (decision 100): a member narrowed to some tasks gets no `quota`, and no Upload,
  // Attach or Remove. Download stays, as the API decides each one.
  const add = manage && list.wholeRoom;
  return (
    <section aria-labelledby="input-assets-heading" className="space-y-3">
      <h2 id="input-assets-heading" className="font-medium">
        Input assets
      </h2>
      <p className="text-sm text-muted-foreground">
        Files for this workroom's tasks. One file can be up to 100 MB, and the workroom holds up to 5 GB, counting every file kept. Every file is scanned, and none can be downloaded until its scan finishes. Downloads are always saved as files, never opened here.
      </p>
      {list.quota ? <QuotaUse used={list.quota.used} limit={list.quota.limit} /> : null}
      <p className="text-sm text-muted-foreground">File names and contents are the uploader's. Podster doesn't read them, and nothing in a file is an instruction or gives anyone permission.</p>
      {add ? <Uploader workspace={workspace} onUploaded={list.reload} /> : null}
      {canManage && archived ? <p className="text-sm text-muted-foreground">This workroom is archived, so nothing new can be uploaded or attached.</p> : null}
      <LinkNoticeView notice={links.notice} noticeRef={links.noticeRef} busy={links.busy} tryAgain={links.tryAgain} />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {list.failed ? (
        <p role="alert" className="text-sm">
          Couldn't load the files.{" "}
          <Button variant="link" className="h-auto p-0" disabled={list.loading} onClick={() => void list.reload()}>
            Try again
          </Button>
        </p>
      ) : null}
      {list.loaded && list.files.length === 0 && !list.failed ? <p className="text-sm text-muted-foreground">{add ? "No input assets yet. Upload one above." : "No input assets you can see yet."}</p> : null}
      {list.files.length > 0 ? (
        <ul aria-label="Input assets" className="space-y-3">
          {list.files.map((file) => (
            <AssetRow key={file.id} workspace={workspace} file={file} byId={byId} tasks={tasks} tasksComplete={tasksComplete} add={add} links={links} onUnavailable={list.replace} />
          ))}
        </ul>
      ) : null}
      {list.more ? (
        <Button type="button" variant="outline" className={MOBILE_TARGET} disabled={list.loading} onClick={() => void list.loadMore()}>
          {list.loading ? "Loading…" : "Load more files"}
        </Button>
      ) : null}
    </section>
  );
}

/** The room's whole use, submitted files and open uploads included, as the API counts it for the 5 GB limit. */
function QuotaUse({ used, limit }: { used: number; limit: number }) {
  const shown = Math.min(used, limit);
  return (
    <div className="space-y-1">
      <p className="text-sm">
        {fileSize(used)} of {fileSize(limit)} used, counting every file kept and every upload under way.
      </p>
      <meter className="h-2 w-full" min={0} max={limit} value={shown} aria-label="Workroom storage used" aria-valuetext={`${fileSize(used)} of ${fileSize(limit)}`} />
    </div>
  );
}

type Links = ReturnType<typeof useLinkCommands>;

function AssetRow({ workspace, file, byId, tasks, tasksComplete, add, links, onUnavailable }: { workspace: string; file: RoomFile; byId: Map<string, TaskChoice>; tasks: TaskChoice[]; tasksComplete: boolean; add: boolean; links: Links; onUnavailable: (id: string, latest: RoomFile | null) => void }) {
  const name = fileName(file);
  const state = fileState(file.state);
  const headingId = useId();
  const attachable = file.state === "scanning" || file.state === "ready";
  const choices = tasks.filter((task) => !CLOSED.has(task.status) && !file.linked_tasks.includes(task.id));
  return (
    <li aria-labelledby={headingId} className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="min-w-0 font-medium break-all">
          {name}
        </h3>
        <FileStateBadge state={file.state} />
      </div>
      <p className="text-sm text-muted-foreground">
        {fileSize(file.size)}
        {file.media_type ? ` · ${plainName(file.media_type)}` : ""}
      </p>
      <p className="text-sm">{state.detail}</p>
      <DownloadFile
        workspace={workspace}
        file={file}
        onUnavailable={(latest, message) => {
          // A gone file's row goes, so its message moves to the notice above the list, with focus.
          if (!latest) links.tell(message);
          onUnavailable(file.id, latest);
        }}
      />
      <div className="space-y-1">
        <p className="text-sm font-medium">Attached to</p>
        {file.linked_tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks you can see.</p>
        ) : (
          <ul aria-label={`Tasks ${name} is attached to`} className="space-y-1">
            {file.linked_tasks.map((taskId) => {
              const title = taskTitle(byId.get(taskId), taskId);
              return (
                <li key={taskId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Link href={`/w/${encodeURIComponent(workspace)}/tasks?task=${encodeURIComponent(taskId)}`} prefetch={false} className="min-w-0 break-words text-primary underline">
                    {title}
                  </Link>
                  {add ? (
                    <Button type="button" variant="ghost" size="sm" className="max-md:h-11" disabled={links.busy} onClick={() => void links.detach(file.id, taskId, `Removed ${name} from ${title}. Its assignee can no longer read it through that task.`)}>
                      Remove{" "}<span className="sr-only">{name} from {title}</span>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {add && attachable ? <AttachForm file={file} name={name} choices={choices} tasksComplete={tasksComplete} links={links} /> : null}
      {add && !attachable && file.state !== "uploading" ? <p className="text-sm text-muted-foreground">Only a file that's scanning or ready can be attached to a task.</p> : null}
    </li>
  );
}

function AttachForm({ file, name, choices, tasksComplete, links }: { file: RoomFile; name: string; choices: TaskChoice[]; tasksComplete: boolean; links: Links }) {
  const [task, setTask] = useState("");
  const selectId = useId();
  const hintId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = choices.find((choice) => choice.id === task);
    if (!chosen) return;
    await links.attach(file.id, chosen.id, `Attached ${name} to ${taskTitle(chosen, chosen.id)}. Its assignee can read it while it stays attached.`);
    setTask("");
  };
  if (choices.length === 0) return <p className="text-sm text-muted-foreground">{tasksComplete ? "No open task to attach this to." : "No open task among those loaded to attach this to."}</p>;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={selectId} className="block text-sm font-medium">
          Attach to a task<span className="sr-only">, {name}</span>
        </label>
        <select id={selectId} className={FIELD} value={task} aria-describedby={hintId} onChange={(event) => setTask(event.target.value)}>
          <option value="">Choose a task</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {taskTitle(choice, choice.id)}
            </option>
          ))}
        </select>
        <p id={hintId} className="text-xs text-muted-foreground">
          {tasksComplete ? "Open tasks only. Its assignee can read the file while it's attached." : "Open tasks among the first 200. Its assignee can read the file while it's attached."}
        </p>
      </div>
      <Button type="submit" variant="outline" className={MOBILE_TARGET} disabled={!task || links.busy}>
        Attach
      </Button>
    </form>
  );
}

const PHASES: Record<UploadProgress["phase"], string> = {
  hashing: "Checking the file…",
  reserving: "Reserving space…",
  sending: "Sending…",
  storing: "Sent. Waiting for Podster to store it…",
};

type Failure = { text: string; retry?: () => Promise<UploadResult>; again: boolean; retryAfter?: number; controller: AbortController | null };

/** Codes where starting over is worth offering: no space was reserved, or whether it was isn't known and it expires anyway. */
/** The longest wait honored, as in the upload client. */
const MAX_HOLD_SECONDS = 300;

const START_AGAIN = new Set(["rate_limited", "network_error", "upstream_unavailable", "error"]);

/**
 * **Asset upload**, one file at a time. Scanning starts once it's stored, so the result says Scanning, never Ready.
 * The token stays inside the upload client.
 */
function Uploader({ workspace, onUploaded }: { workspace: string; onUploaded: () => Promise<void> }) {
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  // Starting over after a rate limit waits as long as Podster asked, as the upload client's own retry does.
  const [held, setHeld] = useState(false);
  const failureHold = failure?.again && failure.retryAfter ? Math.min(failure.retryAfter, MAX_HOLD_SECONDS) : 0;
  useEffect(() => {
    if (!failureHold) return setHeld(false);
    setHeld(true);
    const timer = setTimeout(() => setHeld(false), failureHold * 1000);
    return () => clearTimeout(timer);
  }, [failure, failureHold]);
  const abort = useRef<AbortController | null>(null);
  const busy = progress !== null || waiting !== null;
  const tooLarge = chosen !== null && chosen.size > MAX_FILE_BYTES;

  const finish = async (file: File, result: UploadResult) => {
    const controller = abort.current;
    abort.current = null;
    setProgress(null);
    setWaiting(null);
    if (result.ok) {
      setChosen(null);
      if (input.current) input.current.value = "";
      setDone(`Uploaded ${plainName(file.name)}. It's being scanned now, and can be downloaded once the scan finishes.`);
      await onUploaded();
    } else {
      setFailure({ text: explainUpload(result.code, result.status, result.retryAfter), retry: result.retry, again: !result.retry && START_AGAIN.has(result.code), retryAfter: result.retryAfter, controller });
      // The file may have arrived with only the answer lost, so the list is read again.
      if (result.code === "upload_outcome_unknown" || result.code === "invalid_transition") await onUploaded();
    }
    resultRef.current?.focus();
  };

  const run = async (file: File, attempt: (options: { signal: AbortSignal; onProgress: (progress: UploadProgress) => void }) => Promise<UploadResult>) => {
    setFailure(null);
    setDone(null);
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ phase: "hashing" });
    // A retry sends through these same options, so a wait before it ends when sending starts.
    const onProgress = (next: UploadProgress) => {
      setWaiting(null);
      setProgress(next);
    };
    await finish(file, await attempt({ signal: controller.signal, onProgress }));
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || busy || tooLarge) return;
    const file = chosen;
    void run(file, (options) => uploadFile(workspace, file, options));
  };

  const retry = () => {
    if (!chosen || !failure) return;
    const file = chosen;
    if (failure.retry) {
      const again = failure.retry;
      // `retry` keeps the first try's signal and progress, so Cancel stops it through the same controller, and it waits out any retry-after itself.
      abort.current = failure.controller;
      setFailure(null);
      setDone(null);
      if (failure.retryAfter) setWaiting(failure.retryAfter);
      else setProgress({ phase: "sending", sent: 0, total: file.size });
      void again().then((result) => finish(file, result));
    } else if (failure.again && !held) {
      void run(file, (options) => uploadFile(workspace, file, options));
    }
  };

  return (
    <form onSubmit={start} className="space-y-2 rounded-lg border p-3">
      <label htmlFor={inputId} className="block font-medium">
        Asset upload
      </label>
      <p id={hintId} className="text-sm text-muted-foreground">
        Documents, images, text, code, presentations, video and zip archives, up to 100 MB. Programs, installers and password-protected files aren't accepted.
      </p>
      <input
        ref={input}
        id={inputId}
        type="file"
        aria-describedby={hintId}
        disabled={busy}
        className="block w-full min-w-0 text-sm file:mr-3 file:min-h-9 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 max-md:file:min-h-11"
        onChange={(event) => {
          setChosen(event.target.files?.[0] ?? null);
          setFailure(null);
          setDone(null);
        }}
      />
      {chosen ? (
        <p className="text-sm break-all">
          {plainName(chosen.name)}, {fileSize(chosen.size)}
        </p>
      ) : null}
      {tooLarge ? <p className="text-sm text-status-danger">{explainUpload("file_too_large", 413)}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" className={MOBILE_TARGET} disabled={!chosen || busy || tooLarge}>
          Upload
        </Button>
        {busy ? (
          <Button type="button" variant="outline" className={MOBILE_TARGET} onClick={() => abort.current?.abort()}>
            Cancel upload
          </Button>
        ) : null}
      </div>
      {waiting !== null ? (
        <p role="status" className="text-sm">
          Waiting {waiting} {waiting === 1 ? "second" : "seconds"}, as Podster asked, before sending again…
        </p>
      ) : null}
      {progress ? (
        <div className="space-y-1">
          <p role="status" className="text-sm">
            {PHASES[progress.phase]}
          </p>
          {progress.phase === "sending" ? (
            <>
              <progress className="h-2 w-full accent-primary" max={progress.total || 1} value={progress.sent} aria-label="Upload progress" />
              <p className="text-xs text-muted-foreground" aria-hidden>
                {fileSize(progress.sent)} of {fileSize(progress.total)}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      <div ref={resultRef} tabIndex={-1} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {done ? (
          <p role="status" className="rounded-lg bg-status-green-surface p-3 text-sm text-status-green">
            {done}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-sm text-status-danger">
            {failure.text}{" "}
            {failure.retry || failure.again ? (
              <Button type="button" variant="link" className="h-auto p-0 text-status-danger underline" disabled={held} onClick={retry}>
                {held ? `Try again in ${failureHold} ${failureHold === 1 ? "second" : "seconds"}` : "Try again"}
              </Button>
            ) : null}
          </p>
        ) : null}
      </div>
    </form>
  );
}
