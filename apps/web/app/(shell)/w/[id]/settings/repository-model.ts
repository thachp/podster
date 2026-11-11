import type { GatewayResult } from "@/lib/gateway/result";
import { explainRefusal } from "../team/model";

/** M5 managed repositories (ADR 0009). Every field here is what the room's read said; none of it decides anything. */
export type RepoRequest = { id: string; state: "pending" | "ready" | "failed" | "uncertain"; name: string; visibility: "public" | "private"; reason: string | null; requested_by: string; requested_at: number; updated_at: number; attempts_left: number };
export type RepoLink = { id: string; provider: "github"; provider_repo_id: number; full_name: string; visibility: "public" | "private"; default_branch: string; status: "ready" | "degraded" | "suspended"; status_reason: string | null; created_at: number; verified_at: number | null; updated_at: number };
/** `delegated` is present only for the room's owner, and only when the API could read it. Display only: the request command decides. */
export type RoomRepository = { request: RepoRequest | null; repository: RepoLink | null; delegated?: boolean };

/** Display only. The API checks every grant again, from current authority, at each use; `state` can lag. */
export type RepoGrant = { id: string; principal_id: string; action: "push" | "merge"; delegated_by: string; created_at: number; expires_at: number | null; revoked_at: number | null; state: "live" | "expired" | "stale" | "revoked" };

/**
 * What a repository read says about the feature. Managed repositories are behind a server-side switch, and while it's off
 * every repository route answers as a route that doesn't exist. That answer is the only signal: nothing on the client
 * decides it. Anything else that isn't an answer is a read failure, not "off".
 */
export type Availability<T> = { kind: "off" } | { kind: "on"; data: T } | { kind: "failed" };

export function availability<T>(result: GatewayResult<T>): Availability<T> {
  if (result.ok) return { kind: "on", data: result.data };
  if (result.status === 404 && result.code === "not_found") return { kind: "off" };
  return { kind: "failed" };
}

/** The API's own rule for a name (`crates/core`): lower-case letters, digits and hyphens, starting with a letter or digit, at most 64. */
export const REPO_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function nameProblem(name: string): string | null {
  if (name === "") return "Enter a name.";
  if (name.length > 64) return "Use at most 64 characters.";
  if (!REPO_NAME.test(name)) return "Use lower-case letters, digits and hyphens, starting with a letter or a digit.";
  return null;
}

/** The one link built from provider data: only `owner/name` in GitHub's own character set, else none. */
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function repositoryUrl(fullName: string): string | null {
  if (!FULL_NAME.test(fullName) || fullName.endsWith("/.") || fullName.endsWith("/..")) return null;
  return `https://github.com/${fullName}`;
}

/** The confirmation, before anything is created. The architect rules on these words. */
export const PUBLIC_WARNING = [
  "The repository will be public on GitHub: anyone can read it.",
  "Anything an agent pushes to a task branch is public as soon as it's pushed, before anyone reviews it.",
  "Podster never deletes it. It stays on GitHub after this workroom is archived.",
];

/** Why setup ended, from the request's reason code. Never the provider's own text. */
const REASONS: Record<string, string> = {
  managed_repositories_off: "Podster had switched repositories off when setup ran.",
  provisioning_not_configured: "Podster's GitHub setup wasn't complete when this ran.",
  token_refused: "GitHub refused Podster's access when setup started.",
  not_delegated: "This workroom's organization didn't hold the delegation a Podster operator gives.",
  delegation_unavailable: "Podster couldn't confirm this workroom's organization holds the delegation.",
  room_archived: "The workroom was archived before setup ran.",
  requester_not_owner: "The person who asked was no longer this workroom's owner when setup ran.",
  name_taken: "A repository with that name already exists in Podster's GitHub organization.",
  provider_refused: "GitHub refused to create the repository.",
  wrong_owner: "GitHub created it somewhere other than Podster's organization, so it wasn't linked.",
  creation_outcome_unknown: "GitHub's answer to the creation call was lost.",
  read_back_failed: "Podster couldn't read the repository's settings back from GitHub.",
  setup_call_failed: "A setup call to GitHub failed.",
  wrong_repository: "GitHub described a different repository than the one Podster created.",
  visibility_differs: "The repository's visibility isn't what was asked for.",
  archived: "The repository is archived on GitHub.",
  no_initial_commit: "The repository has no first commit.",
  actions_enabled: "GitHub Actions are on for the repository, and Podster needs them off.",
  actions_unreadable: "Podster couldn't read the repository's Actions setting.",
  ruleset_missing: "A protection rule Podster needs is missing.",
  ruleset_inactive: "A protection rule Podster needs isn't active.",
  ruleset_differs: "A protection rule isn't set the way Podster needs.",
  bypass_differs: "Someone can bypass a protection rule who shouldn't.",
  unexpected_ruleset: "The repository has a rule Podster didn't set.",
  retry_limit_reached: "Setup has run as many times as a workroom is allowed.",
  authority_lost: "The authority to set it up ended before setup finished.",
  internal_error: "Something went wrong in Podster.",
};

export const reasonSentence = (code: string | null) => (code && REASONS[code]) ?? (code ? `Setup stopped (${code}).` : "Setup stopped.");

/** The room's repository state in plain words: a short label for the badge, and what it means. */
export function describe(state: RoomRepository): { label: string; tone: "neutral" | "amber" | "blue" | "green" | "danger"; text: string } {
  const { request, repository } = state;
  if (repository) {
    if (repository.status === "ready") return { label: "Ready", tone: "green", text: "Agents with a push grant can work on tasks in this repository." };
    if (repository.status === "degraded")
      return { label: "Degraded", tone: "amber", text: "Podster found the repository's rules or settings differ from what it needs, so coding tasks are blocked until that's fixed." };
    return { label: "Suspended", tone: "danger", text: "Podster has suspended this repository, so coding tasks are blocked. Nothing in it was deleted." };
  }
  if (!request) return { label: "None", tone: "neutral", text: "This workroom has no repository." };
  if (request.state === "pending") return { label: "Setting up", tone: "blue", text: "Podster is creating the repository and setting its rules. This page shows the result when you reload it." };
  if (request.state === "uncertain")
    return {
      label: "Outcome unknown",
      tone: "amber",
      text: "GitHub's answer was lost, so a repository may or may not have been created. Podster won't adopt one by its name. A Podster operator can check, and a retry uses a new name. Coding tasks are blocked meanwhile.",
    };
  if (request.state === "failed") return { label: "Setup failed", tone: "danger", text: `${reasonSentence(request.reason)} Coding tasks are blocked until setup succeeds.` };
  return { label: "Ready", tone: "green", text: "The repository is set up." };
}

/** Whether a retry can be asked for at all, from what the read says. The API decides, and may still say it's too soon. */
export const retryOffered = (state: RoomRepository) => !state.repository && (state.request?.state === "failed" || state.request?.state === "uncertain") && (state.request?.attempts_left ?? 0) > 0;

export function explainRepositoryRefusal(code: string, status = 400) {
  switch (code) {
    case "name_reserved":
      return "That name is reserved, because it would read as Podster's own. Choose another. Nothing was created.";
    case "not_delegated":
      return "This workroom's organization doesn't hold the delegation for managed repositories, which a Podster operator gives. Nothing was created.";
    case "private_unavailable":
      return "Private repositories aren't available yet. Nothing was created.";
    case "repo_request_exists":
      return "This workroom already has a repository request. Reload to see it.";
    case "retry_limit_reached":
      return "Setup has run as many times as a workroom is allowed. A Podster operator can reset it. Nothing changed.";
    case "retry_too_soon":
      return "It's too soon to retry. Setup waits a minute after a run, doubling up to an hour. Nothing changed.";
    case "repo_request_not_found":
      return "This workroom has no repository request to retry. Reload to see where it stands.";
    case "setup_in_progress":
      return "Setup is already running. Reload in a minute to see the result.";
    case "already_ready":
      return "The repository is already set up. Reload to see it.";
    case "not_allowed":
      return "Only this workroom's owner can do this. Nothing changed.";
    case "not_found":
      return "Repositories aren't available right now. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

export function explainGrantRefusal(code: string, status = 400) {
  switch (code) {
    case "no_provider_delegation":
      return "Only this workroom's owner can grant repository access: admins can't. Nothing changed.";
    case "grantee_not_participant":
      return "They're no longer in this workroom, so they can't hold repository access. Nothing changed.";
    case "grantee_public":
      return "They joined from the public page, so they can't hold repository access. Nothing changed.";
    case "repo_not_linked":
      return "This workroom has no linked repository yet. Nothing changed.";
    case "grant_not_found":
      return "That grant is gone, or you can't take it back. Reload to see the current grants.";
    case "invalid_argument":
      return "Check the expiry: it must be after now and at most a year ahead. Nothing changed.";
    case "not_allowed":
      return "You can't do this. Nothing changed.";
    case "not_found":
      return "Repositories aren't available right now. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

export const ACTION_LABELS: Record<RepoGrant["action"], string> = { push: "Push", merge: "Merge" };

/** Display only, labelled as such where it's shown. */
export const GRANT_STATE_LABELS: Record<RepoGrant["state"], string> = { live: "Live", expired: "Expired", stale: "Its giver no longer holds the delegation", revoked: "Taken back" };

/** A year ahead, as the API counts it, from a day picked in the browser: the end of that day in UTC. */
export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function expiryFromDay(day: string, now: number): { at: number | null; problem: string | null } {
  if (day === "") return { at: null, problem: null };
  const at = Date.parse(`${day}T23:59:59.000Z`);
  if (Number.isNaN(at)) return { at: null, problem: "Enter a date." };
  if (at <= now) return { at: null, problem: "Choose a day after today." };
  if (at > now + YEAR_MS) return { at: null, problem: "Choose a day at most a year from now." };
  return { at, problem: null };
}

export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
