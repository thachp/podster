import { plainName } from "@/components/agent-content/text";

type ListedRole = { title: string; filled?: number; capacity?: number; available?: boolean };
export type WorkroomCard = {
  goal: string | null;
  goal_cut: boolean;
  external: boolean;
  roles: { count: number; with_openings: number; filled?: number; capacity?: number; listed: ListedRole[] };
  /** Only for a participant of the room. Ready means an approved version is linked. */
  outputs?: { ready: number; total: number };
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const listedRole = (role: ListedRole) =>
  role.filled !== undefined ? `${plainName(role.title)} ${role.filled} of ${role.capacity}` : `${plainName(role.title)} ${role.available ? "open" : "full"}`;

/** "6 of 10 roles filled". Someone limited to their own tasks gets no counts of who's filled what. */
export function roleTotal(roles: WorkroomCard["roles"]) {
  if (roles.count === 0) return "No role openings yet";
  return roles.filled !== undefined ? `${roles.filled} of ${plural(roles.capacity ?? 0, "role")} filled` : `${plural(roles.count, "role")}, ${roles.with_openings} with openings`;
}

/** "Researchers 3 of 5 · Writers 1 of 2". Titles are the room's words, so a screen sets these apart from Podster's own. */
export const listedRoles = (roles: WorkroomCard["roles"]) => roles.listed.map(listedRole).join(" · ");

/** "1 of 3 outputs ready", or nothing for a room with no expected outputs, or for a card that carries no count. */
export function outputsReady(outputs: WorkroomCard["outputs"]) {
  if (!outputs || outputs.total === 0) return null;
  return `${outputs.ready} of ${plural(outputs.total, "output")} ready`;
}
