"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { downloadHref, fileState } from "@/lib/files/files";
import { fileName, type RoomFile } from "./model";

type DownloadProps = { workspace: string; file: Pick<RoomFile, "id" | "name" | "state" | "download_path">; onUnavailable?: (latest: RoomFile | null) => void; className?: string };

/**
 * Downloads a ready file as an attachment, through this host's `/api`. It reads the file once more first, so a file that was
 * removed, blocked or put out of reach since the list was read says so here instead of as a failed download.
 * The download itself checks the person's access again, and that's what decides.
 */
export function DownloadFile({ workspace, file, onUnavailable, className }: DownloadProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The reason stays after a re-read takes the download away, which is when it matters.
  const offered = downloadHref(file) !== null;
  if (!offered && !problem) return null;
  const name = fileName(file);
  const start = async () => {
    setBusy(true);
    setProblem(null);
    const latest = await clientQuery<RoomFile>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/files/${encodeURIComponent(file.id)}`).catch(() => null);
    setBusy(false);
    if (!latest) return setProblem("Couldn't reach Podster, so the download didn't start. Try again.");
    if (!latest.ok) {
      if (latest.status === 429) return setProblem("Too many requests, so the download didn't start. Wait a minute and try again.");
      if (latest.status >= 500) return setProblem("Couldn't reach Podster, so the download didn't start. Try again.");
      onUnavailable?.(null);
      return setProblem("This file isn't there any more, or your access no longer includes it.");
    }
    // Only what the shared rule makes a link (Ready, with a path of the API's own shape) is followed.
    const href = downloadHref(latest.data);
    if (!href) {
      onUnavailable?.(latest.data);
      return setProblem(`This file can't be downloaded now. Its state is ${fileState(latest.data.state).label}.`);
    }
    // An attachment, so the page stays where it is, and the browser's own downloads show the file.
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
      {offered ? (
        <Button type="button" variant="outline" size="sm" className="max-md:h-11" disabled={busy} onClick={() => void start()}>
          <Download aria-hidden />
          {busy ? "Starting…" : "Download"} <span className="sr-only">{name}</span>
        </Button>
      ) : null}
      {problem ? (
        <span role="alert" className="text-sm text-status-danger">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
