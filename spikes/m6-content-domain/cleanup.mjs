#!/usr/bin/env node
// Spike only. Lists every resource this spike may have made, and with --delete removes them, then lists again.
// It only ever touches names starting spike-m6-c- and routes whose script is spike-m6-c-dispatch.
// Left in place on purpose: the namespace itself and the owner's wildcard DNS record, which aren't this spike's.
import { DISPATCH, accountScript, deleteAccountScript, deleteRoute, deleteScript, isSpikeName, namespaceScripts, record, zoneRoutes } from "./lib.mjs";

const doDelete = process.argv.includes("--delete");
if (process.argv.includes("--help")) {
  console.log("usage: node cleanup.mjs [--delete]   (without --delete it only lists)");
  process.exit(0);
}

async function inventory() {
  const ns = await namespaceScripts();
  const routes = await zoneRoutes();
  const dispatch = await accountScript(DISPATCH);
  return {
    namespaceScripts: { status: ns.status, errors: ns.errors, spike: ns.names.filter(isSpikeName), others: ns.names.filter((n) => !isSpikeName(n)).length },
    routes: { status: routes.status, errors: routes.errors, spike: routes.routes.filter((r) => r.script === DISPATCH), others: routes.routes.filter((r) => r.script !== DISPATCH).length },
    dispatchWorker: { status: dispatch.status, exists: dispatch.status === 200 },
  };
}

const before = await inventory();
console.log(JSON.stringify({ before }, null, 2));
if (!doDelete) process.exit(0);

const done = [];
for (const route of before.routes.spike) {
  const r = await deleteRoute(route.id);
  done.push({ kind: "route", id: route.id, status: r.status });
  record({ action: r.status === 200 ? "deleted" : "delete-failed", kind: "route", name: route.pattern, id: route.id });
}
for (const name of before.namespaceScripts.spike) {
  const r = await deleteScript(name);
  done.push({ kind: "namespace script", name, status: r.status });
  record({ action: r.status === 200 ? "deleted" : "delete-failed", kind: "namespace script", name });
}
if (before.dispatchWorker.exists) {
  const r = await deleteAccountScript(DISPATCH);
  done.push({ kind: "worker", name: DISPATCH, status: r.status });
  record({ action: r.status === 200 ? "deleted" : "delete-failed", kind: "worker", name: DISPATCH });
}
const after = await inventory();
const clean = after.namespaceScripts.spike.length === 0 && after.routes.spike.length === 0 && !after.dispatchWorker.exists;
console.log(JSON.stringify({ deleted: done, after, clean }, null, 2));
process.exit(clean ? 0 : 1);
