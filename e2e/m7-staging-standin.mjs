// A preload m7-staging-selftest.mjs loads with --import: a stand-in for staging, so the conductor's whole flow runs on
// this machine with no network, no session and no person. It's never run by itself, and m7-staging.mjs refuses a gate
// run while it's loaded: only a rehearsal runs against it.
//
// It replaces fetch. Reads of the staging gateway are answered from a room it keeps here; a POST anywhere else is a
// probe of a nudge address, answered 401, or, for the probe after Runner stops, no connection. A task appears when the
// conductor prints the title it asks a person to make, and moves one step along its story after each read of the
// room's events or of the task, as a real room moves while the conductor waits. STANDIN_BREAK names a story to break,
// so the self-test can see a failure judged as one.
globalThis.__podsterM7Standin = true;

const STAGING = "https://gateway-staging.podster.dev";
const ME = "per_StandInOwner01";
const OTHER_PERSON = "per_StandInSecond02";
const ROOM = "ws_standin01";
const brk = process.env.STANDIN_BREAK ?? "";

let seq = 0;
let clock = Date.parse("2026-11-27T10:00:00Z");
const events = [];
const tasks = new Map();
let pendingTitle = null;
let pendingAgent = null;
/** Who the conductor last asked: the maker of a task is its reviewer. */
let speaker = "first";

/** Each story's steps after creation: [type, actor ("agent" or "reviewer"), new status, minutes later]. */
const STORIES = {
  ask: [["task.accepted", "agent", "accepted"], ["repo_access.issued", "agent"], ["task.submitted", "agent", "submitted"], ["task.completed", "reviewer", "completed"]],
  crash: [["task.accepted", "agent", "accepted"], ["repo_access.issued", "agent"], ["task.submitted", "agent", "submitted"], ["task.completed", "reviewer", "completed"]],
  offline: [["task.accepted", "agent", "accepted"], ["repo_access.issued", "agent"], ["task.canceled", "reviewer", "canceled"]],
  revoked: [["task.canceled", "reviewer", "canceled"]],
  scope: [["task.canceled", "reviewer", "canceled"]],
  budget: [["task.accepted", "agent", "accepted"], ["task.released", "agent", "offered"]],
  unattended: [["task.accepted", "agent", "accepted"], ["repo_access.issued", "agent"], ["task.submitted", "agent", "submitted"], ["task.changes_requested", "reviewer", "accepted"], ["repo_access.issued", "agent"], ["task.submitted", "agent", "submitted"], ["task.completed", "reviewer", "completed"]],
  grant: [["task.accepted", "agent", "accepted"]],
  long: [["task.accepted", "agent", "accepted"], ["repo_access.issued", "agent"], ["repo_access.issued", "agent", null, 70], ["task.submitted", "agent", "submitted", 1], ["task.completed", "reviewer", "completed"]],
  nudge: [["task.accepted", "agent", "accepted", 1], ["repo_access.issued", "agent"], ["task.submitted", "agent", "submitted"], ["task.completed", "reviewer", "completed"]],
};
if (brk === "duplicate-accept") STORIES.ask.splice(1, 0, ["task.accepted", "agent", "accepted"]);
if (brk === "submit-after-cancel") STORIES.offline.push(["task.submitted", "agent", "submitted"]);

function emit(task, type, actor, status, minutes = 0) {
  clock += minutes * 60_000 + 1000;
  const event = { seq: ++seq, id: `evt_${seq}`, type, actor_id: actor, actor_org: "org_standin", task_id: task.id, reason: null, prior_status: task.status, new_status: status ?? null, created_at: clock };
  if (status) task.status = status;
  events.push(event);
}

function create(title, agent, maker) {
  const tag = /\[m7-([a-z]+)(?:-(first|second))?-[0-9a-f]{6}\]/.exec(title);
  const story = tag?.[1] === "ask" || tag?.[1] === "unattended" || tag?.[1] === "nudge" ? tag[1] : tag?.[1];
  const task = { id: `tsk_standin${String(tasks.size + 1).padStart(3, "0")}`, title, agent, status: "offered", story: [...(STORIES[story] ?? [])], reviewer: maker === "second" ? OTHER_PERSON : ME };
  tasks.set(task.id, task);
  emit(task, "task.created", task.reviewer, "offered");
}

function advance() {
  for (const task of tasks.values()) {
    const next = task.story.shift();
    if (next) emit(task, next[0], next[1] === "agent" ? task.agent : task.reviewer, next[2], next[3]);
  }
}

// The conductor prints what a person makes; the stand-in makes it.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  for (const lineText of String(chunk).split("\n")) {
    const who = /^\[(First|Second) person/.exec(lineText);
    if (who) speaker = who[1].toLowerCase();
    const title = /^\s+title:\s+(.+)$/.exec(lineText);
    if (title) pendingTitle = title[1];
    const assignee = /^\s+assignee:\s+.*?(agt_[A-Za-z0-9_-]+)/.exec(lineText);
    if (assignee) pendingAgent = assignee[1];
    if (pendingTitle && pendingAgent) {
      create(pendingTitle, pendingAgent, speaker);
      pendingTitle = pendingAgent = null;
    }
  }
  return write(chunk, ...rest);
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  if (url.origin !== STAGING) {
    if (method === "POST" && init.body === "{}") throw new TypeError("fetch failed: no connection (stand-in: Runner stopped)");
    return json(401, { error: "unauthorized" });
  }
  if (method !== "GET") throw new Error(`stand-in: the conductor sent ${method} to staging, and it must write nothing`);
  if (!String(init.headers?.cookie ?? "").length) return json(401, { error: { code: "unauthenticated" } });
  const path = url.pathname.replace(/^\/api/, "");
  const agentsInRoom = [...new Set([...tasks.values()].map((t) => t.agent).concat(process.env.STANDIN_AGENTS?.split(",") ?? []))];
  if (path === "/v1/me") return json(200, { id: ME });
  if (path === `/v1/workspaces/${ROOM}`) {
    return json(200, { id: ROOM, policy_version: 3, owner: ME, members: [{ principal_id: ME, kind: "person", org_id: "org_a", role: "owner" }, { principal_id: OTHER_PERSON, kind: "person", org_id: "org_b", role: "member" }, ...agentsInRoom.map((id, i) => ({ principal_id: id, kind: "agent", org_id: i ? "org_b" : "org_a", role: "member" }))] });
  }
  if (path === `/v1/workspaces/${ROOM}/repository`) return json(200, { request: null, repository: { full_name: "podsterdev/standin", provider_repo_id: 1 } });
  if (path === `/v1/workspaces/${ROOM}/audit`) return json(200, { audit: brk === "agent-admin" ? [{ actor_id: agentsInRoom[0], action: "repo_grant.give", outcome: "allowed" }] : [{ actor_id: ME, action: "member.add", outcome: "allowed" }], next_cursor: null });
  if (path === `/v1/workspaces/${ROOM}/events`) {
    const after = Number(url.searchParams.get("after") ?? 0);
    const page = events.filter((e) => e.seq > after).slice(0, 50);
    const answer = json(200, { events: page, next_after: page.at(-1)?.seq ?? null });
    if (!page.length) advance();
    return answer;
  }
  if (path === `/v1/workspaces/${ROOM}/tasks`) return json(200, { tasks: [...tasks.values()].reverse().map((t) => ({ id: t.id, title: t.title, status: t.status })), next_cursor: null });
  const detail = /^\/v1\/workspaces\/ws_standin01\/tasks\/(tsk_[a-z0-9]+)$/.exec(path);
  if (detail) {
    const task = tasks.get(detail[1]);
    if (!task) return json(404, { error: { code: "task_not_found" } });
    const answer = json(200, { task: { id: task.id, title: task.title, status: task.status, reviewer: task.reviewer, assignee: task.agent, due_at: null, version: 1 }, change: { pr_number: 7, head_in_repository: true, base_is_default: true }, submissions: [], artifacts: [], files: [], messages: [], history: [] });
    advance();
    return answer;
  }
  const endpoint = /^\/v1\/agents\/(agt_[A-Za-z0-9_-]+)\/a2a-endpoint(\/nudge)?$/.exec(path);
  if (endpoint) {
    if (!endpoint[2]) return json(200, null);
    return json(200, { endpoint: { url: "https://nudge.example.org/podster/nudge", version: 2, control: "verified", nudge_on: true, consecutive_failures: 0 }, history: [{ type: "nudge_on", actor_id: ME, version: 2 }, { type: "verified", actor_id: endpoint[1], version: 2 }, { type: "challenge_sent", actor_id: endpoint[1], version: 2 }] });
  }
  return json(404, { error: { code: "not_found" } });
};
