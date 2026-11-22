/**
 * `setup` (issue 523): a starter run policy from a workroom's settings, previewed and saved only on the owner's typed yes.
 *
 * Runner reads, as its paired agent, who it is (`get_identity`: `owner_org` is that organization, never the room's) and
 * the chosen room (`get_workspace`'s `setup`: the room's organization and linked repository). It shows the proposal and
 * what it allows, and writes `policy.json` only after `y` or `yes` at a terminal. It never replaces a policy: a room the
 * policy lacks is added to it with everything else kept; a room it has is checked for a repository change, as `run`
 * does; a file Runner can't use, or one for another organization, is explained and left alone. Facts Podster won't give,
 * or gives in a form that doesn't check out, are explained, never guessed. Nothing here turns on unattended runs, ticks
 * an acknowledgment or allows another organization without the owner's own yes to exactly that.
 *
 * A room's name is someone else's text: shown only when the owner picks a room from the list, marked as untrusted, and
 * never written anywhere.
 */
import { join } from "node:path";
import { GatewayError, meaningOf } from "../core/errors.js";
import { isPolicyId, type RoomPolicy } from "../core/policy.js";
import type { PolicyText } from "../core/room-facts.js";
import { applyRoomChange, changeScreen, factsProblemText, isExternal, planSetup, previewScreen, readRoomFacts, roomChange, widens, type RoomFacts } from "../core/setup.js";
import { POLICY_FILE } from "./policy-file.js";
import { fenced, type Terminal } from "./prompter.js";

export type SetupDeps = {
  home: string;
  poller: { readonly agentId: string; request(capability: "get_identity" | "list_workspaces" | "get_workspace", args?: Record<string, unknown>): Promise<unknown> };
  policy: PolicyText;
  terminal: Terminal;
  /** The room the owner named with `--room`, if any. */
  room?: string;
  /** For a new policy only. */
  workspace_root: string;
  say: (line: string) => void;
};

/** The most rooms listed to pick from. */
const LISTED = 50;
const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());

export async function runSetup(deps: SetupDeps): Promise<number> {
  const { terminal, say } = deps;
  const atTerminal = terminal.inputIsTTY && terminal.outputIsTTY;
  const path = join(deps.home, POLICY_FILE);

  const identity = (await deps.poller.request("get_identity")) as Record<string, unknown> | null;
  if (identity?.id !== deps.poller.agentId) {
    say("Podster didn't answer as this Runner's agent, so nothing was proposed.");
    return 1;
  }
  const ownerOrg = identity?.org_id;
  if (!isPolicyId(ownerOrg)) {
    say("This agent's organization ID can't be written in a run policy (it must be lower case), so nothing was proposed.");
    return 1;
  }

  let room = deps.room;
  if (room === undefined) {
    if (!atTerminal) {
      say("Name the room with --room <ws_…>: without a terminal Runner can't ask which.");
      return 2;
    }
    const picked = await pickRoom(deps);
    if (picked === null) return 1;
    room = picked;
  }
  if (!isPolicyId(room)) {
    say("A room's ID is lower-case letters, digits, _ and -, such as ws_… from its address in the web app.");
    return 2;
  }

  let answer: unknown;
  try {
    answer = await deps.poller.request("get_workspace", { workspace_id: room });
  } catch (error) {
    if (error instanceof GatewayError && meaningOf(error) === "refused") {
      say(`Podster won't show room ${room} to this agent (${error.code}). Add the agent to the room first, then run setup again. Nothing was changed.`);
      return 1;
    }
    throw error;
  }
  const read = readRoomFacts(room, answer);
  if (!read.ok) {
    say(`${factsProblemText(read.problem)} Nothing was changed.`);
    return 1;
  }
  const facts = read.facts;
  const existing = await deps.policy.read();

  // The owner's own yes, before anything is proposed, for another organization's room.
  let allowRoomOrg = false;
  const plan0 = planSetup({ existing, owner_org: ownerOrg, facts, workspace_root: deps.workspace_root, allow_room_org: false, runner_home: deps.home });
  if (plan0.kind === "refuse") return refuse(say, plan0.reason, plan0.detail, path);
  if (plan0.kind === "room_present") return await refreshRoom(deps, facts, plan0.room, existing as string, path);
  if (isExternal(facts, ownerOrg)) {
    say("");
    say(`Room ${facts.room_id} belongs to another organization, ${facts.org_id}. Runner refuses its tasks unless you allow that organization for this room: asking before each run doesn't allow it by itself.`);
    if (atTerminal) allowRoomOrg = yes(await terminal.question(`Allow tasks from ${facts.org_id} in this room? [y/N] `));
  }
  const plan = planSetup({ existing, owner_org: ownerOrg, facts, workspace_root: deps.workspace_root, allow_room_org: allowRoomOrg, runner_home: deps.home });
  if (plan.kind === "refuse") return refuse(say, plan.reason, plan.detail, path);
  if (plan.kind === "room_present") return await refreshRoom(deps, facts, plan.room, existing as string, path);
  say(previewScreen(plan, facts, ownerOrg, path));
  if (!atTerminal) {
    say("Only a typed yes at a terminal saves a policy, so nothing was saved.");
    return 1;
  }
  if (!yes(await terminal.question(`Save it to ${path}? [y/N] `))) {
    say("Nothing was saved. Your policy is as it was.");
    return 1;
  }
  if (!(await deps.policy.write(plan.text, existing))) {
    say(`${path} changed while you were reading, so nothing was saved. Run setup again.`);
    return 1;
  }
  say(`Saved ${path}. Unattended runs stay off. Start Runner with \`run\`.`);
  return 0;
}

function refuse(say: (line: string) => void, reason: string, detail: string, path: string): number {
  if (reason === "existing_invalid") say(`Your run policy at ${path} can't be used (${detail}). Runner won't replace it: fix it, or move it away, then run setup again. Nothing was changed.`);
  else if (reason === "owner_org_mismatch") say(`Your run policy at ${path} is for another organization (${detail}). Runner won't change it. Nothing was changed.`);
  else say(`Runner couldn't make a policy it would load (${detail}). Nothing was saved. If it's the workspace root, choose another with --workspace-root <folder>.`);
  return 1;
}

/** A room the policy already has: its repository compared with Podster's, as `run` does. */
async function refreshRoom(deps: SetupDeps, facts: RoomFacts, room: RoomPolicy, existing: string, path: string): Promise<number> {
  const { say, terminal } = deps;
  const change = roomChange(room, facts);
  if (change === null) {
    say(`Room ${facts.room_id} is already in your run policy, and its repository matches Podster's. Nothing was changed.`);
    return 0;
  }
  const next = applyRoomChange(existing, change, deps.home);
  if (next === null) {
    say("Runner couldn't apply the change to your policy. Nothing was changed.");
    return 1;
  }
  say(changeScreen(change, room).replace("this takes access away, so Runner has already written it", "this takes access away, so Runner writes it now"));
  if (widens(change)) {
    if (!(terminal.inputIsTTY && terminal.outputIsTTY) || !yes(await terminal.question("Update this room's repository in Runner's policy? [y/N] "))) {
      say("Nothing was saved. Your policy is as it was.");
      return 1;
    }
  }
  if (!(await deps.policy.write(next.text, existing))) {
    say(`${path} changed while you were reading, so nothing was saved. Run setup again.`);
    return 1;
  }
  say(`Saved ${path}.`);
  return 0;
}

/** Lists the agent's rooms and asks for one by number. Names are someone else's words, marked as untrusted. */
async function pickRoom(deps: SetupDeps): Promise<string | null> {
  const { say, terminal } = deps;
  const listed = (await deps.poller.request("list_workspaces")) as { workspaces?: unknown } | null;
  const rooms = (Array.isArray(listed?.workspaces) ? listed.workspaces : [])
    .filter((w): w is { workspace_id: string; workspace_name?: unknown } => typeof w === "object" && w !== null && isPolicyId((w as { workspace_id?: unknown }).workspace_id))
    .slice(0, LISTED);
  if (rooms.length === 0) {
    say("This agent isn't in any room yet. Add it to a room in Podster, then run setup again.");
    return null;
  }
  say("Rooms this agent is in. Each name is someone else's text, shown as data:");
  rooms.forEach((w, i) => {
    say(`  ${i + 1}. ${w.workspace_id}`);
    const name = typeof w.workspace_name === "string" ? w.workspace_name.slice(0, 200) : "";
    for (const line of fenced(name, terminal.columns ?? 80).slice(0, 3)) say(`  ${line}`);
  });
  const choice = Number((await terminal.question(`Which room? [1-${rooms.length}] `)).trim());
  if (!Number.isSafeInteger(choice) || choice < 1 || choice > rooms.length) {
    say("No room was chosen. Nothing was changed.");
    return null;
  }
  return rooms[choice - 1].workspace_id;
}
