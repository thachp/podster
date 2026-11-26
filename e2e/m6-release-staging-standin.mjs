// A stand-in for staging and the content domain, for m6-release-staging-selftest.mjs only. Loaded with `node --import`
// before m6-release-staging.mjs, it replaces fetch, so no request leaves this machine: every one is answered here, and
// none is passed on. At exit it prints how many requests it answered, how many were the test sign-up, and how many
// signed a session out, and how many were sent to Cloudflare's API (answered 599, like any other host it doesn't stand in for).
//
// M6_RELEASE_STANDIN picks what staging does:
// - edge-down: every request answers 502, as Cloudflare's edge does when a Worker is down.
// - off: staging answers the preflight, and capabilities discovery doesn't list deploy_release: RELEASES isn't true.
// - no-content: deploy_release is listed, and an app's host answers 200 with no sandbox: no content Worker there.
// - not-available: release is on and the content Worker answers, one sign-up makes an organization and a room, the
//   room answers its release configuration, and a request is refused release_not_available.
const mode = process.env.M6_RELEASE_STANDIN;
if (!["edge-down", "off", "no-content", "not-available"].includes(mode)) throw new Error(`M6_RELEASE_STANDIN must be edge-down, off, no-content or not-available, not ${mode}`);

const counts = { requests: 0, signUps: 0, signOuts: 0, cloudflare: 0 };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const SANDBOX = "sandbox allow-scripts; default-src https://x.podster.site";
let next = 1;
const id = (prefix) => `${prefix}_standin${next++}`;

globalThis.fetch = async (input, init = {}) => {
  counts.requests++;
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "api.cloudflare.com") counts.cloudflare++;
  const method = (init.method ?? "GET").toUpperCase();
  if (mode === "edge-down") return new Response("bad gateway", { status: 502 });
  if (url.hostname.endsWith(".podster.site")) {
    if (mode === "no-content") return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("not_found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": SANDBOX } });
  }
  if (url.origin !== "https://gateway-staging.podster.dev") return new Response("not here", { status: 599 });
  const path = url.pathname;
  if (path === "/.well-known/agent-configuration") return json(200, { name: "stand-in" });
  if (path === "/api/auth/capability/list") return json(200, { capabilities: [{ name: "get_task" }, ...(mode === "off" ? [] : [{ name: "deploy_release" }])], has_more: false });
  const signedIn = /podster_session=/.test(new Headers(init.headers ?? {}).get("cookie") ?? "");
  if (path === "/api/auth/sign-up/e2e" && method === "POST") {
    counts.signUps++;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json", "set-cookie": `podster_session=${"s".repeat(40)}${counts.signUps}; Path=/; HttpOnly; Secure` } });
  }
  if (path === "/api/auth/sign-out" && method === "POST") {
    counts.signOuts++;
    return json(200, {});
  }
  if (!signedIn) return json(401, { error: { code: "sign_in_required" } });
  if (path === "/api/orgs" && method === "GET") return json(200, { organizations: [{ id: "org_standin_personal", personal: true }] });
  if (path === "/api/orgs" && method === "POST") return json(200, { id: id("org") });
  if (path === "/api/v1/me") return json(200, { id: "per_e2e_standin" });
  if (path === "/api/v1/workspaces" && method === "POST") return json(200, { id: id("ws") });
  if (/^\/api\/v1\/workspaces\/[^/]+\/release-config$/.test(path)) return json(200, { enabled: false, approval_policy: "person", environments: ["production"], default_host: null, custom_host: null, version: 0, set_by: null, updated_at: null });
  if (/^\/api\/v1\/workspaces\/[^/]+\/releases$/.test(path) && method === "POST") return json(409, { error: { code: "release_not_available" } });
  return json(404, { error: { code: "not_found" } });
};

process.on("exit", () => {
  console.log(`stand-in: ${counts.requests} requests, ${counts.signUps} sign-ups, ${counts.signOuts} sign-outs, ${counts.cloudflare} to Cloudflare's API`);
});
