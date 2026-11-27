/**
 * The trust statement an unattended room needs (F-3 of the M7 security review, 2026-11-26; L3 on #455's review).
 *
 * Decision 29, as the owner ruled it on 2026-11-17, allows unattended runs under five conditions, and the architect's L3
 * made every room switched to unattended runs also need the owner to accept the trust statement, since RUNNER.md asks
 * every unattended setup to disclose the residual risk. Until this module, the statement had no text: it was a bare
 * `acknowledged.trust_statement: true` in `policy.json`, which the README's example set. Now:
 *
 * - **The text lives here,** in Runner, with its version and the SHA-256 of its exact UTF-8 bytes. A test holds the hash
 *   to the text, so the words can't change without the hash, and the hash can't change without the version.
 * - **It's accepted only through `podster trust <ws_…>`,** at a terminal on the owner's machine (`node/trust-command.ts`):
 *   Runner shows the whole statement and the room, and only the typed word `accept` records it. A file or an example
 *   can't set it: `policy.json` has no field for it, and one that names `trust_statement` is refused whole.
 * - **What's stored binds the acceptance** to the room, the statement's version and hash, and when it was accepted, in
 *   Runner's own `trust.json`, which Runner alone writes. An acceptance of any other version or text counts as none, so
 *   a changed statement asks again.
 * - **Unattended runs need a current acceptance.** `acceptedRooms` is what the lifecycle hands the run policy on every
 *   evaluation; a room missing from it asks the owner before each run (`trust_statement_not_accepted`), as ask-first does.
 *
 * Decision 29's five conditions, as this holds each:
 *   1. Off by default; only the machine's owner turns it on, per workroom, never from Podster: acceptance is per room,
 *      only by the owner's typed word at a terminal on this machine, and nothing Podster sends is read for it.
 *   2. A tool allowlist and a working-folder sandbox, no shell or network unless added: the statement says what listing
 *      `shell` and a host gives a run (S-51, F-5).
 *   3. Hard caps on spend, run time and turns per task: the statement says runs spend up to them without asking.
 *   4. Revocation stops a run at the next check-in, a local stop at once: the statement says how to stop.
 *   5. Logs carry IDs only: the command logs nothing, and the record holds IDs, a version, a hash and a time.
 *
 * Pure: no I/O, no clock (`now` is an input), no randomness. The hash is a literal, checked by a test.
 */

export const TRUST_STATEMENT_VERSION = 1;

/** The word the owner types to accept, and only it. */
export const ACCEPT_WORD = "accept";

/** Runner's own record of acceptances, in Runner's home. Runner writes it only for the owner's `trust` command. */
export const TRUST_FILE = "trust.json";

/** The statement, exactly as shown and hashed. Changing a word changes the hash, and the version must go up with it. */
export const TRUST_STATEMENT = `Podster Runner trust statement, version 1

Accepting lets Runner run this workroom's tasks on this machine without asking you first, while the room's
"mode" in policy.json is "unattended". Runner's limits reduce these risks; they don't remove them.

1. Runner trusts Podster to say who wrote a task. Nothing in a task is signed by the person who wrote it. If
   Podster's service were compromised, it could send any instructions labeled as written by people in your
   organization, and Runner would run them without asking, within this room's tools, network, repository and
   limits.

2. A host listed in the room's "network" is fully reachable. A run can send it anything the run can read,
   the room's repository included. A host behind a shared CDN can be used to reach other sites on that CDN.

3. Runner runs unattended only when the task's words come from your own organization. That rule doesn't
   reach what a run reads while it works: files in the repository, packages it fetches, pages it opens. In a
   room with "shell", a listed host and a private repository, a run holds private code, can read words no
   one in your organization wrote, and has a way to send data out.

4. The model provider sees the room's content: the task's words, the files the tools read and the tools'
   output go to the provider under your API key and its terms.

5. Each run may spend up to the room's caps, and all runs up to the day's cap, without asking you.

To stop: set the room's "mode" to "ask", which counts at Runner's next evaluation; run \`podster stop\` to end
every run at once; or disconnect the machine in Podster, which stops it at its next check-in. This acceptance
is for this room and this version of the statement only. If the statement changes, Runner asks again.
`;

/**
 * The statement's short form, shown where Runner points the owner to it: in `setup`'s preview, and on the ask screen of
 * an unattended room whose owner hasn't accepted it, which is before its first unattended run, since none starts until
 * they do. Only `trust` shows the whole statement, and only the whole statement is accepted.
 */
export function trustPointer(room_id: string): string[] {
  return [
    "Runner's trust statement, which this room needs before it runs anything unattended, says, in short:",
    "  Runner trusts Podster to say who wrote a task, so a compromised Podster could send instructions labeled as your",
    "  organization's; a listed network host can receive anything a run reads; with shell, a listed host and a private",
    "  repository, a run holds private code, reads words no one in your organization wrote, and has a way out; the model",
    "  provider sees the room's content; and runs spend up to their caps without asking.",
    `Read all of it and accept it at a terminal with: podster trust ${room_id}`,
  ];
}

/** SHA-256 of `TRUST_STATEMENT`'s UTF-8 bytes, lower-case hex. */
export const TRUST_STATEMENT_SHA256 = "d4d11d20eb18b3c2c34ce83f37e7defa6d0977740f53139631c1475a164c7c01";

export type TrustAcceptance = { room_id: string; statement_version: number; statement_sha256: string; accepted_at: number };
export type TrustRecord = { version: 1; rooms: TrustAcceptance[] };

const ROOM_ID = /^[a-z0-9_-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** More rooms than a policy can hold is a record Runner didn't write. */
const MAX_RECORDED = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keysAre = (o: Obj, keys: readonly string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export const isTrustRoomId = (v: unknown): v is string => typeof v === "string" && ROOM_ID.test(v);

/** The record as Runner wrote it, or null for anything else: a missing, malformed or foreign record holds no acceptance. */
export function parseTrustRecord(raw: unknown): TrustRecord | null {
  try {
    if (!isObj(raw) || !keysAre(raw, ["version", "rooms"]) || raw.version !== 1) return null;
    const rooms = raw.rooms;
    if (!Array.isArray(rooms) || rooms.length > MAX_RECORDED) return null;
    const out: TrustAcceptance[] = [];
    for (const r of rooms as unknown[]) {
      if (!isObj(r) || !keysAre(r, ["room_id", "statement_version", "statement_sha256", "accepted_at"])) return null;
      const { room_id, statement_version, statement_sha256, accepted_at } = r;
      if (!isTrustRoomId(room_id) || !isCount(statement_version) || statement_version < 1) return null;
      if (typeof statement_sha256 !== "string" || !HEX64.test(statement_sha256) || !isCount(accepted_at)) return null;
      if (out.some((x) => x.room_id === room_id)) return null;
      out.push({ room_id, statement_version, statement_sha256, accepted_at });
    }
    return { version: 1, rooms: out };
  } catch {
    return null;
  }
}

/** Whether one stored acceptance is of this statement: its version and its exact text, accepted no later than `now`. */
export function isCurrent(a: TrustAcceptance, now: number): boolean {
  return a.statement_version === TRUST_STATEMENT_VERSION && a.statement_sha256 === TRUST_STATEMENT_SHA256 && a.accepted_at <= now;
}

/**
 * The rooms with a current acceptance, sorted: what the lifecycle passes the run policy as `trusted_rooms`. Anything
 * that isn't Runner's record, an acceptance of another version or text, or one dated after `now`, counts as none.
 */
export function acceptedRooms(raw: unknown, now: number): string[] {
  const record = parseTrustRecord(raw);
  if (record === null || !isCount(now)) return [];
  return record.rooms.filter((a) => isCurrent(a, now)).map((a) => a.room_id).sort();
}

/** The record with this room's acceptance of the current statement, at `now`, in place of any earlier one for it. */
export function withAcceptance(record: TrustRecord | null, room_id: string, now: number): TrustRecord {
  const others = (record?.rooms ?? []).filter((a) => a.room_id !== room_id);
  return { version: 1, rooms: [...others, { room_id, statement_version: TRUST_STATEMENT_VERSION, statement_sha256: TRUST_STATEMENT_SHA256, accepted_at: now }] };
}

/** The screen `trust` shows before asking: the room, the whole statement, and what's recorded. */
export function trustScreen(room_id: string): string {
  return [
    "",
    `Runner's trust statement, for the room ${room_id}. Read all of it before you answer.`,
    "",
    ...TRUST_STATEMENT.trimEnd().split("\n").map((l) => (l === "" ? "" : `  ${l}`)),
    "",
    `Typing ${ACCEPT_WORD} records, in ${TRUST_FILE} on this machine only, that you accepted version ${TRUST_STATEMENT_VERSION} of this`,
    `statement (SHA-256 ${TRUST_STATEMENT_SHA256}) for ${room_id}, and when. It doesn't switch the room to`,
    `unattended runs: that's the room's "mode" in policy.json. Anything else records nothing.`,
    "",
  ].join("\n");
}

/*
 * The public-sharing acknowledgement (the owner's ruling of 2026-11-27, a narrowing of S-34).
 *
 * Until it, Runner held the agent's words for the owner's review in every public room, whatever the room's `outputs`
 * said. Now a room's `outputs: "share"` is honoured in a public room only when the owner has accepted this
 * acknowledgement for that room, by the same machinery as the trust statement: the text, its version and the SHA-256 of
 * its exact bytes live here; it's accepted only through `podster trust <ws_…> --share` at a terminal, by typing `share`;
 * Runner alone writes the record (`public-share.json`); and a malformed or foreign record holds no acknowledgement. No
 * policy field, flag, environment variable or example can make one.
 *
 * **It's bound to the room being public.** Runner learns a room's visibility only from Podster's provenance on a task,
 * so `run` keeps what it last saw of each room in `room-visibility.json`: public or private, and since when it has seen
 * the room public without a break (`public_since`). An acknowledgement records the room's visibility and that start when
 * accepted, and `podster trust --share` refuses a room Runner hasn't last seen public. It counts only while Runner's
 * sighting still says public with the same start, so a room seen private and then public again asks again, as does a
 * changed statement. A flip Runner never sees, because no task of the room was read while it was private, can't be told
 * apart from no flip; the docs say so.
 *
 * Unchanged: an input authored outside the owner's organization still holds; a private room behaves as before; the push
 * to a public repository still asks (PR 622); and this isn't the trust statement, which unattended runs still need.
 */

export const SHARE_STATEMENT_VERSION = 1;

/** The word the owner types to accept the acknowledgement, and only it: not the trust statement's `accept`. */
export const SHARE_WORD = "share";

/** Runner's own record of public-sharing acknowledgements, written only for `podster trust --share`. */
export const SHARE_FILE = "public-share.json";

/** What `run` last saw of each room's visibility, written only by `run`. */
export const SIGHTINGS_FILE = "room-visibility.json";

/** The acknowledgement, exactly as shown and hashed. Changing a word changes the hash, and the version must go up with it. */
export const SHARE_STATEMENT = `Podster Runner public-sharing acknowledgement, version 1

In this public room, Runner will send the agent's own words (its result note and summary)
to Podster without asking you first, while the room's "outputs" in policy.json is "share".
Anyone who can see the room can read them. Runner redacts secrets it recognises, but not all.

Runner will also commit, push the task branch and open its pull request without asking.
A push to a public repository still asks you each time.

A task with any words written outside your organization is still held for you. This
acknowledgement is for this room, while it stays public, and this version of the statement
only. If Runner sees the room go private and then public again, or the statement changes,
it holds the words and asks again. To stop, set the room's "outputs" to "hold", which
counts at Runner's next evaluation.
`;

/** SHA-256 of `SHARE_STATEMENT`'s UTF-8 bytes, lower-case hex. */
export const SHARE_STATEMENT_SHA256 = "b258e9a86cc6e1d6c0fb9327ee7d6e9ad22abf0b4383e18b6cdadedfab48c393";

/** Where Runner points the owner to it: the ask screen, setup's preview and the README. */
export function sharePointer(room_id: string): string[] {
  return [
    `This room is public and its outputs are "share", but Runner holds the agent's words and its push for you until you`,
    "accept the public-sharing acknowledgement for it: anyone who can see the room can read what's shared.",
    `Read it and accept it at a terminal with: podster trust ${room_id} --share`,
  ];
}

export type Visibility = "public" | "private";
export type ShareAcknowledgement = {
  room_id: string;
  statement_version: number;
  statement_sha256: string;
  /** The room's visibility when accepted, as Runner last saw it. Only `public` counts. */
  room_visibility: Visibility;
  /** When Runner's sighting of the room's current public stretch began. */
  public_since: number;
  accepted_at: number;
};
export type ShareRecord = { version: 1; rooms: ShareAcknowledgement[] };
export type RoomSighting = { room_id: string; visibility: Visibility; public_since: number | null; seen_at: number };
export type SightingRecord = { version: 1; rooms: RoomSighting[] };

const isVisibility = (v: unknown): v is Visibility => v === "public" || v === "private";

function parseRooms<T>(raw: unknown, keys: readonly string[], one: (r: Obj) => T | null): T[] | null {
  try {
    if (!isObj(raw) || !keysAre(raw, ["version", "rooms"]) || raw.version !== 1) return null;
    const rooms = raw.rooms;
    if (!Array.isArray(rooms) || rooms.length > MAX_RECORDED) return null;
    const out: T[] = [];
    const seen = new Set<unknown>();
    for (const r of rooms as unknown[]) {
      if (!isObj(r) || !keysAre(r, keys) || seen.has(r.room_id)) return null;
      seen.add(r.room_id);
      const item = one(r);
      if (item === null) return null;
      out.push(item);
    }
    return out;
  } catch {
    return null;
  }
}

/** The acknowledgements as Runner wrote them, or null for anything else. */
export function parseShareRecord(raw: unknown): ShareRecord | null {
  const rooms = parseRooms(raw, ["room_id", "statement_version", "statement_sha256", "room_visibility", "public_since", "accepted_at"], (r) => {
    const { room_id, statement_version, statement_sha256, room_visibility, public_since, accepted_at } = r;
    if (!isTrustRoomId(room_id) || !isCount(statement_version) || statement_version < 1) return null;
    if (typeof statement_sha256 !== "string" || !HEX64.test(statement_sha256) || !isVisibility(room_visibility)) return null;
    if (!isCount(public_since) || !isCount(accepted_at) || public_since > accepted_at) return null;
    return { room_id, statement_version, statement_sha256, room_visibility, public_since, accepted_at };
  });
  return rooms === null ? null : { version: 1, rooms };
}

/** What `run` saw, as it wrote it, or null for anything else: public always with a start no later than the sighting, private never. */
export function parseSightings(raw: unknown): SightingRecord | null {
  const rooms = parseRooms(raw, ["room_id", "visibility", "public_since", "seen_at"], (r) => {
    const { room_id, visibility, public_since, seen_at } = r;
    if (!isTrustRoomId(room_id) || !isVisibility(visibility) || !isCount(seen_at)) return null;
    if (visibility === "private" ? public_since !== null : !isCount(public_since) || public_since > seen_at) return null;
    return { room_id, visibility, public_since: public_since as number | null, seen_at };
  });
  return rooms === null ? null : { version: 1, rooms };
}

/**
 * The record with `room` seen at `now`: a public sighting keeps the current public stretch's start, or starts one; a
 * private one ends it. `changed` says whether anything but the time moved, so the caller writes only then.
 */
export function sighted(record: SightingRecord | null, room_id: string, visibility: Visibility, now: number): { record: SightingRecord; changed: boolean } {
  const before = record?.rooms.find((r) => r.room_id === room_id);
  const public_since = visibility === "private" ? null : before?.visibility === "public" && before.public_since !== null ? before.public_since : now;
  const changed = before === undefined || before.visibility !== visibility || before.public_since !== public_since;
  const others = (record?.rooms ?? []).filter((r) => r.room_id !== room_id);
  return { record: { version: 1, rooms: [...others, { room_id, visibility, public_since, seen_at: changed ? now : before.seen_at }] }, changed };
}

/**
 * The rooms whose words may be shared while public: a current acknowledgement (this version, this exact text, accepted
 * while public, no later than `now`) whose public stretch is the one Runner still sees. Anything else is none.
 */
export function sharedPublicRooms(shareRaw: unknown, sightingsRaw: unknown, now: number): string[] {
  const record = parseShareRecord(shareRaw);
  const sightings = parseSightings(sightingsRaw);
  if (record === null || sightings === null || !isCount(now)) return [];
  return record.rooms
    .filter((a) => {
      const s = sightings.rooms.find((r) => r.room_id === a.room_id);
      return (
        a.statement_version === SHARE_STATEMENT_VERSION &&
        a.statement_sha256 === SHARE_STATEMENT_SHA256 &&
        a.room_visibility === "public" &&
        a.accepted_at <= now &&
        s !== undefined &&
        s.visibility === "public" &&
        s.public_since === a.public_since
      );
    })
    .map((a) => a.room_id)
    .sort();
}

/**
 * The record with this room's acknowledgement of the current statement at `now`, in place of any earlier one, or null
 * when Runner's sighting of the room isn't public: an acknowledgement is never recorded for a room not seen public.
 */
export function withShareAcknowledgement(record: ShareRecord | null, room_id: string, sighting: RoomSighting | undefined, now: number): ShareRecord | null {
  if (sighting === undefined || sighting.room_id !== room_id || sighting.visibility !== "public" || sighting.public_since === null || sighting.public_since > now) return null;
  const others = (record?.rooms ?? []).filter((a) => a.room_id !== room_id);
  return {
    version: 1,
    rooms: [...others, { room_id, statement_version: SHARE_STATEMENT_VERSION, statement_sha256: SHARE_STATEMENT_SHA256, room_visibility: "public", public_since: sighting.public_since, accepted_at: now }],
  };
}

/** The screen `trust --share` shows before asking: the room, what Runner saw of it, the whole statement, and what's recorded. */
export function shareScreen(room_id: string, sighting: RoomSighting): string {
  return [
    "",
    `Runner's public-sharing acknowledgement, for the room ${room_id}. Read all of it before you answer.`,
    `Runner last saw this room public, without a break since ${new Date(sighting.public_since ?? 0).toISOString()}.`,
    "",
    ...SHARE_STATEMENT.trimEnd().split("\n").map((l) => (l === "" ? "" : `  ${l}`)),
    "",
    `Typing ${SHARE_WORD} records, in ${SHARE_FILE} on this machine only, that you accepted version ${SHARE_STATEMENT_VERSION} of this`,
    `statement (SHA-256 ${SHARE_STATEMENT_SHA256}) for ${room_id} while it was public, and when. It doesn't set the`,
    `room's outputs to share: that's the room's "outputs" in policy.json. Anything else records nothing.`,
    "",
  ].join("\n");
}
