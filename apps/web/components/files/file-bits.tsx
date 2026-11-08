"use client";

import { CheckCircle2, CircleDashed, Download, Loader2, ShieldAlert, TriangleAlert, Upload } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { fileName, stateOf, type RoomFile } from "./model";

const TONES = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  blue: "bg-status-blue-surface text-status-blue",
  green: "bg-status-green-surface text-status-green",
  danger: "bg-status-danger-surface text-status-danger",
  amber: "bg-status-amber-surface text-status-amber",
};

const ICONS = { uploading: Upload, scanning: Loader2, ready: CheckCircle2, blocked: ShieldAlert, failed: TriangleAlert };

/** A label and an icon, so color is never the only signal. Scanning says so until there's a verdict. */
export function FileStateBadge({ state }: { state: string }) {
  const info = stateOf(state);
  const Icon = ICONS[state as keyof typeof ICONS] ?? CircleDashed;
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[info.tone])}>
      <Icon className={cn("size-3", state === "scanning" && "motion-safe:animate-spin")} aria-hidden />
      {info.label}
    </span>
  );
}

type DownloadProps = { workspace: string; file: Pick<RoomFile, "id" | "name" | "download_path">; onUnavailable?: (latest: RoomFile | null) => void; className?: string };

/**
 * Downloads a ready file as an attachment, through this host's `/api`. It reads the file once more first, so a file that was
 * removed, blocked or put out of reach since the list was read says so here instead of as a failed download.
 * The download itself checks the person's access again, and that's what decides.
 */
export function DownloadFile({ workspace, file, onUnavailable, className }: DownloadProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The reason stays after a re-read takes the download away, which is when it matters.
  if (!file.download_path && !problem) return null;
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
    if (!latest.data.download_path) {
      onUnavailable?.(latest.data);
      return setProblem(`This file can't be downloaded now. Its state is ${stateOf(latest.data.state).label}.`);
    }
    // An attachment, so the page stays where it is, and the browser's own downloads show the file.
    const link = document.createElement("a");
    link.href = `/api${latest.data.download_path}`;
    link.download = "";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
      {file.download_path ? (
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
