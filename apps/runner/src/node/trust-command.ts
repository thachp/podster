/**
 * `podster trust <ws_…>` (F-3 of the M7 security review): the owner reads Runner's trust statement for one room and
 * accepts it by typing the word `accept`, at a terminal on this machine. Nothing else records it: no flag, no piped
 * input, no policy field, nothing from Podster. What's recorded is the room, the statement's version and SHA-256, and
 * when, in Runner's own `trust.json` (`trust-file.ts`). It doesn't switch the room to unattended runs; that stays the
 * room's `mode` in `policy.json` (decision 29, condition 1). Nothing is logged: the record holds IDs, a version, a hash
 * and a time only (condition 5).
 *
 * `podster trust <ws_…> --share` (the owner's ruling of 2026-11-27) does the same for the public-sharing acknowledgement,
 * a separate statement accepted by typing `share`: it lets a public room's `outputs: "share"` count. It's offered only for a
 * room `run` last saw public, and records that, with when the room's public stretch began, in `public-share.json`. The flag
 * only picks which statement is shown; nothing but the typed word records either.
 */
import {
  ACCEPT_WORD,
  isTrustRoomId,
  parseShareRecord,
  parseSightings,
  parseTrustRecord,
  SHARE_FILE,
  SHARE_STATEMENT_VERSION,
  SHARE_WORD,
  shareScreen,
  SIGHTINGS_FILE,
  TRUST_FILE,
  TRUST_STATEMENT_VERSION,
  trustScreen,
  withAcceptance,
  withShareAcknowledgement,
} from "../core/trust.js";
import type { Terminal } from "./prompter.js";
import { trustFile, writeTrustRecord } from "./trust-file.js";

export type TrustDeps = {
  home: string;
  /** The room the owner named. */
  room: string | undefined;
  /** `--share`: the public-sharing acknowledgement instead of the trust statement. */
  share?: boolean;
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
  if (deps.share === true) return runShare(deps, room);
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

async function read(home: string, file: string): Promise<unknown> {
  try {
    return await trustFile(home, file)();
  } catch {
    return undefined;
  }
}

async function runShare(deps: TrustDeps, room: string): Promise<number> {
  const { terminal, say } = deps;
  const sighting = parseSightings(await read(deps.home, SIGHTINGS_FILE))?.rooms.find((r) => r.room_id === room);
  if (sighting === undefined || sighting.visibility !== "public") {
    say(
      `Runner hasn't last seen ${room} as a public room, and this acknowledgement is only for a room that is public when you accept it. ` +
        "Runner learns a room's visibility from Podster when `run` reads one of its tasks; once a public room's task has been asked about, run this again. Nothing was recorded.",
    );
    return 1;
  }
  const existing = await read(deps.home, SHARE_FILE);
  const record = existing === null ? null : parseShareRecord(existing);
  if (existing !== null && record === null) {
    say(`Runner can't read ${SHARE_FILE} in its home as its own record, so it won't write over it. Move it aside, then run \`podster trust --share\` again. Nothing was recorded.`);
    return 1;
  }
  terminal.write(shareScreen(room, sighting));
  const answer = await terminal.question(`Type ${SHARE_WORD} to accept this acknowledgement for ${room}: `);
  const next = answer.trim() === SHARE_WORD ? withShareAcknowledgement(record, room, sighting, deps.now()) : null;
  if (next === null) {
    say("Not accepted. Nothing was recorded, and Runner still holds this public room's words for you.");
    return 1;
  }
  await writeTrustRecord(deps.home, next, SHARE_FILE);
  say(`Accepted version ${SHARE_STATEMENT_VERSION} of the public-sharing acknowledgement for ${room}. It counts while the room's "outputs" is "share" in policy.json and the room stays public.`);
  return 0;
}
