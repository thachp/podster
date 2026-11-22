/**
 * Runner's local record: what it knows about its pairing and its work, outside any task's reach. It holds IDs, states,
 * sequence numbers and times only: never a key (those are in the key store), a code, a token, or any task text.
 *
 * It is saved whole on every change, and the node store (`src/node/file-state.ts`) writes it so that a crash leaves
 * either the old record or the new one, never a mix.
 */

/** Where a pairing has got to. Each step is recorded before the next starts. */
export type Phase =
  /** A key was made for this pairing and stored; redeeming may be tried (again) with it. */
  | "key_made"
  /** The gateway bound the key to the pairing's host. */
  | "redeemed"
  /** Registering the one agent was sent. If it's still this on a restart, the answer was lost: Runner never registers again. */
  | "registering"
  /** The one agent is registered; waiting for its person to confirm in Podster. */
  | "registered"
  /** Confirmed: Runner acts as the Podster agent. */
  | "connected";

/** Why Runner stopped, needing the owner: it never resumes or registers again by itself. */
export type Stop =
  /** The pairing was canceled, refused or ended before it was confirmed. Its key is retired; pair again from Podster. */
  | "pairing_ended"
  /** The agent was revoked or disconnected, or its credential ended. The owner reconnects it in Podster and pairs again. */
  | "revoked"
  /** Registration's answer was lost, so Runner can't know whether an agent exists. Cancel in Podster and pair again. */
  | "registration_unknown";

/** An offer Runner has recorded, by IDs. What the task says is never kept here. */
export type Offer = {
  workspace_id: string;
  task_id: string;
  /** How Runner learned of it: its inbox, or reconciliation with `list_tasks`. */
  source: "inbox" | "reconcile";
  /** The inbox sequence it came with, if it came from the inbox. */
  seq: number | null;
  /** The latest event type seen for the task, such as `task.offered` or `task.canceled`, or the task's status from a list. */
  last: string;
  /** The task's version as last listed, when reconciliation saw it. */
  version: number | null;
  recorded_at: number;
  updated_at: number;
};

/**
 * A room whose inbox told Runner of a role invite (`role.invited`), or that a reconciliation listed, to be read with
 * `list_role_openings` (issue 522). The inbox event names only the room, so the opening is learned from that read. IDs only.
 */
export type RoleCheck = {
  workspace_id: string;
  /** The inbox sequence it came with, or null from a reconciliation. */
  seq: number | null;
  /** Whether the room's openings still need reading. */
  due: boolean;
  recorded_at: number;
  updated_at: number;
};

/**
 * Runner's answer to one invite, by IDs, recorded before anything is sent (issue 522). A claim or decline under way keeps
 * its idempotency key, so a lost answer is asked again with the same key. Forgotten once the room no longer lists the invite.
 */
export type RoleAnswer = {
  workspace_id: string;
  role_id: string;
  /**
   * `claiming` or `declining`: sent, or about to be, with `key`. `later`: the owner left it, asked again after a wait.
   * `refused`: Podster refused the claim or decline, with `code`; not tried again while the same invite stands.
   */
  state: "claiming" | "declining" | "later" | "refused";
  key: string | null;
  code: string | null;
  asked_at: number | null;
  updated_at: number;
};

export type RunnerState = {
  version: 1;
  /** The gateway's origin. */
  gateway: string | null;
  /** The Podster agent this Runner is paired as. */
  agent_id: string | null;
  /** The thumbprint of the key the current pairing uses. */
  thumbprint: string | null;
  phase: Phase | null;
  plugin_host_id: string | null;
  /** The plugin agent Runner registered on the host, its credential's subject. */
  plugin_agent_id: string | null;
  stopped: Stop | null;
  /** Thumbprints of keys whose pairing was canceled, refused or ended. Never used again. */
  retired: string[];
  /** The newest inbox sequence recorded here. Acknowledged to Podster only after it's saved. */
  inbox_cursor: number;
  /** Offers, keyed `workspace/task`. */
  offers: Record<string, Offer>;
  /** Rooms to read for role invites, keyed by room. Missing in a record from before issue 522. */
  role_checks?: Record<string, RoleCheck>;
  /** Answers to role invites, keyed `workspace/role`. Missing in a record from before issue 522. */
  role_answers?: Record<string, RoleAnswer>;
  /** The last time a call to the gateway was answered, in milliseconds. */
  last_contact_at: number | null;
  reconciled_at: number | null;
};

export const emptyState = (): RunnerState => ({
  version: 1,
  gateway: null,
  agent_id: null,
  thumbprint: null,
  phase: null,
  plugin_host_id: null,
  plugin_agent_id: null,
  stopped: null,
  retired: [],
  inbox_cursor: 0,
  offers: {},
  role_checks: {},
  role_answers: {},
  last_contact_at: null,
  reconciled_at: null,
});

/** Saves Runner's record durably, and reads it back. */
export interface StateStore {
  load(): Promise<RunnerState>;
  save(state: RunnerState): Promise<void>;
}

/** For tests only: the record in memory, copied on each save and load so nothing shares it. */
export class MemoryStateStore implements StateStore {
  private saved: string = JSON.stringify(emptyState());
  saves = 0;
  /** Set to make the next saves fail, as a full disk would. */
  failSaves = false;
  async load() {
    return JSON.parse(this.saved) as RunnerState;
  }
  async save(state: RunnerState) {
    if (this.failSaves) throw new Error("save failed");
    this.saved = JSON.stringify(state);
    this.saves++;
  }
}

/** IDs as the gateway gives them. Anything else in an ID's place is refused, so it never reaches a record or a log. */
export const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
