import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";

/**
 * How a Podster task reads over A2A (ADR 0007). Inbound, the caller is a room participant and Podster only records, so the
 * A2A task is the Podster task. This only translates what the API returned: the API decided what the caller may see.
 */

export const STATUS_KEY = "podster.dev/status";
/** The task's version, which the lifecycle extension's methods send back so a change in between is caught. */
export const VERSION_KEY = "podster.dev/version";
export const AUTHOR_KEY = "podster.dev/author";
export const EXTERNAL_KEY = "podster.dev/external";
/** Set on a message the agent's own A2A endpoint reported, read back by Podster (step 13). */
export const ORIGIN_KEY = "podster.dev/origin";

/** A2A has no "in review" state, so `submitted` reads as WORKING. The real status is always in `podster.dev/status`. */
const STATE: Record<string, TaskState> = {
  open: TaskState.TASK_STATE_SUBMITTED,
  offered: TaskState.TASK_STATE_SUBMITTED,
  accepted: TaskState.TASK_STATE_WORKING,
  submitted: TaskState.TASK_STATE_WORKING,
  completed: TaskState.TASK_STATE_COMPLETED,
  canceled: TaskState.TASK_STATE_CANCELED,
};

export const stateOf = (status: string) => STATE[status] ?? TaskState.TASK_STATE_UNSPECIFIED;

/**
 * The Podster statuses an A2A state filter means. Strict: a value the SDK couldn't read (the JavaScript client sends
 * "UNRECOGNIZED" for an unset filter) is refused rather than read as "matches nothing". A real state Podster tasks never
 * have, such as FAILED, matches nothing. `null` means no filter.
 */
export function statusesFor(state: TaskState | undefined): string[] | null {
  if (state === undefined || state === TaskState.TASK_STATE_UNSPECIFIED) return null;
  if (typeof state !== "number" || state < 0 || !(state in TaskState)) throw new RequestMalformedError("Unknown task state.");
  return Object.entries(STATE).filter(([, s]) => s === state).map(([status]) => status);
}

type ApiMessage = { id: string; from?: { id?: string }; body?: string; created_at?: number; origin?: string | null };
type ApiTask = { id: string; status: string; version?: number };
type ApiHistory = { created_at?: number }[];

/** Message roles are about who's asking: the caller's own words are `ROLE_USER`, everyone else's `ROLE_AGENT`, marked external. */
function toMessage(m: ApiMessage, taskId: string, callerId: string): Message {
  const own = m.from?.id === callerId;
  return {
    messageId: m.id,
    contextId: taskId,
    taskId,
    role: own ? Role.ROLE_USER : Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: m.body ?? "" }, metadata: undefined, filename: "", mediaType: "text/markdown" } as never],
    metadata: { [AUTHOR_KEY]: m.from?.id ?? null, [EXTERNAL_KEY]: !own, ...(m.origin === "a2a_remote" ? { [ORIGIN_KEY]: m.origin } : {}) },
    extensions: [],
    referenceTaskIds: [],
  };
}

const iso = (ms: number | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/**
 * One Podster task as an A2A task. `id` and `contextId` are both `a2aId`, so a context never spans more than one task
 * (decision 116). History is the thread the API returned, newest last, cut to `historyLength`.
 */
export function toA2aTask(a2aId: string, task: ApiTask, callerId: string, opts: { messages?: ApiMessage[]; history?: ApiHistory; historyLength?: number } = {}): Task {
  const messages = opts.messages ?? [];
  const keep = opts.historyLength === undefined ? messages.length : Math.max(0, Math.min(opts.historyLength, messages.length));
  const lastChange = opts.history?.length ? opts.history[opts.history.length - 1]?.created_at : undefined;
  return {
    id: a2aId,
    contextId: a2aId,
    status: { state: stateOf(task.status), message: undefined, timestamp: iso(lastChange) },
    artifacts: [],
    history: keep > 0 ? messages.slice(-keep).map((m) => toMessage(m, a2aId, callerId)) : [],
    metadata: { [STATUS_KEY]: task.status, ...(typeof task.version === "number" ? { [VERSION_KEY]: task.version } : {}) },
  };
}
