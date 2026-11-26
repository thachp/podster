// Checks the parts of M6's staging run for custom domains that need no network: its plan and exit code, the figures it
// expects (read from crates/core, apps/api and apps/content), the guard every DNS write goes through, the DNS client
// against a stand-in fetch, and how it judges a hostname request, a race and a custom host's answers. Then the script
// itself: --help, dry runs, which send nothing, and runs against m6-release-staging-standin.mjs, which answers every
// request on this machine, for each way it refuses before it takes a sign-up or writes DNS.
//
//   npm ci          (once, in this directory: the script itself imports lib.mjs's packages)
//   node m6-custom-domain-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adoptable, certificateLine, CF_API, CHALLENGE_PREFIX, challengeName, challengeUnderRoot, CNAME_TARGET, CONTENT_DOMAIN, CUSTOM_HSTS, customHeaderProblems, dnsAllow, dnsClient, dnsEnvProblem, DNS_TTL, EXIT, GONE_SPAN_MS, parseArgs, PENDING_HOLD_MS, PLAN, PROOF_LOOK_MS, raceOutcome,
  REFUSED_BODIES, REFUSED_NAMES, requestProblem, reservedProblem, Results, runLabel, runNames, runOutcome, RUN_LABEL, SIGN_UPS, STAGING, TEST_DOMAIN, txtContent, underRoot, WAITS,
} from "./m6-custom-domain-staging-lib.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node m6-custom-domain-staging-selftest.mjs

Checks M6's staging run for custom domains without the network: its plan and exit code, the figures it expects, the
DNS guard and client (against a stand-in fetch), how it judges answers, dry runs and runs against
m6-release-staging-standin.mjs. Run npm ci in this directory once first. It takes no options and sends nothing anywhere.`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const missing = ["@auth/agent", "@modelcontextprotocol/sdk/client/index.js"].filter((name) => {
  try {
    import.meta.resolve(name);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(`m6-custom-domain-staging-selftest: e2e's packages aren't installed (${missing.join(", ")} not found). Run npm ci in e2e first. No case was run.`);
  process.exit(2);
}

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const scratch = mkdtempSync(join(tmpdir(), "m6-custom-domain-selftest-"));

// ---- the plan and the exit code ----

{
  const ids = PLAN.map((entry) => entry.id);
  check(new Set(ids).size === ids.length, "every check's ID is its own");
  check(JSON.stringify(PLAN.filter((e) => e.outOfScope).map((e) => e.id)) === '["X14-6","X26-2","X26-3"]' && JSON.stringify(PLAN.filter((e) => e.recordOnly).map((e) => e.id)) === '["X14-4"]', "three checks are out of scope (the freed claim, the 72-hour expiry, the 24-hour recheck) and one only recorded (the certificate)");
  check(["M6-X14", "M6-X15", "M6-X26"].every((label) => PLAN.some((e) => !e.outOfScope && !e.recordOnly && e.title.startsWith(label))), "each of M6-X14, M6-X15 and M6-X26 has a judged check");
  check(PLAN.filter((e) => e.outOfScope && e.id.startsWith("X26")).every((e) => /time-dependent/.test(e.outOfScope) && /test clock/.test(e.outOfScope)), "the time-dependent gaps say why");
  const outcome = (status) => {
    const results = new Results(PLAN, () => {});
    for (const entry of PLAN) results.add(entry.id, entry.outOfScope ? "outOfScope" : entry.recordOnly ? "recorded" : status(entry), "");
    return runOutcome(results, PLAN);
  };
  check(outcome(() => "pass").code === 0, "every judged check passed: exit 0, out of scope and recorded aside");
  const one = outcome((entry) => (entry.id === "X15-2" ? "fail" : "pass"));
  check(one.code === 1 && JSON.stringify(one.failed) === '["X15-2"]', "a failure fails the run, named");
  const partial = new Results(PLAN, () => {});
  partial.add("X15-1", "pass");
  check(runOutcome(partial, PLAN).code === 1, "a judged check with no result fails the run");
  check(SIGN_UPS.length === 2, "the run plans 2 takes of the test sign-up");
  check(parseArgs(["--base-url", STAGING]).options?.base === STAGING && Boolean(parseArgs(["--base-url", "https://example.com"]).error) && parseArgs(["--help"]).options?.help === true, "staging only");
  const waits = parseArgs(["--base-url", STAGING, "--claim-wait", "60", "--core-hostnames", "x.rs"]).options;
  check(waits?.claimWait === 60 && waits.coreHostnames === "x.rs" && waits.activeWait === WAITS["--active-wait"][1], "its own waits and the reserved list's file are options");
  check(Boolean(parseArgs(["--base-url", STAGING, "--serve-wait", "5"]).error) && Boolean(parseArgs(["--base-url", STAGING, "--claim-wait"]).error) && Boolean(parseArgs(["--base-url", STAGING, "--zone", "x"]).error), "a wait out of bounds, a missing value or an unknown flag is refused");
}

// ---- the figures, read where they are set ----

const hostnamesRs = readFileSync(join(root, "crates/core/src/hostnames.rs"), "utf8");
{
  check(hostnamesRs.includes(`pub const CHALLENGE_PREFIX: &str = "${CHALLENGE_PREFIX}";`), "the challenge's prefix is core's");
  check(hostnamesRs.includes('pub const CNAME_TARGET_LABEL: &str = "fallback";') && CNAME_TARGET === `fallback.${CONTENT_DOMAIN}`, "the CNAME target is core's label on the content domain");
  check(hostnamesRs.includes("pub const PROOF_EARLY_INTERVAL_MS: i64 = 60 * 1000;") && PROOF_LOOK_MS === 60_000 && PENDING_HOLD_MS >= 2 * PROOF_LOOK_MS, "the proof job looks each minute, and the hold outlasts two looks");
  check(hostnamesRs.includes("pub const PENDING_TTL_MS: i64 = 72 * 60 * 60 * 1000;") && hostnamesRs.includes("pub const RECHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;"), "the expiry and the recheck are 72 and 24 hours, so a run can't wait them out");
  const requestsRs = readFileSync(join(root, "crates/core/src/hostname_requests.rs"), "utf8");
  check(requestsRs.includes(`pub const GONE_SPAN_MS: i64 = ${GONE_SPAN_MS / 60_000} * 60 * 1000;`), "the gone reads' span is core's");
  check(requestsRs.includes("pub const MAX_REQUESTS_PER_HOUR: usize = 5;"), "a room may make 5 requests an hour; the run makes at most 2 in any room");
  const handle = readFileSync(join(root, "apps/content/src/handle.ts"), "utf8");
  check(handle.includes(`return custom ? "${CUSTOM_HSTS}" : "max-age=31536000; includeSubDomains";`), "a custom host's HSTS is the content Worker's");
  const apiHostname = readFileSync(join(root, "apps/api/src/workspace/hostname.rs"), "utf8");
  const codes = apiHostname.match(/error-codes: ([a-z_, ]+)/)?.[1].split(", ") ?? [];
  check(REFUSED_NAMES.every(({ code }) => codes.includes(code)), "every refusal code the run expects is one the API gives");
  check(REFUSED_NAMES.every(({ status, code }) => (status === 400) === ["hostname_invalid", "hostname_wildcard", "hostname_ip_address", "hostname_single_label"].includes(code)), "the name refusals are 400 for a name that isn't one, 409 otherwise, as the API maps them");
  check(REFUSED_BODIES.every(({ code }) => code === "invalid_argument"), "a body that isn't { hostname } is invalid_argument");
}

// ---- the reserved domains ----

{
  const without = hostnamesRs.replace(/(pub const RESERVED_DOMAINS: \[&str; )\d+(\] = \[)([^\]]*)\]/, (whole, a, b, list) => {
    const kept = list.split(",").map((s) => s.trim()).filter((s) => s && s !== `"${TEST_DOMAIN}"`);
    return `${a}${kept.length}${b}${kept.join(", ")}]`;
  });
  check(without !== hostnamesRs || reservedProblem(hostnamesRs) === null, "the test can make a list without the test domain");
  check(reservedProblem(without) === null, "a list without the test domain is no problem");
  check(/RESERVED_DOMAINS/.test(reservedProblem('pub const RESERVED_DOMAINS: [&str; 2] = [PODSTER_DOMAIN, "opster.dev"];') ?? ""), "a list naming the test domain is the problem, named");
  check(reservedProblem(null) !== null && reservedProblem("nothing") !== null, "an unread file, or one with no list, is a problem");
  check(reservedProblem(without, "podster.site") !== null && reservedProblem(without, "podster.dev") !== null, "the content domain and podster.dev are always reserved");
  console.log(`     this checkout: ${reservedProblem(hostnamesRs) ?? `${TEST_DOMAIN} isn't reserved`}`);
}

// ---- names ----

const LABEL = "cd-abc123xyz0";
const NAMES = runNames(LABEL);
{
  check(RUN_LABEL.test(runLabel(Buffer.from("0123456789abcdef"))) && runLabel(Buffer.alloc(10, 255)).length === 13, "a run's label is cd- and ten characters");
  check(NAMES.root === `${LABEL}.${TEST_DOMAIN}` && NAMES.main === NAMES.root && NAMES.race === `race.${NAMES.root}`, "the run's names are its root and race.<root>");
  check(refuses(() => runNames("cd-x")) && refuses(() => runNames("CD-abc123xyz0")), "a label that isn't the run's shape is refused");
  check(underRoot(NAMES.root, NAMES.root) && underRoot(`a.b.${NAMES.root}`, NAMES.root), "the root and names under it are the run's");
  const outside = [TEST_DOMAIN, `x.${TEST_DOMAIN}`, `*.${NAMES.root}`, `X.${NAMES.root}`, `${NAMES.root}.`, `${NAMES.root}.evil.example`, `evil${NAMES.root}`, `cd-zzzzzzzzzz.${TEST_DOMAIN}`, `a..${NAMES.root}`, `_x.${NAMES.root}`, "podster.dev", null];
  check(outside.every((name) => !underRoot(name, NAMES.root)), "the apex, other labels, wildcards, upper case, a trailing dot, look-alikes and underscores aren't");
  check(!underRoot(NAMES.root, `x.${TEST_DOMAIN}`) && !underRoot(TEST_DOMAIN, TEST_DOMAIN), "a root that isn't a cd- label under the test domain holds nothing");
  check(challengeUnderRoot(challengeName(NAMES.race), NAMES.root) && !challengeUnderRoot(NAMES.race, NAMES.root) && !challengeUnderRoot(challengeName(`x.${TEST_DOMAIN}`), NAMES.root), "a challenge's name is _podster-challenge.<a run name>");
}

// ---- the DNS guard ----

const ZONE = "0123456789abcdef0123456789abcdef";
const VALUE = "ab".repeat(32);
const base = `${CF_API}/zones/${ZONE}/dns_records`;
const MADE = "fedcba9876543210fedcba9876543210";
const ctx = { zoneId: ZONE, root: NAMES.root, made: new Set([MADE]) };
const body = (record) => JSON.stringify({ type: "TXT", name: challengeName(NAMES.main), content: txtContent(VALUE), ttl: DNS_TTL, proxied: false, ...record });
const cname = (record) => JSON.stringify({ type: "CNAME", name: NAMES.main, content: CNAME_TARGET, ttl: DNS_TTL, proxied: true, ...record });
{
  const allowed = (method, url, b) => !refuses(() => dnsAllow(method, url, b, ctx));
  check(allowed("POST", base, body()) && allowed("POST", base, body({ name: challengeName(NAMES.race) })), "a TXT challenge at a run name is allowed");
  check(allowed("POST", base, cname()) && allowed("POST", base, cname({ name: NAMES.race })), "a proxied CNAME to the fallback origin at a run name is allowed");
  check(allowed("DELETE", `${base}/${MADE}`) && allowed("GET", `${base}/${MADE}`), "a record the run made may be read and deleted");
  check(allowed("GET", `${base}?name=${NAMES.main}`) && allowed("GET", `${base}?name=${challengeName(NAMES.main)}`) && allowed("GET", `${CF_API}/user/tokens/verify`), "a listing of one run name, and the token's verification, may be read");
  const refusals = [
    ["another origin", "POST", `https://api.cloudflare.com.evil.example/client/v4/zones/${ZONE}/dns_records`, body()],
    ["another zone", "POST", `${CF_API}/zones/${"1".repeat(32)}/dns_records`, body()],
    ["credentials in the URL", "POST", base.replace("https://", "https://u:p@"), body()],
    ["a query on a create", "POST", `${base}?x=1`, body()],
    ["PUT", "PUT", `${base}/${MADE}`, cname()],
    ["PATCH", "PATCH", `${base}/${MADE}`, cname()],
    ["a TXT off the challenge's name", "POST", base, body({ name: NAMES.main })],
    ["a TXT at the apex's challenge", "POST", base, body({ name: challengeName(TEST_DOMAIN) })],
    ["a TXT with other content", "POST", base, body({ content: '"v=spf1 -all"' })],
    ["a TXT unquoted", "POST", base, body({ content: VALUE })],
    ["a TXT proxied", "POST", base, body({ proxied: true })],
    ["a CNAME elsewhere", "POST", base, cname({ content: "evil.example" })],
    ["a CNAME not proxied", "POST", base, cname({ proxied: false })],
    ["a CNAME at the apex", "POST", base, cname({ name: TEST_DOMAIN })],
    ["a CNAME at a wildcard", "POST", base, cname({ name: `*.${NAMES.root}` })],
    ["a CNAME at another name of the zone", "POST", base, cname({ name: `www.${TEST_DOMAIN}` })],
    ["an MX", "POST", base, cname({ type: "MX", content: "mail.example" })],
    ["an NS", "POST", base, cname({ type: "NS", content: "ns.example" })],
    ["an A", "POST", base, cname({ type: "A", content: "192.0.2.1" })],
    ["another field", "POST", base, JSON.stringify({ ...JSON.parse(cname()), comment: "x" })],
    ["another TTL", "POST", base, cname({ ttl: 1 })],
    ["a body that isn't JSON", "POST", base, "nope"],
    ["a delete of a record it didn't make", "DELETE", `${base}/${"2".repeat(32)}`, undefined],
    ["a delete with a query", "DELETE", `${base}/${MADE}?x=1`, undefined],
    ["a delete with a body", "DELETE", `${base}/${MADE}`, "{}"],
    ["a listing of another name", "GET", `${base}?name=www.${TEST_DOMAIN}`, undefined],
    ["a listing of the whole zone", "GET", base, undefined],
    ["a listing with another parameter", "GET", `${base}?name=${NAMES.main}&type=MX`, undefined],
    ["a read of a record it didn't make", "GET", `${base}/${"2".repeat(32)}`, undefined],
    ["the zone itself", "GET", `${CF_API}/zones/${ZONE}`, undefined],
    ["the token verification with a query", "GET", `${CF_API}/user/tokens/verify?x=1`, undefined],
  ];
  const leaked = refusals.filter(([, method, url, b]) => allowed(method, url, b)).map(([what]) => what);
  check(leaked.length === 0, `every other request is refused${leaked.length ? ` (allowed: ${leaked.join(", ")})` : ""}`);
  check(refuses(() => dnsAllow("POST", base, body(), { ...ctx, zoneId: "nope" })) && refuses(() => dnsAllow("POST", base, body(), { ...ctx, root: TEST_DOMAIN })), "without a zone ID or a run root, nothing is sent");
  check(adoptable({ id: MADE, type: "TXT", name: challengeName(NAMES.main) }, NAMES.root) && adoptable({ id: MADE, type: "CNAME", name: NAMES.race }, NAMES.root), "a listed TXT or CNAME under the root is the run's");
  check(!adoptable({ id: MADE, type: "MX", name: NAMES.main }, NAMES.root) && !adoptable({ id: MADE, type: "CNAME", name: `www.${TEST_DOMAIN}` }, NAMES.root) && !adoptable({ id: "x", type: "CNAME", name: NAMES.main }, NAMES.root), "anything else listed isn't");
}

// ---- the DNS client, against a stand-in fetch ----

{
  const TOKEN = "t".repeat(40);
  const sent = [];
  const lines = [];
  const zone = new Map();
  let lose = false;
  let ids = 0;
  const fake = async (url, init) => {
    const u = new URL(url);
    sent.push({ method: init.method, url, auth: init.headers.authorization });
    const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/user/tokens/verify")) return reply(200, { success: true, result: { status: "active" } });
    if (init.method === "POST") {
      const r = JSON.parse(init.body);
      const id = (++ids).toString(16).padStart(32, "0");
      zone.set(id, { id, type: r.type, name: r.name, content: r.content });
      if (lose) throw new TypeError("fetch failed");
      return reply(200, { success: true, result: { id } });
    }
    if (init.method === "DELETE") return reply(zone.delete(u.pathname.split("/").at(-1)) ? 200 : 404, { success: true });
    if (init.method === "GET") return reply(200, { success: true, result: [...zone.values()].filter((r) => r.name === u.searchParams.get("name")) });
    return reply(400, { success: false });
  };
  // Something else in the zone, which the run must never touch.
  zone.set("e".repeat(32), { id: "e".repeat(32), type: "A", name: `www.${TEST_DOMAIN}`, content: "192.0.2.1" });
  const dns = dnsClient({ token: TOKEN, zoneId: ZONE, root: NAMES.root, fetch: fake, log: (line) => lines.push(line) });
  check((await dns.verify()) === true, "the token's verification reads active");
  const txt = await dns.txt(NAMES.main, VALUE);
  await dns.cname(NAMES.main);
  check(dns.made.size === 2 && zone.get(txt)?.content === txtContent(VALUE) && sent.every((r) => r.auth === `Bearer ${TOKEN}`), "a TXT and a CNAME are made and noted, with the token as a bearer header");
  const before = sent.length;
  let thrown = 0;
  for (const attempt of [() => dns.create("TXT", challengeName(`x.${TEST_DOMAIN}`), txtContent(VALUE), false), () => dns.create("MX", NAMES.main, "m.example", false), () => dns.txt(NAMES.main, "not-hex"), () => dns.remove("e".repeat(32))]) {
    try {
      await attempt();
    } catch {
      thrown++;
    }
  }
  check(thrown === 4 && sent.length === before && !dns.tried.has(challengeName(`x.${TEST_DOMAIN}`)), "a refused create or delete sends nothing and notes nothing");
  lose = true;
  let lostThrew = false;
  try {
    await dns.txt(NAMES.race, VALUE);
  } catch {
    lostThrew = true;
  }
  lose = false;
  check(lostThrew && dns.made.size === 2 && dns.tried.has(challengeName(NAMES.race)), "a create whose answer is lost throws, and its name is kept for clean-up");
  const { left, unread, held } = await dns.removeAll();
  check(left.length === 0 && unread.length === 0 && held.length === 0 && dns.made.size === 0, "clean-up deletes every record made, adopts the lost one from a listing, and lists every name empty");
  check(zone.size === 1 && zone.has("e".repeat(32)), "the zone's other record is untouched");
  check(sent.filter((r) => r.method === "DELETE").length === 3, "it deleted exactly the run's three records");
  check(lines.length > 0 && lines.every((line) => !line.includes(TOKEN) && !line.includes(ZONE) && !line.includes("https://")), "its log lines carry neither the token, the zone's ID nor a URL");
}

// ---- the configuration and judging ----

{
  const env = { OPSTER_DNS_TOKEN: "a".repeat(40), OPSTER_ZONE_ID: ZONE };
  check(dnsEnvProblem(env) === null, "a token and a zone ID shaped right are no problem");
  const problems = [dnsEnvProblem({}), dnsEnvProblem({ ...env, OPSTER_DNS_TOKEN: "short" }), dnsEnvProblem({ ...env, OPSTER_ZONE_ID: "" }), dnsEnvProblem({ ...env, OPSTER_ZONE_ID: "Z".repeat(32) })];
  check(problems.every(Boolean) && problems.every((p) => !p.includes("short") && !p.includes("Z".repeat(32))), "each missing or misshapen value is a problem that doesn't name it");

  const req = { id: "hrq_1", hostname: NAMES.main, state: "pending", setup_status: "proof_pending", challenge_name: challengeName(NAMES.main), challenge_value: VALUE, cname_target: CNAME_TARGET, requested_by: "per_x", requested_at: 1, expires_at: 2, end_reason: null };
  check(requestProblem(req, { hostname: NAMES.main, state: "pending", setup: "proof_pending" }) === null, "a pending request as asked for passes");
  check(requestProblem(req, { hostname: NAMES.race }) !== null && requestProblem({ ...req, cname_target: "evil.example" }, { hostname: NAMES.main }) !== null && requestProblem({ ...req, challenge_name: NAMES.main }, { hostname: NAMES.main }) !== null && requestProblem({ ...req, challenge_value: "x" }, { hostname: NAMES.main }) !== null, "another name, another CNAME target, another challenge name or a bad value fails");
  check(requestProblem(req, { hostname: NAMES.main, state: "claimed" }) !== null && requestProblem(req, { hostname: NAMES.main, setup: "active" }) !== null && requestProblem(null, { hostname: NAMES.main }) !== null, "another state or setup, or none, fails");

  const claimed = { ...req, state: "claimed" };
  const refused = { ...req, state: "refused", end_reason: "hostname_claimed_elsewhere" };
  check(raceOutcome(claimed, refused).winner === "a" && raceOutcome(refused, claimed).winner === "b" && raceOutcome(refused, claimed).reason === "hostname_claimed_elsewhere", "one claimed and one refused names the winner and the reason");
  check(Boolean(raceOutcome(claimed, claimed).problem) && Boolean(raceOutcome(refused, refused).problem) && Boolean(raceOutcome(claimed, req).problem) && Boolean(raceOutcome(claimed, { ...refused, end_reason: null }).problem) && Boolean(raceOutcome(claimed, { ...req, state: "expired" }).problem), "both claimed, neither, one pending, a refusal with no reason or another end fails");

  const good = [["referrer-policy", "no-referrer"], ["x-content-type-options", "nosniff"], ["strict-transport-security", CUSTOM_HSTS], ["content-security-policy", "sandbox allow-scripts; default-src 'self'"]];
  check(customHeaderProblems(good).length === 0, "a custom host's fixed headers pass");
  check(customHeaderProblems(good.map(([n, v]) => [n, n === "strict-transport-security" ? "max-age=31536000; includeSubDomains" : v])).length === 1, "includeSubDomains on a custom host fails");
  check(customHeaderProblems([...good, ["set-cookie", "a=1"]]).length === 1 && customHeaderProblems(good.filter(([n]) => n !== "content-security-policy")).length === 1, "a cookie, or no sandbox, fails");

  const cert = { subject: { CN: NAMES.main }, subjectaltname: `DNS:${NAMES.main}`, issuer: { O: "Google Trust Services", CN: "WE1" }, valid_from: "a", valid_to: "b", authorized: true };
  check(certificateLine(cert, NAMES.main).startsWith("names the host") && certificateLine(cert, NAMES.main).includes("trusted by Node"), "a certificate naming the host says so");
  check(certificateLine({ ...cert, subjectaltname: `DNS:*.${TEST_DOMAIN}` }, NAMES.main).startsWith("names the host") && certificateLine({ ...cert, subjectaltname: `DNS:*.${TEST_DOMAIN}` }, NAMES.race).startsWith("does NOT"), "a wildcard covers one label only");
  check(certificateLine(null, NAMES.main) === "no certificate was read" && certificateLine({ ...cert, authorized: false, authorizationError: "CERT_HAS_EXPIRED" }, NAMES.main).includes("not trusted"), "no certificate, or one not trusted, says so");
}

// ---- the script's source ----

{
  const script = readFileSync(join(here, "m6-custom-domain-staging.mjs"), "utf8");
  check(!/spawn\(/.test(script) && !/playwright/.test(script) && !/gh run|npx /.test(script), "the script starts no process and no browser, and runs no gh run or npx: git is m6-release-run.mjs's");
  check(!script.includes("api.cloudflare.com") && (script.match(/dnsClient\(/g) ?? []).length === 1, "it reaches Cloudflare only through the one guarded DNS client");
  check(/delete process\.env\.OPSTER_DNS_TOKEN;/.test(script) && /delete process\.env\.OPSTER_ZONE_ID;/.test(script) && /run\.secret\(dnsToken\)/.test(script) && /run\.secret\(zoneId\)/.test(script), "the token and the zone's ID leave the environment and are scrubbed from the output");
  check(script.includes("dns.removeAll()") && /owner\.dash\("DELETE", hostnamePath\(room\)/.test(script) && script.includes("publisher.stop()") && script.includes("cleanUpShared()") && /enabled: false/.test(script), "clean-up removes each open hostname request, every DNS record, release and the rooms' publicity, then the shared clean-up");
  check(script.indexOf("for (const room of asked)") < script.indexOf("dns.removeAll()"), "clean-up ends the claims through the API before it deletes DNS");
  check(script.includes('run.mask(owner.id, "[owner]")') && script.includes('run.mask(admin.id, "[admin]")'), "both people's IDs are printed as their role");
  check(script.indexOf("dns.verify()") < script.indexOf("await main()") && script.indexOf("run.preflight()") < script.indexOf("dns.verify()"), "the DNS token is checked after the signed-out preflight and before any sign-up");
}

// ---- the script itself ----

const contract = readFileSync(join(root, "packages/contracts/openapi.yaml"), "utf8");
const noGrant = join(scratch, "openapi-no-deploy.yaml");
writeFileSync(noGrant, contract.replace(/(action: \{ type: string, enum: \[)([^\]]*)\]/g, (whole, start, list) => `${start}${list.split(",").map((v) => v.trim()).filter((v) => v !== "deploy").join(", ")}]`));
const open = join(scratch, "hostnames-open.rs");
writeFileSync(open, hostnamesRs.replace(/(pub const RESERVED_DOMAINS: \[&str; )\d+(\] = \[)([^\]]*)\]/, (whole, a, b, list) => {
  const kept = list.split(",").map((s) => s.trim()).filter((s) => s && s !== `"${TEST_DOMAIN}"`);
  return `${a}${kept.length}${b}${kept.join(", ")}]`;
}));
const closed = join(scratch, "hostnames-closed.rs");
writeFileSync(closed, 'pub const RESERVED_DOMAINS: [&str; 3] = [PODSTER_DOMAIN, "opster.dev", "podster.site"];\n');
const SECRET = "x".repeat(40);
const TOKEN = "T".repeat(40);
const ZONE_ID = "9".repeat(32);
/** Runs the script, with the stand-in in `mode` when given. Answers its exit code, its output and the stand-in's counts. */
function script(args, { mode, secret = SECRET, dns = true } = {}) {
  const env = { PATH: process.env.PATH, HOME: scratch, ...(secret ? { PODSTER_E2E_SIGNUP_SECRET: secret } : {}), ...(dns ? { OPSTER_DNS_TOKEN: TOKEN, OPSTER_ZONE_ID: ZONE_ID } : {}), ...(mode ? { M6_RELEASE_STANDIN: mode } : {}) };
  const preload = mode ? ["--import", join(here, "m6-release-staging-standin.mjs")] : [];
  const done = spawnSync(process.execPath, [...preload, join(here, "m6-custom-domain-staging.mjs"), ...args], { cwd: here, env, encoding: "utf8", timeout: 60_000 });
  const out = `${done.stdout}${done.stderr}`;
  const counted = out.match(/stand-in: (\d+) requests, (\d+) sign-ups, (\d+) sign-outs/);
  return { code: done.status, out, requests: counted ? Number(counted[1]) : null, signUps: counted ? Number(counted[2]) : null, signOuts: counted ? Number(counted[3]) : null };
}
const hidden = (out) => !out.includes(SECRET) && !out.includes(TOKEN) && !out.includes(ZONE_ID);
const at = ["--base-url", STAGING];
const openAt = [...at, "--core-hostnames", open];
try {
  {
    const help = script(["--help"], { secret: null, dns: false });
    check(help.code === 0 && /^Usage:/m.test(help.out), "--help prints the usage and exits 0");
    check(script(["--base-url", "https://example.com"]).code === EXIT.refused, "another host exits 2");
  }
  {
    const dry = script([...openAt, "--dry-run"], { mode: "edge-down" });
    check(dry.code === 0 && dry.out.includes("Nothing was sent") && dry.requests === 0 && hidden(dry.out), "a dry run with the test domain unreserved exits 0, sends nothing and prints no secret");
    check(PLAN.every((entry) => dry.out.includes(entry.id)) && dry.out.includes("[out of scope:") && dry.out.includes("[recorded, not judged:"), "the dry run prints every check, marking the out-of-scope and recorded ones");
    check(/cd-[a-z0-9]{10}\.opster\.dev/.test(dry.out), "the dry run names this run's label under the test domain");
    const reserved = script([...at, "--dry-run", "--core-hostnames", closed], { mode: "edge-down" });
    check(reserved.code === EXIT.releaseNotOn && reserved.out.includes("RESERVED_DOMAINS") && reserved.requests === 0, "with the test domain reserved, it exits 3 naming RESERVED_DOMAINS and sends nothing");
    const current = script([...at, "--dry-run"], { mode: "edge-down" });
    const expected = reservedProblem(hostnamesRs) ? EXIT.releaseNotOn : 0;
    check(current.code === expected && current.requests === 0, `on this checkout's reserved list a dry run exits ${expected}`);
    const missingGrant = script([...openAt, "--dry-run", "--contract", noGrant], { mode: "edge-down" });
    check(missingGrant.code === EXIT.releaseNotOn && missingGrant.out.includes("no route gives a deploy grant") && missingGrant.requests === 0, "a contract without the deploy grant exits 3, naming it, and sends nothing");
    const noDns = script([...openAt, "--dry-run"], { mode: "edge-down", dns: false });
    check(noDns.code === EXIT.refused && noDns.out.includes("OPSTER_DNS_TOKEN") && noDns.requests === 0, "a dry run without the DNS settings exits 2, naming them");
    const realNoDns = script(openAt, { mode: "edge-down", dns: false });
    check(realNoDns.code === EXIT.refused && realNoDns.requests === 0, "a real run without the DNS settings exits 2 and sends nothing");
    const realNoSecret = script(openAt, { mode: "edge-down", secret: null });
    check(realNoSecret.code === EXIT.refused && realNoSecret.requests === 0, "a real run without the sign-up secret exits 2 and sends nothing");
  }
  {
    const down = script(openAt, { mode: "edge-down" });
    check(down.code === EXIT.refused && down.signUps === 0 && down.out.includes("No sign-up was taken"), "an edge that answers 502 fails the preflight: exit 2, no sign-up");
    const off = script(openAt, { mode: "off" });
    check(off.code === EXIT.releaseNotOn && off.signUps === 0 && off.out.includes("deploy_release"), "release off on staging: exit 3, no sign-up, naming deploy_release");
    const noContent = script(openAt, { mode: "no-content" });
    check(noContent.code === EXIT.releaseNotOn && noContent.signUps === 0 && noContent.out.includes(CONTENT_DOMAIN), "no content Worker on the content domain: exit 3, no sign-up");
    // The stand-in answers staging and the content domain, and refuses Cloudflare's API: the DNS check fails.
    const noDnsAnswer = script(openAt, { mode: "not-available" });
    check(noDnsAnswer.code === EXIT.refused && noDnsAnswer.signUps === 0 && noDnsAnswer.out.includes("DNS token") && noDnsAnswer.out.includes("nothing was written"), "a DNS token Cloudflare doesn't accept: exit 2, no sign-up, nothing written");
    check(hidden(noDnsAnswer.out) && hidden(off.out) && hidden(down.out), "neither the sign-up secret, the DNS token nor the zone's ID reaches the output");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} case(s) failed.` : "\nm6-custom-domain-staging-selftest: every case passed.");
process.exit(failed ? 1 : 0);
