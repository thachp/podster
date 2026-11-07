/**
 * One scan, with nothing here tied to a real queue, bucket or Container, so each way it can go wrong can be tested.
 *
 * A file ends in one of two ways: nothing known was found, or it's blocked. Everything else is no verdict: it sends nothing, the
 * queue tries again, and the room marks the scan as failed after an hour. So a scanner that never answers, a stalled upload, a
 * dead clamd and old signatures can't let a file through, and the Worker reads every answer as if the Container could be wrong,
 * because it's reading hostile files.
 */

export const MAX_SIGNATURE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
export const READY_TIMEOUT_MS = 150_000;
/** Longer than the slowest scan seen, 18.6 s, and than the Container's own limits, so it normally answers first. */
export const SCAN_TIMEOUT_MS = 5 * 60_000;
export const REPORT_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 100_000_000;

export type ScanJob = { v: 1; workspace_id: string; object_id: string; key: string; size: number; sha256: string };
export type Report = "no_known_malware" | "malware_found" | "unreadable";
export type Database = { engine: string; version: string; built_at: string };
export type ScanResult = { v: 1; workspace_id: string; object_id: string; report: Report; reason: string; sha256: string; bytes: number; database: Database | null; scanned_at: number };

/** The R2 object, or what the test gives instead. */
export type StoredFile = { size: number; body: BodyInit };

export type Scanning = {
  now: () => number;
  /** Null if the bucket has no such object. */
  read: (key: string) => Promise<StoredFile | null>;
  /** Calls the Container. It may hang or throw, and a timeout is the caller's to pass. */
  container: (request: Request) => Promise<Response>;
  /** Tells the room. */
  send: (result: ScanResult, signal: AbortSignal) => Promise<Response>;
};

export type Ending = { ack: true; outcome: Report | "bad_message" } | { ack: true; outcome: "not_recorded"; status: number } | { ack: false; why: NoVerdict };
export type NoVerdict = "not_ready" | "signatures_stale" | "no_answer" | "bad_answer" | "report_refused";

/**
 * The room answered and recorded nothing. 400: `invalid_argument`, such as a bad `v` or a clean report without its signatures.
 * 404: a wrong secret or an unknown object. 409: `scan_mismatch` on a clean report, or `invalid_transition`. 422: a report the
 * room refuses. Each would be refused again, and each retry is a full rescan on the one Container.
 */
const ANSWERED_NOT_RECORDED: readonly number[] = [400, 404, 409, 422];
const REPORTS: readonly string[] = ["no_known_malware", "malware_found", "unreadable"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function readJob(body: unknown): ScanJob | null {
  if (typeof body !== "object" || body === null) return null;
  const job = body as Partial<ScanJob>;
  const fits = job.v === 1 && typeof job.workspace_id === "string" && ID.test(job.workspace_id) && typeof job.object_id === "string" && ID.test(job.object_id) && typeof job.key === "string" && job.key.length > 0 && job.key.length <= 1024 && typeof job.sha256 === "string" && SHA256.test(job.sha256) && Number.isSafeInteger(job.size) && job.size! >= 0;
  return fits ? (job as ScanJob) : null;
}

export function readDatabase(value: unknown): Database | null {
  if (typeof value !== "object" || value === null) return null;
  const { engine, version, built_at } = value as Partial<Database>;
  if (typeof engine !== "string" || typeof version !== "string" || typeof built_at !== "string" || !/^\d+$/.test(version) || engine.length === 0 || engine.length > 40) return null;
  return Number.isNaN(Date.parse(built_at)) ? null : { engine, version, built_at };
}

/** Decision 84, asked of each answer as well as by the Container, so one wrong clock can't give a verdict. */
export function signaturesAreFresh(database: Database | null, now: number) {
  if (!database) return false;
  const age = now - Date.parse(database.built_at);
  return age >= -MAX_AHEAD_MS && age <= MAX_SIGNATURE_AGE_MS;
}

/** A verdict is an exact answer, about this exact file, from signatures that are still fresh. Anything else isn't one. */
export function readVerdict(status: number, body: unknown, job: ScanJob, now: number): Pick<ScanResult, "report" | "reason" | "sha256" | "bytes" | "database"> | NoVerdict {
  if (status === 503 && typeof body === "object" && body !== null && (body as { error?: unknown }).error === "signatures_stale") return "signatures_stale";
  if (status !== 200 || typeof body !== "object" || body === null) return "no_answer";
  const { report, reason, sha256, bytes, database } = body as Record<string, unknown>;
  const read = readDatabase(database);
  if (!read) return "bad_answer";
  if (!signaturesAreFresh(read, now)) return "signatures_stale";
  if (typeof report !== "string" || !REPORTS.includes(report) || typeof reason !== "string" || reason.length === 0 || reason.length > 120 || bytes !== job.size) return "bad_answer";
  // A report that blocks is believed whatever bytes it's about. Saying nothing was found about other bytes isn't.
  if (report === "no_known_malware" && sha256 !== job.sha256) return "bad_answer";
  return { report: report as Report, reason, sha256: job.sha256, bytes: job.size, database: read };
}

export const SCAN_RESULT_PATH = "/internal/scan-result";
/** Proves this came from the scanner. The secret is on this Worker only, and never reaches the Container. */
export const SCANNER_HEADER = "x-podster-scanner";

/**
 * Tells the room over its service binding. There's no idempotency key on purpose: the room runs `record_scan` every time, which
 * can only tighten, so a later finding still blocks a file. With no secret set, nothing is sent, so the queue retries.
 */
export function sendResult(api: Pick<Fetcher, "fetch">, secret: string | undefined, result: ScanResult, signal: AbortSignal): Promise<Response> {
  if (!secret) return Promise.resolve(new Response(null, { status: 503 }));
  return api.fetch(`https://api${SCAN_RESULT_PATH}`, { method: "POST", signal, headers: { "content-type": "application/json", [SCANNER_HEADER]: secret }, body: JSON.stringify(result) });
}

/** Holds for all of `start`, including reading a body, because a Container can stall after its headers just as well as before. */
export const withTimeout = async <T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([start(controller.signal), new Promise<null>((done) => controller.signal.addEventListener("abort", () => done(null), { once: true }))]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const jsonOf = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const answerOf = async (response: Promise<Response>) => {
  const answered = await response;
  return { status: answered.status, body: await jsonOf(answered) };
};

async function tell(job: ScanJob, found: Omit<ScanResult, "v" | "workspace_id" | "object_id" | "scanned_at">, scanning: Scanning): Promise<Ending> {
  const result: ScanResult = { v: 1, workspace_id: job.workspace_id, object_id: job.object_id, scanned_at: scanning.now(), ...found };
  const answer = await withTimeout((signal) => scanning.send(result, signal), REPORT_TIMEOUT_MS);
  if (answer?.ok) return { ack: true, outcome: result.report };
  // The room answered and won't record this, so trying again won't help. The hour limit ends the file as failed. A wrong secret
  // looks the same as an unknown object here, which is why this has its own word in the log.
  if (answer && ANSWERED_NOT_RECORDED.includes(answer.status)) return { ack: true, outcome: "not_recorded", status: answer.status };
  return { ack: false, why: "report_refused" };
}

export async function scanOne(body: unknown, scanning: Scanning): Promise<Ending> {
  const job = readJob(body);
  // Nothing can be said about a file this doesn't name, and retrying won't help. The room's hour still ends it as failed.
  if (!job) return { ack: true, outcome: "bad_message" };

  // Before reading a byte of the file, because old signatures shouldn't even wake a read.
  const ready = await withTimeout((signal) => answerOf(scanning.container(new Request("http://scanner/ready", { signal }))), READY_TIMEOUT_MS);
  if (!ready) return { ack: false, why: "not_ready" };
  if (ready.status !== 200) return { ack: false, why: (ready.body as { error?: unknown } | null)?.error === "signatures_stale" ? "signatures_stale" : "not_ready" };
  const database = readDatabase((ready.body as { database?: unknown } | null)?.database);
  if (!database) return { ack: false, why: "bad_answer" };
  if (!signaturesAreFresh(database, scanning.now())) return { ack: false, why: "signatures_stale" };

  const blocked = (reason: string, bytes: number) => tell(job, { report: "unreadable", reason, sha256: job.sha256, bytes, database }, scanning);
  const file = await scanning.read(job.key);
  if (!file) return blocked("object_missing", job.size);
  if (file.size !== job.size) return blocked("size_mismatch", file.size);
  if (file.size > MAX_FILE_BYTES) return blocked("too_large_to_scan", file.size);

  const headers = { "content-length": String(file.size), "x-expected-sha256": job.sha256 };
  const answer = await withTimeout((signal) => answerOf(scanning.container(new Request("http://scanner/scan", { method: "POST", headers, body: file.body, signal }))), SCAN_TIMEOUT_MS);
  if (!answer) return { ack: false, why: "no_answer" };
  const verdict = readVerdict(answer.status, answer.body, job, scanning.now());
  return typeof verdict === "string" ? { ack: false, why: verdict } : tell(job, verdict, scanning);
}
