/**
 * Runner's run policy (M7 step 7; RUNNER.md "Run policy and budget"; decision 29 as the owner ruled it on 2026-11-17).
 * Pure: it imports nothing, reads no clock (`now` is an input), uses no randomness and does no I/O. A test holds it so.
 *
 * Inputs: the owner's local configuration (rooms, the organizations allowed in each, run mode, tools, network, caps),
 * the task's IDs, its `provenance` from `get_task`, the inputs the prompt will be built from, whether Runner's authority
 * is fresh (`Poller.authorityFresh()`, passed in as a value), the day's spend and reservations, and `now`. Output: ask,
 * run or refuse, with a reason code. Every input is copied to plain data once, at entry, and read as own properties
 * only, so a getter answers once and nothing on `Object.prototype` counts.
 *
 * - **Ask first is the default.** A room runs unattended only when the machine's owner set `mode: "unattended"` for that
 *   one room in this local configuration. There is no all-rooms setting, and nothing from Podster is read for the mode:
 *   the task is taken by its IDs alone, and a provenance with any field the contract doesn't have is refused (S-40).
 * - **The least-trusted author decides.** An unattended run needs the requester and every author of every input to be
 *   named, of the owner's organization, active, and not marked external by the server; and no input marked external.
 *   Unknown or inactive counts as external (F3, G1, G2). Either signal of externality wins: Runner's own comparison with
 *   the owner's organization, or the server's flag. Any of them makes it ask, never run.
 * - **Scope.** A requester or author whose organization is named and is neither the owner's nor listed for the room is
 *   out of scope, and the task is refused (RUNNER.md: "Do not start; report the missing scope"). An unknown organization
 *   can't be scoped, so it asks.
 * - **The room split.** Every unattended room needs the owner to have accepted the trust statement for it, the residual
 *   risk RUNNER.md asks every unattended setup to disclose (L3 on #455's review). A public room also needs the
 *   public-room warning (decision 232).
 * - **The prompt's inputs** must be exactly those `provenance` lists, in its order, and a change request exactly the one
 *   whose `event_id` provenance names (M2 on #455's review). Steps 8 and 9 build the prompt from those inputs only, and
 *   the change request from that event only.
 * - **Caps** on spend, run time, turns and output tokens, and the bounded `max_tokens` the broker writes into each
 *   request, are required, each a positive integer under a fixed ceiling, with no "none" (condition 3; spike B rulings 3
 *   and 5). A configuration lacking any of them is refused whole, as is anything else malformed.
 * - **Tools and network** are facts for step 9's adapter, which enforces them: no shell and no network unless listed by
 *   name (condition 2). The adapter's result tool is always named.
 * - **Run decisions** are bound to every run fact, by a canonical form of the whole `RunFacts` (M1 on #455's review), and
 *   to the task's version, input hash, repository and base. They are single-use and expire.
 *
 * **The caller serialises.** Runner must run evaluate-then-issue, and evaluate-then-consume, as one step each per Runner,
 * with nothing else evaluating or reserving between them; the day's reservations it passes in are only right if so. At
 * consume, it passes this decision's own reservation as `own_reservation_micro_usd`, so the fresh evaluation doesn't count
 * it twice (L5 on #455's review). The decision says what it left out, and consume refuses anything but none or the
 * record's own `reserved_micro_usd`, so a caller can't leave out more (L5, bound 2026-11-18).
 *
 * Agent content is data: task text is never an input here, only provenance IDs and organizations. A decision carries
 * IDs, codes, paths and hostnames only, so it can be logged by ID.
 */

export const POLICY_VERSION = 1;
export const ADAPTERS = ["claude_agent_sdk"] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** Runner's own tools, run in the task's container (spike B ruling 1). Shell only when the owner lists it. */
export const TOOLS = ["read", "search", "write", "edit", "shell"] as const;
export type Tool = (typeof TOOLS)[number];
export const DEFAULT_TOOLS: readonly Tool[] = ["read", "search", "write", "edit"];
/** The SDK's structured result is itself a tool call, so the policy always names it (spike B ruling 2). */
export const RESULT_TOOL = "StructuredOutput";

/** Fixed ceilings, **Proposed** for the owner to review. A cap can be set lower, never above, and never unset. */
export const CEILINGS = {
  spend_micro_usd: 25_000_000,
  run_time_ms: 24 * 60 * 60 * 1000,
  turns: 1_000,
  output_tokens: 1_000_000,
  max_tokens: 32_000,
} as const;
export const MIN_RUN_TIME_MS = 60_000;
export const DAY_SPEND_CEILING_MICRO_USD = 250_000_000;
/** How long a run decision may wait before it is used. */
export const DECISION_TTL_MS = 10 * 60 * 1000;

const MAX_ROOMS = 200;
const MAX_ORGS = 50;
const MAX_HOSTS = 50;
const MAX_AUTHORS = 1_000;
const MAX_ROOT = 1_024;
const MAX_NODES = 200_000;
const MAX_DEPTH = 8;
const MAX_FACTS_KEY = 4 * 1024 * 1024;
/**
 * Room, workspace, task, organization, repository and event IDs are lower case, since they reach paths and path-like
 * comparisons (L6 on #455's review, narrowed 2026-11-18). An agent's ID reaches the policy only as a requester or an
 * author, so it is read as an actor ID below, and compared exactly.
 */
const ID = /^[a-z0-9_-]{1,128}$/;
/**
 * A requester's or author's ID: a person's is `per_` plus Better Auth's mixed-case ID (`personId` in
 * apps/gateway/src/index.ts). Only ever compared exactly, never used in a path.
 */
const ACTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INPUTS = ["title", "instructions", "acceptance_criteria", "change_request"] as const;
type InputName = (typeof INPUTS)[number];

export type Caps = { spend_micro_usd: number; run_time_ms: number; turns: number; output_tokens: number; max_tokens: number };
export type RoomPolicy = {
  room_id: string;
  mode: "ask" | "unattended";
  allowed_orgs: string[];
  tools: Tool[];
  network: string[];
  outputs: "hold" | "share";
  acknowledged: { trust_statement: boolean; public_room_warning: boolean };
};
export type PolicyConfig = {
  version: 1;
  revision: number;
  owner_org: string;
  adapter: Adapter;
  workspace_root: string;
  caps: Caps;
  day_caps: { spend_micro_usd: number };
  rooms: RoomPolicy[];
};

export type RefuseReason =
  | "config_invalid"
  | "provenance_invalid"
  | "prompt_mismatch"
  | "task_invalid"
  | "budget_invalid"
  | "clock_invalid"
  | "authority_stale"
  | "room_not_configured"
  | "requester_out_of_scope"
  | "author_out_of_scope"
  | "day_budget_exhausted";
export type AskReason =
  | "room_ask_first"
  | "requester_unknown"
  | "requester_inactive"
  | "requester_external"
  | "author_unknown"
  | "author_inactive"
  | "author_external"
  | "trust_statement_not_accepted"
  | "public_warning_not_accepted";
export type RunReason = "unattended_eligible";

/** What step 9's adapter is handed for a run: it enforces these; the policy only states them. */
export type RunFacts = {
  adapter: Adapter;
  tools: Tool[];
  shell: boolean;
  network: string[];
  result_tool: typeof RESULT_TOOL;
  workspace_root: string;
  task_folder: string;
  caps: Caps;
  outputs: "hold" | "share";
  policy_revision: number;
  room_visibility: "private" | "public";
  /** The inputs the prompt is built from, exactly those provenance lists, in its order. */
  prompt_inputs: InputName[];
  /** The change request the prompt uses, by its event; null when there is none. */
  change_request_event_id: string | null;
  /** Who wrote each input and the requester, as `id@org`, `?` for unknown. */
  requester: string;
  authors: { input: InputName; authors: string[] }[];
};

export type Decision =
  | { outcome: "refuse"; reason: RefuseReason; task_id?: string; workspace_id?: string; facts?: undefined }
  | { outcome: "ask"; reason: AskReason; task_id: string; workspace_id: string; facts: RunFacts; excluded_reservation_micro_usd: number }
  | { outcome: "run"; reason: RunReason; task_id: string; workspace_id: string; facts: RunFacts; excluded_reservation_micro_usd: number };

export type EvaluateInput = {
  /** The owner's configuration, as read from Runner's local file: checked here, so a malformed one refuses. */
  config: unknown;
  /** `get_task`'s `provenance`. */
  provenance: unknown;
  /** The inputs the prompt will be built from: `{ inputs: [...names], change_request_event_id }`. */
  prompt: unknown;
  /** The task, by its IDs. Anything else on it, its text included, is ignored. */
  task: unknown;
  /** `Poller.authorityFresh()`. Only `true` passes. */
  authority_fresh: unknown;
  /**
   * Spend counted today and budget reserved by runs not yet settled, in micro-USD; at consume, also this decision's own
   * reservation as `own_reservation_micro_usd`, which is left out of the count.
   */
  budget: unknown;
  now: unknown;
};

type Obj = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; at: string };
const fail = (at: string): { ok: false; at: string } => ({ ok: false, at });

/**
 * A plain-data copy: null-prototype objects of own enumerable keys, arrays, strings, numbers, booleans, null. Each
 * property is read once. Anything else (a class instance, a function, too deep or too large) throws.
 */
function plain(v: unknown, depth: number, count: { n: number }): unknown {
  count.n += 1;
  if (count.n > MAX_NODES || depth > MAX_DEPTH) throw new Error("too_large");
  if (v === null || v === undefined || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    const length = v.length;
    if (length > MAX_NODES) throw new Error("too_large");
    for (let i = 0; i < length; i++) out.push(plain(v[i], depth + 1, count));
    return out;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error("not_data");
    const out: Obj = Object.create(null);
    for (const key of Object.keys(v)) out[key] = plain((v as Obj)[key], depth + 1, count);
    return out;
  }
  throw new Error("not_data");
}
const NOT_DATA = { not_data: true } as const;
function copy(v: unknown): unknown {
  try {
    return plain(v, 0, { n: 0 });
  } catch {
    return NOT_DATA;
  }
}

function isObj(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v) || v === NOT_DATA) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
/** Exactly these keys, the optional ones allowed to be absent. */
function keysAre(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => Object.hasOwn(o, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isActorId = (v: unknown): v is string => typeof v === "string" && ACTOR_ID.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const inRange = (v: unknown, min: number, max: number): v is number => isCount(v) && v >= min && v <= max;
const isInput = (v: unknown): v is InputName => typeof v === "string" && (INPUTS as readonly string[]).includes(v);

function uniqueList<T>(v: unknown, max: number, each: (x: unknown) => x is T): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  if (!v.every(each)) return null;
  return new Set(v).size === v.length ? [...v] : null;
}

function isHost(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 253) return false;
  const labels = v.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && TLD.test(labels[labels.length - 1]);
}
const isTool = (v: unknown): v is Tool => typeof v === "string" && (TOOLS as readonly string[]).includes(v);

function isRoot(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 2 || v.length > MAX_ROOT || !v.startsWith("/") || v.endsWith("/")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return false;
  return v.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Input names in the contract's order, title and instructions first, each once. */
function isInputList(v: unknown): v is InputName[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > INPUTS.length || !v.every(isInput)) return false;
  if (v[0] !== "title" || v[1] !== "instructions") return false;
  return v.every((x, i) => i === 0 || INPUTS.indexOf(x) > INPUTS.indexOf(v[i - 1]));
}

function parseCaps(v: unknown): Parsed<Caps> {
  if (!isObj(v) || !keysAre(v, Object.keys(CEILINGS))) return fail("caps");
  const { spend_micro_usd, run_time_ms, turns, output_tokens, max_tokens } = v;
  if (!inRange(spend_micro_usd, 1, CEILINGS.spend_micro_usd)) return fail("caps.spend_micro_usd");
  if (!inRange(run_time_ms, MIN_RUN_TIME_MS, CEILINGS.run_time_ms)) return fail("caps.run_time_ms");
  if (!inRange(turns, 1, CEILINGS.turns)) return fail("caps.turns");
  if (!inRange(output_tokens, 1, CEILINGS.output_tokens)) return fail("caps.output_tokens");
  if (!inRange(max_tokens, 1, CEILINGS.max_tokens) || max_tokens > output_tokens) return fail("caps.max_tokens");
  return { ok: true, value: { spend_micro_usd, run_time_ms, turns, output_tokens, max_tokens } };
}

function parseRoom(v: unknown, ownerOrg: string): Parsed<RoomPolicy> {
  if (!isObj(v) || !keysAre(v, ["room_id", "allowed_orgs", "acknowledged"], ["mode", "tools", "network", "outputs"])) return fail("rooms[]");
  const roomId = own(v, "room_id");
  if (!isId(roomId)) return fail("rooms[].room_id");
  const mode = Object.hasOwn(v, "mode") ? v.mode : "ask";
  if (mode !== "ask" && mode !== "unattended") return fail("rooms[].mode");
  const allowed = uniqueList(own(v, "allowed_orgs"), MAX_ORGS, isId);
  if (!allowed || allowed.includes(ownerOrg)) return fail("rooms[].allowed_orgs");
  const tools = Object.hasOwn(v, "tools") ? uniqueList(v.tools, TOOLS.length, isTool) : [...DEFAULT_TOOLS];
  if (!tools) return fail("rooms[].tools");
  const network = Object.hasOwn(v, "network") ? uniqueList(v.network, MAX_HOSTS, isHost) : [];
  if (!network) return fail("rooms[].network");
  const outputs = Object.hasOwn(v, "outputs") ? v.outputs : "hold";
  if (outputs !== "hold" && outputs !== "share") return fail("rooms[].outputs");
  const ack = own(v, "acknowledged");
  if (!isObj(ack) || !keysAre(ack, ["trust_statement", "public_room_warning"])) return fail("rooms[].acknowledged");
  const trust = own(ack, "trust_statement");
  const warning = own(ack, "public_room_warning");
  if (typeof trust !== "boolean" || typeof warning !== "boolean") return fail("rooms[].acknowledged");
  return { ok: true, value: { room_id: roomId, mode, allowed_orgs: allowed, tools, network, outputs, acknowledged: { trust_statement: trust, public_room_warning: warning } } };
}

/** Checks the owner's configuration whole. Anything missing, unknown or out of range refuses it: fail closed. */
export function parsePolicyConfig(input: unknown): Parsed<PolicyConfig> {
  try {
    const raw = copy(input);
    if (!isObj(raw) || !keysAre(raw, ["version", "revision", "owner_org", "adapter", "workspace_root", "caps", "day_caps", "rooms"])) return fail("config");
    if (raw.version !== POLICY_VERSION) return fail("version");
    const revision = raw.revision;
    if (!inRange(revision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
    const ownerOrg = raw.owner_org;
    if (!isId(ownerOrg)) return fail("owner_org");
    const adapter = raw.adapter;
    if (typeof adapter !== "string" || !(ADAPTERS as readonly string[]).includes(adapter)) return fail("adapter");
    const root = raw.workspace_root;
    if (!isRoot(root)) return fail("workspace_root");
    const caps = parseCaps(raw.caps);
    if (!caps.ok) return caps;
    const day = raw.day_caps;
    if (!isObj(day) || !keysAre(day, ["spend_micro_usd"])) return fail("day_caps");
    const daySpend = day.spend_micro_usd;
    if (!inRange(daySpend, caps.value.spend_micro_usd, DAY_SPEND_CEILING_MICRO_USD)) return fail("day_caps.spend_micro_usd");
    if (!Array.isArray(raw.rooms) || raw.rooms.length > MAX_ROOMS) return fail("rooms");
    const rooms: RoomPolicy[] = [];
    for (const r of raw.rooms) {
      const room = parseRoom(r, ownerOrg);
      if (!room.ok) return room;
      if (rooms.some((x) => x.room_id === room.value.room_id)) return fail("rooms[].room_id");
      rooms.push(room.value);
    }
    return { ok: true, value: { version: 1, revision, owner_org: ownerOrg, adapter: adapter as Adapter, workspace_root: root, caps: caps.value, day_caps: { spend_micro_usd: daySpend }, rooms } };
  } catch {
    return fail("config");
  }
}

type Actor = { id: string | null; org: string | null; external: boolean; active: boolean };
type ProvenanceInput = { input: InputName; external: boolean; authors: Actor[]; event_id: string | null };
type Provenance = { room_visibility: "private" | "public"; requester: Actor & { id: string }; inputs: ProvenanceInput[] };

const isOrg = (v: unknown): v is string | null => v === null || isId(v);

function parseAuthor(v: unknown): Actor | null {
  if (!isObj(v) || !keysAre(v, ["id", "org", "external", "active", "written_at"])) return null;
  const { id, org, external, active } = v;
  if (!(id === null || isActorId(id)) || !isOrg(org)) return null;
  if (typeof external !== "boolean" || typeof active !== "boolean") return null;
  // A named author has a time; only the unknown author has none (L7 on #455's review).
  if (id === null ? v.written_at !== null : !isCount(v.written_at)) return null;
  return { id, org, external, active };
}

/** Checks `get_task`'s provenance against the contract's `TaskProvenance`, strictly. */
function parseProvenance(v: unknown): Provenance | null {
  if (!isObj(v) || !keysAre(v, ["room_visibility", "requester", "inputs"])) return null;
  const visibility = v.room_visibility;
  if (visibility !== "private" && visibility !== "public") return null;
  const r = v.requester;
  if (!isObj(r) || !keysAre(r, ["id", "org", "external", "active"])) return null;
  const { id, org, external, active } = r;
  if (!isActorId(id) || !isOrg(org) || typeof external !== "boolean" || typeof active !== "boolean") return null;
  if (!Array.isArray(v.inputs)) return null;
  const inputs: ProvenanceInput[] = [];
  for (const i of v.inputs) {
    if (!isObj(i) || !keysAre(i, ["input", "external", "authors"], ["event_id"])) return null;
    const name = i.input;
    if (!isInput(name) || typeof i.external !== "boolean") return null;
    const hasEvent = Object.hasOwn(i, "event_id");
    if (hasEvent && (name !== "change_request" || !(i.event_id === null || isId(i.event_id)))) return null;
    if (!Array.isArray(i.authors) || i.authors.length < 1 || i.authors.length > MAX_AUTHORS) return null;
    const authors: Actor[] = [];
    for (const a of i.authors) {
      const author = parseAuthor(a);
      if (!author) return null;
      authors.push(author);
    }
    inputs.push({ input: name, external: i.external, authors, event_id: hasEvent ? (i.event_id as string | null) : null });
  }
  if (!isInputList(inputs.map((i) => i.input))) return null;
  return { room_visibility: visibility, requester: { id, org, external, active }, inputs };
}

/** The prompt's inputs must be exactly provenance's, and its change request exactly the event provenance names. */
function promptMatches(v: unknown, prov: Provenance): { inputs: InputName[]; event: string | null } | null {
  if (!isObj(v) || !keysAre(v, ["inputs", "change_request_event_id"])) return null;
  const names = v.inputs;
  const event = v.change_request_event_id;
  if (!isInputList(names) || names.length !== prov.inputs.length || !names.every((n, i) => n === prov.inputs[i].input)) return null;
  const request = prov.inputs.find((i) => i.input === "change_request");
  if (request === undefined) return event === null ? { inputs: [...names], event: null } : null;
  if (!isId(event) || request.event_id !== event) return null;
  return { inputs: [...names], event };
}

/** How Runner reads one actor against the owner's organization. The first that applies, in this order. */
function standing(a: Actor, ownerOrg: string): "unknown" | "inactive" | "external" | "internal" {
  if (a.id === null || a.org === null) return "unknown";
  if (!a.active) return "inactive";
  if (a.org !== ownerOrg || a.external) return "external";
  return "internal";
}
const label = (a: Actor) => (a.id === null ? "?" : `${a.id}@${a.org ?? "?"}`);

export function evaluate(input: EvaluateInput): Decision {
  try {
    return decide(input);
  } catch {
    return { outcome: "refuse", reason: "config_invalid" };
  }
}

function decide(input: EvaluateInput): Decision {
  const given = copy(input);
  if (!isObj(given)) return { outcome: "refuse", reason: "config_invalid" };
  const parsed = parsePolicyConfig(own(given, "config"));
  if (!parsed.ok) return { outcome: "refuse", reason: "config_invalid" };
  const config = parsed.value;
  const now = own(given, "now");
  if (!isCount(now)) return { outcome: "refuse", reason: "clock_invalid" };
  const t = own(given, "task");
  if (!isObj(t) || !isId(own(t, "id")) || !isId(own(t, "workspace_id"))) return { outcome: "refuse", reason: "task_invalid" };
  const ids = { task_id: t.id as string, workspace_id: t.workspace_id as string };
  if (own(given, "authority_fresh") !== true) return { outcome: "refuse", reason: "authority_stale", ...ids };
  const prov = parseProvenance(own(given, "provenance"));
  if (!prov) return { outcome: "refuse", reason: "provenance_invalid", ...ids };
  const prompt = promptMatches(own(given, "prompt"), prov);
  if (!prompt) return { outcome: "refuse", reason: "prompt_mismatch", ...ids };
  const b = own(given, "budget");
  if (!isObj(b) || !keysAre(b, ["spent_today_micro_usd", "reserved_micro_usd"], ["own_reservation_micro_usd"])) return { outcome: "refuse", reason: "budget_invalid", ...ids };
  const spent = b.spent_today_micro_usd;
  const reserved = b.reserved_micro_usd;
  const ownReservation = Object.hasOwn(b, "own_reservation_micro_usd") ? b.own_reservation_micro_usd : 0;
  if (!isCount(spent) || !isCount(reserved) || !isCount(ownReservation) || ownReservation > reserved) return { outcome: "refuse", reason: "budget_invalid", ...ids };

  const room = config.rooms.find((r) => r.room_id === ids.workspace_id);
  if (!room) return { outcome: "refuse", reason: "room_not_configured", ...ids };

  const inScope = (a: Actor) => a.org === null || a.org === config.owner_org || room.allowed_orgs.includes(a.org);
  if (!inScope(prov.requester)) return { outcome: "refuse", reason: "requester_out_of_scope", ...ids };
  if (prov.inputs.some((i) => !i.authors.every(inScope))) return { outcome: "refuse", reason: "author_out_of_scope", ...ids };

  if (spent + (reserved - ownReservation) + config.caps.spend_micro_usd > config.day_caps.spend_micro_usd)
    return { outcome: "refuse", reason: "day_budget_exhausted", ...ids };

  const requesterStanding = standing(prov.requester, config.owner_org);
  const authorStandings = prov.inputs.flatMap((i) => i.authors.map((a) => standing(a, config.owner_org)));
  const allInternal = requesterStanding === "internal" && authorStandings.every((s) => s === "internal") && prov.inputs.every((i) => !i.external);
  const isPublic = prov.room_visibility === "public";

  const facts: RunFacts = {
    adapter: config.adapter,
    tools: [...room.tools],
    shell: room.tools.includes("shell"),
    network: [...room.network],
    result_tool: RESULT_TOOL,
    workspace_root: config.workspace_root,
    task_folder: `${config.workspace_root}/${ids.workspace_id}/${ids.task_id}`,
    caps: { ...config.caps },
    outputs: room.outputs === "share" && allInternal && !isPublic ? "share" : "hold",
    policy_revision: config.revision,
    room_visibility: prov.room_visibility,
    prompt_inputs: prompt.inputs,
    change_request_event_id: prompt.event,
    requester: label(prov.requester),
    authors: prov.inputs.map((i) => ({ input: i.input, authors: i.authors.map(label) })),
  };
  // The reservation left out of the day's count, so consume can hold it to the decision's own (L5, bound 2026-11-18).
  const excluded = { excluded_reservation_micro_usd: ownReservation };
  const ask = (reason: AskReason): Decision => ({ outcome: "ask", reason, ...ids, facts, ...excluded });

  if (room.mode !== "unattended") return ask("room_ask_first");
  if (requesterStanding !== "internal") return ask(`requester_${requesterStanding}`);
  for (const i of prov.inputs) {
    for (const a of i.authors) {
      const s = standing(a, config.owner_org);
      if (s !== "internal") return ask(`author_${s}`);
    }
  }
  // Every author reads as internal here, so only the server's own flag on an input is left: it wins too.
  if (!allInternal) return ask("author_external");
  if (!room.acknowledged.trust_statement) return ask("trust_statement_not_accepted");
  if (isPublic && !room.acknowledged.public_room_warning) return ask("public_warning_not_accepted");
  return { outcome: "run", reason: "unattended_eligible", ...ids, facts, ...excluded };
}

/** One string for a value, its object keys sorted, so two equal fact sets always give the same form. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Obj;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** What a run decision is bound to beyond the policy's facts: the task's version, its inputs' hash, repository and base. */
export type RunBinding = {
  task_id: string;
  workspace_id: string;
  task_version: number;
  /** SHA-256 of the exact prompt bytes the policy evaluated, in lower-case hex, computed by the caller. */
  input_hash: string;
  repository_id: string | null;
  base_commit: string | null;
};
export type RunDecisionRecord = RunBinding & {
  mode: "unattended" | "approved";
  prompt_inputs: InputName[];
  change_request_event_id: string | null;
  /** The canonical form of the whole `RunFacts` the decision was made on (M1 on #455's review). */
  facts_key: string;
  reserved_micro_usd: number;
  issued_at: number;
  expires_at: number;
  consumed: boolean;
};
export type IssueRefusal = "refused" | "owner_approval_needed" | "reservation_excluded" | "binding_invalid" | "clock_invalid";
export type ConsumeRefusal = "record_invalid" | "clock_invalid" | "consumed" | "expired" | "refused" | "no_longer_eligible" | "reservation_mismatch" | "binding_changed" | "facts_changed";

const BINDING_KEYS = ["task_id", "workspace_id", "task_version", "input_hash", "repository_id", "base_commit"] as const;

function bindingOf(v: unknown, extra: readonly string[] = []): RunBinding | null {
  if (!isObj(v) || !keysAre(v, [...BINDING_KEYS, ...extra])) return null;
  const { task_id, workspace_id, task_version, input_hash, repository_id, base_commit } = v;
  if (!isId(task_id) || !isId(workspace_id) || !isCount(task_version)) return null;
  if (typeof input_hash !== "string" || !HEX64.test(input_hash)) return null;
  if (repository_id === null) {
    if (base_commit !== null) return null;
  } else if (!isId(repository_id) || typeof base_commit !== "string" || !COMMIT.test(base_commit)) return null;
  return { task_id, workspace_id, task_version, input_hash, repository_id: repository_id as string | null, base_commit: base_commit as string | null };
}

const RECORD_KEYS = ["mode", "prompt_inputs", "change_request_event_id", "facts_key", "reserved_micro_usd", "issued_at", "expires_at", "consumed"] as const;

/** A stored record, checked whole before anything compares it (L2 on #455's review). */
function parseRecord(raw: unknown): RunDecisionRecord | null {
  const v = copy(raw);
  const binding = bindingOf(v, RECORD_KEYS);
  if (!binding || !isObj(v)) return null;
  const { mode, prompt_inputs, change_request_event_id, facts_key, reserved_micro_usd, issued_at, expires_at, consumed } = v;
  if (mode !== "unattended" && mode !== "approved") return null;
  if (!isInputList(prompt_inputs)) return null;
  if (prompt_inputs.includes("change_request") ? !isId(change_request_event_id) : change_request_event_id !== null) return null;
  if (typeof facts_key !== "string" || facts_key.length < 2 || facts_key.length > MAX_FACTS_KEY) return null;
  if (!inRange(reserved_micro_usd, 1, CEILINGS.spend_micro_usd)) return null;
  if (!isCount(issued_at) || expires_at !== issued_at + DECISION_TTL_MS) return null;
  if (typeof consumed !== "boolean") return null;
  return { ...binding, mode, prompt_inputs: [...prompt_inputs], change_request_event_id: change_request_event_id as string | null, facts_key, reserved_micro_usd, issued_at, expires_at, consumed };
}

const isDecision = (d: unknown): d is Decision & { outcome: "ask" | "run" } =>
  isObj(d) && (d.outcome === "ask" || d.outcome === "run") && isId(d.task_id) && isId(d.workspace_id) && isObj(d.facts) && isCount(d.excluded_reservation_micro_usd);

/**
 * A run decision for a `run`, or for an `ask` the owner approved on this machine. Never for a refusal. Single-use, it
 * expires `DECISION_TTL_MS` after `now`, and it reserves the task's spend cap against the day's.
 */
export function issueRunDecision(decision: Decision, binding: RunBinding, now: number, opts: { approved_by_owner?: boolean } = {}):
  { ok: true; record: RunDecisionRecord } | { ok: false; reason: IssueRefusal } {
  try {
    const d = copy(decision);
    if (!isDecision(d)) return { ok: false, reason: "refused" };
    const o = copy(opts);
    const approved = isObj(o) && own(o, "approved_by_owner") === true;
    if (d.outcome === "ask" && !approved) return { ok: false, reason: "owner_approval_needed" };
    // No own reservation exists before issue, so an evaluation that left one out skipped counting other runs.
    if (d.excluded_reservation_micro_usd !== 0) return { ok: false, reason: "reservation_excluded" };
    if (!isCount(now)) return { ok: false, reason: "clock_invalid" };
    const b = bindingOf(copy(binding));
    if (!b || b.task_id !== d.task_id || b.workspace_id !== d.workspace_id) return { ok: false, reason: "binding_invalid" };
    const f = d.facts;
    return {
      ok: true,
      record: {
        ...b,
        mode: d.outcome === "run" ? "unattended" : "approved",
        prompt_inputs: [...f.prompt_inputs],
        change_request_event_id: f.change_request_event_id,
        facts_key: canonical(f),
        reserved_micro_usd: f.caps.spend_micro_usd,
        issued_at: now,
        expires_at: now + DECISION_TTL_MS,
        consumed: false,
      },
    };
  } catch {
    return { ok: false, reason: "refused" };
  }
}

/**
 * Spends a run decision at the run's start, against a fresh `evaluate` on a fresh `get_task` (with this decision's own
 * reservation passed as `own_reservation_micro_usd`) and the binding as it now stands: every run passes policy, not just
 * the first. Any difference in the run facts, whatever the policy's revision says, or in the task, its version, input
 * hash, repository or base, refuses it; so does an unattended decision whose fresh evaluation no longer says `run`.
 * Returns the record marked consumed, for the caller to store before starting.
 */
export function consumeRunDecision(stored: RunDecisionRecord, fresh: Decision, binding: RunBinding, now: number):
  { ok: true; record: RunDecisionRecord } | { ok: false; reason: ConsumeRefusal } {
  try {
    const record = parseRecord(stored);
    if (!record) return { ok: false, reason: "record_invalid" };
    if (!isCount(now) || now < record.issued_at) return { ok: false, reason: "clock_invalid" };
    if (record.consumed) return { ok: false, reason: "consumed" };
    if (now > record.expires_at) return { ok: false, reason: "expired" };
    const d = copy(fresh);
    if (!isDecision(d)) return { ok: false, reason: "refused" };
    if (record.mode === "unattended" && d.outcome !== "run") return { ok: false, reason: "no_longer_eligible" };
    // The fresh evaluation may leave out this decision's own reservation, as the record holds it, and nothing else.
    const excluded = d.excluded_reservation_micro_usd;
    if (excluded !== 0 && excluded !== record.reserved_micro_usd) return { ok: false, reason: "reservation_mismatch" };
    const b = bindingOf(copy(binding));
    if (!b) return { ok: false, reason: "binding_changed" };
    const same = BINDING_KEYS.every((k) => b[k] === record[k]) && d.task_id === record.task_id && d.workspace_id === record.workspace_id;
    if (!same) return { ok: false, reason: "binding_changed" };
    if (canonical(d.facts) !== record.facts_key) return { ok: false, reason: "facts_changed" };
    return { ok: true, record: { ...record, consumed: true } };
  } catch {
    return { ok: false, reason: "record_invalid" };
  }
}
