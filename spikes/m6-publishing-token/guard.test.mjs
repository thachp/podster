// Offline: `node --test spikes/m6-publishing-token/guard.test.mjs`. It makes no request and reads no token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAMESPACE, allow, allowedName } from "./guard.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef"; // made up
const API = "https://api.cloudflare.com/client/v4";
const account = `${API}/accounts/${ACCOUNT}`;
const inNamespace = `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`;
const atAccount = `${account}/workers/scripts`;
const WRITES = ["PUT", "POST", "PATCH", "DELETE"];

test("writes to a spike script are allowed, in the namespace and at account level", () => {
  for (const base of [inNamespace, atAccount]) {
    assert.equal(allow("PUT", `${base}/spike-m6-b-canary`, ACCOUNT), `${base}/spike-m6-b-canary`);
    assert.ok(allow("DELETE", `${base}/spike-m6-b-new-edit`, ACCOUNT));
    assert.ok(allow("DELETE", `${base}/spike-m6-b-new-edit?force=true`, ACCOUNT));
  }
  assert.ok(allow("POST", `${inNamespace}/spike-m6-b-edit/assets-upload-session`, ACCOUNT));
});

test("no write reaches one of Podster's Workers, or anything that isn't a script", () => {
  const targets = [
    `${atAccount}/podster-api-staging`,
    `${atAccount}/podster-gateway-staging`,
    `${atAccount}/podster-web-staging`,
    `${atAccount}/podster-api-staging/secrets`,
    `${atAccount}/podster-api-staging/settings`,
    `${atAccount}/podster-api-staging/content`,
    `${inNamespace}/podster-api-staging`,
    `${atAccount}/spike-m6-b-canary/secrets`,
    `${atAccount}/spike-m6-b-canary/settings`,
    `${atAccount}/spike-m6-b-canary/subdomain`,
    `${atAccount}/spike-m6-b-canary/schedules`,
    `${atAccount}/spike-m6-b-canary/tails`,
    `${atAccount}/spike-m6-a-site`,
    `${atAccount}/spike-m6-dispatch`,
    `${atAccount}/spike-m6-b-`,
    `${atAccount}/spike-m6-b-${"a".repeat(41)}`,
    `${atAccount}/spike-m6-b-A`,
    `${atAccount}/spike-m6-b-a.b`,
    `${atAccount}/spike-m6-b-a_b`,
    `${atAccount}/`,
    `${atAccount}`,
    `${account}/workers/dispatch/namespaces/${NAMESPACE}`,
    `${account}/workers/dispatch/namespaces`,
    `${account}/workers/dispatch/namespaces/podster-production-apps/scripts/spike-m6-b-x`,
    `${account}/workers/dispatch/namespaces/PODSTER-STAGING-APPS/scripts/spike-m6-b-x`,
    `${account}/workers/subdomain`,
    `${account}/workers/assets/upload`,
    `${account}/d1/database`,
    `${account}/d1/database/spike-m6-b-x`,
    `${account}/storage/kv/namespaces`,
    `${account}/queues`,
    `${account}/r2/buckets`,
    `${account}/r2/buckets/spike-m6-b-x`,
    `${account}/tokens`,
    `${API}/zones/${ACCOUNT}/workers/routes`,
    `${API}/zones/${ACCOUNT}/dns_records`,
    `${API}/zones/${ACCOUNT}/custom_hostnames`,
    `${API}/user/tokens`,
    `${API}/user/tokens/spike-m6-b-x`,
    `${API}/accounts/ffffffffffffffffffffffffffffffff/workers/scripts/spike-m6-b-x`,
    `${API}/workers/scripts/spike-m6-b-x`,
  ];
  for (const url of targets) for (const method of WRITES) assert.throws(() => allow(method, url, ACCOUNT), /refusing/, `${method} ${url}`);
});

test("a path that could be folded into another one is refused, for every method", () => {
  const targets = [
    `${atAccount}/spike-m6-b-x/../podster-api-staging`,
    `${atAccount}/spike-m6-b-../podster-api-staging`,
    `${atAccount}/spike-m6-b-x%2f..%2fpodster-api-staging`,
    `${atAccount}/spike-m6-b-x%2F`,
    `${atAccount}//spike-m6-b-x`,
    `${atAccount}/spike-m6-b-x/`,
    `${atAccount}/spike-m6-b-x#a`,
    `${atAccount}/spike-m6-b-x\n`,
    `${atAccount}/spike-m6-b-x `,
    `${atAccount}/spike-m6-b-x\\..\\podster-api-staging`,
    `${atAccount}/./spike-m6-b-x`,
    `${inNamespace}/../../../scripts/spike-m6-b-x`,
    `${atAccount}/spike-m6-b-x?force=true&x=1`,
    `${atAccount}/spike-m6-b-x?name=podster-api-staging`,
    `https://api.cloudflare.com:443/client/v4/accounts/${ACCOUNT}/workers/scripts/spike-m6-b-x`,
    `HTTPS://API.CLOUDFLARE.COM/client/v4/accounts/${ACCOUNT}/workers/scripts/spike-m6-b-x`,
  ];
  for (const url of targets) for (const method of WRITES) assert.throws(() => allow(method, url, ACCOUNT), /refusing/, `${method} ${JSON.stringify(url)}`);
  for (const url of targets.filter((u) => /\.\.|%|#|\\|\s|:443|HTTPS/.test(u))) assert.throws(() => allow("GET", url, ACCOUNT), /refusing/, `GET ${JSON.stringify(url)}`);
});

test("a token is never sent to another host, even for a GET", () => {
  for (const url of [
    "https://example.com/client/v4/user/tokens/verify",
    "http://api.cloudflare.com/client/v4/user/tokens/verify",
    "https://api.cloudflare.com.example.com/client/v4/user/tokens/verify",
    "https://user@api.cloudflare.com/client/v4/user/tokens/verify",
    "https://api.cloudflare.com/other/v4/user/tokens/verify",
    "/client/v4/user/tokens/verify",
    "",
    undefined,
  ]) {
    assert.throws(() => allow("GET", url, ACCOUNT), /refusing/, String(url));
  }
});

test("a GET of Podster's own is allowed: it changes nothing", () => {
  for (const url of [`${API}/user/tokens/verify`, `${atAccount}`, `${atAccount}/podster-api-staging/settings`, `${API}/zones?name=opster.dev`, `${account}/d1/database`]) {
    assert.equal(allow("GET", url, ACCOUNT), url);
  }
});

test("PATCH, POST and other methods are refused where PUT and DELETE are allowed", () => {
  for (const method of ["PATCH", "POST", "put", "delete", "OPTIONS", "HEAD", "", undefined]) {
    assert.throws(() => allow(method, `${atAccount}/spike-m6-b-canary`, ACCOUNT), /refusing/, String(method));
  }
  for (const method of ["PUT", "DELETE", "PATCH"]) assert.throws(() => allow(method, `${inNamespace}/spike-m6-b-edit/assets-upload-session`, ACCOUNT), /refusing/);
  assert.throws(() => allow("POST", `${atAccount}/spike-m6-b-edit/assets-upload-session`, ACCOUNT), /refusing/);
  assert.throws(() => allow("PUT", `${atAccount}/spike-m6-b-x?force=true`, ACCOUNT), /refusing/);
});

test("no request without an account ID", () => {
  for (const id of ["", undefined, "ACCOUNT", "0123456789ABCDEF0123456789ABCDEF"]) assert.throws(() => allow("GET", `${API}/user/tokens/verify`, id), /refusing/);
});

test("names", () => {
  assert.ok(allowedName("spike-m6-b-canary"));
  for (const name of ["spike-m6-a-site", "spike-m6-b-", "podster-api-staging", "spike-m6-b-x/..", undefined]) assert.ok(!allowedName(name));
});
