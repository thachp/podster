import type { Tone } from "../tasks/task-model";

export type OutputStatus = "not_started" | "in_review" | "ready";

/**
 * One expected output, as `GET /outputs` lists it. `current` is there only for someone who can see the task whose approval
 * made it Ready, and `files_available` only for someone who may also read that submission's files. Title and description are
 * someone's text, shown and never acted on.
 */
export type Output = {
  id: string;
  title: string;
  description: string | null;
  status: OutputStatus | string;
  /** A task naming it is submitted. For a Ready output, that's a newer version awaiting review, which never replaces the badge. */
  in_review?: boolean;
  current: { task_id: string; submission_no: number; approved_at?: number | null; files_available?: boolean } | null;
};

export type OutputsRead = { outputs: Output[]; ready: number; total: number };

/**
 * One approval that made an output Ready, newest first. `task_id` and `approved_by` are there only for someone who can see the
 * source task. Nothing here is about files: those are read through the task.
 */
export type OutputVersion = { submission_no: number; approved_at: number; task_id?: string; approved_by?: string };
export type VersionsRead = { versions: OutputVersion[]; complete: boolean };

/** How many Ready outputs get their history read with the page. Each read spends the person's rate limit, so past this it's read when asked. */
export const PRELOADED_HISTORIES = 10;

/** The version that's current, when the history's newest entry is the one the listing names. */
export const currentVersion = (output: Output, history: VersionsRead | undefined) => {
  const newest = history?.versions[0];
  return newest && output.current && newest.task_id === output.current.task_id && newest.submission_no === output.current.submission_no ? newest : undefined;
};

/** DESIGN.md's three states, each with an icon beside it so color is never the only signal. */
export const OUTPUT_STATUS: Record<OutputStatus, { label: string; tone: Tone }> = {
  not_started: { label: "Not started", tone: "neutral" },
  in_review: { label: "In review", tone: "violet" },
  ready: { label: "Ready", tone: "green" },
};

/** A state this screen doesn't know is never presented as Ready. */
export const outputStatus = (status: string) => (Object.hasOwn(OUTPUT_STATUS, status) ? OUTPUT_STATUS[status as OutputStatus] : { label: "Unknown state", tone: "neutral" as Tone });

/** Decision 140. Checked here only to say so early: the API decides. */
export const OUTPUT_LIMITS = { outputs: 50, everDefined: 500, title: 200, description: 4096 };

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** What's wrong with a title and description before sending, or null. */
export function outputTextProblem(title: string, description: string) {
  if (title.trim() === "") return "A title is required.";
  if (bytes(title.trim()) > OUTPUT_LIMITS.title) return `A title can be at most ${OUTPUT_LIMITS.title} bytes.`;
  if (bytes(description.trim()) > OUTPUT_LIMITS.description) return "A description can be at most 4 KB.";
  return null;
}

/** "n of m outputs ready", from the API's own count. */
export const readyText = (ready: number, total: number) => (total === 0 ? "No expected outputs yet." : `${ready} of ${total} ${total === 1 ? "output" : "outputs"} ready`);

/** Decision 138: a Ready output keeps its status when a file of it is later blocked or removed, and the screen says so. */
export function currentFilesText(current: Output["current"]) {
  if (!current || current.files_available === undefined) return null;
  // True for a version with only links, too, so this doesn't promise a file.
  return current.files_available ? "Everything in the approved version is still available from its task." : "A file in the approved version has since been blocked or removed, so it can't be downloaded. The output stays Ready, as it was approved.";
}

/** Why an output command was refused. Nothing changed in any of these. */
export function outputProblem(code: string, status = 400) {
  if (status >= 500 || code === "unknown") return "We can't tell whether this saved. Try again: if it did, you'll get that answer and it won't happen twice.";
  switch (code) {
    case "too_many_outputs":
      return `This workroom can't have another expected output. It can have ${OUTPUT_LIMITS.outputs} at once, and ${OUTPUT_LIMITS.everDefined} in all, counting removed ones. Nothing changed.`;
    case "output_in_use":
      return "This output can't be removed: it was Ready once, or a task that isn't finished works toward it. Nothing changed.";
    case "output_not_found":
      return "That output isn't there any more. Nothing changed.";
    case "invalid_argument":
      return `Check the title and description. A title is required and can be at most ${OUTPUT_LIMITS.title} bytes, and a description at most 4 KB. Nothing changed.`;
    case "workspace_archived":
      return "This workroom is archived, so nothing new can happen in it. Nothing changed. Its owner or an admin can bring it back.";
    case "not_allowed":
      return "Only this workroom's owner or an admin can define, rename or remove expected outputs. Nothing changed.";
    default:
      return "That didn't save, and nothing changed. You may no longer be allowed to do this.";
  }
}
