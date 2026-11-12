// Offline: `node --test spikes/m6-namespace-app/guard.test.mjs`. It runs no wrangler command and makes no request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAMESPACE, guard, deleteArgument } from "./guard.mjs";

test("a spike name in the staging namespace is accepted", () => {
  assert.equal(guard("spike-m6-a1", NAMESPACE), "spike-m6-a1");
  assert.equal(deleteArgument("spike-m6-a1", NAMESPACE), "../dispatch/namespaces/podster-staging-apps/scripts/spike-m6-a1");
});

test("a name that could leave the namespace's scripts is refused", () => {
  for (const name of ["spike-m6-../x", "../x", "podster-api-staging", "spike-m6-A", "spike-m6-a.b", "spike-m6-a%2f", "spike-m6-", `spike-m6-${"a".repeat(51)}`, "spike-m6-a\n", "", undefined]) {
    assert.throws(() => guard(name, NAMESPACE), /refusing a script name/, String(name));
    assert.throws(() => deleteArgument(name, NAMESPACE), /refusing a script name/, String(name));
  }
});

test("another namespace is refused, whatever the name", () => {
  for (const namespace of ["podster-production-apps", "podster-staging-apps/..", "PODSTER-STAGING-APPS", "", undefined]) {
    assert.throws(() => guard("spike-m6-a1", namespace), /refusing a namespace/);
    assert.throws(() => deleteArgument("spike-m6-a1", namespace), /refusing a namespace/);
  }
});
