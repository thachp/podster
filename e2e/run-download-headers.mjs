// What a browser gets when it downloads a file through the dashboard: the built web Worker, run by wrangler, in front of a stub gateway
// that answers as the real one does for a ready file. Nothing on this path can make a file ready yet, as scanning's API isn't built, so the
// stub stands in for the gateway and the API. This checks only what the web Worker does to the answer, which is where vinext's config
// headers once replaced the file's own. It also checks that a page keeps the dashboard's CSP, and that the public room page
// (M4 step 11(b)) is served with its own headers and no script, through the stub's PublicReads entrypoint.
//
//   node run-download-headers.mjs [--skip-web-build]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, local, repo, run, startWrangler } from "./stack.mjs";

const web = join(repo, "apps/web");
if (!process.argv.includes("--skip-web-build")) run("npm", ["run", "build"], web);

const FILE_CSP = "default-src 'none'; sandbox";
const DISPOSITION = `attachment; filename="notes.html"; filename*=UTF-8''notes.html`;
const BODY = "<script>alert(1)</script>";
mkdirSync(local, { recursive: true });
const stub = join(local, "stub-gateway.mjs");
writeFileSync(
  stub,
  `import { WorkerEntrypoint } from "cloudflare:workers";
const VIEW = ${JSON.stringify({ handle: `pub_${"a".repeat(32)}`, published_on: "2026-11-09", content: { name: "Reef <script>x</script>", goal: "**Count** the fish", context: null, topic: "research", workflow: "general", openings: [], outputs: [], participant_count: 2, person_review: true, archived: false } })};
export class PublicReads extends WorkerEntrypoint {
  async getWorkroom(handle) { return handle === VIEW.handle ? { status: 200, view: VIEW } : { status: 404 }; }
}
export default { fetch(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/v1/files/ws_1/obj_1") return new Response(${JSON.stringify(BODY)}, { headers: {
    "content-type": "application/octet-stream", "content-disposition": ${JSON.stringify(DISPOSITION)}, "x-content-type-options": "nosniff",
    "cache-control": "private, no-store", "content-security-policy": ${JSON.stringify(FILE_CSP)}, "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer" } });
  return Response.json({ error: { code: "not_found", message: "not_found" } }, { status: 404 });
} };
`,
);
const stubConfig = join(local, "stub-gateway.wrangler.json");
writeFileSync(stubConfig, JSON.stringify({ name: "podster-gateway", main: stub, compatibility_date: "2026-08-01" }));

const registry = { WRANGLER_REGISTRY_PATH: join(local, "download-registry") };
const [port, stubPort] = [await freePort(), await freePort()];
const app = `http://localhost:${port}`;
const gateway = startWrangler({ cwd: local, args: ["--config", stubConfig, "--port", String(stubPort), "--inspector-port", String(await freePort())], env: registry });
const dashboard = startWrangler({
  cwd: web,
  command: join(web, "node_modules/.bin/wrangler"),
  env: registry,
  args: ["--config", "dist/server/wrangler.json", "--port", String(port), "--inspector-port", String(await freePort()), "--var", `APP_URL:${app}`, "--var", `GATEWAY_URL:http://localhost:${stubPort}`],
});

const failures = [];
const check = (passed, title, detail = "") => {
  if (!passed) failures.push(title);
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `: ${detail}` : ""}`);
};

async function main() {
  const deadline = Date.now() + 120_000;
  let download = null;
  while (Date.now() < deadline && gateway.stack.exitCode === null && dashboard.stack.exitCode === null) {
    download = await fetch(`${app}/api/v1/files/ws_1/obj_1`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (download?.status === 200) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (download?.status !== 200) {
    console.error((gateway.log.join("") + dashboard.log.join("")).slice(-3000));
    throw new Error(`the download didn't come through: ${download?.status}`);
  }
  const header = (name) => download.headers.get(name);
  check(header("content-security-policy") === FILE_CSP, "a download keeps the file's sandboxing CSP", header("content-security-policy"));
  check(header("referrer-policy") === "no-referrer", "and its no-referrer", header("referrer-policy"));
  check(header("x-content-type-options") === "nosniff", "and nosniff", header("x-content-type-options"));
  check(header("content-disposition") === DISPOSITION, "and is an attachment", header("content-disposition"));
  check(header("cross-origin-resource-policy") === "same-origin", "and keeps its CORP", header("cross-origin-resource-policy"));
  check((await download.text()) === BODY, "with the bytes unchanged");

  const missing = await fetch(`${app}/api/v1/files/ws_1/obj_2`);
  check(missing.headers.get("content-security-policy")?.startsWith("default-src 'self'") === true, "another /api answer still gets the dashboard's CSP", missing.headers.get("content-security-policy"));
  check(missing.headers.get("referrer-policy") === "same-origin" && missing.headers.get("x-frame-options") === "DENY", "and its referrer policy and frame options");

  const page = await fetch(`${app}/sign-in`);
  check(page.status === 200, "a dashboard page answers", String(page.status));
  check(page.headers.get("content-security-policy")?.startsWith("default-src 'self'") === true, "and keeps the dashboard's CSP", page.headers.get("content-security-policy"));
  check(page.headers.get("referrer-policy") === "same-origin" && page.headers.get("x-frame-options") === "DENY" && page.headers.get("x-content-type-options") === "nosniff", "and its other headers");

  const PUBLIC_CSP = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
  const publicHeaders = (response) =>
    response.headers.get("content-security-policy") === PUBLIC_CSP &&
    response.headers.get("x-robots-tag") === "noindex, nofollow" &&
    response.headers.get("cache-control") === "no-store" &&
    response.headers.get("x-frame-options") === "DENY" &&
    response.headers.get("referrer-policy") === "same-origin";
  const room = await fetch(`${app}/p/pub_${"a".repeat(32)}`);
  const roomBody = await room.text();
  check(room.status === 200, "a public room page answers", String(room.status));
  check(publicHeaders(room), "with only its own CSP and the public headers", room.headers.get("content-security-policy"));
  check(!/<script/i.test(roomBody) && roomBody.includes("Reef &lt;script&gt;x&lt;/script&gt;") && roomBody.includes("<strong>Count</strong>"), "and no script, with the owner's text inert");
  const signedIn = await fetch(`${app}/p/pub_${"a".repeat(32)}`, { headers: { cookie: "better-auth.session_token=abc" } });
  check((await signedIn.text()) === roomBody, "and the same bytes for a signed-in viewer");
  const gone = await fetch(`${app}/p/pub_${"b".repeat(32)}`);
  await gone.text();
  check(gone.status === 404 && publicHeaders(gone), "a handle that isn't public is a 404 with the same headers", String(gone.status));
  const style = await fetch(`${app}/p-assets/style`);
  await style.text();
  check(style.status === 200 && style.headers.get("content-type")?.startsWith("text/css") === true && publicHeaders(style), "its stylesheet comes from this host with the same headers");
  const robots = await fetch(`${app}/robots.txt`);
  check(robots.status === 200 && (await robots.text()).includes("Allow: /"), "robots.txt allows crawling, so the noindex is seen");
}

try {
  await main();
} finally {
  gateway.stop();
  dashboard.stop();
}
if (failures.length > 0) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log("all passed");
