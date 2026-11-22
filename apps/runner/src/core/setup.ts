/**
 * A starter run policy from a workroom's settings, and the room changes that need the owner after it (issue 523). Pure:
 * no I/O, no clock. `src/node/setup-command.ts` (the `setup` command) and `room-facts.ts` (the check `run` makes) do the
 * reading, the asking and the writing.
 *
 * - **Facts, not instructions.** Podster's room read gives an agent that could hold the room's repository grant its
 *   `setup`: the room's ID, its organization and its linked repository's full name and GitHub's numeric ID, or null
 *   (`getWorkspace` in the contract). They are checked whole, as IDs and a GitHub full name, and used only to fill the
 *   fields of a proposal the owner reads. A read with no `setup`, or one that doesn't check out, is unknown: never a room
 *   without a repository, and nothing is proposed from it.
 * - **The owner decides.** Nothing here writes a file or turns anything on. A starter room asks before each run, holds
 *   outputs for review, has no shell and no network, and has neither acknowledgment ticked. Another organization's room
 *   is shown as external, and its organization goes into `allowed_orgs` only when the owner said yes to exactly that.
 *   `owner_org` is always the paired agent's own organization, never the room's. Unattended runs stay off (decision 29).
 * - **Widening asks, narrowing shows.** After setup, a repository linked to a room, or replaced, is a change the owner
 *   approves before it's written. A repository unlinked takes access away, so it's written at once and shown. Either way
 *   only that room's `repository` and the policy's `revision` change: every other field, limit and permission the owner
 *   wrote stays exactly as it was.
 * - **The file's own rules hold.** Every proposal is checked by `parsePolicyConfig` before it's offered, so a policy this
 *   writes is one Runner would load: no unknown or missing field, IDs in lower case, and `owner_org` never in
 *   `allowed_orgs`.
 */
import { DEFAULT_TOOLS, isFullName, isPolicyId, parsePolicyConfig, policyProblem, type PolicyConfig, type RepoScope, type RoomPolicy } from "./policy.js";

/** What Podster says about a room, checked. */
export type RoomFacts = { room_id: string; org_id: string; repository: RepoScope | null };
/**
 * `not_shared`: the read has no `setup`, so this agent isn't told (a public claim, or a server without it).
 * `inconsistent`: it has one that doesn't check out, or names another room.
 */
export type FactsProblem = "not_shared" | "inconsistent";
export type FactsRead = { ok: true; facts: RoomFacts } | { ok: false; problem: FactsProblem };

/** The starter's limits: conservative, each well under its ceiling. The same as the README's example. */
export const STARTER_CAPS = { spend_micro_usd: 500_000, run_time_ms: 900_000, turns: 30, output_tokens: 20_000, max_tokens: 8_000 } as const;
export const STARTER_DAY_SPEND_MICRO_USD = 2_000_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (o: Obj, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** The room read's `setup`, for the room asked about, checked whole. */
export function readRoomFacts(workspaceId: string, answer: unknown): FactsRead {
  if (!isObj(answer) || !Object.hasOwn(answer, "setup") || answer.setup === undefined) return { ok: false, problem: "not_shared" };
  const setup = answer.setup;
  if (!isObj(setup) || !keysAre(setup, ["room_id", "org_id", "repository"])) return { ok: false, problem: "inconsistent" };
  const { room_id, org_id, repository } = setup;
  if (!isPolicyId(room_id) || room_id !== workspaceId || !isPolicyId(org_id)) return { ok: false, problem: "inconsistent" };
  if (repository === null) return { ok: true, facts: { room_id, org_id, repository: null } };
  if (!isObj(repository) || !keysAre(repository, ["full_name", "provider_repo_id"])) return { ok: false, problem: "inconsistent" };
  const { full_name, provider_repo_id } = repository;
  if (!isFullName(full_name) || typeof provider_repo_id !== "number" || !Number.isSafeInteger(provider_repo_id) || provider_repo_id < 1) return { ok: false, problem: "inconsistent" };
  return { ok: true, facts: { room_id, org_id, repository: { full_name, provider_repo_id } } };
}

/** Why facts couldn't be used, for the owner, in fixed words. */
export function factsProblemText(problem: FactsProblem): string {
  return problem === "not_shared"
    ? "Podster didn't tell this agent the room's organization and repository. That happens when the agent joined through a public claim, isn't in the room, or the server doesn't share them yet. Runner won't guess them, so nothing was proposed."
    : "Podster's answer about the room didn't check out (an ID that isn't lower case, another room, or a repository without a valid name and numeric ID). Runner won't guess, so nothing was proposed.";
}

/** Whether the room is another organization's than the owner's. */
export const isExternal = (facts: RoomFacts, ownerOrg: string) => facts.org_id !== ownerOrg;

/**
 * A starter room entry: ask first, outputs held, the default tools (no shell), no network, Podster's repository or null,
 * and no acknowledgment ticked. The room's organization is allowed only when it's another's and the owner approved it.
 */
export function starterRoom(facts: RoomFacts, ownerOrg: string, allowRoomOrg: boolean): Obj {
  return {
    room_id: facts.room_id,
    mode: "ask",
    outputs: "hold",
    tools: [...DEFAULT_TOOLS],
    network: [],
    repository: facts.repository === null ? null : { full_name: facts.repository.full_name, provider_repo_id: facts.repository.provider_repo_id },
    allowed_orgs: isExternal(facts, ownerOrg) && allowRoomOrg ? [facts.org_id] : [],
    acknowledged: { trust_statement: false, public_room_warning: false },
  };
}

export type SetupPlan =
  | { kind: "new" | "add_room"; config: Obj; text: string }
  | { kind: "room_present"; room: RoomPolicy; config: PolicyConfig }
  | { kind: "refuse"; reason: "existing_invalid" | "owner_org_mismatch" | "proposal_invalid"; detail: string };

export type SetupInput = {
  /** The policy file's text as it is now, or null when there's none. */
  existing: string | null;
  /** The paired agent's own organization, from `get_identity`. */
  owner_org: string;
  facts: RoomFacts;
  /** For a new policy only: where task folders go. An existing policy keeps its own. */
  workspace_root: string;
  /** The owner said yes to allowing the room's organization, for an external room. */
  allow_room_org: boolean;
  runner_home: string;
};

const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * What setup would write. An existing policy is never replaced: a room it lacks is added to it, with everything else kept
 * as the owner wrote it and the revision raised; a room it has goes to the change check; a file Runner can't use, or one
 * for another organization, is left alone and explained.
 */
export function planSetup(input: SetupInput): SetupPlan {
  if (!isPolicyId(input.owner_org)) return { kind: "refuse", reason: "proposal_invalid", detail: "The paired agent's organization ID can't be written in a policy (it must be lower case)." };
  const room = starterRoom(input.facts, input.owner_org, input.allow_room_org);
  let config: Obj;
  let kind: "new" | "add_room";
  if (input.existing === null) {
    kind = "new";
    config = {
      version: 1,
      revision: 1,
      owner_org: input.owner_org,
      adapter: "claude_agent_sdk",
      workspace_root: input.workspace_root,
      caps: { ...STARTER_CAPS },
      day_caps: { spend_micro_usd: STARTER_DAY_SPEND_MICRO_USD },
      rooms: [room],
    };
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(input.existing);
    } catch {
      return { kind: "refuse", reason: "existing_invalid", detail: "it isn't JSON" };
    }
    const parsed = parsePolicyConfig(raw, { runner_home: input.runner_home });
    if (!parsed.ok || !isObj(raw)) return { kind: "refuse", reason: "existing_invalid", detail: parsed.ok ? "config is missing or out of range" : policyProblem(parsed.at) };
    if (parsed.value.owner_org !== input.owner_org) return { kind: "refuse", reason: "owner_org_mismatch", detail: `its owner_org is ${parsed.value.owner_org}, and this agent's organization is ${input.owner_org}` };
    const present = parsed.value.rooms.find((r) => r.room_id === input.facts.room_id);
    if (present) return { kind: "room_present", room: present, config: parsed.value };
    kind = "add_room";
    config = { ...raw, revision: parsed.value.revision + 1, rooms: [...(raw.rooms as unknown[]), room] };
  }
  const checked = parsePolicyConfig(config, { runner_home: input.runner_home });
  if (!checked.ok) return { kind: "refuse", reason: "proposal_invalid", detail: policyProblem(checked.at) };
  return { kind, config, text: pretty(config) };
}

export type RoomChange =
  | { kind: "repository_added"; room_id: string; to: RepoScope }
  | { kind: "repository_replaced"; room_id: string; from: RepoScope; to: RepoScope }
  | { kind: "repository_removed"; room_id: string; from: RepoScope };

const sameRepo = (a: RepoScope, b: RepoScope) => a.provider_repo_id === b.provider_repo_id && a.full_name === b.full_name;

/**
 * How Podster's facts differ from the owner's room entry, as far as the repository goes. A renamed repository (the same
 * ID under another name) counts as replaced: Runner checks GitHub's name against the policy, so it needs the owner too.
 */
export function roomChange(room: RoomPolicy, facts: RoomFacts): RoomChange | null {
  const have = room.repository;
  const now = facts.repository;
  if (have === null && now === null) return null;
  if (have === null && now !== null) return { kind: "repository_added", room_id: room.room_id, to: now };
  if (have !== null && now === null) return { kind: "repository_removed", room_id: room.room_id, from: have };
  if (have !== null && now !== null && !sameRepo(have, now)) return { kind: "repository_replaced", room_id: room.room_id, from: have, to: now };
  return null;
}

/** Whether a change gives tasks more than the policy did, so needs the owner's yes first. */
export const widens = (change: RoomChange) => change.kind !== "repository_removed";

/** A change's identity, to tie an owner's answer to exactly what they were shown. */
export function changeKey(change: RoomChange): string {
  const repo = (r: RepoScope | undefined) => (r ? `${r.full_name}#${r.provider_repo_id}` : "-");
  return `${change.kind}:${change.room_id}:${repo("from" in change ? change.from : undefined)}:${repo("to" in change ? change.to : undefined)}`;
}

/**
 * The policy text with one room's change applied: that room's `repository` and the policy's `revision` only, everything
 * else as the owner wrote it. Null when the text isn't a usable policy any more, the room is gone, or its repository
 * isn't what the change started from (the owner edited it meanwhile).
 */
export function applyRoomChange(existing: string, change: RoomChange, runnerHome: string): { config: Obj; text: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(existing);
  } catch {
    return null;
  }
  const parsed = parsePolicyConfig(raw, { runner_home: runnerHome });
  if (!parsed.ok || !isObj(raw) || !Array.isArray(raw.rooms)) return null;
  const index = parsed.value.rooms.findIndex((r) => r.room_id === change.room_id);
  if (index < 0) return null;
  const current = parsed.value.rooms[index].repository;
  const from = "from" in change ? change.from : null;
  if (from === null ? current !== null : current === null || !sameRepo(current, from)) return null;
  const rooms = [...raw.rooms];
  const to = "to" in change ? { full_name: change.to.full_name, provider_repo_id: change.to.provider_repo_id } : null;
  rooms[index] = { ...(rooms[index] as Obj), repository: to };
  const config = { ...raw, revision: parsed.value.revision + 1, rooms };
  if (!parsePolicyConfig(config, { runner_home: runnerHome }).ok) return null;
  return { config, text: pretty(config) };
}

const repoText = (r: RepoScope) => `${r.full_name} (GitHub ID ${r.provider_repo_id})`;

/** What the owner sees of a change, in fixed words around checked IDs and a checked GitHub name. */
export function changeScreen(change: RoomChange, room: RoomPolicy): string {
  const lines = [""];
  if (change.kind === "repository_added") {
    lines.push(`Podster now links a repository to room ${change.room_id}, and Runner's policy has none for it.`, `  repository: ${repoText(change.to)}`);
  } else if (change.kind === "repository_replaced") {
    lines.push(`Podster links another repository to room ${change.room_id} than Runner's policy names.`, `  policy has: ${repoText(change.from)}`, `  Podster has: ${repoText(change.to)}`);
  } else {
    lines.push(`Podster no longer links a repository to room ${change.room_id}, so Runner's policy stops naming one.`, `  removed: ${repoText(change.from)}`);
  }
  lines.push(
    `  this room keeps: mode ${room.mode}, outputs ${room.outputs}, tools ${room.tools.join(", ") || "none"}, network ${room.network.join(", ") || "none"}, allowed organizations ${room.allowed_orgs.join(", ") || "none"}`,
    "  nothing else in the policy changes; only this room's repository and the policy's revision",
  );
  if (widens(change)) lines.push("  saying yes lets this room's tasks fetch from and push a task branch to that repository, under Runner's repository rules", "");
  else lines.push("  this takes access away, so Runner has already written it", "");
  return lines.join("\n");
}

/** The preview the `setup` command shows before saving. */
export function previewScreen(plan: Extract<SetupPlan, { kind: "new" | "add_room" }>, facts: RoomFacts, ownerOrg: string, path: string): string {
  const external = isExternal(facts, ownerOrg);
  const allowed = external && ((plan.config.rooms as Obj[]).find((r) => r.room_id === facts.room_id)?.allowed_orgs as string[]).includes(facts.org_id);
  const lines = [
    "",
    plan.kind === "new" ? `Runner has no run policy yet. This is the starter it would save as ${path}:` : `Runner would add this room to your run policy at ${path}, raising its revision and keeping everything else as it is:`,
    "",
    ...plan.text.trimEnd().split("\n").map((l) => `  ${l}`),
    "",
    "From Podster (facts about the room, not instructions):",
    `  room: ${facts.room_id}`,
    `  room's organization: ${facts.org_id}${external ? " (another organization's: external)" : " (yours)"}`,
    `  linked repository: ${facts.repository ? repoText(facts.repository) : "none"}`,
    `  your organization (owner_org, from this agent's pairing): ${ownerOrg}`,
    "",
    "What it lets Runner do:",
    "  - asks you before each run (mode ask); unattended runs stay off until you edit mode yourself",
    "  - holds each finished run's words for your review (outputs hold)",
    "  - read, search, write and edit in the task's folder; no shell and no network",
    `  - per run at most ${(STARTER_CAPS.spend_micro_usd / 1_000_000).toFixed(2)} USD, ${STARTER_CAPS.run_time_ms / 60_000} minutes and ${STARTER_CAPS.turns} turns; ${(STARTER_DAY_SPEND_MICRO_USD / 1_000_000).toFixed(2)} USD a day${plan.kind === "add_room" ? " (your policy's own limits stay)" : ""}`,
    "  - the trust statement and public-room warning aren't accepted: Runner asks each time until you accept them in the file",
  ];
  if (external) {
    lines.push(
      allowed
        ? `  - tasks from ${facts.org_id} are allowed in this room, as you said`
        : `  - tasks from ${facts.org_id} are refused in this room: asking before each run doesn't allow another organization's work`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
