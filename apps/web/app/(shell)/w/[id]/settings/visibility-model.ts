import { explainRefusal, PRESET_LABELS } from "../team/model";

/** One opening as the public page would show it. `id` is there only while it can be claimed publicly. */
export type PreviewOpening = { capacity: number; filled: number; id: string | null; lead: boolean; preset: string; publicly_claimable: boolean; responsibilities: string; title: string };

/** The public content, built field by field in Rust (ADR 0008). The preview and the served page come from the same code. */
export type PublicPreview = {
  archived: boolean;
  context: string | null;
  goal: string | null;
  name: string;
  openings: PreviewOpening[];
  outputs: { description: string | null; ready: boolean; title: string }[];
  participant_count: number;
  person_review: boolean;
  topic: string | null;
  workflow: string;
};

/** `getRoomVisibility`. Owner and human admins only. */
export type RoomVisibility = {
  visibility: "public" | "private";
  public_handle: string | null;
  published_at: number | null;
  published_on: string | null;
  topic: string | null;
  public_claims_paused: boolean;
  suspension: { reason: string; at: number } | null;
  public_rooms_enabled: boolean;
  preview: PublicPreview;
  view_hash: string;
};

/** The fixed list `setRoomTopic` takes. */
export const TOPICS: { value: string; label: string }[] = [
  { value: "engineering", label: "Engineering" },
  { value: "research", label: "Research" },
  { value: "business", label: "Business" },
  { value: "marketing", label: "Marketing" },
  { value: "film", label: "Film" },
  { value: "other", label: "Other" },
];

export const topicLabel = (topic: string | null) => (topic === null ? "None" : (TOPICS.find((t) => t.value === topic)?.label ?? topic));

/** An operator's reason code, in words. The code is all the room is told. */
const REASONS: Record<string, string> = { spam: "spam", abuse: "abuse", illegal: "illegal content", impersonation: "impersonation", privacy: "privacy", other: "another reason" };
export const suspensionReason = (code: string) => REASONS[code] ?? "another reason";

export const workflowLabel = (workflow: string) => (workflow === "engineering" ? "Engineering" : "General");

export function openingSummary(opening: PreviewOpening) {
  const preset = PRESET_LABELS[opening.preset] ?? opening.preset;
  const parts = [`${opening.filled} of ${opening.capacity} filled`, preset];
  if (opening.lead) parts.push("Lead coordinator");
  return parts.join(" · ");
}

/**
 * Whether going public can be offered, and if not, the one reason to show first. It only decides what to offer: Rust checks
 * each of these again, and the owner alone may publish (decision 148).
 */
export function publishBlock(state: RoomVisibility, { isOwner, archived }: { isOwner: boolean; archived: boolean }): string | null {
  if (!isOwner) return "Only the owner can make this workroom public. An admin can make it private.";
  if (state.suspension) return "Podster has suspended this workroom's public page, so it can't go public until Podster lifts that.";
  if (!state.public_rooms_enabled) return "Podster hasn't opened public workrooms yet. You can see what would be public, but not publish it.";
  if (archived) return "Bring this workroom back to make it public.";
  if (!state.preview.person_review) return "Public workrooms need a person to review. Turn on “Require a person to review” under Review first.";
  return null;
}

export function explainVisibilityRefusal(code: string, status = 400) {
  switch (code) {
    case "person_review_required":
      return "Public workrooms need a person to review. Turn on “Require a person to review” under Review, then try again. Nothing changed.";
    case "public_rooms_disabled":
      return "Podster hasn't opened public workrooms yet, so this can't go public. Nothing changed.";
    case "room_suspended":
      return "Podster has suspended this workroom's public page, so it can't go public until Podster lifts that. Nothing changed.";
    case "not_allowed":
      return "Only the owner can make this workroom public. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

export const STALE_PREVIEW = "What would be public changed since you looked, so it isn't public. Review the latest and confirm again.";
