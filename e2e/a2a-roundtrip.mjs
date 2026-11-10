// M3's gate on staging: the outbound A2A round trip against the test A2A server (option A in #184), and Spike C's staging
// half (decision 126). Staging only, since the server downloads input files from staging's gateway.
//
// - An offer goes out to the server, signed, with the endpoint's bearer. The server makes one GET of the offer's /a2a/files
//   link with the agent's /a2a token. Podster reads back WORKING, which accepts, then COMPLETED, which submits a note
//   recording the download's status and SHA-256 and a URL artifact.
// - A change request goes out as a new A2A task naming the completed one, in its context, and is read back as a resubmission.
// - A task canceled in Podster while the remote works sends CancelTask. The server keeps nothing, so that's seen only as the
//   remote side's reading ending, not the request itself.
// - Spike C: real egress to workers.dev, and timing from Podster's own records: queue to send, and send to each read. Two
//   more endpoints show the timeouts and refusals on the deployment: one that answers after 15 s, past the 10 s send
//   timeout, and one that redirects to the cloud metadata address. Each must fail, be counted, and switch off after 3.
//
//   node a2a-roundtrip.mjs [--server https://podster-a2a-test-staging.podster-dev.workers.dev] [--only round-trip | --only ac18 | --only screens]
//
// Needs PODSTER_E2E_SIGNUP_SECRET for staging's test sign-up, and the server's RUN_KEY in ~/.config/podster/a2a-test-run.key
// (or PODSTER_A2A_TEST_KEY_FILE). A run's values reach the server sealed under that key, as the endpoint's bearer token, so
// no Worker secret is set per run. It prints IDs, counts, times and HTTP statuses, and checks at the end that no token,
// secret or sealed bearer is in its own output.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyCheck, runKey, seal, sign } from "./a2a-test-server/seal.mjs";
import { ADVERSARIAL } from "./a2a-test-server/worker.mjs";
import { childEnv } from "./child-env.mjs";
import { key, linkedA2aToken, McpAgent, Person, sleep, Target } from "./lib.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const BASE = "https://gateway-staging.podster.dev";
const APP = "https://app-staging.podster.dev";
// `--only round-trip` runs just the offer, download and change request, without the cancel and Spike C's failing endpoints.
const only = option("--only");
const server = (option("--server") ?? "https://podster-a2a-test-staging.podster-dev.workers.dev").replace(/\/$/, "");
// The sealed bearer goes to this server, so only the one on Podster's own workers.dev subdomain is accepted.
if (!/^https:\/\/[a-z0-9-]+\.podster-dev\.workers\.dev$/.test(server)) {
  console.error("--server must be a test server on Podster's workers.dev subdomain, podster-dev.workers.dev.");
  process.exit(2);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
if (!signupSecret) {
  console.error("Set PODSTER_E2E_SIGNUP_SECRET for staging's test sign-up.");
  process.exit(2);
}
const keyFile = process.env.PODSTER_A2A_TEST_KEY_FILE ?? join(homedir(), ".config/podster/a2a-test-run.key");
if ((statSync(keyFile).mode & 0o077) !== 0) {
  console.error(`${keyFile} must be readable by its owner only: chmod 600 it.`);
  process.exit(2);
}
const keyHex = readFileSync(keyFile, "utf8").trim();
const runKeyValue = await runKey(keyHex);

const written = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return write(chunk, ...rest);
  };
}
const secrets = new Set([signupSecret, keyHex]);

const target = new Target(BASE, { pollMs: 1000 });
const results = [];
const record = (status, title, detail = "") => {
  results.push({ status, title });
  console.log(`${{ ok: "ok  ", fail: "FAIL", skip: "skip", note: "    " }[status]} ${title}${detail ? `: ${detail}` : ""}`);
};
const check = (passed, title, detail) => record(passed ? "ok" : "fail", title, detail);
const note = (title, detail) => record("note", title, detail);
const section = (name) => console.log(`\n## ${name}`);
async function step(title, run) {
  try {
    await run();
  } catch (error) {
    record("fail", title, [error?.name, error?.message].filter(Boolean).join(" ").slice(0, 200));
  }
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

let owner;
let room;
let lead;
const agents = [];

/** An agent with its endpoint at `path` on the server, its bearer sealing the signing secret and its /a2a token. */
async function remoteAgent(label, path) {
  const agent = await McpAgent.connect(target, owner, label);
  agents.push(agent);
  secrets.add(agent.accessToken());
  await owner.addAgent(room, agent, "guest");
  const a2a = await linkedA2aToken(target, owner, agent);
  secrets.add(a2a);
  const url = `${server}${path}`;
  const first = await agent.call("set_a2a_endpoint", { url });
  if (!first.ok) throw new Error(`set_a2a_endpoint: ${first.code}`);
  const signing = first.data.signing_secret;
  secrets.add(signing);
  const bearer = await seal(runKeyValue, { s: signing, a: a2a, x: Math.floor(Date.now() / 1000) + 3600 });
  secrets.add(bearer);
  const second = await agent.call("set_a2a_endpoint", { url, token: bearer });
  check(second.ok && second.data?.token_state === "stored" && second.data?.version === first.data.version && !("signing_secret" in second.data), `${label}: its endpoint holds the sealed bearer, with the same version and secret`, second.ok ? `version ${second.data?.version}, token ${second.data?.token_state}` : second.code);
  return { agent, url, signing, bearer, a2a, first: first.data, second: second.ok ? second.data : { code: second.code } };
}

const getTask = async (task) => lead.must("get_task", { workspace_id: room, task_id: task }, false);
/** Polls the lead's read until `done` holds, or the time runs out. */
async function until(task, done, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const read = await getTask(task);
    if (done(read) || Date.now() > deadline) return read;
    await sleep(5_000);
  }
}
const event = (read, type) => read.history.find((h) => h.type === type);
const events = (read, type) => read.history.filter((h) => h.type === type);

/** The offer, with an input file, read back, and a change request read back. */
async function roundTrip(remote) {
  const data = Buffer.from(`M3 gate round trip ${randomUUID()}\n`);
  const digest = sha256(data);
  let task;
  let first;

  await step("the input file", async () => {
    const created = await owner.dash("POST", `/v1/workspaces/${room}/uploads`, { name: "round-trip-input.txt", size: data.length, sha256: digest });
    if (!created.ok) throw new Error(`upload: HTTP ${created.status} ${created.code ?? ""}`);
    secrets.add(created.body.token);
    const sent = await target.http(created.body.upload_path, { method: "PUT", headers: { authorization: `Bearer ${created.body.token}` }, body: data });
    await sent.body?.cancel();
    const deadline = Date.now() + 180_000;
    let state;
    for (;;) {
      state = (await owner.dash("GET", `/v1/workspaces/${room}/files/${created.body.id}`)).body?.state;
      if (state !== "scanning" || Date.now() > deadline) break;
      await sleep(3_000);
    }
    check(state === "ready", "the owner uploads an input file and the scanner marks it ready", state);
    task = (await lead.must("create_task", { workspace_id: room, title: "M3 gate: round trip", instructions: "Read the input file and complete." })).id;
    const linked = await owner.dash("POST", `/v1/workspaces/${room}/files/${created.body.id}/links`, { task_id: task });
    check(linked.ok, "it's linked to a task before the task is offered", `HTTP ${linked.status}`);
  });
  if (!task) return;

  await step("the offer", async () => {
    const version = (await getTask(task)).task.version;
    await lead.must("assign_task", { workspace_id: room, task_id: task, version, assignee: remote.agent.id });
    const accepted = await until(task, (r) => r.task.status !== "offered", 4);
    const offered = event(accepted, "task.offered");
    const acceptedAt = event(accepted, "task.accepted");
    check(accepted.task.status === "accepted" && acceptedAt?.origin === "a2a_remote" && acceptedAt?.actor_id === remote.agent.id, "WORKING read back accepts the offer, as the agent, marked from its A2A endpoint", `${accepted.task.status}, origin ${acceptedAt?.origin}`);
    const submitted = await until(task, (r) => r.task.status === "submitted", 5);
    const sub = submitted.submissions[0];
    const submittedAt = event(submitted, "task.submitted");
    check(submitted.task.status === "submitted" && submittedAt?.origin === "a2a_remote" && sub?.submitted_by === remote.agent.id, "COMPLETED read back submits, as the agent, marked from its A2A endpoint", `${submitted.task.status}, origin ${submittedAt?.origin}`);
    check(submitted.artifacts?.some((a) => a.uri?.startsWith("https://example.com/podster-a2a-test/")), "the submission has the remote's URL artifact");
    const download = /Input file: (\S+)\./.exec(sub?.note ?? "")?.[1];
    check(download === `200-${digest.slice(0, 12)}`, "the server downloaded the input file over /a2a/files with the agent's /a2a token: HTTP 200 and the same bytes", download);
    first = /Remote task: ([0-9a-f]{12})\./.exec(sub?.note ?? "")?.[1];
    const remoteAt = Date.parse(/Sent to it at (\S+)\. Read/.exec(sub?.note ?? "")?.[1] ?? "");
    note("Spike C timing, offer", [
      `offered to the send reaching the server ${seconds(remoteAt - offered.created_at)}`,
      `offered to accepted ${seconds(acceptedAt.created_at - offered.created_at)}`,
      `accepted to submitted ${seconds(submittedAt.created_at - acceptedAt.created_at)}`,
    ].join(", "));
  });
  if (!first) return;

  await step("the change request", async () => {
    await lead.must("request_changes", { workspace_id: room, task_id: task, submission_no: 1, reason: "Please add a second line." });
    const back = await until(task, (r) => r.submissions.length >= 2, 6);
    const sub = back.submissions[1];
    const requested = event(back, "task.changes_requested");
    const resubmitted = events(back, "task.submitted")[1];
    const endpoint = (await remote.agent.call("get_a2a_endpoint", {})).data;
    const since = `endpoint enabled ${endpoint?.enabled}, ${endpoint?.consecutive_failures} failures, token ${endpoint?.token_state}; ` + back.history.slice(back.history.indexOf(requested)).map((h) => `${h.type}${h.origin ? `(${h.origin})` : ""}`).join(" ");
    check(back.task.status === "submitted" && resubmitted?.origin === "a2a_remote" && sub?.submitted_by === remote.agent.id, "the change request goes out and COMPLETED reads back as a second submission, from the A2A endpoint", `${back.task.status}, ${back.submissions.length} submissions; since the request: ${since}`);
    check(/Kind: change\./.test(sub?.note ?? "") && sub.note.includes(`Changes for remote task: ${first}.`), "it went out as a new A2A task naming the completed one in referenceTaskIds");
    // The first task's context is ctx.<its own random part>, and the server notes the context the change request carried.
    check(sub?.note?.includes(`Context received: ${first}.`), "in the first task's context", /Context received: (\S+)\./.exec(sub?.note ?? "")?.[1]);
    if (requested && resubmitted) note("Spike C timing, change request", `requested to resubmitted ${seconds(resubmitted.created_at - requested.created_at)}`);
    const verified = await lead.call("verify_task", { idempotency_key: key(), workspace_id: room, task_id: task, submission_no: 2 });
    check(verified.ok, "the lead verifies it", verified.ok ? "" : verified.code);
  });
}

/** A task canceled in Podster while the remote works: CancelTask goes out, and Podster's task stays canceled. */
async function cancel(remote) {
  await step("cancel", async () => {
    const task = (await lead.must("create_task", { workspace_id: room, title: "M3 gate: to cancel", instructions: "Will be canceled.", assignee: remote.agent.id })).id;
    const accepted = await until(task, (r) => r.task.status !== "offered", 4);
    check(accepted.task.status === "accepted", "the remote accepts by WORKING", accepted.task.status);
    await lead.must("cancel_task", { workspace_id: room, task_id: task, version: accepted.task.version, reason: "Not needed." });
    await sleep(150_000);
    const after = await getTask(task);
    check(after.task.status === "canceled" && after.submissions.length === 0, "after the cancel and the next read's time, the task is still canceled with no submission", `${after.task.status}, ${after.submissions.length} submissions`);
    note("CancelTask", "the server keeps nothing, so the request itself isn't seen from here. Its delivery is covered by a2a-readback.spec.ts");
  });
}

/** Spike C's failure half on the deployment: the send times out, or a redirect isn't followed, 3 times, then the endpoint is off. */
/**
 * What the server itself does at a Spike C path, asked directly with this run's own signing secret and bearer, so a failure
 * Podster then records is that behavior and not a bad bearer, an expired one or DNS.
 */
async function probe(remote) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "probe:1", method: "GetTask", params: { id: "rt.o.0.n.000000000000" } });
  const started = Date.now();
  const res = await fetch(remote.url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", authorization: `Bearer ${remote.bearer}`, "x-podster-signature": await sign(remote.signing, Math.floor(Date.now() / 1000), body) },
    body,
  });
  await res.arrayBuffer();
  return { status: res.status, location: res.headers.get("location"), ms: Date.now() - started };
}

async function failing(remote, what, expected) {
  await step(what, async () => {
    const seen = await probe(remote);
    const behaves = expected === "slow" ? seen.status === 200 && seen.ms > 10_000 : seen.status === 302 && seen.location === "http://169.254.169.254/latest/meta-data/";
    check(behaves, `${what}: asked directly with this run's signed request and bearer, the server does it`, `HTTP ${seen.status} after ${seconds(seen.ms)}${seen.location ? `, to ${seen.location}` : ""}`);
    if (!behaves) return;
    const started = Date.now();
    const task = (await lead.must("create_task", { workspace_id: room, title: `M3 gate: ${what}`, instructions: "Spike C.", assignee: remote.agent.id })).id;
    const deadline = Date.now() + 12 * 60_000;
    let read;
    let most = 0;
    for (;;) {
      read = (await remote.agent.call("get_a2a_endpoint", {})).data;
      most = Math.max(most, read?.consecutive_failures ?? 0);
      if (!read || read.enabled === false || Date.now() > deadline) break;
      await sleep(10_000);
    }
    check(read?.enabled === false && read?.consecutive_failures === 3, `${what}: each send fails and after 3 the endpoint is off`, `enabled ${read?.enabled}, ${most} in a row, after ${seconds(Date.now() - started)}`);
    const now = await getTask(task);
    check(now.task.status === "offered", `${what}: the task is untouched`, now.task.status);
  });
}

/** The agent's role in the room, as the owner reads it. */
async function roleOf(agentId) {
  const read = await owner.dash("GET", `/v1/workspaces/${room}`);
  const member = (read.body?.members ?? []).find((m) => (m.principal_id ?? m.id) === agentId);
  return member?.role ?? null;
}

/**
 * AC-18 on a deployment: an agent sends Podster instructions to raise its access, inbound over A2A and back from its own A2A
 * endpoint, and nothing moves but what the agent may do anyway. Its role, the task's status and its review stay as they were,
 * and the text is kept as data: a thread message and a submission note.
 */
async function ac18(remote) {
  await step("AC-18", async () => {
    const before = await roleOf(remote.agent.id);
    check(before === "guest", "the agent joins as a guest", before);
    const task = (await lead.must("create_task", { workspace_id: room, title: "M3 gate: AC-18", instructions: "Do the work.", assignee: remote.agent.id })).id;
    // Inbound: the agent's own A2A message, with the instructions in its text and in fields it sets.
    const res = await target.http("/a2a", {
      method: "POST",
      headers: { authorization: `Bearer ${remote.a2a}`, "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: randomUUID(), role: "ROLE_USER", taskId: `${room}:${task}`, parts: [{ text: ADVERSARIAL }], metadata: { "podster.dev/status": "completed", role: "admin" } }, metadata: { "podster.dev/status": "completed" } } }),
    });
    const sent = await res.json();
    check(res.status === 200 && !sent.error, "inbound: the agent's message is taken, as a message", sent.error?.message ?? `HTTP ${res.status}`);
    const afterInbound = await getTask(task);
    const posted = (await lead.must("list_messages", { workspace_id: room, task_id: task }, false)).messages;
    check(afterInbound.task.status === "offered", "inbound: the task doesn't move", afterInbound.task.status);
    check(posted.some((m) => m.body === ADVERSARIAL && (m.from?.id ?? m.sender_id) === remote.agent.id), "inbound: the text is kept verbatim as the agent's message");
    check((await roleOf(remote.agent.id)) === "guest", "inbound: the agent is still a guest");
    // Outbound: the agent's endpoint answers WORKING, then asks for input with the instructions, then completes with them.
    const submitted = await until(task, (r) => r.task.status === "submitted", 10);
    const types = submitted.history.map((h) => h.type);
    check(submitted.task.status === "submitted", "read back: WORKING accepts and COMPLETED submits, and nothing more", submitted.task.status);
    check(!types.some((t) => /verified|completed|role|admin/.test(t)), "read back: no verify, completion or role change in the task's history", types.join(" "));
    const thread = (await lead.must("list_messages", { workspace_id: room, task_id: task }, false)).messages;
    check(thread.some((m) => m.body === ADVERSARIAL && m.origin === "a2a_remote"), "read back: INPUT_REQUIRED's text is a thread message, marked a2a_remote");
    check(submitted.submissions[0]?.note === ADVERSARIAL, "read back: COMPLETED's text is the submission's note, as data");
    check((await roleOf(remote.agent.id)) === "guest", "the agent is still a guest at the end");
    const verify = await remote.agent.call("verify_task", { idempotency_key: key(), workspace_id: room, task_id: task, submission_no: 1 });
    check(!verify.ok && /not_allowed/.test(verify.code ?? ""), "and it still can't verify its own submission: not_allowed", verify.ok ? "verified" : verify.code);
  });
}

/**
 * Step 15's screens on the deployed app, in a real browser, as the test person: the Agent Sheet's A2A endpoint section, and
 * the Task Sheet's labels on what the agent's endpoint reported. The task first goes round the test server, so there's
 * something to label.
 */
async function screens(remote) {
  await step("screens", async () => {
    const task = (await lead.must("create_task", { workspace_id: room, title: "M3 gate: screens", instructions: "Do the work.", assignee: remote.agent.id })).id;
    const submitted = await until(task, (r) => r.task.status === "submitted", 5);
    check(submitted.task.status === "submitted", "the task goes round the test server to submitted", submitted.task.status);
    const playwright = await import("playwright");
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    // Third-party code: the browser gets the allow-listed environment, never the sign-up secret.
    const browser = await playwright.chromium.launch({ env: childEnv() });
    try {
      const context = await browser.newContext();
      // The test person's session, from the gateway's test sign-up, offered to the app's host, and the person's organization.
      const appHost = new URL(APP).hostname;
      const cookies = owner.cookieForSignOut.split("; ").map((pair) => {
        const at = pair.indexOf("=");
        return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: appHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" };
      });
      await context.addCookies([...cookies, { name: "podster-org", value: owner.org, domain: appHost, path: "/", secure: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      // The same rules and known-issues list as the accessibility run, so a listed issue isn't reported twice.
      const known = new Set(JSON.parse(readFileSync(new URL("./a11y-known.json", import.meta.url), "utf8")).axe.map((k) => `${k.screen}|${k.rule}|${k.target}`));
      const axe = async (name) => {
        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        const fresh = violations.flatMap((v) => v.nodes.map((n) => `${name}|${v.id}|${n.target.join(" ")}`)).filter((k) => !known.has(k));
        check(fresh.length === 0, `${name}: no axe violations beyond a11y-known.json`, fresh.join(", "));
      };

      // The signed-in shell keeps polling, so the network never goes idle: wait for the page's own content instead, and say
      // where the browser ended up if it doesn't come.
      const open = async (url, ready) => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        try {
          await ready().waitFor({ timeout: 30_000 });
        } catch (error) {
          throw new Error(`${new URL(url).pathname}: not shown, the browser is at ${new URL(page.url()).pathname}`);
        }
      };
      const section = page.locator("section[aria-labelledby='agent-a2a']");
      await open(`${APP}/agents?agent=${remote.agent.id}`, () => section);
      const text = await section.innerText();
      check(/A2A endpoint/.test(text) && text.includes(new URL(server).hostname), "the Agent Sheet shows the endpoint section, with its host", new URL(server).hostname);
      check(/Token/.test(text) && /stored/i.test(text), "and that a token is stored, without showing it");
      for (const label of ["Change", "New signing secret", "Remove"]) {
        check(await section.getByRole("button", { name: label }).isVisible(), `and the org admin's "${label}" button`);
      }
      const html = await page.content();
      check([...secrets].every((value) => !html.includes(value)), "no token, secret or sealed bearer anywhere in the page");
      await axe("the Agent Sheet");

      // The labels are on the Task Sheet's Activity tab. It opens on Details, and a tab's content isn't rendered until chosen.
      await open(`${APP}/w/${room}/tasks?task=${task}`, () => page.getByRole("tablist", { name: "Task details" }));
      await page.getByRole("tab", { name: "Activity" }).click();
      await page.getByText("through its A2A endpoint").first().waitFor({ timeout: 30_000 });
      const labels = await page.getByRole("tabpanel").getByText("through its A2A endpoint").count();
      check(labels >= 2, "the Task Sheet marks the accept and the submission as reported through the agent's A2A endpoint", `${labels} labels`);
      await axe("the Task Sheet");
    } finally {
      await browser.close();
    }
  });
}

async function run() {
  section("The test server");
  const ready = await (await fetch(`${server}/ready`)).json();
  check(ready.ready === true && ready.key_check === (await keyCheck(keyHex)), "it's ready, with the same RUN_KEY as this run", `ready ${ready.ready}`);
  if (!ready.ready) return;
  const unsigned = await fetch(`${server}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }) });
  check(unsigned.status === 401, "it refuses a request with no bearer and no signature", `HTTP ${unsigned.status}`);

  section("Setup");
  const cookie = await Person.testSessionCookie(target, "Person A", signupSecret);
  owner = await Person.fromCookie(target, "Person A", cookie);
  owner.cookieForSignOut = cookie;
  secrets.add(cookie);
  room = await owner.createRoom(`M3 gate round trip ${new Date().toISOString().slice(0, 19)}`);
  console.log(`Room ${room}.`);
  lead = await McpAgent.connect(target, owner, "M3 gate lead");
  secrets.add(lead.accessToken());
  agents.push(lead);
  await owner.addAgent(room, lead, "member");
  if (only === "screens") {
    section("Screens (step 15) on the staging app");
    return screens(await remoteAgent("M3 gate screens", "/a2a"));
  }
  if (only === "ac18") {
    section("AC-18: A2A instructions to raise access stay data");
    return ac18(await remoteAgent("M3 gate AC-18", "/a2a/adversarial"));
  }
  const main = await remoteAgent("M3 gate remote", "/a2a");
  check(/^a2asec_[0-9a-f]{64}$/.test(main.signing), "the endpoint's signing secret is shown once, when it's set");
  if (only === "round-trip") {
    section("Round trip");
    return roundTrip(main);
  }
  const slow = await remoteAgent("M3 gate slow", "/a2a/slow");
  const redirect = await remoteAgent("M3 gate redirect", "/a2a/redirect");
  section("Round trip, Spike C timeouts and redirects, side by side");
  await Promise.all([
    (async () => {
      await roundTrip(main);
      await cancel(main);
    })(),
    failing(slow, "an answer after 15 s, past the 10 s timeout", "slow"),
    failing(redirect, "a redirect to the metadata address", "redirect"),
  ]);
}

async function cleanUp() {
  section("Clean-up");
  let done = 0;
  for (const agent of agents) {
    await agent.call("delete_a2a_endpoint", {}).catch(() => null);
    const gone = await owner?.dash("POST", `/agents/${agent.id}/disconnect`).catch(() => null);
    if (gone?.status === 200) done++;
  }
  check(done === agents.length, "each test agent's endpoint is deleted and the agent disconnected", `${done} of ${agents.length}`);
  if (room) console.log(`     left on staging: room ${room} and its tasks, since there's no delete route, and the signed-out test person`);
  if (owner?.cookieForSignOut) {
    await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie: owner.cookieForSignOut, origin: BASE, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  }
}

try {
  await run();
} catch (error) {
  record("fail", "the run", [error?.name, error?.message].filter(Boolean).join(" ").slice(0, 200));
} finally {
  await cleanUp().catch((error) => record("fail", "clean-up", error?.message));
}
const output = written.join("");
const leaked = [...secrets].filter((s) => s && output.includes(s)).length;
check(leaked === 0, "no session cookie, OAuth token, signing secret, key or sealed bearer anywhere in this script's output", `${secrets.size} values checked`);
const failed = results.filter((r) => r.status === "fail").length;
const passed = results.filter((r) => r.status === "ok").length;
console.log(`\n${passed} passed, ${failed} failed. Room ${room}.`);
process.exit(failed ? 1 : 0);
