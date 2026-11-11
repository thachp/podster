// merge_task end to end (M5 step 7b), on a local stack with managed repositories on and GitHub stood in for by the test
// suite's fake (fake-github-server.mjs). run-local.mjs builds the API for this with its `rehearsal` feature, which sends
// GitHub's calls to that fake on this machine and nowhere else.
//
//   node merge-check.mjs --base-url http://localhost:8787 --github http://127.0.0.1:9999
//
// The repository is provisioned for real, through the fake. No operator approves the organization first: it holds the
// delegation by default (the owner's decision of 2026-11-11). The
// room's owner asks for the repository, and the room's job creates and protects it. Then the four things AC-17 exists
// for, and four things GitHub's rules refused in the spike, as the fake holds to them, each with its exact answer: approval merges nothing; a merge-grant holder who is the submitter, or controlled by
// the same person, is refused `self_merge`; a participant with no merge grant is refused `grant_required`; and an
// authorized holder's merge_task leads to exactly one merge call, for the reviewed commit, which the task records.
import { eq, key, McpAgent, ok, Person, refused, Report, Target } from "./lib.mjs";

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const [base, github] = [arg("--base-url"), arg("--github")];
if (!base || !/^http:\/\/localhost:\d+$/.test(base) || !github || !/^http:\/\/127\.0\.0\.1:\d+$/.test(github)) {
  console.error("Give --base-url http://localhost:<port> and --github http://127.0.0.1:<port>. This check is for a local stack only.");
  process.exit(2);
}
const target = new Target(base, { pollMs: 500 });
const report = new Report();
const check = report.check.bind(report);
const HEAD = "a1".repeat(20);
const BASE = "b2".repeat(20);
const fake = async (path, body) => (await fetch(`${github}/__fake/${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined)).json();
/** Waits for `read` to answer something `done` accepts, as a job that runs on the room's alarm needs. */
const until = async (read, done, label, timeoutMs = 60_000) => {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const value = await read();
    if (done(value)) return value;
    ok(Date.now() < deadline, `${label}: still ${JSON.stringify(value)} after ${timeoutMs / 1000} seconds`);
    await new Promise((wait) => setTimeout(wait, 500));
  }
};

const owner = await Person.signUp(target, "Merge owner");
const other = await Person.signUp(target, "Another person");
const room = await owner.createRoom(`e2e merge ${new Date().toISOString().slice(0, 19)}`);
// The owner's two agents, and one another person controls, who joins as a member of the room.
const coder = await McpAgent.connect(target, owner, "Coder");
const sibling = await McpAgent.connect(target, owner, "Sibling");
const robot = await McpAgent.connect(target, other, "Robot");
// The other person's second agent: it merges, and is no party to the tasks it merges, so it's shown the merge alone.
const merger = await McpAgent.connect(target, other, "Merger");
for (const agent of [coder, sibling]) await owner.addAgent(room, agent);
const invitation = await owner.invite(room, other.org, { role: "member" });
eq([...((await other.accept(invitation.token, other.org, [robot, merger])).body?.agents ?? [])].sort(), [robot.id, merger.id].sort(), "the other person's agents joined");

let repo;
let task;
const where = () => ({ workspace_id: room, task_id: task });
const change = async () => (await owner.must("GET", `/v1/workspaces/${room}/tasks/${task}`)).change;
const grantNow = async (principal) => owner.must("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action: "merge" });
const ask = (agent) => agent.call("merge_task", { ...where(), submission_no: 1, commit_sha: HEAD, idempotency_key: key() });
const merges = async () => (await fake(`merge-calls?repo=${repo}`)).calls.filter((call) => call.method === "PUT");

await check("M5-S7-setup", "with no operator's approval, the owner asks, and the room's job creates and protects the repository through the fake", async () => {
  await owner.must("POST", `/v1/workspaces/${room}/repository`, { name: `e2e-merge-${key().slice(0, 8).toLowerCase()}`, visibility: "public" });
  const ready = await until(async () => (await owner.must("GET", `/v1/workspaces/${room}/repository`)), (read) => read.repository?.status === "ready" || read.request?.state === "failed", "the repository");
  eq(ready.repository?.status, "ready", `the repository's state (request: ${JSON.stringify(ready.request)})`);
  repo = ready.repository.provider_repo_id;
  // The agent-token App and the merge App know the repository, and it has one open pull request, as an agent would have made.
  await fake("agent-repo", { id: repo, pulls: { 7: { head_sha: HEAD, base_sha: BASE } } });
});

// Who reviews and who merges. The coder, the owner's agent, submits. The robot, an agent the other person controls, is
// named reviewer and approves: a review independent of the submitter's person, as the owner's decision of 2026-11-11 on
// review A1 asks before a commit is merged. The merger, the other person's second agent and no party to the task, merges.
await check("M5-S7i", "an approved, linked task that nobody asks to merge is not merged, however long the room's alarm runs", async () => {
  const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: "Change the code", instructions: "x", assignee: coder.id, reviewer: robot.id }, { idempotencyKey: key() });
  task = made.id;
  const accepted = await coder.must("accept_task", { ...where(), version: made.version });
  await coder.must("submit_task", { ...where(), version: accepted.version, note: "Done", commit_sha: HEAD, pr_number: 7 });
  await robot.must("verify_task", { ...where(), submission_no: 1, commit_sha: HEAD });
  eq((await change()).reviewed_commit_sha, HEAD, "the reviewed commit");
  // The room's alarm has work of its own here: the change is read again a minute after approval at the latest. Four
  // seconds is long enough for anything that would merge on approval to have done so.
  await new Promise((wait) => setTimeout(wait, 4_000));
  eq((await change()).merge_state, "not_requested", "the merge's state");
  eq(await merges(), [], "merge calls");
  eq((await fake(`merge-calls?repo=${repo}`)).statuses, [], "statuses set");
  eq((await fake(`merge-calls?repo=${repo}`)).pulls["7"].merged ?? false, false, "the pull request merged");
});

await check("M5-S7ii", "a merge-grant holder who is the submitter, its owner, or another agent of that owner is refused self_merge", async () => {
  for (const holder of [coder, sibling, owner]) await grantNow(holder);
  refused(await ask(coder), "self_merge", "the submitter");
  refused(await ask(sibling), "self_merge", "another agent of the same person");
  const person = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${task}/merge`, { submission_no: 1, commit_sha: HEAD });
  refused(person, "self_merge", "the person who controls the submitter");
  eq((await change()).merge_state, "not_requested", "the merge's state");
  eq(await merges(), [], "merge calls");
});

await check("M5-S7iii", "a participant with no merge grant is refused grant_required", async () => {
  refused(await ask(merger), "grant_required", "an agent another person controls, with no grant");
  eq((await change()).merge_state, "not_requested", "the merge's state");
  eq(await merges(), [], "merge calls");
});

await check("M5-S7iv", "an authorized holder's merge_task leads to exactly one merge call, for the reviewed commit, and the task records the merge", async () => {
  await grantNow(merger);
  const asked = await merger.must("merge_task", { ...where(), submission_no: 1, commit_sha: HEAD });
  eq(asked.merge_state, "requested", "the answer's state");
  const done = await until(change, (seen) => seen.merge_state !== "requested", "the merge");
  eq([done.merge_state, done.merge_reason, done.pr_state, done.merge_requested_by], ["succeeded", null, "merged", merger.id], "the task's change");
  const calls = await merges();
  eq(calls.map((call) => [call.path, call.status, call.body.sha, call.body.merge_method]), [[`/repositories/${repo}/pulls/7/merge`, 200, HEAD, "merge"]], "merge calls");
  const seen = await fake(`merge-calls?repo=${repo}`);
  eq(seen.statuses, [{ sha: HEAD, state: "success", context: "podster/review" }], "statuses set");
  eq([seen.pulls["7"].merged, seen.pulls["7"].head_sha, seen.has], [true, HEAD, [HEAD]], "the pull request and the default branch");
  eq(done.merge_sha, seen.pulls["7"].merge_commit_sha, "the merge commit recorded");
  // Asking again merges nothing more.
  refused(await ask(merger), "already_merged", "asking again");
  eq((await merges()).length, 1, "merge calls after asking again");
  // The agent that asked reads how it went from the release status (M5 step 8), which fetches nothing. It isn't shown
  // the task's change, so it gets the merge alone: nothing of the pull request or its checks. No release exists.
  const status = await merger.must("get_task_release_status", where(), false);
  eq([status.merge.state, status.merge.reason, status.merge.sha, status.merge.requested_by], ["succeeded", null, done.merge_sha, merger.id], "the release status's merge");
  ok(typeof status.merge.observed_at === "number", "the merge has no observation time");
  eq([status.pull_request, status.checks], [null, null], "what the requester is shown of the change");
  eq(status.release.exists, false, "the release");
  // The room's owner, who is shown the change, gets all of it. Checks weren't read here, which is said as unobserved.
  const whole = await owner.must("GET", `/v1/workspaces/${room}/tasks/${task}/release-status`);
  eq([whole.pull_request.pr_number, whole.pull_request.pr_state, whole.merge.state], [7, "merged", "succeeded"], "the owner's release status");
  eq([whole.checks.state, whole.checks.counts, whole.checks.observed_at, whole.checks.commit_sha], [null, null, null, null], "the owner's view of the checks");
  // Another agent in the room, shown neither the change nor having asked, is refused.
  refused(await sibling.call("get_task_release_status", where()), "not_allowed", "another agent reading the release status");
});

// What GitHub's two rulesets refused in the spike, as the fake holds to them, each shown through Podster with one exact
// answer. A new task and pull request for each, with a commit of its own, so the status on the first one's commit counts
// for nothing here.
const headOf = (number) => (0x10 + number).toString(16).repeat(20);
const taskOn = async (number, reviewer = robot) => {
  await fake("agent-repo", { id: repo, status: 201, pulls: { [number]: { head_sha: headOf(number), base_sha: BASE } } });
  const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `Change ${number}`, instructions: "x", assignee: coder.id, reviewer: reviewer.id }, { idempotencyKey: key() });
  const here = { workspace_id: room, task_id: made.id };
  const accepted = await coder.must("accept_task", { ...here, version: made.version });
  return { here, version: accepted.version };
};
/** A task on pull request `number`, approved by `reviewer`: the robot, independent of the submitter, unless a check needs the owner. */
const approvedOn = async (number, reviewer = robot) => {
  const { here, version } = await taskOn(number, reviewer);
  await coder.must("submit_task", { ...here, version, note: "Done", commit_sha: headOf(number), pr_number: number });
  if (reviewer === robot) await robot.must("verify_task", { ...here, submission_no: 1, commit_sha: headOf(number) });
  else await reviewer.must("POST", `/v1/workspaces/${room}/tasks/${here.task_id}/verify`, { submission_no: 1, commit_sha: headOf(number) });
  return here;
};
const changeOf = async (here) => (await owner.must("GET", `/v1/workspaces/${room}/tasks/${here.task_id}`)).change;
const mergeAndWait = async (here, number) => {
  await merger.must("merge_task", { ...here, submission_no: 1, commit_sha: headOf(number) });
  return until(() => changeOf(here), (seen) => seen.merge_state !== "requested", "the merge");
};
const mergesOf = async (number) => (await merges()).filter((call) => call.path === `/repositories/${repo}/pulls/${number}/merge`).map((call) => call.status);
const pullOf = async (number) => (await fake(`merge-calls?repo=${repo}`)).pulls[String(number)];

await check("M5-S7v", "an agent's token can't write to the default branch: a commit is refused 409, a ref update 422, and a merge 405", async () => {
  await owner.must("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: coder.id, action: "push" });
  // While the task is the agent's to work on, its token is live.
  const { here } = await taskOn(8);
  const access = await coder.must("get_repo_access", here, false);
  ok(typeof access?.token === "string" && access.token.length > 0, "the agent got no token");
  const direct = (method, path, body) => fetch(`${github}/repositories/${repo}/${path}`, { method, headers: { authorization: `Bearer ${access.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "e2e" }, body: JSON.stringify(body) });
  eq((await direct("PUT", "contents/README.md", { message: "x", content: "eA==", branch: "main" })).status, 409, "a commit straight to the default branch");
  eq((await direct("PATCH", "git/refs/heads/main", { sha: headOf(8), force: true })).status, 422, "moving the default branch's ref");
  // Nor can it merge a pull request, its own or the one whose commit the merge App has marked.
  eq((await direct("PUT", "pulls/8/merge", { sha: headOf(8), merge_method: "merge" })).status, 405, "the agent merging its own pull request");
  eq((await pullOf(8)).merged ?? false, false, "the pull request merged");
});

await check("M5-S7vi", "a commit with no review status isn't merged: GitHub refuses the merge App, and the merge fails provider_refused", async () => {
  const here = await approvedOn(9);
  // GitHub says the status was set, and it isn't there.
  await fake("agent-repo", { id: repo, status: "drop" });
  const done = await mergeAndWait(here, 9);
  eq([done.merge_state, done.merge_reason], ["failed", "provider_refused"], "the task's change");
  eq(await mergesOf(9), [405], "merge calls");
  eq((await pullOf(9)).merged ?? false, false, "the pull request merged");
});

await check("M5-S7vii", "a status from another App doesn't satisfy the rule: the merge is refused, and fails provider_refused", async () => {
  const here = await approvedOn(10);
  await fake("agent-repo", { id: repo, status: "foreign" });
  const done = await mergeAndWait(here, 10);
  eq([done.merge_state, done.merge_reason], ["failed", "provider_refused"], "the task's change");
  eq(await mergesOf(10), [405], "merge calls");
  eq((await pullOf(10)).merged ?? false, false, "the pull request merged");
});

await check("M5-S7viii", "a head that moved after review isn't merged: the merge fails commit_changed and no merge call is made", async () => {
  const here = await approvedOn(11);
  await fake("agent-repo", { id: repo, pulls: { 11: { head_sha: "c3".repeat(20), base_sha: BASE } } });
  const done = await mergeAndWait(here, 11);
  eq([done.merge_state, done.merge_reason, done.commit_changed], ["failed", "commit_changed", true], "the task's change");
  eq(await mergesOf(11), [], "merge calls");
  eq((await pullOf(11)).merged ?? false, false, "the pull request merged");
  refused(await merger.call("merge_task", { ...here, submission_no: 1, commit_sha: headOf(11), idempotency_key: key() }), "commit_changed", "asking again");
});

await check("M5-S7ix", "a commit the submitter's own person approved isn't merged: the review completes the task, and the merge is refused self_review", async () => {
  const here = await approvedOn(12, owner);
  // Ordinary review is unchanged: the owner, who controls the coder, completed the task's review.
  eq((await owner.must("GET", `/v1/workspaces/${room}/tasks/${here.task_id}`)).task.status, "completed", "the task's status");
  refused(await merger.call("merge_task", { ...here, submission_no: 1, commit_sha: headOf(12), idempotency_key: key() }), "self_review", "a grant holder asking to merge it");
  eq((await changeOf(here)).merge_state, "not_requested", "the merge's state");
  eq(await mergesOf(12), [], "merge calls");
});

for (const agent of [coder, sibling, robot, merger]) await agent.close();
const counts = report.counts();
console.log(`\nmerge_task, against the fake GitHub: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
