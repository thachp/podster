"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "cn";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { GatewayResult } from "@/lib/gateway/result";

/** What a pending request is bound to. A command gets this, so it can't address whatever is selected by the time it runs. */
export type SheetBinding = { target: string; version: number | null };

export type SheetApi<T> = {
  data: T;
  binding: SheetBinding;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  /** A draft that doesn't answer to a version, such as a new message. It holds the Sheet open like an edit, and leaves version checks and `dirty` alone. */
  setUnsaved: (unsaved: boolean) => void;
  /** A command in flight outside `run`, such as a new message. The Sheet won't close or discard under it, and other commands wait. */
  setSending: (sending: boolean) => void;
  saving: boolean;
  /**
   * Runs a command for this Sheet's own target. Never optimistic: on success the Sheet reloads and shows the server's state.
   * `explain` words a failure for this command, and a lost response or server error reaches it as code "unknown". After one of
   * those the Sheet reads the target again too, because the command may have gone through. It stays unsure until a command
   * succeeds, so a later refusal gets the Sheet's own "still can't tell" wording rather than `explain`.
   */
  run: <R>(command: (binding: SheetBinding) => Promise<GatewayResult<R>>, explain?: (code: string, status: number) => string) => Promise<GatewayResult<R> | null>;
  /** Reads the target again, for a command that doesn't go through `run`. */
  refresh: () => void;
  /** Reloads the list behind the Sheet, for a command outside `run` whose result the list can show. */
  refreshList: () => void;
  close: () => void;
};

export type TargetSheetProps<T> = {
  /** The query parameter that holds the target's ID, such as `task` for `?task=:taskId`. */
  param: string;
  /** `md` for access and agent details, `lg` for tasks. */
  size?: "md" | "lg";
  /** Resolve `null` when the target is missing or hidden. The viewer gets one message for both, and nothing about it. */
  load: (target: string, init: { signal: AbortSignal }) => Promise<T | null>;
  /** Names the object. Agent-written text shows as text only. */
  title: (data: T) => string;
  /** Names its workroom. */
  description: (data: T) => string;
  version?: (data: T) => number | null;
  /** The wording on a conflict, such as "task". */
  noun?: string;
  children: (api: SheetApi<T>) => ReactNode;
};

const SIZES = { md: "sm:max-w-[480px]", lg: "sm:max-w-[720px]" };

const InsideSheet = createContext(false);

/** The URL with this Sheet's parameter set or cleared. */
function hrefWith(pathname: string, search: URLSearchParams, param: string, target: string | null) {
  const next = new URLSearchParams(search);
  if (target === null) next.delete(param);
  else next.set(param, target);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The Sheet's own words for a failed command, for a command's `explain` to fall back on. */
export const FAILURE_COPY: Record<string, string> = {
  unknown: "We can't tell whether this saved. Refresh before trying again.",
  still_unknown: "We still can't tell whether your earlier change saved. Refresh to see where things stand.",
  signed_out: "You've been signed out, so this didn't save. Refresh to sign in again.",
  signed_out_unknown: "You've been signed out, so we still can't tell whether your earlier change saved. Refresh to sign in again.",
  rate_limited: "Too many requests, so this didn't save. Wait a minute and try again.",
  workspace_archived: "This workroom is archived, so nothing new can happen in it. Nothing changed. Its owner or an admin can bring it back.",
  refused: "That didn't save, and nothing changed. You may no longer be allowed to do this.",
};

function failureKind(status: number, code: string, earlierUnknown: boolean) {
  if (status === 401) return earlierUnknown ? "signed_out_unknown" : "signed_out";
  if (earlierUnknown) return "still_unknown";
  if (status === 429) return "rate_limited";
  return code === "workspace_archived" ? code : "refused";
}

const launcherKey = (param: string, target: string) => `${param}:${target}`;
let lastLauncher: HTMLElement | null = null;
const pressListeners = new Set<(param: string, target: string) => void>();

/**
 * Opens a Sheet from a list. It's a real link, so it can be opened in a new tab and shared, and it marks itself so focus
 * can find it again on close, even after a re-render or a reload.
 */
export function SheetLink({ param, target, onClick, ...props }: { param: string; target: string } & Omit<ComponentProps<typeof Link>, "href">) {
  if (useContext(InsideSheet)) throw new Error("A Sheet can't open another Sheet. Close it, then open the other.");
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const href = hrefWith(pathname, new URLSearchParams(search.toString()), param, target);
  return <Link {...props} onClick={(event) => {
    lastLauncher = event.currentTarget;
    onClick?.(event);
    // A press for a new tab leaves this page as it is.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    pressListeners.forEach((listener) => listener(param, target));
    // An SVG link's `target` is an object, which vinext's Link reads as a target and leaves to the browser, reloading the page.
    if (event.currentTarget instanceof SVGElement) {
      event.preventDefault();
      router.push(href, { scroll: false });
    }
  }} href={href} scroll={false} prefetch={false} data-sheet-launcher={launcherKey(param, target)} />;
}

function focusLauncher(param: string, target: string) {
  // A screen can offer the same target twice, as a list and a map do, so the one pressed comes first.
  const key = launcherKey(param, target);
  const pressed = lastLauncher?.isConnected && lastLauncher.getAttribute("data-sheet-launcher") === key ? lastLauncher : null;
  const launcher = pressed ?? document.querySelector<HTMLElement>(`[data-sheet-launcher="${CSS.escape(key)}"]`);
  (launcher ?? document.getElementById("main-content"))?.focus();
}

/**
 * The one right-side Sheet. The URL says what's selected, and `bound` says what's open: they differ only while an open
 * Sheet has unsaved edits or a save in flight, which finish or are discarded before it moves on. Each target gets its own
 * instance, so a late response belongs to the instance that asked for it and can't reach another target's.
 */
export function TargetSheet<T>(props: TargetSheetProps<T>) {
  const { param } = props;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selected = search.get(param);

  const [bound, setBound] = useState<string | null>(selected);
  const [busy, setBusy] = useState(false);
  const [goneNotice, setGoneNotice] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // The target just found to be gone. Navigation is asynchronous, so the URL still names it for a moment.
  const left = useRef<string | null>(null);

  // What was closed, and the URL then, until the URL stops naming it. A later navigation replaces one still in progress, so
  // a link built from the old URL can land on this target again though no one asked for it.
  const closed = useRef<{ target: string; search: string } | null>(null);
  const [reopened, setReopened] = useState(0);
  const searchText = search.toString();

  const navigate = useCallback((target: string | null) => router.push(hrefWith(pathname, new URLSearchParams(search.toString()), param, target), { scroll: false }), [router, pathname, search, param]);

  // Follows the URL, unless this Sheet still has something unfinished. Then the instance holds it and asks.
  useEffect(() => {
    if (selected !== left.current) left.current = null;
    if (selected === bound || busy || (selected !== null && selected === left.current)) return;
    if (selected !== null) setGoneNotice(false);
    setBound(selected);
  }, [selected, bound, busy, reopened]);

  // That link meant something else, such as a filter, so the closing still stands.
  useEffect(() => {
    if (!closed.current) return;
    if (selected !== closed.current.target) closed.current = null;
    else if (searchText !== closed.current.search) {
      closed.current.search = searchText;
      navigate(null);
    }
  }, [selected, searchText, navigate]);

  // Pressing the link while closing is on its way has an unchanged URL to go to, so the URL can't say this was asked for.
  useEffect(() => {
    const onPress = (pressedParam: string, target: string) => {
      if (pressedParam !== param || closed.current?.target !== target) return;
      closed.current = null;
      left.current = null;
      setReopened((count) => count + 1);
    };
    pressListeners.add(onPress);
    return () => void pressListeners.delete(onPress);
  }, [param]);

  useEffect(() => {
    if (goneNotice) noticeRef.current?.focus();
  }, [goneNotice]);

  const onGone = useCallback(() => {
    left.current = bound;
    closed.current = bound === null ? null : { target: bound, search: searchText };
    setBusy(false);
    setGoneNotice(true);
    setBound(null);
    navigate(null);
  }, [navigate, bound, searchText]);

  return (
    <>
      {goneNotice ? (
        <p ref={noticeRef} tabIndex={-1} role="alert" className="rounded-lg border p-3 outline-none">
          We can't find that. It may not exist, or you may not have access to it.
        </p>
      ) : null}
      {bound === null ? null : (
        <BoundSheet
          key={`${bound}:${reopened}`}
          {...props}
          target={bound}
          selected={selected}
          onBusyChange={setBusy}
          onGone={onGone}
          onClose={() => {
            closed.current = { target: bound, search: searchText };
            navigate(null);
          }}
          onStay={() => navigate(bound)}
          onRefreshList={() => router.refresh()}
        />
      )}
    </>
  );
}

type BoundProps<T> = TargetSheetProps<T> & {
  target: string;
  /** What the URL says now. */
  selected: string | null;
  onBusyChange: (busy: boolean) => void;
  onGone: () => void;
  onClose: () => void;
  onStay: () => void;
  onRefreshList: () => void;
};

type Loaded<T> = { phase: "loading" } | { phase: "ready"; data: T; refreshFailed: boolean } | { phase: "failed" };

function BoundSheet<T>({ param, size = "md", load, title, description, version, noun = "item", children, target, selected, onBusyChange, onGone, onClose, onStay, onRefreshList }: BoundProps<T>) {
  const [loaded, setLoaded] = useState<Loaded<T>>({ phase: "loading" });
  const [reloads, setReloads] = useState(0);
  const [dirty, setDirtyState] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [sending, setSending] = useState(false);
  // The version a draft was read at. A reload can show newer data, but the draft still answers to this one, so saving it conflicts instead of overwriting.
  const draftVersion = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  // A save that failed after the URL moved on. The Sheet holds until the person has seen it.
  const [heldFailure, setHeldFailure] = useState(false);
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  // An earlier attempt here may have committed. Authority and rate limits answer before a replay, so a refusal can't rule that out.
  const outcomeUnknown = useRef(false);
  const [asking, setAsking] = useState(false);
  const [closing, setClosing] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);

  const loadRef = useRef(load);
  loadRef.current = load;
  const versionRef = useRef(version);
  versionRef.current = version;
  // This Sheet's own command moved the version. Its draft carries on from what that read shows, so only someone else's change conflicts.
  const ownChange = useRef(false);
  const [settling, setSettling] = useState(false);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const goneCalled = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Mounted once per target, so `alive` going false means this target's Sheet is finished with.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    // Only a read begun after this Sheet's own change can speak for it. One already out may hold what came before.
    const adopts = ownChange.current;
    setLoaded((previous) => (previous.phase === "failed" ? { phase: "loading" } : previous));
    loadRef
      .current(target, { signal: controller.signal })
      .then((data) => {
        if (!current) return;
        if (data === null) {
          // It's gone, or the viewer's access is. Either way, nothing more about it shows.
          goneCalled.current = true;
          goneRef.current();
        } else {
          if (adopts && versionRef.current) draftVersion.current = versionRef.current(data);
          if (adopts) {
            ownChange.current = false;
            setSettling(false);
          }
          setLoaded({ phase: "ready", data, refreshFailed: false });
        }
      })
      .catch(() => {
        // This read was replaced, and whichever replaced it answers.
        if (!current) return;
        // Without a read there's no version to carry on from, so a draft keeps answering to the old one and conflicts rather than overwrites.
        if (adopts) {
          ownChange.current = false;
          setSettling(false);
        }
        // A read failure keeps prior data on screen.
        if (current) setLoaded((previous) => (previous.phase === "ready" ? { ...previous, refreshFailed: true } : { phase: "failed" }));
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [target, reloads]);

  const hasDraft = dirty || unsaved;
  const inFlight = saving || sending;
  const busy = hasDraft || inFlight || heldFailure;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // The URL moved away, by Back or a link, while this Sheet was busy. A save finishes first; edits need an answer.
  useEffect(() => {
    if (selected !== target && hasDraft && !inFlight) setAsking(true);
  }, [selected, target, hasDraft, inFlight]);

  // Leaving the app altogether is beyond the Sheet's own prompt, so this asks the browser to. Browsers choose the wording.
  useEffect(() => {
    if (!hasDraft && !inFlight) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [hasDraft, inFlight]);

  const finish = () => {
    setClosing(true);
    onBusyChange(false);
    onClose();
  };

  const requestClose = () => {
    if (inFlight) return;
    if (hasDraft) setAsking(true);
    // The URL has already moved on, so closing this goes there.
    else if (selected !== target) setHeldFailure(false);
    else finish();
  };

  const discard = () => {
    setAsking(false);
    setHeldFailure(false);
    setDirty(false);
    setUnsaved(false);
    // Moves on to whatever the URL now says, or closes.
    if (selected === target) finish();
    else onBusyChange(false);
  };

  const keepEditing = () => {
    setAsking(false);
    if (selected !== target) onStay();
  };

  const data = loaded.phase === "ready" ? loaded.data : null;
  const shownVersion = data !== null && version ? version(data) : null;
  const binding: SheetBinding = { target, version: dirty ? draftVersion.current : shownVersion };

  const rereadAfterUnknown = () => {
    setReloads((count) => count + 1);
    onRefreshList();
  };

  function setDirty(next: boolean) {
    if (next && !dirty) draftVersion.current = shownVersion;
    setDirtyState(next);
    // A failure about a draft that's gone would tell the person to retry something they can't.
    if (!next) {
      setFailedCode(null);
      setFailedText(null);
    }
  }

  async function run<R>(command: (binding: SheetBinding) => Promise<GatewayResult<R>>, explain?: (code: string, status: number) => string): Promise<GatewayResult<R> | null> {
    // A second click can't send a second command while the first is out.
    if (savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    setConflict(false);
    setFailedCode(null);
    setFailedText(null);
    setHeldFailure(false);
    try {
      const result = await command(binding);
      // The list behind may have changed, whatever became of this Sheet.
      if (result.ok) {
        outcomeUnknown.current = false;
        onRefreshList();
      } else if (result.status >= 500) outcomeUnknown.current = true;
      if (!alive.current) return result;
      if (result.ok) {
        setDirty(false);
        ownChange.current = true;
        setSettling(true);
        setReloads((count) => count + 1);
      } else {
        if (result.code === "version_conflict") setConflict(true);
        else {
          const kind = result.status >= 500 ? "unknown" : failureKind(result.status, result.code, outcomeUnknown.current);
          setFailedCode(kind);
          // A command's own explanation says why it was refused, which can't speak for an earlier attempt that may have gone through.
          const answersForEarlier = kind === "still_unknown" || kind === "signed_out_unknown";
          setFailedText(answersForEarlier ? null : (explain?.(kind === "unknown" ? "unknown" : result.code, result.status) ?? null));
          // Not after being signed out, when a read would only send the person to sign in, with their draft still here.
          if (kind === "unknown" || kind === "still_unknown") rereadAfterUnknown();
        }
        if (selectedRef.current !== target) setHeldFailure(true);
      }
      return result;
    } catch {
      outcomeUnknown.current = true;
      if (alive.current) {
        setFailedCode("unknown");
        setFailedText(explain?.("unknown", 0) ?? null);
        rereadAfterUnknown();
        if (selectedRef.current !== target) setHeldFailure(true);
      }
      return null;
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  const heading = data !== null ? title(data) : loaded.phase === "failed" ? "Couldn't load this" : "Loading";

  return (
    <InsideSheet.Provider value={true}>
      <Sheet open={!closing} onOpenChange={(open) => !open && requestClose()}>
        <SheetContent
          side="right"
          className={cn("w-full overflow-y-auto", SIZES[size])}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Moving to another target or a not-found message has its own place for focus.
            if (goneCalled.current || (selectedRef.current !== null && selectedRef.current !== target)) return;
            focusLauncher(param, target);
          }}
        >
          <SheetHeader>
            <SheetTitle ref={titleRef} tabIndex={-1} className="pr-8 break-words outline-none">
              {heading}
            </SheetTitle>
            <SheetDescription className="break-words">{data !== null ? description(data) : "\u00a0"}</SheetDescription>
            {hasDraft ? <p role="status">Unsaved changes</p> : null}
          </SheetHeader>
          <div className="flex-1 space-y-4 px-4 pb-4">
            {loaded.phase === "loading" ? (
              <div aria-hidden className="space-y-3">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : null}
            {loaded.phase === "failed" || (loaded.phase === "ready" && loaded.refreshFailed) ? (
              <p role="alert">
                Couldn't refresh.{" "}
                <Button variant="link" className="h-auto p-0" onClick={() => setReloads((count) => count + 1)}>
                  Try again
                </Button>
              </p>
            ) : null}
            {conflict ? (
              <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
                This {noun} changed while you were editing. Your changes aren't saved.{" "}
                <Button
                  variant="link"
                  className="h-auto p-0 text-status-amber underline"
                  onClick={() => {
                    setConflict(false);
                    setDirty(false);
                    // Reviewing is the person choosing to carry on from what's there now, so a form that keeps its text answers to that.
                    ownChange.current = true;
                    setSettling(true);
                    setReloads((count) => count + 1);
                  }}
                >
                  Review latest
                </Button>
              </p>
            ) : null}
            {failedText ? (
              <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
                {failedText}
              </p>
            ) : null}
            {failedCode && !failedText ? (
              <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
                {FAILURE_COPY[failedCode] ?? FAILURE_COPY.refused}
              </p>
            ) : null}
            {data !== null ? children({ data, binding, dirty, setDirty, setUnsaved, setSending, saving: inFlight || settling, run, refreshList: onRefreshList, refresh: () => setReloads((count) => count + 1), close: requestClose }) : null}
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog open={asking}>
        <AlertDialogContent onEscapeKeyDown={keepEditing}>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">{data !== null ? <>Your changes to “{title(data)}” won't be saved.</> : "Your changes won't be saved."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={keepEditing}>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={discard}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </InsideSheet.Provider>
  );
}
