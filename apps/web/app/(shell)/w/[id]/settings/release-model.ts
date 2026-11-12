import type { GatewayResult } from "@/lib/gateway/result";
import { explainRefusal } from "../team/model";
import { availability, type Availability } from "./repository-model";

/**
 * M6 release (ADR 0010), as the room's reads give it. Every field is what the server said, and none of it decides
 * anything: Rust checks who may configure, the room's visibility, its repository and the deployment delegation again on
 * every command. While release is switched off for the deployment, its routes answer as routes that don't exist, which
 * `availability` reads as off.
 */
export type ReleaseConfig = {
  enabled: boolean;
  approval_policy: "person";
  environments: "production"[];
  /** The app's host on the content domain, as the server names it. The content domain itself is the server's configuration, never this page's. */
  default_host: string | null;
  custom_host: string | null;
  version: number;
  set_by: string | null;
  updated_at: number | null;
};

/**
 * What the configuration read says about release. Off for the deployment, its routes answer as routes that don't exist;
 * switched on where its step isn't built, which only a test build can be, they answer 409 `release_not_available`. Both
 * are Unavailable. Anything else that isn't an answer is a read failure.
 */
export function releaseAvailability(result: GatewayResult<ReleaseConfig>): Availability<ReleaseConfig> {
  if (!result.ok && result.status === 409 && result.code === "release_not_available") return { kind: "off" };
  return availability(result);
}

export type HostnameRequest = {
  id: string;
  hostname: string;
  state: "pending" | "claimed" | "ending" | "refused" | "expired" | "ended";
  challenge_name: string;
  challenge_value: string;
  requested_by: string;
  requested_at: number;
  expires_at: number;
  end_reason: string | null;
};

export type AppHostname = { request: HostnameRequest | null };

export type Tone = "neutral" | "amber" | "blue" | "green" | "danger";

/** What else the page read, which switching release on needs. Null where the read failed or the feature is off. */
export type Prerequisites = { isPublic: boolean | null; repositoryReady: boolean | null };

export type ReleaseView =
  | { state: "unavailable"; label: "Unavailable"; tone: Tone; text: string }
  | { state: "failed" }
  | { state: "not-configured" | "needs-approval" | "ready"; label: "Not configured" | "Needs approval" | "Ready"; tone: Tone; text: string; missing: string[]; config: ReleaseConfig };

export const UNAVAILABLE = "Release isn't available on this Podster deployment, so this workroom can't publish an app. Nothing is published, and nothing here grants a deployment.";

/**
 * What still has to be in place before release can be switched on, each with who resolves it. Only what the page could
 * read: the deployment delegation isn't readable here, so Podster checks it when release is switched on.
 */
export function missingFor({ isPublic, repositoryReady }: Prerequisites): string[] {
  const missing: string[] = [];
  if (isPublic === false) missing.push("The workroom has to be public. Its owner makes it public under Visibility.");
  if (isPublic === null) missing.push("We couldn't read whether the workroom is public, and only a public workroom can release.");
  if (repositoryReady === false) missing.push("Its repository has to be Ready. The owner or an admin sets it up under Repository.");
  if (repositoryReady === null) missing.push("Its repository isn't available, and a release is made only from a ready repository's merged code.");
  return missing;
}

/**
 * The section's state, from the configuration read and what release needs:
 * - Unavailable: the deployment answers release's routes as routes that don't exist.
 * - Not configured: release is off for the room, and nothing the page read stands in the way of switching it on.
 * - Needs approval: release is off, and something someone else has to approve or set up comes first.
 * - Ready: release is on. That publishes nothing by itself: each release still needs a person's approval.
 * Never assumes success: a read that failed is a failure, not off.
 */
export function releaseView(read: Availability<ReleaseConfig>, prerequisites: Prerequisites): ReleaseView {
  if (read.kind === "off") return { state: "unavailable", label: "Unavailable", tone: "neutral", text: UNAVAILABLE };
  if (read.kind === "failed") return { state: "failed" };
  const config = read.data;
  if (config.enabled)
    return {
      state: "ready",
      label: "Ready",
      tone: "green",
      text: "Release is on. Switching it on published nothing: a release is made only from merged code when someone asks for one, and the owner or an admin approves each one before anything is uploaded.",
      missing: [],
      config,
    };
  const missing = missingFor(prerequisites);
  if (missing.length > 0) return { state: "needs-approval", label: "Needs approval", tone: "amber", text: "Release is off, and publishes nothing. It can be switched on once the following are in place.", missing, config };
  return { state: "not-configured", label: "Not configured", tone: "neutral", text: "Release is off, and publishes nothing.", missing, config };
}

/** A hostname request's state, in words. `claimed` isn't "live": whether the app is served there is the content side's, and isn't shown here. */
export function describeHostname(request: HostnameRequest): { label: string; tone: Tone; text: string } {
  switch (request.state) {
    case "pending":
      return { label: "Waiting for proof", tone: "blue", text: "Publish the TXT record below at your DNS provider. Nothing is held until Podster reads it, and the request ends if it isn't read in time." };
    case "claimed":
      return { label: "Claimed", tone: "green", text: "Podster read your record, and this workroom holds the name. Podster checks the record again every day; keep it published." };
    case "ending":
      return { label: "Being removed", tone: "amber", text: "This workroom has stopped using the name, and Podster is removing it. It still counts as this workroom's one name until that's done." };
    case "refused":
      return { label: "Refused", tone: "danger", text: `The name couldn't be claimed. ${hostnameReason(request.end_reason)}` };
    case "expired":
      return { label: "Expired", tone: "neutral", text: "The record wasn't read in time, so the request ended. Ask again for a new record." };
    default:
      return { label: "Ended", tone: "neutral", text: `This workroom no longer holds the name. ${hostnameReason(request.end_reason)}` };
  }
}

/**
 * Reason codes a hostname request ends with, from `crates/core`'s hostname rules (`HostnameRefusal`, `ClaimDecision`,
 * `ClaimEnd`), in words. Never a provider's text. A code not listed is shown as itself.
 */
const HOSTNAME_REASONS: Record<string, string> = {
  hostname_claimed: "Another workroom holds this name.",
  hostname_suspended: "A Podster operator suspended this name.",
  hostname_unproven: "Podster couldn't read your record from DNS.",
  hostname_challenge_stale: "The record was for an earlier request. Ask again for a new one.",
  hostname_request_expired: "The record wasn't read in time.",
  hostname_claim_ending: "The name was still being removed from an earlier claim.",
  hostname_challenge_removed: "Your record was removed from DNS.",
  hostname_proof_lapsed: "Podster couldn't read your record for too long.",
  hostname_moved: "The name was moved away from Podster.",
  hostname_unmapped: "The owner or an admin removed it.",
  hostname_unpublished: "This workroom's app was unpublished.",
};

export const hostnameReason = (code: string | null) => (code ? (HOSTNAME_REASONS[code] ?? `Reason code: ${code}.`) : "");

/** Requests that still count as the room's one hostname. A new name can be asked for only once none does. */
export const holdsName = (request: HostnameRequest | null) => request !== null && ["pending", "claimed", "ending"].includes(request.state);

/**
 * A first look at a hostname before it's sent, so a typo is caught here. The API normalizes the name and decides: it also
 * refuses Podster's own domains, the content domain, public suffixes and suspended names, which this page doesn't know.
 */
export function hostnameProblem(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (name === "") return "Enter a hostname.";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(name) || name.includes("/")) return "Enter the hostname only, such as app.example.com, without https:// or a path.";
  if (name.length > 253) return "Use at most 253 characters.";
  if (name.startsWith("*")) return "Wildcard names can't be used. Enter one hostname.";
  if (/^[0-9.]+$/.test(name) || name.includes(":")) return "Enter a hostname, not an IP address.";
  if (!name.includes(".")) return "Enter a full hostname, such as app.example.com.";
  const labels = name.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return "Each part between dots has to be 1 to 63 characters.";
  // International names are sent as typed; the API turns them into their ASCII form.
  if (labels.some((label) => !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label))) return "Use letters, digits and hyphens, with a dot between each part.";
  return null;
}

export function explainReleaseRefusal(code: string, status = 400) {
  switch (code) {
    case "release_not_available":
      return "Release isn't available on this Podster deployment yet. Nothing changed.";
    case "release_needs_public_room":
      return "Only a public workroom can release. Make it public under Visibility first. Nothing changed.";
    case "repo_not_ready":
      return "This workroom's repository isn't Ready, and a release is made only from a ready repository. Nothing changed.";
    case "not_delegated":
      return "A Podster operator hasn't given this workroom's organization the ability to release, or has taken it away. Only an operator can change that. Nothing changed.";
    case "delegation_unavailable":
      return "Podster couldn't check this workroom's organization's ability to release just now. Nothing changed. Try again.";
    case "workspace_archived":
      return "This workroom is archived, so release can't be changed. Nothing changed.";
    case "not_allowed":
      return "Only this workroom's owner and admins can change release, as people. Nothing changed.";
    case "not_found":
      return "Release isn't available on this Podster deployment. Nothing changed.";
    case "hostname_invalid":
    case "invalid_argument":
      return "That isn't a hostname Podster can use. Check it and try again. Nothing changed.";
    case "hostname_wildcard":
      return "Wildcard names can't be used. Enter one hostname. Nothing changed.";
    case "hostname_ip_address":
      return "Enter a hostname, not an IP address. Nothing changed.";
    case "hostname_single_label":
      return "Enter a full hostname, such as app.example.com. Nothing changed.";
    case "hostname_reserved":
      return "That name is under one of Podster's own domains, so it can't be used. Nothing changed.";
    case "hostname_public_suffix":
      return "That name is a public suffix, which nobody can claim. Nothing changed.";
    case "hostname_suspended":
      return "A Podster operator has suspended that name, so no workroom can claim it. Nothing changed.";
    case "hostname_limit":
      return "This workroom already has its one custom hostname. Remove it first. Nothing changed.";
    case "hostname_unavailable":
      return "Podster can't use that name. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

export const releaseConflict = "Release settings changed while you were looking. Nothing was changed; reload to see them.";

export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
