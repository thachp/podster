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
  adoptable, CERT_MAX_AGE_MS, certificateLine, certificateProblem, CF_API, CNAME_MODES, cnameProxied, DEFAULT_CNAME_MODE, planFor, CHALLENGE_PREFIX, challengeName, challengeUnderRoot, CNAME_TARGET, CONTENT_DOMAIN, CUSTOM_HSTS, customHeaderProblems, dnsAllow, dnsClient, dnsEnvProblem, DNS_TTL, EXIT, GONE_SPAN_MS, parseArgs, PENDING_HOLD_MS, PLAN, PROOF_LOOK_MS, RACE_SETTLE_MS, raceOutcome,
  authoritativeLookup, deleteRecordsLine, isManualDomain, manualName, manualRecords, MANUAL_CHECKS, MANUAL_CLAIM_WAIT_S, MANUAL_DNS_WAIT_MS, MANUAL_DOMAINS, MANUAL_POLL_MS, MANUAL_REPRINT_MS, MANUAL_SOA_MINIMUM_S, recordBlock, recordsSeen, TEST_DOMAINS,
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
  check(JSON.stringify(PLAN.filter((e) => e.outOfScope).map((e) => e.id)) === '["X14-6","X26-2","X26-3"]', "three checks are out of scope (the freed claim, the 72-hour expiry, the 24-hour recheck)");
  const proxiedPlan = planFor("proxied");
  check(DEFAULT_CNAME_MODE === "dns-only" && JSON.stringify(CNAME_MODES) === '["dns-only","proxied"]' && JSON.stringify(PLAN) === JSON.stringify(planFor("dns-only")), "the default plan is the DNS-only one");
  check(PLAN.every((e) => !e.recordOnly) && JSON.stringify(proxiedPlan.filter((e) => e.recordOnly).map((e) => e.id)) === '["X14-4"]' && /orange-to-orange/.test(proxiedPlan.find((e) => e.id === "X14-4").recordOnly), "with a DNS-only CNAME the certificate (X14-4) is judged; with a proxied one it is only recorded, saying orange-to-orange");
  check(JSON.stringify(proxiedPlan.map((e) => e.id)) === JSON.stringify(ids) && proxiedPlan.every((e, i) => e.title === PLAN[i].title && e.outOfScope === PLAN[i].outOfScope), "the two modes' plans differ only in whether X14-4 is judged");
  check(refuses(() => planFor("orange")) && refuses(() => planFor(undefined)) && refuses(() => cnameProxied("")) && cnameProxied("proxied") === true && cnameProxied("dns-only") === false, "a mode that isn't one of the two is refused, never guessed");
  {
    const results = new Results(proxiedPlan, () => {});
    for (const entry of proxiedPlan) results.add(entry.id, entry.outOfScope ? "outOfScope" : entry.recordOnly ? "recorded" : "pass", "");
    check(runOutcome(results, proxiedPlan).code === 0, "a proxied run with every judged check passed exits 0, the certificate recorded");
    const dnsOnly = new Results(PLAN, () => {});
    for (const entry of PLAN) dnsOnly.add(entry.id, entry.outOfScope ? "outOfScope" : entry.id === "X14-4" ? "fail" : "pass", "");
    check(runOutcome(dnsOnly, PLAN).code === 1 && JSON.stringify(runOutcome(dnsOnly, PLAN).failed) === '["X14-4"]', "a DNS-only run whose certificate check failed fails, naming X14-4");
  }
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
  check(parseArgs(["--base-url", STAGING]).options?.cnameMode === "dns-only" && parseArgs(["--base-url", STAGING, "--cname-mode", "proxied"]).options?.cnameMode === "proxied" && parseArgs(["--base-url", STAGING, "--cname-mode", "dns-only"]).options?.cnameMode === "dns-only", "the CNAME mode defaults to dns-only, and proxied is an option");
  check(["true", "PROXIED", "dns_only", "", "proxied;x"].every((mode) => Boolean(parseArgs(["--base-url", STAGING, "--cname-mode", mode]).error)) && Boolean(parseArgs(["--base-url", STAGING, "--cname-mode"]).error), "any other CNAME mode, or none, is refused");
  check(Boolean(parseArgs(["--base-url", STAGING, "--serve-wait", "5"]).error) && Boolean(parseArgs(["--base-url", STAGING, "--claim-wait"]).error) && Boolean(parseArgs(["--base-url", STAGING, "--zone", "x"]).error), "a wait out of bounds, a missing value or an unknown flag is refused");
}

// ---- the figures, read where they are set ----

const hostnamesRs = readFileSync(join(root, "crates/core/src/hostnames.rs"), "utf8");
{
  check(hostnamesRs.includes(`pub const CHALLENGE_PREFIX: &str = "${CHALLENGE_PREFIX}";`), "the challenge's prefix is core's");
  check(hostnamesRs.includes('pub const CNAME_TARGET_LABEL: &str = "fallback";') && CNAME_TARGET === `fallback.${CONTENT_DOMAIN}`, "the CNAME target is core's label on the content domain");
  check(hostnamesRs.includes("pub const PROOF_EARLY_INTERVAL_MS: i64 = 60 * 1000;") && PROOF_LOOK_MS === 60_000 && PENDING_HOLD_MS >= 2 * PROOF_LOOK_MS, "the proof job looks each minute, and the hold outlasts two looks");
  check(RACE_SETTLE_MS >= DNS_TTL * 1000 + 2 * PROOF_LOOK_MS, "the race is waited for past the placeholder's TTL and two looks");
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
const ctx = { zoneId: ZONE, root: NAMES.root, made: new Set([MADE]), cnameMode: "dns-only" };
const proxiedCtx = { ...ctx, cnameMode: "proxied" };
const body = (record) => JSON.stringify({ type: "TXT", name: challengeName(NAMES.main), content: txtContent(VALUE), ttl: DNS_TTL, proxied: false, ...record });
const cname = (record) => JSON.stringify({ type: "CNAME", name: NAMES.main, content: CNAME_TARGET, ttl: DNS_TTL, proxied: false, ...record });
{
  const allowed = (method, url, b) => !refuses(() => dnsAllow(method, url, b, ctx));
  check(allowed("POST", base, body()) && allowed("POST", base, body({ name: challengeName(NAMES.race) })), "a TXT challenge at a run name is allowed");
  check(allowed("POST", base, cname()) && allowed("POST", base, cname({ name: NAMES.race })), "in dns-only mode, a DNS-only CNAME to the fallback origin at a run name is allowed");
  const allowedProxied = (b) => !refuses(() => dnsAllow("POST", base, b, proxiedCtx));
  check(allowedProxied(cname({ proxied: true })) && allowedProxied(cname({ proxied: true, name: NAMES.race })), "in proxied mode, a proxied CNAME to the fallback origin at a run name is allowed");
  check(!allowed("POST", base, cname({ proxied: true })), "in dns-only mode, a proxied CNAME is refused");
  check(!allowedProxied(cname({ proxied: false })), "in proxied mode, a DNS-only CNAME is refused");
  check([undefined, null, "1", 1, 0, "true"].every((proxied) => !allowed("POST", base, cname({ proxied })) && !allowedProxied(cname({ proxied }))), "in either mode, a CNAME whose proxied isn't exactly the mode's boolean is refused");
  check([undefined, "", "orange", "PROXIED"].every((cnameMode) => refuses(() => dnsAllow("POST", base, cname(), { ...ctx, cnameMode })) && refuses(() => dnsAllow("POST", base, cname({ proxied: true }), { ...ctx, cnameMode }))), "without one of the two modes, no CNAME is allowed");
  check(allowedProxied(body()) && !allowedProxied(body({ proxied: true })) && allowedProxied(cname({ proxied: true, ttl: DNS_TTL })) && !allowedProxied(cname({ proxied: true, ttl: 1 })), "the TXT and TTL guards are the same in proxied mode");
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
    ["a CNAME proxied in dns-only mode", "POST", base, cname({ proxied: true })],
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
      zone.set(id, { id, type: r.type, name: r.name, content: r.content, proxied: r.proxied });
      if (lose) throw new TypeError("fetch failed");
      return reply(200, { success: true, result: { id } });
    }
    if (init.method === "DELETE") return reply(zone.delete(u.pathname.split("/").at(-1)) ? 200 : 404, { success: true });
    if (init.method === "GET") return reply(200, { success: true, result: [...zone.values()].filter((r) => r.name === u.searchParams.get("name")) });
    return reply(400, { success: false });
  };
  // Something else in the zone, which the run must never touch.
  zone.set("e".repeat(32), { id: "e".repeat(32), type: "A", name: `www.${TEST_DOMAIN}`, content: "192.0.2.1" });
  const dns = dnsClient({ token: TOKEN, zoneId: ZONE, root: NAMES.root, cnameMode: "dns-only", fetch: fake, log: (line) => lines.push(line) });
  check(refuses(() => dnsClient({ token: TOKEN, zoneId: ZONE, root: NAMES.root, fetch: fake })) && refuses(() => dnsClient({ token: TOKEN, zoneId: ZONE, root: NAMES.root, cnameMode: "orange", fetch: fake })), "a DNS client needs one of the two CNAME modes");
  check((await dns.verify()) === true, "the token's verification reads active");
  const txt = await dns.txt(NAMES.main, VALUE);
  const madeCname = await dns.cname(NAMES.main);
  check(zone.get(madeCname)?.proxied === false && zone.get(txt)?.proxied === false, "in dns-only mode the client makes the CNAME not proxied");
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
  const quick = dnsClient({ token: TOKEN, zoneId: ZONE, root: NAMES.root, cnameMode: "proxied", fetch: fake, log: () => {} });
  const quickCname = await quick.cname(NAMES.race);
  check(zone.get(quickCname)?.proxied === true, "in proxied mode the client makes the CNAME proxied");
  check((await quick.removeMade()) === 0 && quick.made.size === 0, "the SIGTERM clean-up deletes every record held, with no listing");
  const { left, unread, held } = await dns.removeAll();
  check(left.length === 0 && unread.length === 0 && held.length === 0 && dns.made.size === 0, "clean-up deletes every record made, adopts the lost one from a listing, and lists every name empty");
  check(zone.size === 1 && zone.has("e".repeat(32)), "the zone's other record is untouched");
  check(sent.filter((r) => r.method === "DELETE").length === 4, "it deleted exactly the runs' four records");
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
  const BC = ["B", "C"];
  check(raceOutcome(claimed, refused, BC).winner === "B" && raceOutcome(refused, claimed, BC).winner === "C" && raceOutcome(refused, claimed, BC).reason === "hostname_claimed_elsewhere", "one claimed and one refused names the winning room by its label, not its position, and the reason (run 45803085099 said room A for rooms B and C)");
  check(Boolean(raceOutcome(claimed, refused).problem) && Boolean(raceOutcome(claimed, refused, ["B"]).problem) && Boolean(raceOutcome(claimed, refused, ["B", "B"]).problem), "a race whose two rooms aren't named, or are named alike, fails");
  check(Boolean(raceOutcome(claimed, claimed, BC).problem) && Boolean(raceOutcome(refused, refused, BC).problem) && Boolean(raceOutcome(claimed, req, BC).problem) && Boolean(raceOutcome(claimed, { ...refused, end_reason: null }, BC).problem) && Boolean(raceOutcome(claimed, { ...req, state: "expired" }, BC).problem), "both claimed, neither, one pending, a refusal with no reason or another end fails");

  const good = [["referrer-policy", "no-referrer"], ["x-content-type-options", "nosniff"], ["strict-transport-security", CUSTOM_HSTS], ["content-security-policy", "sandbox allow-scripts; default-src 'self'"]];
  check(customHeaderProblems(good).length === 0, "a custom host's fixed headers pass");
  check(customHeaderProblems(good.map(([n, v]) => [n, n === "strict-transport-security" ? "max-age=31536000; includeSubDomains" : v])).length === 1, "includeSubDomains on a custom host fails");
  check(customHeaderProblems([...good, ["set-cookie", "a=1"]]).length === 1 && customHeaderProblems(good.filter(([n]) => n !== "content-security-policy")).length === 1, "a cookie, or no sandbox, fails");

  const cert = { subject: { CN: NAMES.main }, subjectaltname: `DNS:${NAMES.main}`, issuer: { O: "Google Trust Services", CN: "WE1" }, valid_from: "a", valid_to: "b", authorized: true };
  check(certificateLine(cert, NAMES.main).startsWith("names the host") && certificateLine(cert, NAMES.main).includes("trusted by Node"), "a certificate naming the host says so");
  check(certificateLine({ ...cert, subjectaltname: `DNS:*.${TEST_DOMAIN}` }, NAMES.main).startsWith("names the host") && certificateLine({ ...cert, subjectaltname: `DNS:*.${TEST_DOMAIN}` }, NAMES.race).startsWith("does NOT"), "a wildcard covers one label only");
  check(certificateLine(null, NAMES.main) === "no certificate was read" && certificateLine({ ...cert, authorized: false, authorizationError: "CERT_HAS_EXPIRED" }, NAMES.main).includes("not trusted"), "no certificate, or one not trusted, says so");
  check(certificateLine({ handshakeError: "CERT_HAS_EXPIRED" }, NAMES.main).includes("validation on failed: CERT_HAS_EXPIRED"), "a handshake that fails validation records its error as the finding");

  // X14-4 with a DNS-only CNAME: the custom hostname's own certificate, judged.
  const NOW = Date.parse("2026-11-26T12:00:00Z");
  const own = { ...cert, valid_from: "Nov 26 10:00:00 2026 GMT", valid_to: "Feb 24 10:00:00 2027 GMT" };
  const judge = (c, host = NAMES.main) => certificateProblem(c, host, { now: NOW });
  check(judge(own) === null, "an exact-host certificate, trusted and issued today, passes");
  check(judge({ ...own, subjectaltname: `DNS:${NAMES.main}, DNS:${NAMES.race}` }) === null && judge({ ...own, subjectaltname: `DNS:${NAMES.main.toUpperCase()}` }) === null, "other names of the run beside it, or the host in upper case, still pass");
  check(/wildcard isn't enough/.test(judge({ ...own, subjectaltname: `DNS:*.${TEST_DOMAIN}` }) ?? ""), "a wildcard-only certificate fails, though it covers the host");
  check(/test zone's own/.test(judge({ ...own, subjectaltname: `DNS:${TEST_DOMAIN}, DNS:*.${TEST_DOMAIN}, DNS:${NAMES.main}` }) ?? "") && /test zone's own/.test(judge({ ...own, subjectaltname: `DNS:${NAMES.main}, DNS:*.${TEST_DOMAIN}` }) ?? ""), "the test zone's universal certificate fails, even naming the host");
  check(/hours ago/.test(judge({ ...own, valid_from: "Nov 23 10:00:00 2026 GMT" }) ?? "") && judge({ ...own, valid_from: new Date(NOW - CERT_MAX_AGE_MS + 60_000).toUTCString() }) === null, "a certificate issued more than 2 days ago fails; one just inside passes");
  check(/trust/.test(judge({ ...own, authorized: false, authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) ?? "") && /trust/.test(judge({ ...own, authorized: undefined }) ?? ""), "a certificate Node doesn't trust, or one with no verdict, fails");
  check(judge({ ...own, valid_from: "Dec 26 10:00:00 2026 GMT" }) !== null && judge({ ...own, valid_to: "Nov 26 11:00:00 2026 GMT" }) !== null && judge({ ...own, valid_from: "?" }) !== null, "one not yet valid, expired, or with dates unread fails");
  check(judge({ handshakeError: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" }) !== null && judge(null) !== null && judge({ ...own, subjectaltname: `DNS:${NAMES.race}` }) !== null, "a failed handshake, no certificate, or one for another run name fails");
}

// ---- manual-DNS mode: the input and the allow-list ----

const MANUAL_LABEL = "cd-abc123xyz0";
const MANUAL_NAMES = runNames(MANUAL_LABEL, "war3.org");
{
  check(JSON.stringify(MANUAL_DOMAINS) === '["war3.org"]' && Object.isFrozen(MANUAL_DOMAINS) && JSON.stringify(TEST_DOMAINS) === '["opster.dev","war3.org"]' && Object.isFrozen(TEST_DOMAINS), "war3.org is the one manual domain, hard-coded in a frozen allow-list beside opster.dev");
  check(isManualDomain("war3.org") && ["opster.dev", "WAR3.ORG", "war3.org.", "x.war3.org", "example.com", "", undefined].every((d) => !isManualDomain(d)), "only war3.org itself is a manual domain");
  const def = parseArgs(["--base-url", STAGING]).options;
  const manual = parseArgs(["--base-url", STAGING, "--test-domain", "war3.org"]).options;
  check(def?.testDomain === TEST_DOMAIN && def.manual === false && manual?.testDomain === "war3.org" && manual.manual === true && manual.cnameMode === "dns-only", "the test domain defaults to opster.dev; --test-domain war3.org is manual mode, DNS-only");
  check(["example.com", "WAR3.ORG", "war3.org.", "x.war3.org", "", "war3.org;x", "podster.site"].every((d) => Boolean(parseArgs(["--base-url", STAGING, "--test-domain", d]).error)) && Boolean(parseArgs(["--base-url", STAGING, "--test-domain"]).error), "any other test domain, or none, is refused");
  check(/proxied/.test(parseArgs(["--base-url", STAGING, "--test-domain", "war3.org", "--cname-mode", "proxied"]).error ?? ""), "manual mode with a proxied CNAME is refused");
  check(MANUAL_NAMES.main === `${MANUAL_LABEL}.war3.org` && MANUAL_NAMES.race === null && MANUAL_NAMES.domain === "war3.org" && refuses(() => runNames(MANUAL_LABEL, "example.com")), "manual mode's one name is cd-<random>.war3.org, with no race name; another domain is refused");
  check(manualName(MANUAL_NAMES.main) && [`x.${MANUAL_NAMES.main}`, "war3.org", "cd-short.war3.org", `CD-ABC123XYZ0.war3.org`, `${MANUAL_LABEL}.opster.dev`, `${MANUAL_LABEL}.war3.org.evil.example`, `${MANUAL_LABEL}.war3.org.`, null].every((n) => !manualName(n)), "a manual name is exactly cd-<10 characters>.war3.org");
  const manualPlan = planFor("dns-only", "war3.org");
  check(JSON.stringify(manualPlan.filter((e) => !e.outOfScope && !e.recordOnly).map((e) => e.id)) === JSON.stringify(MANUAL_CHECKS) && JSON.stringify(MANUAL_CHECKS) === '["X14-2","X14-3","X14-4","X14-5"]', "manual mode judges X14-2, X14-3, X14-4 and X14-5, and nothing else");
  check(manualPlan.filter((e) => !MANUAL_CHECKS.includes(e.id)).every((e) => /^not in manual mode/.test(e.outOfScope ?? "")) && manualPlan.every((e) => !e.recordOnly), "every other check says it isn't in manual mode");
  check(refuses(() => planFor("proxied", "war3.org")) && refuses(() => planFor("dns-only", "example.com")) && JSON.stringify(planFor("dns-only", TEST_DOMAIN)) === JSON.stringify(PLAN), "a manual plan with a proxied CNAME, or another domain, is refused; opster.dev's plan is unchanged");
  {
    const results = new Results(manualPlan, () => {});
    for (const entry of manualPlan) results.add(entry.id, entry.outOfScope ? "outOfScope" : entry.id === "X14-4" ? "fail" : "pass", "");
    const passing = new Results(manualPlan, () => {});
    for (const entry of manualPlan) passing.add(entry.id, entry.outOfScope ? "outOfScope" : "pass", "");
    check(runOutcome(passing, manualPlan).code === 0 && runOutcome(results, manualPlan).code === 1 && JSON.stringify(runOutcome(results, manualPlan).failed) === '["X14-4"]', "a manual run passes on its four checks, and fails naming X14-4 when the certificate fails");
  }
  check(reservedProblem(hostnamesRs, "war3.org") === null, "war3.org isn't one of core's reserved domains");
  const workflow = readFileSync(join(root, ".github/workflows/m6-custom-domain-staging.yml"), "utf8");
  check(/test_domain:\n\s+description: [^\n]+\n\s+type: choice\n\s+options:\n\s+- opster\.dev\n\s+- war3\.org\n\s+default: opster\.dev/.test(workflow), "the workflow's test_domain input is a choice of opster.dev and war3.org, defaulting to opster.dev");
  check(/TEST_DOMAIN: \$\{\{ inputs\.test_domain \|\| 'opster\.dev' \}\}/.test(workflow) && /case "\$TEST_DOMAIN" in\n\s+opster\.dev \| war3\.org\) ;;\n\s+\*\) [^\n]*exit 2 ;;/.test(workflow) && /--test-domain "\$TEST_DOMAIN"/.test(workflow) && !/run: [^\n]*inputs\.test_domain|exec node[^\n]*inputs\./.test(workflow), "the test domain reaches the run through env alone, checked by a case against its two values, never written into the command");
  check(/OPSTER_DNS_TOKEN: \$\{\{ inputs\.test_domain != 'war3\.org' && secrets\.OPSTER_DNS_TOKEN \|\| '' \}\}/.test(workflow) && /OPSTER_ZONE_ID: \$\{\{ inputs\.test_domain != 'war3\.org' && secrets\.OPSTER_ZONE_ID \|\| '' \}\}/.test(workflow) && /environment: staging-dns/.test(workflow), "in manual mode the OPSTER_* secrets aren't passed; the job stays in staging-dns for the sign-up secret");
  const minutes = Number(workflow.match(/timeout-minutes: (\d+)/)?.[1]);
  const manualWorst = (300 + 300 + 300 + MANUAL_DNS_WAIT_MS / 1000 + MANUAL_CLAIM_WAIT_S + WAITS["--active-wait"][1] + WAITS["--serve-wait"][1] + WAITS["--takedown-wait"][1]) / 60;
  check(minutes >= manualWorst + 15, `the job's ${minutes} minutes allow manual mode's ${manualWorst} minutes of waits, clean-up and the install`);
}

// ---- manual-DNS mode: the records the owner adds ----

{
  const records = manualRecords(MANUAL_NAMES.main, VALUE);
  const [txt, cnameRecord] = records;
  check(records.length === 2 && txt.type === "TXT" && txt.name === `${CHALLENGE_PREFIX}.${MANUAL_NAMES.main}` && txt.host === `${CHALLENGE_PREFIX}.${MANUAL_LABEL}` && txt.value === VALUE, "the TXT is _podster-challenge.cd-<random>, host relative to war3.org, holding room A's challenge value");
  check(cnameRecord.type === "CNAME" && cnameRecord.name === MANUAL_NAMES.main && cnameRecord.host === MANUAL_LABEL && cnameRecord.value === CNAME_TARGET && CNAME_TARGET === "fallback.podster.site", "the CNAME is cd-<random>, host relative to war3.org, to fallback.podster.site");
  check(records.every((r) => r.ttl === MANUAL_SOA_MINIMUM_S && r.domain === "war3.org") && MANUAL_SOA_MINIMUM_S === 300, "each suggests a TTL of 300 s, war3.org's SOA minimum");
  check([() => manualRecords(NAMES.main, VALUE), () => manualRecords(`x.${MANUAL_NAMES.main}`, VALUE), () => manualRecords("war3.org", VALUE), () => manualRecords(MANUAL_NAMES.main, "nothex"), () => manualRecords(MANUAL_NAMES.main, undefined)].every(refuses), "records are made only for cd-<random>.war3.org and one challenge value");
  const block = recordBlock(records, { minutesLeft: 30 });
  const lines = block.split("\n");
  check(block.includes("Squarespace → Domains → war3.org → DNS → Custom records") && lines.filter((l) => /^\s+\d\. Type: {2}(TXT|CNAME)$/.test(l)).length === 2, "the block names where in Squarespace, and both record types");
  check([`Host:  ${CHALLENGE_PREFIX}.${MANUAL_LABEL}`, `Host:  ${MANUAL_LABEL}`, `Data:  ${VALUE}`, `Data:  ${CNAME_TARGET}`, `Full name: ${CHALLENGE_PREFIX}.${MANUAL_NAMES.main}`, `Full name: ${MANUAL_NAMES.main}`, "TTL:   5 minutes (300 s)"].every((part) => block.includes(part)) && block.includes("30 more minute"), "the block gives each record's host field, data, full name and TTL, and the time left");
  check(!block.includes(`"${VALUE}"`) && /without quotes/.test(block), "the TXT data is given without quotes, and says so");
  const gone = deleteRecordsLine(records);
  check(gone.startsWith("Delete these 2 records in Squarespace") && gone.includes(`TXT host ${CHALLENGE_PREFIX}.${MANUAL_LABEL}`) && gone.includes(`CNAME host ${MANUAL_LABEL}`), "the way out names both records to delete");
  check(/nothing to delete/.test(deleteRecordsLine(null)) && /nothing to delete/.test(deleteRecordsLine([])), "with no records asked for, it says there is nothing to delete");
  check(MANUAL_DNS_WAIT_MS === 30 * 60_000 && MANUAL_REPRINT_MS === 5 * 60_000 && MANUAL_POLL_MS <= 30_000, "the records are waited for 30 minutes, the block printed again every 5, the name servers asked at least twice a minute");
  check(MANUAL_CLAIM_WAIT_S >= MANUAL_SOA_MINIMUM_S + (2 * PROOF_LOOK_MS) / 1000, "the claim wait outlasts a cached miss at cloudflare-dns.com (the SOA minimum) and two of the proof job's looks");

  // The lookups, against a stand-in Resolver: NS first, then only the run's names, at the name servers' addresses.
  const asked = [];
  const zone = { txt: new Map(), cname: new Map() };
  class FakeResolver {
    constructor() {
      this.servers = null;
    }
    setServers(ips) {
      this.servers = ips;
    }
    async resolveNs(name) {
      asked.push(["NS", name, this.servers]);
      return ["ns-cloud-c1.googledomains.com.", "NS-CLOUD-C2.googledomains.com"];
    }
    async resolve4(name) {
      asked.push(["A", name, this.servers]);
      return name.startsWith("ns-cloud-c1") ? ["192.0.2.1"] : ["192.0.2.2"];
    }
    async resolveTxt(name) {
      asked.push(["TXT", name, this.servers]);
      if (!zone.txt.has(name)) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      return zone.txt.get(name);
    }
    async resolveCname(name) {
      asked.push(["CNAME", name, this.servers]);
      if (!zone.cname.has(name)) throw Object.assign(new Error("nodata"), { code: "ENODATA" });
      return zone.cname.get(name);
    }
  }
  const lookup = authoritativeLookup({ domain: "war3.org", Resolver: FakeResolver });
  check(refuses(() => authoritativeLookup({ domain: TEST_DOMAIN, Resolver: FakeResolver })) && refuses(() => authoritativeLookup({ domain: "example.com", Resolver: FakeResolver })), "authoritative lookups are only for a manual domain");
  const none = await recordsSeen(lookup, records);
  check(!none.txt && !none.cname && none.error === null, "a missing record reads as not seen, not as an error");
  zone.txt.set(txt.name, [[VALUE.slice(0, 40), VALUE.slice(40)]]);
  zone.cname.set(cnameRecord.name, ["Fallback.Podster.Site."]);
  const both = await recordsSeen(lookup, records);
  check(both.txt && both.cname, "a TXT split in strings and a CNAME in another case with a trailing dot are seen");
  zone.txt.set(txt.name, [["cd".repeat(32)]]);
  check(!(await recordsSeen(lookup, records)).txt, "a TXT with another value isn't seen");
  const nsAsk = asked.find(([type]) => type === "NS");
  const recordAsks = asked.filter(([type]) => type === "TXT" || type === "CNAME");
  check(nsAsk?.[1] === "war3.org" && nsAsk[2] === null && recordAsks.length > 0 && recordAsks.every(([, , servers]) => JSON.stringify(servers) === '["192.0.2.1","192.0.2.2"]'), "the name servers are found by an NS lookup, and the records asked of them directly");
  let refusedOther = 0;
  for (const name of [`www.war3.org`, "war3.org", NAMES.main, `x.${MANUAL_NAMES.main}`]) {
    try {
      await lookup.txt(name);
    } catch {
      refusedOther++;
    }
  }
  check(refusedOther === 4 && !asked.some(([, name]) => name === "www.war3.org"), "nothing but the run's name and its challenge's name is looked up");
}

// ---- manual-DNS mode: no DNS API call ----

{
  check(["POST", "GET"].every((method) => refuses(() => dnsAllow(method, base, method === "POST" ? body({ name: challengeName(MANUAL_NAMES.main) }) : undefined, { ...ctx, root: MANUAL_NAMES.root }))) && refuses(() => dnsAllow("GET", `${base}?name=${MANUAL_NAMES.main}`, undefined, { ...ctx, root: MANUAL_NAMES.root })), "the DNS guard refuses every request for a war3.org root, so the API client couldn't write there");
}

// ---- the script's source ----

{
  const script = readFileSync(join(here, "m6-custom-domain-staging.mjs"), "utf8");
  check(!/spawn\(/.test(script) && !/playwright/.test(script) && !/gh run|npx /.test(script), "the script starts no process and no browser, and runs no gh run or npx: git is m6-release-run.mjs's");
  check(!script.includes("api.cloudflare.com") && (script.match(/dnsClient\(/g) ?? []).length === 1, "it reaches Cloudflare only through the one guarded DNS client");
  check(/delete process\.env\.OPSTER_DNS_TOKEN;/.test(script) && /delete process\.env\.OPSTER_ZONE_ID;/.test(script) && /run\.secret\(dnsToken\)/.test(script) && /run\.secret\(zoneId\)/.test(script), "the token and the zone's ID leave the environment and are scrubbed from the output");
  check(script.includes("dns.removeAll()") && /owner\.dash\("DELETE", hostnamePath\(room\)/.test(script) && script.includes("publisher.stop()") && script.includes("cleanUpShared()") && /enabled: false/.test(script), "clean-up removes each open hostname request, every DNS record, release and the rooms' publicity, then the shared clean-up");
  check(script.indexOf("for (const room of asked)") < script.indexOf("dns.removeAll()"), "clean-up ends the claims through the API before it deletes DNS");
  check(!/rejectUnauthorized/.test(script) && script.includes("tls.connect("), "the certificate is read with validation on");
  check(/if \(DNS_ONLY\) \{[\s\S]*?await check\("X14-4"[\s\S]*?certificateProblem\(cert, NAMES\.main, \{ domain: NAMES\.domain \}\)[\s\S]*?\} else \{\s*await record\("X14-4"/.test(script), "X14-4 is a judged check on certificateProblem with a DNS-only CNAME, and recorded with a proxied one");
  check(/cnameMode: options\.cnameMode/.test(script) && /const PLAN = planFor\(options\.cnameMode, options\.testDomain\)/.test(script), "the DNS client and the plan both take the run's CNAME mode");
  const workflow = readFileSync(join(root, ".github/workflows/m6-custom-domain-staging.yml"), "utf8");
  check(/cname_mode:\n\s+description: [^\n]+\n\s+type: choice\n\s+options:\n\s+- dns-only\n\s+- proxied\n\s+default: dns-only/.test(workflow), "the workflow's cname_mode input is a choice of dns-only and proxied, defaulting to dns-only");
  check(/CNAME_MODE: \$\{\{ inputs\.cname_mode \|\| 'dns-only' \}\}/.test(workflow) && /case "\$CNAME_MODE" in\n\s+dns-only \| proxied\) ;;/.test(workflow) && /--cname-mode "\$CNAME_MODE"/.test(workflow) && (workflow.match(/inputs\.cname_mode/g) ?? []).length === 1, "the input reaches the run through env alone, checked against its two values, never written into the command");
  check(/process\.on\("SIGTERM"/.test(script) && script.indexOf("dns.removeMade()") > script.indexOf('process.on("SIGTERM"') && /process\.exit\(143\)/.test(script), "SIGTERM removes DNS records and hostname requests first, then exits 143");
  check(/try \{\n    const \{ left \} = await publisher\.stop\(\);/.test(script), "a failed unpublish doesn't stop the shared clean-up");
  check(!["m6-custom-domain-staging.mjs", "m6-custom-domain-staging-lib.mjs", "m6-custom-domain-staging-selftest.mjs"].some((f) => { const t = readFileSync(join(here, f), "utf8"); return t.includes("apps/content") && t.includes(["wran", "gler"].join("")); }), "no file of this run names both the content package and its deploy tool (the content package's config test)");
  check(script.includes('run.mask(owner.id, "[owner]")') && script.includes('run.mask(admin.id, "[admin]")'), "both people's IDs are printed as their role");
  check(script.indexOf("dns.verify()") < script.indexOf("await main()") && script.indexOf("run.preflight()") < script.indexOf("dns.verify()"), "the DNS token is checked after the signed-out preflight and before any sign-up");
  check(/const dns = MANUAL \? null : dnsClient\(/.test(script) && /if \(!MANUAL\) \{\n  let refusal = null;\n  try \{\n    if \(!\(await dns\.verify\(\)\)\)/.test(script), "manual mode makes no DNS API client, and skips the token's check");
  check(/const dnsToken = MANUAL \? undefined : process\.env\.OPSTER_DNS_TOKEN;/.test(script) && /const zoneId = MANUAL \? undefined : process\.env\.OPSTER_ZONE_ID;/.test(script) && /const dnsProblem = MANUAL \? null : dnsEnvProblem\(process\.env\);/.test(script), "manual mode doesn't read OPSTER_DNS_TOKEN or OPSTER_ZONE_ID");
  check(/authoritativeLookup\(\{ domain: NAMES\.domain, Resolver \}\)/.test(script) && /import \{ Resolver \} from "node:dns\/promises";/.test(script), "manual mode reads the records with node:dns at the domain's own name servers");
  check(/if \(MANUAL\) return manualChecks\(\);/.test(script) && script.indexOf("if (MANUAL) return manualChecks();") < script.indexOf('say("\\n## refused names")') && /if \(!MANUAL\) \{\n    rooms\.b = /.test(script), "manual mode makes no rooms B or C, and leaves before the refused names, the decoy and the race");
  check(/MANUAL_REPRINT_MS[\s\S]*?recordBlock\(manualShown/.test(script.slice(script.indexOf("async function manualChecks"))) && /Math\.max\(options\.claimWait, MANUAL_CLAIM_WAIT_S\)/.test(script), "manual mode prints the block again while waiting, and waits the claim for a cached miss");
  const sigterm = script.slice(script.indexOf('process.on("SIGTERM"'));
  check(/if \(MANUAL\) console\.log\(run\.out\(deleteRecordsLine\(manualShown\)\)\);/.test(sigterm.slice(0, sigterm.indexOf("const claims"))) && /dns \? dns\.removeMade\(\) : 0/.test(sigterm), "on SIGTERM, manual mode says which records to delete before anything else, with no DNS client");
  check(/if \(MANUAL\) said\.push\(deleteRecordsLine\(manualShown\)\);/.test(script) && (script.match(/if \(MANUAL\) say\(`\\n\$\{deleteRecordsLine\(manualShown\)\}`\);/g) ?? []).length === 2, "every other way out, pass, fail, timeout or not on, ends by naming the records to delete");
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
  const counted = out.match(/stand-in: (\d+) requests, (\d+) sign-ups, (\d+) sign-outs, (\d+) to Cloudflare's API/);
  return { code: done.status, out, requests: counted ? Number(counted[1]) : null, signUps: counted ? Number(counted[2]) : null, signOuts: counted ? Number(counted[3]) : null, cloudflare: counted ? Number(counted[4]) : null };
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
    check(PLAN.every((entry) => dry.out.includes(entry.id)) && dry.out.includes("[out of scope:") && !dry.out.includes("[recorded, not judged:") && dry.out.includes("DNS-only (the default)"), "the default dry run is DNS-only and prints every check, marking the out-of-scope ones, with none only recorded");
    const dryProxied = script([...openAt, "--dry-run", "--cname-mode", "proxied"], { mode: "edge-down" });
    check(dryProxied.code === 0 && dryProxied.requests === 0 && /X14-4 .*\[recorded, not judged: proxied CNAME/.test(dryProxied.out) && dryProxied.out.includes("orange-to-orange"), "a proxied dry run marks X14-4 recorded, saying orange-to-orange, and sends nothing");
    check(script([...openAt, "--dry-run", "--cname-mode", "orange"], { mode: "edge-down" }).code === EXIT.refused, "an unknown CNAME mode exits 2");
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
    check(noDnsAnswer.cloudflare > 0, "the stand-in counts what reaches Cloudflare's API (the opster.dev run's token check)");
  }
  {
    const manualAt = [...at, "--test-domain", "war3.org"];
    const dry = script([...manualAt, "--dry-run"], { mode: "edge-down", dns: false });
    check(dry.code === 0 && dry.requests === 0 && dry.out.includes("manual-DNS mode") && /cd-[a-z0-9]{10}\.war3\.org/.test(dry.out) && !/race\./.test(dry.out), "a manual dry run needs no OPSTER_* settings, names cd-<random>.war3.org and no race, and sends nothing");
    check(script([...manualAt, "--cname-mode", "proxied", "--dry-run"], { mode: "edge-down", dns: false }).code === EXIT.refused && script([...at, "--test-domain", "example.com", "--dry-run"], { mode: "edge-down" }).code === EXIT.refused, "manual mode with a proxied CNAME, or a domain off the allow-list, exits 2");
    // Release refused on staging: the owner's sign-up is taken, the run stops before any name is asked for, and it ends
    // by saying there is nothing to delete. No request reaches Cloudflare's API, with or without the OPSTER_* settings.
    const notOn = script(manualAt, { mode: "not-available", dns: false });
    check(notOn.code === EXIT.releaseNotOn && notOn.signUps === 1 && notOn.cloudflare === 0 && /nothing to delete in Squarespace/.test(notOn.out), "a manual run makes no Cloudflare API request, and its way out says there is nothing to delete");
    const withDns = script(manualAt, { mode: "not-available" });
    check(withDns.code === EXIT.releaseNotOn && withDns.cloudflare === 0 && !/Refused: the DNS token|the DNS token is active/.test(withDns.out) && hidden(withDns.out), "with OPSTER_* set anyway, manual mode still doesn't check or use the token");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} case(s) failed.` : "\nm6-custom-domain-staging-selftest: every case passed.");
process.exit(failed ? 1 : 0);
