// merge_task end to end (M5 step 7b), on a local stack with managed repositories on and GitHub stood in for by the test
// suite's fake (fake-github-server.mjs). run-local.mjs builds the API for this with its `rehearsal` feature, which sends
// GitHub's calls to that fake on this machine and nowhere else.
//
//   node merge-check.mjs --base-url http://localhost:8787 --github http://127.0.0.1:9999
//
// The repository is provisioned for real, through the fake: an operator gives the organization the delegation, the
// room's owner asks for the repository, and the room's job creates and protects it. Then the four things AC-17 exists
// for, each with its exact answer: approval merges nothing; a merge-grant holder who is the submitter, or controlled by
// the same person, is refused `self_merge`; a participant with no merge grant is refused `grant_required`; and an
// authorized holder's merge_task leads to exactly one merge call, for the reviewed commit, which the task records.
// PODSTER_E2E_OPERATOR_COOKIE is the session of the person named in the stack's OPERATORS.
import { eq, key, McpAgent, ok, Person, refused, Report, Target } from "./lib.mjs";

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const [base, github] = [arg("--base-url"), arg("--github")];
if (!base || !/^http:\/\/localhost:\d+$/.test(base) || !github || !/^http:\/\/127\.0\.0\.1:\d+$/.test(github) || !process.env.PODSTER_E2E_OPERATOR_COOKIE) {
  console.error("Give --base-url http://localhost:<port>, --github http://127.0.0.1:<port> and PODSTER_E2E_OPERATOR_COOKIE. This check is for a local stack only.");
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

const operator = await Person.fromCookie(target, "Operator", process.env.PODSTER_E2E_OPERATOR_COOKIE);
const owner = await Person.signUp(target, "Merge owner");
const other = await Person.signUp(target, "Another person");
const room = await owner.createRoom(`e2e merge ${new Date().toISOString().slice(0, 19)}`);
// The owner's two agents, and one another person controls, who joins as a member of the room.
const coder = await McpAgent.connect(target, owner, "Coder");
const sibling = await McpAgent.connect(target, owner, "Sibling");
const robot = await McpAgent.connect(target, other, "Robot");
for (const agent of [coder, sibling]) await owner.addAgent(room, agent);
const invitation = await owner.invite(room, other.org, { role: "member" });
eq((await other.accept(invitation.token, other.org, [robot])).body?.agents, [robot.id], "the other person's agent joined");

let repo;
let task;
const where = () => ({ workspace_id: room, task_id: task });
const change = async () => (await owner.must("GET", `/v1/workspaces/${room}/tasks/${task}`)).change;
const grantNow = async (principal) => owner.must("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action: "merge" });
const ask = (agent) => agent.call("merge_task", { ...where(), submission_no: 1, commit_sha: HEAD, idempotency_key: key() });
const merges = async () => (await fake(`merge-calls?repo=${repo}`)).calls.filter((call) => call.method === "PUT");

await check("M5-S7-setup", "an operator delegates, the owner asks, and the room's job creates and protects the repository through the fake", async () => {
  const delegated = await operator.dash("PUT", `/v1/orgs/${owner.org}/provisioning-delegation`, { granted: true });
  ok(delegated.ok, `the delegation: HTTP ${delegated.status} ${delegated.code ?? ""}`);
  await owner.must("POST", `/v1/workspaces/${room}/repository`, { name: `e2e-merge-${key().slice(0, 8).toLowerCase()}`, visibility: "public" });
  const ready = await until(async () => (await owner.must("GET", `/v1/workspaces/${room}/repository`)), (read) => read.repository?.status === "ready" || read.request?.state === "failed", "the repository");
  eq(ready.repository?.status, "ready", `the repository's state (request: ${JSON.stringify(ready.request)})`);
  repo = ready.repository.provider_repo_id;
  // The agent-token App and the merge App know the repository, and it has one open pull request, as an agent would have made.
  await fake("agent-repo", { id: repo, pulls: { 7: { head_sha: HEAD, base_sha: BASE } } });
});

await check("M5-S7i", "an approved, linked task that nobody asks to merge is not merged, however long the room's alarm runs", async () => {
  const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: "Change the code", instructions: "x", assignee: coder.id }, { idempotencyKey: key() });
  task = made.id;
  const accepted = await coder.must("accept_task", { ...where(), version: made.version });
  await coder.must("submit_task", { ...where(), version: accepted.version, note: "Done", commit_sha: HEAD, pr_number: 7 });
  await owner.must("POST", `/v1/workspaces/${room}/tasks/${task}/verify`, { submission_no: 1, commit_sha: HEAD });
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
  refused(await ask(robot), "grant_required", "an agent another person controls, with no grant");
  eq((await change()).merge_state, "not_requested", "the merge's state");
  eq(await merges(), [], "merge calls");
});

await check("M5-S7iv", "an authorized holder's merge_task leads to exactly one merge call, for the reviewed commit, and the task records the merge", async () => {
  await grantNow(robot);
  const asked = await robot.must("merge_task", { ...where(), submission_no: 1, commit_sha: HEAD });
  eq(asked.merge_state, "requested", "the answer's state");
  const done = await until(change, (seen) => seen.merge_state !== "requested", "the merge");
  eq([done.merge_state, done.merge_reason, done.pr_state, done.merge_requested_by], ["succeeded", null, "merged", robot.id], "the task's change");
  const calls = await merges();
  eq(calls.map((call) => [call.path, call.status, call.body.sha, call.body.merge_method]), [[`/repositories/${repo}/pulls/7/merge`, 200, HEAD, "merge"]], "merge calls");
  const seen = await fake(`merge-calls?repo=${repo}`);
  eq(seen.statuses, [{ sha: HEAD, state: "success", context: "podster/review" }], "statuses set");
  eq([seen.pulls["7"].merged, seen.pulls["7"].head_sha, seen.has], [true, HEAD, [HEAD]], "the pull request and the default branch");
  eq(done.merge_sha, seen.pulls["7"].merge_commit_sha, "the merge commit recorded");
  // Asking again merges nothing more.
  refused(await ask(robot), "already_merged", "asking again");
  eq((await merges()).length, 1, "merge calls after asking again");
});

for (const agent of [coder, sibling, robot]) await agent.close();
const counts = report.counts();
console.log(`\nmerge_task, against the fake GitHub: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
