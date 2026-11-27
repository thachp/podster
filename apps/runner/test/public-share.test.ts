// The owner's ruling of 2026-11-27, a narrowing of S-34: a room's `outputs: "share"` is honoured in a public room only
// once the owner has accepted Runner's public-sharing acknowledgement for that room, typed at a terminal through
// `podster trust <ws_…> --share`. It's bound to the room, the statement's version and hash, and the room being public
// when accepted, as Runner last saw it; a room seen private and then public again asks again. Everything else stays:
// any input from outside the owner's organization still holds, private rooms behave as before, a public repository's
// push still asks (PR 622), and no file, flag, variable or example can create it.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { explain } from "../src/core/explain.js";
import { evaluate, parsePolicyConfig } from "../src/core/policy.js";
import { planSetup, previewScreen } from "../src/core/setup.js";
import {
  parseShareRecord,
  parseSightings,
  sharedPublicRooms,
  SHARE_FILE,
  SHARE_STATEMENT,
  SHARE_STATEMENT_SHA256,
  SHARE_STATEMENT_VERSION,
  SHARE_WORD,
  sharePointer,
  shareScreen,
  SIGHTINGS_FILE,
  sighted,
  TRUST_FILE,
  withShareAcknowledgement,
} from "../src/core/trust.js";
import { askScreen, type Terminal } from "../src/node/prompter.js";
import { runTrust } from "../src/node/trust-command.js";
import { trustFile, writeTrustRecord } from "../src/node/trust-file.js";

const OWNER = "org_owner";
const ROOM = "ws_room_one";
const NOW = 1_800_000_000_000;
const SINCE = NOW - 60_000;
const CAPS = { spend_micro_usd: 2_000_000, run_time_ms: 30 * 60_000, turns: 40, output_tokens: 50_000, max_tokens: 4_096 };

const config = (outputs: "share" | "hold", mode: "ask" | "unattended" = "ask") => ({
  version: 1,
  revision: 1,
  owner_org: OWNER,
  adapter: "claude_agent_sdk",
  workspace_root: "/Users/owner/podster-work",
  caps: { ...CAPS },
  day_caps: { spend_micro_usd: 10_000_000 },
  rooms: [{ room_id: ROOM, mode, allowed_orgs: ["org_other"], outputs, acknowledged: { public_room_warning: true } }],
});
const internal = { id: "per_Person1", org: OWNER, external: false, active: true, written_at: 1_700_000_000_000 };
const outsider = { id: "per_Other1", org: "org_other", external: true, active: true, written_at: 1_700_000_000_000 };
const input = (visibility: "public" | "private", outputs: "share" | "hold", authors: "internal" | "external", shared: unknown, extra: Record<string, unknown> = {}) => ({
  config: config(outputs),
  provenance: {
    room_visibility: visibility,
    requester: { id: internal.id, org: OWNER, external: false, active: true },
    inputs: [
      { input: "title", external: false, authors: [internal] },
      { input: "instructions", external: authors === "external", authors: [authors === "external" ? outsider : internal] },
    ],
  },
  prompt: { inputs: ["title", "instructions"], change_request_event_id: null },
  task: { id: "tsk_one", workspace_id: ROOM },
  authority_fresh: true,
  budget: { spent_today_micro_usd: 0, reserved_micro_usd: 0 },
  ...(shared === undefined ? {} : { shared_public_rooms: shared }),
  now: NOW,
  ...extra,
});

const ack = (over: Record<string, unknown> = {}) => ({
  room_id: ROOM,
  statement_version: SHARE_STATEMENT_VERSION,
  statement_sha256: SHARE_STATEMENT_SHA256,
  room_visibility: "public",
  public_since: SINCE,
  accepted_at: NOW - 1,
  ...over,
});
const seen = (over: Record<string, unknown> = {}) => ({ room_id: ROOM, visibility: "public", public_since: SINCE, seen_at: NOW - 1, ...over });
const shares = (...rooms: unknown[]) => ({ version: 1, rooms });
const sightings = (...rooms: unknown[]) => ({ version: 1, rooms });

describe("the acknowledgement's text lives in Runner", () => {
  it("has words, a version and the SHA-256 of exactly those words", () => {
    expect(SHARE_STATEMENT_VERSION).toBe(1);
    expect(SHARE_STATEMENT_SHA256).toBe(createHash("sha256").update(SHARE_STATEMENT, "utf8").digest("hex"));
    expect(SHARE_STATEMENT).toContain(`version ${SHARE_STATEMENT_VERSION}`);
  });

  it("says what the owner's ruling says: the agent's own words go without asking, anyone who sees the room reads them, redaction isn't complete", () => {
    for (const words of ["public room", "result note and summary", "without asking you first", "Anyone who can see the room", "redacts", "not all", "public repository", "private and then public"])
      expect([words, SHARE_STATEMENT.includes(words)]).toEqual([words, true]);
  });

  it("is shown whole, with the room, version, hash and the word to type", () => {
    const screen = shareScreen(ROOM, seen() as never);
    for (const line of SHARE_STATEMENT.split("\n").filter((l) => l !== "")) expect(screen).toContain(line);
    for (const words of [ROOM, SHARE_STATEMENT_SHA256, `version ${SHARE_STATEMENT_VERSION}`, SHARE_WORD]) expect(screen).toContain(words);
  });
});

describe("the matrix: visibility, outputs, acknowledgement, inputs", () => {
  // What the caller passes for each acknowledgement state, read from Runner's own two records.
  const states = {
    acknowledged: sharedPublicRooms(shares(ack()), sightings(seen()), NOW),
    none: sharedPublicRooms(null, sightings(seen()), NOW),
    stale_version: sharedPublicRooms(shares(ack({ statement_version: SHARE_STATEMENT_VERSION + 1 })), sightings(seen()), NOW),
    stale_text: sharedPublicRooms(shares(ack({ statement_sha256: "a".repeat(64) })), sightings(seen()), NOW),
    accepted_while_private: sharedPublicRooms(shares(ack({ room_visibility: "private" })), sightings(seen()), NOW),
    public_again_since: sharedPublicRooms(shares(ack()), sightings(seen({ public_since: NOW - 10 })), NOW),
  } as const;

  it("reads only a current acknowledgement of a room seen public since before it as shared", () => {
    expect(states.acknowledged).toEqual([ROOM]);
    for (const [name, rooms] of Object.entries(states)) if (name !== "acknowledged") expect([name, rooms]).toEqual([name, []]);
  });

  for (const visibility of ["public", "private"] as const)
    for (const outputs of ["share", "hold"] as const)
      for (const [state, rooms] of Object.entries(states))
        for (const authors of ["internal", "external"] as const) {
          // Shared only when the room says share and every input is the owner's organization's; in a public room, also
          // only with a current acknowledgement. A private room is as before: the acknowledgement plays no part.
          const expected = outputs === "share" && authors === "internal" && (visibility === "private" || state === "acknowledged") ? "share" : "hold";
          it(`${visibility}, ${outputs}, ${state}, ${authors} inputs: ${expected}`, () => {
            const d = evaluate(input(visibility, outputs, authors, rooms));
            expect(d.outcome).toBe("ask");
            expect(d.facts?.outputs).toBe(expected);
          });
        }

  it("holds a public room's words when the input is missing or malformed", () => {
    for (const shared of [undefined, null, ROOM, [ROOM.toUpperCase()], [1], { [ROOM]: true }]) expect(evaluate(input("public", "share", "internal", shared)).facts?.outputs).toBe("hold");
  });

  it("isn't the trust statement: neither one stands in for the other", () => {
    const unattended = { ...input("public", "share", "internal", [ROOM]), config: config("share", "unattended") };
    expect(evaluate(unattended)).toMatchObject({ outcome: "ask", reason: "trust_statement_not_accepted" });
    expect(evaluate({ ...unattended, trusted_rooms: [ROOM], shared_public_rooms: [] })).toMatchObject({ outcome: "run", facts: { outputs: "hold" } });
    expect(evaluate({ ...unattended, trusted_rooms: [ROOM] })).toMatchObject({ outcome: "run", facts: { outputs: "share" } });
  });
});

describe("what Runner saw of the room's visibility", () => {
  it("starts a public stretch when it first sees the room public, and keeps it while it stays public", () => {
    const first = sighted(null, ROOM, "public", 100);
    expect(first.changed).toBe(true);
    expect(first.record.rooms).toEqual([{ room_id: ROOM, visibility: "public", public_since: 100, seen_at: 100 }]);
    const again = sighted(first.record, ROOM, "public", 200);
    expect(again.record.rooms[0]).toMatchObject({ visibility: "public", public_since: 100 });
  });

  it("ends the stretch when the room is seen private, so a later public stretch asks again", () => {
    const pub = sighted(null, ROOM, "public", 100).record;
    const acknowledged = withShareAcknowledgement(null, ROOM, pub.rooms[0], 150);
    expect(acknowledged).not.toBeNull();
    expect(sharedPublicRooms(acknowledged, pub, 160)).toEqual([ROOM]);
    const priv = sighted(pub, ROOM, "private", 200).record;
    expect(priv.rooms[0]).toMatchObject({ visibility: "private", public_since: null });
    expect(sharedPublicRooms(acknowledged, priv, 210)).toEqual([]);
    const pubAgain = sighted(priv, ROOM, "public", 300).record;
    expect(pubAgain.rooms[0]).toMatchObject({ visibility: "public", public_since: 300 });
    expect(sharedPublicRooms(acknowledged, pubAgain, 310)).toEqual([]);
  });

  it("can't record an acknowledgement for a room not seen public", () => {
    expect(withShareAcknowledgement(null, ROOM, undefined, NOW)).toBeNull();
    expect(withShareAcknowledgement(null, ROOM, seen({ visibility: "private", public_since: null }) as never, NOW)).toBeNull();
    expect(withShareAcknowledgement(null, ROOM, seen({ room_id: "ws_other" }) as never, NOW)).toBeNull();
  });
});

describe("forged and malformed records count as none", () => {
  it("refuses any share record Runner didn't write", () => {
    const forged: unknown[] = [
      null,
      true,
      [],
      { version: 2, rooms: [ack()] },
      { version: 1, rooms: [ack()], extra: 1 },
      { version: 1, rooms: [ack(), ack()] },
      { version: 1, rooms: [{ ...ack(), extra: 1 }] },
      { version: 1, rooms: [{ room_id: ROOM, share: true }] },
      { version: 1, rooms: [ack({ room_visibility: "PUBLIC" })] },
      { version: 1, rooms: [ack({ public_since: "yesterday" })] },
      { version: 1, rooms: [ack({ public_since: NOW })] }, // public only after it was accepted
      { version: 1, rooms: [ack({ accepted_at: NOW + 1 })] }, // dated after now
      { version: 1, rooms: [ack({ room_id: "WS_ROOM" })] },
      { version: 1, rooms: [ack({ statement_sha256: "Z".repeat(64) })] },
    ];
    for (const raw of forged) expect([raw, sharedPublicRooms(raw, sightings(seen()), NOW)]).toEqual([raw, []]);
  });

  it("refuses any sightings record Runner didn't write", () => {
    const forged: unknown[] = [
      null,
      { version: 2, rooms: [seen()] },
      { version: 1, rooms: [seen(), seen()] },
      { version: 1, rooms: [{ ...seen(), extra: 1 }] },
      { version: 1, rooms: [seen({ public_since: null })] }, // public without a start
      { version: 1, rooms: [seen({ visibility: "private" })] }, // private with one
      { version: 1, rooms: [seen({ public_since: NOW })] }, // started after it was last seen
    ];
    for (const raw of forged) expect([raw, sharedPublicRooms(shares(ack()), raw, NOW)]).toEqual([raw, []]);
    expect(parseSightings(sightings(seen({ visibility: "private", public_since: null })))).not.toBeNull();
  });

  it("an acknowledgement in the trust statement's file, or a trust acceptance, isn't one", () => {
    const trust = { version: 1, rooms: [{ room_id: ROOM, statement_version: 1, statement_sha256: "d".repeat(64), accepted_at: NOW - 1 }] };
    expect(sharedPublicRooms(trust, sightings(seen()), NOW)).toEqual([]);
    expect(parseShareRecord(trust)).toBeNull();
    expect(SHARE_FILE).not.toBe(TRUST_FILE);
    expect(SIGHTINGS_FILE).not.toBe(SHARE_FILE);
  });

  it("the policy file can't set it: a room naming it, or a public-share flag, is refused whole", () => {
    const base = config("share");
    for (const acknowledged of [{ public_room_warning: true, public_share: true }, { public_room_warning: true, share_statement: true }])
      expect(parsePolicyConfig({ ...base, rooms: [{ ...base.rooms[0], acknowledged }] }).ok).toBe(false);
    expect(parsePolicyConfig({ ...base, rooms: [{ ...base.rooms[0], public_share: true }] }).ok).toBe(false);
    expect(parsePolicyConfig({ ...base, public_share: true }).ok).toBe(false);
  });
});

describe("`podster trust <ws_…> --share`: accepted only by the owner's typed word, for a room seen public", () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });
  const home = async (sighting?: unknown) => {
    const h = await mkdtemp(join(tmpdir(), "runner-share-"));
    homes.push(h);
    if (sighting !== undefined) await writeFile(join(h, SIGHTINGS_FILE), JSON.stringify(sighting), { mode: 0o600 });
    return h;
  };
  const terminal = (answers: string[], tty = true): Terminal & { written: string[]; asked: string[] } => {
    const written: string[] = [];
    const asked: string[] = [];
    return { inputIsTTY: tty, outputIsTTY: tty, written, asked, write: (t) => void written.push(t), question: async (p) => (asked.push(p), answers.shift() ?? "") };
  };
  const said = () => {
    const lines: string[] = [];
    return { lines, say: (line: string) => void lines.push(line) };
  };
  const share = (h: string, t: Terminal, s = said()) => runTrust({ home: h, room: ROOM, share: true, terminal: t, now: () => NOW, say: s.say });

  it("without a terminal, asks nothing and records nothing", async () => {
    const h = await home(sightings(seen()));
    const t = terminal([SHARE_WORD], false);
    expect(await share(h, t)).toBe(2);
    expect(t.asked).toEqual([]);
    await expect(stat(join(h, SHARE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a room Runner hasn't seen public, or last saw private, and says how to get there", async () => {
    for (const sighting of [undefined, sightings(seen({ visibility: "private", public_since: null })), sightings(seen({ room_id: "ws_other" })), { version: 9 }]) {
      const h = await home(sighting);
      const t = terminal([SHARE_WORD]);
      const s = said();
      expect(await share(h, t, s)).toBe(1);
      expect(t.asked).toEqual([]);
      expect(s.lines.join("\n")).toMatch(/public/);
      await expect(stat(join(h, SHARE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("shows the whole statement, and records nothing on any other answer, the trust statement's word included", async () => {
    const h = await home(sightings(seen()));
    for (const answer of ["", "y", "yes", "accept", "Share", "share it"]) {
      const t = terminal([answer]);
      expect(await share(h, t)).toBe(1);
      expect(t.written.join("")).toContain(shareScreen(ROOM, seen() as never));
    }
    await expect(stat(join(h, SHARE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(h, TRUST_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("on the typed word, records the room, version, hash, visibility, public stretch and time, owner-only, and the policy then shares", async () => {
    const h = await home(sightings(seen()));
    expect(await share(h, terminal([` ${SHARE_WORD} `]))).toBe(0);
    const stored = JSON.parse(await readFile(join(h, SHARE_FILE), "utf8")) as unknown;
    expect(stored).toEqual({ version: 1, rooms: [ack({ accepted_at: NOW })] });
    expect((await stat(join(h, SHARE_FILE))).mode & 0o777).toBe(0o600);
    // The trust statement's record is untouched: this is a separate acknowledgement.
    await expect(stat(join(h, TRUST_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    const rooms = sharedPublicRooms(await trustFile(h, SHARE_FILE)(), await trustFile(h, SIGHTINGS_FILE)(), NOW);
    expect(evaluate(input("public", "share", "internal", rooms)).facts?.outputs).toBe("share");
    expect(evaluate(input("public", "share", "external", rooms)).facts?.outputs).toBe("hold");
  });

  it("won't write over a share record it can't read", async () => {
    const h = await home(sightings(seen()));
    await writeFile(join(h, SHARE_FILE), "{ not json");
    const t = terminal([SHARE_WORD]);
    expect(await share(h, t)).toBe(1);
    expect(t.asked).toEqual([]);
    expect(await readFile(join(h, SHARE_FILE), "utf8")).toBe("{ not json");
  });

  it("keeps the plain `trust` the trust statement", async () => {
    const h = await home(sightings(seen()));
    const t = terminal(["accept"]);
    expect(await runTrust({ home: h, room: ROOM, terminal: t, now: () => NOW, say: said().say })).toBe(0);
    await expect(stat(join(h, SHARE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(t.written.join("")).not.toContain(SHARE_STATEMENT_SHA256);
  });

  it("the writer is the trust statement's: a sightings file written by Runner reads back", async () => {
    const h = await home();
    await writeTrustRecord(h, sightings(seen()) as never, SIGHTINGS_FILE);
    expect(parseSightings(await trustFile(h, SIGHTINGS_FILE)())).toEqual(sightings(seen()));
  });
});

describe("where Runner says how to enable it", () => {
  const view = (over: Record<string, unknown> = {}) =>
    ({ workspace_id: ROOM, task_id: "tsk_one", room_visibility: "public", reason: "room_ask_first", requester: "per_Person1@org_owner", authors: [], inputs: [], tools: [], network: [], repository: null, caps: CAPS, ...over }) as never;

  it("on the ask screen, for a public room set to share without an acknowledgement", () => {
    const screen = askScreen(view({ public_share_held: true })).screen;
    for (const line of sharePointer(ROOM)) expect(screen).toContain(line);
    expect(screen).toContain(`podster trust ${ROOM} --share`);
    expect(askScreen(view()).screen).not.toContain("--share");
    expect(askScreen(view({ public_share_held: false })).screen).not.toContain("--share");
  });

  it("in setup's preview", () => {
    const plan = planSetup({ existing: null, owner_org: OWNER, facts: { room_id: ROOM, org_id: OWNER }, workspace_root: "/Users/owner/podster-work", allow_room_org: false, runner_home: "/Users/owner/.podster-runner" });
    const screen = previewScreen(plan as never, { room_id: ROOM, org_id: OWNER }, OWNER, "/Users/owner/.podster-runner/policy.json");
    expect(screen).toContain(`podster trust ${ROOM} --share`);
  });

  it("in the code explanations", () => {
    expect(explain("public_share_not_acknowledged").todo).toMatch(/podster trust <ws_…> --share/);
  });

  it("in the README, which names the command and sets no acknowledgement", async () => {
    const text = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(text).toMatch(/podster@test trust ws_… --share/);
    expect(text).not.toMatch(/"public_share"\s*:/);
  });
});
