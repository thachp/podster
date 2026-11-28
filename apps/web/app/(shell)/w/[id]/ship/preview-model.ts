import type { GatewayResult } from "@/lib/gateway/result";
import { repositoryUrl } from "../settings/repository-model";
import { explainReleaseRefusal, type Tone } from "../settings/release-model";

/**
 * The room's preview (M8, docs/m8-preview-plan.md sections 3, 9.1 and 10), as `getPreview` gives it. Every field is what
 * the server said, and none of it decides anything: Rust decides who may view, make, replace, delete and publish, again on
 * every command. Nothing an agent wrote is in it.
 */
export const PREVIEW_RELEASE_STATES = ["queued", "uploading", "uncertain", "live", "served", "replaced", "unpublished", "failed"] as const;
export type PreviewReleaseState = (typeof PREVIEW_RELEASE_STATES)[number];

export type PreviewRelease = {
  id: string;
  task_id: string;
  commit_sha: string;
  state: PreviewReleaseState;
  build_id: string | null;
  storage_warning: boolean | null;
  requested_by: string;
  requested_at: number;
  served_at: number | null;
  failure_code: string | null;
  finished_at: number | null;
};

export type HostnameSetup = "proof_pending" | "provider_pending" | "active" | "ended" | "failed";
export type PreviewHostnameView = { hostname: string; setup_status: HostnameSetup };

export type Preview = {
  state: "active" | "deleting";
  serving: PreviewRelease | null;
  replacement: PreviewRelease | null;
  default_host: string | null;
  custom_host: PreviewHostnameView | null;
};

/**
 * What the preview read gave:
 * - unavailable: release is off for the deployment, so the route answers as one that doesn't exist.
 * - off: release is on and previews aren't (`previews_off`).
 * - hidden: the room answered this viewer `not_allowed`: they may not view its preview.
 * - failed: no answer, or one of a shape this page doesn't know, which is never taken as "no preview" (review standard 3).
 * - read: the room's preview, or null for none.
 */
export type PreviewRead = { kind: "unavailable" } | { kind: "off" } | { kind: "hidden" } | { kind: "failed" } | { kind: "read"; preview: Preview | null };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const REL = /^rel_[0-9a-f]{32}$/;
const BLD = /^bld_[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}$/;
const SETUPS: readonly unknown[] = ["proof_pending", "provider_pending", "active", "ended", "failed"];
const nullOr = (value: unknown, check: (value: unknown) => boolean) => value === null || check(value);
const isString = (value: unknown) => typeof value === "string";
const isNumber = (value: unknown) => typeof value === "number";

function isPreviewRelease(value: unknown): value is PreviewRelease {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    REL.test(value.id) &&
    typeof value.task_id === "string" &&
    typeof value.commit_sha === "string" &&
    SHA.test(value.commit_sha) &&
    (PREVIEW_RELEASE_STATES as readonly unknown[]).includes(value.state) &&
    nullOr(value.build_id, (build) => typeof build === "string" && BLD.test(build)) &&
    nullOr(value.storage_warning, (flag) => typeof flag === "boolean") &&
    typeof value.requested_by === "string" &&
    typeof value.requested_at === "number" &&
    nullOr(value.served_at, isNumber) &&
    nullOr(value.failure_code, isString) &&
    nullOr(value.finished_at, isNumber)
  );
}

const isHostnameView = (value: unknown): value is PreviewHostnameView => isObject(value) && typeof value.hostname === "string" && SETUPS.includes(value.setup_status);

export function parsePreview(body: unknown): PreviewRead {
  if (!isObject(body) || !("preview" in body)) return { kind: "failed" };
  const preview = body.preview;
  if (preview === null) return { kind: "read", preview: null };
  if (!isObject(preview)) return { kind: "failed" };
  const fine =
    (preview.state === "active" || preview.state === "deleting") &&
    nullOr(preview.serving, isPreviewRelease) &&
    nullOr(preview.replacement, isPreviewRelease) &&
    nullOr(preview.default_host, isString) &&
    nullOr(preview.custom_host, isHostnameView);
  return fine ? { kind: "read", preview: preview as Preview } : { kind: "failed" };
}

export function previewRead(result: GatewayResult<unknown>): PreviewRead {
  if (result.ok) return parsePreview(result.data);
  if (result.status === 404 && result.code === "not_found") return { kind: "unavailable" };
  if (result.status === 409 && result.code === "previews_off") return { kind: "off" };
  if (result.status === 403 && result.code === "not_allowed") return { kind: "hidden" };
  return { kind: "failed" };
}

/** Reason codes a preview release fails with, in words. Never a provider's text. A code not listed is shown as itself. */
const FAILURES: Record<string, string> = {
  release_marker_missing: "the new build didn't answer on the preview host in time",
  build_mismatch: "the files Podster fetched didn't match the build it recorded",
  commit_not_releasable: "that commit is no longer one Podster's merge confirmed for the task",
  release_directory_missing: "the repository has no app folder at that commit",
  release_too_large: "the app is larger than Podster serves",
  release_too_many_files: "the app has more files than Podster serves",
  release_file_too_large: "one of the app's files is larger than Podster serves",
  release_upload_attempts: "Podster couldn't upload it in the attempts it had",
  release_attempts_exhausted: "Podster couldn't upload it in the attempts it had",
  release_off: "release was switched off in this workroom",
  previews_off: "previews were switched off on this Podster deployment",
  repo_not_ready: "the workroom's repository wasn't ready",
  requester_lost_authority: "the person who asked no longer may",
  reviewer_rule_changed: "the workroom's review rule changed",
  app_suspended: "a Podster operator suspended this workroom's app",
};

const CODE = /^[a-z0-9_]{1,64}$/;
export const failureWords = (code: string | null) => (code === null ? "Podster didn't say why" : (FAILURES[code] ?? (CODE.test(code) ? `reason code ${code}` : "Podster didn't say why")));

export const IN_FLIGHT: readonly PreviewReleaseState[] = ["queued", "uploading", "uncertain", "live"];

export type PreviewState = "none" | "building" | "first-failed" | "ready" | "replacing" | "replacement-failed" | "deleting";

/**
 * The preview card's state chip (the plan's section 10): None, Building, Ready, Replacement failed, Deleting, and between
 * them Replacing while a replacement is in flight and Failed when the first preview never served. Amber, the shell's "needs
 * you", only for a failure, which someone has to look at. Only what the read says: a replacement is in flight by its state.
 */
export function previewState(preview: Preview | null): { state: PreviewState; label: string; tone: Tone } {
  if (preview === null) return { state: "none", label: "None", tone: "neutral" };
  if (preview.state === "deleting") return { state: "deleting", label: "Deleting", tone: "neutral" };
  const next = preview.replacement;
  const inFlight = next !== null && IN_FLIGHT.includes(next.state);
  const failed = next !== null && next.state === "failed";
  if (preview.serving === null) {
    if (inFlight) return { state: "building", label: "Building", tone: "blue" };
    if (failed) return { state: "first-failed", label: "Failed", tone: "amber" };
    return { state: "none", label: "None", tone: "neutral" };
  }
  if (inFlight) return { state: "replacing", label: "Replacing", tone: "blue" };
  if (failed) return { state: "replacement-failed", label: "Replacement failed", tone: "amber" };
  return { state: "ready", label: "Ready", tone: "green" };
}

/** `bld_` and the first 8 hexadecimal characters, as the card shows it; the full ID is on hover and copied whole. */
export const shortBuild = (build: string) => build.slice(0, 12);
export const shortCommit = (sha: string) => sha.slice(0, 7);

/** A host the server named, as a link only if it is a plain lower-case DNS name. Anything else is shown as no link. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const hostLink = (host: string | null) => (host !== null && HOST.test(host) ? `https://${host}/` : null);

/** A commit in the room's repository, only from a repository name in GitHub's own character set and a full commit ID. */
export function commitUrl(fullName: string | null, sha: string): string | null {
  if (fullName === null || !SHA.test(sha)) return null;
  const repo = repositoryUrl(fullName);
  return repo ? `${repo}/commit/${sha}` : null;
}

/** The plan's section 10 and 5.2.1, said under the preview's link. */
export const PREVIEWS_ARENT_PRODUCTION = "A preview can use browser storage and its own address. Production apps can't: they run with no cookies or browser storage.";
/** `podster_core::preview_build::STORAGE_WARNING_NOTICE`, said on the card where the build has the warning. */
export const STORAGE_WARNING = "This build may use browser storage, which production apps don't have.";
export const STORAGE_WARNING_CAVEAT = "Podster only searched the build's text for the names of browser storage, so this can be wrong either way. It never blocks anything.";
/** `podster_core::preview_build::PREVIEW_DIFFERENCES_NOTICE`, the approval dialog's words where the server sent none. */
export const PREVIEW_DIFFERENCES = "This build ran in the preview with browser storage and its own origin. In production it runs sandboxed, with neither, so anything that worked only because of them will break.";
export const OPENING_NEEDS_ACCESS = "Opening this address needs access to this room.";
export const PREVIEW_UNAVAILABLE = "Previews aren't available on this Podster deployment, so this workroom has none.";
export const PREVIEWS_OFF = "Previews are switched off on this Podster deployment, so this workroom has none. Production isn't affected.";
export const PREVIEW_HIDDEN = "This workroom's preview is shown only to people with a role in it.";
/** Where step 10's controls go, until its routes are built. The name and status shown come from `getPreview` alone. */
export const PREVIEW_HOSTNAME_PENDING = "Connecting a custom preview hostname isn't available on this Podster deployment yet.";
export const PRIVATE_CANT_PUBLISH = "Only a public workroom can publish. This workroom is private, so its preview can't go live. Its owner can make it public under Settings.";

export const HOSTNAME_SETUP_WORDS: Record<HostnameSetup, string> = {
  proof_pending: "Waiting for proof",
  provider_pending: "Waiting for DNS",
  active: "Active",
  ended: "Ended",
  failed: "Failed",
};

/**
 * Refusals of `requestPreview` and `deletePreview`, in words, in the route's own order. Each writes nothing, so each says
 * nothing changed. Anything not listed is release's.
 */
export function explainPreviewRefusal(code: string, status = 400): string {
  switch (code) {
    case "not_allowed":
    case "not_a_participant":
      return "Only this workroom's owner and admins, as people, can make, replace or delete its preview. Nothing changed.";
    case "previews_off":
      return "Previews are switched off on this Podster deployment. Nothing changed.";
    case "release_off":
      return "Release is off in this workroom, and a preview is made through release. The owner or an admin switches it on under Settings. Nothing changed.";
    case "preview_in_flight":
      return "A preview of another commit is still being made. Wait for it to finish or fail, then try again. Nothing changed.";
    case "preview_limit":
      return "This workroom has used its 20 asks for a day, which previews and releases share. Try again later. Nothing changed.";
    case "commit_not_releasable":
      return "That commit isn't one Podster's merge confirmed for a finished task, so it can't be previewed. Nothing changed.";
    case "reviewer_rule_changed":
      return "This workroom's review rule changed since the task was approved, so its commit can't be previewed. Nothing changed.";
    case "task_not_found":
      return "That task isn't there, or you can't see it. Nothing changed.";
    case "invalid_argument":
      return "Podster didn't take that request. Reload and try again. Nothing changed.";
    default:
      return explainReleaseRefusal(code, status);
  }
}

/** Refusals of `requestRelease` with `from_preview`, in words. Each writes nothing. */
export function explainPublishRefusal(code: string, status = 400): string {
  switch (code) {
    case "release_needs_public_room":
      return "Only a public workroom can publish, so this preview's build can't go live from here. Nothing was asked for.";
    case "grant_required":
    case "grant_stale":
      return "Asking for a release needs a live deployment grant on this workroom's repository, from someone who may still give one. Nothing was asked for.";
    case "public_participant":
      return "You joined this workroom from its public page, so you can't ask for a release. Nothing was asked for.";
    case "preview_release_not_found":
      return "Podster has no preview release by that ID in this workroom. Reload to see the preview. Nothing was asked for.";
    case "preview_not_served":
      return "That build never reached the preview, so it can't be published. Nothing was asked for.";
    case "preview_build_missing":
      return "Podster didn't record a build for that preview, so there's nothing exact to publish. Nothing was asked for.";
    case "preview_task_mismatch":
    case "preview_commit_mismatch":
      return "That preview's task or commit isn't the one asked for. Reload and try again. Nothing was asked for.";
    case "release_pending":
      return "A release of this commit is already waiting for approval or going out. Nothing new was asked for.";
    case "release_limit":
      return "This workroom has used its 20 asks for a day. Try again later. Nothing was asked for.";
    case "no_releaser":
      return "Nobody who may release is left in this workroom, so no release can be asked for. Nothing was asked for.";
    case "not_allowed":
    case "not_a_participant":
      return "You can't ask for a release in this workroom. Nothing was asked for.";
    default:
      return explainPreviewRefusal(code, status).replace(/Nothing changed\.$/, "Nothing was asked for.");
  }
}

/** What a merged task gives a preview request: its commit, only once Podster's merge succeeded with one. */
export function mergedCommit(body: unknown): string | null {
  if (!isObject(body) || !isObject(body.change)) return null;
  const { merge_state, merge_sha } = body.change;
  return merge_state === "succeeded" && typeof merge_sha === "string" && SHA.test(merge_sha) ? merge_sha : null;
}
