import { CheckCircle2, CircleDashed, CircleDot, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "cn";

const TONES = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  amber: "bg-status-amber-surface text-status-amber",
  blue: "bg-status-blue-surface text-status-blue",
  green: "bg-status-green-surface text-status-green",
  danger: "bg-status-danger-surface text-status-danger",
} as const;

const ICONS: Record<keyof typeof TONES, LucideIcon> = { neutral: CircleDashed, amber: TriangleAlert, blue: CircleDot, green: CheckCircle2, danger: XCircle };

/** A label and an icon, so color is never the only signal. */
export function StateBadge({ label, tone }: { label: string; tone: keyof typeof TONES }) {
  const Icon = ICONS[tone];
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone])}>
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}
