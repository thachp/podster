"use client";

import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { LinkNotice } from "./use-files";

type Props = { notice: LinkNotice; noticeRef: RefObject<HTMLDivElement | null>; busy: boolean; tryAgain: () => Promise<void> | undefined };

/**
 * What an attach, a removal or a download that found the file gone came to. The wrapper is always there, so focus has somewhere
 * stable to land when the row that was acted on goes. Good news goes in a status that's always there, and trouble is an
 * alert beside it, never one inside the other.
 */
export function LinkNoticeView({ notice, noticeRef, busy, tryAgain }: Props) {
  return (
    <div ref={noticeRef} tabIndex={-1} className="rounded-lg text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div role="status">{notice?.kind === "ok" ? <p className="rounded-lg bg-status-green-surface p-3 text-status-green">{notice.text}</p> : null}</div>
      {notice?.kind === "refused" ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {notice.text}
        </p>
      ) : null}
      {notice?.kind === "unknown" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
          {notice.text}{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" disabled={busy} onClick={() => void tryAgain()}>
            {busy ? "Trying…" : "Try again"}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
