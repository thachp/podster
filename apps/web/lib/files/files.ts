/**
 * How a stored file is shown anywhere in the dashboard: its state's label, its size, and where it downloads. Shared by the Task
 * Sheet's submission files, input assets and the Artifacts tab. A file's name and label are agent content, and none of this
 * reads them.
 */

/** The fields a file read gives that this needs. `state` is null when the file's record is gone. */
export type StoredFile = { state: string | null; download_path: string | null };

export type FileTone = "neutral" | "amber" | "blue" | "green";

/** DESIGN.md's file labels. A scanner only knows known malware, so nothing here says a file is safe. */
export const FILE_STATE: Record<string, { label: string; tone: FileTone; detail: string }> = {
  uploading: { label: "Uploading", tone: "blue", detail: "It can't be downloaded until it has arrived and been scanned." },
  scanning: { label: "Scanning", tone: "amber", detail: "It can be downloaded once its scan finishes." },
  ready: { label: "Ready", tone: "green", detail: "No known malware found." },
  blocked: { label: "Blocked", tone: "neutral", detail: "Its scan refused it, so it can't be downloaded." },
  failed: { label: "Scan failed", tone: "neutral", detail: "It couldn't be scanned, so it can't be downloaded." },
  removed: { label: "Removed", tone: "neutral", detail: "Its bytes are gone. Its record and SHA-256 stay." },
};

const UNAVAILABLE = { label: "Unavailable", tone: "neutral" as FileTone, detail: "It can't be downloaded." };

/** A state this dashboard doesn't know, or a record that's gone, is never presented as Ready. */
export const fileState = (state: string | null) => (state && Object.hasOwn(FILE_STATE, state) ? FILE_STATE[state] : UNAVAILABLE);

/** Decimal units, as the upload limits are written: 100 MB is 100,000,000 bytes. */
export function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units: [number, string][] = [
    [1e3, "KB"],
    [1e6, "MB"],
    [1e9, "GB"],
  ];
  // Rounding can reach the next unit, as 999,950 bytes would show as 1,000 KB, so the unit is chosen after rounding.
  for (const [index, [scale, unit]] of units.entries()) {
    const value = bytes / scale;
    const digits = value < 10 ? 1 : 0;
    const rounded = Number(value.toFixed(digits));
    if (rounded < 1000 || index === units.length - 1) return `${rounded.toLocaleString("en-US", { maximumFractionDigits: digits })} ${unit}`;
  }
  return "Unknown size";
}

/** The API's own download path, and nothing else: no host, query, dot segment or encoded character. */
const FILE_PATH = /^\/v1\/files\/[\w-]+\/[\w-]+$/;

/**
 * Where the browser downloads a file: through this host's `/api`, with the person's session. Only a Ready file with a path of
 * the API's own shape becomes a link, so nothing else in a read can point the browser somewhere. The API serves it only as an
 * attachment, and decides again on each download. Link it with `download`, never `target`.
 */
export const downloadHref = (file: StoredFile) => (file.state === "ready" && file.download_path && FILE_PATH.test(file.download_path) ? `/api${file.download_path}` : null);
