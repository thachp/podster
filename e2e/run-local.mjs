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
// After the journey, which runs with managed repositories off in both Workers as every deployment has them,
// managed-off-check.mjs shows the off state. Then a second throwaway stack runs with them on in both, for
// repo-access-check.mjs (M5 step 6) and merge-check.mjs (M5 step 7b). That stack's API is built again with its
// `rehearsal` feature, which sends GitHub's calls to fake-github-server.mjs on this machine, and the plain release build
// is put back afterwards. `--skip-managed` leaves all of that out.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localCertificate } from "./local-cert.mjs";
import { freePort, groupGone, local, prepareStack, repo, run, startGateway } from "./stack.mjs";

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

let { stack, log, stop } = startGateway({ gateway, apiConfig, persist, vars, port, extraArgs: testPeople ? ["--local-upstream", STAGING_HOST, "--local-protocol", "https", "--https-key-path", tls.key, "--https-cert-path", tls.cert] : [], inspectorPort: await freePort() });

/** Whether the HTTPS stack answers at all, with its certificate checked against the one made above. */
function answersOverTls(base) {
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

async function waitForStack(base) {
  const deadline = Date.now() + 120_000;
  let cookie;
  // Nobody can sign up on this stack without using up the test sign-up's limit, and any answer means it's listening.
  while (testPeople && Date.now() < deadline && stack.exitCode === null) {
    if (await answersOverTls(base)) return;
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
/** The fake GitHub's process, and whether the API's build is the rehearsal one, to undo both on the way out. */
let fakeGithub;
let rehearsalBuild = false;
try {
  await waitForStack(base);
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
  // Managed repositories are off on this stack, as on every deployment.
  const offCheck = skipManaged ? 0 : await child("managed-off-check.mjs", ["--base-url", base]);
  code = journey || probe || selfTest || agreeSelfTest || offCheck;
  if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
  if (code === 0 && !skipManaged) {
    // A second stack, from empty, with managed repositories on in both Workers. The build is the one above. Until its
    // check passes, the run counts as failed, so a stack that never comes up can't pass.
    code = 1;
    stop();
    // The first stack shares the local state folder, so it has to be gone before that's emptied for the second.
    if (!(await groupGone(stack.pid))) throw new Error("the first local stack didn't stop");
    // GitHub is stood in for by the test suite's fake, served on this machine. It makes its own keys, for this stack alone.
    const githubPort = await freePort();
    const github = `http://127.0.0.1:${githubPort}`;
    const keysFile = join(here, `.fake-github-${process.pid}.json`);
    fakeGithub = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(here, "fake-github-server.mjs"), String(githubPort), keysFile], { cwd: here, stdio: "inherit" });
    for (const deadline = Date.now() + 15_000; !existsSync(keysFile); ) {
      if (Date.now() > deadline || fakeGithub.exitCode !== null) throw new Error("the fake GitHub didn't start");
      await new Promise((wait) => setTimeout(wait, 50));
    }
    const fake = JSON.parse(readFileSync(keysFile, "utf8"));
    rmSync(keysFile, { force: true });
    // The API again, with GitHub's address fixed to the fake's. The plain release build comes back in `finally`.
    rehearsalBuild = true;
    run("worker-build", ["--release", "--features", "rehearsal"], join(repo, "apps/api"), { PODSTER_REHEARSAL_GITHUB_URL: github });
    const apiVars = {
      MANAGED_REPOSITORIES: "true",
      GITHUB_ORG_LOGIN: fake.ids.orgLogin,
      GITHUB_ORG_ID: String(fake.ids.orgId),
      GITHUB_PROVISION_APP_ID: String(fake.ids.provisionAppId),
      GITHUB_PROVISION_INSTALLATION_ID: String(fake.ids.installationId),
      GITHUB_PROVISION_APP_KEY: fake.provisionKey,
      GITHUB_AGENT_APP_ID: String(fake.ids.agentAppId),
      GITHUB_AGENT_INSTALLATION_ID: String(fake.ids.agentInstallationId),
      GITHUB_AGENT_APP_KEY: fake.agentKey,
      GITHUB_MERGE_APP_ID: String(fake.ids.mergeAppId),
      GITHUB_MERGE_INSTALLATION_ID: String(fake.ids.mergeInstallationId),
      GITHUB_MERGE_APP_KEY: fake.mergeKey,
      REPO_TOKEN_KEY: randomBytes(32).toString("hex"),
    };
    const on = prepareStack({ skipBuild: true, apiVars });
    const onPort = await freePort();
    const onBase = `http://localhost:${onPort}`;
    // Its own assertion key pair too, which prepareStack just made: the API checks against the new public half.
    const onVars = { ...vars, ASSERTION_SIGNING_JWK: JSON.stringify({ ...on.privateKey.export({ format: "jwk" }), kid: on.kid }), BASE_URL: onBase, MANAGED_REPOSITORIES: "true" };
    const start = async () => {
      ({ stack, log, stop } = startGateway({ ...on, vars: onVars, port: onPort, inspectorPort: await freePort() }));
      await waitForStack(onBase);
    };
    await start();
    // An operator is a person the API's OPERATORS names, and a person's ID exists only once they've signed up. So one
    // signs up, and the stack comes back with that ID named, on the same state.
    const operatorFile = join(local, "operator.json");
    if ((await child("operator-signup.mjs", ["--base-url", onBase, "--out", operatorFile])) !== 0) throw new Error("the operator couldn't sign up");
    const operator = JSON.parse(readFileSync(operatorFile, "utf8"));
    rmSync(operatorFile, { force: true });
    stop();
    if (!(await groupGone(stack.pid))) throw new Error("the stack didn't stop to take its operator");
    const config = JSON.parse(readFileSync(on.apiConfig, "utf8"));
    writeFileSync(on.apiConfig, JSON.stringify({ ...config, vars: { ...config.vars, OPERATORS: operator.id } }));
    await start();
    console.log(`\nlocal stack with managed repositories on is up at ${onBase}, with a fake GitHub at ${github}\n`);
    const access = await child("repo-access-check.mjs", ["--base-url", onBase]);
    const admins = await child("repo-admin-check.mjs", ["--base-url", onBase], { PODSTER_E2E_OPERATOR_COOKIE: operator.cookie });
    const merge = await child("merge-check.mjs", ["--base-url", onBase, "--github", github]);
    code = access || admins || merge;
    // Last, the same stack with the API's REPOSITORY_REQUESTERS naming one person, on the same state: the operator, who
    // is already signed in. Everyone the checks above made is then someone the deployment doesn't list.
    if (code === 0) {
      stop();
      if (!(await groupGone(stack.pid))) throw new Error("the stack didn't stop to take its list of requesters");
      const open = JSON.parse(readFileSync(on.apiConfig, "utf8"));
      writeFileSync(on.apiConfig, JSON.stringify({ ...open, vars: { ...open.vars, REPOSITORY_REQUESTERS: operator.id } }));
      await start();
      code = await child("repo-requesters-check.mjs", ["--base-url", onBase, "--github", github], { PODSTER_E2E_LISTED_COOKIE: operator.cookie });
    }
    if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
  }
} catch (error) {
  console.error(error);
} finally {
  stop();
  fakeGithub?.kill();
  // Never leave the rehearsal build where a later run or a deploy would find it.
  if (rehearsalBuild) {
    try {
      run("worker-build", ["--release"], join(repo, "apps/api"));
    } catch (error) {
      console.error("The API's plain release build couldn't be put back. Rebuild it before anything else uses apps/api/build.", error);
      code = 1;
    }
  }
}
process.exit(code);
