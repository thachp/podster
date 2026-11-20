"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentContent, AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "../tasks/go-to-sign-in";
import { useLoadOnScroll } from "../tasks/task-pages";
import { isSelfReviewedMerge, kindOf, nameOf } from "../tasks/task-model";
import { eventsText, eventVerb } from "./model";
import { Time } from "./time";

export type RoomEvent = { id: string; type: string; from: { id: string; org?: string | null }; external: boolean; task_id: string | null; task_title: string | null; reason: string | null; created_at: number };

type Status = "idle" | "loading" | "failed" | "stale" | "lost";

type Props = {
  roomId: string;
  /** The filters, as a query string. Every later page asks for the same ones. */
  filters: string;
  first: RoomEvent[];
  nextBefore: string | null;
  /** The way back to the first page. */
  newest: string;
  /** This list starts from an older event, so the way back stays in reach above it. */
  fromOlder: boolean;
  me: string;
  names: Record<string, string>;
  orgNames: Record<string, string>;
  now: number;
};

/**
 * The room's events, newest first, so each page lands below the reader and nothing they're looking at moves. A read follows
 * a downward move near the bottom, or the button, which does the same for anyone who can't or doesn't scroll. The server
 * filters every page for this viewer.
 */
export function ActivityList({ roomId, filters, first, nextBefore, newest, fromOlder, me, names, orgNames, now }: Props) {
  const [more, setMore] = useState<RoomEvent[]>([]);
  const [cursor, setCursor] = useState(nextBefore);
  const [status, setStatus] = useState<Status>("idle");
  const [spoken, setSpoken] = useState("");
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const load = useCallback(() => {
    if (inFlight.current || cursor === null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setStatus("loading");
    const read = new URLSearchParams(filters);
    read.set("order", "newest");
    read.set("before", cursor);
    void (async () => {
      try {
        const result = await clientQuery<{ events: RoomEvent[]; next_before: string | null }>(`/api/v1/workspaces/${encodeURIComponent(roomId)}/activity?${read}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        inFlight.current = null;
        if (result.ok) {
          setMore((held) => {
            const known = new Set([...first, ...held].map((event) => event.id));
            return [...held, ...result.data.events.filter((event) => !known.has(event.id))];
          });
          setCursor(result.data.next_before);
          setStatus("idle");
          const added = result.data.events.length;
          setSpoken(`${added} more ${added === 1 ? "event" : "events"} loaded.`);
        } else if (result.status === 401) {
          goToSignIn();
        } else if (result.status === 400) {
          // A cursor the room no longer knows: trying it again can't help, so what's here stays, with the way back.
          setStatus("stale");
        } else if (result.status === 403 || result.status === 404) {
          setStatus("lost");
          setSpoken("");
        } else {
          setStatus("failed");
        }
      } catch {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        setStatus("failed");
      }
    })();
  }, [cursor, filters, first, roomId]);

  const rows = status === "lost" ? [] : first.concat(more);
  const bottom = useLoadOnScroll({ cursor, status, load, tasks: more }, false);
  const button = useRef<HTMLButtonElement>(null);
  const replacement = useRef<HTMLParagraphElement>(null);
  // Read while rendering, because by the time an effect runs the button has already gone.
  const buttonHadFocus = button.current !== null && document.activeElement === button.current;
  const buttonGoes = cursor === null || status === "stale" || status === "lost";
  useLayoutEffect(() => {
    if (buttonGoes && buttonHadFocus) replacement.current?.focus();
  });

  return (
    <>
      {/* Says a page arrived, which nothing else announces. The count is what keeps one page's words from another's. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {spoken ? `${spoken} ${eventsText(rows.length)} showing.` : ""}
      </p>
      {/* An alert below brings its own, and two links to one place only say the same thing twice. */}
      {fromOlder && status !== "stale" && status !== "lost" ? (
        <Link href={newest} prefetch={false} className="block w-fit text-primary underline">
          Back to the newest
        </Link>
      ) : null}
      <ol className="divide-y rounded-lg border empty:hidden">
        {rows.map((event) => {
          const author = { name: nameOf(event.from.id, me, names), kind: kindOf(event.from.id), organization: event.from.org ? (orgNames[event.from.org] ?? event.from.org) : undefined, viewer: event.from.id === me };
          return (
            <li key={event.id} className="space-y-1 p-3 text-sm">
              {/* The name, whether it's a person or an agent, and any label on it, the same as a task's history. */}
              <div title={event.from.id}>
                <AuthorLine author={author} external={event.external} />
              </div>
              <p className="break-words">
                {eventVerb(event.type)}
                {event.task_id ? (
                  <>
                    {" "}
                    <Link href={`/w/${roomId}/tasks?task=${encodeURIComponent(event.task_id)}`} prefetch={false} title={event.task_id} className="break-words text-primary underline">
                      {event.task_title ? plainName(event.task_title) : event.task_id}
                    </Link>
                  </>
                ) : null}
              </p>
              {/* Podster's own code, not anyone's words: decision 186 as amended 2026-11-20. */}
              {isSelfReviewedMerge(event) ? <p className="text-status-amber">Self-reviewed: nobody else reviewed it.</p> : event.reason ? <AgentContent author={author} external={event.external} body={event.reason} /> : null}
              <p className="text-muted-foreground">
                <Time at={event.created_at} now={now} />
              </p>
            </li>
          );
        })}
      </ol>
      {status === "lost" ? (
        <p ref={replacement} tabIndex={-1} role="alert" className="text-sm outline-none">
          You can't see this activity any more.{" "}
          <Link href={newest} prefetch={false} className="text-primary underline">
            Back to the newest
          </Link>
        </p>
      ) : status === "stale" ? (
        <p ref={replacement} tabIndex={-1} role="alert" className="text-sm outline-none">
          The next page isn't available. What's here is what was already loaded.{" "}
          <Link href={newest} prefetch={false} className="text-primary underline">
            Back to the newest
          </Link>
        </p>
      ) : cursor === null ? (
        nextBefore !== null ? (
          <p ref={replacement} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
            End of the activity when it loaded: {eventsText(rows.length)}. Reload to see any added since.
          </p>
        ) : null
      ) : (
        <>
          <div ref={bottom} aria-hidden />
          {/* The new rows land above this. While it holds focus it stays in view, so the reader's place and their focus both hold. It has to be a child of the section to stick that far. */}
          <div className="space-y-2 bg-background py-2 focus-within:sticky focus-within:bottom-0 focus-within:z-10">
            {status === "failed" ? (
              <p role="alert" className="text-sm">
                Couldn't load more events. What's here is what was already loaded. Press Load more to try again.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button ref={button} data-activity-load-more variant="outline" className="min-h-11 sm:min-h-8" aria-disabled={status === "loading"} onClick={load}>
                {status === "loading" ? "Loading more events" : "Load more"}
              </Button>
              <p className="text-sm text-muted-foreground">{eventsText(rows.length)} loaded so far. There are more.</p>
            </div>
          </div>
        </>
      )}
    </>
  );
}
