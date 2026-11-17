import type { GatewayResult } from "@/lib/gateway/result";
import type { PullRequestChange } from "./task-change";

/**
 * The deployment stage of a task's Release panel (M6 step 10(b); DESIGN.md "Release stages"; UI-02), from
 * `getTaskReleaseStatus`'s `release`. Nothing here decides anything: the room says what was released and whether it is
 * served, and this only says it. **Live is `served` alone**: no state, however named, makes a stage Live, and a link
 * shows only while the server gave an https address for a release of this task's merged commit.
 */

/** The status's states, `podster_core::release_status::ReleaseStatusState`'s, as the contract lists them. Never `live`. */
export const RELEASE_STATUS_STATES = ["awaiting_approval", "queued", "uploading", "uncertain", "awaiting_confirmation", "served", "replaced", "unpublished", "declined", "failed"] as const;
export type ReleaseStatusState = (typeof RELEASE_STATUS_STATES)[number];

export type TaskRelease = {
  exists: true;
  release_id: string;
  commit_sha: string;
  state: ReleaseStatusState;
  observed_at: number;
  failure_code: string | null;
  served: boolean;
  result_url: string | null;
};

/**
 * What the release read gave: `hidden` for whoever is shown the merge alone (`release: null`), `none` for
 * `{ exists: false }` (release off for the room, or nothing asked for this commit), `failed` for a read that didn't
 * answer, and `malformed` for an answer of any other shape, which is never taken as none (review standard 3).
 */
export type ReleaseRead = { kind: "hidden" } | { kind: "none" } | { kind: "release"; release: TaskRelease } | { kind: "malformed" } | { kind: "failed" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SHA = /^[0-9a-f]{40}$/;

export function parseTaskRelease(body: unknown): ReleaseRead {
  if (!isObject(body) || !("release" in body)) return { kind: "malformed" };
  const release = body.release;
  if (release === null) return { kind: "hidden" };
  if (!isObject(release)) return { kind: "malformed" };
  if (release.exists === false && Object.keys(release).length === 1) return { kind: "none" };
  const fine =
    release.exists === true &&
    typeof release.release_id === "string" &&
    typeof release.commit_sha === "string" &&
    SHA.test(release.commit_sha) &&
    (RELEASE_STATUS_STATES as readonly unknown[]).includes(release.state) &&
    typeof release.observed_at === "number" &&
    (release.failure_code === null || typeof release.failure_code === "string") &&
    typeof release.served === "boolean" &&
    (release.result_url === null || typeof release.result_url === "string");
  return fine ? { kind: "release", release: release as TaskRelease } : { kind: "malformed" };
}

/**
 * Whether release is switched on for the deployment, from a read of the room's release configuration. Off, its route
 * answers exactly as a route that doesn't exist, `404 not_found`. On, the route answers: the configuration to the
 * room's owner and admins, `403 not_allowed` to anyone else in the room. Anything else can't tell, so it is null.
 */
export function releaseSwitchedOn(result: GatewayResult<unknown>): boolean | null {
  if (result.ok) return true;
  if (result.status === 404 && result.code === "not_found") return false;
  if (result.status === 403 && result.code === "not_allowed") return true;
  return null;
}

export type Tone = "neutral" | "amber" | "blue" | "green" | "danger";

export type DeploymentStage = {
  label: "Unavailable" | "Off" | "Waiting for merge" | "Waiting for approval" | "Deploying" | "Live" | "Deployment failed" | "Declined" | "Replaced" | "Unpublished" | "Not live" | "Not shown to you" | "Couldn't check";
  tone: Tone;
  text: string;
  /** The app's address, only while served and for this task's merged commit. */
  link: string | null;
  commit: string | null;
  observedAt: number | null;
};

export const RELEASE_UNAVAILABLE = "Release isn't available on this Podster deployment, so nothing from this task is published.";

const reason = (code: string | null) => (code && /^[a-z0-9_]{1,64}$/.test(code) ? ` Reason code: ${code}.` : "");

/** The server's address, only if it is https. Anything else is shown as no link. */
const httpsOnly = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

export type StageInput = {
  /** From [`releaseSwitchedOn`]; null when it couldn't be told. */
  switchedOn: boolean | null;
  /** The release read, or null where it wasn't made. */
  read: ReleaseRead | null;
  merge_state: PullRequestChange["merge_state"];
  merge_sha: string | null;
};

export function deploymentStage({ switchedOn, read, merge_state, merge_sha }: StageInput): DeploymentStage {
  const none = { link: null, commit: null, observedAt: null };
  if (switchedOn === false) return { label: "Unavailable", tone: "neutral", text: RELEASE_UNAVAILABLE, ...none };
  if (merge_state !== "succeeded") return { label: "Waiting for merge", tone: "neutral", text: "A release is made only from merged code, and merging releases nothing by itself.", ...none };
  if (switchedOn === null || read === null || read.kind === "failed" || read.kind === "malformed") return { label: "Couldn't check", tone: "amber", text: "Podster couldn't read this task's release just now. Reload to try again.", ...none };
  if (read.kind === "hidden") return { label: "Not shown to you", tone: "neutral", text: "Your access to this task shows its merge, not its release.", ...none };
  if (read.kind === "none") return { label: "Off", tone: "neutral", text: "Nothing has been released from this task's merged commit. Merging releases nothing.", ...none };
  const { release } = read;
  const at = { commit: release.commit_sha, observedAt: release.observed_at };
  if (release.served) {
    // A served release that isn't of this task's merged commit, or with no merged commit to compare, is a read that
    // doesn't agree with itself: couldn't check, never Live (review standard 3).
    if (merge_sha === null || release.commit_sha !== merge_sha) return { label: "Couldn't check", tone: "amber", text: "Podster's answer about this task's release didn't match its merged commit. Reload to try again.", ...none };
    // Live only here, and a link only to an https address the server gave.
    const link = httpsOnly(release.result_url);
    const text = release.state === "failed" ? `The latest attempt failed, and the earlier release of this commit is still served.${reason(release.failure_code)}` : "Podster confirmed this commit is what the app serves.";
    return { label: "Live", tone: "green", text, link, ...at };
  }
  switch (release.state) {
    case "awaiting_approval":
      return { label: "Waiting for approval", tone: "blue", text: "The workroom's owner or an admin has to approve this release before anything is uploaded.", link: null, ...at };
    case "queued":
    case "uploading":
    case "uncertain":
      return { label: "Deploying", tone: "blue", text: "Podster is uploading this release. It isn't served yet.", link: null, ...at };
    case "awaiting_confirmation":
      return { label: "Deploying", tone: "blue", text: "Podster switched the app to this release and is waiting to confirm it's served. It isn't live until then.", link: null, ...at };
    case "failed":
      return { label: "Deployment failed", tone: "danger", text: `This release wasn't served. Whatever the app served before, it still serves.${reason(release.failure_code)}`, link: null, ...at };
    case "declined":
      return { label: "Declined", tone: "neutral", text: "The workroom's owner or an admin declined this release, so nothing was uploaded.", link: null, ...at };
    case "replaced":
      return { label: "Replaced", tone: "neutral", text: "A later release is served in its place.", link: null, ...at };
    case "unpublished":
      return { label: "Unpublished", tone: "neutral", text: "The app was taken down, so this release isn't served.", link: null, ...at };
    default:
      // `served` by its record, but not served now: the host moved on, the app is held or suspended, the workroom isn't
      // public, or the content domain is stopped.
      return { label: "Not live", tone: "amber", text: "Podster once confirmed this release served, but it isn't served now.", link: null, ...at };
  }
}

/** The merge and the deployment side by side, as DESIGN.md's compound results: "Merged · Deployment failed". */
export const releaseHeadline = (mergeLabel: string, stage: DeploymentStage) => `${mergeLabel} · ${stage.label}`;

/** What every merge confirmation says in M6. */
export const MERGE_RELEASES_NOTHING = "Merging releases nothing: no app is published or changed by a merge.";
