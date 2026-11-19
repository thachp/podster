/**
 * A fresh `get_task` answer, read for the lifecycle (M7 step 8), and the prompt built from it.
 *
 * - **The task's state** is taken by its IDs, status, assignee and version only.
 * - **The prompt is built ONLY from the inputs `provenance` lists,** in its order, and a change request ONLY from the
 *   history entry whose ID is the exact `event_id` provenance names, with type `task.changes_requested` (M2 on #455's
 *   review). Nothing else the answer holds reaches it: not messages, artifact labels, files, other history or any field a
 *   hostile server adds. If an input provenance lists can't be found, there is no prompt, and nothing starts.
 * - **The prompt's bytes** are a fixed JSON form of those inputs, `{"inputs":[{"input":…,"text":…},…]}`, as UTF-8, and
 *   the run decision binds their SHA-256 (`input_hash`). The bytes are held in memory for the run's start and never
 *   stored or logged; only the hash is kept. Step 9's adapter marks them untrusted.
 *
 * The words are data. Nothing here reads them for meaning, and nothing they say changes what Runner does.
 */
import { isId } from "./state.js";

export type InputName = "title" | "instructions" | "acceptance_criteria" | "change_request";
const INPUTS: readonly string[] = ["title", "instructions", "acceptance_criteria", "change_request"];
const STATUS = /^[a-z_]{1,32}$/;

export type TaskView = { id: string; status: string; version: number; assignee: string | null };

export type Prompt = {
  /** The policy's `prompt` input: the names provenance lists, and the change request's event. */
  shape: { inputs: InputName[]; change_request_event_id: string | null };
  /** The inputs' words, for the owner's ask screen and the adapter. In memory only. */
  inputs: { input: InputName; text: string }[];
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, lower-case hex. */
  hash: string;
};

export type TaskDetail = {
  task: TaskView;
  /** `provenance` as answered, for the policy to check strictly. */
  provenance: unknown;
  /** Null when an input provenance lists can't be found in the answer. */
  prompt: Prompt | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The prompt's bytes for these inputs, in this order. */
export function promptBytes(inputs: { input: InputName; text: string }[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ inputs: inputs.map(({ input, text }) => ({ input, text })) }));
}

/** The names and change-request event provenance lists, or null when it isn't shaped as a list of inputs. */
function listed(provenance: unknown): { input: InputName; event_id: string | null }[] | null {
  if (!isObject(provenance)) return null;
  const inputs = own(provenance, "inputs");
  if (!Array.isArray(inputs) || inputs.length > INPUTS.length) return null;
  const out: { input: InputName; event_id: string | null }[] = [];
  for (const entry of inputs) {
    if (!isObject(entry)) return null;
    const name = own(entry, "input");
    if (typeof name !== "string" || !INPUTS.includes(name)) return null;
    const event = own(entry, "event_id");
    out.push({ input: name as InputName, event_id: name === "change_request" && isId(event) ? event : null });
  }
  return out;
}

/** Reads a `get_task` answer. Null when the task itself isn't shaped as one. */
export async function readTaskDetail(answer: unknown): Promise<TaskDetail | null> {
  if (!isObject(answer)) return null;
  const task = own(answer, "task");
  if (!isObject(task)) return null;
  const id = own(task, "id");
  const status = own(task, "status");
  const version = own(task, "version");
  const assignee = own(task, "assignee");
  if (!isId(id) || typeof status !== "string" || !STATUS.test(status) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
  const view: TaskView = { id, status, version, assignee: isId(assignee) ? assignee : null };
  const provenance = own(answer, "provenance");
  const names = listed(provenance);
  if (!names) return { task: view, provenance, prompt: null };

  const inputs: { input: InputName; text: string }[] = [];
  let changeRequestEvent: string | null = null;
  for (const { input, event_id } of names) {
    let text: unknown;
    if (input === "change_request") {
      if (event_id === null) return { task: view, provenance, prompt: null };
      const history = own(answer, "history");
      const entries = Array.isArray(history) ? history.filter((h) => isObject(h) && own(h, "id") === event_id) : [];
      // Exactly one entry with that ID, of the right type: anything else is no prompt.
      if (entries.length !== 1 || own(entries[0], "type") !== "task.changes_requested") return { task: view, provenance, prompt: null };
      text = own(entries[0], "reason");
      changeRequestEvent = event_id;
    } else {
      text = own(task, input);
    }
    if (typeof text !== "string") return { task: view, provenance, prompt: null };
    inputs.push({ input, text });
  }
  const bytes = promptBytes(inputs);
  return {
    task: view,
    provenance,
    prompt: { shape: { inputs: names.map((n) => n.input), change_request_event_id: changeRequestEvent }, inputs, bytes, hash: await sha256Hex(bytes) },
  };
}
