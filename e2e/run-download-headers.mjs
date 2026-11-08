// What a browser gets when it downloads a file through the dashboard: the built web Worker, run by wrangler, in front of a stub gateway
// that answers as the real one does for a ready file. Nothing on this path can make a file ready yet, as scanning's API isn't built, so the
// stub stands in for the gateway and the API. This checks only what the web Worker does to the answer, which is where vinext's config
// headers once replaced the file's own. It also checks that a page keeps the dashboard's CSP.
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
  `export default { fetch(request) {
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
