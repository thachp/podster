// A stand-in for staging, for m6-staging-selftest.mjs only. Loaded with `node --import` before m6-staging.mjs, it
// replaces fetch, so no request leaves this machine: every one is answered here, and none is passed on. At exit it
// prints how many requests it answered, and how many were the test sign-up.
//
// M6_STANDIN picks what staging does:
// - drop-signup: the signed-out preflight answers as staging does; the test sign-up's request arrives, and its answer is
//   lost in transport.
// - edge-down: every request answers 502, as Cloudflare's edge does when the Worker is down.
const mode = process.env.M6_STANDIN;
if (!["drop-signup", "edge-down"].includes(mode)) throw new Error(`M6_STANDIN must be drop-signup or edge-down, not ${mode}`);

const counts = { requests: 0, signUps: 0 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url) => {
  counts.requests++;
  const path = new URL(typeof url === "string" ? url : url.url).pathname;
  if (path === "/api/auth/sign-up/e2e") counts.signUps++;
  if (mode === "edge-down") return new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  if (path === "/.well-known/agent-configuration") return json(200, { version: "stand-in" });
  if (path === "/api/v1/workspaces") return json(401, { error: { code: "sign_in_required", message: "sign_in_required" } });
  if (path === "/api/auth/sign-up/e2e") throw new TypeError("fetch failed", { cause: new Error("the stand-in dropped the answer") });
  return json(404, { error: { code: "not_found", message: "not_found" } });
};

console.log(`stand-in for staging: ${mode}; nothing leaves this machine`);
process.on("exit", () => console.log(`stand-in counted: ${counts.requests} requests, ${counts.signUps} test sign-ups`));
