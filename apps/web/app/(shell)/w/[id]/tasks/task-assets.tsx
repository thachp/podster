"use client";

import { useState } from "react";
import { DownloadFile } from "@/components/files/file-bits";
import { LinkNoticeView } from "@/components/files/link-notice";
import { FileStateBadge } from "@/components/files/file-state-badge";
import { fileName } from "@/components/files/model";
import { fileSize, fileState } from "@/lib/files/files";
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
  useScanWatch(workspace, list.files, list.replace, (file) => setAnnouncement(`${fileName(file)}: ${fileState(file.state).label}.`));
  const links = useLinkCommands(workspace, list.reload);
  // Detaching follows attaching's rule (decision 100), so a member narrowed to some tasks, who gets no `quota`, can't remove.
  const manage = canManage && !archived && list.wholeRoom;
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Attached files</h3>
      <LinkNoticeView notice={links.notice} noticeRef={links.noticeRef} busy={links.busy} tryAgain={links.tryAgain} />
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
                    <span className="text-muted-foreground">{fileSize(file.size)}</span>
                  </p>
                  <p className="text-muted-foreground">{fileState(file.state).detail}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <DownloadFile workspace={workspace} file={file} onUnavailable={(latest, message) => {
                        // A gone file's row goes, so its message moves to the notice above the list, with focus.
                        if (!latest) links.tell(message);
                        list.replace(file.id, latest);
                      }}
                    />
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
