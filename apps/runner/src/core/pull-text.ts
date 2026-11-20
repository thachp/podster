/**
 * The words Runner writes to GitHub for a task: its commit's message and its pull request's title and body. Pure.
 *
 * - **The title is a Conventional Commits line,** `<type>: <subject>`, at most `MAX_TITLE_CHARS` characters. The type
 *   comes from a fixed list: the agent may propose one in its structured result (`change_type`), and anything missing or
 *   not on the list is `chore`. The subject is the task's title, which its requester wrote, so it is untrusted text:
 *   cleaned to one plain line and made inert on GitHub (`inert`). Empty after that, it is `task <task ID>`.
 * - **The commit's message** starts with that same title, and names the task by its ID in a trailer.
 * - **The body** starts with a link to the task's page in Podster's web app, built from fixed parts: an app origin from
 *   Runner's own fixed table (`appOriginFor`), never from anything a task or Podster's answers say, and IDs checked
 *   against their exact form. Without either, the line names the task by its ID alone. The body carries no task or agent
 *   text at all.
 *
 * The task's ID stays out of the title: 36 of its 72 characters would go to it. The body's first line and the commit's
 * trailer carry it instead, and the branch is `podster/<task ID>`.
 *
 * Agent content is data: nothing here reads the words for meaning.
 */

/** The types a title may have. The agent may propose one; anything else is `chore`. */
export const CHANGE_TYPES = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "build", "ci", "style"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export const DEFAULT_CHANGE_TYPE: ChangeType = "chore";
/** The longest title, in Unicode code points, the type and `…` included. */
export const MAX_TITLE_CHARS = 72;

export const isChangeType = (v: unknown): v is ChangeType => typeof v === "string" && (CHANGE_TYPES as readonly string[]).includes(v);
/** The agent's proposed type when it is one on the list, else `chore`. */
export const changeTypeOf = (v: unknown): ChangeType => (isChangeType(v) ? v : DEFAULT_CHANGE_TYPE);

/**
 * The Podster web app's origin for each gateway Runner can pair with: a fixed table, so no task, answer or configuration
 * text can point a pull request's link anywhere else. Staging's only for now; there is no production deployment, and its
 * hosts are added here when there is.
 */
const APP_ORIGINS: Readonly<Record<string, string>> = Object.freeze({
  "https://gateway-staging.podster.dev": "https://app-staging.podster.dev",
});

/** The web app's origin for the gateway Runner is paired with, or null for any gateway not in the table. */
export function appOriginFor(gateway: unknown): string | null {
  if (typeof gateway !== "string" || !Object.hasOwn(APP_ORIGINS, gateway)) return null;
  return APP_ORIGINS[gateway];
}

const WORKSPACE_ID = /^ws_[A-Za-z0-9]{1,64}$/;
const TASK_ID = /^tsk_[A-Za-z0-9]{1,64}$/;

/**
 * The task's page in the web app: `/w/<workspace>/tasks?task=<task>`, the link the app itself uses to open a task's
 * sheet. Null unless the origin is exactly an `https` origin with no path, credentials, query or fragment, and both IDs
 * have their exact form.
 */
export function taskPageUrl(app_origin: string | null, workspace_id: unknown, task_id: unknown): string | null {
  if (app_origin === null || typeof workspace_id !== "string" || typeof task_id !== "string") return null;
  if (!WORKSPACE_ID.test(workspace_id) || !TASK_ID.test(task_id)) return null;
  let origin: URL;
  try {
    origin = new URL(app_origin);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" || origin.origin !== app_origin || origin.username || origin.password) return null;
  return `${origin.origin}/w/${encodeURIComponent(workspace_id)}/tasks?task=${encodeURIComponent(task_id)}`;
}

/** Characters dropped outright: invisible formatting (zero-width, bidi controls, BOM), default-ignorables, private use, unassigned and lone surrogates. */
const DROPPED = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}]/gu;
/** Characters that end or space a line: controls (tab and newline included), separators and any other white space. */
const SPACING = /[\p{Cc}\p{Z}\s]+/gu;

/** Untrusted text as one plain line: NFC, nothing invisible, no control or line break, single spaces, trimmed. */
export function oneLine(text: string): string {
  return text.normalize("NFC").replace(DROPPED, "").replace(SPACING, " ").trim().normalize("NFC");
}

/**
 * Text made inert on GitHub, in a title, a commit message or Markdown: it can't mention anyone, reference an issue, pull
 * request or commit in any repository, or carry a link GitHub would follow, so a closing keyword before it closes
 * nothing.
 *
 * - `@` becomes the full-width `＠` (U+FF20). GitHub reads a mention, and `owner/repo@sha`, only after an ASCII `@`, so
 *   no mention, team mention or email address survives, and the text reads the same to a person. A space after `@`
 *   would also stop it, but changes what the text says (`a@ b`); a zero-width character is invisible to a reviewer and is
 *   the kind of character `oneLine` removes.
 * - `#` becomes `＃` (U+FF03) for the same reason: no `#1`, `owner#1` or `owner/repo#1` reference is left.
 * - `GH-1` becomes `GH‑1` with a non-breaking hyphen (U+2011), which GitHub doesn't read as a reference.
 * - `://` and `www.` lose their ASCII colon and dot (`：//`, `www．`), so neither a bare link nor a full issue or pull
 *   request URL is linked, or read as a reference after `fixes`.
 *
 * With every reference form gone, a closing keyword (`fixes`, `closes`, `resolves` and their forms) has nothing to act
 * on, so the words themselves are left as written.
 */
export function inert(text: string): string {
  return text
    .replace(/@/g, "＠")
    .replace(/#/g, "＃")
    .replace(/\b(GH)-(?=\d)/gi, "$1‑")
    .replace(/:\/\//g, "：//")
    .replace(/\b(www)\./gi, "$1．");
}

/** A leading Conventional Commits prefix the requester wrote themselves, so a title never reads `chore: feat: …`. */
const OWN_PREFIX = new RegExp(`^(?:${CHANGE_TYPES.join("|")})(?:\\([^()]{0,40}\\))?!?:\\s*`, "i");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const codePoints = (s: string) => [...s].length;

/** Lower-cases the first letter when it starts a capitalised word (`Add` → `add`), never an acronym (`API`, `iOS`). */
function lowerFirst(subject: string): string {
  const [first, second] = [...subject];
  if (first === undefined || first === first.toLowerCase() || (second !== undefined && second !== second.toLowerCase())) return subject;
  const lowered = first.toLowerCase();
  // Only when it stays one character (`İ` lowers to two).
  return codePoints(lowered) === 1 ? lowered + subject.slice(first.length) : subject;
}

/** Cut on a character (grapheme) boundary so that it is at most `max` code points with `…`, or as it is if it fits. */
function cut(text: string, max: number): string {
  if (codePoints(text) <= max) return text;
  let kept = "";
  for (const { segment } of graphemes.segment(text)) {
    if (codePoints(kept) + codePoints(segment) + 1 > max) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}

/** The pull request's title and the commit's first line: `<type>: <subject>`, inert, at most `MAX_TITLE_CHARS`. */
export function conventionalTitle(input: { task_id: string; title: string | null; change_type?: unknown }): string {
  const type = changeTypeOf(input.change_type);
  const prefix = `${type}: `;
  let subject = oneLine(input.title ?? "").replace(OWN_PREFIX, "");
  subject = inert(subject).replace(/[.。\s]+$/u, "").trim();
  subject = lowerFirst(subject);
  if (subject === "") subject = `task ${input.task_id}`;
  return prefix + cut(subject, MAX_TITLE_CHARS - codePoints(prefix));
}

export type PullText = { title: string; body: string; commit_message: string };

/** Everything Runner writes to GitHub for a task's change. The task's ID must already be checked (`taskBranch`). */
export function pullText(input: { workspace_id: string; task_id: string; title: string | null; change_type?: unknown; app_origin: string | null }): PullText {
  const title = conventionalTitle(input);
  const page = taskPageUrl(input.app_origin, input.workspace_id, input.task_id);
  const first = page === null ? `Podster task: \`${input.task_id}\`` : `Podster task: [${input.task_id}](${page})`;
  const body = `${first}\n\nOpened by Podster Runner for task ${input.task_id}. Review it in Podster; Runner never merges.`;
  return { title, body, commit_message: `${title}\n\nPodster-Task: ${input.task_id}` };
}
