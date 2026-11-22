/**
 * Room changes after setup (issue 523, the owner's clarification): while `run` goes on, Runner reads each room in the
 * owner's policy again now and then, and compares Podster's facts with the room's entry (`setup.ts`).
 *
 * - **Every change waits for the owner.** A repository Podster now names for a room, or names differently, is shown at
 *   this terminal with what the room keeps, and written only on a typed `y`. The answer is tied to exactly what was shown: it's used only if, on a
 *   fresh read, Podster still says the same and the policy file is still the text it was asked about. Anything else sets
 *   the answer aside and asks again. A `no` holds until Podster's facts change again or Runner restarts; no terminal, or
 *   no answer, writes nothing.
 * - **Unknown is "ask later", never "none".** Podster names a room's repository only while this agent holds a live push
 *   grant on it, and its organization only where the agent could already see it. A part it leaves out is unknown, and
 *   Runner never removes or narrows anything on it: a repository the room no longer links is refused by
 *   `get_repo_access`, and the owner edits the entry.
 * - **Nothing else moves.** Only that room's `repository` and the policy's `revision` change; every other limit and
 *   permission the owner wrote stays. Podster's facts are data: checked IDs and a checked GitHub name, never text to act
 *   on, and never a source for `mode`, `allowed_orgs`, tools, network or acknowledgments.
 * - **A write that races is never silent.** The file is written only while it still holds the text the question was
 *   about, and read back after; if it holds anything else then, the owner is told and asked again on a later pass.
 * - **Unknown isn't a change.** A room Podster won't describe to this agent, or describes in a way that doesn't check out,
 *   is left as the owner wrote it.
 * - **A question never holds up task work.** As with role invites (issue 528), the answer is waited for off the poll loop,
 *   one question at a time, and set aside (`QuestionInterrupted`) when a task needs the terminal.
 */
import { GatewayError, meaningOf } from "./errors.js";
import type { OwnerAnswer } from "./lifecycle.js";
import { parsePolicyConfig, type RoomPolicy } from "./policy.js";
import { AuthorityEnded } from "./poller.js";
import { QuestionInterrupted } from "./roles.js";
import type { Clock, Logger } from "./runtime.js";
import { applyRoomChange, changeKey, readRoomFacts, roomChange, type RoomChange } from "./setup.js";

/** How often each room's facts are read again. */
export const ROOM_CHECK_MS = 10 * 60 * 1000;
/** How long a change the owner left unanswered waits before it's asked again. */
export const ROOM_ASK_AGAIN_MS = 10 * 60 * 1000;
/** How soon a question set aside, or ended by a newer change, is asked again. */
export const ROOM_RETRY_MS = 60 * 1000;
/** Rooms read in one pass; the rest wait for the next. */
export const ROOM_CHECKS_PER_PASS = 10;

export type RoomChangeView = { change: RoomChange; room: RoomPolicy };

/** Asks the owner about a change. Rejects with `QuestionInterrupted` when set aside. */
export interface RoomChangePrompter {
  roomChange?(view: RoomChangeView, signal?: AbortSignal): Promise<OwnerAnswer>;
  /** Tells the owner, in fixed words, that a write raced another change to the file and wasn't kept as theirs. */
  policyRaced?(path: string): void;
}

/**
 * How a guarded write ended. `written`: the file held `expected` and now holds the new text, read back. `changed`: it
 * didn't hold `expected`, so nothing was written. `raced`: it held `expected` when checked, but read back after the write
 * it holds something else, because another writer got in between; the owner must look.
 */
export type WriteOutcome = "written" | "changed" | "raced";

/** The policy file: its text now (null when there's none), and a write that happens only if the text is still `expected`. */
export type PolicyText = {
  readonly path?: string;
  read(): Promise<string | null>;
  write(text: string, expected: string | null): Promise<WriteOutcome>;
};

export type RoomFactsDeps = {
  poller: { readonly agentId: string; authorityFresh(): boolean; request(capability: "get_workspace", args: Record<string, unknown>): Promise<unknown> };
  policy: PolicyText;
  home: string;
  prompter: RoomChangePrompter;
  clock: Clock;
  log: Logger;
  /** Ends the poll loop's wait early once the owner answers. */
  wake?: () => void;
};

type Heard = { key: string; text: string; choice: OwnerAnswer };

export class RoomFacts {
  private readonly deps: RoomFactsDeps;
  private nextCheckAt = 0;
  /** Where the last pass stopped in the list of rooms, so every room gets its turn. */
  private cursor = 0;
  private asking: { room: string; key: string; controller: AbortController } | null = null;
  private readonly heard = new Map<string, Heard>();
  /** Changes the owner turned down, by room: not asked again until Podster says something else. In memory only. */
  private readonly declined = new Map<string, string>();
  /** When each room's change was left unanswered, by change key. */
  private readonly later = new Map<string, number>();

  constructor(deps: RoomFactsDeps) {
    this.deps = deps;
  }

  private log(outcome: string, workspace: string, code?: string) {
    this.deps.log("rooms.facts", outcome, { agent: this.deps.poller.agentId, workspace, ...(code ? { code } : {}) });
  }

  /**
   * One pass, when one is due or an owner's answer is waiting: each room in the policy, up to a bound, read again and
   * compared. An authority error throws `AuthorityEnded`; a network failure leaves everything for the next pass.
   */
  async pass(signal: AbortSignal): Promise<void> {
    const now = this.deps.clock.now();
    if (now < this.nextCheckAt && this.heard.size === 0) return;
    if (!this.deps.poller.authorityFresh()) return;
    const text = await this.readText();
    if (text === null) return;
    const parsed = parsePolicyConfig(safeJson(text), { runner_home: this.deps.home });
    if (!parsed.ok) return;
    const rooms = parsed.value.rooms;
    if (rooms.length === 0) return;
    // An answer waiting is for one room: that room is read now, whether or not a full pass is due.
    const due = now >= this.nextCheckAt;
    let chosen: RoomPolicy[];
    if (due) {
      this.nextCheckAt = now + ROOM_CHECK_MS;
      const start = this.cursor % rooms.length;
      chosen = [...rooms.slice(start), ...rooms.slice(0, start)].slice(0, ROOM_CHECKS_PER_PASS);
      this.cursor = start + chosen.length;
    } else {
      chosen = rooms.filter((r) => this.heard.has(r.room_id));
    }
    try {
      for (const room of chosen) {
        if (signal.aborted) return;
        await this.room(room, signal);
      }
    } catch (error) {
      if (error instanceof AuthorityEnded) throw error;
      if (signal.aborted) return;
      const failure = error instanceof GatewayError ? error : new GatewayError(0, "unknown");
      this.deps.log("rooms.facts", "unreachable", { agent: this.deps.poller.agentId, status: failure.status, code: failure.code });
    }
  }

  private async readText(): Promise<string | null> {
    try {
      return await this.deps.policy.read();
    } catch {
      return null;
    }
  }

  private async room(room: RoomPolicy, signal: AbortSignal) {
    const workspace = room.room_id;
    let answer: unknown;
    try {
      answer = await this.deps.poller.request("get_workspace", { workspace_id: workspace });
    } catch (error) {
      if (error instanceof GatewayError && meaningOf(error) === "refused") {
        this.heard.delete(workspace);
        this.log("room_unreadable", workspace, error.code);
        return;
      }
      throw error;
    }
    const read = readRoomFacts(workspace, answer);
    if (!read.ok) {
      this.heard.delete(workspace);
      this.log("facts_unknown", workspace, read.problem);
      return;
    }
    const change = roomChange(room, read.facts);
    const heard = this.heard.get(workspace);
    this.heard.delete(workspace);
    if (change === null) {
      this.declined.delete(workspace);
      if (this.asking?.room === workspace) this.asking.controller.abort();
      return;
    }
    const key = changeKey(change);
    // The policy as it is now: an answer counts only for the text it was asked about.
    const text = await this.readText();
    if (text === null) return;
    if (heard && heard.key === key && heard.text === text) {
      if (heard.choice === "approve") {
        await this.write(change, room, text, "widened_by_owner");
        return;
      }
      if (heard.choice === "decline") {
        this.declined.set(workspace, key);
        this.log("declined_by_owner", workspace, change.kind);
        return;
      }
      this.later.set(key, this.deps.clock.now());
      this.log("waiting_for_owner", workspace, change.kind);
      return;
    }
    if (heard) this.log("answer_set_aside", workspace, change.kind);
    if (this.declined.get(workspace) === key) return;
    if (this.asking) {
      // Asked about something that has changed since: ended, and asked again afresh.
      if (this.asking.room === workspace && this.asking.key !== key) this.asking.controller.abort();
      return;
    }
    const left = this.later.get(key);
    if (left !== undefined && this.deps.clock.now() - left < ROOM_ASK_AGAIN_MS) return;
    if (!this.deps.prompter.roomChange) {
      this.log("waiting_for_owner", workspace, change.kind);
      this.later.set(key, this.deps.clock.now());
      return;
    }
    this.ask(workspace, key, text, { change, room }, signal);
    this.log("asking_owner", workspace, change.kind);
  }

  private async write(change: RoomChange, room: RoomPolicy, text: string, outcome: string) {
    const next = applyRoomChange(text, change, this.deps.home);
    const written = next === null ? "changed" : await this.deps.policy.write(next.text, text);
    if (written === "changed") {
      // The owner edited the file meanwhile: nothing written, and read again next time.
      this.log("policy_changed_meanwhile", room.room_id, change.kind);
      return;
    }
    if (written === "raced") {
      // Something else wrote the file as Runner did: the owner is told, and the room is read and asked about again.
      this.log("policy_write_raced", room.room_id, change.kind);
      this.deps.prompter.policyRaced?.(this.deps.policy.path ?? "policy.json");
      this.nextCheckAt = Math.min(this.nextCheckAt, this.deps.clock.now() + ROOM_RETRY_MS);
      return;
    }
    this.later.delete(changeKey(change));
    this.log(outcome, room.room_id, change.kind);
  }

  private ask(workspace: string, key: string, text: string, view: RoomChangeView, signal: AbortSignal) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    const asking = { room: workspace, key, controller };
    this.asking = asking;
    const question = (async () => (this.deps.prompter.roomChange as NonNullable<RoomChangePrompter["roomChange"]>).call(this.deps.prompter, view, controller.signal))();
    void question
      .then(
        (choice) => choice,
        (error) => (error instanceof QuestionInterrupted ? null : ("later" as const)),
      )
      .then((choice) => {
        signal.removeEventListener("abort", stop);
        if (this.asking === asking) this.asking = null;
        if (choice !== null && !controller.signal.aborted) this.heard.set(workspace, { key, text, choice });
        // Set aside, or ended because Podster said something else: the rooms are read again soon.
        else this.nextCheckAt = Math.min(this.nextCheckAt, this.deps.clock.now() + ROOM_RETRY_MS);
        this.deps.wake?.();
      });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
