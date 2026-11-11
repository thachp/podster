// Checks that capabilities map to API operations, and that the CQRS sides agree.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { collectErrorCodes, compareWithEnum, readSources } from "./error-codes.mjs";

const api = parse(readFileSync(new URL("openapi.yaml", import.meta.url), "utf8"));
const { capabilities, person_only: personOnly = [], transfer_only: transferOnly = [], provider_only: providerOnly = [] } = parse(readFileSync(new URL("capabilities.yaml", import.meta.url), "utf8"));

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

// `Error.code` lists exactly the codes the API and the gateway can answer a caller with in the REST error body,
// collected by error-codes.mjs. Not OAuth's `error`, MCP or JSON-RPC errors, A2A's own errors, or a code built at run
// time. These are left out, each with why:
const INTERNAL_ONLY = {
  already_sent: "the room's answer to the A2A worker's own finish call (apps/api/src/workspace/a2a_out.rs)",
  scan_mismatch: "the room's answer to the scanner's verdict call (apps/api/src/workspace/objects.rs)",
  unavailable: "a person's object answering three internal routes, /internal/repo-request-reserve, /internal/departed and /internal/a2a-endpoint-report, and only in test builds, where the failpoints feature makes it (apps/api/src/principal.rs)",
};
/** Gateway routes whose answers aren't the contract's `Error` for a caller it describes. Their codes are listed apart. */
const EXCLUDED_SURFACES = {
  "apps/gateway/src/github-webhook.ts": "GitHub's webhook deliveries: the caller is GitHub, which reads only the status",
  "apps/gateway/src/a2a/": "the A2A endpoint, with its own error profile",
};
const errorCodes = new Set(api.components.schemas.Error?.properties?.error?.properties?.code?.enum ?? []);
const found = collectErrorCodes(readSources(new URL("../../", import.meta.url).pathname), EXCLUDED_SURFACES);
problems.push(...found.problems, ...compareWithEnum(errorCodes, found, INTERNAL_ONLY));
const apart = [...found.excluded.keys()].filter((code) => !found.codes.has(code));

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`${Object.keys(capabilities).length} capabilities match ${operations.size} operations; Error.code lists the ${errorCodes.size} codes the REST error body can carry (not OAuth's, MCP's, JSON-RPC's or A2A's, and not codes built at run time); ${Object.keys(INTERNAL_ONLY).length} internal-only codes and ${apart.length} on excluded surfaces (${apart.join(", ")}) are left out`);
