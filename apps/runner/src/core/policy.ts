/**
 * Runner's run policy (M7 step 7; RUNNER.md "Run policy and budget"; decision 29 as the owner ruled it on 2026-11-17).
 * Pure: it imports nothing, reads no clock (`now` is an input), uses no randomness and does no I/O. A test holds it so.
 *
 * Inputs: the owner's local configuration (rooms, the organizations allowed in each, run mode, tools, network, caps),
 * the task's IDs, its `provenance` from `get_task`, whether Runner's authority is fresh (`Poller.authorityFresh()`,
 * passed in as a value), the day's spend and reservations, and `now`. Output: ask, run or refuse, with a reason code.
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
 * - **The room split.** B: the owner's own private room runs with no acknowledgement. A: a public room, or a room
 *   configured for other organizations' authors, runs only once the owner accepted the trust statement for it, and a
 *   public room also the public-room warning (decision 232).
 * - **Caps** on spend, run time, turns and output tokens, and the bounded `max_tokens` the broker writes into each
 *   request, are required, each a positive integer under a fixed ceiling, with no "none" (condition 3; spike B rulings 3
 *   and 5). A configuration lacking any of them is refused whole, as is anything else malformed.
 * - **Tools and network** are facts for step 9's adapter, which enforces them: no shell and no network unless listed by
 *   name (condition 2). The adapter's result tool is always named.
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

/** Fixed ceilings. A cap can be set lower, never above, and never unset. */
export const CEILINGS = {
  spend_micro_usd: 100_000_000,
  run_time_ms: 24 * 60 * 60 * 1000,
  turns: 1_000,
  output_tokens: 1_000_000,
  max_tokens: 32_000,
} as const;
export const MIN_RUN_TIME_MS = 60_000;
export const DAY_SPEND_CEILING_MICRO_USD = 1_000_000_000;
/** How long a run decision may wait before it is used. */
export const DECISION_TTL_MS = 10 * 60 * 1000;

const MAX_ROOMS = 200;
const MAX_ORGS = 50;
const MAX_HOSTS = 50;
const MAX_AUTHORS = 1_000;
const MAX_ROOT = 1_024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
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
  /** Who wrote each input and the requester, as `id@org`, `?` for unknown; a run decision is bound to it. */
  requester: string;
  authors: { input: InputName; authors: string[] }[];
};

export type Decision =
  | { outcome: "refuse"; reason: RefuseReason; task_id?: string; workspace_id?: string; facts?: undefined }
  | { outcome: "ask"; reason: AskReason; task_id: string; workspace_id: string; facts: RunFacts }
  | { outcome: "run"; reason: RunReason; task_id: string; workspace_id: string; facts: RunFacts };

export type EvaluateInput = {
  /** The owner's configuration, as read from Runner's local file: checked here, so a malformed one refuses. */
  config: unknown;
  /** `get_task`'s `provenance`. */
  provenance: unknown;
  /** The task, by its IDs. Anything else on it, its text included, is ignored. */
  task: unknown;
  /** `Poller.authorityFresh()`. Only `true` passes. */
  authority_fresh: unknown;
  /** Spend counted today and budget reserved by runs in flight, in micro-USD. */
  budget: unknown;
  now: unknown;
};

type Obj = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; at: string };
const fail = (at: string): { ok: false; at: string } => ({ ok: false, at });

function isObj(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
/** Exactly these keys, the optional ones allowed to be absent. */
function keysAre(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => Object.hasOwn(o, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const inRange = (v: unknown, min: number, max: number): v is number => isCount(v) && v >= min && v <= max;

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
  if (!isId(v.room_id)) return fail("rooms[].room_id");
  const mode = v.mode ?? "ask";
  if (mode !== "ask" && mode !== "unattended") return fail("rooms[].mode");
  const allowed = uniqueList(v.allowed_orgs, MAX_ORGS, isId);
  if (!allowed || allowed.includes(ownerOrg)) return fail("rooms[].allowed_orgs");
  const tools = v.tools === undefined ? [...DEFAULT_TOOLS] : uniqueList(v.tools, TOOLS.length, isTool);
  if (!tools) return fail("rooms[].tools");
  const network = v.network === undefined ? [] : uniqueList(v.network, MAX_HOSTS, isHost);
  if (!network) return fail("rooms[].network");
  const outputs = v.outputs ?? "hold";
  if (outputs !== "hold" && outputs !== "share") return fail("rooms[].outputs");
  const ack = v.acknowledged;
  if (!isObj(ack) || !keysAre(ack, ["trust_statement", "public_room_warning"])) return fail("rooms[].acknowledged");
  if (typeof ack.trust_statement !== "boolean" || typeof ack.public_room_warning !== "boolean") return fail("rooms[].acknowledged");
  return {
    ok: true,
    value: { room_id: v.room_id, mode, allowed_orgs: allowed, tools, network, outputs, acknowledged: { trust_statement: ack.trust_statement, public_room_warning: ack.public_room_warning } },
  };
}

/** Checks the owner's configuration whole. Anything missing, unknown or out of range refuses it: fail closed. */
export function parsePolicyConfig(raw: unknown): Parsed<PolicyConfig> {
  try {
    if (!isObj(raw) || !keysAre(raw, ["version", "revision", "owner_org", "adapter", "workspace_root", "caps", "day_caps", "rooms"])) return fail("config");
    if (raw.version !== POLICY_VERSION) return fail("version");
    if (!inRange(raw.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
    if (!isId(raw.owner_org)) return fail("owner_org");
    const ownerOrg = raw.owner_org;
    if (typeof raw.adapter !== "string" || !(ADAPTERS as readonly string[]).includes(raw.adapter)) return fail("adapter");
    if (!isRoot(raw.workspace_root)) return fail("workspace_root");
    const caps = parseCaps(raw.caps);
    if (!caps.ok) return caps;
    const day = raw.day_caps;
    if (!isObj(day) || !keysAre(day, ["spend_micro_usd"])) return fail("day_caps");
    if (!inRange(day.spend_micro_usd, caps.value.spend_micro_usd, DAY_SPEND_CEILING_MICRO_USD)) return fail("day_caps.spend_micro_usd");
    if (!Array.isArray(raw.rooms) || raw.rooms.length > MAX_ROOMS) return fail("rooms");
    const rooms: RoomPolicy[] = [];
    for (const r of raw.rooms) {
      const room = parseRoom(r, ownerOrg);
      if (!room.ok) return room;
      if (rooms.some((x) => x.room_id === room.value.room_id)) return fail("rooms[].room_id");
      rooms.push(room.value);
    }
    return {
      ok: true,
      value: { version: 1, revision: raw.revision, owner_org: ownerOrg, adapter: raw.adapter as Adapter, workspace_root: raw.workspace_root, caps: caps.value, day_caps: { spend_micro_usd: day.spend_micro_usd }, rooms },
    };
  } catch {
    return fail("config");
  }
}

type Actor = { id: string | null; org: string | null; external: boolean; active: boolean };
type Provenance = { room_visibility: "private" | "public"; requester: Actor & { id: string }; inputs: { input: InputName; external: boolean; authors: Actor[] }[] };

const isOrg = (v: unknown): v is string | null => v === null || isId(v);

function parseAuthor(v: unknown): Actor | null {
  if (!isObj(v) || !keysAre(v, ["id", "org", "external", "active", "written_at"])) return null;
  if (!(v.id === null || isId(v.id)) || !isOrg(v.org)) return null;
  if (typeof v.external !== "boolean" || typeof v.active !== "boolean") return null;
  if (!(v.written_at === null || isCount(v.written_at))) return null;
  return { id: v.id, org: v.org, external: v.external, active: v.active };
}

/** Checks `get_task`'s provenance against the contract's `TaskProvenance`, strictly. */
function parseProvenance(v: unknown): Provenance | null {
  if (!isObj(v) || !keysAre(v, ["room_visibility", "requester", "inputs"])) return null;
  if (v.room_visibility !== "private" && v.room_visibility !== "public") return null;
  const r = v.requester;
  if (!isObj(r) || !keysAre(r, ["id", "org", "external", "active"]) || !isId(r.id) || !isOrg(r.org)) return null;
  if (typeof r.external !== "boolean" || typeof r.active !== "boolean") return null;
  if (!Array.isArray(v.inputs) || v.inputs.length < 2 || v.inputs.length > INPUTS.length) return null;
  const inputs: Provenance["inputs"] = [];
  let last = -1;
  for (const i of v.inputs) {
    if (!isObj(i) || !keysAre(i, ["input", "external", "authors"], ["event_id"])) return null;
    const at = INPUTS.indexOf(i.input as InputName);
    if (at <= last) return null;
    last = at;
    if (Object.hasOwn(i, "event_id") && (i.input !== "change_request" || !(i.event_id === null || isId(i.event_id)))) return null;
    if (typeof i.external !== "boolean") return null;
    if (!Array.isArray(i.authors) || i.authors.length < 1 || i.authors.length > MAX_AUTHORS) return null;
    const authors: Actor[] = [];
    for (const a of i.authors) {
      const author = parseAuthor(a);
      if (!author) return null;
      authors.push(author);
    }
    inputs.push({ input: i.input as InputName, external: i.external, authors });
  }
  if (inputs[0].input !== "title" || inputs[1].input !== "instructions") return null;
  return { room_visibility: v.room_visibility, requester: { id: r.id, org: r.org, external: r.external, active: r.active }, inputs };
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
  const parsed = parsePolicyConfig(input.config);
  if (!parsed.ok) return { outcome: "refuse", reason: "config_invalid" };
  const config = parsed.value;
  if (!isCount(input.now)) return { outcome: "refuse", reason: "clock_invalid" };
  const t = input.task;
  if (!isObj(t) || !isId(t.id) || !isId(t.workspace_id)) return { outcome: "refuse", reason: "task_invalid" };
  const ids = { task_id: t.id, workspace_id: t.workspace_id };
  if (input.authority_fresh !== true) return { outcome: "refuse", reason: "authority_stale", ...ids };
  const prov = parseProvenance(input.provenance);
  if (!prov) return { outcome: "refuse", reason: "provenance_invalid", ...ids };
  const b = input.budget;
  if (!isObj(b) || !keysAre(b, ["spent_today_micro_usd", "reserved_micro_usd"]) || !isCount(b.spent_today_micro_usd) || !isCount(b.reserved_micro_usd))
    return { outcome: "refuse", reason: "budget_invalid", ...ids };

  const room = config.rooms.find((r) => r.room_id === ids.workspace_id);
  if (!room) return { outcome: "refuse", reason: "room_not_configured", ...ids };

  const inScope = (a: Actor) => a.org === null || a.org === config.owner_org || room.allowed_orgs.includes(a.org);
  if (!inScope(prov.requester)) return { outcome: "refuse", reason: "requester_out_of_scope", ...ids };
  if (prov.inputs.some((i) => !i.authors.every(inScope))) return { outcome: "refuse", reason: "author_out_of_scope", ...ids };

  if (b.spent_today_micro_usd + b.reserved_micro_usd + config.caps.spend_micro_usd > config.day_caps.spend_micro_usd)
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
    requester: label(prov.requester),
    authors: prov.inputs.map((i) => ({ input: i.input, authors: i.authors.map(label) })),
  };
  const ask = (reason: AskReason): Decision => ({ outcome: "ask", reason, ...ids, facts });

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
  if ((isPublic || room.allowed_orgs.length > 0) && !room.acknowledged.trust_statement) return ask("trust_statement_not_accepted");
  if (isPublic && !room.acknowledged.public_room_warning) return ask("public_warning_not_accepted");
  return { outcome: "run", reason: "unattended_eligible", ...ids, facts };
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
  adapter: Adapter;
  policy_revision: number;
  room_visibility: "private" | "public";
  requester: string;
  authors: RunFacts["authors"];
  reserved_micro_usd: number;
  issued_at: number;
  expires_at: number;
  consumed: boolean;
};
export type IssueRefusal = "refused" | "owner_approval_needed" | "binding_invalid" | "clock_invalid";
export type ConsumeRefusal = "clock_invalid" | "consumed" | "expired" | "refused" | "no_longer_eligible" | "binding_changed" | "facts_changed" | "record_invalid";

function bindingOk(b: unknown): b is RunBinding {
  if (!isObj(b) || !keysAre(b, ["task_id", "workspace_id", "task_version", "input_hash", "repository_id", "base_commit"])) return false;
  if (!isId(b.task_id) || !isId(b.workspace_id) || !isCount(b.task_version)) return false;
  if (typeof b.input_hash !== "string" || !HEX64.test(b.input_hash)) return false;
  if (b.repository_id === null) return b.base_commit === null;
  return isId(b.repository_id) && typeof b.base_commit === "string" && COMMIT.test(b.base_commit);
}

const sameAuthors = (a: RunFacts["authors"], b: RunFacts["authors"]) =>
  a.length === b.length && a.every((x, i) => x.input === b[i].input && x.authors.length === b[i].authors.length && x.authors.every((y, j) => y === b[i].authors[j]));

/**
 * A run decision for a `run`, or for an `ask` the owner approved on this machine. Never for a refusal. Single-use, it
 * expires `DECISION_TTL_MS` after `now`, and it reserves the task's spend cap against the day's.
 */
export function issueRunDecision(decision: Decision, binding: RunBinding, now: number, opts: { approved_by_owner?: boolean } = {}):
  { ok: true; record: RunDecisionRecord } | { ok: false; reason: IssueRefusal } {
  if (decision.outcome === "refuse") return { ok: false, reason: "refused" };
  if (decision.outcome === "ask" && opts.approved_by_owner !== true) return { ok: false, reason: "owner_approval_needed" };
  if (!isCount(now)) return { ok: false, reason: "clock_invalid" };
  if (!bindingOk(binding) || binding.task_id !== decision.task_id || binding.workspace_id !== decision.workspace_id) return { ok: false, reason: "binding_invalid" };
  const f = decision.facts;
  return {
    ok: true,
    record: {
      task_id: binding.task_id,
      workspace_id: binding.workspace_id,
      task_version: binding.task_version,
      input_hash: binding.input_hash,
      repository_id: binding.repository_id,
      base_commit: binding.base_commit,
      mode: decision.outcome === "run" ? "unattended" : "approved",
      adapter: f.adapter,
      policy_revision: f.policy_revision,
      room_visibility: f.room_visibility,
      requester: f.requester,
      authors: f.authors.map((x) => ({ input: x.input, authors: [...x.authors] })),
      reserved_micro_usd: f.caps.spend_micro_usd,
      issued_at: now,
      expires_at: now + DECISION_TTL_MS,
      consumed: false,
    },
  };
}

/**
 * Spends a run decision at the run's start, against a fresh `evaluate` on a fresh `get_task` and the binding as it now
 * stands: every run passes policy, not just the first. Any change to the task, its version, inputs, authors, room
 * visibility, adapter, repository, base or the policy's revision refuses it; so does an unattended decision whose fresh
 * evaluation no longer says `run`. Returns the record marked consumed, for the caller to store before starting.
 */
export function consumeRunDecision(record: RunDecisionRecord, fresh: Decision, binding: RunBinding, now: number):
  { ok: true; record: RunDecisionRecord } | { ok: false; reason: ConsumeRefusal } {
  if (!isObj(record) || !isCount(record.issued_at) || !isCount(record.expires_at)) return { ok: false, reason: "record_invalid" };
  if (!isCount(now) || now < record.issued_at) return { ok: false, reason: "clock_invalid" };
  if (record.consumed !== false) return { ok: false, reason: "consumed" };
  if (now > record.expires_at) return { ok: false, reason: "expired" };
  if (fresh.outcome === "refuse") return { ok: false, reason: "refused" };
  if (record.mode === "unattended" && fresh.outcome !== "run") return { ok: false, reason: "no_longer_eligible" };
  if (!bindingOk(binding)) return { ok: false, reason: "binding_changed" };
  const sameBinding =
    binding.task_id === record.task_id &&
    binding.workspace_id === record.workspace_id &&
    binding.task_version === record.task_version &&
    binding.input_hash === record.input_hash &&
    binding.repository_id === record.repository_id &&
    binding.base_commit === record.base_commit &&
    fresh.task_id === record.task_id &&
    fresh.workspace_id === record.workspace_id;
  if (!sameBinding) return { ok: false, reason: "binding_changed" };
  const f = fresh.facts;
  const sameFacts =
    f.adapter === record.adapter &&
    f.policy_revision === record.policy_revision &&
    f.room_visibility === record.room_visibility &&
    f.requester === record.requester &&
    f.caps.spend_micro_usd === record.reserved_micro_usd &&
    sameAuthors(f.authors, record.authors);
  if (!sameFacts) return { ok: false, reason: "facts_changed" };
  return { ok: true, record: { ...record, authors: record.authors.map((x) => ({ input: x.input, authors: [...x.authors] })), consumed: true } };
}
