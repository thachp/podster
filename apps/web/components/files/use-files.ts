"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "@/app/(shell)/w/[id]/tasks/go-to-sign-in";
import { explainLink, type FilePage, type RoomFile } from "./model";

const base = (workspace: string) => `/api/v1/workspaces/${encodeURIComponent(workspace)}`;

/** Every page of the room's input assets the viewer can see, or only one task's. A failure leaves what's on screen, and says so. */
export function useFileList(workspace: string, initial: FilePage | null, taskId?: string) {
  const [files, setFiles] = useState<RoomFile[]>(initial?.files ?? []);
  const [cursor, setCursor] = useState<number | null>(initial ? initial.next_cursor : null);
  const [loaded, setLoaded] = useState(initial !== null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const query = taskId ? `task_id=${encodeURIComponent(taskId)}&` : "";

  const readPage = useCallback(
    async (from: number) => {
      const result = await clientQuery<FilePage>(`${base(workspace)}/files?${query}cursor=${from}`).catch(() => null);
      if (result && !result.ok && result.status === 401) goToSignIn();
      // Anything that isn't a page of files is a failed read, never an empty list.
      return result?.ok && Array.isArray(result.data?.files) ? result.data : null;
    },
    [workspace, query],
  );

  /** From the start again, as far as the list had reached, so a refresh never shortens what someone has scrolled to. */
  const reload = useCallback(async () => {
    setLoading(true);
    const pages = Math.max(1, Math.ceil(files.length / 50));
    const next: RoomFile[] = [];
    let from: number | null = 0;
    for (let page = 0; page < pages && from !== null; page += 1) {
      const read: FilePage | null = await readPage(from);
      if (!read) {
        setFailed(true);
        setLoading(false);
        return;
      }
      next.push(...read.files);
      from = read.next_cursor;
    }
    setFiles(next);
    setCursor(from);
    setFailed(false);
    setLoaded(true);
    setLoading(false);
  }, [files.length, readPage]);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoading(true);
    const read = await readPage(cursor);
    setLoading(false);
    if (!read) return setFailed(true);
    setFailed(false);
    setFiles((current) => [...current, ...read.files.filter((file) => !current.some((known) => known.id === file.id))]);
    setCursor(read.next_cursor);
  };

  const replace = useCallback((id: string, latest: RoomFile | null) => setFiles((current) => (latest ? current.map((file) => (file.id === id ? latest : file)) : current.filter((file) => file.id !== id))), []);

  // A Task Sheet has no server read to start from.
  const first = useRef(initial === null);
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    void reload();
  }, [reload]);

  return { files, more: cursor !== null, loaded, failed, loading, reload, loadMore, replace };
}

const POLL_MS = 10_000;
/** A room's reads are limited per person, so a long list of scanning files is checked a few at a time. */
const PER_TICK = 5;

/**
 * Re-reads files that are scanning until each has a verdict, so the screen says Scanning only while it's true. It shows only
 * what the API says: a file stays Scanning until the API says otherwise, and becomes Scan failed when the API does.
 */
export function useScanWatch(workspace: string, files: RoomFile[], replace: (id: string, latest: RoomFile | null) => void, onVerdict?: (file: RoomFile) => void) {
  const scanning = files.filter((file) => file.state === "scanning" || file.state === "uploading").map((file) => file.id);
  const key = scanning.join(",");
  const turn = useRef(0);
  const verdict = useRef(onVerdict);
  verdict.current = onVerdict;
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    let stopped = false;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      const start = (turn.current * PER_TICK) % ids.length;
      turn.current += 1;
      const batch = [...ids.slice(start), ...ids.slice(0, start)].slice(0, PER_TICK);
      for (const id of batch) {
        const read = await clientQuery<RoomFile>(`${base(workspace)}/files/${encodeURIComponent(id)}`).catch(() => null);
        if (stopped || !read) continue;
        if (read.ok) {
          replace(id, read.data);
          if (read.data.state !== "scanning" && read.data.state !== "uploading") verdict.current?.(read.data);
        } else if (read.status === 404) {
          replace(id, null);
        } else if (read.status === 401) {
          goToSignIn();
        }
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, workspace, replace]);
}

/** One intent, frozen, so sending it again is the same request under the same key, and a change that committed isn't made twice. */
type Attempt = { path: string; body?: unknown; method: "POST" | "DELETE"; key: string };

export type LinkNotice = { kind: "ok" | "refused" | "unknown"; text: string } | null;

/**
 * Attach and remove commands. Never optimistic: the list changes when it's read again. After an unknown outcome, Try again
 * repeats the same attempt, so the API answers it from its stored result.
 */
export function useLinkCommands(workspace: string, afterChange: () => Promise<void> | void) {
  const [notice, setNotice] = useState<LinkNotice>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ attempt: Attempt; success: string } | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const run = async (attempt: Attempt, success: string, retried: boolean) => {
    setBusy(true);
    const result = await clientCommand(attempt.path, attempt.body, { method: attempt.method, idempotencyKey: attempt.key }).catch(() => null);
    setBusy(false);
    if (result?.ok) {
      pending.current = null;
      setNotice({ kind: "ok", text: success });
      await afterChange();
    } else if (!result || result.status >= 500) {
      pending.current = { attempt, success };
      setNotice({ kind: "unknown", text: "We can't tell whether this saved. Try again: if it did, you'll get that answer and it won't happen twice." });
    } else if (result.status === 401) {
      goToSignIn();
    } else if (retried) {
      // A rate limit or refusal of the retry says nothing about whether the first one landed.
      setNotice({ kind: "unknown", text: result.status === 429 ? explainLink("rate_limited", 429, result.retryAfter) : "We still can't tell whether this saved. Refresh to see where things stand." });
    } else {
      pending.current = null;
      setNotice({ kind: "refused", text: explainLink(result.code, result.status, result.retryAfter) });
    }
    noticeRef.current?.focus();
  };

  const attach = (fileId: string, taskId: string, success: string) =>
    run({ path: `${base(workspace)}/files/${encodeURIComponent(fileId)}/links`, body: { task_id: taskId }, method: "POST", key: crypto.randomUUID() }, success, false);
  const detach = (fileId: string, taskId: string, success: string) =>
    run({ path: `${base(workspace)}/files/${encodeURIComponent(fileId)}/links/${encodeURIComponent(taskId)}`, method: "DELETE", key: crypto.randomUUID() }, success, false);
  const tryAgain = () => (pending.current ? run(pending.current.attempt, pending.current.success, true) : undefined);

  return { notice, noticeRef, busy, attach, detach, tryAgain, clear: () => setNotice(null) };
}
