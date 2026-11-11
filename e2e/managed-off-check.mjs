// Managed repositories switched off, as on every deployment: an agent is offered neither get_repo_access nor merge_task,
// and both routes answer as ones that don't exist. run-local.mjs runs it against the first stack, beside the journey.
//
//   node managed-off-check.mjs --base-url http://localhost:8787
import { eq, key, McpAgent, ok, Person, Report, Target } from "./lib.mjs";

const at = process.argv.indexOf("--base-url");
const base = at > 0 ? process.argv[at + 1] : undefined;
if (!base || !/^http:\/\/localhost:\d+$/.test(base)) {
  console.error("Give --base-url http://localhost:<port>. This check is for a local stack only.");
  process.exit(2);
}
const target = new Target(base, { pollMs: 500 });
const report = new Report();

const owner = await Person.signUp(target, "Off owner");
const room = await owner.createRoom(`e2e managed off ${new Date().toISOString().slice(0, 19)}`);
const agent = await McpAgent.connect(target, owner, "Off agent");
await owner.addAgent(room, agent);
const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: "Anything", instructions: "x", assignee: agent.id }, { idempotencyKey: key() });

await report.check("M5-OFFa", "with the switch off, an agent is offered no managed-repository tool at all", async () => {
  eq((await agent.tools()).filter((t) => ["get_repo_access", "merge_task", "get_task_release_status"].includes(t) || /merge|deploy/.test(t)), [], "the managed-repository tools");
});

await report.check("M5-OFFb", "with the switch off, the token and merge routes answer exactly as a task verb that doesn't exist", async () => {
  const none = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${made.id}/no-such-verb`, { submission_no: 1, commit_sha: "a".repeat(40) });
  ok(!none.ok, "a verb that doesn't exist was accepted");
  for (const verb of ["merge", "repo-access"]) {
    const got = await owner.dash("POST", `/v1/workspaces/${room}/tasks/${made.id}/${verb}`, { submission_no: 1, commit_sha: "a".repeat(40) });
    eq([got.status, got.code], [none.status, none.code], `POST …/${verb}`);
  }
  // The release status (M5 step 8) is a read, and answers as a read that was never there.
  const noRead = await owner.dash("GET", `/v1/workspaces/${room}/tasks/${made.id}/no-such-read`);
  const status = await owner.dash("GET", `/v1/workspaces/${room}/tasks/${made.id}/release-status`);
  ok(!noRead.ok, "a read that doesn't exist was answered");
  eq([status.status, status.code], [noRead.status, noRead.code], "GET …/release-status");
});

await agent.close();
const counts = report.counts();
console.log(`\nmanaged repositories, switched off: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
