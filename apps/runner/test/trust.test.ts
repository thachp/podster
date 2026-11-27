// F-3 of the M7 security review (2026-11-26): the trust statement an unattended room needs (L3 on #455's review) has
// text, lives in Runner, is accepted only by the owner's typed word at a terminal through `podster trust`, is stored
// bound to its version and hash and when it was accepted, and an unattended room without a current acceptance asks.
// A policy file, or the README's example, can't set it.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, parsePolicyConfig, policyProblem } from "../src/core/policy.js";
import { starterRoom } from "../src/core/setup.js";
import {
  ACCEPT_WORD,
  acceptedRooms,
  parseTrustRecord,
  TRUST_FILE,
  TRUST_STATEMENT,
  TRUST_STATEMENT_SHA256,
  TRUST_STATEMENT_VERSION,
  trustScreen,
  withAcceptance,
} from "../src/core/trust.js";
import { askScreen } from "../src/node/prompter.js";
import type { Terminal } from "../src/node/prompter.js";
import { runTrust } from "../src/node/trust-command.js";
import { trustFile } from "../src/node/trust-file.js";

const OWNER = "org_owner";
const ROOM = "ws_room_one";
const NOW = 1_800_000_000_000;
const CAPS = { spend_micro_usd: 2_000_000, run_time_ms: 30 * 60_000, turns: 40, output_tokens: 50_000, max_tokens: 4_096 };

const config = (acknowledged: Record<string, unknown> = { public_room_warning: false }) => ({
  version: 1,
  revision: 1,
  owner_org: OWNER,
  adapter: "claude_agent_sdk",
  workspace_root: "/Users/owner/podster-work",
  caps: { ...CAPS },
  day_caps: { spend_micro_usd: 10_000_000 },
  rooms: [{ room_id: ROOM, mode: "unattended", allowed_orgs: [], acknowledged }],
});
const author = { id: "per_Person1", org: OWNER, external: false, active: true, written_at: 1_700_000_000_000 };
const requester = { id: "per_Person1", org: OWNER, external: false, active: true };
const input = (extra: Record<string, unknown> = {}) => ({
  config: config(),
  provenance: {
    room_visibility: "private",
    requester,
    inputs: [
      { input: "title", external: false, authors: [author] },
      { input: "instructions", external: false, authors: [author] },
    ],
  },
  prompt: { inputs: ["title", "instructions"], change_request_event_id: null },
  task: { id: "tsk_one", workspace_id: ROOM },
  authority_fresh: true,
  budget: { spent_today_micro_usd: 0, reserved_micro_usd: 0 },
  now: NOW,
  ...extra,
});
const current = (room = ROOM, at = NOW - 1) => ({ room_id: room, statement_version: TRUST_STATEMENT_VERSION, statement_sha256: TRUST_STATEMENT_SHA256, accepted_at: at });

describe("the statement's text lives in Runner", () => {
  it("has words, a version and the SHA-256 of exactly those words", () => {
    expect(TRUST_STATEMENT_VERSION).toBe(1);
    expect(TRUST_STATEMENT_SHA256).toBe(createHash("sha256").update(TRUST_STATEMENT, "utf8").digest("hex"));
    expect(TRUST_STATEMENT).toContain(`version ${TRUST_STATEMENT_VERSION}`);
  });

  it("states the residual risk the review names: forged labels, listed hosts, the combination, the provider, spend, and how to stop", () => {
    // R-21's residual, S-51's channels, F-5's combination, the provider seeing room content (F-3's fix), condition 3's caps
    // and condition 4's stops.
    for (const words of ["compromised", "labeled", "network", "fully reachable", "CDN", "shell", "private repository", "provider", "caps", '"ask"', "podster stop", "disconnect"])
      expect([words, TRUST_STATEMENT.includes(words)]).toEqual([words, true]);
  });

  it("shows the whole statement, the room, the version, the hash and the word to type", () => {
    const screen = trustScreen(ROOM);
    for (const line of TRUST_STATEMENT.split("\n").filter((l) => l !== "")) expect(screen).toContain(line);
    expect(screen).toContain(ROOM);
    expect(screen).toContain(TRUST_STATEMENT_SHA256);
    expect(screen).toContain(`version ${TRUST_STATEMENT_VERSION}`);
    expect(screen).toContain(ACCEPT_WORD);
  });
});

describe("the policy file can't set it", () => {
  it("refuses a room whose acknowledged names trust_statement, true or false, and says where acceptance moved", () => {
    for (const value of [true, false]) {
      const parsed = parsePolicyConfig(config({ trust_statement: value, public_room_warning: false }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.at).toBe("rooms[].acknowledged:trust_statement_moved");
        expect(policyProblem(parsed.at)).toMatch(/podster trust/);
      }
    }
  });

  it("takes a room whose acknowledged holds only the public-room warning", () => {
    expect(parsePolicyConfig(config()).ok).toBe(true);
    expect(parsePolicyConfig(config({})).ok).toBe(false);
  });

  it("a starter room names no trust statement", () => {
    expect(starterRoom({ room_id: ROOM, org_id: OWNER }, OWNER, false).acknowledged).toEqual({ public_room_warning: false });
  });
});

describe("unattended runs need a current acceptance", () => {
  it("asks when no room is trusted, or the input is missing or malformed", () => {
    for (const trusted of [undefined, [], ["ws_other"], "ws_room_one", [ROOM.toUpperCase()], null])
      expect(evaluate(input(trusted === undefined ? {} : { trusted_rooms: trusted }))).toMatchObject({ outcome: "ask", reason: "trust_statement_not_accepted" });
  });

  it("runs once the room has a current acceptance", () => {
    expect(evaluate(input({ trusted_rooms: [ROOM] }))).toMatchObject({ outcome: "run", reason: "unattended_eligible" });
  });

  it("still asks in an ask-first room, trusted or not", () => {
    const ask = { ...config(), rooms: [{ ...config().rooms[0], mode: "ask" }] };
    expect(evaluate(input({ config: ask, trusted_rooms: [ROOM] }))).toMatchObject({ outcome: "ask", reason: "room_ask_first" });
  });

  it("counts only an acceptance of this version and this exact text, made no later than now", () => {
    expect(acceptedRooms({ version: 1, rooms: [current()] }, NOW)).toEqual([ROOM]);
    expect(acceptedRooms({ version: 1, rooms: [current(ROOM, NOW)] }, NOW)).toEqual([ROOM]);
    expect(acceptedRooms({ version: 1, rooms: [current(ROOM, NOW + 1)] }, NOW)).toEqual([]);
    expect(acceptedRooms({ version: 1, rooms: [{ ...current(), statement_version: TRUST_STATEMENT_VERSION + 1 }] }, NOW)).toEqual([]);
    expect(acceptedRooms({ version: 1, rooms: [{ ...current(), statement_sha256: "a".repeat(64) }] }, NOW)).toEqual([]);
  });

  it("reads anything but Runner's own record as no acceptance", () => {
    for (const raw of [null, undefined, true, [], { version: 2, rooms: [current()] }, { version: 1, rooms: [current(), current()] }, { version: 1, rooms: [{ ...current(), extra: 1 }] }, { version: 1, rooms: [{ room_id: ROOM, trust_statement: true }] }, { version: 1, rooms: [{ ...current(), accepted_at: "2026-11-26" }] }, { version: 1, rooms: [current()], extra: true }])
      expect(acceptedRooms(raw, NOW)).toEqual([]);
  });

  it("replaces a room's earlier acceptance and keeps the others", () => {
    const old = { version: 1 as const, rooms: [{ ...current(), statement_version: 0 + 1, statement_sha256: "b".repeat(64), accepted_at: 5 }, current("ws_room_two", 7)] };
    const next = withAcceptance(parseTrustRecord(old), ROOM, NOW);
    expect(next.rooms).toEqual([current("ws_room_two", 7), current(ROOM, NOW)]);
  });

  it("tells the owner on the ask screen how to accept it", () => {
    const view = { workspace_id: ROOM, task_id: "tsk_one", room_visibility: "private" as const, reason: "trust_statement_not_accepted" as const, requester: "per_Person1@org_owner", authors: [], inputs: [], tools: [], network: [], repository: null, caps: CAPS };
    expect(askScreen(view as never).screen).toContain(`podster trust ${ROOM}`);
  });
});

describe("`podster trust`: accepted only by the owner's typed word, at a terminal", () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });
  const home = async () => {
    const h = await mkdtemp(join(tmpdir(), "runner-trust-"));
    homes.push(h);
    return h;
  };
  const terminal = (answers: string[], tty = true): Terminal & { written: string[]; asked: string[] } => {
    const written: string[] = [];
    const asked: string[] = [];
    return {
      inputIsTTY: tty,
      outputIsTTY: tty,
      written,
      asked,
      write: (text) => void written.push(text),
      question: async (prompt) => {
        asked.push(prompt);
        return answers.shift() ?? "";
      },
    };
  };
  const said = () => {
    const lines: string[] = [];
    return { lines, say: (line: string) => void lines.push(line) };
  };

  it("without a terminal, asks nothing and records nothing", async () => {
    const h = await home();
    for (const tty of [{ inputIsTTY: false, outputIsTTY: true }, { inputIsTTY: true, outputIsTTY: false }]) {
      const t = { ...terminal([ACCEPT_WORD]), ...tty };
      const s = said();
      expect(await runTrust({ home: h, room: ROOM, terminal: t, now: () => NOW, say: s.say })).toBe(2);
      expect(t.asked).toEqual([]);
      expect(s.lines.join("\n")).toMatch(/terminal/);
    }
    await expect(stat(join(h, TRUST_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a room ID it can't record, asking nothing", async () => {
    const h = await home();
    for (const room of [undefined, "", "WS_ROOM", "ws room", "../x"]) {
      const t = terminal([ACCEPT_WORD]);
      expect(await runTrust({ home: h, room, terminal: t, now: () => NOW, say: said().say })).toBe(2);
      expect(t.asked).toEqual([]);
    }
    await expect(stat(join(h, TRUST_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shows the whole statement before asking, and records nothing on any other answer", async () => {
    const h = await home();
    for (const answer of ["", "y", "yes", "Accept", " accept now", "I accept"]) {
      const t = terminal([answer]);
      expect(await runTrust({ home: h, room: ROOM, terminal: t, now: () => NOW, say: said().say })).toBe(1);
      expect(t.written.join("")).toContain(trustScreen(ROOM));
      expect(t.asked).toHaveLength(1);
    }
    await expect(stat(join(h, TRUST_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("on the typed word, records the room, version, hash and time, readable only by the owner, and the policy then runs", async () => {
    const h = await home();
    const t = terminal([` ${ACCEPT_WORD} `]);
    expect(await runTrust({ home: h, room: ROOM, terminal: t, now: () => NOW, say: said().say })).toBe(0);
    const stored = JSON.parse(await readFile(join(h, TRUST_FILE), "utf8")) as unknown;
    expect(stored).toEqual({ version: 1, rooms: [current(ROOM, NOW)] });
    expect((await stat(join(h, TRUST_FILE))).mode & 0o777).toBe(0o600);
    const read = trustFile(h);
    expect(acceptedRooms(await read(), NOW)).toEqual([ROOM]);
    expect(evaluate(input({ trusted_rooms: acceptedRooms(await read(), NOW) }))).toMatchObject({ outcome: "run" });
  });

  it("keeps other rooms' acceptances, and won't write over a record it can't read", async () => {
    const h = await home();
    await writeFile(join(h, TRUST_FILE), JSON.stringify({ version: 1, rooms: [current("ws_room_two", 7)] }), { mode: 0o600 });
    expect(await runTrust({ home: h, room: ROOM, terminal: terminal([ACCEPT_WORD]), now: () => NOW, say: said().say })).toBe(0);
    expect(acceptedRooms(await trustFile(h)(), NOW)).toEqual([ROOM, "ws_room_two"]);

    await writeFile(join(h, TRUST_FILE), "{ not json");
    const t = terminal([ACCEPT_WORD]);
    const s = said();
    expect(await runTrust({ home: h, room: ROOM, terminal: t, now: () => NOW, say: s.say })).toBe(1);
    expect(t.asked).toEqual([]);
    expect(await readFile(join(h, TRUST_FILE), "utf8")).toBe("{ not json");
    expect(s.lines.join("\n")).toMatch(new RegExp(TRUST_FILE.replace(".", "\\.")));
  });

  it("reads a missing record as none", async () => {
    expect(acceptedRooms(await trustFile(await home())(), NOW)).toEqual([]);
  });
});

describe("the README's example", () => {
  const readme = () => readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

  it("is a valid policy that sets neither acknowledgment, and so can't switch on unattended runs by being copied", async () => {
    const text = await readme();
    const block = text.match(/A complete, valid example[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(block).not.toBeNull();
    const example = JSON.parse(block![1].replaceAll("…", "example")) as { rooms: { mode?: string; acknowledged: Record<string, unknown> }[] };
    expect(parsePolicyConfig(example).ok).toBe(true);
    for (const room of example.rooms) {
      expect(room.acknowledged).toEqual({ public_room_warning: false });
      expect(room.mode ?? "ask").toBe("ask");
    }
    expect(text).not.toMatch(/"trust_statement"\s*:\s*true/);
  });

  it("names the command that accepts the statement", async () => {
    expect(await readme()).toMatch(/podster@test trust ws_/);
  });
});
