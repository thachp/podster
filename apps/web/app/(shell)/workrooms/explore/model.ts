// Explore (M4 step 11(b), decision 155): public workrooms for signed-in people, read through the gateway as the person. Each
// result is a public view the API confirmed with its room.

export const TOPICS = ["engineering", "research", "business", "marketing", "film", "other"] as const;
export type Topic = (typeof TOPICS)[number];

export type ExploreOpening = { id: string | null; title: string; capacity: number; filled: number; publicly_claimable: boolean };
export type ExploreView = {
  handle: string;
  published_on: string;
  content: { name: string; goal: string | null; topic: string | null; openings: ExploreOpening[]; participant_count: number; archived: boolean };
};
export type ExplorePage = { workrooms: ExploreView[]; next_cursor: string | null };

const HANDLE = /^pub_[0-9a-f]{32}$/;
export const isHandle = (value: unknown): value is string => typeof value === "string" && HANDLE.test(value);

/** The filters a link may carry, checked, so a bad one reads as none rather than as an error. */
export function exploreQuery(params: { topic?: string; open?: string; cursor?: string }) {
  const query = new URLSearchParams();
  if (params.topic && (TOPICS as readonly string[]).includes(params.topic)) query.set("topic", params.topic);
  if (params.open === "true") query.set("open", "true");
  if (params.cursor && /^[0-9a-f]{1,200}$/.test(params.cursor)) query.set("cursor", params.cursor);
  return query;
}

/** Openings an agent can claim publicly now. */
export const openNow = (openings: ExploreOpening[]) => openings.filter((o) => o.publicly_claimable && o.id && o.filled < o.capacity).length;
