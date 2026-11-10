// Runs the real gateway and the release build of the API together under `wrangler dev`, then the journey and the probe.
// Everything local lives in e2e/.local and is thrown away, so each run starts empty.
//
//   node run-local.mjs [--skip-build] [--rehearse-cookies] [journey options]
//
// `--rehearse-cookies` signs two people up first and hands the journey their cookies, which is the path a deployed run
// uses. `--rehearse-same-person` gives it one person's cookie twice, which it has to refuse. `--rehearse-test-people`
// runs staging's setup with nothing remote: the worker sees staging's URLs and `APP_URL`, and rehearse-fetch.mjs sends the
// journey's requests for staging here, so the driver and the test sign-up meet with their real gates on.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localCertificate } from "./local-cert.mjs";
import { freePort, prepareStack, startGateway } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const flags = process.argv.slice(2);
const skipBuild = flags.includes("--skip-build");
const rehearse = flags.includes("--rehearse-cookies");
const samePerson = flags.includes("--rehearse-same-person");
const testPeople = flags.includes("--rehearse-test-people");
const passOn = flags.filter((f) => !["--skip-build", "--rehearse-cookies", "--rehearse-same-person", "--rehearse-test-people"].includes(f));

const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild });

const port = await freePort();
// A worker only sees staging's HTTPS URLs if the local stack is on HTTPS too.
const base = `${testPeople ? "https" : "http"}://localhost:${port}`;
// Its certificate is made for this run, and is the one thing this run and the journey trust beyond the usual.
// Certificate checking stays on everywhere. What the certificate is, in local-cert.mjs.
const tls = testPeople ? localCertificate() : undefined;
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

const { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, extraArgs: testPeople ? ["--local-upstream", STAGING_HOST, "--local-protocol", "https", "--https-key-path", tls.key, "--https-cert-path", tls.cert] : [], inspectorPort: await freePort() });

/** Whether the HTTPS stack answers at all, with its certificate checked against the one made above. */
function answersOverTls() {
  return new Promise((done) => {
    const request = httpsRequest(`${base}/api/auth/ok`, { ca: tls.ca, timeout: 30_000 }, (response) => {
      response.resume();
      done(true);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => done(false));
    request.end();
  });
}

async function waitForStack() {
  const deadline = Date.now() + 120_000;
  let cookie;
  // Nobody can sign up on this stack without using up the test sign-up's limit, and any answer means it's listening.
  while (testPeople && Date.now() < deadline && stack.exitCode === null) {
    if (await answersOverTls()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  while (Date.now() < deadline) {
    if (stack.exitCode !== null) break;
    try {
      // A signed-in /v1/me is the first request that crosses the service binding to the API.
      cookie ||= await signUp();
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

async function signUp() {
  const res = await fetch(`${base}/api/auth/sign-up/email`, { signal: AbortSignal.timeout(30_000), method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: `${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(16).toString("hex"), name: "Rehearsal" }) });
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
  await waitForStack();
  console.log(`local stack is up at ${base}\n`);
  if (testPeople) {
    const redirect = ["--import", join(here, "rehearse-fetch.mjs")];
    // The journey trusts this run's certificate through Node's own list of extra authorities, and checks it as usual.
    const rehearsal = { PODSTER_E2E_REHEARSE_PORT: String(port), PODSTER_E2E_SIGNUP_SECRET: signupSecret, PODSTER_E2E_COOKIE_A: "", PODSTER_E2E_COOKIE_B: "", NODE_EXTRA_CA_CERTS: tls.cert };
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
} catch (error) {
  console.error(error);
} finally {
  stop();
}
process.exit(code);
