// Runs the real gateway and the release build of the API together under `wrangler dev`, then the journey and the probe.
// Everything local lives in e2e/.local and is thrown away, so each run starts empty.
//
//   node run-local.mjs [--skip-build] [--rehearse-cookies] [journey options]
//
// `--rehearse-cookies` signs two people up first and hands the journey their cookies, which is the path a deployed run
// uses. `--rehearse-same-person` gives it one person's cookie twice, which it has to refuse. `--rehearse-test-people`
// runs staging's setup with nothing remote: the worker sees staging's URLs and `APP_URL`, and rehearse-fetch.mjs sends the
// journey's requests for staging here, so the driver and the test sign-up meet with their real gates on.
//
// After the journey, which runs with managed repositories off in both Workers as every deployment has them, a second
// throwaway stack runs with them on in both, for repo-access-check.mjs (M5 step 6). `--skip-managed` leaves that out.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, groupGone, prepareStack, startGateway } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const flags = process.argv.slice(2);
const skipBuild = flags.includes("--skip-build");
const rehearse = flags.includes("--rehearse-cookies");
const samePerson = flags.includes("--rehearse-same-person");
const testPeople = flags.includes("--rehearse-test-people");
const skipManaged = flags.includes("--skip-managed");
const passOn = flags.filter((f) => !["--skip-build", "--rehearse-cookies", "--rehearse-same-person", "--rehearse-test-people", "--skip-managed"].includes(f));

const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild });

const port = await freePort();
// A worker only sees staging's HTTPS URLs if the local stack is on HTTPS too, with wrangler's own certificate.
const base = `${testPeople ? "https" : "http"}://localhost:${port}`;
if (testPeople) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// These reach only the gateway, and die with this run.
const vars = {
  AUTH_SECRET: randomBytes(32).toString("base64"),
  ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }),
  BASE_URL: base,
  // Password sign-in only turns on where BASE_URL is localhost or *.test. The gateway enforces that.
  ENABLE_PASSWORD_SIGNIN: "true",
};

const STAGING_HOST = "gateway-staging.podster.dev";
const signupSecret = randomBytes(32).toString("hex");
if (testPeople) {
  // Password sign-in stays off, as on staging. The secret dies with this run.
  delete vars.ENABLE_PASSWORD_SIGNIN;
  Object.assign(vars, { BASE_URL: `https://${STAGING_HOST}`, APP_URL: "https://app-staging.podster.dev", ENABLE_E2E_SIGNUP: "true", E2E_SIGNUP_SECRET: signupSecret });
}

let { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, extraArgs: testPeople ? ["--local-upstream", STAGING_HOST, "--local-protocol", "https"] : [], inspectorPort: await freePort() });

async function waitForStack(base) {
  const deadline = Date.now() + 120_000;
  let cookie;
  // Nobody can sign up on this stack without using up the test sign-up's limit, and any answer means it's listening.
  while (testPeople && Date.now() < deadline && stack.exitCode === null) {
    const answered = await fetch(`${base}/api/auth/ok`, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (answered) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  while (Date.now() < deadline) {
    if (stack.exitCode !== null) break;
    try {
      // A signed-in /v1/me is the first request that crosses the service binding to the API.
      cookie ||= await signUp(base);
      const me = await fetch(`${base}/api/v1/me`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
      if (me.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  console.error(log.join(""));
  throw new Error("the local stack didn't come up");
}

async function signUp(at = base) {
  const res = await fetch(`${at}/api/auth/sign-up/email`, { signal: AbortSignal.timeout(30_000), method: "POST", headers: { "content-type": "application/json", origin: at }, body: JSON.stringify({ email: `${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(16).toString("hex"), name: "Rehearsal" }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function child(script, args, env = {}, nodeArgs = []) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [...nodeArgs, join(here, script), ...args], { cwd: here, stdio: "inherit", env: { ...process.env, ...env } });
    proc.on("exit", (code) => done(code ?? 1));
  });
}

let code = 1;
try {
  await waitForStack(base);
  console.log(`local stack is up at ${base}\n`);
  if (testPeople) {
    const redirect = ["--import", join(here, "rehearse-fetch.mjs")];
    const rehearsal = { PODSTER_E2E_REHEARSE_PORT: String(port), PODSTER_E2E_SIGNUP_SECRET: signupSecret, PODSTER_E2E_COOKIE_A: "", PODSTER_E2E_COOKIE_B: "" };
    const resultFiles = () => (existsSync(join(here, "results")) ? readdirSync(join(here, "results")) : []);
    const before = new Set(resultFiles());
    code = await child("journey.mjs", ["--base-url", `https://${STAGING_HOST}`, ...passOn], rehearsal, redirect);
    // docs/m0-gate.md records passes from these files, so a rehearsal's must never pass for a deployed run's.
    const written = resultFiles().filter((name) => !before.has(name));
    const kind = written.length === 1 ? JSON.parse(readFileSync(join(here, "results", written[0]), "utf8")).kind : undefined;
    if (kind !== "rehearsal" || !written[0].startsWith("rehearsal-")) {
      console.error(`A rehearsal has to write one result marked as one. It wrote ${written.join(", ") || "none"}, of kind ${kind}.`);
      code = 1;
    }
    if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
    stop();
    process.exit(code);
  }
  const first = rehearse || samePerson ? await signUp() : undefined;
  const cookies = first ? { PODSTER_E2E_COOKIE_A: first, PODSTER_E2E_COOKIE_B: samePerson ? first : await signUp() } : {};
  const journey = await child("journey.mjs", ["--base-url", base, ...passOn], cookies);
  const probe = await child("probe-api.mjs", ["--gateway", base, "--gateway-only", "--with-posts"]);
  const selfTest = await child("probe-selftest.mjs", []);
  const agreeSelfTest = await child("agree-selftest.mjs", []);
  code = journey || probe || selfTest || agreeSelfTest;
  if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
  if (code === 0 && !skipManaged) {
    // A second stack, from empty, with managed repositories on in both Workers. The build is the one above. Until its
    // check passes, the run counts as failed, so a stack that never comes up can't pass.
    code = 1;
    stop();
    // The first stack shares the local state folder, so it has to be gone before that's emptied for the second.
    if (!(await groupGone(stack.pid))) throw new Error("the first local stack didn't stop");
    const on = prepareStack({ skipBuild: true, apiVars: { MANAGED_REPOSITORIES: "true" } });
    const onPort = await freePort();
    const onBase = `http://localhost:${onPort}`;
    // Its own assertion key pair too, which prepareStack just made: the API checks against the new public half.
    const onVars = { ...vars, ASSERTION_SIGNING_JWK: JSON.stringify({ ...on.privateKey.export({ format: "jwk" }), kid: on.kid }), BASE_URL: onBase, MANAGED_REPOSITORIES: "true" };
    ({ stack, log, stop } = startGateway({ ...on, vars: onVars, port: onPort, inspectorPort: await freePort() }));
    await waitForStack(onBase);
    console.log(`\nlocal stack with managed repositories on is up at ${onBase}\n`);
    code = await child("repo-access-check.mjs", ["--base-url", onBase]);
    if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
  }
} catch (error) {
  console.error(error);
} finally {
  stop();
}
process.exit(code);
