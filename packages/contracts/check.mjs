// Checks the contract against itself and the code: capabilities map to API operations and the CQRS sides agree, the
// public view and the managed-repository operations keep their shapes, and `Error.code` equals the error codes a text
// scan of the API and the gateway finds (error-codes.mjs, which says what that scan can't see).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { columnCheck, coreSets } from "./core-sets.mjs";
import { collectErrorCodes, compareExcluded, compareWithEnum, readSources } from "./error-codes.mjs";
import { promptWrites, provenanceInRequests } from "./provenance-checks.mjs";

const api = parse(readFileSync(new URL("openapi.yaml", import.meta.url), "utf8"));
const { capabilities, person_only: personOnly = [], transfer_only: transferOnly = [], provider_only: providerOnly = [], a2a = {} } = parse(readFileSync(new URL("capabilities.yaml", import.meta.url), "utf8"));

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
  // A provider's delivery carries its own assertion, never an identity's, and its delivery ID stands in for an idempotency key.
  if (!operations.get(id)?.op.security?.some((s) => "providerDelivery" in s)) problems.push(`${id}: provider_only without the delivery assertion`);
}
for (const id of operations.keys()) if (!covered.has(id) && !personOnly.includes(id) && !transferOnly.includes(id) && !providerOnly.includes(id)) problems.push(`${id}: operation with no capability`);
// Only a provider_only operation takes the delivery assertion.
for (const [id, { op }] of operations) if (op.security?.some((s) => "providerDelivery" in s) && !providerOnly.includes(id)) problems.push(`${id}: takes the delivery assertion but isn't provider_only`);

// The gateway's own dashboard routes for an organization's people. They never reach the API, so they aren't capabilities.
const organizations = parse(readFileSync(new URL("organizations.yaml", import.meta.url), "utf8"));
for (const [path, item] of Object.entries(organizations.paths)) {
  if (!path.startsWith("/api/")) problems.push(`organizations.yaml: ${path} isn't a dashboard route`);
  for (const method of ["get", "post", "put", "delete"]) {
    const id = item[method]?.operationId;
    if (id && operations.has(id)) problems.push(`organizations.yaml: ${id} is also an API operation`);
  }
}

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
if (api.components.schemas.RepoGrant?.properties?.action?.enum?.join() !== "push,merge") problems.push("RepoGrant.action: must be exactly push,merge");
for (const schema of ["RepoRequest", "RepoLink", "RoomRepository", "RepoGrant", "RepoGrantList"]) {
  if (api.components.schemas[schema]?.additionalProperties !== false) problems.push(`${schema}: isn't closed`);
}

// Release (M6 step 2, ADR 0010): the contract and the state only. Every operation is a person's or an operator's, and
// names only what its path may. One capability reaches one, since 6g: `deploy_release`, an agent's request for a
// release, reaches `requestRelease` and nothing else. Anything else that names a release or a deployment is in no
// agent's list (AC-17).
const AGENT_RELEASE = { capability: "deploy_release", operation: "requestRelease" };
const releaseOperations = {
  getReleaseConfig: "ws", setReleaseConfig: "ws", listReleaseApprovals: "ws", requestRelease: "ws", approveRelease: "ws,release", declineRelease: "ws,release", rollbackRelease: "ws,release", getAppHostname: "ws", requestAppHostname: "ws", removeAppHostname: "ws",
  deleteAppData: "ws,label", deleteAppDataAsOperator: "label",
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
    // Step 6 built a person's request for a release, which the room itself answers.
    // Step 6's 6f built approving and declining one, and 6h asking to roll back, which the room itself answers.
    // S4 of the store plan built deleting an app's data, the owner's (which the room itself answers) and an operator's.
    const built = ["requestRelease", "approveRelease", "declineRelease", "rollbackRelease", "listReleaseApprovals", "suspendApp", "liftAppSuspension", "stopContentDomain", "resumeContentDomain", "listTakedownFindings", "createAppReport", "getReleaseDelegation", "setReleaseDelegation", "getReleaseConfig", "setReleaseConfig", "getAppHostname", "requestAppHostname", "removeAppHostname", "deleteAppData", "deleteAppDataAsOperator"].includes(id);
    if (!found.op.summary?.includes("`not_found`")) problems.push(`${id}: its summary must say what it answers while release is switched off`);
    // Asking for a custom hostname is built but gated: until claims are complete (8b and 8d), a deployment with release
    // and a provider answers it `release_not_available`, and its summary must say exactly when. So is asking for a
    // release, and approving one, until the release path is complete (`RELEASE_PATH_COMPLETE`). Declining only takes
    // away and passes no gate, so its summary may not name `release_not_available` at all.
    const gates = { requestAppHostname: "**Until custom hostname claims are complete**", requestRelease: "**Until the release path is complete**", approveRelease: "**Until the release path is complete**", rollbackRelease: "**Until the release path is complete**" };
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
  if (/deploy|release[-_]?config|app[-_]?host|content[-_]?domain/i.test(`${name} ${cap.operation} ${found?.path ?? ""}`) || /\/releases(\/|$)/.test(found?.path ?? "") || releaseOperations[cap.operation] !== undefined) problems.push(`${name}: no capability but ${AGENT_RELEASE.capability} may reach a release, a deployment or an app's hosts`);
}
// The closed sets are `crates/core`'s, never restated here: core-sets.mjs reads them from its source, and the contract's
// enums and the room's column checks must each equal them, value for value and in core's order. So a state, a trigger or
// a policy added to the rules fails this until the contract and a new migration say the same.
const root = new URL("../../", import.meta.url);
const core = coreSets(root);
const releaseEnums = {
  "ReleaseConfig.approval_policy": core.approvalPolicies.join(), "Release.environment": core.environment, "Release.state": core.releaseStates.join(), "TaskRelease.state": core.releaseStatusStates.join(),
  "AppHostnameRequest.state": core.hostnameRequestStates.join(),
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
for (const schema of ["ReleaseConfig", "SetReleaseConfig", "Release", "ReleaseApproval", "ReleaseApprovalList", "AppHostnameRequest", "AppHostname", "SetAppHostname"]) {
  const found = api.components.schemas[schema];
  if (found?.additionalProperties !== false) problems.push(`${schema}: isn't closed`);
  if ((found?.required ?? []).slice().sort().join() !== Object.keys(found?.properties ?? {}).sort().join()) problems.push(`${schema}: must require exactly its properties`);
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
