// Checks the contract against itself and the code: capabilities map to API operations and the CQRS sides agree, the
// public view and the managed-repository operations keep their shapes, and `Error.code` equals the error codes a text
// scan of the API and the gateway finds (error-codes.mjs, which says what that scan can't see).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { columnCheck, coreSets } from "./core-sets.mjs";
import { collectErrorCodes, compareExcluded, compareWithEnum, readSources } from "./error-codes.mjs";
import { promptWrites, provenanceInRequests } from "./provenance-checks.mjs";
import { schemaShapeProblems, unknownKeywordProblems } from "./schema-shape.mjs";
import { exclusiveSchemeProblems } from "./security-classes.mjs";
import { calls, passthroughRefuses } from "./gateway-wiring.mjs";

const api = parse(readFileSync(new URL("openapi.yaml", import.meta.url), "utf8"));
const { capabilities, person_only: personOnly = [], transfer_only: transferOnly = [], provider_only: providerOnly = [], pairing_only: pairingOnly = [], service_only: serviceOnly = [], a2a = {} } = parse(readFileSync(new URL("capabilities.yaml", import.meta.url), "utf8"));

const operations = new Map();
for (const [path, item] of Object.entries(api.paths)) {
  for (const method of ["get", "post", "put", "delete"]) {
    if (item[method]) operations.set(item[method].operationId, { method, path, op: item[method] });
  }
}

const problems = [];
const covered = new Set();
for (const [name, cap] of Object.entries(capabilities)) {
  const found = operations.get(cap.operation);
  if (!found) { problems.push(`${name}: no operation ${cap.operation}`); continue; }
  covered.add(cap.operation);
  const isRead = found.method === "get";
  if ((cap.kind === "query") !== isRead) problems.push(`${name}: ${cap.kind} uses ${found.method.toUpperCase()}`);
  const tag = cap.kind === "query" ? "queries" : "commands";
  if (!found.op.tags.includes(tag)) problems.push(`${name}: missing tag ${tag}`);
  const hasKey = (found.op.parameters ?? []).some((p) => p.$ref?.endsWith("/idempotencyKey"));
  if (cap.kind === "command" && !cap.idempotent_by_design && !hasKey) problems.push(`${name}: command without an idempotency key`);
  if (cap.kind === "query" && hasKey) problems.push(`${name}: query with an idempotency key`);
}
// What an `/a2a` token reaches: each method names capabilities that exist, and the lifecycle's commands keep their keys.
for (const [method, reached] of Object.entries(a2a)) {
  for (const name of [reached].flat()) if (!capabilities[name]) problems.push(`a2a ${method}: no capability ${name}`);
}
for (const name of ["claim_role", "get_repo_access", "submit_task"]) if (!Object.values(a2a).flat().includes(name)) problems.push(`a2a: the engineer's ${name} isn't reachable`);
for (const id of personOnly) {
  if (!operations.has(id)) problems.push(`${id}: person_only operation doesn't exist`);
  if (covered.has(id)) problems.push(`${id}: person_only but also a capability`);
}
for (const id of transferOnly) {
  if (!operations.has(id)) problems.push(`${id}: transfer_only operation doesn't exist`);
  if (covered.has(id) || personOnly.includes(id)) problems.push(`${id}: transfer_only but also listed elsewhere`);
}
for (const id of providerOnly) {
  if (!operations.has(id)) problems.push(`${id}: provider_only operation doesn't exist`);
  if (covered.has(id) || personOnly.includes(id) || transferOnly.includes(id)) problems.push(`${id}: provider_only but also listed elsewhere`);
}
for (const id of pairingOnly) {
  if (!operations.has(id)) problems.push(`${id}: pairing_only operation doesn't exist`);
  if (covered.has(id) || personOnly.includes(id) || transferOnly.includes(id) || providerOnly.includes(id)) problems.push(`${id}: pairing_only but also listed elsewhere`);
}
for (const id of serviceOnly) {
  if (!operations.has(id)) problems.push(`${id}: service_only operation doesn't exist`);
  if (covered.has(id) || personOnly.includes(id) || transferOnly.includes(id) || providerOnly.includes(id) || pairingOnly.includes(id)) problems.push(`${id}: service_only but also listed elsewhere`);
}
// The pairing sweep (M7 step 5(c), ruling L1 on #453) is the gateway's cron, a service, never a person or an agent.
for (const id of ["sweepPairings", "settlePairingSweep"]) if (!serviceOnly.includes(id)) problems.push(`${id}: must be service_only`);
// A provider's delivery and Runner's redemption (M7 step 5) each carry their own assertion, never an identity's: an
// operation of either class lists only its scheme, and nothing outside the class lists it (security-classes.mjs). A
// delivery's ID stands in for an idempotency key.
problems.push(...exclusiveSchemeProblems(operations, [
  { name: "provider_only", ids: providerOnly, scheme: "providerDelivery" },
  { name: "pairing_only", ids: pairingOnly, scheme: "pairingRedeem" },
  { name: "service_only", ids: serviceOnly, scheme: "pairingSweep" },
], api.security));
for (const id of operations.keys()) if (!covered.has(id) && !personOnly.includes(id) && !transferOnly.includes(id) && !providerOnly.includes(id) && !pairingOnly.includes(id) && !serviceOnly.includes(id)) problems.push(`${id}: operation with no capability`);
// A person's pairing operations are person_only.
for (const id of ["startPairing", "getPairing", "activatePairing", "cancelPairing"]) if (!personOnly.includes(id)) problems.push(`${id}: must be person_only`);

// The gateway's own dashboard routes for an organization's people. They never reach the API, so they aren't capabilities.
const organizations = parse(readFileSync(new URL("organizations.yaml", import.meta.url), "utf8"));
for (const [path, item] of Object.entries(organizations.paths)) {
  if (!path.startsWith("/api/")) problems.push(`organizations.yaml: ${path} isn't a dashboard route`);
  for (const method of ["get", "post", "put", "delete"]) {
    const id = item[method]?.operationId;
    if (id && operations.has(id)) problems.push(`organizations.yaml: ${id} is also an API operation`);
  }
}

// The gateway's own pairing routes (M7 step 5(b)): each reaches exactly one of the API's pairing operations, every one is
// reached, the person's are on their session under `/api/pairing`, and Runner's redeem alone takes a host proof, off
// `/api/`. A body names only what the route takes from the client, and start takes no code, host or organization.
const pairingRoutes = parse(readFileSync(new URL("pairing.yaml", import.meta.url), "utf8"));
const PAIRING_OPERATIONS = ["startPairing", "getPairing", "cancelPairing", "activatePairing", "redeemPairing"];
const reachedPairing = [];
for (const [path, item] of Object.entries(pairingRoutes.paths)) {
  for (const method of ["get", "post", "put", "delete"]) {
    const op = item[method];
    if (!op) continue;
    const target = op["x-api-operation"];
    if (!PAIRING_OPERATIONS.includes(target)) problems.push(`pairing.yaml: ${op.operationId} reaches ${target}, not a pairing operation`);
    if (operations.has(op.operationId)) problems.push(`pairing.yaml: ${op.operationId} is also an API operation`);
    if (operations.get(target)?.method !== method) problems.push(`pairing.yaml: ${op.operationId} uses ${method.toUpperCase()}, ${target} doesn't`);
    reachedPairing.push(target);
    const schemes = (op.security ?? []).flatMap((r) => Object.keys(r));
    const isRedeem = target === "redeemPairing";
    if (schemes.join() !== (isRedeem ? "hostProof" : "session")) problems.push(`pairing.yaml: ${op.operationId} must list only ${isRedeem ? "hostProof" : "session"}`);
    if (isRedeem ? path !== "/pairing/{agent}/redeem" : !path.startsWith("/api/pairing")) problems.push(`pairing.yaml: ${op.operationId} is at ${path}`);
    const body = op.requestBody?.content?.["application/json"]?.schema;
    if (body && body.additionalProperties !== false) problems.push(`pairing.yaml: ${op.operationId}'s body isn't closed`);
    const names = Object.keys(body?.properties ?? {});
    if (target === "startPairing" && names.some((n) => n !== "name")) problems.push("pairing.yaml: the start takes only `name` from the client");
  }
}
if (reachedPairing.slice().sort().join() !== PAIRING_OPERATIONS.slice().sort().join()) problems.push(`pairing.yaml: reaches ${reachedPairing.join()}, not each pairing operation once`);
const gatewayIndex = readFileSync(new URL("../../apps/gateway/src/index.ts", import.meta.url), "utf8");
if (!passthroughRefuses(gatewayIndex, "/v1/pairing")) problems.push("apps/gateway/src/index.ts: the passthrough must refuse /v1/pairing");
for (const handler of ["handlePairing", "handlePairingRedeem"]) if (!calls(gatewayIndex, handler)) problems.push(`apps/gateway/src/index.ts: ${handler} isn't called`);

// The public view (ADR 0008) is closed at every level, so a field reaches the public surface only by being named here.
const view = JSON.parse(readFileSync(new URL("public-workroom-view.schema.json", import.meta.url), "utf8"));
const closed = (schema, at) => {
  if (schema.type === "object" || schema.properties) {
    if (schema.additionalProperties !== false) problems.push(`public-workroom-view.schema.json: ${at} isn't closed`);
    const names = Object.keys(schema.properties ?? {});
    if ((schema.required ?? []).slice().sort().join() !== names.slice().sort().join()) problems.push(`public-workroom-view.schema.json: ${at} must require exactly its properties`);
    for (const [name, child] of Object.entries(schema.properties ?? {})) closed(child, `${at}.${name}`);
  }
  if (schema.items) closed(schema.items, `${at}[]`);
};
closed(view, "view");
for (const id of ["getPublicWorkroom", "explorePublicWorkrooms"]) if (!operations.has(id)) problems.push(`${id}: the public read's operation is missing`);

// Managed repositories (M5, ADR 0009): the room's read names only the room, and its states are exactly the ADR's. A token,
// merge or status capability isn't in the contract until the step that builds it, so no agent sees a merge tool before then.
const repository = operations.get("getRepository");
if (!repository) problems.push("getRepository: the managed repository read is missing");
else if ([...repository.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).join() !== "ws") problems.push("getRepository: its path may name only ws");
if (!personOnly.includes("getRepository")) problems.push("getRepository: must be person_only");
const states = { "RepoRequest.state": "pending,ready,failed,uncertain", "RepoLink.status": "ready,degraded,suspended" };
for (const [at, expected] of Object.entries(states)) {
  const [schema, field] = at.split(".");
  if (api.components.schemas[schema]?.properties?.[field]?.enum?.join() !== expected) problems.push(`${at}: must be exactly ${expected}`);
}
// M5 step 5b: grants are given, taken back and listed by people only, and name only the room and a grant.
for (const [id, params] of [["listRepositoryGrants", "ws"], ["grantRepositoryAction", "ws"], ["revokeRepositoryGrant", "ws,grant"]]) {
  const found = operations.get(id);
  if (!found) problems.push(`${id}: the repository grant operation is missing`);
  else if ([...found.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).join() !== params) problems.push(`${id}: its path may name only ${params}`);
  if (!personOnly.includes(id)) problems.push(`${id}: must be person_only`);
}
// M6 step 6 added `deploy`, given by the same people on the same route, behind RELEASES. The request takes exactly what
// the answer names.
if (api.components.schemas.RepoGrant?.properties?.action?.enum?.join() !== "push,merge,deploy") problems.push("RepoGrant.action: must be exactly push,merge,deploy");
{
  const given = operations.get("grantRepositoryAction");
  const asked = given && api.paths[given.path]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.action?.enum?.join();
  if (asked !== "push,merge,deploy") problems.push("grantRepositoryAction: its action must be exactly push,merge,deploy");
}
for (const schema of ["RepoRequest", "RepoLink", "RoomRepository", "RepoGrant", "RepoGrantList"]) {
  if (api.components.schemas[schema]?.additionalProperties !== false) problems.push(`${schema}: isn't closed`);
}

// Release (M6 step 2, ADR 0010): the contract and the state only. Every operation is a person's or an operator's, and
// names only what its path may. One capability reaches one, since 6g: `deploy_release`, an agent's request for a
// release, reaches `requestRelease` and nothing else. Anything else that names a release or a deployment is in no
// agent's list (AC-17).
const AGENT_RELEASE = { capability: "deploy_release", operation: "requestRelease" };
const releaseOperations = {
  getReleaseConfig: "ws", setReleaseConfig: "ws", listReleaseApprovals: "ws", requestRelease: "ws", approveRelease: "ws,release", declineRelease: "ws,release", rollbackRelease: "ws,release", getAppHostname: "ws", requestAppHostname: "ws", removeAppHostname: "ws", checkAppHostname: "ws",
  deleteAppData: "ws,label", deleteAppDataAsOperator: "label", retireAppLabel: "label",
  createAppReport: "", suspendApp: "label", liftAppSuspension: "label", suspendAppHost: "host", liftAppHostSuspension: "host", stopContentDomain: "", resumeContentDomain: "", listTakedownFindings: "",
  getReleaseDelegation: "org", setReleaseDelegation: "org",
};
for (const [id, params] of Object.entries(releaseOperations)) {
  const found = operations.get(id);
  if (!found) problems.push(`${id}: the release operation is missing`);
  else {
    if ([...found.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).join() !== params) problems.push(`${id}: its path may name only ${params || "nothing"}`);
    // Each says what it answers switched off. One that isn't built, or is built in part, says what it answers then, so
    // a reader of the contract isn't told release works. Step 4(a) built an app's suspension and the stop for the
    // whole content domain, with their lifting, and the operator's read of what the reconciles found. A host's suspension still answers `release_not_available` while no
    // content domain is configured, and says so.
    // Step 9 built a person's report that names an app.
    // Decision 218's PR B built the operator's release switch for an organization, read and set.
    // Step 6 built the room's release configuration, read and set, which the room itself answers.
    // Step 8's first PR built the room's custom hostname, read, asked for and removed, which the room itself answers.
    // Step 10(b) built the room's list of releases awaiting approval, which the room itself answers.
    // "Check now" on a pending custom hostname (2026-11-27), which the room itself answers.
    // Step 6 built a person's request for a release, which the room itself answers.
    // Step 6's 6f built approving and declining one, and 6h asking to roll back, which the room itself answers.
    // S4 of the store plan built deleting an app's data, the owner's (which the room itself answers) and an operator's.
    // Step 6's 6f built an operator's retirement of a room's label another room's lookup row holds, behind the gate.
    const built = ["requestRelease", "approveRelease", "declineRelease", "rollbackRelease", "listReleaseApprovals", "suspendApp", "liftAppSuspension", "stopContentDomain", "resumeContentDomain", "listTakedownFindings", "createAppReport", "getReleaseDelegation", "setReleaseDelegation", "getReleaseConfig", "setReleaseConfig", "getAppHostname", "requestAppHostname", "removeAppHostname", "checkAppHostname", "deleteAppData", "deleteAppDataAsOperator", "retireAppLabel"].includes(id);
    if (!found.op.summary?.includes("`not_found`")) problems.push(`${id}: its summary must say what it answers while release is switched off`);
    // Asking for a custom hostname is built but gated: while the release path isn't complete, a deployment with release
    // and a content provider answers it `release_not_available`, and its summary must say exactly when. So is asking for a
    // release, and approving one, until the release path is complete (`RELEASE_PATH_COMPLETE`). Declining only takes
    // away and passes no gate, so its summary may not name `release_not_available` at all.
    const gates = { requestAppHostname: "**While the release path isn't complete,**", requestRelease: "**Until the release path is complete**", approveRelease: "**Until the release path is complete**", rollbackRelease: "**Until the release path is complete**", retireAppLabel: "**Until the release path is complete**" };
    const gated = id in gates;
    if (gated && !found.op.summary?.includes(gates[id])) problems.push(`${id}: its summary must say when its gate answers \`release_not_available\``);
    if (built ? found.op.summary?.includes("Not built") || (!gated && found.op.summary?.includes("`release_not_available`")) : !found.op.summary?.includes("`release_not_available`")) problems.push(`${id}: its summary must say ${built ? "it is built, and not that it isn't" : "what it answers while it isn't built"}`);
  }
  if (id === AGENT_RELEASE.operation) {
    if (personOnly.includes(id)) problems.push(`${id}: is ${AGENT_RELEASE.capability}'s, so it can't be person_only`);
  } else if (!personOnly.includes(id)) problems.push(`${id}: must be person_only`);
}
if (capabilities[AGENT_RELEASE.capability]?.operation !== AGENT_RELEASE.operation || capabilities[AGENT_RELEASE.capability]?.kind !== "command") problems.push(`${AGENT_RELEASE.capability}: must be the command that reaches ${AGENT_RELEASE.operation}`);
for (const [name, cap] of Object.entries(capabilities)) {
  if (name === AGENT_RELEASE.capability && cap.operation === AGENT_RELEASE.operation) continue;
  const found = operations.get(cap.operation);
  if (/deploy|release[-_]?config|app[-_]?host|content[-_]?domain|preview/i.test(`${name} ${cap.operation} ${found?.path ?? ""}`) || /\/releases(\/|$)/.test(found?.path ?? "") || releaseOperations[cap.operation] !== undefined) problems.push(`${name}: no capability but ${AGENT_RELEASE.capability} may reach a release, a deployment or an app's hosts`);
}
// The closed sets are `crates/core`'s, never restated here: core-sets.mjs reads them from its source, and the contract's
// enums and the room's column checks must each equal them, value for value and in core's order. So a state, a trigger or
// a policy added to the rules fails this until the contract and a new migration say the same.
const root = new URL("../../", import.meta.url);
const core = coreSets(root);
const releaseEnums = {
  "ReleaseConfig.approval_policy": core.approvalPolicies.join(), "Release.environment": core.environment, "Release.state": core.releaseStates.join(), "TaskRelease.state": core.releaseStatusStates.join(), "TaskRelease.waiting": [...core.releaseWaitings, null].join(),
  "AppHostnameRequest.state": core.hostnameRequestStates.join(), "AppHostnameRequest.setup_status": core.hostnameSetupStatuses.join(), "AppHostnameRequest.provider_status": [...core.providerStatuses, null].join(),
  "AppDataDeletion.data": core.dataStates.join(), "AppDataDeletion.cause": [...core.deleteCauses, null].join(),
};
const store = readFileSync(new URL("apps/api/src/store.rs", root), "utf8");
const columns = { "release.state": core.releaseStates, "hostname_request.state": core.hostnameRequestStates, "unpublish.cause": core.unpublishCauses, "task_input_author.input": core.promptInputs, "task_input_text.input": core.promptInputs };
for (const [at, expected] of Object.entries(columns)) {
  const [table, column] = at.split(".");
  try {
    if (columnCheck(store, table, column).join() !== expected.join()) problems.push(`${at}: the room's column check must be exactly core's ${expected.join()}`);
  } catch (error) { problems.push(error.message); }
}
// M7 step 4 (decision 228): a task's provenance names core's prompt inputs, in core's order, and nothing else. It is a
// read: closed, on `get_task` alone, and no command takes any of it.
const provenance = api.components.schemas.TaskProvenance;
if (provenance?.additionalProperties !== false || provenance?.properties?.inputs?.items?.additionalProperties !== false) problems.push("TaskProvenance: isn't closed");
if (provenance?.properties?.inputs?.items?.properties?.input?.enum?.join() !== core.promptInputs.join()) problems.push(`TaskProvenance.inputs.input: must be exactly core's ${core.promptInputs.join()}`);
if (provenance?.properties?.room_visibility?.enum?.join() !== "private,public") problems.push("TaskProvenance.room_visibility: must be exactly private,public");
if (api.components.responses.TaskDetail?.content?.["application/json"]?.schema?.properties?.provenance?.$ref !== "#/components/schemas/TaskProvenance") problems.push("TaskDetail.provenance: must be the TaskProvenance schema");
// Every schema in each contract file keeps its shape: no keyword slipped under `properties` and no `items` left null, the
// marks of a mis-indented YAML block (TaskProvenance, #443). schema-shape.test.mjs shows it finds both.
for (const file of ["openapi.yaml", "capabilities.yaml", "organizations.yaml", "pairing.yaml", "public-workroom-view.schema.json"]) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const doc = file.endsWith(".json") ? JSON.parse(text) : parse(text);
  problems.push(...schemaShapeProblems(doc).map((problem) => `${file} ${problem}`));
  // And every schema holds only schema keywords, so a field written inside its neighbour's schema is found (#468).
  problems.push(...unknownKeywordProblems(doc, file.endsWith(".schema.json")).map((problem) => `${file} ${problem}`));
}
// No command may take a provenance or an author, however deep its schema puts the name (F5), and only the room's recorded
// command paths write a task's prompt text or its provenance (F6). provenance-checks.test.mjs shows each finds what it must.
problems.push(...provenanceInRequests(api));
problems.push(...promptWrites(readSources(new URL("../../", import.meta.url).pathname).rust));
// The claim object's own table takes its states from core too.
const claims = readFileSync(new URL("apps/api/src/hostname_claim.rs", root), "utf8");
try {
  if (columnCheck(claims, "claim", "state").join() !== core.hostnameClaimStates.join()) problems.push(`claim.state: the claim object's column check must be exactly core's ${core.hostnameClaimStates.join()}`);
} catch (error) { problems.push(error.message); }
// A request is open, and holds the room's one hostname, in exactly the states core's `is_open` names; a claim holds its
// name in exactly the states `holds` names; and a release must have its script and its approver in exactly the states
// `serves` names.
const listed = (text) => text?.split(",").map((value) => value.trim().replace(/^'|'$/g, "")).join();
const ties = [
  ["hostname_request.open", store, /CHECK \(\(open IS NOT NULL\) = \(state IN \(([^)]*)\)\)\)/, core.openHostnameRequestStates],
  ["claim.held", claims, /CHECK \(\(held IS NOT NULL\) = \(state IN \(([^)]*)\)\)\)/, core.holdingHostnameClaimStates],
  ["release's script and approver", store, /CHECK \(state NOT IN \(([^)]*)\) OR \(script_name IS NOT NULL AND approved_by IS NOT NULL\)\)/, core.servingReleaseStates],
];
for (const [what, source, pattern, expected] of ties) {
  if (listed(source.match(pattern)?.[1]) !== expected.join()) problems.push(`${what}: must be tied to exactly core's ${expected.join()}`);
}
// A release is declined exactly when someone declined it. The state's name is core's.
if (!core.releaseStates.includes("declined") || !store.includes("CHECK ((state = 'declined') = (declined_by IS NOT NULL))")) problems.push("release.declined_by: must be set exactly in core's declined state");
if (!store.includes(`environments_json = '[\\"${core.environment}\\"]'`)) problems.push(`release_config.environments_json: must be exactly the one environment, ${core.environment}`);
// M6 step 7: a task's release status carries the release beside checks and merge. It is null for whoever is given the
// merge alone, `{ exists: false }` while release is off, or the latest attempt, whose `served` and `result_url` are what
// says live: the state alone never does.
{
  const release = api.components.schemas.TaskReleaseStatus?.properties?.release;
  const shown = api.components.schemas.TaskRelease;
  const variants = (release?.oneOf ?? []).map((v) => v.$ref ?? JSON.stringify(v));
  if (variants.join("|") !== [JSON.stringify({ type: "null" }), JSON.stringify({ type: "object", additionalProperties: false, required: ["exists"], properties: { exists: { type: "boolean", enum: [false] } } }), "#/components/schemas/TaskRelease"].join("|")) problems.push("TaskReleaseStatus.release: must be null, { exists: false } or a TaskRelease");
  if (shown?.properties?.served?.type !== "boolean" || JSON.stringify(shown?.properties?.result_url?.type) !== JSON.stringify(["string", "null"]) || shown?.properties?.exists?.enum?.join() !== "true" || shown?.additionalProperties !== false) problems.push("TaskRelease: must say served as a boolean and result_url as a string or null, apart from its state");
  if (shown?.properties?.commit_sha?.pattern !== "^[0-9a-f]{40}$") problems.push("TaskRelease.commit_sha: must be 40 lower-case hexadecimal characters");
  if (shown?.properties?.state?.enum?.includes("live") || core.releaseStatusStates.includes("live")) problems.push("TaskRelease.state: the status never says live; live-ness is `served` alone");
}
if (api.components.schemas.Release?.properties?.commit_sha?.pattern !== "^[0-9a-f]{40}$") problems.push("Release.commit_sha: must be 40 lower-case hexadecimal characters");
for (const [what, text] of [["approval policy", `approval_policy = '${core.approvalPolicies.join()}'`], ["environment", `environment = '${core.environment}'`], ["release ID's prefix", `id GLOB '${core.releaseIdPrefix}*'`], ["release ID's length", `length(id) = ${core.idLen}`], ["label's length", `length(label) BETWEEN 1 AND ${core.maxLabelLen}`]]) {
  if (!store.includes(text)) problems.push(`the room's tables don't hold the ${what} as core has it: ${text}`);
}
if (core.maxLabelLen + 1 + core.idLen !== core.maxScriptNameLen) problems.push("core: a label, a separator and an ID no longer make the longest script name");
for (const [at, expected] of Object.entries(releaseEnums)) {
  const [schema, field] = at.split(".");
  if (api.components.schemas[schema]?.properties?.[field]?.enum?.join() !== expected) problems.push(`${at}: must be exactly ${expected}`);
}
// The owner's words for an app's data deleted (2026-11-17) are core's one constant, and each command that deletes says
// them exactly, so a reader of the contract is told what a person is told.
for (const id of ["deleteAppData", "deleteAppDataAsOperator"]) {
  if (!operations.get(id)?.op.summary?.includes(core.dataDeletedNotice)) problems.push(`${id}: its summary must carry the owner's words exactly: ${core.dataDeletedNotice}`);
}
if (api.components.schemas.ReleaseConfig?.properties?.environments?.items?.enum?.join() !== core.environment || api.components.schemas.ReleaseConfig?.properties?.environments?.maxItems !== 1) problems.push("ReleaseConfig.environments: must be exactly one, production");
// A release's ID is the repository's ID form, and an app's label is at most 26 lower-case letters and digits, so a script's
// name, the label, a `.` and the ID, is at most 63 characters (ADR 0010, "Script names").
const idPattern = `^${core.releaseIdPrefix}[0-9a-f]{${core.idLen - core.releaseIdPrefix.length}}$`;
if (api.components.schemas.Release?.properties?.id?.pattern !== idPattern) problems.push(`Release.id: must be ${idPattern}`);
// M6 step 10(b): what awaits approval is exactly core's awaiting state, named by the release's own ID and commit forms.
{
  const approval = api.components.schemas.ReleaseApproval?.properties;
  if (approval?.state?.enum?.join() !== "awaiting_approval" || !core.releaseStates.includes("awaiting_approval")) problems.push("ReleaseApproval.state: must be exactly core's awaiting_approval");
  if (approval?.id?.pattern !== idPattern || approval?.commit_sha?.pattern !== "^[0-9a-f]{40}$") problems.push("ReleaseApproval: its ID and commit must have the release's forms");
}
for (const id of ["approveRelease", "declineRelease"]) {
  if (operations.get(id)?.path && api.paths[operations.get(id).path].parameters?.find((p) => p.name === "release")?.schema?.pattern !== idPattern) problems.push(`${id}: its release parameter must be ${idPattern}`);
}
if (api.components.parameters.appLabel?.schema?.pattern !== `^[a-z0-9]{1,${core.maxLabelLen}}$`) problems.push(`appLabel: must be at most ${core.maxLabelLen} lower-case letters and digits`);
// M8 step 3 named fields that later steps build. Each is in its schema's properties and not yet required, so the contract
// never says the API answers a field it doesn't; the step that builds one takes it off this list and makes it required.
const PENDING = {
  ReleaseApproval: ["from_preview", "build_id", "preview_served_at"], // M8 step 9
};
for (const [schema, names] of Object.entries(PENDING)) {
  const found = api.components.schemas[schema];
  for (const name of names) {
    if (!found?.properties?.[name]) problems.push(`${schema}.${name}: pending, but not in its properties`);
    if (found?.required?.includes(name)) problems.push(`${schema}.${name}: required, so take it off PENDING`);
    if (!/\*\*not built/i.test(`${found?.properties?.[name]?.description ?? ""}`)) problems.push(`${schema}.${name}: pending, so its description must say it isn't built`);
  }
}
for (const schema of ["ReleaseConfig", "SetReleaseConfig", "Release", "ReleaseApproval", "ReleaseApprovalList", "AppHostnameRequest", "AppHostname", "SetAppHostname"]) {
  const found = api.components.schemas[schema];
  if (found?.additionalProperties !== false) problems.push(`${schema}: isn't closed`);
  const named = Object.keys(found?.properties ?? {}).filter((name) => !(PENDING[schema] ?? []).includes(name));
  if ((found?.required ?? []).slice().sort().join() !== named.sort().join()) problems.push(`${schema}: must require exactly its properties`);
}

// Previews (M8 step 3: the preview plan's section 9, ADR 0010's revision on previews, decisions 250 to 259). The contract
// only: every operation is a person's (decision 253), names only what its path may, and says it isn't built and what it
// answers until it is, or, for the three M8 step 6 built, that it is built behind the switch and what it answers while off. No capability reaches one (the check on capabilities above refuses `preview`), and a preview's
// states are core's release states, never awaiting approval or declined, since a preview is queued when asked.
const previewOperations = { getPreview: "ws", requestPreview: "ws,t", deletePreview: "ws", getPreviewHostname: "ws", requestPreviewHostname: "ws", removePreviewHostname: "ws", checkPreviewHostname: "ws", requestPreviewAccess: "" };
for (const [id, params] of Object.entries(previewOperations)) {
  const found = operations.get(id);
  if (!found) { problems.push(`${id}: the preview operation is missing`); continue; }
  if ([...found.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).join() !== params) problems.push(`${id}: its path may name only ${params || "nothing"}`);
  if (!personOnly.includes(id)) problems.push(`${id}: must be person_only (decision 253)`);
  // M8 step 6 built the room's preview, read, asked for and deleted, which the room itself answers behind the switch.
  const previewBuilt = ["getPreview", "requestPreview", "deletePreview"].includes(id);
  if (previewBuilt ? found.op.summary?.includes("Not built") || !found.op.summary?.includes("Built behind the switch") || !found.op.summary?.includes("`not_found`") : !found.op.summary?.includes("**Not built (M8 step") || !found.op.summary?.includes("`not_found`")) problems.push(`${id}: its summary must say ${previewBuilt ? "it is built behind the switch, and not that it isn't, and what it answers while release is off (`not_found`)" : "it isn't built, and that it answers `not_found` until it is"}`);
  // While previews are off the room answers who first, as release switched off does; deleting and removing pass no gate,
  // and the access route asks no room.
  if (!["deletePreview", "removePreviewHostname", "requestPreviewAccess"].includes(id) && !found.op.summary?.includes("**`previews_off` comes after who is asking,**")) problems.push(`${id}: its summary must say \`previews_off\` comes after who is asking`);
  if (!found.op.summary?.includes("never an agent") && !found.op.summary?.includes("every agent") && !found.op.summary?.includes("Never an agent")) problems.push(`${id}: its summary must say no agent may`);
  // Each command but the access ticket keeps an idempotency key; a ticket is never stored for a replay.
  const hasKey = (found.op.parameters ?? []).some((p) => p.$ref?.endsWith("/idempotencyKey"));
  if (found.method !== "get" && hasKey !== (id !== "requestPreviewAccess")) problems.push(`${id}: ${hasKey ? "takes" : "lacks"} an idempotency key`);
}
for (const schema of ["RoomPreview", "Preview", "PreviewHostnameView", "PreviewRelease", "RequestPreview", "PreviewAccessRequest", "PreviewAccess", "ApproveRelease", "TaskPreview"]) {
  const found = api.components.schemas[schema];
  if (found?.additionalProperties !== false) problems.push(`${schema}: isn't closed`);
  if ((found?.required ?? []).slice().sort().join() !== Object.keys(found?.properties ?? {}).sort().join()) problems.push(`${schema}: must require exactly its properties`);
}
{
  const schemas = api.components.schemas;
  const without = (set) => set.filter((state) => state !== "awaiting_approval" && state !== "declined").join();
  if (schemas.PreviewRelease?.properties?.state?.enum?.join() !== without(core.releaseStates)) problems.push(`PreviewRelease.state: must be exactly core's ${without(core.releaseStates)}`);
  if (schemas.TaskPreview?.properties?.state?.enum?.join() !== without(core.releaseStatusStates)) problems.push(`TaskPreview.state: must be exactly core's ${without(core.releaseStatusStates)}`);
  const buildId = "^bld_[0-9a-f]{32}$";
  for (const [at, pattern] of [["PreviewRelease.build_id", schemas.PreviewRelease?.properties?.build_id?.pattern], ["ApproveRelease.build", schemas.ApproveRelease?.properties?.build?.pattern], ["ReleaseApproval.build_id", schemas.ReleaseApproval?.properties?.build_id?.pattern]]) {
    if (pattern !== buildId) problems.push(`${at}: must be ${buildId}`);
  }
  for (const at of ["PreviewRelease.id", "TaskPreview.release_id", "RequestRelease.from_preview", "ReleaseApproval.from_preview"]) {
    const [schema, field] = at.split(".");
    if (schemas[schema]?.properties?.[field]?.pattern !== idPattern) problems.push(`${at}: must be ${idPattern}`);
  }
  for (const at of ["PreviewRelease.commit_sha", "TaskPreview.commit_sha", "RequestPreview.commit_sha"]) {
    const [schema, field] = at.split(".");
    if (schemas[schema]?.properties?.[field]?.pattern !== "^[0-9a-f]{40}$") problems.push(`${at}: must be 40 lower-case hexadecimal characters`);
  }
  // Everyone who may view reads getPreview, so its custom hostname is the name and setup status only: setup facts stay on
  // the owner's and admins' getPreviewHostname, as production's do on getAppHostname (widening them is the owner's ruling).
  if (schemas.Preview?.properties?.custom_host?.oneOf?.[0]?.$ref !== "#/components/schemas/PreviewHostnameView" || Object.keys(schemas.PreviewHostnameView?.properties ?? {}).join() !== "hostname,setup_status") problems.push("Preview.custom_host: viewers may see only the hostname and setup_status (PreviewHostnameView)");
  if (schemas.PreviewHostnameView?.properties?.setup_status?.enum?.join() !== schemas.AppHostnameRequest?.properties?.setup_status?.enum?.join()) problems.push("PreviewHostnameView.setup_status: must be exactly AppHostnameRequest.setup_status");
  if (operations.get("getPreviewHostname")?.op?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/AppHostname") problems.push("getPreviewHostname: must answer the full AppHostname, for owners and admins");
  // What an agent reads of a preview is its state and commit: never a host, a label or a link (the plan's 9.2).
  if (Object.keys(schemas.TaskPreview?.properties ?? {}).join() !== "exists,release_id,commit_sha,state,observed_at,failure_code,served") problems.push("TaskPreview: must hold exactly exists, release_id, commit_sha, state, observed_at, failure_code and served, and never a host or a link");
  const preview = schemas.TaskReleaseStatus?.properties?.preview;
  const shapes = (preview?.oneOf ?? []).map((v) => v.$ref ?? JSON.stringify(v));
  if (shapes.join("|") !== [JSON.stringify({ type: "null" }), JSON.stringify({ type: "object", additionalProperties: false, required: ["exists"], properties: { exists: { type: "boolean", enum: [false] } } }), "#/components/schemas/TaskPreview"].join("|")) problems.push("TaskReleaseStatus.preview: must be null, { exists: false } or a TaskPreview");
  // The access request takes exactly the host, the state's hash and the return path, each required: only the preview host
  // starts a flow, so no `st` is `invalid_argument`.
  const access = schemas.PreviewAccessRequest?.properties;
  if (Object.keys(access ?? {}).join() !== "host,st,r" || access?.st?.pattern !== "^[A-Za-z0-9_-]{43}$") problems.push("PreviewAccessRequest: must take exactly host, st (a base64url SHA-256) and r");
  // A preview is optional before publishing (decision 254), so a release's request doesn't need one, and the approval's
  // body is optional, required by the room only for a release made from a preview.
  if (schemas.RequestRelease?.required?.includes("from_preview")) problems.push("RequestRelease.from_preview: must be optional (decision 254)");
  const approve = operations.get("approveRelease")?.op;
  if (approve?.requestBody?.required !== false || approve?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ApproveRelease") problems.push("approveRelease: its body must be the optional ApproveRelease");
}
// The serve entries' preview form (the plan's 3.1): its mark, the slot's ID, the epoch's grammar, and vectors that cross, so a
// production host never reads a preview entry and a preview host never reads a production one.
{
  const fixture = JSON.parse(readFileSync(new URL("serve-entry.fixture.json", import.meta.url), "utf8"));
  if (fixture.preview_mark !== "preview:") problems.push("serve-entry.fixture.json: the preview mark must be preview:");
  const epoch = new RegExp(fixture.preview_epoch_pattern ?? "$^");
  // M8 step 4's security review: the entry names its preview slot, so a token for one slot is never honoured on a host
  // a later slot holds. The ID is `podster_core::preview::is_slot_id`'s form.
  const slot = new RegExp(fixture.preview_slot_pattern ?? "$^");
  if (fixture.preview_slot_pattern !== "^pvw_[0-9a-f]{32}$" || slot.test("pvw_0123456789ABCDEF0123456789abcdef")) problems.push("serve-entry.fixture.json: the preview slot's ID must be pvw_ and 32 lower-case hexadecimal characters");
  // The largest epoch the pattern takes must be exact as a JavaScript number, and the next digit count refused.
  if (!epoch.test("0") || epoch.test("01") || epoch.test("-1") || !epoch.test("9".repeat(15)) || epoch.test("1".repeat(16))) problems.push("serve-entry.fixture.json: the epoch must be 0 or an unpadded decimal of at most 15 digits");
  const missing = (values, lists) => values.filter((value) => !lists.some((list) => (fixture[list] ?? []).includes(value)));
  const crosses = [
    [fixture.valid_preview_entries, ["invalid_script_names", "invalid_code_entries"], "a valid preview entry a production default host might read"],
    [fixture.valid_preview_custom_entries, ["invalid_custom_entries", "invalid_code_custom_entries"], "a valid preview custom entry a production custom host might read"],
    [[...fixture.valid_script_names, ...fixture.valid_code_entries], ["invalid_preview_entries"], "a valid production default entry a preview host might read"],
    [[...fixture.valid_custom_entries, ...fixture.valid_code_custom_entries], ["invalid_preview_custom_entries"], "a valid production custom entry a preview custom host might read"],
  ];
  for (const [values, lists, what] of crosses) {
    if (!values?.length) problems.push(`serve-entry.fixture.json: no vectors for ${what}`);
    for (const value of missing(values ?? [], lists)) problems.push(`serve-entry.fixture.json: ${JSON.stringify(value)} is ${what}, and isn't in ${lists.join(" or ")}`);
  }
  for (const value of [...(fixture.valid_preview_entries ?? []), ...(fixture.valid_preview_custom_entries ?? [])]) {
    const [pvw, ep] = value.slice(fixture.preview_mark.length).split(":");
    if (!value.startsWith(fixture.preview_mark) || !slot.test(pvw ?? "") || !epoch.test(ep ?? "") || !Number.isSafeInteger(Number(ep))) problems.push(`serve-entry.fixture.json: ${JSON.stringify(value)} isn't the mark, a slot's ID and an exact epoch`);
  }
}

// `Error.code` lists exactly the codes error-codes.mjs's scan finds in the REST error body of the API and the gateway.
// Not OAuth's `error`, MCP or JSON-RPC errors, A2A's own errors, Agent Auth's own error body, or a code built at run
// time. These are left out, each with why and the sites (`path#function`, with how many uses) allowed to answer it; a
// use anywhere else, or one more in a pinned function, fails:
const INTERNAL_ONLY = {
  already_sent: {
    why: "the room's answer to the A2A worker's own finish call",
    sites: { "apps/api/src/workspace/a2a_out.rs#finish": 1 },
  },
  scan_mismatch: {
    why: "the room's answer to the scanner's verdict call",
    sites: { "apps/api/src/workspace/objects.rs#record_verdict": 1 },
  },
  unavailable: {
    why: "a person's or an agent's object answering four internal routes, /internal/repo-request-reserve, /internal/departed, /internal/a2a-endpoint-report and /internal/check's read-only connection read, and only in test builds, where the failpoints feature makes it",
    sites: { "apps/api/src/principal.rs#Principal::dispatch": 4 },
  },
};
/**
 * Gateway routes whose answers aren't the contract's `Error` for a caller it describes. Each pins the codes it answers,
 * so a new one changes this list; a surface that's gone or makes no error any more fails too.
 */
const EXCLUDED_SURFACES = {
  "apps/gateway/src/github-webhook.ts": {
    why: "GitHub's webhook deliveries: the caller is GitHub, which reads only the status",
    codes: ["body_too_large", "event_not_used", "invalid_delivery", "invalid_payload", "invalid_signature", "method_not_allowed", "not_found", "upstream_unavailable"],
  },
  "apps/gateway/src/a2a/": {
    why: "the A2A endpoint, with its own error profile",
    codes: ["method_not_allowed", "payload_too_large"],
  },
};
const errorCodes = new Set(api.components.schemas.Error?.properties?.error?.properties?.code?.enum ?? []);
const found = collectErrorCodes(readSources(new URL("../../", import.meta.url).pathname), EXCLUDED_SURFACES);
problems.push(...found.problems, ...compareWithEnum(errorCodes, found, INTERNAL_ONLY), ...compareExcluded(EXCLUDED_SURFACES, found));
const apart = [...found.excluded.keys()].filter((code) => !found.codes.has(code));

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`${Object.keys(capabilities).length} capabilities match ${operations.size} operations; Error.code lists the ${errorCodes.size} codes the scan found in the REST error body (not OAuth's, MCP's, JSON-RPC's, A2A's or Agent Auth's, and not codes built at run time; error-codes.mjs lists what the scan can't see); ${Object.keys(INTERNAL_ONLY).length} internal-only codes, each at its pinned sites, and ${apart.length} answered only on excluded surfaces (${apart.join(", ")}) are left out, and each excluded surface answers exactly its pinned codes`);
