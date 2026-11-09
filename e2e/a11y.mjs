// UI-10 and UI-11: axe, including contrast, on the dashboard's screens in light and dark, and keyboard-only paths for
// creating a room, reviewing a task and revoking access. It uses the real Workers in a real browser, because jsdom can't
// compute contrast. A screen reader isn't run, so UI-10's announcements are checked only as live regions in the page.
//
//   node run-a11y.mjs [--skip-build] [--browser=firefox|webkit]
//
// CI runs Chromium. Playwright's Firefox and WebKit are engines it builds itself, so a pass there isn't a pass in Safari or a released Firefox.
//
// A violation fails the run unless a11y-known.json lists it, with the file to fix. A listed one that's gone fails too, so
// the list can't go stale. Results go to results/a11y-<time>.json.
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as playwright from "playwright";
import { seedInputAssets } from "./asset-fixture.mjs";
import { AuthAgent, key, ok, Person, Target } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = process.env.PODSTER_A11Y_APP;
const gatewayBase = process.env.PODSTER_A11Y_GATEWAY;
ok(app && gatewayBase, "Run this through run-a11y.mjs, which starts the Workers.");
const known = JSON.parse(readFileSync(join(here, "a11y-known.json"), "utf8"));
const ORG_COOKIE = "podster-org";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const target = new Target(gatewayBase, { pollMs: 150 });

const CANT_FORMAT = "This text can't be formatted";


/**
 * Screen 9c's second block: an output whose task's submission carries a file. Before the Workers restart, the agent uploads
 * the file for its task, and it ends in `scanning`. After the runner marks it Ready, `approveThenRemove` submits it, approves
 * it, which makes the output Ready, and removes the file, which leaves the output Ready with `files_available` false.
 */
async function uploadOutputFile({ gatewayBase, owner, agent, room }) {
  const base = `/v1/workspaces/${room}`;
  const output = await owner.must("POST", `${base}/outputs`, { title: "Signed contract", description: "Its approved file was removed after approval." });
  const task = await owner.must("POST", `${base}/tasks`, { title: "Send the signed contract", instructions: "Ordinary", assignee: agent.id, expected_output_id: output.id });
  const at = { workspace_id: room, task_id: task.id };
  const taken = await agent.must("accept_task", { ...at, version: task.version });
  const bytes = Buffer.from("Removed output file fixture\nPlain text for the accessibility run.\n");
  const upload = await agent.must("create_upload", { ...at, name: "Signed contract.txt", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const sent = await fetch(`${gatewayBase}${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: bytes });
  const answer = await sent.json().catch(() => null);
  ok(sent.ok && answer?.state === "scanning", `uploading the output's file answered ${sent.status} ${answer?.error?.code ?? answer?.state ?? ""}`);
  return {
    fileId: upload.id,
    approveThenRemove: async () => {
      const submitted = await agent.must("submit_task", { ...at, version: taken.version, note: "Signed", files: [{ id: upload.id }] });
      await owner.must("POST", `${base}/tasks/${task.id}/verify`, { submission_no: submitted.submission_no });
      await owner.must("POST", `${base}/files/${upload.id}/remove`);
    },
  };
}

/** Screen 9c's block: outputs Not started, In review and Ready, with a description that has markup in it, kept as text. */
async function seedOutputs(owner, agent) {
  const outputsRoom = await owner.createRoom("Outputs room");
  await owner.addAgent(outputsRoom, agent);
  const base = `/v1/workspaces/${outputsRoom}`;
  const define = (title, description) => owner.must("POST", `${base}/outputs`, { title, ...(description ? { description } : {}) });
  await define("Pricing page", "Not started yet, with <b>markup</b> that stays text.");
  const inReview = await define("Launch plan");
  const ready = await define("Design doc", "The API's design, as **one** document.");
  const work = async (title, output) => {
    const task = await owner.must("POST", `${base}/tasks`, { title, instructions: "Ordinary", assignee: agent.id, expected_output_id: output.id });
    const at = { workspace_id: outputsRoom, task_id: task.id };
    const taken = await agent.must("accept_task", { ...at, version: task.version });
    return agent.must("submit_task", { ...at, version: taken.version, note: "Ready", artifacts: [{ uri: "https://example.com/design", label: "Design" }] });
  };
  await work("Write the launch plan", inReview);
  const approved = await work("Write the design doc", ready);
  await owner.must("POST", `${base}/tasks/${approved.id}/verify`, { submission_no: approved.submission_no });
  return { room: outputsRoom, readyTask: approved.id };
}

/** What the screens need to show every state: each task status, an agent's text, an external author, and a pending link. */
async function seed() {
  const [owner, partner] = [await signUp("Ada Owner"), await signUp("Bea Partner")];
  const room = await owner.createRoom("Billing v2");
  const emptyRoom = await owner.createRoom("Empty room");
  const lead = await AuthAgent.connect(target, owner, "Lead agent");
  const revokee = await AuthAgent.connect(target, owner, "Revokee agent");
  await owner.addAgent(room, lead);
  await owner.addAgent(room, revokee);
  const guest = await AuthAgent.connect(target, partner, "Partner agent");
  const invitation = await owner.invite(room, partner.org);
  ok((await partner.accept(invitation.token, partner.org, [guest])).ok, "the partner's agent joining");
  const at = (task) => ({ workspace_id: room, task_id: task.id });
  const make = (title, extra = {}) => lead.must("create_task", { workspace_id: room, title, instructions: "**Write** the design, and [link](https://example.com) the result.\n\n- One\n- Two", ...extra });

  await make("An open task");
  // An unbroken title has to wrap inside a card on a phone, not widen the page.
  await make(`A_task_with_a_long_unbroken_title_${"x".repeat(120)}`);
  await make("An offered task", { assignee: guest.id });
  const accepted = await make("An accepted task", { assignee: guest.id });
  await guest.must("accept_task", { ...at(accepted), version: accepted.version });
  const submit = async (title, reviewer, extra = {}) => {
    const task = await make(title, { assignee: guest.id, reviewer, ...extra });
    const taken = await guest.must("accept_task", { ...at(task), version: task.version });
    await guest.must("send_message", { ...at(task), body: "A question **about** scope, with `code` and <b>inert HTML</b>." });
    return guest.must("submit_task", { ...at(task), version: taken.version, note: "Ready for review", artifacts: [{ uri: "https://example.com/pr/1", label: "Pull request" }] });
  };
  await make("Plan the first step");
  await make("Plan the second step");
  const review = await submit("Task for keyboard review", owner.id);
  const reviewScreen = await submit("Task for the review screen", owner.id, { instructions: `**Write** the design.\n\n# A heading\n\n- [x] A marked item\n- [ ] An unmarked item\n\n| Column one | Column two |\n| --- | --- |\n| ${"unbroken".repeat(30)} | **two** |\n\n| Narrow |\n| --- |\n| Fits |` });
  // A few bytes that ask for millions of cells: instructions at their limit, which display cuts to 20,000 characters, and a message at its limit.
  const paddedTable = (size) => {
    const columns = Math.floor(size / 8);
    return `${"|a".repeat(columns)}\n${"|-".repeat(columns)}\n${"a\n".repeat(Math.floor((size - 4 * columns) / 2) - 2)}`;
  };
  const K16 = 16 * 1024;
  const oversized = await make("Task with oversized tables", { assignee: guest.id, instructions: paddedTable(20_000).padEnd(64 * 1024, "a\n") });
  await guest.must("accept_task", { ...at(oversized), version: oversized.version });
  await guest.must("send_message", { ...at(oversized), body: paddedTable(16 * 1024) });
  // What a whole screen can cost: the shapes that took longest to parse, on one task. About 34 s to open before bodies were deferred.
  const fill = (unit) => unit.repeat(Math.ceil(K16 / unit.length)).slice(0, K16);
  const runOfMarks = `${"**".repeat(4095)}a${"**".repeat(4095)}`;
  const heavy = [`${"*a _b ".repeat(1300)}x${" b_ a*".repeat(1300)}`, fill("]"), fill("a\n=\n"), fill(`${"- ".repeat(100)}x\n`), runOfMarks, fill("*"), fill("_")];
  const heavyThread = await make("Task with a heavy thread", { assignee: guest.id });
  await guest.must("accept_task", { ...at(heavyThread), version: heavyThread.version });
  for (let i = 0; i < 50; i++) await guest.must("send_message", { ...at(heavyThread), body: heavy[i % heavy.length] });
  // And shorter ones, at and around the length that's parsed at once, where each message costs the main thread a little.
  const short = (size) => ["*a _b ".repeat(Math.floor(size / 6)), "]".repeat(size), "a\n=\n".repeat(size / 4), "**".repeat(size / 2)];
  const heavyShort = [...short(2_000), ...short(500), `${"- ".repeat(100)}x\n`.repeat(9), `${"- ".repeat(10)}x\n`.repeat(21)];
  const shortThread = await make("Task with a heavy short thread", { assignee: guest.id });
  await guest.must("accept_task", { ...at(shortThread), version: shortThread.version });
  for (let i = 0; i < 50; i++) await guest.must("send_message", { ...at(shortThread), body: heavyShort[i % heavyShort.length] });
  // Unbroken text in scripts that cost a lot to lay out, at the message limit in bytes.
  const byBytes = (unit) => unit.repeat(Math.floor(K16 / Buffer.byteLength(unit)));
  const scripts = [byBytes("ع"), byBytes("ก"), byBytes("אa")];
  const scriptThread = await make("Task with unbroken scripts", { assignee: guest.id });
  await guest.must("accept_task", { ...at(scriptThread), version: scriptThread.version });
  for (let i = 0; i < 50; i++) await guest.must("send_message", { ...at(scriptThread), body: scripts[i % scripts.length] });
  const oneScript = async (title, body) => {
    const task = await make(title, { assignee: guest.id });
    await guest.must("accept_task", { ...at(task), version: task.version });
    for (let i = 0; i < 50; i++) await guest.must("send_message", { ...at(task), body });
    return task;
  };
  const arabicThread = await oneScript("Task with unbroken Arabic", byBytes("ع"));
  const hebrewLatinThread = await oneScript("Task with alternating directions", byBytes("אa"));
  // Long bodies whose results soon use up what can be applied out of view: for keeping the reader's place, and for how far ahead they format.
  const tallThread = await make("Task with tall messages", { assignee: guest.id });
  await guest.must("accept_task", { ...at(tallThread), version: tallThread.version });
  for (let i = 0; i < 20; i++) await guest.must("send_message", { ...at(tallThread), body: `Message ${i} ${"**b** ".repeat(1500)}` });
  // Long bodies with ordinary links, for reaching them by keyboard.
  const linkThread = await make("Task with links in long messages", { assignee: guest.id });
  await guest.must("accept_task", { ...at(linkThread), version: linkThread.version });
  for (let i = 0; i < 6; i++) await guest.must("send_message", { ...at(linkThread), body: `[link ${i}](https://example.com/${i})\n\n${"## A heading\n\n- A bullet with some words\n- Another bullet\n\n".repeat(120)}`.slice(0, 8 * 1024) });
  const numberedBrief = await make("Task with a long numbered list", { instructions: Array.from({ length: 120 }, (_, i) => `${i + 1}. An item`).join("\n") });
  const composeTask = await make("Task for the message box", { assignee: guest.id });
  // A long brief that has to end up formatted: this proves the worker runs, under the real CSP, from the real build.
  // Nothing limits this one but the clock: it parses for over a second, with nothing deep and little rendered.
  const slowBrief = await make("Task with a slow brief", { instructions: runOfMarks });
  const longBrief = await make("Task with a long brief", { instructions: `**A bold start** and [a link](https://example.com/brief), caf&eacute;.\n\n${"Ordinary words in a long brief. ".repeat(150)}` });
  // Text that has crashed the tab. Each gets its own task, in its own room, so one failure can't hide another.
  const hostileRoom = await owner.createRoom("Hostile text");
  await owner.addAgent(hostileRoom, lead);
  const deepest = `${"- ".repeat(100)}x\n`;
  const hostile = [];
  for (const [label, instructions, note] of [
    ["quotes at the limit", `${">".repeat(100)} deep`, null],
    ["1,500 quotes", ">".repeat(1500), CANT_FORMAT],
    ["1,750 quotes", ">".repeat(1750), CANT_FORMAT],
    ["2,000 quotes", ">".repeat(2000), CANT_FORMAT],
    ["3,000 quotes", ">".repeat(3000), CANT_FORMAT],
    ["quotes at the message limit", ">".repeat(K16), CANT_FORMAT],
    ["quotes at the instructions limit", ">".repeat(64 * 1024), CANT_FORMAT],
    ["2 KB of bullets", "- ".repeat(1000), CANT_FORMAT],
    ["bullets at the message limit", "- ".repeat(K16 / 2), CANT_FORMAT],
    ["a mix at the message limit", "> - 1. ".repeat(Math.floor(K16 / 7)), CANT_FORMAT],
    ["CRLF ladder", Array.from({ length: 170 }, (_, i) => `${">".repeat(i)} a`).join("\r\n"), CANT_FORMAT],
    ["indented ladder", Array.from({ length: 125 }, (_, i) => `${"  ".repeat(i)}- a`).join("\n"), CANT_FORMAT],
    ["tabs behind a quote at the message limit", Array.from({ length: 70 }, (_, i) => `> ${"\t".repeat(i)}${"- ".repeat(98)}x`).join("\n").slice(0, K16), CANT_FORMAT],
    ["footnotes", "[^a]: ".repeat(Math.floor(K16 / 6)), CANT_FORMAT],
    ["inline nesting", `${"*a _b ".repeat(1300)}x${" b_ a*".repeat(1300)}`, CANT_FORMAT],
    ["a mix at the limit", `${"> - ".repeat(50)}deep`, null],
    ["the deepest allowed, once", deepest, null],
    ["the deepest allowed, repeated", deepest.repeat(Math.floor(K16 / deepest.length)), CANT_FORMAT],
    ["wide tables repeated", `| ${"w".repeat(300)} |\n| - |\n\n`.repeat(Math.floor(K16 / 312)), "too large to show as a table"],
  ]) hostile.push({ label, note, id: (await lead.must("create_task", { workspace_id: hostileRoom, title: `Hostile: ${label}`, instructions })).id });
  const done = await submit("A completed task", lead.id);
  await lead.must("verify_task", { ...at(done), submission_no: 1 });
  const canceled = await make("A canceled task");
  await lead.must("cancel_task", { ...at(canceled), version: canceled.version, reason: "No longer needed" });
  // A requester who leaves flags the task, which shows the attention colors.
  const leaver = await AuthAgent.connect(target, owner, "Departing agent");
  await owner.addAgent(room, leaver);
  await leaver.must("create_task", { workspace_id: room, title: "A task needing attention", instructions: "x" });
  await owner.revoke(room, leaver.id);

  const off = await AuthAgent.connect(target, owner, "Disconnected agent");
  await owner.must("POST", `/agents/${off.id}/disconnect`);
  // These pages need live links.
  const pending = await AuthAgent.register(target, "Pending agent");
  const roomInvite = await owner.invite(room, partner.org);
  const teamOrg = (await owner.must("POST", "/orgs", { name: "Ada team" })).id;
  const orgInvite = await owner.must("POST", `/orgs/${teamOrg}/invitations`, { role: "member" });
  // A workroom in that organization with an admin to transfer it to, and an archived one whose owner has left.
  const join = async (person, role) => person.must("POST", "/org-invitations/accept", { token: (await owner.must("POST", `/orgs/${teamOrg}/invitations`, { role })).token });
  const heir = await signUp("Cid Admin");
  await join(heir, "member");
  const inTeam = { org: teamOrg };
  const transferRoom = (await owner.must("POST", "/v1/workspaces", { name: "Room to hand over" }, inTeam)).id;
  await owner.must("POST", `/v1/workspaces/${transferRoom}/members`, { principal_id: heir.id, kind: "person", org_id: teamOrg, role: "admin", policy_version: await owner.policyVersion(transferRoom) }, inTeam);
  await join(partner, "admin");
  const ownerlessRoom = (await partner.must("POST", "/v1/workspaces", { name: "Room to recover" }, inTeam)).id;
  await partner.must("POST", `/v1/workspaces/${ownerlessRoom}/archive`, { policy_version: (await partner.must("GET", `/v1/workspaces/${ownerlessRoom}`, undefined, inTeam)).policy_version }, inTeam);
  const until = async (test, label) => {
    for (let tries = 0; tries < 50; tries++) {
      if (await test()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${label} never happened`);
  };
  await until(async () => (await partner.must("GET", "/v1/workspaces")).workspaces.some((w) => w.workspace_id === ownerlessRoom), "the workroom being listed");
  await owner.must("DELETE", `/orgs/${teamOrg}/members/${partner.id}`);
  await until(async () => (await owner.must("GET", "/v1/oversight/ownerless")).rooms.some((r) => r.workspace_id === ownerlessRoom), "the workroom reaching the ownerless list");
  // A workroom a person holds only as a guest, an agent narrowed to its own tasks, and work neither is party to, with words to look for anywhere.
  const SECRET = { title: "SECRET-TITLE-OTHERS", instructions: "SECRET-INSTRUCTIONS-OTHERS", message: "SECRET-MESSAGE-OTHERS", note: "SECRET-NOTE-OTHERS" };
  const viewer = await signUp("Gia Guest");
  await join(viewer, "member");
  const limitedRoom = (await owner.must("POST", "/v1/workspaces", { name: "Limited room" }, inTeam)).id;
  const inLimited = `/v1/workspaces/${limitedRoom}`;
  const version = async () => (await owner.must("GET", inLimited, undefined, inTeam)).policy_version;
  await owner.must("POST", `${inLimited}/members`, { principal_id: viewer.id, kind: "person", org_id: teamOrg, role: "guest", policy_version: await version() }, inTeam);
  const narrowed = await AuthAgent.connect(target, partner, "Narrowed agent");
  const otherWorker = await AuthAgent.connect(target, partner, "Other worker");
  const limitedInvite = await owner.must("POST", `${inLimited}/invitations`, { role: "member", invited_org_id: partner.org, policy_version: await version() }, inTeam);
  ok((await partner.accept(limitedInvite.token, partner.org, [narrowed, otherWorker])).ok, "the partner's agents joining the limited room");
  await owner.must("PUT", `${inLimited}/members/${narrowed.id}/access`, { scopes: { tasks: "own", artifacts: "own", conversations: "own" }, policy_version: await version() }, inTeam);
  const inRoom = (task) => ({ workspace_id: limitedRoom, task_id: task.id });
  const worked = async (agent, title, reviewer, extra = {}) => {
    const task = await owner.must("POST", `${inLimited}/tasks`, { title, instructions: extra.instructions ?? "Ordinary", assignee: agent.id, reviewer }, inTeam);
    const taken = await agent.must("accept_task", { ...inRoom(task), version: task.version });
    if (extra.message) await agent.must("send_message", { ...inRoom(task), body: extra.message });
    await agent.must("submit_task", { ...inRoom(task), version: taken.version, note: extra.note ?? "Ready", artifacts: [{ uri: "https://example.com/own", label: "Work" }] });
    return task;
  };
  const secretTask = await worked(otherWorker, SECRET.title, owner.id, SECRET);
  const viewerTask = await worked(narrowed, "Gia reviews this", viewer.id);
  // Screen 9c: expected outputs in each state, in a room of their own so other screens' counts don't move. Decision 138's
  // note, a Ready output whose file was removed after approval, is added there by the REMOVED OUTPUT FILE FIXTURE below.
  const outputs = await seedOutputs(owner, lead);
  const plan = await owner.must("GET", `${inLimited}/plan`, undefined, inTeam);
  await owner.must("PUT", `${inLimited}/tasks/${viewerTask.id}/plan`, { plan_revision: plan.plan_revision, predecessors: [secretTask.id] }, inTeam);
  const client = await (await target.post("/oauth/register", { redirect_uris: ["https://e2e-client.invalid/cb"], client_name: "A11y client", token_endpoint_auth_method: "none" })).json();
  const consent = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://e2e-client.invalid/cb", scope: "mcp", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "s" });
  const opening = (await owner.must("POST", `/v1/workspaces/${room}/roles`, { title: "Lead coordinator", responsibilities: "Plans the work and **follows up**.", is_lead: true, policy_version: (await owner.must("GET", `/v1/workspaces/${room}`)).policy_version })).id;
  // Hundreds of tasks, with the one review waiting for the owner on the last page, past anything the screen first reads.
  const longRoom = await owner.createRoom("Long room");
  const longWorker = await AuthAgent.connect(target, owner, "Long room agent");
  await owner.addAgent(longRoom, lead);
  await owner.addAgent(longRoom, longWorker);
  const inLong = (title, extra = {}) => lead.must("create_task", { workspace_id: longRoom, title, instructions: "A row in a long list.", idempotency_key: crypto.randomUUID(), ...extra });
  const LONG_TASKS = 320;
  // The oldest task, so it's on the last page of a newest-first read.
  const lastReview = await inLong("The review past every loaded page", { assignee: longWorker.id, reviewer: owner.id });
  const lastTaken = await longWorker.must("accept_task", { workspace_id: longRoom, task_id: lastReview.id, version: lastReview.version });
  await longWorker.must("submit_task", { workspace_id: longRoom, task_id: lastReview.id, version: lastTaken.version, note: "Ready", artifacts: [], idempotency_key: crypto.randomUUID() });
  for (let start = 0; start < LONG_TASKS; start += 20) {
    await Promise.all(Array.from({ length: Math.min(20, LONG_TASKS - start) }, (_, i) => inLong(`Long task ${String(start + i).padStart(3, "0")}`, (start + i) % 5 === 0 ? { assignee: longWorker.id } : {})));
  }
  // Two pages, so one read ends the list.
  const shortListRoom = await owner.createRoom("Two pages");
  await owner.addAgent(shortListRoom, lead);
  for (let start = 0; start < 60; start += 20) {
    await Promise.all(Array.from({ length: 20 }, (_, i) => lead.must("create_task", { workspace_id: shortListRoom, title: `Short list ${String(start + i).padStart(2, "0")}`, instructions: "A row.", idempotency_key: crypto.randomUUID() })));
  }

  // Two openings and a planned line between them, so the Collaboration screens have a plan to show.
  const plannedTo = (await owner.must("POST", `/v1/workspaces/${room}/roles`, { title: "Delivery engineer with a long title that has to wrap", responsibilities: "Builds what's planned.", capacity: 1, preset: "member", policy_version: (await owner.must("GET", `/v1/workspaces/${room}`)).policy_version })).id;
  await owner.must("POST", `/v1/workspaces/${room}/collaboration/planned`, { from_role_id: opening, to_role_id: plannedTo, label: "Hands the plan to, with a label long enough that the map cuts it short", policy_version: (await owner.must("GET", `/v1/workspaces/${room}`)).policy_version });
  // A task waiting on another, both on the first page.
  const planned = await owner.must("GET", `/v1/workspaces/${longRoom}/plan`);
  const longId = (title) => planned.tasks.find((task) => task.title === title).id;
  await owner.must("PUT", `/v1/workspaces/${longRoom}/tasks/${longId("Long task 319")}/plan`, { plan_revision: planned.plan_revision, duration_days: 3, predecessors: [longId("Long task 318")] });
  // A whole forecast: a start on a Saturday, a link, a parallel task, and a finished task with no estimate that it leaves out.
  const plannedRoom = await owner.createRoom("Planned room");
  await owner.addAgent(plannedRoom, lead);
  await owner.addAgent(plannedRoom, longWorker);
  const inPlanned = (title, extra = {}) => lead.must("create_task", { workspace_id: plannedRoom, title, instructions: "A planned task.", idempotency_key: crypto.randomUUID(), ...extra });
  const [firstStep, nextStep, sideStep] = [await inPlanned("First step"), await inPlanned("Next step"), await inPlanned("Side step")];
  const finished = await inPlanned("Finished with no estimate", { assignee: longWorker.id });
  const finishedAt = { workspace_id: plannedRoom, task_id: finished.id };
  const finishedTaken = await longWorker.must("accept_task", { ...finishedAt, version: finished.version });
  const finishedSent = await longWorker.must("submit_task", { ...finishedAt, version: finishedTaken.version, note: "Ready", artifacts: [], idempotency_key: crypto.randomUUID() });
  await lead.must("verify_task", { ...finishedAt, version: finishedSent.version, submission_no: 1 });
  let planRevision = (await owner.must("GET", `/v1/workspaces/${plannedRoom}/plan`)).plan_revision;
  for (const [step, duration_days, predecessors] of [[firstStep, 2, []], [nextStep, 13, [firstStep.id]], [sideStep, 1, []]]) {
    planRevision = (await owner.must("PUT", `/v1/workspaces/${plannedRoom}/tasks/${step.id}/plan`, { plan_revision: planRevision, duration_days, predecessors })).plan_revision;
  }
  await owner.must("PUT", `/v1/workspaces/${plannedRoom}/plan/start`, { start_date: "2026-11-07", timezone: "America/New_York", plan_revision: planRevision });

  // INPUT ASSET FIXTURE (screen 9a). Test-only, and last, because setting its scan states restarts the Workers. Why, in asset-fixture.mjs.
  // Checked before uploading, so a run that can't set the states fails before it leaves files behind.
  ok(canAskRunner(), RUN_THROUGH_RUNNER);
  const inputAssets = await seedInputAssets({ gatewayBase, owner, room, task: reviewScreen.id });
  await askRunner({ type: "set-file-states", changes: inputAssets.changes });
  // END INPUT ASSET FIXTURE

  // REMOVED OUTPUT FILE FIXTURE (screen 9c). After 9a's block, and through the same runner, for decision 138's note: a Ready
  // output whose approved file was later removed. Only the scan verdict is written by hand, as 9a's are. The submission, the
  // approval and the removal go through the real routes.
  const removedFile = await uploadOutputFile({ gatewayBase, owner, agent: lead, room: outputs.room });
  await askRunner({ type: "set-file-states", changes: [{ id: removedFile.fileId, state: "ready" }] });
  await removedFile.approveThenRemove();
  // END REMOVED OUTPUT FILE FIXTURE
  return { outputs, done, plannedRoom, viewer, narrowed, otherWorker, limitedRoom, secretTask, viewerTask, SECRET, teamOrgId: teamOrg, longRoom, shortListRoom, lastReview, LONG_TASKS, opening, plannedTo, owner, partner, room, emptyRoom, lead, guest, revokee, review, reviewScreen, oversized, heavyThread, shortThread, scriptThread, arabicThread, hebrewLatinThread, tallThread, linkThread, longBrief, slowBrief, numberedBrief, composeTask, hostileRoom, hostile, off, pending, roomInvite, orgInvite, teamOrg, consent, heir, transferRoom, ownerlessRoom };
}

const screens = (s) => {
  const w = `/w/${s.room}`;
  return [
    // [name, path, text that shows the real screen, who]
    ["Sign in", "/sign-in", "Sign in", null],
    ["Workrooms", "/workrooms", "Billing v2"],
    ["Create a workroom", "/workrooms/new", "Create workroom"],
    ["Explore", "/workrooms/explore", "Explore"],
    // The handle needn't be public to show the form: the API decides when it's sent.
    ["Report", `/report?handle=pub_${"0".repeat(32)}`, "Send report"],
    ["Needs attention", "/attention", "Task for the review screen"],
    ["Agents", "/agents", "Lead agent"],
    ["Agent Sheet", `/agents?agent=${s.lead.id}`, "Lead agent", "owner", true],
    ["Disconnected agent Sheet", `/agents?agent=${s.off.id}`, "Disconnected agent", "owner", true],
    ["Connect Sheet", "/agents/connect", "Connect"],
    ["Settings", "/settings/profile", "Ada Owner"],
    ["Notifications", "/settings/notifications", "Notifications"],
    ["Organization", "/settings/organization", "Ada Owner"],
    ["Organization, team", "/settings/organization", "Ada team", "owner", false, s.teamOrg],
    ["Organization, a workroom to recover", "/settings/organization", "Room to recover", "owner", false, s.teamOrg],
    ["Overview", `${w}/overview`, "Billing v2"],
    // From the input asset fixture: a row in each scan state, and the attach picker.
    ["Overview, input assets", `${w}/overview`, "Scan failed"],
    ["Task Sheet, attached files", `${w}/tasks?task=${s.reviewScreen.id}`, "No known malware found.", "owner", true],
    ["Tasks", `${w}/tasks`, "An open task"],
    ["Tasks, empty", `/w/${s.emptyRoom}/tasks`, "Tasks"],
    ["Task Sheet, review", `${w}/tasks?task=${s.reviewScreen.id}`, "Approve submission", "owner", true],
    ["Tasks, board", `${w}/tasks?view=board`, "An open task"],
    ["Tasks, board with canceled shown", `${w}/tasks?view=board&canceled=show`, "A canceled task"],
    ["Tasks, board, empty", `/w/${s.emptyRoom}/tasks?view=board`, "No tasks in scope"],
    ["Tasks, Gantt", `${w}/tasks?view=gantt`, "Forecast unavailable"],
    ["Tasks, Gantt, empty", `/w/${s.emptyRoom}/tasks?view=gantt`, "No tasks in scope"],
    ["Tasks, Gantt, baseline plan", `/w/${s.plannedRoom}/tasks?view=gantt`, "Baseline plan"],
    ["Tasks, Gantt, long", `/w/${s.longRoom}/tasks?view=gantt`, "Load more"],
    ["Task Sheet over the Gantt", `${w}/tasks?view=gantt&task=${s.reviewScreen.id}`, "Approve submission", "owner", true],
    ["Tasks, long list", `/w/${s.longRoom}/tasks`, "Load more"],
    ["Activity, long", `/w/${s.longRoom}/activity`, "Load more"],
    ["Task Sheet over the board", `${w}/tasks?view=board&task=${s.reviewScreen.id}`, "Approve submission", "owner", true],
    ["Activity", `${w}/activity`, "Activity"],
    ["Team", `${w}/team`, "Lead agent"],
    ["Access Sheet", `${w}/team?agent=${s.lead.id}`, "Revoke workroom access", "owner", true],
    ["Role opening Sheet", `${w}/team?role=${s.opening}`, "Close opening", "owner", true],
    ["Workroom settings", `${w}/settings`, "Billing v2"],
    ["Workroom settings, with an admin", `/w/${s.transferRoom}/settings`, "Transfer ownership"],
    ["Collaboration", `${w}/collaboration`, "Who has worked with whom"],
    ["Collaboration, map", `${w}/collaboration?view=map`, "Each number counts"],
    ["Artifacts", `${w}/artifacts`, "Artifacts"],
    ["Artifacts, outputs in each state", `/w/${s.outputs.room}/artifacts`, "has since been blocked or removed"],
    ["Task Sheet over Artifacts", `/w/${s.outputs.room}/artifacts?task=${s.outputs.readyTask}`, "Expected output", "owner", true],
    ["Claim", `/claim?agent_id=${s.pending.pluginId}&code=${s.pending.userCode}`, "Confirm ownership"],
    ["MCP consent", `/oauth/consent?${s.consent}`, "Connect an agent to Podster"],
    ["Room invitation", `/invitations/${s.roomInvite.token}`, "Workroom invitation", "partner"],
    ["Organization invitation", `/join#${s.orgInvite.token}`, "Ada team", "partner"],
    ["Not found", `/w/ws_${"0".repeat(32)}/overview`, "find that page"],
    ["Too many requests", "/too-many-requests?after=30&next=/attention", "Too many requests just now", null],
  ];
};

const results = [];
const failures = [];

/** Lets opening animations finish, because a half-faded element fails contrast by accident. */
async function settle(page) {
  // Ended rather than waited on: Firefox and WebKit don't finish a transition on something scrolled out of view, and axe needs the final
  // colors. In rounds, because ending one can start another on what inherits from it.
  await page.evaluate(() => {
    for (let round = 0; round < 20 && document.getAnimations().length > 0; round++) {
      for (const animation of document.getAnimations()) {
        try {
          animation.finish();
        } catch {
          // An endless one can't finish, and nothing here depends on it.
        }
      }
    }
  });
}

/** Waits until React has taken over the page, so keys and clicks reach it. */
async function hydrated(page) {
  await page.waitForFunction(() => {
    // Every control, because parts of a page hydrate at different times: the shell's first link says nothing about a form further down.
    return [...document.querySelectorAll("a[href], button, input, textarea, select")].every((element) => Object.keys(element).some((name) => name.startsWith("__reactProps")));
  });
}

/** The theme's text and control colors, by contrast ratio. It covers states axe never sees, and the ones it couldn't decide. */
function checkTokens() {
  const css = readFileSync(join(here, "../apps/web/app/globals.css"), "utf8");
  const block = (selector) => Object.fromEntries([...css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`))).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
  const light = block(":root");
  const themes = { light, dark: { ...light, ...block(".dark") } };
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const text = [["foreground", "background"], ["muted-foreground", "background"], ["muted-foreground", "muted"], ["primary", "background"], ["primary-foreground", "primary"], ["secondary-foreground", "secondary"], ["accent-foreground", "accent"], ["card-foreground", "card"], ["popover-foreground", "popover"], ["destructive-foreground", "destructive"], ["sidebar-foreground", "sidebar"], ["sidebar-primary-foreground", "sidebar-primary"], ["sidebar-accent-foreground", "sidebar-accent"], ...["neutral", "amber", "blue", "violet", "green", "danger"].flatMap((tone) => [[`status-${tone}`, `status-${tone}-surface`], [`status-${tone}`, "background"]])];
  const control = [["input", "background"], ["ring", "background"], ["sidebar-ring", "sidebar"]];
  const problems = [];
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const [pairs, minimum] of [[text, 4.5], [control, 3]]) {
      for (const [fore, back] of pairs) {
        const value = ratio(tokens[fore], tokens[back]);
        if (value < minimum) problems.push({ theme, fore, back, ratio: Number(value.toFixed(2)), minimum });
      }
    }
  }
  console.log(`${problems.length ? "FAIL" : "ok  "} theme colors, ${(text.length + control.length) * 2} pairs${problems.length ? `: ${JSON.stringify(problems)}` : ""}`);
  results.push({ tokens: problems });
  for (const problem of problems) failures.push(`theme colors: ${problem.fore} on ${problem.back} in ${problem.theme} is ${problem.ratio}:1, under ${problem.minimum}:1`);
}

async function audit(page, screen) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await settle(page);
    const { violations, incomplete } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const nodes = violations.flatMap((v) => v.nodes.map((n) => ({ rule: v.id, impact: v.impact, target: n.target.join(" "), summary: n.failureSummary?.split("\n").slice(1, 2).join(" ").trim() })));
    // What axe couldn't decide, kept so a person can look: it isn't a pass.
    const unchecked = incomplete.flatMap((i) => i.nodes.map((n) => ({ rule: i.id, target: n.target.join(" "), summary: n.failureSummary?.split("\n").slice(1, 2).join(" ").trim() })));
    results.push({ screen, theme, violations: nodes, unchecked });
    console.log(`${nodes.length ? "FAIL" : "ok  "} axe ${screen} (${theme})${nodes.length ? `: ${nodes.length}` : ""}`);
    for (const node of nodes) console.log(`       ${node.rule} ${node.target}\n         ${node.summary ?? ""}`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

const browserName = process.env.PODSTER_A11Y_BROWSER ?? "chromium";
ok(["chromium", "firefox", "webkit"].includes(browserName), `There's no browser called ${browserName}.`);
// Safari's Tab skips links and buttons unless someone turns on full keyboard access, and Option-Tab reaches them either way.
const TAB = browserName === "webkit" ? "Alt+Tab" : "Tab";
const SHIFT_TAB = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
const browser = await playwright[browserName].launch();
console.log(`browser: ${browserName} ${browser.version()}`);
const newContext = () => browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
const signedOut = await newContext();
const contexts = new Map();

const RUN_THROUGH_RUNNER = "Run this through run-a11y.mjs, which can restart the Workers.";
const canAskRunner = () => typeof process.send === "function";

/** Asks run-a11y.mjs to do what only it can, with the Workers stopped, and waits for it to say it's done. */
function askRunner(request) {
  ok(canAskRunner(), RUN_THROUGH_RUNNER);
  return new Promise((done, fail) => {
    const answer = (message) => {
      if (message?.type !== `${request.type}:done`) return;
      process.off("message", answer);
      if (message.error) fail(new Error(message.error));
      else done();
    };
    process.on("message", answer);
    process.send(request);
  });
}

/** Sign-up belongs to the application host once `APP_URL` is set, so it runs in the browser there. The session works on both hosts. */
async function signUp(label) {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(`${app}/sign-in`);
  const status = await page.evaluate(async ([name, email, password]) => (await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) })).status, [label, `${key()}@example.test`, `pw-${key()}`]);
  ok(status === 200, `sign-up for ${label} answered ${status}`);
  await page.close();
  const person = await Person.fromCookie(target, label, (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; "));
  contexts.set(person, context);
  return person;
}

const contextFor = (person) => (person ? contexts.get(person) : signedOut);

function fail(path, message) {
  failures.push(`${path}: ${message}`);
  console.log(`FAIL ${path}: ${message}`);
}

/** Tabs until `locator` has focus, and fails if the page never gets there. Only the keyboard moves focus here. */
async function tabTo(page, locator, label, limit = 80) {
  let backwards = false;
  for (let i = 0; i < limit; i++) {
    // Firefox and WebKit may not come back round to what has focus already, so there it's counted without a key. Chromium always comes
    // round, and has to press Tab to show the keyboard reaches it.
    const there = browserName !== "chromium" && (await locator.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false));
    if (!there) await page.keyboard.press(backwards ? SHIFT_TAB : TAB);
    // Firefox here doesn't come round from the end of a page, and Option-Tab doesn't come round in a dialog, so from there it goes back.
    // Several presses on one control aren't stuck, because Tab moves between a date's parts with the same element active.
    if (browserName !== "chromium" && !there) backwards ||= await page.evaluate(() => {
      window.__tabRepeats = document.activeElement === window.__lastTabStop ? (window.__tabRepeats ?? 0) + 1 : 0;
      window.__lastTabStop = document.activeElement;
      return document.activeElement === document.body || window.__tabRepeats >= 5;
    });
    if (there || (await locator.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false))) {
      const visible = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? true : style.boxShadow !== "none";
      });
      if (!visible) throw new Error(`${label} has focus with no visible ring`);
      return;
    }
  }
  throw new Error(`${label} can't be reached with Tab`);
}

const activeText = (page) => page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute("role") ?? ""} ${(document.activeElement?.textContent ?? "").trim().slice(0, 60)}`);
const insideDialog = (page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')));

/** A check Playwright's WebKit can't answer, recorded as skipped with what it did, so the path's pass can't be read as covering it. */
const unseenInWebKit = (name, happened) => {
  console.log(`skip keyboard: ${name}: unseen in WebKit, which ${happened ? "did" : "didn't"} scroll here`);
  results.push({ keyboard: name, status: "skipped", detail: `Playwright's WebKit ${happened ? "scrolled" : "didn't scroll"}. Needs Safari.` });
};

/** A path that needs Chromium's debugging protocol is named as skipped elsewhere, so a pass can't be read as covering it. */
const chromiumOnly = (name, fn) => {
  if (browserName === "chromium") return keyboardPath(name, fn);
  console.log(`skip keyboard: ${name}: needs Chromium`);
  results.push({ keyboard: name, status: "skipped", detail: `needs Chromium, not ${browserName}` });
};

async function keyboardPath(name, fn) {
  try {
    await fn();
    console.log(`ok   keyboard: ${name}`);
    results.push({ keyboard: name, status: "pass" });
  } catch (error) {
    results.push({ keyboard: name, status: "fail", detail: error.message });
    fail(`keyboard: ${name}`, error.message);
  }
}

/** Shows the checks can fail: a low-contrast element has to trip axe, and the dark theme has to really apply. */
async function controls() {
  const page = await signedOut.newPage();
  await page.goto(`${app}/sign-in`);
  await page.evaluate(() => {
    const bad = document.createElement("p");
    bad.id = "a11y-control";
    bad.textContent = "Low contrast, on purpose";
    bad.style.cssText = "color:#999;background:#aaa";
    document.body.append(bad);
  });
  const { violations } = await new AxeBuilder({ page }).include("#a11y-control").withTags(TAGS).analyze();
  ok(violations.some((v) => v.id === "color-contrast"), "axe didn't flag low contrast, so its passes mean nothing");
  const body = (dark) => page.evaluate((on) => {
    document.documentElement.classList.toggle("dark", on);
    return getComputedStyle(document.body).backgroundColor;
  }, dark);
  const [light, dark] = [await body(false), await body(true)];
  ok(light !== dark, `the dark theme didn't change the page's background (${light})`);
  await page.close();
  console.log(`ok   controls: axe flags low contrast, and dark changes the background from ${light} to ${dark}`);
}

async function keyboardPaths(s) {
  const page = await contextFor(s.owner).newPage();
  // In Firefox, the router finishing a request from the step before updates history, and that cancels a load just started. Load states
  // don't help, because a page that has been idle once stays idle to them.
  if (browserName === "firefox") {
    let open = 0;
    page.on("request", () => open++);
    for (const ended of ["requestfinished", "requestfailed"]) page.on(ended, () => open--);
    const goto = page.goto.bind(page);
    page.goto = async (...args) => {
      for (const deadline = Date.now() + 5_000; open > 0 && Date.now() < deadline; ) await new Promise((done) => setTimeout(done, 25));
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => {});
      return goto(...args);
    };
  }

  await keyboardPath("create a room", async () => {
    await page.goto(`${app}/workrooms/new`);
    const name = page.getByRole("textbox", { name: "Name" });
    await name.waitFor();
    await hydrated(page);
    await tabTo(page, name, "the name field");
    await page.keyboard.type("Keyboard room");
    await tabTo(page, page.getByRole("button", { name: "Create workroom" }), "the create button");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/w\/[^/]+\/overview/, { timeout: 15_000 });
    await page.getByText("Keyboard room").first().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.id === "main-content", null, { timeout: 5_000 }).catch(() => {});
    ok(await page.evaluate(() => document.activeElement?.id === "main-content"), `after creating, focus is on ${await activeText(page)}, not on the new screen's main region`);
    await page.keyboard.press(TAB);
    ok(await page.evaluate(() => document.getElementById("main-content").contains(document.activeElement)), `Tab from the new screen's main region went to ${await activeText(page)}, not into that screen`);
  });

  // What React holds against what's on screen, after filling in everything before scripts arrive.
  const fillEarly = async (path, person, org) => {
    const context = contextFor(person);
    if (org) await context.addCookies([{ name: ORG_COOKIE, value: org, domain: new URL(app).hostname, path: "/" }]);
    const own = await context.newPage();
    let release;
    const ready = new Promise((done) => (release = done));
    await own.route(/_next\/static\/.*\.js/, async (route) => {
      await ready;
      await route.continue();
    });
    await own.goto(`${app}${path}`, { waitUntil: "commit" });
    // React reveals streamed parts in batches, and a part still hidden can't be filled in.
    await own.waitForFunction(() => document.readyState !== "loading" && !window.$RB?.length);
    const fields = own.locator("main input:not([type=hidden]), main textarea, main select, form input:not([type=hidden]), form textarea, form select");
    for (let i = 0; i < (await fields.count()); i++) {
      const field = fields.nth(i);
      const { tag, type, usable } = await field.evaluate((el) => ({ tag: el.tagName, type: el.type, usable: el.getClientRects().length > 0 && !el.disabled && !el.readOnly }));
      if (!usable) continue;
      if (tag === "SELECT") await field.evaluate((el) => (el.selectedIndex = (el.selectedIndex + 1) % el.options.length));
      else if (type === "checkbox") await field.evaluate((el) => (el.checked = !el.checked));
      else if (type === "number") await field.fill("3");
      else await field.fill("Early");
    }
    release();
    await hydrated(own);
    await own.waitForTimeout(300);
    const lost = await own.evaluate(() =>
      [...document.querySelectorAll("input:not([type=hidden]), textarea, select")].flatMap((el) => {
        const props = el[Object.keys(el).find((key) => key.startsWith("__reactProps"))];
        const checkable = el.type === "checkbox";
        if (!props || !((checkable ? "checked" : "value") in props)) return [];
        return String(checkable ? el.checked : el.value) === String((checkable ? props.checked : props.value) ?? "") ? [] : [el.labels?.[0]?.textContent?.trim().slice(0, 30) ?? el.id];
      }),
    );
    if (org) await context.clearCookies({ name: ORG_COOKIE });
    return { own, lost };
  };

  await keyboardPath("forms filled in before the page is ready keep what they show", async () => {
    const screensToFill = [
      [`/w/${s.room}/tasks`],
      [`/w/${s.room}/team`],
      [`/w/${s.room}/collaboration`],
      [`/w/${s.room}/settings`],
      [`/w/${s.transferRoom}/settings`],
      ["/settings/organization"],
      ["/settings/organization", s.owner, s.teamOrg],
      [`/claim?agent_id=${s.pending.pluginId}&code=${s.pending.userCode}`],
      [`/oauth/consent?${s.consent}`],
      [`/invitations/${s.roomInvite.token}`, s.partner],
      // Forms that don't need the early-input hook, which would need it if they ever held their state in React before load.
      ["/sign-in", null],
      ["/agents"],
      ["/agents/connect"],
      ["/attention"],
      ["/settings/profile"],
      ["/settings/notifications"],
      ["/workrooms/explore"],
      [`/w/${s.room}/tasks?task=${s.review.id}`],
      [`/w/${s.room}/artifacts`],
    ];
    for (const [path, person = s.owner, org] of screensToFill) {
      const { own, lost } = await fillEarly(path, person, org);
      await own.close();
      ok(lost.length === 0, `${path.split("?")[0]} shows what React doesn't hold: ${lost.join(", ")}`);
    }
    // And it counts: the buttons that were stuck disabled work.
    const team = await fillEarly(`/w/${s.room}/team`, s.owner);
    for (const name of ["Add opening", "Add agent", "Add person"]) ok(await team.own.getByRole("button", { name, exact: true }).isEnabled(), `${name} stayed disabled for a form filled in early`);
    await team.own.close();
    const { own } = await fillEarly(`/w/${s.room}/settings`, s.owner);
    const save = own.getByRole("button", { name: "Save goal and context" });
    ok(await save.isEnabled(), "Save stayed disabled for a goal typed early");
    // The browser restores fields on coming back, which can land after the form has hydrated.
    await own.goto(`${app}/agents`);
    await own.goBack();
    await hydrated(own);
    await own.waitForTimeout(500);
    const goal = await own.locator("form textarea").first().inputValue();
    console.log(`     coming back, the browser ${goal ? "restored" : "didn't restore"} the goal`);
    ok(!goal || (await save.isEnabled()), "a restored goal left Save disabled");
    await own.close();
  });

  await keyboardPath("a filter ticked before the page is ready is applied, once", async () => {
    const own = await contextFor(s.owner).newPage();
    let release;
    const ready = new Promise((done) => (release = done));
    await own.route(/_next\/static\/.*\.js/, async (route) => {
      await ready;
      await route.continue();
    });
    try {
      await own.goto(`${app}/w/${s.room}/tasks`, { waitUntil: "commit" });
      const filter = own.getByRole("checkbox", { name: "Needs my review" });
      await filter.waitFor();
      const entries = await own.evaluate(() => history.length);
      await filter.evaluate((el) => (el.checked = true));
      release();
      await own.waitForURL(/[?&]/, { timeout: 15_000 });
      await hydrated(own);
      await own.waitForTimeout(500);
      const after = await own.evaluate(() => history.length);
      ok(after === entries + 1, `a filter ticked early moved history by ${after - entries}`);
      ok(await filter.isChecked(), "the filter ticked early came back unticked");
    } finally {
      await own.close();
    }
  });

  await keyboardPath("settings changed before the page is ready send what they show, only when asked", async () => {
    const own = await contextFor(s.owner).newPage();
    const sent = [];
    await own.route(/\/api\/v1\/workspaces\/[^/]+\/(brief|review-policy)$/, (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      sent.push([new URL(route.request().url()).pathname.split("/").at(-1), route.request().postDataJSON()]);
      return route.fulfill({ status: 403, json: { error: { code: "not_allowed" } } });
    });
    let release;
    const ready = new Promise((done) => (release = done));
    await own.route(/_next\/static\/.*\.js/, async (route) => {
      await ready;
      await route.continue();
    });
    try {
      await own.goto(`${app}/w/${s.room}/settings`, { waitUntil: "commit" });
      const goal = own.locator("form textarea").first();
      await goal.waitFor();
      await goal.focus();
      await own.keyboard.type("Typed before load");
      await own.getByRole("checkbox", { name: /Require a person to review/ }).evaluate((el) => (el.checked = true));
      release();
      await hydrated(own);
      await own.waitForTimeout(500);
      ok(sent.length === 0, `something early was sent without being asked: ${JSON.stringify(sent)}`);
      const answered = (what) => own.waitForResponse((response) => response.url().endsWith(`/${what}`) && response.request().method() === "PUT", { timeout: 15_000 });
      await Promise.all([answered("brief"), own.getByRole("button", { name: "Save goal and context" }).click()]);
      const brief = sent.filter(([what]) => what === "brief");
      ok(brief.length === 1 && brief[0][1].goal?.includes("Typed before load"), `the goal sent wasn't what it showed: ${JSON.stringify(sent)}`);
      await Promise.all([answered("review-policy"), own.getByRole("button", { name: "Save review setting" }).click()]);
      const policy = sent.filter(([what]) => what === "review-policy");
      ok(policy.length === 1 && policy[0][1].require_person === true, `the review setting sent wasn't what it showed: ${JSON.stringify(sent)}`);
    } finally {
      await own.close();
    }
  });

  await keyboardPath("a filter ticked after the page is ready isn't sent again on load or coming back", async () => {
    const own = await contextFor(s.owner).newPage();
    try {
      await own.goto(`${app}/w/${s.room}/tasks`);
      await hydrated(own);
      await own.getByRole("checkbox", { name: "Needs my review" }).click();
      await own.waitForURL(/[?&]/, { timeout: 15_000 });
      const [entries, url] = await own.evaluate(() => [history.length, location.href]);
      await own.evaluate(() => {
        window.dispatchEvent(new Event("load"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await own.waitForTimeout(500);
      const after = await own.evaluate(() => [history.length, location.href]);
      ok(after[0] === entries && after[1] === url, `a late load or pageshow moved the page: ${entries} entries to ${after[0]}, ${after[1]}`);
    } finally {
      await own.close();
    }
  });

  await keyboardPath("a create form filled in before the page is ready still sends what it shows", async () => {
    const own = await contextFor(s.owner).newPage();
    let body;
    await own.route("**/api/v1/workspaces", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      body = route.request().postDataJSON();
      return route.fulfill({ status: 403, json: { error: { code: "not_allowed" } } });
    });
    // Scripts held back, as on a slow connection, so nothing is hydrated while this types.
    let release;
    const ready = new Promise((done) => (release = done));
    await own.route(/_next\/static\/.*\.js/, async (route) => {
      await ready;
      await route.continue();
    });
    try {
      await own.goto(`${app}/workrooms/new`, { waitUntil: "commit" });
      const name = own.getByRole("textbox", { name: "Name" });
      await name.waitFor();
      const fields = own.locator("form textarea");
      await name.focus();
      await own.keyboard.type("Early room");
      await fields.nth(0).focus();
      await own.keyboard.type("Early goal");
      await fields.nth(1).focus();
      await own.keyboard.type("Early context");
      release();
      await hydrated(own);
      await name.focus();
      await own.keyboard.press("Enter");
      await own.getByRole("alert").filter({ hasText: "no workroom was created" }).waitFor({ timeout: 15_000 });
      ok(body?.name === "Early room", `it sent the name ${JSON.stringify(body?.name)}`);
      ok(JSON.stringify(body).includes("Early goal") && JSON.stringify(body).includes("Early context"), `it left out what was typed: ${JSON.stringify(body)}`);
    } finally {
      release();
      await own.close();
    }
  });

  await keyboardPath("a refused create keeps focus and says why", async () => {
    // The owner is allowed to create, so a refusal has to be staged. Only the response is; the form is the real one.
    await page.route("**/api/v1/workspaces", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 403, json: { error: { code: "not_allowed" } } }) : route.fallback()));
    try {
      await page.goto(`${app}/workrooms/new`);
      const name = page.getByRole("textbox", { name: "Name" });
      await name.waitFor();
      await hydrated(page);
      await tabTo(page, name, "the name field");
      await page.keyboard.type("Refused room");
      const alert = page.getByRole("alert").filter({ hasText: "no workroom was created" });
      const focusedOn = (locator) => locator.evaluate((el) => el === document.activeElement);

      await page.keyboard.press("Enter");
      await alert.waitFor({ timeout: 15_000 });
      ok(await focusedOn(name), `a refusal after Enter in the field left focus on ${await activeText(page)}`);

      const button = page.getByRole("button", { name: "Create workroom" });
      await tabTo(page, button, "the create button");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Create workroom" }).waitFor({ timeout: 15_000 });
      await alert.waitFor({ timeout: 15_000 });
      ok(await focusedOn(button), `a refusal after Enter on the button left focus on ${await activeText(page)}`);
      ok(new URL(page.url()).pathname === "/workrooms/new", `a refusal moved the page to ${page.url()}`);
    } finally {
      await page.unroute("**/api/v1/workspaces");
    }
  });

  await keyboardPath("manage a role opening, and the Team page at phone width", async () => {
    await page.goto(`${app}/w/${s.room}/team`);
    await hydrated(page);
    const link = page.getByRole("link", { name: "Manage opening" }).first();
    await tabTo(page, link, "the opening's link");
    await page.keyboard.press("Enter");
    const close = page.getByRole("button", { name: "Close opening" });
    await close.waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const path of [`/w/${s.room}/team`, `/w/${s.room}/team?role=${s.opening}`, `/w/${s.room}/team?agent=${s.lead.id}`]) {
      await small.goto(`${app}${path}`);
      await small.getByText("Lead coordinator").first().waitFor({ timeout: 15_000 });
      const widths = await small.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      ok(widths[0] <= widths[1], `${path} scrolls sideways at phone width: ${widths.join(" > ")}`);
    }
    await phone.close();
  });

  await keyboardPath("filter the room's activity, also at phone width", async () => {
    await page.goto(`${app}/w/${s.room}/activity`);
    await hydrated(page);
    const participant = page.getByLabel("Participant");
    await tabTo(page, participant, "the Participant filter");
    // Typing, because an arrow key opens the list on some platforms and changes the value on others. The owner reads as "You".
    await page.keyboard.type("You");
    const chosen = await participant.inputValue();
    ok(chosen !== "", "typing didn't change the Participant filter");
    const filter = page.getByRole("button", { name: "Filter" });
    await tabTo(page, filter, "Filter");
    await page.keyboard.press("Enter");
    await page.waitForURL(/actor=/, { timeout: 15_000 });
    ok((await participant.inputValue()) === chosen, "the filter didn't keep its choice");
    // Clear goes through the client router, which doesn't remount a form on its own, and it mustn't drop focus as it goes.
    await hydrated(page);
    await page.getByRole("link", { name: "Clear" }).click();
    await page.waitForURL((url) => !url.search.includes("actor="), { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('select[name="actor"]')?.value === "", null, { timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.id === "activity-heading", null, { timeout: 15_000 });
    await page.goBack();
    await page.waitForURL(/actor=/, { timeout: 15_000 });
    await page.waitForFunction((value) => document.querySelector('select[name="actor"]')?.value === value, chosen, { timeout: 15_000 });
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    await small.goto(`${app}/w/${s.room}/activity`);
    await small.getByRole("button", { name: "Filter" }).waitFor({ timeout: 15_000 });
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `activity scrolls sideways by ${overflow}px at 375px`);
    await phone.close();
  });

  await keyboardPath("collaboration list, map and a line's handoffs, also at phone width", async () => {
    await page.goto(`${app}/w/${s.room}/collaboration`);
    await hydrated(page);
    const line = page.locator('a[href*="line="]').first();
    await tabTo(page, line, "a line");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("link").first().waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    await page.goto(`${app}/w/${s.room}/collaboration?view=map`);
    await hydrated(page);
    const mapLine = page.locator("svg a").first();
    await mapLine.waitFor({ timeout: 15_000 });
    ok((await mapLine.getAttribute("aria-label"))?.includes(" to "), "a map line has no words");
    await tabTo(page, mapLine, "a map line");
    await page.evaluate(() => { window.__samePage = true; });
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("link").first().waitFor({ timeout: 15_000 });
    ok(await page.evaluate(() => window.__samePage === true), "a map line reloaded the page");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.closest("svg") !== null, null, { timeout: 15_000 });
    ok((await page.getByRole("region", { name: /scrolls sideways/ }).count()) === 0, "the map's box is a tab stop though it doesn't scroll");
    // Straight back in, before closing has reached the URL: it opens, instead of leaving a line that won't.
    await page.waitForURL((url) => !url.search.includes("line="), { timeout: 15_000 });
    const collaborationPage = (url) => url.pathname.endsWith("/collaboration");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("link").first().waitFor({ timeout: 15_000 });
    // The late close can land before or after the reopen, depending on timing, so this tries a few gaps.
    for (const held of [1500, 0, 60, 400]) {
      await page.route(collaborationPage, (route) => setTimeout(() => route.continue().catch(() => {}), held));
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
      // Focus comes back just after the dialog goes. A key pressed sooner lands on the body and presses nothing.
      await page.waitForFunction(() => document.activeElement?.closest("svg") !== null, null, { timeout: 15_000 });
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").getByRole("link").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(held + 300);
      await page.unroute(collaborationPage);
      await page.waitForURL((url) => url.search.includes("line="), { timeout: 15_000 });
      ok((await page.getByRole("dialog").getByRole("link").count()) > 0, `the reopened Sheet didn't stay open with a ${held} ms gap`);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.closest("svg") !== null, null, { timeout: 15_000 });
    await page.waitForURL((url) => !url.search.includes("line="), { timeout: 15_000 });
    // The same line again, from the list below the map: it comes back there, not to the map.
    const listed = page.locator('section[aria-labelledby="collab-lines"] a[href*="line="]').first();
    await listed.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("link").first().waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.tagName === "A" && document.activeElement.closest("svg") === null, null, { timeout: 15_000 });
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const path of [`/w/${s.room}/collaboration`, `/w/${s.room}/collaboration?view=map`]) {
      await small.goto(`${app}${path}`);
      await small.getByText("Lines describe work").first().waitFor({ timeout: 15_000 });
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 0, `${path} scrolls sideways by ${overflow}px at 375px`);
    }
    // At this width the map's box is cut off, so the keyboard has to be able to move it.
    const box = small.getByRole("region", { name: /scrolls sideways/ });
    await box.focus();
    await small.keyboard.press("ArrowRight");
    // See the table's arrow keys: in Playwright's WebKit, a key doesn't move even a plain box with focus.
    if (browserName === "webkit") {
      await small.waitForTimeout(1_000);
      unseenInWebKit("arrow keys scrolling the map", await box.evaluate((el) => el.scrollLeft > 0));
    } else await small.waitForFunction(() => document.activeElement?.scrollLeft > 0, null, { timeout: 15_000 });
    await phone.close();
  });

  await keyboardPath("plan a line, reach it from the map, and remove it, also at phone width", async () => {
    await page.goto(`${app}/w/${s.room}/collaboration?view=map`);
    await hydrated(page);
    const form = page.locator("form", { hasText: "Plan a line" });
    // By keyboard alone: Tab to each field, and typing a role's first letters chooses it.
    const from = form.getByRole("combobox", { name: "From role" });
    const to = form.getByRole("combobox", { name: "To role" });
    await tabTo(page, from, "the From role select", 120);
    await page.keyboard.type("Delivery");
    await page.waitForFunction((id) => document.activeElement?.value === id, s.plannedTo, { timeout: 15_000 });
    await page.keyboard.press(TAB);
    await to.evaluate((el) => new Promise((done) => (document.activeElement === el ? done() : el.addEventListener("focus", done, { once: true }))));
    await page.keyboard.type("Lead");
    await page.waitForFunction((id) => document.activeElement?.value === id, s.opening, { timeout: 15_000 });
    ok((await from.inputValue()) === s.plannedTo && (await to.inputValue()) === s.opening, "the keyboard didn't choose both roles");
    await page.keyboard.press(TAB);
    await page.waitForFunction(() => document.activeElement?.tagName === "INPUT", null, { timeout: 15_000 });
    await page.keyboard.type("Asks questions of");
    await page.keyboard.press(TAB);
    await page.waitForFunction(() => document.activeElement?.textContent === "Add planned line", null, { timeout: 15_000 });
    await page.keyboard.press("Enter");
    const dashed = page.locator('svg a[href^="#planned-"]', { hasText: "Asks questions of" });
    await dashed.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "status", null, { timeout: 15_000 });
    const name = await dashed.getAttribute("aria-label");
    ok(name?.startsWith("Planned: Delivery engineer") && name.includes("Asks questions of") && name.includes("not recorded"), `a planned line's name is ${name}`);
    ok((await dashed.locator("path[stroke-dasharray]").count()) === 1, "a planned line isn't dashed");
    await dashed.focus();
    await page.waitForFunction(() => document.activeElement?.closest("svg") !== null, null, { timeout: 15_000 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.tagName === "LI" && document.activeElement.id.startsWith("planned-"), null, { timeout: 15_000 });
    const row = page.locator(`li#${await page.evaluate(() => document.activeElement.id)}`);
    ok((await row.textContent()).includes("Planned, not recorded"), "the list's row doesn't say it's planned");
    await page.keyboard.press(TAB);
    await page.waitForFunction(() => document.activeElement?.textContent === "Remove", null, { timeout: 15_000 });
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.closest('[role="alertdialog"]') !== null, null, { timeout: 15_000 });
    await confirm.getByRole("button", { name: "Remove line" }).focus();
    await page.waitForFunction(() => document.activeElement?.textContent === "Remove line", null, { timeout: 15_000 });
    await page.keyboard.press("Enter");
    await dashed.waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "status", null, { timeout: 15_000 });
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const path of [`/w/${s.room}/collaboration`, `/w/${s.room}/collaboration?view=map`]) {
      await small.goto(`${app}${path}`);
      await small.getByRole("heading", { name: "Planned relationships" }).waitFor({ timeout: 15_000 });
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 0, `${path} scrolls sideways by ${overflow}px at 375px with a plan on it`);
    }
    await phone.close();
  });

  // With a real API, because a stand-in whose version doesn't move can't see this: staging found it.
  await keyboardPath("keep a draft through an opening's own commands", async () => {
    const opening = (await s.owner.must("POST", `/v1/workspaces/${s.room}/roles`, { title: "Draft check", responsibilities: "Before", capacity: 2, preset: "guest", policy_version: (await s.owner.must("GET", `/v1/workspaces/${s.room}`)).policy_version })).id;
    await page.goto(`${app}/w/${s.room}/team?role=${opening}`);
    await hydrated(page);
    const sheet = page.getByRole("dialog");
    const responsibilities = sheet.getByLabel("Responsibilities");
    await responsibilities.waitFor({ timeout: 15_000 });
    await responsibilities.fill("Before, and after");
    await sheet.getByLabel("Invite an agent in this workroom").selectOption(s.lead.id);
    await sheet.getByRole("button", { name: "Invite", exact: true }).click();
    const withdraw = sheet.getByRole("button", { name: /^Withdraw invite to/ });
    await withdraw.waitFor({ timeout: 15_000 });
    const afterInvite = await responsibilities.inputValue();
    ok(afterInvite === "Before, and after", `the draft didn't survive the invite: ${afterInvite}`);
    await withdraw.click();
    await sheet.getByText(/withdrawn/).waitFor({ timeout: 15_000 });
    const afterWithdraw = await responsibilities.inputValue();
    ok(afterWithdraw === "Before, and after", `the draft didn't survive the withdrawal: ${afterWithdraw}`);
    const save = sheet.getByRole("button", { name: "Save changes" });
    await save.click();
    await sheet.getByText(/^Saved\./).waitFor({ timeout: 15_000 });
    const conflict = await sheet.getByText(/changed while you were editing/).count();
    ok(conflict === 0, "a draft conflicted with this Sheet's own commands");
    const after = (await s.owner.must("GET", `/v1/workspaces/${s.room}/roles`)).roles.find((role) => role.id === opening);
    ok(after.responsibilities === "Before, and after", `the draft wasn't saved: ${after.responsibilities}`);
    ok(after.invited.length === 0, "the invite wasn't withdrawn");
    await s.owner.must("DELETE", `/v1/workspaces/${s.room}/roles/${opening}`, { policy_version: (await s.owner.must("GET", `/v1/workspaces/${s.room}`)).policy_version });
  });

  await keyboardPath("add an opening while creating a workroom, also at phone width", async () => {
    await page.goto(`${app}/workrooms/new`);
    await hydrated(page);
    const add = page.getByRole("button", { name: "Add an opening" });
    await tabTo(page, add, "Add an opening");
    await page.keyboard.press("Enter");
    const group = page.getByRole("group", { name: "Opening 1" });
    await group.waitFor({ timeout: 15_000 });
    await tabTo(page, group.getByLabel("Title"), "the opening's title");
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    await small.goto(`${app}/workrooms/new`);
    await hydrated(small);
    await small.getByRole("button", { name: "Add an opening" }).click();
    await small.getByRole("group", { name: "Opening 1" }).waitFor({ timeout: 15_000 });
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `the create form scrolls sideways by ${overflow}px at 375px`);
    await small.goto(`${app}/w/${s.room}/settings`);
    await small.getByRole("button", { name: "Save review setting" }).waitFor({ timeout: 15_000 });
    const settings = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(settings <= 0, `settings scrolls sideways by ${settings}px at 375px`);
    await phone.close();
  });

  await keyboardPath("set a task's plan, see a refusal, and at phone width", async () => {
    const open = async (target, title) => {
      await target.goto(`${app}/w/${s.room}/tasks`);
      await hydrated(target);
      await target.getByRole("link", { name: title }).click();
      await target.getByRole("button", { name: "Show plan" }).waitFor({ timeout: 15_000 });
    };
    const dialog = page.getByRole("dialog");
    await page.goto(`${app}/w/${s.room}/tasks`);
    await hydrated(page);
    await tabTo(page, page.getByRole("link", { name: "Plan the second step" }), "the task's link");
    await page.keyboard.press("Enter");
    const show = dialog.getByRole("button", { name: "Show plan" });
    await show.waitFor({ timeout: 15_000 });
    await tabTo(page, show, "Show plan");
    await page.keyboard.press("Enter");
    const edit = dialog.getByRole("button", { name: "Edit plan" });
    await edit.waitFor({ timeout: 15_000 });
    await dialog.getByText("Not estimated").waitFor({ timeout: 15_000 });
    await tabTo(page, edit, "Edit plan");
    await page.keyboard.press("Enter");
    const days = dialog.getByLabel("Estimate in working days");
    await page.waitForFunction(() => document.activeElement?.id === "plan-duration", undefined, { timeout: 15_000 });
    await page.keyboard.type("3");
    const add = dialog.getByRole("button", { name: "Add Plan the first step" });
    await dialog.getByLabel("Add a task that comes first").fill("Plan the first");
    await tabTo(page, add, "Add");
    await page.keyboard.press("Enter");
    const remove = dialog.getByRole("button", { name: "Remove Plan the first step" });
    await remove.waitFor({ timeout: 15_000 });
    // The pressed button has gone, so focus moves on, and it's said aloud.
    await page.waitForFunction(() => document.activeElement?.id === "plan-find", undefined, { timeout: 15_000 });
    await dialog.getByText("Added Plan the first step.").waitFor({ state: "attached", timeout: 15_000 });
    await tabTo(page, remove, "Remove");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "plan-find", undefined, { timeout: 15_000 });
    await dialog.getByText("Removed Plan the first step.").waitFor({ state: "attached", timeout: 15_000 });
    await tabTo(page, add, "Add again");
    await page.keyboard.press("Enter");
    await remove.waitFor({ timeout: 15_000 });
    ok((await days.inputValue()) === "3", "the estimate didn't stay while adding a task");
    const save = dialog.getByRole("button", { name: "Save plan" });
    await tabTo(page, save, "Save plan");
    await page.keyboard.press("Enter");
    await dialog.getByText(/Plan saved/).waitFor({ timeout: 15_000 });
    await dialog.getByText(/3 working days/).waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.textContent === "Edit plan", undefined, { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });

    // The other way round would close a loop, and the refusal names no task.
    await open(page, "Plan the first step");
    await dialog.getByRole("button", { name: "Show plan" }).click();
    await dialog.getByRole("button", { name: "Edit plan" }).click();
    await dialog.getByLabel("Add a task that comes first").fill("Plan the second");
    await dialog.getByRole("button", { name: "Add Plan the second step" }).click();
    await dialog.getByRole("button", { name: "Save plan" }).click();
    const refusal = dialog.getByRole("alert").filter({ hasText: "wait for itself" });
    await refusal.waitFor({ timeout: 15_000 });
    ok(await refusal.evaluate((el) => document.activeElement === el), "focus didn't move to the refusal");
    await audit(page, "Task plan form, with a refusal");
    ok(!(await refusal.textContent()).includes("Plan the"), "the refusal named a task");

    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    await open(small, "Plan the second step");
    await small.getByRole("button", { name: "Show plan" }).click();
    await small.getByRole("button", { name: "Edit plan" }).click();
    await small.getByLabel("Estimate in working days").waitFor({ timeout: 15_000 });
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `the plan form scrolls sideways by ${overflow}px at 375px`);
    await audit(small, "Task plan form, phone");
    await phone.close();
  });

  await keyboardPath("review a task", async () => {
    await page.goto(`${app}/w/${s.room}/tasks`);
    await hydrated(page);
    const link = page.getByRole("link", { name: "Task for keyboard review" });
    await tabTo(page, link, "the task's link");
    await page.keyboard.press("Enter");
    const approve = page.getByRole("button", { name: /Approve submission/ });
    await approve.waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    await tabTo(page, approve, "Approve");
    await page.keyboard.press("Enter");
    // Announced, and in the Sheet's own text.
    const notice = page.getByText(/Approved submission 1/);
    await notice.waitFor({ timeout: 15_000 });
    const live = await notice.evaluate((el) => Boolean(el.closest('[role="status"], [role="alert"], [aria-live]')));
    ok(live, "the approval isn't in a live region, so a screen reader wouldn't hear it");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-sheet-launcher")?.startsWith("task:"), undefined, { timeout: 5000 }).catch(async () => {
      throw new Error(`closing the Sheet left focus on ${await activeText(page)}, not the link that opened it`);
    });
  });

  await keyboardPath("switch to the board and open a card", async () => {
    await page.goto(`${app}/w/${s.room}/tasks`);
    await hydrated(page);
    const board = page.getByRole("link", { name: "Board", exact: true });
    await tabTo(page, board, "the Board link");
    await page.keyboard.press("Enter");
    await page.waitForURL(/view=board/, { timeout: 15_000 });
    ok(await board.evaluate((el) => el === document.activeElement && el.getAttribute("aria-current") === "true"), `switching views left focus on ${await activeText(page)}, or Board isn't marked current`);
    const live = await page.getByText(/Board view, showing \d+ of \d+ tasks/).evaluate((el) => el.getAttribute("aria-live"));
    ok(live === "polite", "switching views isn't announced");
    const card = page.getByRole("link", { name: "An open task", exact: true });
    // The stretched link covers the card, except the truncated ID, which keeps its tooltip.
    const hits = await card.evaluate((link) => {
      link.scrollIntoView({ block: "center" });
      const top = (el) => {
        const box = el.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      };
      const item = link.closest("li");
      return { id: top(item.querySelector("p[title]")).hasAttribute("title"), estimate: top(item.querySelector("dl dd:last-child")) === link };
    });
    ok(hits.id, "the card's link covers the task ID, so its tooltip can't show");
    ok(hits.estimate, "the rest of the card doesn't open the Sheet");
    await tabTo(page, card, "the card's link");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    ok(page.url().includes("view=board") && page.url().includes("task="), `opening a card changed the view: ${page.url()}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-sheet-launcher")?.startsWith("task:"), undefined, { timeout: 5000 }).catch(async () => {
      throw new Error(`closing the Sheet left focus on ${await activeText(page)}, not the card that opened it`);
    });
    ok(page.url().includes("view=board"), `closing the Sheet lost the view: ${page.url()}`);
  });

  await keyboardPath("Back, Forward and reload restore the view, filter and Sheet", async () => {
    const current = (name) => page.getByRole("link", { name, exact: true }).and(page.locator('[aria-current="true"]')).waitFor({ timeout: 15_000 });
    const mine = page.getByRole("checkbox", { name: "Needs my review" });
    await page.goto(`${app}/w/${s.room}/tasks`);
    await hydrated(page);
    await tabTo(page, mine, "the review filter");
    await page.keyboard.press("Space");
    await page.waitForURL(/review=mine/, { timeout: 15_000 });
    await tabTo(page, page.getByRole("link", { name: "Board", exact: true }), "the Board link");
    await page.keyboard.press("Enter");
    await current("Board");
    await page.reload();
    await hydrated(page);
    await current("Board");
    ok(await mine.isChecked(), "reloading lost the filter");
    await page.goBack();
    await current("List");
    ok(await mine.isChecked(), "Back lost the filter");
    await page.goBack();
    await page.waitForFunction(() => !location.search.includes("review=mine"), undefined, { timeout: 15_000 });
    await page.waitForFunction(() => !document.querySelector('input[type="checkbox"]')?.checked, undefined, { timeout: 5000 });
    await page.goForward();
    await page.goForward();
    await current("Board");
    await page.goto(`${app}/w/${s.room}/tasks?view=board&task=${s.reviewScreen.id}`);
    await page.getByRole("button", { name: /Approve submission/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
    await current("Board");
  });

  const longUrl = (query = "") => `${app}/w/${s.longRoom}/tasks${query}`;
  const rows = (where) => where.locator('[data-sheet-launcher^="task:"]').count();
  const waitForRows = (where, above) => where.waitForFunction((n) => document.querySelectorAll('[data-sheet-launcher^="task:"]').length > n, above, { timeout: 30_000 });
  const everyRow = s.LONG_TASKS + 1;
  /** Stops the page from loading by itself, for the paths that are about the button. The others keep scrolling live. */
  const buttonOnly = async () => {
    const own = await contextFor(s.owner).newPage();
    await own.addInitScript(() => {
      const listen = window.addEventListener.bind(window);
      window.addEventListener = (type, ...rest) => (type === "scroll" ? undefined : listen(type, ...rest));
    });
    return own;
  };

  await keyboardPath("Load more with the keyboard, to the end of a long list", async () => {
    const own = await buttonOnly();
    try {
      await own.goto(longUrl());
      await hydrated(own);
      const first = await rows(own);
      ok(first === 50, `the first read showed ${first} rows, not one page`);
      const more = own.getByRole("button", { name: "Load more" });
      await tabTo(own, more, "Load more", 120);
      for (let loaded = first; loaded < everyRow; ) {
        await own.keyboard.press("Enter");
        await waitForRows(own, loaded);
        loaded = await rows(own);
        const live = await own.locator('[aria-live="polite"]').filter({ hasText: /view, showing/ }).textContent();
        ok(/more tasks? loaded/.test(live), `a loaded page wasn't announced: ${live}`);
        if (loaded < everyRow) {
          await own.waitForFunction(() => document.activeElement?.textContent === "Load more", null, { timeout: 15_000 });
        }
      }
      await own.waitForFunction(() => document.activeElement?.textContent?.startsWith("End of the list"), null, { timeout: 15_000 });
      ok((await own.getByText(`End of the list when it loaded: ${everyRow} tasks.`).count()) === 1, "the end of the list doesn't say so");
      // With everything loaded, the progress is a real one, for the whole set.
      ok((await own.getByRole("progressbar").count()) === 1, "progress still says partial with every task loaded");
    } finally {
      await own.close();
    }
  });

  await keyboardPath("a Sheet opened past the first page keeps the list, Back and focus", async () => {
    const own = await buttonOnly();
    try {
      await own.goto(longUrl());
      await hydrated(own);
      const more = own.getByRole("button", { name: "Load more" });
      await more.waitFor();
      await tabTo(own, more, "Load more", 120);
      await own.keyboard.press("Enter");
      await waitForRows(own, 50);
      const late = own.getByRole("link", { name: "Long task 250", exact: true });
      // Backward from the button, which is how far a keyboard user has got.
      for (let i = 0; i < 120 && !(await late.evaluate((el) => el === document.activeElement)); i++) await own.keyboard.press(SHIFT_TAB);
      ok(await late.evaluate((el) => el === document.activeElement), "couldn't reach a row from the second page");
      await own.keyboard.press("Enter");
      await own.getByRole("dialog").waitFor({ timeout: 15_000 });
      ok(own.url().includes("task="), "opening the row didn't reach the URL");
      await own.keyboard.press("Escape");
      await own.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
      await own.waitForFunction(() => document.activeElement?.textContent?.includes("Long task 250"), null, { timeout: 15_000 });
      ok((await rows(own)) > 50, "closing the Sheet dropped the pages already loaded");
      // Closing reaches the URL a moment later, and Back before that would leave the page's first entry.
      await own.waitForURL((url) => !url.search.includes("task="), { timeout: 15_000 });
      await own.goBack();
      await own.waitForURL(/task=/, { timeout: 15_000 });
      await own.getByRole("dialog").waitFor({ timeout: 5_000 }).catch(() => { throw new Error(`Back to ${own.url()} didn't open the Sheet`); });
      ok((await rows(own)) > 50, "Back dropped the pages already loaded");
      await own.goForward();
      await own.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
      // A deep link to a task no page has reached still opens. Closing it has no row to go back to, so focus lands on the page.
      await own.goto(longUrl(`?task=${s.lastReview.id}`));
      await own.getByRole("button", { name: /Approve submission/ }).waitFor({ timeout: 30_000 });
      await own.waitForFunction(() => document.activeElement?.closest('[role="dialog"]'), null, { timeout: 15_000 });
      await own.keyboard.press("Escape");
      await own.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
      await own.waitForFunction(() => document.activeElement && document.activeElement !== document.body, null, { timeout: 15_000 }).catch(async () => {
        throw new Error(`closing a deep-linked Sheet left focus on ${await activeText(own)}`);
      });
    } finally {
      await own.close();
    }
  });

  await keyboardPath("Needs my review finds a review past the loaded pages", async () => {
    const own = await buttonOnly();
    try {
      await own.goto(longUrl());
      await hydrated(own);
      const mine = own.getByRole("checkbox", { name: "Needs my review" });
      await tabTo(own, mine, "the review filter");
      await own.keyboard.press("Space");
      await own.getByRole("link", { name: "The review past every loaded page" }).waitFor({ timeout: 15_000 });
      ok(await mine.evaluate((el) => el === document.activeElement), `the filter's answer moved focus to ${await activeText(own)}`);
      ok((await rows(own)) === 1, `the filter shows ${await rows(own)} rows`);
      await own.goto(longUrl("?review=mine&view=board"));
      await own.getByRole("link", { name: "The review past every loaded page" }).waitFor({ timeout: 30_000 });
    } finally {
      await own.close();
    }
  });

  await keyboardPath("focus when scrolling ends the list, with scrolling live", async () => {
    const own = await contextFor(s.owner).newPage();
    const url = `${app}/w/${s.shortListRoom}/tasks`;
    try {
      // Tabbing to the button scrolls it into view, which loads the last page and takes the button away.
      await own.goto(url);
      await hydrated(own);
      const more = own.getByRole("button", { name: "Load more" });
      await more.waitFor();
      await more.focus();
      await own.getByText(/End of the list when it loaded: 60 tasks/).waitFor({ timeout: 15_000 });
      await own.waitForFunction(() => document.activeElement?.textContent?.startsWith("End of the list"), null, { timeout: 5000 }).catch(async () => {
        throw new Error(`the last page took the focused button away, leaving focus on ${await activeText(own)}`);
      });
      // A reader on a row stays there. Pressing the button earlier doesn't change that.
      await own.goto(url);
      await hydrated(own);
      const row = own.locator('[data-sheet-launcher^="task:"]').nth(3);
      await row.waitFor();
      await row.focus({ preventScroll: true });
      await own.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await own.getByText(/End of the list when it loaded: 60 tasks/).waitFor({ timeout: 15_000 });
      ok(await row.evaluate((el) => el === document.activeElement), `the list ending moved focus from a row to ${await activeText(own)}`);
    } finally {
      await own.close();
    }
  });

  await chromiumOnly("several thousand rows stay usable", async () => {
    const TARGET = 5000;
    const own = await buttonOnly();
    // Pages the server would have to hold thousands of tasks to answer, with instructions at their limit, which rows don't keep.
    const instructions = "x".repeat(64 * 1024);
    let served = 0;
    await own.route(/\/tasks\?cursor=[\w-]+&order=newest$/, (route) => {
      const start = 1000 + served;
      served += 50;
      const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `tsk_many_${start + i}`, title: `Many ${start + i}`, instructions, acceptance_criteria: null, requester: s.owner.id, assignee: null, reviewer: s.owner.id, status: i % 2 ? "open" : "completed", version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false }));
      // A cursor is the last task returned, as the API's are.
      return route.fulfill({ json: { tasks, next_cursor: tasks.at(-1).id } });
    });
    const cdp = await own.context().newCDPSession(own);
    await cdp.send("HeapProfiler.enable");
    await cdp.send("Performance.enable");
    const heapMb = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Math.round(metrics.find((metric) => metric.name === "JSHeapUsedSize").value / 1048576);
    };
    try {
      await own.goto(longUrl());
      await hydrated(own);
      // The list streams in after the shell, so the button can be on screen before React has it, and a script's click is lost then.
      await own.waitForFunction(() => Object.keys(document.querySelector("[data-task-load-more]") ?? {}).some((key) => key.startsWith("__reactProps")), null, { timeout: 15_000 });
      await own.evaluate(() => {
        window.__longest = 0;
        new PerformanceObserver((list) => list.getEntries().forEach((entry) => (window.__longest = Math.max(window.__longest, entry.duration)))).observe({ entryTypes: ["longtask"] });
      });
      const report = [];
      for (const milestone of [1000, 3000, TARGET]) {
        let page = 0;
        for (let loaded = await rows(own); loaded < milestone; loaded = await rows(own)) {
          page = await own.evaluate(async (before) => {
            const started = performance.now();
            window.__longest = 0;
            document.querySelector("[data-task-load-more]").click();
            while (document.querySelectorAll('[data-sheet-launcher^="task:"]').length <= before) {
              if (performance.now() - started > 30_000) throw new Error(`no new rows after 30 s at ${before}: ${document.querySelector("[data-task-load-more]")?.textContent}, ${document.querySelector('[role="alert"]')?.textContent}, ${performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/tasks?cursor=")).length} reads`);
              await new Promise((done) => setTimeout(done, 5));
            }
            await new Promise(requestAnimationFrame);
            return Math.round(performance.now() - started);
          }, loaded);
        }
        const stats = await own.evaluate(() => ({ elements: document.querySelectorAll("*").length, longest: Math.round(window.__longest) }));
        const heap = await heapMb();
        report.push(`${milestone} rows: last page ${page} ms, longest block ${stats.longest} ms, ${stats.elements} elements, ${heap} MB heap after GC`);
        // These pages carry 64 KB of instructions a row. Rows that kept them would hold 320 MB by the end.
        ok(heap < 120, `${milestone} rows hold ${heap} MB of heap after GC`);
        ok(page < 3000, `adding a page at ${milestone} rows took ${page} ms`);
      }
      const opened = Date.now();
      await own.getByRole("link", { name: "Long task 300", exact: true }).click();
      await own.getByRole("dialog").waitFor({ timeout: 30_000 });
      const sheet = Date.now() - opened;
      await own.keyboard.press("Escape");
      await own.getByRole("dialog").waitFor({ state: "hidden", timeout: 30_000 });
      const switched = await own.getByRole("link", { name: "Board", exact: true }).evaluate(async (link) => {
        const started = performance.now();
        link.click();
        await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
        return Math.round(performance.now() - started);
      });
      console.log(`measure ${TARGET} rows: ${report.join("; ")}; opening a Sheet ${sheet} ms; switching to Board ${switched} ms`);
      ok(sheet < 5000, `opening a Sheet over ${TARGET} rows took ${sheet} ms`);
    } finally {
      await own.close();
    }
  });

  await keyboardPath("Activity loads as the reader scrolls or presses Load more, one read at a time", async () => {
    const own = await contextFor(s.owner).newPage();
    const reads = [];
    own.on("request", (request) => {
      if (/\/activity\?.*before=/.test(request.url())) reads.push(request.url());
    });
    const events = () => own.locator("main ol > li").count();
    const grown = (than) => own.waitForFunction((n) => document.querySelectorAll("main ol > li").length > n, than, { timeout: 15_000 });
    try {
      await own.goto(`${app}/w/${s.longRoom}/activity`);
      await hydrated(own);
      ok((await events()) === 50, `the first read showed ${await events()} events, not one page`);
      await own.waitForTimeout(500);
      ok(reads.length === 0, `${reads.length} page reads before anyone scrolled`);
      // Chromium anchors scrolling by itself, which would hide a page that moves the reader. Safari has no such thing.
      await own.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
      const before = await own.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        const row = [...document.querySelectorAll("main ol > li")].find((el) => {
          const box = el.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight;
        });
        window.__row = row;
        return { top: row?.getBoundingClientRect().top, y: scrollY };
      });
      await grown(50);
      await own.waitForTimeout(3000);
      ok(reads.length === 1, `one scroll made ${reads.length} reads and ${await events()} events`);
      const after = await own.evaluate(() => ({ top: window.__row?.getBoundingClientRect().top, y: scrollY }));
      ok(Math.abs(after.top - before.top) <= 2 && Math.abs(after.y - before.y) <= 2, `a page moved the reader by ${after.top - before.top}px`);
      // A scroll that goes nowhere asks for nothing, and a move up doesn't either.
      await own.evaluate(() => window.scrollBy(0, 0));
      await own.evaluate(() => window.scrollBy(0, -100));
      await own.waitForTimeout(300);
      ok(reads.length === 1, "a scroll that wasn't down made another read");
      // The rest by keyboard: focus stays on the button, in view, until it goes, and each page says what it added.
      const more = own.getByRole("button", { name: "Load more" });
      await more.focus();
      const spoken = new Set();
      for (let loaded = await events(), presses = 0; presses < 40; presses++) {
        await own.waitForFunction(() => document.activeElement?.hasAttribute("data-activity-load-more") && document.activeElement.textContent === "Load more", null, { timeout: 15_000 });
        await own.keyboard.press("Enter");
        await grown(loaded);
        loaded = await events();
        const live = await own.locator('[aria-live="polite"]').filter({ hasText: /more events? loaded/ }).textContent();
        ok(!spoken.has(live), `the same words were announced twice: ${live}`);
        spoken.add(live);
        const end = await own.getByText(/^End of the activity/).count();
        if (end > 0) break;
        const box = await own.evaluate(() => {
          const rect = document.activeElement.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight && document.activeElement.hasAttribute("data-activity-load-more");
        });
        ok(box, "Load more lost focus, or left the window, after a page landed");
      }
      await own.waitForFunction(() => document.activeElement?.textContent?.startsWith("End of the activity"), null, { timeout: 15_000 });
      const ids = await own.locator("main ol > li").count();
      ok(reads.length === spoken.size + 1, `${reads.length} reads for ${spoken.size + 1} loads and ${ids} events`);
      // Filters carry to every page, and a cursor the room doesn't know keeps its own way back.
      reads.length = 0;
      await own.goto(`${app}/w/${s.longRoom}/activity?actor=${s.lead.id}`);
      await hydrated(own);
      await own.getByRole("button", { name: "Load more" }).click();
      await grown(50);
      ok(reads.length === 1 && reads[0].includes(`actor=${s.lead.id}`), `a later page dropped the filter: ${reads[0]}`);
      await own.goto(`${app}/w/${s.longRoom}/activity?before=evt_${"0".repeat(32)}`);
      await own.getByText("That page isn't available.").waitFor({ timeout: 15_000 });
      const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
      const small = await phone.newPage();
      await small.goto(`${app}/w/${s.longRoom}/activity`);
      const button = small.getByRole("button", { name: "Load more" });
      await button.waitFor({ timeout: 15_000 });
      // The server's HTML shows the button before React can hear it, and a click in that gap is lost, which a slow machine can hit.
      await hydrated(small);
      await button.click();
      await small.waitForFunction(() => document.querySelectorAll("main ol > li").length > 50, null, { timeout: 15_000 });
      const size = await button.boundingBox();
      ok(size && size.height >= 44, `Load more is ${size?.height}px tall at 375px`);
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 0, `long activity scrolls sideways by ${overflow}px at 375px`);
      await phone.close();
    } finally {
      await own.close();
    }
  });

  /**
   * Waits for text a person can see, and fails if they could see it twice. A slow page can also hold React's hidden streamed copy
   * for a moment after React has drawn the screen itself, and that copy is in the document without being on screen.
   */
  const shownOnce = (where, text) => where.getByText(text).filter({ visible: true }).waitFor({ timeout: 15_000 });

  await keyboardPath("progress counts past the loaded pages, and Blocked shows in both views, at phone width too", async () => {
    const own = await contextFor(s.owner).newPage();
    try {
      for (const query of ["", "?view=board"]) {
        await own.goto(longUrl(query));
        await hydrated(own);
        // The list is in the document before React reveals it, and `hydrated` only checks the first control. A count here can catch
        // that gap, and the checks below that something is absent would pass for the wrong reason.
        await own.getByRole("button", { name: "Load more" }).waitFor({ timeout: 15_000 }).catch(() => {
          throw new Error("the room should still have pages to load");
        });
        ok((await own.getByRole("button", { name: "Load more" }).count()) === 1, "the room should have one Load more");
        const bar = own.getByRole("progressbar", { name: "Progress" });
        const said = await bar.getAttribute("aria-valuetext");
        ok(/^0 of 32\d completed, 0%$/.test(said), `progress past the first page reads ${said}`);
        ok((await own.getByText(/partial/).count()) === 0, "progress still says partial with a complete plan");
        await shownOnce(own, "Blocked: waiting on “Long task 318”");
        ok((await own.getByRole("heading", { name: /^Blocked/ }).count()) === 0, "Blocked became a column");
      }
    } finally {
      await own.close();
    }
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const query of ["", "?view=board"]) {
      await small.goto(longUrl(query));
      await shownOnce(small, "Blocked: waiting on “Long task 318”");
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 0, `tasks${query} scrolls sideways by ${overflow}px at 375px with Blocked on it`);
    }
    await phone.close();
  });

  await keyboardPath("the Gantt table: real rows, a keyboard path to the Sheet and back, and no sideways page at phone width", async () => {
    const own = await contextFor(s.owner).newPage();
    try {
      await own.goto(longUrl());
      await hydrated(own);
      const gantt = own.getByRole("link", { name: "Gantt", exact: true });
      await tabTo(own, gantt, "the Gantt link");
      await own.keyboard.press("Enter");
      await own.waitForURL(/view=gantt/, { timeout: 15_000 });
      const row = own.getByRole("row").filter({ has: own.getByRole("link", { name: "Long task 319", exact: true }) });
      await row.getByRole("cell", { name: "Long task 318" }).waitFor({ timeout: 15_000 });
      ok(await row.getByRole("cell", { name: "3 working days", exact: true }).count() === 1, "the estimate didn't show with its units");
      ok(await row.getByRole("cell", { name: "Unavailable", exact: true }).count() === 1, "planned dates should be unavailable");
      await shownOnce(own, "Forecast unavailable");
      await shownOnce(own, "No capacity/resource leveling");
      const link = row.getByRole("link", { name: "Long task 319", exact: true });
      await hydrated(own);
      await tabTo(own, link, "the row's link");
      await own.keyboard.press("Enter");
      await own.getByRole("dialog").waitFor({ timeout: 15_000 });
      ok(own.url().includes("view=gantt") && own.url().includes("task="), `opening a row changed the view: ${own.url()}`);
      await own.keyboard.press("Escape");
      await own.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
      await own.waitForFunction(() => document.activeElement?.getAttribute("data-sheet-launcher")?.startsWith("task:"), undefined, { timeout: 5000 }).catch(async () => {
        throw new Error(`closing the Sheet left focus on ${await activeText(own)}, not the row that opened it`);
      });
      ok(own.url().includes("view=gantt"), `closing the Sheet lost the view: ${own.url()}`);
    } finally {
      await own.close();
    }
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    await small.goto(longUrl("?view=gantt"));
    await hydrated(small);
    const region = small.getByRole("region", { name: "Task plan table" });
    await region.waitFor({ timeout: 15_000 });
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `the Gantt scrolls the page sideways by ${overflow}px at 375px`);
    ok(await region.evaluate((el) => el.scrollWidth > el.clientWidth), "the table should scroll inside its region at 375px");
    const share = await region.evaluate((el) => el.querySelector("tbody th").getBoundingClientRect().width / el.clientWidth);
    ok(share <= 0.55, `the column that stays put takes ${Math.round(share * 100)}% of the table's width at 375px`);
    await region.focus();
    await small.keyboard.press("ArrowRight");
    if (browserName === "webkit") {
      await small.waitForTimeout(1_000);
      unseenInWebKit("arrow keys scrolling the Gantt table", await region.evaluate((el) => el.scrollLeft > 0));
    } else {
      await small.waitForFunction(() => document.querySelector('[role="region"][aria-label="Task plan table"]').scrollLeft > 0, undefined, { timeout: 5000 }).catch(() => {
        throw new Error("the arrow keys don't scroll the table");
      });
    }
    await audit(small, "Tasks, Gantt, phone");
    await phone.close();
  });

  await keyboardPath("the baseline plan: dates from the server, bars by keyboard, and setting the start", async () => {
    const own = await contextFor(s.owner).newPage();
    const url = `${app}/w/${s.plannedRoom}/tasks?view=gantt`;
    try {
      await own.goto(url);
      await hydrated(own);
      await shownOnce(own, "Baseline plan");
      await shownOnce(own, "The start date, Saturday, Nov 7, 2026, isn't a working day, so the plan begins on Monday, Nov 9, 2026.");
      await shownOnce(own, "Left out of this plan: 1 completed task with no estimate");
      const panel = own.locator('section[aria-labelledby="gantt-forecast"]');
      await panel.getByText("Finished with no estimate").waitFor({ timeout: 5000 });
      ok((await panel.getByRole("listitem").filter({ hasText: "No capacity/resource leveling." }).count()) === 1, "the assumptions should come from the server");
      const row = own.getByRole("row").filter({ has: own.getByRole("link", { name: "Next step", exact: true }) });
      await row.getByRole("cell", { name: /Nov 11 to Nov 27, 2026/ }).waitFor({ timeout: 5000 });
      await row.getByRole("cell", { name: "First step", exact: true }).waitFor({ timeout: 5000 });
      const region = own.getByRole("region", { name: "Timeline" });
      await region.waitFor({ timeout: 5000 });
      ok((await region.locator("path[marker-end]").count()) === 1, "the one link should draw one arrow");
      const bar = region.getByRole("link", { name: /^Next step, Nov 11 to Nov 27, 2026, Critical/ });
      await hydrated(own);
      await tabTo(own, bar, "the bar");
      await own.keyboard.press("Enter");
      await own.getByRole("dialog").waitFor({ timeout: 15_000 });
      ok(own.url().includes("view=gantt") && own.url().includes("task="), `opening a bar changed the view: ${own.url()}`);
      await own.keyboard.press("Escape");
      await own.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
      await own.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Next step,"), undefined, { timeout: 5000 }).catch(async () => {
        throw new Error(`closing the Sheet left focus on ${await activeText(own)}, not the bar that opened it`);
      });
      const skip = own.getByRole("button", { name: "Skip to the table" });
      await skip.focus();
      await own.keyboard.press("Enter");
      ok(await own.getByRole("region", { name: "Task plan table" }).evaluate((el) => el === document.activeElement), "skipping the bars didn't reach the table");
      // By keyboard, through the real command, and read back from the server.
      const change = own.getByRole("button", { name: "Change start date" });
      await change.focus();
      await own.keyboard.press("Enter");
      const date = own.getByLabel("Start date");
      await date.waitFor({ timeout: 5000 });
      ok(await date.evaluate((el) => el === document.activeElement), "opening the form didn't move focus to the date");
      await date.fill("2026-11-16");
      await tabTo(own, own.getByRole("button", { name: "Save start" }), "Save start");
      await own.keyboard.press("Enter");
      await row.getByRole("cell", { name: /Nov 18 to Dec 4, 2026/ }).waitFor({ timeout: 15_000 });
      ok((await own.getByText("isn't a working day").count()) === 0, "a Monday start shouldn't say it moved");
      await own.waitForFunction(() => document.activeElement?.textContent === "Change start date", undefined, { timeout: 5000 }).catch(async () => {
        throw new Error(`saving left focus on ${await activeText(own)}`);
      });
      await own.reload();
      await row.getByRole("cell", { name: /Nov 18 to Dec 4, 2026/ }).waitFor({ timeout: 15_000 });
    } finally {
      await own.close();
    }
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    await small.goto(url);
    await shownOnce(small, "Baseline plan");
    await hydrated(small);
    const closed = small.getByRole("region", { name: "Timeline" });
    ok(!(await closed.isVisible()), "the timeline should start closed on a phone");
    await small.getByText("Timeline", { exact: true }).click();
    await closed.waitFor({ timeout: 5000 });
    ok(await closed.evaluate((el) => el.scrollWidth > el.clientWidth), "the timeline should scroll inside its region at 375px");
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `the baseline plan scrolls the page sideways by ${overflow}px at 375px`);
    await audit(small, "Tasks, Gantt, baseline plan, phone, open");
    await phone.close();
  });

  await keyboardPath("a long list loads near the bottom without moving the reader, and what it costs", async () => {
    for (const [view, query] of [["List", ""], ["Board", "?view=board"]]) {
      const own = await contextFor(s.owner).newPage();
      const reads = [];
      own.on("request", (request) => {
        if (/\/tasks\?cursor=/.test(request.url())) reads.push(request.url());
      });
      try {
        const opened = Date.now();
        await own.goto(longUrl(query));
        await own.getByRole("link", { name: "Long task 319", exact: true }).waitFor({ timeout: 30_000 });
        const firstScreen = Date.now() - opened;
        await hydrated(own);
        ok(reads.length <= 1, `${view}: ${reads.length} page reads before anyone scrolled`);
        // Chromium anchors scrolling by itself, which would hide a page that doesn't. Safari has no such thing.
        await own.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
        // One scroll is one person's action, and it asks for one page, however long the reader then sits there.
        const readsBefore = reads.length;
        await own.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await waitForRows(own, 50);
        await own.waitForTimeout(3000);
        ok(reads.length - readsBefore === 1, `${view}: one scroll made ${reads.length - readsBefore} reads and ${await rows(own)} rows`);
        // Sitting at the very bottom, a scroll that goes nowhere asks for nothing either.
        await own.evaluate(() => window.scrollBy(0, 0));
        await own.waitForTimeout(300);
        ok(reads.length - readsBefore === 1, `${view}: a scroll that went nowhere made another read`);
        const loadedAt = Date.now();
        let worst = 0;
        const shifts = [];
        for (let loaded = await rows(own); loaded < everyRow; ) {
          // A row in view right now, and where it sits.
          const before = await own.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const row = [...document.querySelectorAll('[data-sheet-launcher^="task:"]')].find((el) => {
              const box = el.getBoundingClientRect();
              return box.top >= 0 && box.bottom <= innerHeight;
            });
            window.__anchor = row;
            return row?.getBoundingClientRect().top;
          });
          await waitForRows(own, loaded).catch(async () => {
            throw new Error(`${view}: going back to the bottom at ${loaded} rows read nothing, after ${reads.length} reads`);
          });
          await own.evaluate(() => new Promise(requestAnimationFrame));
          const after = await own.evaluate(() => window.__anchor?.getBoundingClientRect().top);
          if (before !== undefined && after !== undefined) {
            shifts.push(Math.round(Math.abs(after - before)));
            worst = Math.max(worst, Math.abs(after - before));
          }
          loaded = await rows(own);
        }
        const allLoaded = Date.now() - loadedAt;
        ok(worst <= 2, `${view}: a row in view moved as rows arrived: ${shifts.join(", ")}px by page`);
        const sideways = await own.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        ok(sideways <= 0, `${view}: the page scrolls sideways by ${sideways}px`);
        const cost = await own.evaluate(() => ({ nodes: document.querySelectorAll("*").length }));
        // How long a person waits for the switch once every row is there.
        const other = own.getByRole("link", { name: view === "List" ? "Board" : "List", exact: true });
        const switched = await other.evaluate(async (link) => {
          const started = performance.now();
          link.click();
          await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
          return Math.round(performance.now() - started);
        });
        console.log(`measure ${view}: ${everyRow} tasks, first screen ${firstScreen} ms, the rest ${allLoaded} ms over ${reads.length} reads, worst row shift ${worst}px, ${cost.nodes} elements, switching view ${switched} ms`);
      } finally {
        await own.close();
      }
    }
  });

  await keyboardPath("a long list at phone width", async () => {
    const own = await contextFor(s.owner).newPage();
    await own.setViewportSize({ width: 375, height: 812 });
    try {
      for (const query of ["", "?view=board"]) {
        await own.goto(longUrl(query));
        await hydrated(own);
        const more = own.getByRole("button", { name: /Load more|Loading more/ });
        await more.waitFor();
        const box = await more.boundingBox();
        ok(box && box.height >= 44, `Load more is ${box?.height}px tall at 375px`);
        await own.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await waitForRows(own, 50);
        const sideways = await own.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        ok(sideways <= 0, `the page scrolls sideways by ${sideways}px at 375px`);
      }
      await audit(own, "Tasks, long list, phone");
      await own.evaluate(() => window.scrollTo(0, 0));
      await tabTo(own, own.locator('[data-sheet-launcher^="task:"]').first(), "a row", 120);
    } finally {
      await own.close();
    }
  });

  await keyboardPath("the board at phone width", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    try {
      await page.goto(`${app}/w/${s.room}/tasks?view=board&canceled=show`);
      await hydrated(page);
      await page.getByText("A canceled task").waitFor({ timeout: 15_000 });
      const overflow = await page.evaluate(() => [document.documentElement, document.getElementById("main-content")].filter((el) => el && el.scrollWidth > el.clientWidth).map((el) => el.tagName));
      ok(overflow.length === 0, `the page scrolls sideways at 375px: ${overflow.join(", ")}`);
      await audit(page, "Tasks, board, phone");
      const link = page.getByRole("link", { name: "An open task", exact: true });
      await tabTo(page, link, "the card's link");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor({ timeout: 15_000 });
      const box = await page.getByRole("dialog").boundingBox();
      ok(box && box.width <= 375, `the Sheet is wider than the phone: ${box?.width}`);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  await keyboardPath("revoke access", async () => {
    await page.goto(`${app}/w/${s.room}/team`);
    await hydrated(page);
    const row = page.getByRole("listitem").filter({ hasText: "Revokee agent" });
    await tabTo(page, row.getByRole("link", { name: "Manage access" }), "Manage access");
    await page.keyboard.press("Enter");
    const revoke = page.getByRole("button", { name: "Revoke workroom access" });
    await revoke.waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    await tabTo(page, revoke, "Revoke workroom access");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 15_000 });
    await audit(page, "Revoke confirmation");
    ok(await dialog.evaluate((el) => el.contains(document.activeElement)), `the confirmation left focus on ${await activeText(page)}`);
    await tabTo(page, dialog.getByRole("button", { name: "Revoke access" }), "Revoke access");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    const status = await page.evaluate(() => document.activeElement?.closest('[role="status"], [role="alert"], [aria-live]') ? (document.activeElement.textContent ?? "") : null);
    ok(status !== null, `after revoking, focus is on ${await activeText(page)}, not on a status that says what happened`);
  });
  // Phone width comes first, because the paths below change what these pages show.
  await keyboardPath("ownership screens at phone width", async () => {
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const [label, path, control] of [["recovery", "/settings/organization", "Name new owner"], ["transfer", `/w/${s.transferRoom}/settings`, "Transfer ownership"]]) {
      await small.goto(`${app}${path}`);
      await hydrated(small);
      const button = small.getByRole("button", { name: control }).first();
      await button.waitFor({ timeout: 15_000 });
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 0, `${label} scrolls sideways by ${overflow}px at 375px`);
      const height = (await button.boundingBox())?.height ?? 0;
      ok(height >= 44, `${label}'s button is ${height}px tall at 375px`);
    }
    await phone.close();
  });
  await keyboardPath("agent text at phone width", async () => {
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    await small.goto(`${app}/w/${s.room}/tasks?task=${s.reviewScreen.id}`);
    await hydrated(small);
    const scroller = small.getByRole("group", { name: "Table in this text" }).first();
    await scroller.waitFor({ timeout: 15_000 });
    const sizes = await scroller.evaluate((el) => ({ page: document.documentElement.scrollWidth - window.innerWidth, sheet: el.closest('[role="dialog"]').scrollWidth - el.closest('[role="dialog"]').clientWidth, table: el.scrollWidth - el.clientWidth }));
    ok(sizes.page <= 0, `the page scrolls sideways by ${sizes.page}px at 375px`);
    ok(sizes.sheet <= 0, `the Sheet scrolls sideways by ${sizes.sheet}px at 375px`);
    ok(sizes.table > 0, "the wide table doesn't scroll in its own container, so this check proves nothing");
    await tabTo(small, scroller, "the table");
    await small.keyboard.press("ArrowRight");
    await small.waitForFunction((el) => el.scrollLeft > 0, await scroller.elementHandle(), { timeout: 5_000 }).catch(() => {});
    // Whether Safari does this needs Safari. In Playwright's WebKit the table has focus and can scroll, and a key doesn't move even a plain box.
    if (browserName === "webkit") unseenInWebKit("arrow keys scrolling a table", await scroller.evaluate((el) => el.scrollLeft > 0));
    else ok(await scroller.evaluate((el) => el.scrollLeft > 0), "the arrow keys don't scroll the table");
    const box = small.getByRole("checkbox", { name: "Author's mark, not verified by Podster" }).first();
    ok(await box.isDisabled(), "a checklist mark isn't disabled");
    const before = await box.isChecked();
    await box.click({ force: true });
    ok((await box.isChecked()) === before, "clicking a checklist mark changed it");
    ok(await box.evaluate((el) => getComputedStyle(el.closest("li")).listStyleType === "none"), "a checklist item still has a bullet");
    const marksNote = small.getByText("Podster hasn't verified them").first();
    ok((await marksNote.boundingBox()).y < (await box.boundingBox()).y, "the note about checked boxes isn't above them");
    ok((await small.getByRole("heading", { name: "A heading", level: 4 }).count()) > 0, "agent text's heading isn't at the fixed level");
    const narrow = small.getByRole("group", { name: "Table in this text" }).nth(1);
    await small.waitForTimeout(200);
    ok((await narrow.getAttribute("tabindex")) === null, "a table that fits is still a tab stop");
    await phone.close();
  });

  await keyboardPath("oversized agent tables don't freeze the Sheet", async () => {
    const started = Date.now();
    await page.goto(`${app}/w/${s.room}/tasks?task=${s.oversized.id}`);
    await page.getByText("too large to show as a table").first().waitFor({ timeout: 15_000 });
    await hydrated(page);
    ok((await page.locator("table td").count()) < 2_500, "an oversized table still rendered as a table");
    const responded = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(true))));
    ok(responded && Date.now() - started < 15_000, `the Sheet took ${Date.now() - started}ms`);
  });

  // The longest the main thread was blocked, from opening a screen to reading it to the end. Each shape used to block 300 ms to 2 s per body.
  const LONGEST_BLOCK_MS = 700;
  const watchBlocks = (context) => context.addInitScript(() => {
    window.longestBlock = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longestBlock = Math.max(window.longestBlock, entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  // A slow body has to be timed or laid out once, up to about 340 ms locally. Without skipped layout, these blocked for 922 ms on the Task Sheet and 2,226 ms on oversight.
  const LONGEST_BLOCK_SCRIPTS_MS = 800;
  const TAB_BACK_BLOCK_MS = 1_000;
  const openHeavy = async (label, context, path, tab, longest = LONGEST_BLOCK_MS, idleWait = 3_000) => {
    await watchBlocks(context);
    const own = await context.newPage();
    try {
      const started = Date.now();
      await own.goto(`${app}${path}`);
      await own.getByRole("dialog").getByRole("tab", { name: tab }).waitFor({ timeout: 30_000 });
      await hydrated(own);
      await own.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
      const opened = Date.now() - started;
      ok(opened < 10_000, `${label} took ${opened}ms to open`);
      // What's on the page before the screen's own work starts isn't this code's cost, such as hydrating the shell.
      const startup = await own.evaluate(() => {
        const was = window.longestBlock;
        window.longestBlock = 0;
        return Math.round(was);
      });
      const switched = Date.now();
      await own.getByRole("dialog").getByRole("tab", { name: tab }).click();
      await own.getByRole("dialog").locator("article").first().waitFor({ timeout: 30_000 });
      await own.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
      const shown = Date.now() - switched;
      ok(shown < 10_000, `${label}'s tab took ${shown}ms to show`);
      // Reading to the end pays for each body once, a body at a time, and input can get in between them.
      const read = await own.getByRole("dialog").evaluate(async (sheet) => {
        const started = performance.now();
        for (const article of sheet.querySelectorAll("article")) {
          article.scrollIntoView();
          await new Promise((done) => setTimeout(() => requestAnimationFrame(done), 50));
        }
        return Math.round(performance.now() - started);
      });
      const blocked = await own.evaluate(() => Math.round(window.longestBlock));
      ok(blocked < longest, `${label} blocked the main thread for ${blocked}ms`);
      // Let what's idle finish, then switch away and back: whatever stayed laid out is laid out again, all at once.
      await own.waitForTimeout(idleWait);
      const stayed = await own.getByRole("dialog").evaluate((sheet) => {
        const bodies = [...sheet.querySelectorAll("article > div")];
        return `${bodies.filter((body) => body.style.contentVisibility === "visible").length} of ${bodies.length}`;
      });
      await own.evaluate(() => (window.longestBlock = 0));
      await own.getByRole("dialog").getByRole("tab", { name: /^(Details)$/ }).click();
      await own.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))));
      await own.getByRole("dialog").getByRole("tab", { name: tab }).click();
      await own.getByRole("dialog").locator("article").last().waitFor({ timeout: 30_000 });
      await own.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 200))));
      const tabBack = await own.evaluate(() => Math.round(window.longestBlock));
      console.log(`     ${label}: ${stayed} stayed laid out, longest block on tabbing back ${tabBack}ms`);
      ok(tabBack < TAB_BACK_BLOCK_MS, `${label} blocked for ${tabBack}ms on tabbing back`);
      console.log(`     ${label}: opened in ${opened}ms (longest block ${startup}ms), tab showed in ${shown}ms, read to the end in ${read}ms, longest block ${blocked}ms`);
    } finally {
      await own.close().catch(() => {});
    }
  };
  await keyboardPath("a heavy thread on the Task Sheet (the latest 20 messages)", () => openHeavy("the Task Sheet", contextFor(s.owner), `/w/${s.room}/tasks?task=${s.heavyThread.id}`, /^Discussion/));
  await keyboardPath("a heavy thread on oversight (50 messages)", () => openHeavy("oversight", contextFor(s.partner), `/oversight/${s.room}/${s.guest.id}?task=${s.heavyThread.id}`, "Thread"));
  await keyboardPath("unbroken scripts on the Task Sheet (the latest 20 messages)", () => openHeavy("the Task Sheet, unbroken scripts", contextFor(s.owner), `/w/${s.room}/tasks?task=${s.scriptThread.id}`, /^Discussion/, LONGEST_BLOCK_SCRIPTS_MS));
  await keyboardPath("unbroken scripts on oversight (50 messages)", () => openHeavy("oversight, unbroken scripts", contextFor(s.partner), `/oversight/${s.room}/${s.guest.id}?task=${s.scriptThread.id}`, "Thread", LONGEST_BLOCK_SCRIPTS_MS));
  await keyboardPath("unbroken Arabic on oversight (50 messages)", () => openHeavy("oversight, unbroken Arabic", contextFor(s.partner), `/oversight/${s.room}/${s.guest.id}?task=${s.arabicThread.id}`, "Thread", LONGEST_BLOCK_SCRIPTS_MS));
  await keyboardPath("alternating directions on oversight (50 messages)", () => openHeavy("oversight, alternating directions", contextFor(s.partner), `/oversight/${s.room}/${s.guest.id}?task=${s.hebrewLatinThread.id}`, "Thread", LONGEST_BLOCK_SCRIPTS_MS));
  await keyboardPath("a heavy short thread on oversight (50 messages)", () => openHeavy("oversight, short messages", contextFor(s.partner), `/oversight/${s.room}/${s.guest.id}?task=${s.shortThread.id}`, "Thread"));

  await keyboardPath("a long brief formats in a worker, under the real CSP", async () => {
    const own = await contextFor(s.owner).newPage();
    const refused = [];
    own.on("console", (message) => {
      if (/Content Security Policy|Worker/.test(message.text())) refused.push(message.text());
    });
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.longBrief.id}`);
    const bold = own.getByRole("dialog").locator("article strong").filter({ hasText: "A bold start" });
    await bold.waitFor({ timeout: 15_000 }).catch(() => {});
    ok(await bold.isVisible(), `a long brief never formatted${refused.length ? `: ${refused[0]}` : ""}`);
    ok((await own.getByRole("dialog").locator("article a").first().getAttribute("href")) === "https://example.com/brief", "a long brief's link didn't format");
    ok((await own.getByRole("dialog").locator("article").first().innerText()).includes("café"), "a long brief's entity wasn't decoded");
    ok(await own.evaluate(() => window.find("A bold start and")), "find-in-page can't match text that spans markup");
    await own.close();
  });

  await keyboardPath("a body over the time limit falls back to plain text", async () => {
    const own = await contextFor(s.owner).newPage();
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.slowBrief.id}`);
    await own.getByRole("dialog").getByText(CANT_FORMAT).first().waitFor({ timeout: 15_000 });
    await own.close();
  });

  // Opens the tall thread's Discussion at its end, with nothing applied until then. What's near the top when the tab opens formats
  // too, and each one that shrinks brings the next into range, so how many had by the jump depended on how fast the runner was: on
  // CI, 6 of the 10 far above. Holding the worker back until after the jump leaves only what this is about.
  const openTall = async (own) => {
    let release;
    const jumped = new Promise((done) => (release = done));
    await own.route("**/static/workers/**", async (route) => {
      await jumped;
      await route.continue();
    });
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.tallThread.id}`);
    const sheet = own.getByRole("dialog");
    await sheet.getByRole("tab", { name: /^Discussion/ }).click();
    await sheet.locator("article").last().waitFor({ timeout: 15_000 });
    await sheet.evaluate((dialog) => dialog.querySelectorAll("article")[dialog.querySelectorAll("article").length - 1].scrollIntoView({ block: "end" }));
    release();
    // Settled once the last body has formatted and the count has stopped changing.
    await sheet.locator("article").last().locator("strong").first().waitFor({ state: "attached", timeout: 20_000 });
    let [count, steady] = [-1, 0];
    for (let i = 0; i < 60 && steady < 4; i++) {
      await own.waitForTimeout(250);
      const now = await sheet.locator("article:has(strong)").count();
      steady = now === count ? steady + 1 : 0;
      count = now;
    }
    return sheet;
  };

  await keyboardPath("agent text formats ahead of the view, not everywhere", async () => {
    const own = await contextFor(s.owner).newPage();
    const sheet = await openTall(own);
    const rows = await sheet.evaluate((dialog) => {
      let scroller = dialog.querySelector("article").parentElement;
      while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const top = scroller.getBoundingClientRect().top;
      return [...dialog.querySelectorAll("article")].map((article) => ({ above: Math.round(top - article.getBoundingClientRect().bottom), formatted: article.querySelector("strong") !== null }));
    });
    const justAbove = rows.filter((row) => row.above > 100 && row.above < 1_000);
    const farAbove = rows.filter((row) => row.above > 3_000);
    console.log(`     ${justAbove.length} just above the view, ${farAbove.length} far above`);
    ok(justAbove.length > 0 && justAbove.every((row) => row.formatted), `a body up to 1,000 px above the view isn't formatted: ${JSON.stringify(justAbove)}`);
    // Each of these results is about 4,500 nodes, and only 20,000 can be applied out of view.
    const appliedFarAbove = farAbove.length - farAbove.filter((row) => !row.formatted).length;
    console.log(`     ${appliedFarAbove} of ${farAbove.length} far above were applied`);
    ok(farAbove.length >= 8, `only ${farAbove.length} bodies were far above the view, so this proves little`);
    ok(appliedFarAbove <= 4, `${appliedFarAbove} large results far above the view were applied, past what's allowed out of view`);
    await own.close();
  });

  await keyboardPath("scrolling up keeps the reader's place", async () => {
    for (const [label, viewport] of [["desktop", undefined], ["375px", { width: 375, height: 800 }]]) {
      const context = viewport ? await browser.newContext({ reducedMotion: "reduce", viewport, storageState: await contextFor(s.owner).storageState() }) : contextFor(s.owner);
      const own = await context.newPage();
      const sheet = await openTall(own);
      const shift = await sheet.evaluate(async (dialog) => {
        let scroller = dialog.querySelector("article").parentElement;
        while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        const view = () => scroller.getBoundingClientRect();
        const items = () => [...dialog.querySelectorAll("article")];
        const formatted = () => items().filter((article) => article.querySelector("strong")).length;
        const startedWith = formatted();
        let worst = 0;
        for (let step = 0; step < 60 && scroller.scrollTop > 0; step++) {
          // Something in view that isn't changing: the first article already formatted, or a timestamp between two.
          const inView = items().filter((article) => article.querySelector("strong") && article.getBoundingClientRect().bottom > view().top && article.getBoundingClientRect().top < view().bottom)[0];
          if (!inView) break;
          const before = inView.getBoundingClientRect().top;
          const moved = Math.min(150, scroller.scrollTop);
          scroller.scrollTop -= moved;
          await new Promise((done) => setTimeout(done, 120));
          worst = Math.max(worst, Math.abs(inView.getBoundingClientRect().top - before - moved));
        }
        return { worst: Math.round(worst), swapped: formatted() - startedWith };
      });
      const { worst, swapped } = shift;
      console.log(`     scrolling up at ${label}: worst shift ${worst}px, across ${swapped} bodies that formatted on the way`);
      ok(swapped > 0, `scrolling up at ${label} formatted nothing, so this proves nothing`);
      ok(worst <= 20, `scrolling up at ${label} moved what was being read by ${worst}px`);
      await own.close();
      if (viewport) await context.close();
    }
  });

  await keyboardPath("the message box's preview works by keyboard, and changes nothing that's sent", async () => {
    const own = await contextFor(s.owner).newPage();
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.composeTask.id}`);
    const sheet = own.getByRole("dialog");
    await sheet.getByRole("tab", { name: /^Discussion/ }).click();
    await hydrated(own);
    const refused = [];
    own.on("console", (message) => {
      if (/Content Security Policy/.test(message.text())) refused.push(message.text());
    });
    const sent = [];
    own.on("request", (request) => {
      if (request.method() === "POST" && /\/messages$/.test(new URL(request.url()).pathname)) sent.push(request.postDataJSON().body);
    });
    const written = "_id ~/foo C:\\Users\\me **bold** `a\\_b`\n\ndef __init__(self, *args):\n\nhttps://ex.com/~me/_x?a=*b <img src=x onerror=\"window.pwned=1\"> [x](javascript:window.pwned=2)";
    const box = sheet.getByLabel("Post a message");
    await box.fill(written);
    const toggle = sheet.getByRole("button", { name: /^(Preview|Edit)$/ });
    await tabTo(own, sheet.getByRole("button", { name: "Post message" }), "the post button");
    await toggle.focus();
    await own.keyboard.press("Enter");
    const preview = sheet.getByRole("region", { name: "Preview of your message" });
    await preview.locator("strong").first().waitFor({ timeout: 15_000 });
    ok((await toggle.innerText()).trim() === "Edit", "the toggle doesn't say how to get back");
    ok((await preview.getByText("Not posted yet", { exact: false }).count()) === 2, "the preview doesn't say it isn't posted, before and after the card");
    ok(await toggle.evaluate((el) => el === document.activeElement), "focus left the toggle");
    ok((await preview.locator("img, script, iframe, a[href^='javascript']").count()) === 0, "hostile text became elements in the preview");
    ok((await own.evaluate(() => window.pwned)) === undefined, "hostile text ran in the preview");
    await audit(own, "Message preview");
    await own.keyboard.press("Enter");
    await box.waitFor({ timeout: 5_000 });
    ok((await box.inputValue()) === written, "closing the preview changed the text");
    ok((await toggle.innerText()).trim() === "Preview", "the toggle didn't go back");
    await toggle.focus();
    await own.keyboard.press("Enter");
    await tabTo(own, sheet.getByRole("button", { name: "Post message" }), "the post button");
    await own.keyboard.press("Enter");
    await sheet.getByText("Posted.").waitFor({ timeout: 15_000 });
    ok(sent[0] === written, `previewing changed what's sent: ${JSON.stringify(sent[0])}`);
    ok(await box.evaluate((el) => el === document.activeElement), "focus didn't return to the box");
    await box.fill(written);
    await sheet.getByRole("button", { name: "Post message" }).click();
    await own.waitForFunction(() => document.querySelector("#thread-message")?.value === "", null, { timeout: 15_000 });
    ok(sent[1] === sent[0], "the body differs with and without previewing");
    ok(refused.length === 0, `the policy refused something: ${refused[0]}`);
    await own.close();
  });

  await keyboardPath("the message box's preview at phone width", async () => {
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const own = await phone.newPage();
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.composeTask.id}`);
    const sheet = own.getByRole("dialog");
    await sheet.getByRole("tab", { name: /^Discussion/ }).click();
    await hydrated(own);
    await sheet.getByLabel("Post a message").fill(`A wide one: ${"unbroken".repeat(60)}\n\n| a | b |\n| - | - |\n| ${"wide".repeat(60)} | c |`);
    const toggle = sheet.getByRole("button", { name: /^(Preview|Edit)$/ });
    ok(((await toggle.boundingBox())?.height ?? 0) >= 44, "the toggle is under 44px tall at 375px");
    await toggle.click();
    await sheet.getByRole("region", { name: "Preview of your message" }).locator("table").waitFor({ timeout: 15_000 });
    const sizes = await sheet.evaluate((dialog) => ({ page: document.documentElement.scrollWidth - window.innerWidth, sheet: dialog.scrollWidth - dialog.clientWidth }));
    ok(sizes.page <= 0 && sizes.sheet <= 0, `the preview scrolls sideways at 375px: ${JSON.stringify(sizes)}`);
    // A result too large to apply out of view still formats here, because the preview is in view.
    await toggle.click();
    await sheet.getByLabel("Post a message").fill("- item\n".repeat(600).trim());
    await toggle.click();
    await sheet.getByRole("region", { name: "Preview of your message" }).locator("li").nth(599).waitFor({ state: "attached", timeout: 15_000 });
    await phone.close();
  });

  // Everything a page holds or was sent, hidden or not, so nothing can pass by being out of sight.
  const limitedPage = async (person, org) => {
    const context = contextFor(person);
    if (org) await context.addCookies([{ name: ORG_COOKIE, value: org, domain: new URL(app).hostname, path: "/" }]);
    const own = await context.newPage();
    const sent = [];
    own.on("response", (response) => {
      if (!response.url().startsWith(app) || /_next\/static/.test(response.url())) return;
      const url = response.url().replace(app, "");
      // The shell asks for this to keep the session fresh and never reads the answer, so it never finishes. It's the person's own session.
      if (url === "/api/auth/get-session") return;
      // A redirect has no body, and neither has a response the page left behind. One still open is named rather than waited on.
      const read = response.text().then((text) => ({ url, text }), () => ({ url, text: "" }));
      sent.push(Promise.race([read, new Promise((resolve) => setTimeout(() => resolve({ url, open: true }), 5_000).unref())]));
    });
    const hidesAll = async (label, also = [s.otherWorker.id, "Other worker"]) => {
      // `also` has the worker, because Collaboration shows people rather than tasks.
      const words = [...Object.values(s.SECRET), s.secretTask.id, ...also];
      const held = await own.content();
      for (const word of words) ok(!held.includes(word), `${label} holds ${word} in its page`);
      for (const { url, text, open } of await Promise.all(sent.splice(0))) {
        ok(!open, `${label} couldn't read what ${url} sent`);
        for (const word of words) ok(!text.includes(word), `${label} was sent ${word} by ${url}`);
      }
    };
    const done = async () => {
      await own.close();
      if (org) await context.clearCookies({ name: ORG_COOKIE });
    };
    return { own, hidesAll, done };
  };

  await keyboardPath("a guest's Gantt has no forecast, no Today and no start form", async () => {
    const { own: limited, done } = await limitedPage(s.viewer, s.teamOrgId);
    try {
      await limited.goto(`${app}/w/${s.limitedRoom}/tasks?view=gantt`);
      await shownOnce(limited, "Forecast unavailable");
      await hydrated(limited);
      await shownOnce(limited, "A baseline plan needs the room's whole plan, and this view doesn't show one.");
      ok((await limited.getByRole("region", { name: "Timeline" }).count()) === 0, "a limited viewer got a timeline");
      ok((await limited.getByText(/Today is/).count()) === 0, "a limited viewer got a Today");
      ok((await limited.getByRole("button", { name: /start date/ }).count()) === 0, "a limited viewer was offered the start form");
      ok((await limited.getByText(s.SECRET).count()) === 0, "the Gantt showed a hidden task");
    } finally {
      await done();
    }
  });

  await keyboardPath("a guest's screens show only what they may, with nothing hidden in the page", async () => {
    const { own, hidesAll, done } = await limitedPage(s.viewer, s.teamOrgId);
    const w = `/w/${s.limitedRoom}`;
    try {
      for (const [label, path] of [["Tasks", `${w}/tasks`], ["the Board", `${w}/tasks?view=board`], ["the Gantt", `${w}/tasks?view=gantt`]]) {
        await own.goto(`${app}${path}`);
        await hydrated(own);
        await shownOnce(own, "Gia reviews this");
        await hidesAll(`a guest's ${label}`);
      }
      await own.goto(`${app}${w}/activity`);
      await hydrated(own);
      await own.locator("main ol > li").filter({ visible: true }).first().waitFor({ timeout: 15_000 });
      await hidesAll("a guest's Activity");
      for (const [label, path] of [["Collaboration list", `${w}/collaboration`], ["Collaboration map", `${w}/collaboration?view=map`]]) {
        await own.goto(`${app}${path}`);
        await hydrated(own);
        // Someone the guest has worked with, so what's absent below is absent from a screen that has its data. Another organization's agent shows by its ID.
        await own.getByRole("heading", { name: "Collaboration" }).filter({ visible: true }).waitFor({ timeout: 15_000 });
        await own.getByText(s.narrowed.id).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
        await hidesAll(`a guest's ${label}`);
      }
      await own.goto(`${app}${w}/tasks?task=${s.viewerTask.id}`);
      const sheet = own.getByRole("dialog");
      await sheet.getByRole("button", { name: "Show plan" }).click();
      await sheet.getByText(/shows only tasks you can see/).waitFor({ timeout: 15_000 });
      ok((await sheet.getByRole("button", { name: "Edit plan" }).count()) === 0, "a limited viewer is offered Edit plan");
      await hidesAll("a limited viewer's Plan section");
      await audit(own, "Plan section, limited viewer");
    } finally {
      await done();
    }
  });

  await keyboardPath("a narrowed agent's work shows only what it may, to the admin overseeing it", async () => {
    const { own, hidesAll, done } = await limitedPage(s.partner);
    try {
      await own.goto(`${app}/oversight/${s.limitedRoom}/${s.narrowed.id}`);
      await hydrated(own);
      await shownOnce(own, "Gia reviews this");
      // This admin's own agents include that worker, so only its work is out of bounds.
      await hidesAll("a narrowed agent's oversight", []);
    } finally {
      await done();
    }
    // People's access follows their role, so a narrowed member on these screens can't exist. If that changes, this path needs a person.
    const room = `/v1/workspaces/${s.limitedRoom}`;
    const version = (await s.owner.must("GET", room, undefined, { org: s.teamOrgId })).policy_version;
    const refused = await s.owner.dash("PUT", `${room}/members/${s.viewer.id}/access`, { preset: "member", policy_version: version }, { org: s.teamOrgId });
    ok(refused.status === 400, `narrowing a person answered ${refused.status} ${refused.code}`);
  });

  await keyboardPath("a completed task's Sheet shows the Approved mark on the approved submission, in view", async () => {
    const own = await contextFor(s.owner).newPage();
    try {
      await own.goto(`${app}/w/${s.room}/tasks?task=${s.done.id}`);
      const sheet = own.getByRole("dialog");
      await sheet.waitFor({ timeout: 15_000 });
      await hydrated(own);
      const mark = sheet.getByText("Approved", { exact: true }).filter({ visible: true });
      await mark.waitFor({ timeout: 15_000 });
      ok((await mark.count()) === 1, `the Sheet shows ${await mark.count()} Approved marks for one approved submission`);
      await mark.scrollIntoViewIfNeeded();
      const box = await mark.boundingBox();
      ok(box && box.y >= 0 && box.y + box.height <= own.viewportSize().height, "the Approved mark isn't in view after scrolling to it");
      // It says so in words, because a color and an icon alone wouldn't reach everyone.
      ok((await mark.locator("svg").getAttribute("aria-hidden")) === "true", "the Approved mark's icon isn't hidden from the accessibility tree");
      await audit(own, "Task Sheet, Approved mark in view");
    } finally {
      await own.close();
    }
  });

  await chromiumOnly("long messages are in the accessibility tree, off-screen too", async () => {
    const own = await contextFor(s.owner).newPage();
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.linkThread.id}`);
    const sheet = own.getByRole("dialog");
    await sheet.getByRole("tab", { name: /^Discussion/ }).click();
    await sheet.locator("article a").nth(5).waitFor({ state: "attached", timeout: 15_000 });
    const headings = await sheet.locator("article h4").count();
    const cdp = await own.context().newCDPSession(own);
    const exposed = async () => {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const named = (role, pattern) => nodes.filter((node) => !node.ignored && node.role?.value === role && pattern.test(node.name?.value ?? "")).length;
      return { links: named("link", /^link \d/), headings: named("heading", /^A heading$/) };
    };
    let found = await exposed();
    for (let i = 0; i < 40 && (found.links < 6 || found.headings < headings); i++) {
      await own.waitForTimeout(250);
      found = await exposed();
    }
    console.log(`     accessibility tree: ${found.links} of 6 links, ${found.headings} of ${headings} headings`);
    ok(found.links === 6, `the accessibility tree has ${found.links} of 6 links in long messages`);
    ok(found.headings === headings, `the accessibility tree has ${found.headings} of ${headings} headings in long messages`);
    await own.close();
  });

  await keyboardPath("list numbers past 99 aren't clipped", async () => {
    const own = await contextFor(s.owner).newPage();
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.numberedBrief.id}`);
    const list = own.getByRole("dialog").locator("article ol").first();
    await list.waitFor({ timeout: 15_000 });
    // Skipping layout contains paint, so what matters is the room from the list's text to the edge that clips it, skipped or not.
    const room = await list.evaluate((ol) => {
      const body = ol.closest("article > div");
      body.style.contentVisibility = "auto";
      return ol.querySelector("li").getBoundingClientRect().left - body.getBoundingClientRect().left;
    });
    ok(room >= 44, `list numbers have only ${room}px before they're clipped, and "100." needs about 30`);
    await own.close();
  });

    await keyboardPath("Tab reaches every link in long messages", async () => {
    const own = await contextFor(s.owner).newPage();
    await own.goto(`${app}/w/${s.room}/tasks?task=${s.linkThread.id}`);
    const sheet = own.getByRole("dialog");
    await sheet.getByRole("tab", { name: /^Discussion/ }).focus();
    await own.keyboard.press("Enter");
    await sheet.locator("article a").nth(5).waitFor({ state: "attached", timeout: 15_000 });
    // Find-in-page has to reach text that hasn't been laid out yet.
    ok(await own.evaluate(() => window.find("link 5")), "find-in-page can't reach an off-screen message");
    await sheet.getByRole("tab", { name: /^Discussion/ }).focus();
    const reached = new Set();
    for (let i = 0; i < 40; i++) {
      await own.keyboard.press(TAB);
      const href = await own.evaluate(() => (document.activeElement?.closest("article") ? document.activeElement.getAttribute("href") : null));
      if (href) reached.add(href);
    }
    ok(reached.size === 6, `Tab reached ${reached.size} of 6 links in long messages`);
    await own.close();
  });

  await keyboardPath("nesting inside the limit at phone width", async () => {
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const { label, id } of s.hostile.filter((shape) => shape.note === null)) {
      await small.goto(`${app}/w/${s.hostileRoom}/tasks?task=${id}`);
      await small.getByRole("dialog").getByText(`Hostile: ${label}`).first().waitFor({ timeout: 15_000 });
      await hydrated(small);
      const sizes = await small.getByRole("dialog").evaluate((sheet) => ({ page: document.documentElement.scrollWidth - window.innerWidth, sheet: sheet.scrollWidth - sheet.clientWidth, article: (sheet.querySelector("article")?.scrollWidth ?? 0) - (sheet.querySelector("article")?.clientWidth ?? 0) }));
      console.log(`     ${label} at 375px overflows by ${JSON.stringify(sizes)}`);
      ok(sizes.page <= 0, `${label} scrolls the page sideways by ${sizes.page}px at 375px`);
      ok(sizes.sheet <= 0, `${label} scrolls the Sheet sideways by ${sizes.sheet}px at 375px`);
      if (label === "quotes at the limit") {
        const deepest = small.getByRole("dialog").locator("article blockquote").last();
        await deepest.waitFor({ timeout: 15_000 });
        ok((await deepest.evaluate((el) => getComputedStyle(el).boxShadow)) !== "none", "a quote at level 5 or deeper has no bar");
      }
    }
    await phone.close();
  });

  for (const { label, note, id } of s.hostile) {
    await keyboardPath(`hostile text: ${label}`, async () => {
      const own = await contextFor(s.owner).newPage();
      let crashed = false;
      own.on("crash", () => (crashed = true));
      try {
        const started = Date.now();
        await own.goto(`${app}/w/${s.hostileRoom}/tasks?task=${id}`);
        await own.getByRole("dialog").getByText(`Hostile: ${label}`).first().waitFor({ timeout: 15_000 });
        if (note) await own.getByRole("dialog").getByText(note).first().waitFor({ timeout: 15_000 });
        else ok((await own.getByRole("dialog").getByText("can't be formatted").count()) === 0, "text within the limits wasn't formatted");
        await hydrated(own);
        const alive = await own.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(true))));
        ok(alive && !crashed, "the tab crashed");
        ok(Date.now() - started < 15_000, `the Sheet took ${Date.now() - started}ms`);
        if (label === "wide tables repeated") {
          // Real Tab presses, because Chromium makes anything that overflows focusable by itself.
          const article = own.getByRole("dialog").locator("article").first();
          await own.waitForTimeout(300);
          let stops = 0;
          for (let i = 0; i < 400; i++) {
            await own.keyboard.press(TAB);
            const inside = await article.evaluate((el) => el.contains(document.activeElement));
            if (inside) stops += 1;
            else if (stops > 0) break;
          }
          ok(stops === 10, `the fallback left ${stops} tab stops in one body`);
        }
      } finally {
        await own.close().catch(() => {});
      }
    });
  }

  await keyboardPath("transfer ownership", async () => {
    await page.goto(`${app}/w/${s.transferRoom}/settings`);
    await hydrated(page);
    const select = page.getByLabel("New owner");
    await tabTo(page, select, "New owner");
    // Keys inside a native select differ by platform, so the browser's own control isn't what's tested here.
    await select.selectOption({ index: 1 });
    const button = page.getByRole("button", { name: "Transfer ownership" });
    await tabTo(page, button, "Transfer ownership");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 15_000 });
    await audit(page, "Transfer confirmation");
    ok(await dialog.evaluate((el) => el.contains(document.activeElement)), `the confirmation left focus on ${await activeText(page)}`);
    await tabTo(page, dialog.getByRole("button", { name: "Transfer ownership" }), "the confirmation's Transfer ownership");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    await page.getByText("Transferred.").waitFor({ timeout: 15_000 });
    const status = await page.evaluate(() => (document.activeElement?.closest('[role="status"], [role="alert"]') ? document.activeElement.textContent : null));
    ok(status !== null, `after transferring, focus is on ${await activeText(page)}, not on a status that says what happened`);
    ok((await s.heir.must("GET", `/v1/workspaces/${s.transferRoom}`)).owner === s.heir.id, "the stored owner after transferring");
  });
  await keyboardPath("recover a workroom", async () => {
    await page.goto(`${app}/settings/organization`);
    await hydrated(page);
    const row = page.getByRole("listitem").filter({ hasText: "Room to recover" });
    const select = row.getByLabel("New owner");
    await tabTo(page, select, "New owner");
    // The first person offered is this admin, who has never been in the workroom.
    await select.selectOption({ index: 1 });
    const button = row.getByRole("button", { name: "Name new owner" });
    await tabTo(page, button, "Name new owner");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 15_000 });
    await audit(page, "Recovery confirmation");
    // This admin is naming themselves, so it's the takeover wording.
    await tabTo(page, dialog.getByRole("button", { name: "Take over" }), "the confirmation's Take over");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    await page.getByText("You're now the owner").waitFor({ timeout: 15_000 });
    const status = await page.evaluate(() => (document.activeElement?.closest('[role="status"], [role="alert"]') ? document.activeElement.textContent : null));
    ok(status !== null, `after recovering, focus is on ${await activeText(page)}, not on a status that says what happened`);
    const read = await s.owner.must("GET", `/v1/workspaces/${s.ownerlessRoom}`);
    ok(read.owner === s.owner.id, "the stored owner after recovering");
    ok(read.status === "archived", `the workroom is ${read.status} after recovering, and should still be archived`);
  });
  await page.close();
}

async function run() {
  const seeded = await seed();
  checkTokens();
  await controls();
  for (const [name, path, expected, who = "owner", sheet = false, org] of screens(seeded)) {
    const person = who === null ? null : who === "partner" ? seeded.partner : seeded.owner;
    const context = contextFor(person);
    // A person's current organization is this cookie, as the profile menu sets it.
    if (org) await context.addCookies([{ name: ORG_COOKIE, value: org, domain: new URL(app).hostname, path: "/" }]);
    const page = await context.newPage();
    try {
      const response = await page.goto(`${app}${path}`);
      await hydrated(page);
      if ((name === "Not found") === response.ok()) throw new Error(`HTTP ${response.status()}`);
      await page.getByText(expected).first().waitFor({ timeout: 15_000 });
      // A failed read would pass axe while hiding the screen.
      if (await page.getByText("Couldn't refresh").count()) throw new Error("the screen's read failed");
      if (sheet) await page.getByRole("dialog").waitFor({ timeout: 15_000 });
      // This one's text has a table, which is formatted in the worker, and it's what shows tables to axe.
      if (name === "Task Sheet, review") await page.locator("article table").first().waitFor({ timeout: 15_000 });
      await audit(page, name);
    } catch (error) {
      fail(name, error.message.split("\n")[0]);
    }
    await page.close();
    if (org) await context.clearCookies({ name: ORG_COOKIE });
  }
  await keyboardPaths(seeded);
}

await run().catch((error) => fail("run", error.message));
await browser.close();

// Compare to the known list, by screen, rule and element.
const found = results.flatMap((r) => (r.violations ?? []).map((v) => `${r.screen}|${v.rule}|${v.target}`));
const uniqueFound = new Set(found);
const knownKeys = new Set(known.axe.map((k) => `${k.screen}|${k.rule}|${k.target}`));
for (const key of uniqueFound) if (!knownKeys.has(key)) failures.push(`new axe violation: ${key}`);
for (const key of knownKeys) if (!uniqueFound.has(key)) failures.push(`a11y-known.json lists something that's gone, so remove it: ${key}`);
// A known keyboard failure is exempt only with its exact message, so any other break on that path still fails the run.
const knownKeyboard = new Set(known.keyboard.map((k) => `keyboard: ${k.path}: ${k.failure}`));
const unexpected = failures.filter((f) => !knownKeyboard.has(f));
for (const entry of knownKeyboard) if (!failures.includes(entry)) unexpected.push(`a11y-known.json lists a keyboard failure that's gone, so remove it: ${entry}`);

mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `a11y-${browserName === "chromium" ? "" : `${browserName}-`}${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`);
writeFileSync(file, `${JSON.stringify({ commit: process.env.GITHUB_SHA ?? null, results, failures }, null, 2)}\n`);
console.log(`\n${results.filter((r) => r.screen).length} axe runs, ${uniqueFound.size} distinct violations, ${unexpected.length} unexpected. Results: ${file}`);
for (const failure of unexpected) console.log(`  ${failure}`);
process.exit(unexpected.length ? 1 : 0);
