import { FAILURE_COPY } from "@/components/sheet/target-sheet";
import type { TaskFile } from "./task-model";

/** At most this many links and files together on one submission, as the API counts them. */
export const MAX_SUBMISSION_ITEMS = 10;

/** Why a submission's files stop it being approved, as far as this read shows. The API checks each one again. */
export function approvalBlocker(files: Pick<TaskFile, "state">[]) {
  const states = new Set(files.map((file) => file.state));
  if (states.has("removed") || states.has(null)) return "A file in it has been removed, so it can't be approved. Request changes instead.";
  if (states.has("blocked") || states.has("failed")) return "A file in it was blocked or couldn't be scanned, so it can't be approved. Request changes instead.";
  if ([...states].some((state) => state !== "ready")) return "A file in it isn't ready, so it can't be approved yet.";
  return null;
}

const UPLOAD_REFUSED: Record<string, string> = {
  file_too_large: "It's over 100 MB, which is the most a file can be.",
  room_quota_exceeded: "This workroom has used its 5 GB of file space.",
  workspace_archived: "This workroom is archived, so nothing can be added to it.",
  invalid_file_name: "Its name can't be used. Rename it and add it again.",
  executable_refused: "Programs and files that run when opened can't be uploaded. Put code in a zip.",
  password_protected_refused: "Password-protected files can't be uploaded, because they can't be scanned.",
  macro_file_refused: "Files with macros can't be uploaded.",
  file_not_inspectable: "Its type couldn't be worked out from its content, so it can't be uploaded.",
  file_type_refused: "This type of file isn't allowed.",
  upload_mismatch: "What arrived wasn't the file that was chosen. It may have changed while it was sending. Add it again.",
  limit_exceeded: "You already have 10 files for this task that no submission names. Files you removed here still count, unless they were blocked or failed their scan, until they're cleared 24 hours after this task leaves Accepted.",
  task_not_found: "This task can't be found any more.",
  invalid_transition: "This task isn't waiting for your work any more, so nothing can be added to it.",
  not_allowed: "Only this task's assignee can add files to its submission.",
  access_revoked: "You no longer have access to this workroom.",
  file_unreadable: "It couldn't be read. It may have moved or changed since you chose it.",
  network_error: "The connection was lost.",
  storage_unavailable: "File storage didn't answer.",
  upload_timed_out: "It took too long to send.",
  upstream_unavailable: "Podster didn't answer.",
  rate_limited: "Too many requests at once.",
  upload_outcome_unknown: "We can't tell whether it arrived. Add it again.",
  upload_not_found: "Its upload expired or was ended. Add it again.",
};

/** What to say about a file that didn't upload. */
export const uploadProblem = (code: string, status: number) => UPLOAD_REFUSED[code] ?? (status === 401 ? "You've been signed out. Sign in again, then add it again." : "It didn't upload. Add it again.");

const SUBMIT_REFUSED: Record<string, string> = {
  too_many_artifacts: "A submission can hold at most 10 files and links together.",
  duplicate_file: "The same file is in it twice.",
  file_not_found: "A file in it can't be found. Remove it and add it again.",
  file_not_ready: "A file in it hasn't finished scanning as ready. Wait for its scan, or remove it.",
  file_removed: "A file in it has been removed. Remove it here and add it again.",
  invalid_argument: "It needs a note or at least one file, and a note can be at most 16 KB.",
  not_allowed: "Only this task's assignee can submit work on it.",
};

/** What to say about a submission that didn't go through. "unknown" is a lost answer: the same key can't submit twice. */
export function submitProblem(code: string, status: number) {
  if (code === "unknown" || status >= 500) return "We can't tell whether your work was submitted, so we read the task again. If it still shows as Accepted, submit again without changing anything: that can't submit twice.";
  if (status === 401) return "That wasn't submitted. Your session has ended. Copy your note, then sign in again.";
  if (status === 429) return "That wasn't submitted. Too many requests, so wait a minute and try again.";
  if (code === "workspace_archived") return "That wasn't submitted. This workroom is archived, so nothing new can happen in it.";
  return `That wasn't submitted. ${SUBMIT_REFUSED[code] ?? "You may no longer be allowed to do this."}`;
}

const VERIFY_REFUSED: Record<string, string> = {
  file_not_ready: "A file in it isn't ready now. A later scan may have blocked it. Request changes instead.",
  file_changed: "A file in it no longer matches the version that was submitted. Request changes instead.",
  file_removed: "A file in it has been removed since it was submitted. Request changes instead.",
  files_not_checked: "Podster couldn't check its files, so it wasn't approved. Try again, and tell the workroom's owner if it keeps happening.",
};

/**
 * What to say when approving doesn't go through: why a file stopped it, and otherwise the Sheet's own words, so a lost answer
 * still says it can't tell. Nothing was approved in any refusal here.
 */
export function verifyProblem(code: string, status: number) {
  if (code !== "unknown" && status < 500 && status !== 401 && status !== 429 && Object.hasOwn(VERIFY_REFUSED, code)) return `That wasn't approved, and nothing changed. ${VERIFY_REFUSED[code]}`;
  if (code === "unknown" || status >= 500) return FAILURE_COPY.unknown;
  if (status === 401) return FAILURE_COPY.signed_out;
  if (status === 429) return FAILURE_COPY.rate_limited;
  return code === "workspace_archived" ? FAILURE_COPY.workspace_archived : FAILURE_COPY.refused;
}

/**
 * `files_not_checked` comes back as a 500, but it's a definite refusal: the API answers it before anything commits. Left as a
 * 500, the Sheet would say it can't tell whether the approval went through.
 */
export const definiteRefusal = <T extends { ok: boolean; status?: number; code?: string }>(result: T): T => (!result.ok && result.code === "files_not_checked" ? { ...result, status: 409 } : result);
