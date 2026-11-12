// A probe for one question: what does the API's log say of a signed GitHub delivery on staging, and does its tail
// hold it? Written after M5-16b failed on staging with "no log line within 60 s" for a delivery the gateway had
// answered 202. It takes no sign-up, makes no room and asks GitHub nothing.
//
//   PODSTER_M5_WEBHOOK_SECRET=… CLOUDFLARE_ACCOUNT_ID=… node m5-delivery-probe.mjs [--repository ID] [--pull NUMBER] [--count N]
//
// It tails the API and the gateway, then sends `--count` signed deliveries (3 unless said, 10 at most) naming GitHub's
// repository 1, which is nobody's room, and the same number naming `--repository` when one is given: a repository a
// past run left linked to a room. `--pull` is the pull request number they name: 999999 unless said, which no room
// watches. For each it prints the gateway's answer and everything the API's tail holds of it: its line's outcome, a
// line with no outcome, the API's own request with no line, or nothing at all.
//
// Staging's gateway only. The secret is read from the environment, used to sign, and never printed, written or passed
// to a child. Exit 0 when every delivery had one line with an outcome, 1 otherwise, 2 for a refused configuration.
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingWranglers } from "./m4-staging-lib.mjs";
import { deliveryBody, deliveryProblem, deliveryTrace, scrub, signDelivery, STAGING, WEBHOOK_PATH, WEBHOOK_SECRET_ENV, webhookSecretProblem } from "./m5-staging-lib.mjs";
import { closeTails, downWithin, openTail, refusalLines, STAY_UP_SECONDS } from "./m5-tails.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const APPS = ["api", "gateway"];

/** The arguments, or why they're refused. */
export function probeArgs(argv) {
  const options = { repository: undefined, pull: 999_999, count: 3 };
  for (let at = 0; at < argv.length; at++) {
    const [flag, value] = [argv[at], argv[at + 1]];
    const name = { "--repository": "repository", "--pull": "pull", "--count": "count" }[flag];
    if (!name) return { error: `unknown argument ${flag}` };
    if (value === undefined || !/^[1-9]\d{0,14}$/.test(value)) return { error: `${flag} takes a whole number above zero` };
    options[name] = Number(value);
    at++;
  }
  if (options.count > 10) return { error: "--count is 10 at most" };
  return { options };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const parsed = probeArgs(process.argv.slice(2));
  const secret = process.env[WEBHOOK_SECRET_ENV] || undefined;
  const uninstalled = missingWranglers(repoRoot).filter((app) => APPS.includes(app));
  const problems = [parsed.error, secret ? webhookSecretProblem(secret) : `${WEBHOOK_SECRET_ENV} isn't set`, uninstalled.length ? `apps/${uninstalled.join(", apps/")} has no wrangler installed: run \`npm ci\` there` : null].filter(Boolean);
  for (const problem of problems) console.error(`Refused: ${problem}.`);
  if (problems.length) process.exit(2);
  const { options } = parsed;
  const say = (line) => console.log(scrub(line, [secret]));
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  const tails = APPS.map((app) => openTail({ app, bin: join(repoRoot, "apps", app, "node_modules/.bin/wrangler"), cwd: join(repoRoot, "apps", app) }));
  const down = await downWithin(tails, STAY_UP_SECONDS);
  if (down.length) {
    closeTails(tails);
    for (const line of refusalLines(down)) console.error(`Refused: ${line}.`);
    process.exit(2);
  }
  const [api, gateway] = tails;
  const send = async (repositoryId) => {
    const id = randomUUID();
    const body = deliveryBody({ repositoryId, number: options.pull, head: randomBytes(20).toString("hex"), nonce: randomUUID() });
    const res = await fetch(`${STAGING}${WEBHOOK_PATH}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": "e2e-check", "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signDelivery(secret, body) }, body, signal: AbortSignal.timeout(30_000) });
    await res.arrayBuffer();
    return { id, repositoryId, status: res.status, at: Date.now() };
  };
  /** What the gateway's own log says of a delivery: its `github.webhook` line's outcome, or none. */
  const gatewaySaid = (id) => {
    for (const event of gateway.stream.values) {
      for (const entry of Array.isArray(event?.logs) ? event.logs : []) {
        for (const part of Array.isArray(entry?.message) ? entry.message : []) {
          try {
            const line = typeof part === "string" ? JSON.parse(part) : part;
            if (line?.at === "github.webhook" && line.delivery === id) return String(line.outcome);
          } catch {
            // Not a line of JSON.
          }
        }
      }
    }
    return "no line";
  };

  // The first delivery also shows both tails are delivering: it's sent until its line is there, for a minute at most.
  let connected = false;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && !connected; ) {
    const first = await send(1);
    await sleep(4000);
    connected = deliveryTrace(api.stream.values, first.id).outcomes.length > 0;
  }
  say(connected ? "Both tails are up, and the API's holds a delivery's line." : "The API's tail held no line for any delivery in its first minute: what follows may only show a tail that isn't delivering.");

  const sent = [];
  for (let round = 0; round < options.count; round++) {
    // Back to back, as M5-16b sends its two: the one for a room first.
    if (options.repository) sent.push(await send(options.repository));
    sent.push(await send(1));
    await sleep(1500);
  }
  await sleep(20_000);
  let failed = 0;
  for (const one of sent) {
    const trace = deliveryTrace(api.stream.values, one.id);
    const problem = deliveryProblem(trace);
    if (problem || one.status !== 202) failed++;
    say(`repository ${one.repositoryId}: the gateway answered ${one.status} and logged ${gatewaySaid(one.id)}; the API logged ${trace.outcomes.join(", ") || "no outcome"}${problem ? `. ${problem.text}` : ""}`);
  }
  say(`\n${sent.length - failed} of ${sent.length} deliveries had one line with an outcome. The API's tail held ${api.stream.values.length} events, the gateway's ${gateway.stream.values.length}.`);
  closeTails(tails);
  await sleep(2000);
  process.exit(failed ? 1 : 0);
}
