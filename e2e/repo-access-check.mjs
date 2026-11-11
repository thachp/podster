// Managed repositories switched on (M5 step 6), on a local stack where both Workers have MANAGED_REPOSITORIES set to
// "true". run-local.mjs runs it after the journey, which runs with both off and is unchanged.
//
//   node repo-access-check.mjs --base-url http://localhost:8787
//
// A local stack can't reach GitHub, so no room here can have a linked repository and no token can ever be minted. What
// this shows end to end is the switch's wiring and that every call is refused with no token in the answer: the agent
// sees the tool only with the switch on, and an agent without a grant, and one whose task isn't its own, gets a
// refusal. The grant, standing and minting paths themselves are covered against a fake GitHub in apps/api's tests.
import { eq, key, McpAgent, ok, Person, refused, Report, Target } from "./lib.mjs";

const at = process.argv.indexOf("--base-url");
const base = at > 0 ? process.argv[at + 1] : undefined;
if (!base || !/^http:\/\/localhost:\d+$/.test(base)) {
  console.error("Give --base-url http://localhost:<port>. This check is for a local stack only.");
  process.exit(2);
}
const target = new Target(base, { pollMs: 500 });
const report = new Report();
const check = report.check.bind(report);
/** No answer may carry anything shaped like a GitHub token. */
const tokenless = (result, label) => ok(!JSON.stringify(result).includes("ghs_") && !JSON.stringify(result).includes('"token"'), `${label}: an answer carried a token`);

const owner = await Person.signUp(target, "Repo owner");
const room = await owner.createRoom(`e2e repo access ${new Date().toISOString().slice(0, 19)}`);
const coder = await McpAgent.connect(target, owner, "Coder");
const bystander = await McpAgent.connect(target, owner, "Bystander");
for (const agent of [coder, bystander]) await owner.addAgent(room, agent);
const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: "Change the code", instructions: "x", assignee: coder.id }, { idempotencyKey: key() });
const accepted = await coder.must("accept_task", { workspace_id: room, task_id: made.id, version: made.version });
const where = { workspace_id: room, task_id: made.id };

await check("M5-S6a", "with the switch on, the agent is offered get_repo_access and merge_task, and no other merge tool and no deploy tool", async () => {
  const tools = await coder.tools();
  ok(tools.includes("get_repo_access"), `get_repo_access isn't listed: ${tools.join(", ")}`);
  // Step 7b's tool is listed with the switch on, and only then: the journey, with it off, still finds none (AC-17).
  ok(tools.includes("merge_task"), `merge_task isn't listed: ${tools.join(", ")}`);
  ok(!tools.some((t) => t !== "merge_task" && /merge|deploy/.test(t)), "another merge tool, or a deploy tool, is exposed");
});

await check("M5-S6b", "an agent without a grant gets a refusal and no token", async () => {
  eq(accepted.status, "accepted", "the task's status");
  const result = await coder.call("get_repo_access", where);
  // No link can be made here, so the refusal comes before the grant is looked at.
  refused(result, ["task_not_linked", "repo_not_ready", "grant_required"], "asking with no grant");
  tokenless(result, "asking with no grant");
  // Asking again is refused again, the same way.
  refused(await coder.call("get_repo_access", where), result.code, "asking again");
});

await check("M5-S6c", "an agent that isn't the assignee, and a person, get a refusal and no token", async () => {
  const theirs = await bystander.call("get_repo_access", where);
  refused(theirs, ["not_allowed", "task_not_found"], "another agent's task");
  tokenless(theirs, "another agent's task");
  const person = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${made.id}/repo-access`, {});
  ok(!person.ok, `a person was given an answer: HTTP ${person.status}`);
  tokenless(person.body ?? {}, "a person asking");
});

await check("M5-S6d", "nothing can be chosen: a field naming a repository or permission is refused", async () => {
  const res = await owner.target.http(`/api/v1/workspaces/${room}/tasks/${made.id}/repo-access`, { method: "POST", headers: { cookie: owner.cookie, origin: target.base, "content-type": "application/json" }, body: JSON.stringify({ repository_id: 1 }) });
  ok(res.status >= 400, `a body with a field was accepted: HTTP ${res.status}`);
});

// Step 7b, the property AC-17 exists for, as far as a stack with no GitHub can show it: approval merges nothing, and
// asking for a merge is refused for the submitter, for another agent of the same person, and for the room's owner, who
// holds no merge grant. That only an authorized merge_task merges, and merges exactly the reviewed commit, needs a
// repository, and is shown against a fake GitHub in apps/api/test/merge-task.spec.ts.
const COMMIT = "a".repeat(40);
const mergeCodes = ["self_merge", "grant_required", "task_not_linked", "repo_not_ready", "not_allowed"];
const detail = () => owner.must("GET", `/v1/workspaces/${room}/tasks/${made.id}`);
const noMerge = async (label) => {
  const task = await detail();
  eq(task.task.status, "completed", `${label}: the task's status`);
  ok(task.change == null || task.change.merge_state === "not_requested", `${label}: a merge is on record: ${JSON.stringify(task.change)}`);
  ok(!task.history.some((event) => String(event.type).startsWith("merge.")), `${label}: a merge event is in the task's history`);
};

await check("M5-S7a", "approval alone merges nothing and asks for no merge", async () => {
  await coder.must("submit_task", { ...where, version: accepted.version, note: "Done" });
  await owner.must("POST", `/v1/workspaces/${room}/tasks/${made.id}/verify`, { submission_no: 1 });
  await noMerge("after approval");
});

await check("M5-S7b", "the submitter, and another agent of the same person, are refused a merge of the approved work", async () => {
  for (const [agent, label] of [[coder, "the submitter"], [bystander, "another agent of the same person"]]) {
    const result = await agent.call("merge_task", { ...where, submission_no: 1, commit_sha: COMMIT, idempotency_key: key() });
    refused(result, mergeCodes, label);
    tokenless(result, label);
  }
  await noMerge("after the agents asked");
});

await check("M5-S7c", "holding the room and the review isn't holding a merge grant: the owner is refused, whatever the body names", async () => {
  const plain = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${made.id}/merge`, { submission_no: 1, commit_sha: COMMIT });
  refused(plain, mergeCodes, "the owner asking");
  const naming = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${made.id}/merge`, { submission_no: 1, commit_sha: COMMIT, repository_id: 1, pr_number: 7, merge_method: "squash" });
  ok(!naming.ok, `a body naming a repository was accepted: HTTP ${naming.status}`);
  await noMerge("after the owner asked");
});

for (const agent of [coder, bystander]) await agent.close();
const counts = report.counts();
console.log(`\nrepository access, switched on: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
