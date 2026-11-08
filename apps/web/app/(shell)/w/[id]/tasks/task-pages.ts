"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { summaryOf, type Task, type TaskSummary } from "./task-model";

export type TaskPages = {
  /** The tasks these pages added. */
  tasks: TaskSummary[];
  /** Where the next page starts, or null at the end: the last task a page returned, never a position. */
  cursor: string | null;
  status: "idle" | "loading" | "failed";
  /** A later page was refused, so access may be gone and nothing already loaded should stay on screen. */
  lost: boolean;
  /** How many pages have arrived. */
  pages: number;
  /** The page that just arrived on the end of the list, to say so. A new object for each. */
  announce: { count: number } | null;
  /** Reads the next page, unless one is already on its way. */
  load: () => void;
  /** Reads the first page again, keeping what's held on screen until the answer comes, and later pages after it. */
  restart: () => void;
};

/** A read that doesn't reach the screen is at most this far from the reader's place. */
type Held = { generation: number; tasks: TaskSummary[]; firstPageRows: number; laterFrom: string | null; cursor: string | null | undefined; pages: number; announce: { count: number } | null; lost: boolean };
const nothingHeld = (generation: number): Held => ({ generation, tasks: [], firstPageRows: 0, laterFrom: null, cursor: undefined, pages: 0, announce: null, lost: false });

/**
 * Keeps what the reader is looking at where it is when rows arrive above it, because a page adds to every group. Chrome and
 * Firefox anchor scrolling themselves, which leaves nothing to correct here. Safari doesn't.
 */
export function rememberPlace() {
  const focused = document.activeElement?.closest?.("[data-sheet-launcher]") ?? document.activeElement;
  const onScreen = (el: Element) => {
    const { top, bottom } = el.getBoundingClientRect();
    return bottom > 0 && top < window.innerHeight;
  };
  const anchor = focused && focused !== document.body && onScreen(focused) ? focused : [...document.querySelectorAll('[data-sheet-launcher^="task:"], [data-task-load-more]')].find(onScreen);
  if (!anchor) return null;
  const before = anchor.getBoundingClientRect().top;
  return () => {
    if (!anchor.isConnected) return;
    const moved = anchor.getBoundingClientRect().top - before;
    if (moved !== 0) window.scrollBy(0, moved);
  };
}

/**
 * Pages of a room's tasks past the ones the page was rendered with, one read at a time. `filter` is what the server narrows
 * by. It never decides what the reader may see, because the server filters every row. A new `generation` means what's held
 * can't be trusted, so it's dropped. A new `firstRead` is the page reading again, which is the way back from a refusal.
 */
export function useTaskPages(workspace: string, filter: string, start: string | null, generation: number, firstRead: unknown): TaskPages {
  const [stored, setStored] = useState(() => nothingHeld(generation));
  const held = stored.generation === generation ? stored : nothingHeld(generation);
  const [status, setStatus] = useState<TaskPages["status"]>("idle");
  const inFlight = useRef<AbortController | null>(null);
  const restore = useRef<(() => void) | null>(null);
  const cursor = held.cursor === undefined ? start : held.cursor;

  const abort = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);
  useEffect(() => abort, [abort]);
  // A read for what was just dropped must not land on what replaces it.
  useEffect(() => {
    abort();
    setStatus("idle");
  }, [abort, generation]);
  useEffect(() => {
    setStored((now) => (now.lost ? nothingHeld(now.generation) : now));
  }, [firstRead]);
  useLayoutEffect(() => {
    restore.current?.();
    restore.current = null;
  }, [stored]);

  const read = useCallback(
    (from: string, replace: boolean) => {
      const controller = new AbortController();
      inFlight.current = controller;
      setStatus("loading");
      void (async () => {
        try {
          const result = await clientQuery<{ tasks: Task[]; next_cursor: string | null }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/tasks?cursor=${encodeURIComponent(from)}${filter}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          inFlight.current = null;
          if (result.ok) {
            const rows = result.data.tasks.map(summaryOf);
            restore.current = rememberPlace();
            const next = result.data.next_cursor;
            setStored((before) => {
              const now = before.generation === generation ? before : nothingHeld(generation);
              if (!replace) return { ...now, tasks: [...now.tasks, ...rows], firstPageRows: now.pages === 0 ? rows.length : now.firstPageRows, laterFrom: now.pages === 1 ? from : now.laterFrom, cursor: next, pages: now.pages + 1, announce: { count: rows.length }, lost: false };
              // Later pages stay, as the reader's place, only if the new first page reaches where they start: it holds the task
              // the old first page ended on, where the later pages pick up, or one of theirs. A task joining the list pushes that
              // task off the end, and a row between the two would then be on neither and nothing would fetch it. Rows past that
              // point overlap at most, and `mergeTasks` removes those. A cursor is a task's ID, not a position, so rows tell, or
              // a first page that ends where it did.
              const later = new Set(now.tasks.slice(now.firstPageRows).map((task) => task.id));
              const keepLater = next !== null && now.laterFrom !== null && (next === now.laterFrom || rows.some((row) => row.id === now.laterFrom || later.has(row.id)));
              return { ...now, tasks: keepLater ? [...rows, ...now.tasks.slice(now.firstPageRows)] : rows, firstPageRows: rows.length, laterFrom: keepLater ? now.laterFrom : null, cursor: keepLater ? now.cursor : next, pages: keepLater ? now.pages : 1, announce: null, lost: false };
            });
            setStatus("idle");
          } else if (result.status === 401) {
            goToSignIn();
          } else if (result.status === 403 || result.status === 404) {
            setStored({ ...nothingHeld(generation), lost: true });
            setStatus("idle");
          } else {
            setStatus("failed");
          }
        } catch {
          if (controller.signal.aborted) return;
          inFlight.current = null;
          setStatus("failed");
        }
      })();
    },
    [filter, generation, workspace],
  );

  const load = useCallback(() => {
    if (!inFlight.current && cursor !== null) read(cursor, false);
  }, [cursor, read]);
  const restart = useCallback(() => {
    abort();
    read(start ?? "", true);
  }, [abort, read, start]);

  return { tasks: held.tasks, cursor, status, lost: held.lost, pages: held.pages, announce: held.announce, load, restart };
}

/** How near the bottom a read starts, and how far the reader has to have moved. Less than that is a correction rounding. */
const NEAR_BOTTOM_PX = 400;
const MOVED_PX = 4;

/**
 * Asks for the next page when the reader scrolls down near the bottom. Each read has to follow a move of theirs, which is
 * what the owner chose. A page can land entirely above the reader, and correcting for that leaves them just as near the
 * bottom, so being near isn't enough, or one scroll would run through the whole room with nobody reading it. What's
 * measured is the bottom's distance from the top of the window: new rows above and that correction leave it alone, and so
 * does a browser's own anchoring, whose scroll event would otherwise look like the reader's.
 *
 * A reader can get to the bottom before this is listening, on a slow page, and then has nowhere further down to move. So it looks
 * once when it starts, and reads for someone who has moved down the page and is near the bottom. That's still a move of theirs,
 * and being scrolled to the top isn't, so a list that fits the window waits for the button.
 */
export function useLoadOnScroll(pages: { cursor: unknown; status: string; load: () => void; tasks: unknown }, paused: boolean) {
  const bottom = useRef<HTMLDivElement>(null);
  const latest = useRef({ ...pages, paused });
  useEffect(() => {
    latest.current = { ...pages, paused };
  });
  const last = useRef<number | null>(null);
  const measure = () => bottom.current?.getBoundingClientRect().top ?? null;
  // New rows below the reader push the bottom away without them moving, and going back to it is a move. This runs after any correction.
  const arrived = pages.tasks;
  useEffect(() => {
    last.current = measure();
  }, [arrived]);
  const present = pages.cursor !== null;
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current || !present) return;
    // After this commit's other effects, because a list's own start cancels any read begun before it.
    const look = setTimeout(() => {
      // Only here, so a look cleared before it ran, as when the bottom goes away that soon, still happens later.
      looked.current = true;
      const now = measure();
      const { status, paused: stopped, load } = latest.current;
      if (now !== null && window.scrollY > 0 && now < window.innerHeight + NEAR_BOTTOM_PX && status === "idle" && !stopped) load();
    });
    return () => clearTimeout(look);
  }, [present]);
  useEffect(() => {
    if (!present) return;
    last.current = measure();
    const onScroll = () => {
      const now = measure();
      if (now === null) return;
      const moved = last.current === null ? 0 : last.current - now;
      if (last.current !== null && Math.abs(moved) < MOVED_PX) return;
      last.current = now;
      const { status, paused: stopped, load } = latest.current;
      if (moved > 0 && now < window.innerHeight + NEAR_BOTTOM_PX && status === "idle" && !stopped) load();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [present]);
  return bottom;
}
