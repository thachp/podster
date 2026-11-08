import { authoritySoundingName, chosenNameLabel, plainName, truncate } from "@/components/agent-content/text";

/** What the API returns for tasks, and the wording the design spec gives it. Nothing here decides anything: Rust does. */

export const TASK_STATUSES = ["open", "offered", "accepted", "submitted", "completed", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  title: string;
  instructions: string;
  acceptance_criteria: string | null;
  requester: string;
  assignee: string | null;
  reviewer: string;
  status: TaskStatus;
  version: number;
  due_at: number | null;
  follow_up_of: string | null;
  submission_no: number;
  /** The submission a reviewer approved, or null if none has been. The Sheet reads it, and lists never need it. */
  approved_submission_no?: number | null;
  needs_attention: boolean;
};

/**
 * A task as a list holds it. Rows don't show instructions or criteria, the Sheet reads its own, and at 64 KB of instructions
 * a task, a long list would otherwise keep tens of megabytes it never uses.
 */
export type TaskSummary = Omit<Task, "instructions" | "acceptance_criteria">;
export function summaryOf(task: TaskSummary): TaskSummary {
  const { instructions: _instructions, acceptance_criteria: _criteria, ...summary } = task as Task;
  return summary;
}

export type From = { id: string; org: string };
export type Message = { id: string; from: From; external: boolean; body: string; created_at: number };
export type Artifact = { id: string; submission_no: number; uri: string; label: string; from: From; external: boolean; created_at: number };
/**
 * A stored file on a submission, as the task read lists it. `sha256` and `size` are what the submission pinned, and `state` is
 * the file's now, null if its record is gone. `label` and `name` are agent content. `download_path` is null unless the viewer
 * may download it now. `submitted` false is the viewer's own upload for the task that no submission names yet, with no
 * `submission_no`. Through oversight a file has only `id`, `submission_no`, `name` and `state`, so the rest are optional.
 */
export type TaskFile = { id: string; submitted?: boolean; submission_no: number | null; label?: string | null; name: string | null; size?: number; sha256?: string; media_type?: string | null; state: string | null; download_path: string | null; from?: From; external?: boolean; created_at?: number };
export type Submission = { submission_no: number; task_version: number; note: string | null; commit_sha: string | null; from: From; external: boolean; created_at: number };
export type HistoryEvent = { id: string; type: string; from: From; external: boolean; reason: string | null; prior_status: string | null; new_status: string | null; task_version: number | null; created_at: number };
/** What the viewer's access leaves out of this read. Without it, empty lists can't be told from a task with nothing in them. */
export type TaskVisibility = { submissions: "all" | "own"; conversation: boolean };
/** The expected output a task works toward. `removed` means it was removed since the task named it. */
export type TaskOutput = { id: string; title: string; removed: boolean };
export type TaskDetail = { task: Task; expected_output?: TaskOutput | null; submissions: Submission[]; artifacts: Artifact[]; files?: TaskFile[]; messages: Message[]; history: HistoryEvent[]; visible?: TaskVisibility };

export type Member = { principal_id: string; kind: string; org_id: string; role: string; access?: { review: string; artifacts: string } };
export type Room = { id: string; name: string; owner: string; status?: string; require_person_review?: boolean; owner_left_at?: number | null; members?: Member[] };

/** Display only. In an archived room Rust refuses every new command with `workspace_archived`. */
export const isArchivedRoom = (room: Pick<Room, "status">) => room.status === "archived";

/** IDs, and what we know to call them. Only the viewer's own organizations have names so far, so everyone else shows as an ID. */
export type Names = Record<string, string>;

export type Tone = "neutral" | "amber" | "blue" | "violet" | "green";

/** docs/spec/DESIGN.md section 4. Every screen takes its label from here, so a state can't have two. */
export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "neutral" },
  offered: { label: "Awaiting acceptance", tone: "amber" },
  accepted: { label: "Accepted", tone: "blue" },
  submitted: { label: "Awaiting review", tone: "violet" },
  completed: { label: "Completed", tone: "green" },
  canceled: { label: "Canceled", tone: "neutral" },
};

/** The order a person works through them: what's waiting on someone first, finished work last. */
export const GROUP_ORDER: TaskStatus[] = ["submitted", "open", "offered", "accepted", "completed", "canceled"];

export const kindOf = (principal: string) => (principal.startsWith("agt_") ? ("agent" as const) : ("person" as const));

/** People and agents choose their own names, so these never go on screen unsanitized. An ID comes from the server, and costs nothing to treat the same. */
export const nameOf = (id: string, me: string, names: Names) => (id === me ? "You" : plainName(names[id] ?? id));

/** Whether a name could pass for Podster, the room's authority or the viewer. "You" for the viewer is ours, and nobody chose it. */
export const isChosenName = (id: string, name: string, me: string) => id !== me && authoritySoundingName(name);

/** For places that take text only, such as an `<option>` or a sentence, where a badge can't go. */
export function textNameOf(id: string, me: string, names: Names) {
  const name = nameOf(id, me, names);
  return isChosenName(id, name, me) ? `${name} (${chosenNameLabel(kindOf(id)).toLowerCase()})` : name;
}

/** For a tight space such as a map: the name is cut, never its label, which is short and goes on separately. */
export function shortNameOf(id: string, me: string, names: Names, max: number) {
  const name = nameOf(id, me, names);
  const cut = truncate(name, max);
  return { name: cut.truncated ? `${cut.text}…` : cut.text, label: isChosenName(id, name, me) ? "(chosen name)" : null };
}

const VERBS: Record<string, string> = {
  "task.created": "created this task",
  "task.offered": "offered this task",
  "task.reassigned": "offered this task to someone else",
  "task.updated": "edited this task",
  "task.plan_changed": "changed this task's plan",
  "task.reviewer_changed": "changed the reviewer",
  "task.requester_changed": "changed the requester",
  "task.accepted": "accepted",
  "task.declined": "declined",
  "task.released": "released",
  "task.submitted": "submitted",
  "task.changes_requested": "requested changes",
  "task.completed": "approved",
  "task.canceled": "canceled",
  // The actor of these two is whoever removed the person, or the person themselves, so neither says the actor left.
  "task.assignee_departed": "recorded that the assignee left",
  "task.needs_attention": "recorded that someone left, so the task needs a new reviewer or requester",
  "task.message": "posted a message",
  "task.output_changed": "changed the expected output",
};

/** An edit to the instructions or criteria of an accepted task (decision 4). It's recorded as an offer, and no actual offer starts from `accepted`. */
const isReofferingEdit = (event: Pick<HistoryEvent, "type" | "prior_status">) => event.type === "task.offered" && event.prior_status === "accepted";

/** The API can add event types before this does. A new one reads as what it is, not as something it isn't. */
export const verbFor = (event: Pick<HistoryEvent, "type" | "prior_status">) => (isReofferingEdit(event) ? "edited the instructions or criteria, so this needs accepting again" : (VERBS[event.type] ?? "changed this task"));

/** Who wrote the brief: the last person to create or edit it. The history is the only place that carries an organization and `external` for it. */
export function briefAuthor(detail: Pick<TaskDetail, "task" | "history">) {
  // The first event creates the task, and it's `task.offered` when the task starts with an assignee. Later offers change nothing in the brief.
  const event = detail.history.findLast((entry) => entry.type === "task.updated" || isReofferingEdit(entry)) ?? detail.history[0];
  return event ? { id: event.from.id, org: event.from.org, external: event.external } : { id: detail.task.requester, org: undefined, external: false };
}

const isTerminal = (status: TaskStatus) => status === "completed" || status === "canceled";

const isAdmin = (role: string | undefined) => role === "owner" || role === "admin";

/**
 * Which controls to show. This mirrors crates/policy so people aren't offered what would fail, and it grants nothing:
 * the server decides each request again.
 */
export function viewerActions(task: Task, me: string, role: string | undefined, archived = false) {
  if (archived) return { review: false, respond: false, submit: false, setOutput: false, cancel: false, assign: false, edit: false, setReviewer: false, setRequester: false };
  const admin = isAdmin(role);
  const manages = task.requester === me || admin;
  const live = !isTerminal(task.status);
  return {
    review: task.status === "submitted" && task.reviewer === me && task.assignee !== me,
    // The assignee hands in work, whoever they are. The server decides again.
    submit: task.status === "accepted" && task.assignee === me,
    // Accept or decline an offer, which only the one it's offered to can do.
    respond: task.status === "offered" && task.assignee === me,
    // Decision 137: not once work is submitted, since a reviewer approves for the output named when it was.
    setOutput: manages && (task.status === "open" || task.status === "offered" || task.status === "accepted"),
    cancel: manages && live,
    assign: manages && (task.status === "open" || task.status === "offered"),
    edit: manages && live && task.status !== "submitted",
    // Once there's a submission to judge, a requester can't choose who judges it.
    setReviewer: live && (admin || (manages && task.status !== "submitted")),
    // Decision 24. The Coordinator's own takeover arrives with access presets in M1.
    setRequester: live && admin,
  };
}

/** Decision 22: guests don't create tasks from the dashboard. This shows a control, and the server decides again. */
export const canCreateTask = (role: string | undefined) => role === "owner" || role === "admin" || role === "member";

/** The API lists a room's owner apart from its members, so being absent from `members` doesn't mean having no role. */
export const roleOf = (room: Pick<Room, "owner" | "members">, me: string) => (room.owner === me ? "owner" : room.members?.find((member) => member.principal_id === me)?.role);

/** Everyone in the room, whether or not they could review. An owner who left stays recorded as its owner, but isn't here, and only those who manage access are told. */
const whoIsHere = (room: Pick<Room, "owner" | "members" | "owner_left_at">) => [...new Set([...(room.owner_left_at ? [] : [room.owner]), ...(room.members ?? []).map((member) => member.principal_id)])];

/** Whether a member could review, as far as this read says. Access goes only to those who manage it, so anyone else can pick someone the server then refuses. */
const canReview = (member: Member, room: Pick<Room, "require_person_review">) => {
  if (room.require_person_review && member.principal_id.startsWith("agt_")) return false;
  return !member.access || (member.access.review === "when_named" && member.access.artifacts !== "shared");
};

/** Who can be named reviewer: the owner and every member who could review, never the assignee. The server checks again. */
export const reviewerChoices = (room: Pick<Room, "owner" | "members" | "require_person_review" | "owner_left_at">, assignee: string) => [...new Set([...(room.owner_left_at ? [] : [room.owner]), ...(room.members ?? []).filter((member) => canReview(member, room)).map((member) => member.principal_id)])].filter((id) => id !== assignee);

/**
 * What a flagged task needs. The API only says that it needs something, so this looks at who has left. A guest sees only
 * itself in `members`, and a departed owner stays listed, so this can come back with neither.
 */
export function flagged(task: Pick<Task, "needs_attention" | "requester" | "reviewer">, room: Pick<Room, "owner" | "members">, role: string | undefined) {
  if (!task.needs_attention || role === "guest") return { requester: false, reviewer: false };
  const present = new Set(whoIsHere(room));
  return { requester: !present.has(task.requester), reviewer: !present.has(task.reviewer) };
}

/**
 * Who could become the reviewer or requester. Choosing the same one again is pointless, except on a flag nobody can place:
 * someone who left and came back still has the flag, and naming them again is what clears it.
 */
function choicesFor(ids: string[], current: string, task: Pick<Task, "needs_attention" | "requester" | "reviewer">, room: Pick<Room, "owner" | "members">, role: string | undefined) {
  const need = flagged(task, room, role);
  const keepCurrent = task.needs_attention && !need.requester && !need.reviewer;
  return ids.filter((id) => keepCurrent || id !== current);
}
export const newReviewerChoices = (room: Pick<Room, "owner" | "members" | "require_person_review">, task: Pick<Task, "assignee" | "requester" | "reviewer" | "needs_attention">, role: string | undefined) => choicesFor(reviewerChoices(room, task.assignee ?? ""), task.reviewer, task, room, role);
export const newRequesterChoices = (room: Pick<Room, "owner" | "members" | "owner_left_at">, task: Pick<Task, "requester" | "reviewer" | "needs_attention">, role: string | undefined) => choicesFor(whoIsHere(room), task.requester, task, room, role);

/** The flag in words, including who can fix it, because that's often not the person reading. */
export function flagText(task: Task, room: Pick<Room, "owner" | "members" | "status" | "require_person_review" | "owner_left_at">, me: string, role: string | undefined) {
  const can = viewerActions(task, me, role);
  const need = flagged(task, room, role);
  const whom = need.requester && need.reviewer ? "a new reviewer and a new requester" : need.requester ? "a new requester" : need.reviewer ? "a new reviewer" : "a new reviewer or requester";
  // A guest's read holds only itself, so it can't tell who left or why, and shouldn't be told a reason it can't know.
  const canTell = role !== undefined && role !== "guest";
  // Nobody named on it has left, so the flag came from what someone can do here, or from someone who left and came back.
  const stillHere = !need.requester && !need.reviewer;
  const reviewerIsAgent = task.reviewer.startsWith("agt_");
  const opening = !canTell
    ? "This task needs a new reviewer or requester."
    : !stillHere
      ? `Someone left this workroom, so this task needs ${whom}.`
      : room.require_person_review && reviewerIsAgent
        ? "This workroom requires a person to review, so this task needs a new reviewer."
        : "This task needs a new reviewer or requester. Its reviewer may not be able to review here any more, or someone named on it left, or left and came back.";
  if (isArchivedRoom(room)) return `${opening} It can be fixed once the workroom is back.`;
  const fixable = need.requester === need.reviewer ? can.setRequester || can.setReviewer : need.requester ? can.setRequester : can.setReviewer;
  return `${opening} ${fixable ? "You can choose below." : "An owner or admin of this workroom can fix it."}`;
}

/** What the edit form holds. Dates are in the form a date-and-time field uses, so an untouched one compares equal. */
export type TaskDraft = { title: string; instructions: string; criteria: string; due: string };

/** The viewer's own clock, which is what a date-and-time field shows. */
export function toLocalInput(at: number) {
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export const draftOf = (task: Task): TaskDraft => ({ title: task.title, instructions: task.instructions, criteria: task.acceptance_criteria ?? "", due: task.due_at === null ? "" : toLocalInput(task.due_at) });

export type TaskPatch = { title?: string; instructions?: string; acceptance_criteria?: string; due_at?: number };

/**
 * Only what changed, because Rust compares what it's sent, and resending the same words mustn't look like a change. There's no
 * way to remove a due date: the API treats a missing one as "leave it alone".
 */
export function taskPatch(task: Task, draft: TaskDraft): TaskPatch {
  const base = draftOf(task);
  const patch: TaskPatch = {};
  if (draft.title.trim() !== base.title.trim()) patch.title = draft.title.trim();
  if (draft.instructions.trim() !== base.instructions.trim()) patch.instructions = draft.instructions.trim();
  if (draft.criteria.trim() !== base.criteria.trim()) patch.acceptance_criteria = draft.criteria.trim();
  if (draft.due !== "" && draft.due !== base.due) patch.due_at = new Date(draft.due).getTime();
  return patch;
}

/** Decision 4: this edit would send accepted work back to be accepted again. Rust decides the same way, and the result says what happened. */
export const reoffers = (task: Pick<Task, "status">, patch: TaskPatch) => task.status === "accepted" && (patch.instructions !== undefined || patch.acceptance_criteria !== undefined);

/** Only what the person changed: the rest may be someone else's words, which can't show here as if they were the person's. */
export function ownWords(saved: { readAt: Task; draft: TaskDraft }) {
  const before = draftOf(saved.readAt);
  const fields: [string, string, string][] = [
    ["Title", saved.draft.title, before.title],
    ["Instructions", saved.draft.instructions, before.instructions],
    ["Acceptance criteria", saved.draft.criteria, before.criteria],
  ];
  return fields.filter(([, mine, theirs]) => mine.trim() !== theirs.trim() && mine.trim() !== "").map(([label, mine]) => ({ label, text: mine }));
}

/** Limits from crates/core, in bytes, so a form can say so before the server refuses. */
export const LIMITS = { title: 500, instructions: 64 * 1024, criteria: 16 * 1024, message: 16 * 1024 };
export const tooLong = (text: string, limit: number) => new TextEncoder().encode(text.trim()).length > limit;

/** Keeps what the person typed over what someone else just changed, without undoing changes to fields they never touched. */
export function rebaseDraft(draft: TaskDraft, readAt: Task, latest: Task): TaskDraft {
  const before = draftOf(readAt);
  const now = draftOf(latest);
  return { title: draft.title === before.title ? now.title : draft.title, instructions: draft.instructions === before.instructions ? now.instructions : draft.instructions, criteria: draft.criteria === before.criteria ? now.criteria : draft.criteria, due: draft.due === before.due ? now.due : draft.due };
}

/** What moved between two reads of a task, in words, for a person whose edit just lost a race. */
export function changedSince(readAt: Task, latest: Task) {
  const before = draftOf(readAt);
  const now = draftOf(latest);
  const changed = [before.title !== now.title && "title", before.instructions !== now.instructions && "instructions", before.criteria !== now.criteria && "acceptance criteria", before.due !== now.due && "due date", readAt.status !== latest.status && "status", readAt.assignee !== latest.assignee && "assignee", readAt.reviewer !== latest.reviewer && "reviewer", readAt.requester !== latest.requester && "requester"];
  return changed.filter((item): item is string => item !== false);
}

export type TaskChange = "edit" | "reviewer" | "requester" | "message";

const LOST: Record<TaskChange, string> = {
  edit: "We can't tell whether your edit saved. Save again without changing it: that can't apply it twice.",
  reviewer: "We can't tell whether the reviewer changed, so we read the task again. Check the reviewer above before trying again.",
  requester: "We can't tell whether the requester changed, so we read the task again. Check the requester above before trying again.",
  message: "We can't tell whether this posted. Post it again without changing it: that can't post it twice.",
};

const REFUSED: Record<TaskChange, Record<string, string>> = {
  edit: {
    invalid_argument: "A title and instructions are required, and each has a length limit.",
    not_allowed: "Only this task's requester, or an owner or admin of this workroom, can edit it.",
  },
  reviewer: {
    self_sign_off: "The reviewer can't be the person doing the work. Choose someone else, or offer the task to someone else first.",
    invalid_argument: "That person isn't in this workroom any more, or can't review here. Choose someone else.",
    not_allowed: "Only this task's requester, or an owner or admin of this workroom, can change the reviewer. Once work is submitted, only an owner or admin can.",
  },
  requester: {
    invalid_argument: "That person isn't in this workroom any more. Choose someone else.",
    not_allowed: "Only an owner or admin of this workroom can change the requester.",
  },
  message: {
    invalid_argument: "A message can't be empty, and it can be at most 16 KB.",
  },
};

/** A refusal can't rule out an earlier attempt: access and rate limits answer before the replay lookup. Its key is still good, so posting again is still safe. */
export const messageStillUnknown = (status: number) => (status === 401 ? "You've been signed out, so we still can't tell whether this posted. Copy your text, then sign in again." : "We still can't tell whether this posted. Check the thread above, and post it again without changing it: that can't post it twice.");

/** What to say when a change fails. A refusal says why, except that anything about access stays general. */
export function changeProblem(change: TaskChange, code: string, status: number) {
  if (code === "unknown" || status >= 500) return LOST[change];
  const nothingChanged = change === "message" ? "That didn't post." : "That didn't save, and nothing changed.";
  if (status === 401) return `${nothingChanged} Your session has ended. Copy anything you want to keep, then sign in again.`;
  if (status === 429) return `${nothingChanged} Too many requests, so wait a minute and try again.`;
  if (code === "workspace_archived") return `${nothingChanged} This workroom is archived, so nothing new can happen in it. Its owner or an admin can bring it back.`;
  return `${nothingChanged} ${REFUSED[change][code] ?? "You may no longer be allowed to do this."}`;
}

/** A workroom and task named together, for a Sheet that isn't on its workroom's own page. Neither ID can hold a dot. */
export const crossRoomTarget = (workspace: string, task: string) => `${workspace}.${task}`;

export function parseCrossRoomTarget(target: string) {
  const match = /^([\w-]{1,128})\.([\w-]{1,128})$/.exec(target);
  return match ? { workspace: match[1], task: match[2] } : null;
}

/**
 * A review that lost a race, because the submission changed or the task moved on, is the same to the person as a
 * version conflict: nothing was saved, and they should look at the latest before deciding again.
 */
export const asConflict = <T extends { ok: boolean; code?: string }>(result: T): T => (!result.ok && (result.code === "submission_mismatch" || result.code === "invalid_transition" || result.code === "commit_changed") ? { ...result, code: "version_conflict" } : result);

/** A lost response or a server error may have come after the task was committed. The form's key is unchanged, so sending it again returns that task. */
export const UNKNOWN_CREATE = "We can't tell whether this task was created. Send it again without changing it: that can't make a second task.";

/** What to say about a create that didn't succeed. Only a refusal or a limit means nothing happened. */
export function createProblem(status: number, code: string) {
  if (status >= 500) return UNKNOWN_CREATE;
  if (status === 429) return "That didn't save, and nothing changed. Too many requests, so wait a minute and try again.";
  const nothingChanged = "That didn't save, and nothing changed.";
  if (code === "self_sign_off") return `${nothingChanged} The reviewer and the assignee can't be the same.`;
  if (code === "invalid_argument") return `${nothingChanged} Check the fields. The title and instructions are required, and the reviewer and assignee must still be in this workroom.`;
  if (code === "limit_exceeded") return `${nothingChanged} This workroom has too many open tasks. Finish or cancel some first.`;
  if (code === "workspace_archived") return `${nothingChanged} This workroom is archived, so nothing new can happen in it. Its owner or an admin can bring it back.`;
  // Stays general, because anything more may say something about access.
  return `${nothingChanged} You may no longer be allowed to do this.`;
}
