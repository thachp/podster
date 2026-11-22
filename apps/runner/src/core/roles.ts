/**
 * Role invites (issue 522): Runner answers an invite to a role opening as its own agent, through its ordinary inbox, under
 * the owner's local policy. No other client and no other credential is involved.
 *
 * - **Found through the inbox.** `role.invited` names only the room. The reducer records that room (`record.ts`) in the
 *   same save as the cursor, and a reconciliation records every room it lists, so an invite is never acknowledged
 *   unrecorded and one made while Runner was off is still found. Each room is then read with `list_role_openings`, whose
 *   `mine: "invited"` is Podster's own answer about this agent; Runner takes only the opening's ID from it to act on.
 * - **The owner's policy decides.** A room the owner set to `roles: "accept"` in Runner's local policy has its invites
 *   claimed with no question. Anywhere else, the default, Runner asks the owner on this machine, as it does for a task in
 *   ask mode. Silence is never an answer: no prompter, no terminal or no reply leaves the invite waiting, asked again
 *   later. Runner never declines by itself; only the owner's answer does.
 * - **Podster decides authority.** `claim_role` and `decline_role` are the agent's own calls, and the room checks each:
 *   only the invite naming this agent can be claimed or declined, and a claim copies only the opening's preset. A claim
 *   accepts no task and a decline declines none; neither grants a person anything.
 * - **Agent content is data.** An opening's title and responsibilities are someone else's text. They go only to the
 *   owner's screen, marked as untrusted, never to a model, a log or Runner's record.
 * - **An older pairing.** A pairing registered before these capabilities were Runner's doesn't hold them, and calling one
 *   would read as an authority error. Runner checks its stored grants first and, missing any, leaves invites alone and
 *   says once that pairing again enables this.
 */
import { GatewayError, meaningOf } from "./errors.js";
import type { OwnerAnswer } from "./lifecycle.js";
import { parsePolicyConfig } from "./policy.js";
import { AuthorityEnded } from "./poller.js";
import type { Clock, Logger } from "./runtime.js";
import { isId, type RoleAnswer, type RunnerState } from "./state.js";

/** The capabilities answering an invite needs, all of them. */
export const ROLE_CAPABILITIES = ["list_role_openings", "claim_role", "decline_role"] as const;
/** How long an invite the owner left waits before it's asked again. */
export const ROLE_ASK_AGAIN_MS = 10 * 60 * 1000;
/** Rooms read in one pass. The rest wait for the next. */
export const ROOMS_PER_PASS = 10;

/** What the owner sees of an invite. `title` and `responsibilities` are untrusted text: shown, never stored or logged. */
export type RoleView = {
  workspace_id: string;
  role_id: string;
  title: string;
  responsibilities: string;
  /** The access preset a claim copies, as Podster names it, or `unknown`. */
  preset: string;
  is_lead: boolean;
  /** The room is another organization's. */
  external: boolean;
};

/** Asks the owner about an invite. `approve` claims it, `decline` turns it down, `later` leaves it. */
export interface RolePrompter {
  role?(view: RoleView, signal?: AbortSignal): Promise<OwnerAnswer>;
}

export type RolePoller = {
  readonly agentId: string;
  readonly record: RunnerState;
  authorityFresh(): boolean;
  request(capability: "list_role_openings" | "claim_role" | "decline_role", args: Record<string, unknown>): Promise<unknown>;
  granted(): Promise<ReadonlySet<string>>;
  updateRecord(change: (state: RunnerState) => RunnerState): Promise<void>;
};

export type RoleDeps = {
  poller: RolePoller;
  /** The owner's run policy, read afresh on each pass. One Runner can't read gives every room the default, `ask`. */
  config: unknown | (() => unknown | Promise<unknown>);
  home?: string;
  prompter: RolePrompter;
  clock: Clock;
  log: Logger;
  newId?: () => string;
};

const PRESET = /^[a-z_]{1,32}$/;
const answerKey = (workspace: string, role: string) => `${workspace}/${role}`;

/** The invites to this agent a `list_role_openings` answer shows, read for their shape. Null for an answer that isn't one. */
export function readInvites(workspaceId: string, answer: unknown): { invited: RoleView[]; listed: Set<string> } | null {
  if (!answer || typeof answer !== "object") return null;
  const { roles, external } = answer as Record<string, unknown>;
  if (!Array.isArray(roles)) return null;
  const invited: RoleView[] = [];
  const listed = new Set<string>();
  for (const row of roles) {
    if (!row || typeof row !== "object") continue;
    const { id, mine, title, responsibilities, preset, is_lead } = row as Record<string, unknown>;
    if (!isId(id)) continue;
    listed.add(id);
    if (mine !== "invited") continue;
    invited.push({
      workspace_id: workspaceId,
      role_id: id,
      title: typeof title === "string" ? title : "",
      responsibilities: typeof responsibilities === "string" ? responsibilities : "",
      preset: typeof preset === "string" && PRESET.test(preset) ? preset : "unknown",
      is_lead: is_lead === true,
      external: external === true,
    });
  }
  return { invited, listed };
}

/** The owner's choice for invites in a room: `accept` only where the local policy says so for that room. */
export function roleMode(config: unknown, workspaceId: string, home?: string): "ask" | "accept" {
  const parsed = parsePolicyConfig(config, home === undefined ? {} : { runner_home: home });
  if (!parsed.ok) return "ask";
  return parsed.value.rooms.find((room) => room.room_id === workspaceId)?.roles ?? "ask";
}

export class RoleInvites {
  private readonly deps: RoleDeps;
  private readonly newId: () => string;
  private toldMissing = false;

  constructor(deps: RoleDeps) {
    this.deps = deps;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  private now() {
    return this.deps.clock.now();
  }

  private log(outcome: string, workspace: string, code?: string) {
    this.deps.log("roles.invite", outcome, { agent: this.deps.poller.agentId, workspace, ...(code ? { code } : {}) });
  }

  private async readConfig(): Promise<unknown> {
    try {
      const config = this.deps.config;
      return typeof config === "function" ? await (config as () => unknown)() : config;
    } catch {
      return null;
    }
  }

  private async setAnswer(key: string, answer: RoleAnswer | null) {
    await this.deps.poller.updateRecord((state) => {
      const answers = { ...(state.role_answers ?? {}) };
      if (answer) answers[key] = { ...answer, updated_at: this.now() };
      else delete answers[key];
      return { ...state, role_answers: answers };
    });
  }

  private async settleCheck(workspace: string) {
    await this.deps.poller.updateRecord((state) => {
      const known = state.role_checks?.[workspace];
      if (!known) return state;
      return { ...state, role_checks: { ...state.role_checks, [workspace]: { ...known, due: false, updated_at: this.now() } } };
    });
  }

  /** Rooms with something to do now: a check due, a command owed, or an invite the owner left whose wait is over. */
  private work(): { rooms: string[]; owed: RoleAnswer[] } {
    const record = this.deps.poller.record;
    const answers = Object.values(record.role_answers ?? {});
    const owed = answers.filter((a) => a.state === "claiming" || a.state === "declining");
    const rooms = new Set(Object.values(record.role_checks ?? {}).filter((c) => c.due).sort((a, b) => a.updated_at - b.updated_at).map((c) => c.workspace_id));
    for (const a of answers) if (a.state === "later" && (a.asked_at === null || this.now() - a.asked_at >= ROLE_ASK_AGAIN_MS)) rooms.add(a.workspace_id);
    return { rooms: [...rooms].slice(0, ROOMS_PER_PASS), owed };
  }

  /**
   * One pass: owed claims and declines first, with their stored keys, then each room due a read. An authority error
   * throws `AuthorityEnded` for the lifecycle to handle. A network failure leaves everything as it is, for the next pass.
   */
  async pass(signal: AbortSignal): Promise<void> {
    const { rooms, owed } = this.work();
    if (rooms.length === 0 && owed.length === 0) return;
    if (!this.deps.poller.authorityFresh()) return;
    const granted = await this.deps.poller.granted();
    if (!ROLE_CAPABILITIES.every((c) => granted.has(c))) {
      if (!this.toldMissing) this.deps.log("roles.invite", "unavailable", { agent: this.deps.poller.agentId, code: "pair_again_for_roles" });
      this.toldMissing = true;
      return;
    }
    try {
      for (const answer of owed) {
        if (signal.aborted) return;
        await this.send(answer);
      }
      for (const room of rooms) {
        if (signal.aborted) return;
        await this.room(room, signal);
      }
    } catch (error) {
      if (error instanceof AuthorityEnded) throw error;
      if (signal.aborted) return;
      const failure = error instanceof GatewayError ? error : new GatewayError(0, "unknown");
      this.deps.log("roles.invite", "unreachable", { agent: this.deps.poller.agentId, status: failure.status, code: failure.code });
    }
  }

  /** Reads one room's openings and answers each invite to this agent. */
  private async room(workspace: string, signal: AbortSignal) {
    let answer: unknown;
    try {
      answer = await this.deps.poller.request("list_role_openings", { workspace_id: workspace });
    } catch (error) {
      if (error instanceof GatewayError && meaningOf(error) === "refused") {
        // A room this agent can no longer read: nothing to answer there.
        this.log("room_unreadable", workspace, error.code);
        await this.forgetRoom(workspace, new Set());
        await this.settleCheck(workspace);
        return;
      }
      throw error;
    }
    const read = readInvites(workspace, answer);
    if (!read) throw new GatewayError(0, "bad_answer");
    // An answer whose invite the room no longer lists is done with: claimed, declined, withdrawn or closed.
    await this.forgetRoom(workspace, new Set(read.invited.map((i) => i.role_id)));
    const config = await this.readConfig();
    for (const invite of read.invited) {
      if (signal.aborted) return;
      const key = answerKey(workspace, invite.role_id);
      const known = this.deps.poller.record.role_answers?.[key];
      if (known?.state === "refused" || known?.state === "claiming" || known?.state === "declining") continue;
      if (known?.state === "later" && known.asked_at !== null && this.now() - known.asked_at < ROLE_ASK_AGAIN_MS) continue;
      this.log("found", workspace);
      const mode = roleMode(config, workspace, this.deps.home);
      let choice: OwnerAnswer;
      if (mode === "accept") choice = "approve";
      else {
        choice = this.deps.prompter.role ? await this.deps.prompter.role(invite, signal).catch(() => "later" as const) : "later";
        if (signal.aborted) return;
      }
      if (choice === "later") {
        await this.setAnswer(key, { workspace_id: workspace, role_id: invite.role_id, state: "later", key: null, code: null, asked_at: this.now(), updated_at: this.now() });
        this.log("waiting_for_owner", workspace);
        continue;
      }
      const pending: RoleAnswer = { workspace_id: workspace, role_id: invite.role_id, state: choice === "approve" ? "claiming" : "declining", key: this.newId(), code: null, asked_at: this.now(), updated_at: this.now() };
      // Stored before it's sent, so a lost answer is asked again with the same key.
      await this.setAnswer(key, pending);
      this.log(mode === "accept" ? "accepting_by_policy" : choice === "approve" ? "accepting_by_owner" : "declining_by_owner", workspace);
      await this.send(pending);
    }
    await this.settleCheck(workspace);
  }

  /** Drops this room's settled answers whose invite isn't listed now. One under way is kept until it's sent. */
  private async forgetRoom(workspace: string, stillInvited: Set<string>) {
    const stale = Object.entries(this.deps.poller.record.role_answers ?? {}).filter(([, a]) => a.workspace_id === workspace && !stillInvited.has(a.role_id) && a.state !== "claiming" && a.state !== "declining");
    for (const [key] of stale) await this.setAnswer(key, null);
  }

  /** Sends a claim or a decline with its stored key. A refusal is recorded and not tried again for this invite. */
  private async send(answer: RoleAnswer) {
    const key = answerKey(answer.workspace_id, answer.role_id);
    const capability = answer.state === "claiming" ? "claim_role" : "decline_role";
    try {
      await this.deps.poller.request(capability, { workspace_id: answer.workspace_id, role_id: answer.role_id, idempotency_key: answer.key });
    } catch (error) {
      if (error instanceof GatewayError && meaningOf(error) === "refused") {
        await this.setAnswer(key, { ...answer, state: "refused", key: null, code: error.code });
        this.log(capability === "claim_role" ? "claim_refused" : "decline_refused", answer.workspace_id, error.code);
        return;
      }
      throw error;
    }
    await this.setAnswer(key, null);
    this.log(capability === "claim_role" ? "claimed" : "declined", answer.workspace_id);
  }
}
