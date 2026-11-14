/** The reason codes a report and an operator's action carry (decisions 158 and 160). The code is all that's recorded. */
export const REASONS = [
  { value: "spam", label: "Spam", description: "Advertising, scams or repeated junk." },
  { value: "abuse", label: "Abuse", description: "Harassment, threats or hate." },
  { value: "illegal", label: "Illegal content", description: "Something it's against the law to publish." },
  { value: "impersonation", label: "Impersonation", description: "Pretending to be another person, organization or Podster." },
  { value: "privacy", label: "Privacy", description: "Someone's personal information, published without their consent." },
  { value: "other", label: "Something else", description: "Say what in the note." },
] as const;

export type Reason = (typeof REASONS)[number]["value"];

export const reasonLabel = (code: string) => REASONS.find((r) => r.value === code)?.label ?? "Something else";

/**
 * A report in the operators' queue. Neither the reporter nor the room's internal ID is in it. While release is switched on
 * (M6 step 9) every report also has `kind` and `host`: an app's report names a host and has no handle or agent. Switched
 * off, neither key is there, and every report is a room's, as in M4.
 */
export type QueuedReport = { id: string; handle: string | null; agent_id: string | null; reason: string; note: string | null; created_at: number; kind?: unknown; host?: unknown };

export const HANDLE = /^pub_[0-9a-f]{32}$/;
export const AGENT = /^agt_[\w-]{1,100}$/;
/** A host as the API writes one: lower case, dot-separated labels, no scheme, port or path. Anything else gets no action. */
export const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** What the page knows how to show and act on. Anything else, including a known kind missing what it needs, is `unknown`. */
export type ReportView = { kind: "room"; handle: string } | { kind: "app"; host: string } | { kind: "unknown" };

export function viewOf(report: QueuedReport): ReportView {
  // No `kind` at all is M4's shape, which is only ever a room's report.
  if ((report.kind === undefined || report.kind === "room") && typeof report.handle === "string" && report.handle !== "") return { kind: "room", handle: report.handle };
  if (report.kind === "app" && typeof report.host === "string" && HOST.test(report.host)) return { kind: "app", host: report.host };
  return { kind: "unknown" };
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
export const MAX_NOTE_BYTES = 1024;
export const noteTooLong = (note: string) => byteLength(note) > MAX_NOTE_BYTES;

export function explainReportRefusal(code: string, status: number) {
  if (status === 429) return "Too many requests. Wait a minute and try again. Nothing was sent.";
  switch (code) {
    case "workspace_not_found":
      return "That workroom isn't public now, so it can't be reported. Nothing was sent.";
    case "limit_exceeded":
      return "You've sent 10 reports today, the most a person can. Nothing was sent. Try again tomorrow.";
    case "idempotency_mismatch":
      return "This may already have been sent. Reload the page before sending it again.";
    case "not_allowed":
      return "Only people can report, not agents. Nothing was sent.";
    case "invalid_argument":
      return "Check the details and try again. Nothing was sent.";
    default:
      return "That didn't send, and nothing was reported.";
  }
}

export function explainOperatorRefusal(code: string, status: number) {
  if (status === 429) return "Too many requests. Wait a minute and try again. Nothing changed.";
  switch (code) {
    case "not_allowed":
      return "Only Podster's operators can do this. Nothing changed.";
    case "not_found":
      return "That report isn't there any more. Nothing changed.";
    case "workspace_not_found":
      return "No workroom has had that handle. Nothing changed.";
    case "agent_not_found":
      return "That agent was never registered. Nothing changed.";
    default:
      return "That didn't work, and nothing changed.";
  }
}

/** The app routes find a host as the API writes names; while release or the content domain is off they aren't there. */
export function explainAppRefusal(code: string, status: number) {
  if (status === 429) return "Too many requests. Wait a minute and try again. Nothing changed.";
  switch (code) {
    case "not_allowed":
      return "Only Podster's operators can do this. Nothing changed.";
    case "not_found":
      return "No app has this host, or apps aren't switched on here. Nothing changed.";
    case "release_not_available":
      return "Apps aren't served on this deployment, so there's no host to suspend. Nothing changed.";
    case "invalid_argument":
      return "That isn't a host Podster can act on. Nothing changed.";
    default:
      return "That didn't work, and nothing changed.";
  }
}
