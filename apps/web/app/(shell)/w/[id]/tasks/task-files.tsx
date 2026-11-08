"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { plainName } from "@/components/agent-content/text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { MAX_UPLOAD_BYTES, uploadFile, type UploadProgress, type UploadResult } from "@/lib/uploads/client";
import { FIELD_CLASS } from "./task-bits";
import { FileStateBadge } from "@/components/files/file-state-badge";
import { downloadHref, fileSize, fileState } from "@/lib/files/files";
import { MAX_SUBMISSION_ITEMS, submitProblem, uploadProblem } from "./task-files-model";
import { asConflict, LIMITS, tooLong, type Task, type TaskFile } from "./task-model";
import type { LoadedTask } from "./task-sheet";

const shortHash = (sha256: string) => plainName(sha256).slice(0, 12);
const UNNAMED = "Unnamed file";

/**
 * A submission's stored files. The label and name are agent content and stay text. The one link is the download, which the
 * API serves only as an attachment. Each row shows the SHA-256 the submission pinned, which is what an approval names.
 */
export function SubmissionFiles({ files, overseen = false }: { files: TaskFile[]; overseen?: boolean }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Files" className="space-y-2">
      {files.map((file) => {
        // Oversight gives a name and no label, so either can be missing.
        const name = typeof file.name === "string" ? plainName(file.name) : null;
        const label = typeof file.label === "string" ? plainName(file.label) : (name ?? UNNAMED);
        const href = downloadHref(file);
        return (
          <li key={file.id} className="space-y-1 rounded-md bg-muted/50 p-2 text-sm">
            <p className="break-words font-medium">{label}</p>
            {name && name !== label ? <p className="text-xs break-words text-muted-foreground">File name: {name}</p> : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <FileStateBadge state={file.state} />
              {typeof file.size === "number" ? <span>{fileSize(file.size)}</span> : null}
              {typeof file.sha256 === "string" ? (
                <span>
                  SHA-256{" "}
                  <code className="font-mono" title={plainName(file.sha256)}>
                    {shortHash(file.sha256)}
                  </code>
                </span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">{fileState(file.state).detail}</p>
            {href ? (
              <a href={href} download aria-label={`Download ${label}`} className="inline-flex min-h-11 items-center text-primary underline sm:min-h-6">
                Download
              </a>
            ) : file.state === "ready" ? (
              <p className="text-xs text-muted-foreground">{overseen ? "Oversight shows a file's name and status, not its bytes." : "Your access doesn't include downloading it."}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type Phase = UploadProgress["phase"] | "scanning" | "ready" | "blocked" | "failed" | "removed" | "refused";

/** A file chosen for this submission, from the moment it's picked. Lives only in this form, like its upload token. */
type Chosen = { key: string; name: string; size: number; phase: Phase; sent?: number; id?: string; problem?: string; retry?: () => Promise<UploadResult> };

const PHASE_TEXT: Partial<Record<Phase, string>> = { hashing: "Preparing", reserving: "Preparing", storing: "Checking what arrived" };

function phaseText(chosen: Chosen) {
  if (chosen.phase === "sending" && chosen.sent !== undefined && chosen.size > 0) return `Uploading, ${Math.min(100, Math.floor((chosen.sent / chosen.size) * 100))}%`;
  return PHASE_TEXT[chosen.phase] ?? fileState(chosen.phase === "sending" ? "uploading" : chosen.phase).label;
}

/** Rows that will go out with the submission, or still could. A refusal never reserved space and isn't one. */
const counted = (chosen: Chosen) => chosen.phase !== "refused";
const settled = (phase: Phase) => phase === "ready" || phase === "blocked" || phase === "failed" || phase === "removed" || phase === "refused";

/** How long to wait before reading a scanning file again. A scan takes about 20 seconds, and a slow one is read less often. */
const pollDelay = (attempt: number) => Math.min(3000 * 1.25 ** attempt, 30_000);

/**
 * The assignee's submission: a note and files, each uploaded for this task and scanned before it can go. Only Ready files
 * can be submitted, which is the API's rule too. The submission pins each one's SHA-256, so what's reviewed is what was sent.
 */
export function SubmitWork({ api, onNotice, taskPath }: { api: SheetApi<LoadedTask>; onNotice: (notice: string | null) => void; taskPath: (data: LoadedTask, action: string) => string }) {
  const { data, run, saving, setDirty } = api;
  const { task, workspace } = data;
  const [note, setNote] = useState("");
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  const ready = chosen.filter((file) => file.phase === "ready" && file.id);
  const unsettled = chosen.some((file) => !settled(file.phase));
  const stuck = chosen.some((file) => settled(file.phase) && file.phase !== "ready");
  const trimmed = note.trim();
  const noteTooLong = tooLong(note, LIMITS.message);
  const hasContent = trimmed !== "" || chosen.length > 0;
  const canSubmit = !saving && !unsettled && !stuck && !noteTooLong && (trimmed !== "" || ready.length > 0);
  const ids = ready.map((file) => file.id).join(",");
  const key = useIntentKey(`submit:${task.version}:${trimmed}:${ids}`);

  useEffect(() => {
    setDirty(hasContent);
    // Only when that answer changes. `setDirty` is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasContent]);

  // Leaving stops every upload and scan read this form started. A stopped upload frees its space when it expires.
  useEffect(() => {
    alive.current = true;
    const running = controllers.current;
    return () => {
      alive.current = false;
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  const update = (key: string, change: Partial<Chosen>) => {
    if (alive.current) setChosen((all) => all.map((file) => (file.key === key ? { ...file, ...change } : file)));
  };

  async function watchScan(key: string, id: string, signal: AbortSignal) {
    for (let attempt = 0; !signal.aborted; attempt++) {
      await new Promise((done) => setTimeout(done, pollDelay(attempt)));
      if (signal.aborted) return;
      const read = await clientQuery<{ state: string }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/files/${encodeURIComponent(id)}`, { signal }).catch(() => null);
      if (signal.aborted) return;
      // A lost read or a busy server is tried again. Anything else means this file isn't there for this person any more.
      if (!read || (!read.ok && (read.status >= 500 || read.status === 429))) continue;
      if (!read.ok) return update(key, { phase: "refused", problem: read.status === 401 ? uploadProblem("", 401) : "It can't be found any more. Remove it and add it again." });
      const state = read.data.state;
      if (state === "scanning" || state === "uploading") continue;
      return update(key, { phase: (["ready", "blocked", "failed", "removed"].includes(state) ? state : "failed") as Phase });
    }
  }

  async function follow(key: string, attempt: () => Promise<UploadResult>) {
    const controller = controllers.current.get(key);
    if (!controller) return;
    const result = await attempt();
    if (controller.signal.aborted) return;
    if (!result.ok) return update(key, { phase: "refused", problem: uploadProblem(result.code, result.status), retry: result.retry });
    const state = result.data.state;
    update(key, { id: result.data.id, phase: (state === "ready" || state === "blocked" || state === "failed" || state === "removed" ? state : "scanning") as Phase, problem: undefined, retry: undefined });
    if (state === "scanning" || state === "uploading") void watchScan(key, result.data.id, controller.signal);
  }

  function add(files: FileList | null) {
    if (!files || files.length === 0 || saving) return;
    setProblem(null);
    onNotice(null);
    const room = MAX_SUBMISSION_ITEMS - chosen.filter(counted).length;
    const picked = [...files];
    if (picked.length > room) {
      setProblem(room <= 0 ? `A submission can hold at most ${MAX_SUBMISSION_ITEMS} files. Remove one to add another.` : `A submission can hold at most ${MAX_SUBMISSION_ITEMS} files, so only the first ${room} were added.`);
    }
    const added: Chosen[] = [];
    for (const file of picked.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(key, controller);
      const tooBig = file.size > MAX_UPLOAD_BYTES;
      added.push({ key, name: file.name, size: file.size, phase: tooBig ? "refused" : "hashing", problem: tooBig ? uploadProblem("file_too_large", 413) : undefined });
      if (!tooBig) void follow(key, () => uploadFile(workspace, file, { taskId: task.id, signal: controller.signal, onProgress: (progress) => update(key, progress.phase === "sending" ? { phase: "sending", sent: progress.sent } : { phase: progress.phase }) }));
    }
    setChosen((all) => [...all, ...added]);
  }

  function remove(key: string) {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setChosen((all) => all.filter((file) => file.key !== key));
    // The row and its button are gone, and focus shouldn't go with them.
    inputRef.current?.focus();
  }

  function retry(file: Chosen) {
    if (!file.retry) return;
    const again = file.retry;
    update(file.key, { phase: "sending", sent: 0, problem: undefined, retry: undefined });
    void follow(file.key, again);
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onNotice(null);
    const files = ready.map((file) => ({ id: file.id as string }));
    const result = await run(async (binding) => asConflict(await clientCommand<Task>(taskPath(data, "submit"), { version: binding.version, ...(trimmed ? { note: trimmed } : {}), ...(files.length ? { files } : {}) }, { idempotencyKey: key })), submitProblem);
    if (!result?.ok) return;
    const number = result.data.submission_no;
    onNotice(`Submitted${number ? ` submission ${number}` : ""}${files.length ? ` with ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}. It's waiting for review.`);
  };

  const hint = unsettled ? "Wait for every file to finish uploading and scanning." : stuck ? "Remove each file that isn't Ready before submitting." : !trimmed && ready.length === 0 ? "Add a note or at least one file." : null;

  return (
    <form onSubmit={submit} aria-label="Submit work" className="space-y-3">
      <h3 className="font-medium">Submit your work</h3>
      <p className="text-sm text-muted-foreground">The reviewer gets this submission&apos;s note and files, exactly as they are when you submit.</p>
      <div className="space-y-1">
        <Label htmlFor="submit-note">Note (optional)</Label>
        <textarea
          id="submit-note"
          rows={4}
          readOnly={saving}
          className={FIELD_CLASS}
          value={note}
          onChange={(event) => {
            if (!saving) setNote(event.target.value);
          }}
        />
        {noteTooLong ? <p className="text-sm text-status-danger">That&apos;s too long. A note can be at most 16 KB.</p> : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="submit-files">Files (optional)</Label>
        <input
          ref={inputRef}
          id="submit-files"
          type="file"
          multiple
          aria-describedby="submit-files-hint"
          className={cn(FIELD_CLASS, "file:mr-3 file:rounded-sm file:border-0 file:bg-muted file:px-2 file:py-1 file:text-sm")}
          onChange={(event) => {
            add(event.target.files);
            event.target.value = "";
          }}
        />
        <p id="submit-files-hint" className="text-xs text-muted-foreground">
          Up to {MAX_SUBMISSION_ITEMS} files, each at most 100 MB. Each is scanned before it can be submitted. Until you submit, only you can see them.
        </p>
      </div>
      {problem ? <p className="text-sm text-status-danger">{problem}</p> : null}
      {chosen.length > 0 ? (
        <ul aria-label="Files for this submission" className="space-y-2">
          {chosen.map((file) => {
            const name = plainName(file.name);
            return (
              <li key={file.key} className="flex flex-wrap items-start gap-2 rounded-md bg-muted/50 p-2 text-sm">
                <div className="min-w-0 flex-1 basis-48 space-y-1">
                  <p className="break-words font-medium">{name}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {file.phase === "refused" ? <span className="font-medium text-status-danger">Didn&apos;t upload</span> : settled(file.phase) ? <FileStateBadge state={file.phase} /> : null}
                    <span>{settled(file.phase) ? (file.phase === "refused" ? "" : fileState(file.phase).detail) : phaseText(file)}</span>
                    <span>{fileSize(file.size)}</span>
                  </p>
                  {/* Only where a file ends up, so a screen reader hears a scan finish without moving focus, and not every percent. */}
                  <span role="status" className="sr-only">
                    {settled(file.phase) ? `${name}: ${file.phase === "refused" ? "didn't upload" : fileState(file.phase).label}` : ""}
                  </span>
                  {file.problem ? <p className="text-xs text-status-danger">{file.problem}</p> : null}
                </div>
                <div className="flex gap-2">
                  {file.retry ? (
                    <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving} aria-label={`Try again ${name}`} onClick={() => retry(file)}>
                      Try again
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving} aria-label={`Remove ${name}`} onClick={() => remove(file.key)}>
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hint && hasContent ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      <Button type="submit" className="min-h-11 sm:min-h-9" disabled={!canSubmit}>
        {saving ? "Submitting…" : ready.length > 0 ? `Submit with ${ready.length} ${ready.length === 1 ? "file" : "files"}` : "Submit"}
      </Button>
    </form>
  );
}

/** One key per intent, so retrying after a lost response can't submit twice. Changing what's being sent starts a new intent. */
function useIntentKey(intent: string) {
  const key = useRef({ intent, value: crypto.randomUUID() });
  if (key.current.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
  return key.current.value;
}
