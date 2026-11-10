// Checks that capabilities map to API operations, and that the CQRS sides agree.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const api = parse(readFileSync(new URL("openapi.yaml", import.meta.url), "utf8"));
const { capabilities, person_only: personOnly = [], transfer_only: transferOnly = [] } = parse(readFileSync(new URL("capabilities.yaml", import.meta.url), "utf8"));

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
for (const id of operations.keys()) if (!covered.has(id) && !personOnly.includes(id) && !transferOnly.includes(id)) problems.push(`${id}: operation with no capability`);

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
for (const schema of ["RepoRequest", "RepoLink", "RoomRepository"]) {
  if (api.components.schemas[schema]?.additionalProperties !== false) problems.push(`${schema}: isn't closed`);
}

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`${Object.keys(capabilities).length} capabilities match ${operations.size} operations`);
