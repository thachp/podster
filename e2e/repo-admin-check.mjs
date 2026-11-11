// Who runs a room's repository (AC-10, AC-11), as the owner decided on 2026-11-11: a person who is the room's owner or a
// room admin asks for it and gives its grants, with no operator's approval first. Every organization may have managed
// repositories unless an operator took that back, and a daily cap holds the rest. On a local stack with
// MANAGED_REPOSITORIES "true", against the rehearsal's fake GitHub. run-local.mjs runs it.
//
//   PODSTER_E2E_OPERATOR_COOKIE=<cookie> node repo-admin-check.mjs --base-url http://localhost:8787
//
// PODSTER_E2E_OPERATOR_COOKIE is the session of the person named in the stack's OPERATORS. Each refusal is one exact code.
import { eq, key, McpAgent, ok, Person, refused, Report, Target } from "./lib.mjs";

const at = process.argv.indexOf("--base-url");
const base = at > 0 ? process.argv[at + 1] : undefined;
if (!base || !/^http:\/\/localhost:\d+$/.test(base) || !process.env.PODSTER_E2E_OPERATOR_COOKIE) {
  console.error("Give --base-url http://localhost:<port> and PODSTER_E2E_OPERATOR_COOKIE. This check is for a local stack only.");
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
const name = () => `e2e-admin-${key().slice(4, 12).toLowerCase()}`;

const operator = await Person.fromCookie(target, "Operator", process.env.PODSTER_E2E_OPERATOR_COOKIE);
// An organization nobody has said anything about, with a room in it, a room admin, a plain member and the owner's agent.
const owner = await (await Person.signUp(target, "Room owner")).useNewOrg(`Repo admins ${new Date().toISOString().slice(0, 19)}`);
const team = owner.org;
const admin = await Person.signUp(target, "Room admin");
const member = await Person.signUp(target, "Room member");
const stranger = await Person.signUp(target, "Stranger");
for (const person of [admin, member]) {
  await person.must("POST", "/org-invitations/accept", { token: (await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" })).token });
  person.actingOrg = team;
}
const room = await owner.createRoom(`e2e repo admins ${new Date().toISOString().slice(0, 19)}`);
for (const [person, role] of [[admin, "admin"], [member, "member"]]) {
  await owner.must("POST", `/v1/workspaces/${room}/members`, { principal_id: person.id, kind: "person", org_id: team, role, policy_version: await owner.policyVersion(room) });
}
const coder = await McpAgent.connect(target, owner, "Coder");
await owner.addAgent(room, coder);
const repository = `/v1/workspaces/${room}/repository`;
const grant = async (who, principal, action = "push") => who.dash("POST", `${repository}/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action });

await check("AC-10a", "nobody but a person who is the room's owner or an admin asks for its repository: a member is refused not_allowed, a stranger is told nothing, and an agent has no tool for it", async () => {
  refused(await member.dash("POST", repository, { name: name(), visibility: "public" }), "not_allowed", "a member asking");
  refused(await stranger.dash("POST", repository, { name: name(), visibility: "public" }), "workspace_not_found", "a stranger asking");
  const tools = await coder.tools();
  eq(tools.filter((tool) => /repositor|grant|delegat/.test(tool) && tool !== "get_repo_access"), [], "an agent's tools for asking, granting or delegating");
  eq((await owner.must("GET", repository)).request, null, "the room's request");
});

await check("AC-10b", "an admin asks with no operator's approval: the organization holds the delegation by default, and the room's job sets the repository up", async () => {
  const held = await owner.must("GET", `/v1/orgs/${team}/provisioning-delegation`);
  eq([held.provider, held.granted, held.set_by, held.set_at], ["github", true, null, null], "the organization's delegation, which nobody set");
  eq((await admin.must("GET", repository)).delegated, true, "what the admin is told");
  const asked = await admin.must("POST", repository, { name: name(), visibility: "public" });
  eq([asked.request?.state, asked.request?.requested_by], ["pending", admin.id], "the request");
  const ready = await until(async () => owner.must("GET", repository), (read) => read.repository?.status === "ready" || read.request?.state === "failed", "the repository");
  eq(ready.repository?.status, "ready", `the repository's state (request: ${JSON.stringify(ready.request)})`);
});

let given;
await check("AC-11a", "an admin gives a grant as the owner does, and a member and a stranger give none", async () => {
  refused(await grant(member, coder), "not_allowed", "a member granting");
  refused(await grant(stranger, coder), "workspace_not_found", "a stranger granting");
  const result = await grant(admin, coder);
  ok(result.ok, `the admin's grant: HTTP ${result.status} ${result.code ?? ""}`);
  given = result.body;
  eq([given.principal_id, given.action, given.delegated_by, given.state], [coder.id, "push", admin.id, "live"], "the grant");
});

await check("AC-11b", "a grant counts only while its giver is still an admin: demoted, what they gave ends at once and they give no more", async () => {
  await owner.must("POST", `/v1/workspaces/${room}/members/${admin.id}/role`, { role: "member", policy_version: await owner.policyVersion(room) });
  ok(given, "the admin's grant wasn't given, so there's nothing to see ended");
  eq((await owner.must("GET", `${repository}/grants`)).grants, [], "the grants that aren't revoked");
  refused(await grant(admin, coder), "not_allowed", "the former admin granting");
  // Made an admin again, nothing they gave before comes back.
  await owner.must("POST", `/v1/workspaces/${room}/members/${admin.id}/role`, { role: "admin", policy_version: await owner.policyVersion(room) });
  eq((await owner.must("GET", `${repository}/grants`)).grants, [], "the grants after they're an admin again");
});

const rooms = [];
await check("AC-10c", "an organization is held to five accepted requests in a day: the sixth room is refused repository_request_limit and nothing is recorded for it", async () => {
  // The admin's request was the first. The owner asks in four more rooms, and is refused in a sixth.
  for (let n = 0; n < 5; n++) rooms.push(await owner.createRoom(`e2e repo cap ${n} ${new Date().toISOString().slice(0, 19)}`));
  for (const next of rooms.slice(0, 4)) await owner.must("POST", `/v1/workspaces/${next}/repository`, { name: name(), visibility: "public" });
  // A replay and a second ask for a room that has its request cost nothing.
  refused(await owner.dash("POST", `/v1/workspaces/${rooms[0]}/repository`, { name: name(), visibility: "public" }), "repo_request_exists", "asking twice for one room");
  const sixth = await owner.dash("POST", `/v1/workspaces/${rooms[4]}/repository`, { name: name(), visibility: "public" });
  refused(sixth, "repository_request_limit", "the sixth room in a day");
  eq(sixth.status, 429, "its status");
  eq((await owner.must("GET", `/v1/workspaces/${rooms[4]}/repository`)).request, null, "the sixth room's request");
});

await check("AC-10d", "an operator takes the ability away from an organization: new requests are refused not_delegated, and the repository already linked keeps working", async () => {
  refused(await owner.dash("PUT", `/v1/orgs/${team}/provisioning-delegation`, { granted: false }), "not_allowed", "the organization's own admin taking it back");
  const taken = await operator.dash("PUT", `/v1/orgs/${team}/provisioning-delegation`, { granted: false });
  ok(taken.ok, `the take-back: HTTP ${taken.status} ${taken.code ?? ""}`);
  refused(await owner.dash("POST", `/v1/workspaces/${rooms[4]}/repository`, { name: name(), visibility: "public" }), "not_delegated", "asking after the take-back");
  eq((await owner.must("GET", `/v1/workspaces/${rooms[4]}/repository`)).delegated, false, "what the owner is told");
  eq((await owner.must("GET", repository)).repository?.status, "ready", "the linked repository");
  const again = await grant(owner, coder);
  ok(again.ok, `a grant on the linked repository: HTTP ${again.status} ${again.code ?? ""}`);
  // Only an operator restores it.
  refused(await owner.dash("PUT", `/v1/orgs/${team}/provisioning-delegation`, { granted: true }), "not_allowed", "the organization's own admin restoring it");
  ok((await operator.dash("PUT", `/v1/orgs/${team}/provisioning-delegation`, { granted: true })).ok, "the operator restores it");
  eq((await owner.must("GET", `/v1/workspaces/${rooms[4]}/repository`)).delegated, true, "what the owner is told once it's restored");
});

await coder.close();
const counts = report.counts();
console.log(`\nwho runs a room's repository, switched on: ${counts.pass} passed, ${counts.fail} failed`);
process.exit(counts.fail > 0 ? 1 : 0);
