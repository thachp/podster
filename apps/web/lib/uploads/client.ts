"use client";

import { clientCommand } from "@/lib/gateway/client";

/** Only so a file that can't fit isn't read into memory to be hashed. The API decides, by what really arrives. */
export const MAX_UPLOAD_BYTES = 100_000_000;

export type UploadProgress = { phase: "hashing" } | { phase: "reserving" } | { phase: "sending"; sent: number; total: number } | { phase: "storing" };

export type UploadedFile = { id: string; state: string; size: number; sha256: string; media_type?: string };

export type UploadResult =
  | { ok: true; data: UploadedFile }
  /** `retry` is there only when the same token can try again. It sends the bytes once more, and the token stays inside it. */
  | { ok: false; status: number; code: string; retry?: () => Promise<UploadResult> };

type Options = { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void };
type Reservation = { upload_path: string; token: string };

// Answers that say this attempt failed and the upload is still open. A lost connection is one, though the file may have arrived
// with only the answer lost, and then a retry answers `invalid_transition`.
const CAN_RETRY = new Set(["network_error", "storage_unavailable", "upload_timed_out", "upstream_unavailable", "rate_limited"]);
const CANCELED: UploadResult = { ok: false, status: 0, code: "upload_canceled" };

/**
 * Sends a file to a room: hashes it, reserves its space, then sends the bytes through this host's `/api`.
 *
 * The token lives only in this call. It's never returned, stored or put in a URL, and `create_upload` won't give it again.
 * XMLHttpRequest because it's the only way all browsers report an upload's progress, and a File is read from disk as it goes.
 * Hashing does hold the whole file for a moment, since the browser's own SHA-256 can't take it in parts.
 *
 * A reached 100% isn't a finished upload: `storing` runs until the API has checked and kept the file, and only `ok` means it did.
 * A failed upload keeps its reserved space until it expires, so prefer `retry` where it's offered to starting again.
 */
export async function uploadFile(workspaceId: string, file: File, options: Options = {}): Promise<UploadResult> {
  const { signal, onProgress } = options;
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, status: 413, code: "file_too_large" };
  if (signal?.aborted) return CANCELED;
  onProgress?.({ phase: "hashing" });
  let sha256: string;
  try {
    sha256 = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  } catch {
    // The file moved or changed since it was chosen, or there isn't the memory to read it.
    return { ok: false, status: 0, code: "file_unreadable" };
  }
  if (signal?.aborted) return CANCELED;
  onProgress?.({ phase: "reserving" });
  const reserved = await clientCommand<Reservation>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/uploads`, { name: file.name, size: file.size, sha256 });
  if (!reserved.ok) return reserved;
  const { upload_path: path, token } = reserved.data;
  return sendBytes(path, token, file, options);
}

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function sendBytes(path: string, token: string, file: File, options: Options): Promise<UploadResult> {
  const { signal, onProgress } = options;
  const again = () => sendBytes(path, token, file, options);
  return new Promise((done) => {
    if (signal?.aborted) return done(CANCELED);
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (result: UploadResult) => {
      signal?.removeEventListener("abort", abort);
      done(result);
    };
    const failed = (status: number, code: string): UploadResult => (CAN_RETRY.has(code) ? { ok: false, status, code, retry: again } : { ok: false, status, code });

    signal?.addEventListener("abort", abort);
    request.open("PUT", `/api${path}`);
    request.setRequestHeader("authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => onProgress?.({ phase: "sending", sent: event.loaded, total: file.size });
    request.upload.onload = () => onProgress?.({ phase: "storing" });
    request.onerror = () => finish(failed(0, "network_error"));
    request.onabort = () => finish(CANCELED);
    request.onload = () => {
      const body = parse(request.responseText);
      if (request.status >= 200 && request.status < 300 && body) return finish({ ok: true, data: body as UploadedFile });
      finish(failed(request.status, (body as { error?: { code?: string } } | null)?.error?.code ?? "error"));
    };
    request.send(file);
  });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
