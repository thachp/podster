import { test } from "node:test";
import assert from "node:assert/strict";
import { allow, folded, spikeHostname } from "./guard.mjs";

const zone = "a".repeat(32);
const account = "b".repeat(32);
const id = "0e2d5a7f-1548-4f27-8c05-b577cb14f4ec";
const ctx = { zone, account, made: new Set([id]) };
const API = "https://api.cloudflare.com/client/v4";
const create = (hostname, ssl = { method: "http", type: "dv" }) => JSON.stringify({ hostname, ssl });

test("a GET goes anywhere on the API, and nowhere else", () => {
  allow("GET", `${API}/zones/${zone}/custom_hostnames?hostname=x`, null, ctx);
  assert.throws(() => allow("GET", "https://example.com/client/v4/x", null, ctx));
});

test("a create only for a spike name, with exactly the spike's ssl", () => {
  allow("POST", `${API}/zones/${zone}/custom_hostnames`, create("spike.opster.dev"), ctx);
  allow("POST", `${API}/zones/${zone}/custom_hostnames`, create("spike-dot.opster.dev."), ctx);
  assert.throws(() => allow("POST", `${API}/zones/${zone}/custom_hostnames`, create("podster.dev"), ctx));
  assert.throws(() => allow("POST", `${API}/zones/${zone}/custom_hostnames`, create("evil.example.com"), ctx));
  assert.throws(() => allow("POST", `${API}/zones/${zone}/custom_hostnames`, create("spike.opster.dev", { method: "txt", type: "dv" }), ctx));
  const extra = JSON.stringify({ hostname: "spike.opster.dev", ssl: { method: "http", type: "dv" }, custom_origin_server: "x" });
  assert.throws(() => allow("POST", `${API}/zones/${zone}/custom_hostnames`, extra, ctx));
  assert.throws(() => allow("POST", `${API}/zones/${zone}/custom_hostnames?x=1`, create("spike.opster.dev"), ctx));
  assert.throws(() => allow("POST", `${API}/zones/${zone}/custom_hostnames`, create("spike.opster.dev"), { ...ctx, zone: "short" }));
});

test("a delete only for a custom hostname the spike made", () => {
  allow("DELETE", `${API}/zones/${zone}/custom_hostnames/${id}`, null, ctx);
  assert.throws(() => allow("DELETE", `${API}/zones/${zone}/custom_hostnames/11111111-1548-4f27-8c05-b577cb14f4ec`, null, ctx));
  assert.throws(() => allow("PATCH", `${API}/zones/${zone}/custom_hostnames/${id}`, "{}", ctx));
  assert.throws(() => allow("DELETE", `${API}/zones/${zone}/custom_hostnames/fallback_origin`, null, ctx));
  assert.throws(() => allow("DELETE", `${API}/zones/${zone}/dns_records/${id}`, null, ctx));
});

test("a script only by the spike's name, on the second account", () => {
  allow("PUT", `${API}/accounts/${account}/workers/scripts/spike-hostnames-abc-doh`, "x", ctx);
  allow("POST", `${API}/accounts/${account}/workers/scripts/spike-hostnames-abc-doh/subdomain`, "{}", ctx);
  allow("DELETE", `${API}/accounts/${account}/workers/scripts/spike-hostnames-abc-doh`, null, ctx);
  assert.throws(() => allow("PUT", `${API}/accounts/${account}/workers/scripts/podster-content`, "x", ctx));
  assert.throws(() => allow("PUT", `${API}/accounts/${account}/workers/scripts/spike-hostnames-abc/settings`, "x", ctx));
  assert.throws(() => allow("PUT", `${API}/accounts/${"c".repeat(32)}/workers/scripts/spike-hostnames-abc`, "x", ctx));
});

test("a listing's entry counts as the spike's only under a spike name", () => {
  assert.equal(folded("Spike-Case.Opster.Dev"), "spike-case.opster.dev");
  assert.ok(spikeHostname("spike-case.opster.dev"));
  assert.ok(spikeHostname("spike-dot.opster.dev"));
  assert.ok(!spikeHostname("other.opster.dev"));
});
