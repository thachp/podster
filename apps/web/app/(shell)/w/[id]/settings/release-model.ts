import type { GatewayResult } from "@/lib/gateway/result";
import { explainRefusal } from "../team/model";
import type { Member } from "../team/model";
import { availability, explainGrantRefusal, type Availability, type RepoGrant } from "./repository-model";

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

/**
 * Where a hostname's setup stands, in core's fixed words (2026-11-25): from the request's state and Cloudflare's last
 * read of the name. Display only. `active` means Cloudflare reads the name active, not that the app is served there.
 */
export type HostnameSetup = "proof_pending" | "provider_pending" | "active" | "ended" | "failed";

export type HostnameRequest = {
  id: string;
  hostname: string;
  state: "pending" | "claimed" | "ending" | "refused" | "expired" | "ended";
  setup_status: HostnameSetup;
  challenge_name: string;
  challenge_value: string;
  /** Where the hostname's CNAME points: the content domain's fallback origin, as the server names it. Null while the deployment has none. */
  cname_target: string | null;
  requested_by: string;
  requested_at: number;
  expires_at: number;
  end_reason: string | null;
  /** When Podster last looked at the request: its TXT record, or an ask for the claim. Null before the first look. */
  checked_at: number | null;
  /** While pending with no proof read, when the job next looks for the TXT record; otherwise null. Display only. */
  next_check_at: number | null;
};

export type AppHostname = { request: HostnameRequest | null };

/**
 * What the custom-domain read gave. Custom domains are built after release's configuration (M6 step 8): until then their
 * routes answer as routes that don't exist, or 409 `release_not_available` where release is switched on, and both read
 * as not yet available, with no field. Anything else that isn't an answer is a read failure.
 */
export type HostnameRead = AppHostname | "unavailable" | "failed";

export function hostnameAvailability(result: GatewayResult<AppHostname>): HostnameRead {
  if (result.ok) return result.data;
  if (result.status === 404 && result.code === "not_found") return "unavailable";
  if (result.status === 409 && result.code === "release_not_available") return "unavailable";
  return "failed";
}

/** An organization's release switch (decision 218), as `getReleaseDelegation` answers an operator or the organization's admin. Display only. */
export type ReleaseSwitch = { granted: boolean; generation: number; last_take: number; set_by: string | null; set_at: number | null };

/**
 * Release at workroom setup, before the room exists. The only deployment-wide read a creator can make is their
 * organization's release switch, which answers as a route that doesn't exist while release is off for the deployment:
 * - Unavailable: off for the deployment. Nothing is offered or implied.
 * - Needs approval: an operator has taken release away from the organization.
 * - Not configured: release is on for the deployment and the organization, and a new workroom starts with it off.
 * - Unknown: the read failed or wasn't the creator's to make, so the page says it can't tell rather than guessing.
 */
export type SetupRelease = "unavailable" | "needs-approval" | "not-configured" | "unknown";

/**
 * Whether the organization holds release, from a read of its switch: a boolean only when the answer had a boolean
 * `granted`. Anything else, a failed read or a body of another shape, is unknown, never a take (review standard 3).
 */
export function switchGranted(result: GatewayResult<ReleaseSwitch> | null): boolean | null {
  if (result === null || !result.ok) return null;
  const body: unknown = result.data;
  if (typeof body !== "object" || body === null) return null;
  const granted = (body as { granted?: unknown }).granted;
  return typeof granted === "boolean" ? granted : null;
}

export function setupRelease(result: GatewayResult<ReleaseSwitch> | null): SetupRelease {
  if (result === null) return "unknown";
  if (result.ok) {
    const granted = switchGranted(result);
    return granted === null ? "unknown" : granted ? "not-configured" : "needs-approval";
  }
  if (result.status === 404 && result.code === "not_found") return "unavailable";
  return "unknown";
}

export const CUSTOM_DOMAIN_UNAVAILABLE = "Custom domains aren't available on this Podster deployment yet. A released app would have only the address Podster gives it.";

/**
 * The room's deployment grants (ADR 0010, M6 step 6), as the reads give them. `deploy` is an action on the room's
 * repository grants while release is switched on for the deployment, and the grants read lists them only then:
 * - off: release isn't on in this room, so the page reads no grants and offers none.
 * - unavailable: the grants read answers as a route that doesn't exist, or the room has no linked repository.
 * - failed: the read failed.
 * - on: the room's deploy grants the read listed, and whether to offer the form. That is the API's word only: the
 *   release configuration answered this viewer, which it does only for the room's owner and admins as people, and the
 *   room read sent its policy version, which it sends only to those who manage access. Rust decides every grant again.
 */
export type DeployGrants = { kind: "off" } | { kind: "unavailable" } | { kind: "failed" } | { kind: "on"; grants: RepoGrant[]; mayGive: boolean };

export function deployGrants(view: ReleaseView, read: GatewayResult<{ grants: RepoGrant[] }> | null, { linked, policyVersion, archived }: { linked: boolean | null; policyVersion: number | null; archived: boolean }): DeployGrants {
  if (view.state !== "ready") return { kind: "off" };
  if (read === null || linked === false) return { kind: "unavailable" };
  if (!read.ok) return read.status === 404 && read.code === "not_found" ? { kind: "unavailable" } : { kind: "failed" };
  const listed = Array.isArray(read.data?.grants) ? read.data.grants : [];
  return { kind: "on", grants: listed.filter((grant) => grant.action === "deploy"), mayGive: linked === true && policyVersion !== null && !archived };
}

/** Only participant agents not there through a public claim are offered (decision 209). The API refuses anyone else. */
export const deployCandidates = (members: Member[]) => members.filter((member) => member.kind === "agent" && member.public_claim !== true);

/** Refusals of giving or taking back a deploy grant, in words. Each writes nothing. */
export function explainDeployGrantRefusal(code: string, status = 400) {
  switch (code) {
    case "invalid_argument":
      return "Podster didn't take that grant: deployment grants aren't available on this Podster deployment, or the expiry isn't after now and at most a year ahead. Nothing changed.";
    case "release_needs_public_room":
      return "Only a public workroom can release, so a deployment grant can be given only while this workroom is public. Nothing changed.";
    case "grantee_public":
      return "They joined from the public page, so they can't hold a deployment grant. Nothing changed.";
    case "not_allowed":
      return "Only this workroom's owner and admins, as people, can give a deployment grant, and never to a person from another organization. Nothing changed.";
    default:
      return explainGrantRefusal(code, status);
  }
}

/**
 * What a released app is, said before release is switched on (decision 220, stage 1 of apps as Workers). The person who
 * approves each release is to be told it again there (step 10(b)).
 */
export const WHAT_AN_APP_IS = "A released app can run its own code on Podster's servers, and can keep data in a store that anyone who opens the app can write to.";

export type Tone = "neutral" | "amber" | "blue" | "green" | "danger";

/**
 * What else the page read, which switching release on needs. Null where the read failed or the feature is off.
 * `delegated` is the organization's release switch (decision 218), which only an organization admin or an operator can
 * read: null, or absent, where it couldn't be read, and then it isn't listed, since Podster checks it when release is
 * switched on.
 */
export type Prerequisites = { isPublic: boolean | null; repositoryReady: boolean | null; delegated?: boolean | null };

export type ReleaseView =
  | { state: "unavailable"; label: "Unavailable"; tone: Tone; text: string }
  | { state: "failed" }
  | { state: "not-configured" | "needs-approval" | "ready"; label: "Not configured" | "Needs approval" | "Ready"; tone: Tone; text: string; missing: string[]; config: ReleaseConfig };

export const UNAVAILABLE = "Release isn't available on this Podster deployment, so this workroom can't publish an app. Nothing is published, and nothing here grants a deployment.";

/**
 * What still has to be in place before release can be switched on, each with who resolves it. Only what the page could
 * read: the deployment delegation isn't readable here, so Podster checks it when release is switched on.
 */
export function missingFor({ isPublic, repositoryReady, delegated = null }: Prerequisites): string[] {
  const missing: string[] = [];
  if (delegated === false) missing.push("A Podster operator has taken release away from this workroom's organization. Only an operator can give it back.");
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

/**
 * A hostname request's state, in words. A claim reads as Active only once Cloudflare reads the name active
 * (`setup_status`), and even then it isn't "live": whether the app is served there is the content side's, and isn't
 * shown here.
 */
export function describeHostname(request: HostnameRequest): { label: string; tone: Tone; text: string } {
  switch (request.state) {
    case "pending":
      return { label: "Waiting for proof", tone: "blue", text: "Publish both records below at your DNS provider. Nothing is held until Podster reads the TXT record, and the request ends if it isn't read in time." };
    case "claimed":
      return request.setup_status === "active"
        ? { label: "Active", tone: "green", text: "This workroom holds the name, and Cloudflare reports it active. The app is served here while a release is served. Keep both records published: Podster checks the TXT record every day." }
        : { label: "Waiting for DNS", tone: "blue", text: "Podster read your TXT record, and this workroom holds the name. Cloudflare turns it on once the CNAME record below points at Podster. Keep both records published: Podster checks the TXT record every day." };
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

/** **Proposed** wording (RELEASE-POLICIES.md, 2026-11-27): shown when "Check now" didn't find the TXT record yet. */
export const DNS_DELAY_NOTE = "DNS can take up to about 30 minutes to show a new record if it was added after you asked.";

/** A moment to the second, in UTC, as the server gave it. */
export const timeOf = (at: number) => `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;

/**
 * What "Check now" found, from the room's hostname as the server answered it after its look (2026-11-27). `notFound` is
 * true while the request is still waiting for proof, which is when the note on DNS delay is shown. Display only: the
 * server decided, and the page refreshes from its reads.
 */
export function describeCheck(after: HostnameRequest | null): { text: string; notFound: boolean } {
  switch (after?.state) {
    case "pending":
      return { text: "Podster didn't find your TXT record yet. It keeps checking until the request ends.", notFound: true };
    case "claimed":
      return { text: "Podster read your TXT record. This workroom holds the name.", notFound: false };
    case "refused":
      return { text: `Podster read your TXT record, but the name couldn't be claimed. ${hostnameReason(after.end_reason)}`.trim(), notFound: false };
    case undefined:
      return { text: "This workroom has no hostname request open now. Reload to see where it stands.", notFound: false };
    default:
      return { text: `The request is no longer waiting for proof. ${hostnameReason(after?.end_reason ?? null)}`.trim(), notFound: false };
  }
}

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

/**
 * Refusals of release's commands, in words. The configuration's are `podster_policy::release::ReleaseDenial`'s and
 * `podster_core::release::ReleaseConfigRefusal`'s, as `setReleaseConfig` lists them; the hostname ones are core's hostname
 * rules'. Each refusal writes nothing, so each says nothing changed.
 */
export function explainReleaseRefusal(code: string, status = 400) {
  switch (code) {
    case "release_not_available":
      return "Release isn't available on this Podster deployment yet. Nothing changed.";
    case "release_off_for_deployment":
      return "Release is switched off for this whole Podster deployment, so no workroom can switch it on. Nothing changed.";
    case "release_needs_public_room":
      return "Only a public workroom can release. Make it public under Visibility first. Nothing changed.";
    case "repo_not_ready":
      return "This workroom's repository isn't Ready, and a release is made only from a ready repository. Nothing changed.";
    case "release_not_delegated":
      return "A Podster operator has taken release away from this workroom's organization, or hasn't let it make repositories. Only an operator can change that. Nothing changed.";
    case "standing_unknown":
      return "Podster couldn't check this workroom's organization or repository just now. Nothing changed. Try again.";
    case "public_surface_suspended":
      return "A Podster operator has suspended this workroom's public page, so release can't be switched on. Nothing changed.";
    case "app_suspended":
      return "A Podster operator has suspended this workroom's app, so release can't be switched on. Nothing changed.";
    case "organization_deleted":
      return "This workroom's organization has been deleted, so release can't be switched on. Nothing changed.";
    case "workspace_deleted":
      return "This workroom has been deleted. Nothing changed.";
    case "workspace_archived":
      return "This workroom is archived, so release can't be changed. Nothing changed.";
    case "not_allowed":
    case "not_a_participant":
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
    case "hostname_not_pending":
      return "This request isn't waiting for proof any more. Reload to see where it stands. Nothing changed.";
    case "hostname_check_too_soon":
      return "Podster checked this request less than 30 seconds ago. Wait a moment and try again. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

export const releaseConflict = "Release settings changed while you were looking. Nothing was changed; reload to see them.";

export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
