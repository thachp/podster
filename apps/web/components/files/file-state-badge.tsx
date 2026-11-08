import { Ban, CheckCircle2, CircleDashed, Loader2, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { fileState, type FileTone } from "@/lib/files/files";

const ICONS: Record<string, LucideIcon> = { uploading: Loader2, scanning: Loader2, ready: CheckCircle2, blocked: Ban, failed: Ban, removed: Trash2 };

const TONES: Record<FileTone, string> = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  amber: "bg-status-amber-surface text-status-amber",
  blue: "bg-status-blue-surface text-status-blue",
  green: "bg-status-green-surface text-status-green",
};

/** A file's state as a label and an icon, so color is never the only signal. */
export function FileStateBadge({ state }: { state: string | null }) {
  const known = fileState(state);
  const Icon = (state && Object.hasOwn(ICONS, state) && ICONS[state]) || CircleDashed;
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[known.tone])}>
      <Icon className="size-3" aria-hidden />
      {known.label}
    </span>
  );
}
