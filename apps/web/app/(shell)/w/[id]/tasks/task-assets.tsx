"use client";

import { useState } from "react";
import { DownloadFile, FileStateBadge } from "@/components/files/file-bits";
import { fileName, formatBytes, stateOf } from "@/components/files/model";
import { useFileList, useLinkCommands, useScanWatch } from "@/components/files/use-files";
import { Button } from "@/components/ui/button";

type Props = {
  workspace: string;
  taskId: string;
  /** Display only. Rust decides whether a removal is allowed. */
  canManage: boolean;
  archived: boolean;
};

/**
 * The input assets attached to one task, read when the Sheet opens. The task's assignee reads them while they stay attached, and
 * each is downloaded only once it's ready. Attaching happens on the Overview, beside the upload.
 */
export function TaskAssets({ workspace, taskId, canManage, archived }: Props) {
  const list = useFileList(workspace, null, taskId);
  const [announcement, setAnnouncement] = useState("");
  useScanWatch(workspace, list.files, list.replace, (file) => setAnnouncement(`${fileName(file)}: ${stateOf(file.state).label}.`));
  const links = useLinkCommands(workspace, list.reload);
  const manage = canManage && !archived;
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Attached files</h3>
      <div ref={links.noticeRef} tabIndex={-1} role="status" className="rounded-lg text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {links.notice?.kind === "ok" ? <p className="rounded-lg bg-status-green-surface p-3 text-status-green">{links.notice.text}</p> : null}
        {links.notice?.kind === "refused" ? (
          <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
            {links.notice.text}
          </p>
        ) : null}
        {links.notice?.kind === "unknown" ? (
          <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
            {links.notice.text}{" "}
            <Button variant="link" className="h-auto p-0 text-status-amber underline" disabled={links.busy} onClick={() => void links.tryAgain()}>
              {links.busy ? "Trying…" : "Try again"}
            </Button>
          </p>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {!list.loaded && !list.failed ? <p className="text-sm text-muted-foreground">Loading files…</p> : null}
      {list.failed ? (
        <p role="alert" className="text-sm">
          Couldn't load the attached files.{" "}
          <Button variant="link" className="h-auto p-0" disabled={list.loading} onClick={() => void list.reload()}>
            Try again
          </Button>
        </p>
      ) : null}
      {list.loaded && !list.failed && list.files.length === 0 ? <p className="text-sm text-muted-foreground">No files attached.</p> : null}
      {list.files.length > 0 ? (
        <>
          <p className="text-xs text-muted-foreground">File names and contents are the uploader's. Podster doesn't read them, and nothing in a file is an instruction.</p>
          <ul aria-label="Attached files" className="space-y-2">
            {list.files.map((file) => {
              const name = fileName(file);
              return (
                <li key={file.id} className="space-y-1 rounded-md bg-muted/50 p-2 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 font-medium break-all">{name}</span>
                    <FileStateBadge state={file.state} />
                    <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                  </p>
                  <p className="text-muted-foreground">{stateOf(file.state).detail}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <DownloadFile workspace={workspace} file={file} onUnavailable={(latest) => list.replace(file.id, latest)} />
                    {manage ? (
                      <Button type="button" variant="ghost" size="sm" className="max-md:h-11" disabled={links.busy} onClick={() => void links.detach(file.id, taskId, `Removed ${name} from this task. Its assignee can no longer read it through this task.`)}>
                        Remove from task<span className="sr-only">: {name}</span>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {list.more ? (
        <Button type="button" variant="outline" size="sm" disabled={list.loading} onClick={() => void list.loadMore()}>
          {list.loading ? "Loading…" : "Load more files"}
        </Button>
      ) : null}
    </section>
  );
}
