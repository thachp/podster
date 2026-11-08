import { plainName } from "@/components/agent-content/text";

/** A file as `listFiles` and `getFile` return it. `name` is agent content: shown as plain text, never followed. */
export type RoomFile = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  media_type: string | null;
  state: string;
  /** Null unless the viewer may download it now. It carries no authority: the download rechecks everything. */
  download_path: string | null;
  /** The tasks it's attached to that the viewer can see. */
  linked_tasks: string[];
};

/** `quota` comes only to someone who sees the whole room, and only when the API sends it. */
export type Quota = { used: number; limit: number };
export type FilePage = { files: RoomFile[]; next_cursor: number | null; quota?: Quota };

/** The upload policy's limits, as the API applies them. Shown to explain a refusal, never to decide one. */
export const MAX_FILE_BYTES = 100_000_000;
export const ROOM_QUOTA_BYTES = 5_000_000_000;

/** A file's name as text. It's whatever the uploader called it, cleaned by the API, and gets no meaning here. */
export const fileName = (file: Pick<RoomFile, "name">) => plainName(file.name);

const wait = (seconds?: number) => (seconds ? `Wait ${seconds} ${seconds === 1 ? "second" : "seconds"} and try again.` : "Wait a minute and try again.");

/** What the API's refusal of an upload means for the person. Each says what happened to the file. */
export function explainUpload(code: string, status: number, retryAfter?: number) {
  switch (code) {
    case "file_too_large":
      return "This file is over 100 MB, the most one file can be. Nothing was uploaded.";
    case "executable_refused":
      return "Podster doesn't take programs, installers or files that run when opened. Nothing was uploaded. Code can go inside a zip.";
    case "room_quota_exceeded":
      return "This workroom doesn't have space for this file. It holds up to 5 GB, counting every file kept. Nothing was uploaded.";
    case "invalid_file_name":
      return "That file name can't be used. Rename the file and upload it again.";
    case "workspace_archived":
      return "This workroom is archived, so nothing new can be uploaded.";
    case "not_allowed":
      return "Your access here doesn't include uploading files.";
    case "access_revoked":
      return "You no longer have access to this workroom, so the upload stopped.";
    case "upload_mismatch":
      return "What arrived isn't the file that was chosen. It may have changed while it was sent. Choose it again.";
    case "file_unreadable":
      return "Couldn't read that file. It may have moved or changed since you chose it. Choose it again.";
    case "upload_canceled":
      return "Upload canceled. The space it reserved is freed within an hour.";
    case "upload_not_found":
      return "This upload expired before the file arrived. Choose the file again.";
    case "invalid_transition":
    case "upload_outcome_unknown":
      return "The workroom didn't confirm this upload, and the file may have arrived. Check the list below before uploading it again.";
    case "upload_timed_out":
      return "The upload took too long and stopped. Try again.";
    case "network_error":
      return "The connection dropped, so the upload stopped. Try again.";
    case "storage_unavailable":
    case "upstream_unavailable":
    case "room_unavailable":
      return "Podster couldn't store the file just now. Try again.";
    case "rate_limited":
      return `Too many requests, so the upload didn't start. ${wait(retryAfter)}`;
  }
  if (status === 415) return "This kind of file isn't accepted. Podster takes documents, images, text, code, presentations, video and zip archives. Nothing was uploaded.";
  if (status === 413) return explainUpload("file_too_large", status);
  return "The upload didn't finish. Try again, or choose the file again.";
}

/** What a refusal to attach or remove a file means. A hidden file or task answers as one that isn't there. */
export function explainLink(code: string, status: number, retryAfter?: number) {
  switch (code) {
    case "file_not_available":
      return "Only a file that's scanning or ready can be attached. This one is blocked, its scan failed, or it hasn't finished uploading.";
    case "task_closed":
      return "That task is completed or canceled, so files can't be attached to it. Removing a file still works.";
    case "limit_exceeded":
      return "That task already has 50 files attached, the most one task can have.";
    case "task_not_found":
      return "That task isn't there, or your access doesn't show it.";
    case "file_not_found":
      return "That file isn't there, or your access doesn't show it.";
    case "workspace_archived":
      return "This workroom is archived, so attachments can't change.";
    case "not_allowed":
      return "Your access here doesn't include attaching files to tasks.";
    case "access_revoked":
      return "You no longer have access to this workroom.";
    case "rate_limited":
      return `Too many requests, so nothing changed. ${wait(retryAfter)}`;
  }
  if (status === 429) return explainLink("rate_limited", status, retryAfter);
  return "That didn't work, and nothing changed. Try again.";
}

/** Owner, admin and member roles may upload and attach input assets, Coordinators included, as they hold the member role. Display only: Rust decides. */
export const mayManageAssets = (role: string | undefined) => role === "owner" || role === "admin" || role === "member";
