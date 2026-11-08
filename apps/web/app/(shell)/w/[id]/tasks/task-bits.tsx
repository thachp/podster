"use client";

import { CheckCircle2, Circle, CircleDashed, CircleDot, Hourglass, Eye, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { chosenNameLabel } from "@/components/agent-content/text";
import { isChosenName, kindOf, TASK_STATUS, type TaskStatus, type Tone } from "./task-model";

const ICONS: Record<TaskStatus, LucideIcon> = { open: Circle, offered: Hourglass, accepted: CircleDot, submitted: Eye, completed: CheckCircle2, canceled: XCircle };

export const TONES: Record<Tone, string> = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  amber: "bg-status-amber-surface text-status-amber",
  blue: "bg-status-blue-surface text-status-blue",
  violet: "bg-status-violet-surface text-status-violet",
  green: "bg-status-green-surface text-status-green",
};

/** A label and an icon, so color is never the only signal. */
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const known = TASK_STATUS[status];
  const Icon = ICONS[status] ?? CircleDashed;
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[known?.tone ?? "neutral"])}>
      <Icon className="size-3" aria-hidden />
      {known?.label ?? "Unknown state"}
    </span>
  );
}

/** The same label-and-icon rule as the status, in the color a completed task has. */
export function ApprovedMark() {
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES.green)}>
      <CheckCircle2 className="size-3" aria-hidden />
      Approved
    </span>
  );
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function relativeTime(at: number, now: number) {
  const elapsed = now - at;
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.round(elapsed / size), unit);
  }
  return "just now";
}

/** Relative text, with the absolute time on hover and focus. The clock differs between server and browser, so it fills in after hydration. */
export function Timestamp({ at }: { at: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const iso = new Date(at).toISOString();
  return (
    <time dateTime={iso} title={iso} tabIndex={0} className="rounded-sm whitespace-nowrap text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {now === null ? iso.slice(0, 10) : relativeTime(at, now)}
    </time>
  );
}

/** A principal's name or ID in running text. Long IDs truncate, with the full ID on hover. */
export function PrincipalName({ id, label, me }: { id: string; label: string; me: string }) {
  return (
    <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="max-w-full truncate" title={id}>
        {label}
      </span>
      {isChosenName(id, label, me) ? <Badge variant="outline">{chosenNameLabel(kindOf(id))}</Badge> : null}
    </span>
  );
}

export const FIELD_CLASS =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30";

/**
 * A planning note, and never a state: the task keeps its own, and nothing holds back a command. A task that finished since
 * the plan was read has nothing left to wait for. Titles in the words are whatever their authors wrote, and React keeps them text.
 */
export function BlockedLine({ status, words }: { status: string; words?: string }) {
  if (!words || status === "completed" || status === "canceled") return null;
  return <p className="text-xs break-words text-status-amber">{words}</p>;
}
