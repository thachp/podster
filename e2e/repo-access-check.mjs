// Managed repositories switched on (M5 step 6), on a local stack where both Workers have MANAGED_REPOSITORIES set to
// "true". run-local.mjs runs it after the journey, which runs with both off and is unchanged.
//
//   node repo-access-check.mjs --base-url http://localhost:8787
//
// The room here has no linked repository, so no token can ever be minted for it (merge-check.mjs makes one, against the
// rehearsal's fake GitHub). What
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

await check("M5-S6a", "with the switch on, the agent is offered exactly get_repo_access and merge_task for a repository, and no deploy tool", async () => {
  const tools = await coder.tools();
  // Step 7b's tool is listed with the switch on, and only then: the journey and managed-off-check.mjs, with it off, find neither.
  eq(tools.filter((t) => /repo|merge|release|deploy/.test(t)).sort(), ["get_repo_access", "get_task_release_status", "merge_task"], "the managed-repository tools");
});

await check("M5-S6b", "an agent without a grant gets a refusal and no token", async () => {
  eq(accepted.status, "accepted", "the task's status");
  const result = await coder.call("get_repo_access", where);
  // This room has no repository, so its task isn't a linked one, and that is the one answer: it comes before the grant
  // is looked at. The grant's own refusal is shown, exactly, in merge-check.mjs and against the fake in apps/api's tests.
  refused(result, "task_not_linked", "asking with no grant");
  tokenless(result, "asking with no grant");
  // Asking again is refused again, the same way.
  refused(await coder.call("get_repo_access", where), result.code, "asking again");
});

await check("M5-S6c", "an agent that isn't the assignee, and a person, get a refusal and no token", async () => {
  const theirs = await bystander.call("get_repo_access", where);
  refused(theirs, "not_allowed", "another agent's task");
  tokenless(theirs, "another agent's task");
  const person = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${made.id}/repo-access`, {});
  ok(!person.ok, `a person was given an answer: HTTP ${person.status}`);
  tokenless(person.body ?? {}, "a person asking");
});

await check("M5-S6d", "nothing can be chosen: a field naming a repository or permission is refused", async () => {
  const res = await owner.target.http(`/api/v1/workspaces/${room}/tasks/${made.id}/repo-access`, { method: "POST", headers: { cookie: owner.cookie, origin: target.base, "content-type": "application/json" }, body: JSON.stringify({ repository_id: 1 }) });
  ok(res.status >= 400, `a body with a field was accepted: HTTP ${res.status}`);
});

for (const agent of [coder, bystander]) await agent.close();
const counts = report.counts();
console.log(`\nrepository access, switched on: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
