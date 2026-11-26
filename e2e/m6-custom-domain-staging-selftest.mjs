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

// ---- the script's source ----

{
  const script = readFileSync(join(here, "m6-custom-domain-staging.mjs"), "utf8");
  check(!/spawn\(/.test(script) && !/playwright/.test(script) && !/gh run|npx /.test(script), "the script starts no process and no browser, and runs no gh run or npx: git is m6-release-run.mjs's");
  check(!script.includes("api.cloudflare.com") && (script.match(/dnsClient\(/g) ?? []).length === 1, "it reaches Cloudflare only through the one guarded DNS client");
  check(/delete process\.env\.OPSTER_DNS_TOKEN;/.test(script) && /delete process\.env\.OPSTER_ZONE_ID;/.test(script) && /run\.secret\(dnsToken\)/.test(script) && /run\.secret\(zoneId\)/.test(script), "the token and the zone's ID leave the environment and are scrubbed from the output");
  check(script.includes("dns.removeAll()") && /owner\.dash\("DELETE", hostnamePath\(room\)/.test(script) && script.includes("publisher.stop()") && script.includes("cleanUpShared()") && /enabled: false/.test(script), "clean-up removes each open hostname request, every DNS record, release and the rooms' publicity, then the shared clean-up");
  check(script.indexOf("for (const room of asked)") < script.indexOf("dns.removeAll()"), "clean-up ends the claims through the API before it deletes DNS");
  check(!/rejectUnauthorized/.test(script) && script.includes("tls.connect("), "the certificate is read with validation on");
  check(/if \(DNS_ONLY\) \{[\s\S]*?await check\("X14-4"[\s\S]*?certificateProblem\(cert, NAMES\.main\)[\s\S]*?\} else \{\s*await record\("X14-4"/.test(script), "X14-4 is a judged check on certificateProblem with a DNS-only CNAME, and recorded with a proxied one");
  check(/cnameMode: options\.cnameMode/.test(script) && /const PLAN = planFor\(options\.cnameMode\)/.test(script), "the DNS client and the plan both take the run's CNAME mode");
  const workflow = readFileSync(join(root, ".github/workflows/m6-custom-domain-staging.yml"), "utf8");
  check(/cname_mode:\n\s+description: [^\n]+\n\s+type: choice\n\s+options:\n\s+- dns-only\n\s+- proxied\n\s+default: dns-only/.test(workflow), "the workflow's cname_mode input is a choice of dns-only and proxied, defaulting to dns-only");
  check(/CNAME_MODE: \$\{\{ inputs\.cname_mode \|\| 'dns-only' \}\}/.test(workflow) && /case "\$CNAME_MODE" in\n\s+dns-only \| proxied\) ;;/.test(workflow) && /--cname-mode "\$CNAME_MODE"/.test(workflow) && (workflow.match(/inputs\.cname_mode/g) ?? []).length === 1, "the input reaches the run through env alone, checked against its two values, never written into the command");
  check(/process\.on\("SIGTERM"/.test(script) && script.indexOf("dns.removeMade()") > script.indexOf('process.on("SIGTERM"') && /process\.exit\(143\)/.test(script), "SIGTERM removes DNS records and hostname requests first, then exits 143");
  check(/try \{\n    const \{ left \} = await publisher\.stop\(\);/.test(script), "a failed unpublish doesn't stop the shared clean-up");
  check(!["m6-custom-domain-staging.mjs", "m6-custom-domain-staging-lib.mjs", "m6-custom-domain-staging-selftest.mjs"].some((f) => { const t = readFileSync(join(here, f), "utf8"); return t.includes("apps/content") && t.includes(["wran", "gler"].join("")); }), "no file of this run names both the content package and its deploy tool (the content package's config test)");
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
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} case(s) failed.` : "\nm6-custom-domain-staging-selftest: every case passed.");
process.exit(failed ? 1 : 0);
