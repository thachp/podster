// A deployment's list of who may ask for a room's repository: the API's Worker variable REPOSITORY_REQUESTERS, added on
// 2026-11-11 after M5's security review. This checks that the variable itself is read, through the gateway and the API,
// on a local stack with MANAGED_REPOSITORIES "true" whose REPOSITORY_REQUESTERS is `operators` and whose OPERATORS names
// exactly one person, so that person is the only one let ask. run-local.mjs starts that stack and runs this against the rehearsal's fake GitHub.
//
//   PODSTER_E2E_LISTED_COOKIE=<cookie> node repo-requesters-check.mjs --base-url http://localhost:8787 --github http://127.0.0.1:9999
//
// PODSTER_E2E_LISTED_COOKIE is the session of the one person OPERATORS names. Each refusal is one exact code.
import { eq, key, McpAgent, ok, Person, refused, Report, Target } from "./lib.mjs";

const arg = (name) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const [base, github] = [arg("--base-url"), arg("--github")];
if (!base || !/^http:\/\/localhost:\d+$/.test(base) || !github || !/^http:\/\/127\.0\.0\.1:\d+$/.test(github) || !process.env.PODSTER_E2E_LISTED_COOKIE) {
  console.error("Give --base-url http://localhost:<port>, --github http://127.0.0.1:<port> and PODSTER_E2E_LISTED_COOKIE. This check is for a local stack only.");
  process.exit(2);
}
const target = new Target(base, { pollMs: 500 });
const report = new Report();
const check = report.check.bind(report);
const until = async (read, done, label, timeoutMs = 60_000) => {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const value = await read();
    if (done(value)) return value;
    ok(Date.now() < deadline, `${label}: still ${JSON.stringify(value)} after ${timeoutMs / 1000} seconds`);
    await new Promise((wait) => setTimeout(wait, 500));
  }
};
const name = () => `e2e-listed-${key().slice(4, 12).toLowerCase()}`;
/** Every creation call the fake GitHub has had. */
const creations = async () => (await (await fetch(`${github}/__fake/state`, { method: "POST", body: "{}" })).json()).calls.filter((call) => call.method === "POST" && /^\/orgs\/[^/]+\/repos$/.test(call.path)).length;
const stamp = new Date().toISOString().slice(0, 19);

const listed = await (await Person.fromCookie(target, "Listed person", process.env.PODSTER_E2E_LISTED_COOKIE)).useNewOrg(`Listed ${stamp}`);
const unlisted = await (await Person.signUp(target, "Unlisted owner")).useNewOrg(`Unlisted ${stamp}`);
const theirRoom = await unlisted.createRoom(`e2e unlisted ${stamp}`);
const listedRoom = await listed.createRoom(`e2e listed ${stamp}`);
const theirs = `/v1/workspaces/${theirRoom}/repository`;
const mine = `/v1/workspaces/${listedRoom}/repository`;

await check("RQ-1", "an owner the deployment doesn't list is told so by the read, is refused repository_requests_closed, and nothing is recorded or sent to GitHub", async () => {
  const before = await creations();
  const read = await unlisted.must("GET", theirs);
  eq([read.may_request, read.request, read.repository], [false, null, null], "what the owner is told");
  const asked = await unlisted.dash("POST", theirs, { name: name(), visibility: "public" });
  refused(asked, "repository_requests_closed", "an unlisted owner asking");
  ok(!JSON.stringify(asked.body ?? {}).includes(listed.id), "the refusal names nobody who is listed");
  refused(await unlisted.dash("POST", `${theirs}/retry`, {}), "repository_requests_closed", "an unlisted owner retrying");
  eq((await unlisted.must("GET", theirs)).request, null, "the room's request");
  eq(await creations(), before, "creation calls at GitHub");
});

await check("RQ-2", "the person the deployment lists asks, and the room's job sets the repository up", async () => {
  eq((await listed.must("GET", mine)).may_request, true, "what the listed person is told");
  const asked = await listed.must("POST", mine, { name: name(), visibility: "public" });
  eq([asked.request?.state, asked.request?.requested_by], ["pending", listed.id], "the request");
  const ready = await until(async () => listed.must("GET", mine), (read) => read.repository?.status === "ready" || read.request?.state === "failed", "the repository");
  eq(ready.repository?.status, "ready", `the repository's state (request: ${JSON.stringify(ready.request)})`);
});

await check("RQ-3", "a room that has its repository works for people the deployment doesn't list: an unlisted admin reads it and gives a grant", async () => {
  const team = listed.org;
  await unlisted.must("POST", "/org-invitations/accept", { token: (await listed.must("POST", `/orgs/${team}/invitations`, { role: "member" })).token });
  await listed.must("POST", `/v1/workspaces/${listedRoom}/members`, { principal_id: unlisted.id, kind: "person", org_id: team, role: "admin", policy_version: await listed.policyVersion(listedRoom) });
  unlisted.actingOrg = team;
  const admin = unlisted;
  const read = await admin.must("GET", mine);
  eq([read.repository?.status, read.may_request], ["ready", false], "what the unlisted admin is told");
  const coder = await McpAgent.connect(target, listed, "Coder");
  await listed.addAgent(listedRoom, coder);
  const given = await admin.dash("POST", `${mine}/grants`, { policy_version: await listed.policyVersion(listedRoom), principal_id: coder.id, action: "push" });
  ok(given.ok, `the unlisted admin's grant: HTTP ${given.status} ${given.code ?? ""}`);
  eq([given.body.principal_id, given.body.delegated_by, given.body.state], [coder.id, unlisted.id, "live"], "the grant");
  await coder.close();
});

const counts = report.counts();
console.log(`\nwho the deployment lets ask for a repository: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
