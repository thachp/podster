/**
 * `podster trust <ws_…>` (F-3 of the M7 security review): the owner reads Runner's trust statement for one room and
 * accepts it by typing the word `accept`, at a terminal on this machine. Nothing else records it: no flag, no piped
 * input, no policy field, nothing from Podster. What's recorded is the room, the statement's version and SHA-256, and
 * when, in Runner's own `trust.json` (`trust-file.ts`). It doesn't switch the room to unattended runs; that stays the
 * room's `mode` in `policy.json` (decision 29, condition 1). Nothing is logged: the record holds IDs, a version, a hash
 * and a time only (condition 5).
 */
import { ACCEPT_WORD, isTrustRoomId, parseTrustRecord, TRUST_FILE, TRUST_STATEMENT_VERSION, trustScreen, withAcceptance } from "../core/trust.js";
import type { Terminal } from "./prompter.js";
import { trustFile, writeTrustRecord } from "./trust-file.js";

export type TrustDeps = {
  home: string;
  /** The room the owner named. */
  room: string | undefined;
  terminal: Terminal;
  now: () => number;
  say: (line: string) => void;
};

/** 0 accepted and recorded; 1 not accepted, or a record Runner can't read; 2 not asked at all. */
export async function runTrust(deps: TrustDeps): Promise<number> {
  const { terminal, say, room } = deps;
  if (!isTrustRoomId(room)) {
    say("Name the room: `podster trust <ws_…>`, with its ID in lower case as policy.json holds it. Nothing was recorded.");
    return 2;
  }
  if (!terminal.inputIsTTY || !terminal.outputIsTTY) {
    say("The trust statement is accepted only at a terminal, by you typing the word. Run `podster trust` in a terminal. Nothing was recorded.");
    return 2;
  }
  let existing: unknown;
  try {
    existing = await trustFile(deps.home)();
  } catch {
    existing = undefined;
  }
  const record = existing === null ? null : parseTrustRecord(existing);
  if (existing !== null && record === null) {
    say(`Runner can't read ${TRUST_FILE} in its home as its own record, so it won't write over it. Move it aside, then run \`podster trust\` again. Nothing was recorded.`);
    return 1;
  }
  terminal.write(trustScreen(room));
  const answer = await terminal.question(`Type ${ACCEPT_WORD} to accept this statement for ${room}: `);
  if (answer.trim() !== ACCEPT_WORD) {
    say("Not accepted. Nothing was recorded, and unattended runs in this room still ask you first.");
    return 1;
  }
  await writeTrustRecord(deps.home, withAcceptance(record, room, deps.now()));
  say(`Accepted version ${TRUST_STATEMENT_VERSION} of the trust statement for ${room}. Unattended runs need the room's "mode" to be "unattended" in policy.json too.`);
  return 0;
}
