// The parts of m6-custom-domain-staging.mjs that touch nothing: the plan of checks and the run's exit code, the names a
// run may write in the test customer's DNS and the guard every DNS write goes through, the names it expects refused,
// and how it judges a hostname request and a custom host's answers. Kept apart so m6-custom-domain-staging-selftest.mjs
// can check them without a network, a secret or the e2e packages. The DNS client is here too, with its fetch passed in,
// so the self-test drives it against a stand-in.
//
// The run is the staging acceptance test for custom domains (docs/m6-plan.md, steps 8a to 8e; the labels M6-X14,
// M6-X15 and M6-X26 in m6-release-staging-lib.mjs): a name routes only after its proof of control, refused names and a
// race for one name, and a claim only by the room that published its own challenge.
export { CONTENT_DOMAIN, contentNotFoundProblem, defaultHostProblem, deployGrantProblem, DEPLOY_GRANT, HOST_CHANGE_SECONDS, markerBody, MARKER_PATH, RELEASE_DIRECTORY, resultUrlProblem, secretProblem, SITE, slowestLine, STAGING, STAGING_ORG, unknownLabel } from "./m6-release-staging-lib.mjs";
export { EXIT, Results, runOutcome } from "./m6-code-app-staging-lib.mjs";
import { CONTENT_DOMAIN, FIXED_HEADERS, PODSTER_DOMAIN, STAGING, stagingOnly } from "./m6-release-staging-lib.mjs";

/**
 * The test customer's domain: a zone on the podster.dev account that serves nothing else. The run's names are all
 * under one random label of it, `cd-<10 characters>.opster.dev`, fresh for each run, since a claim never transfers.
 */
export const TEST_DOMAIN = "opster.dev";
/** The label every name of one run sits under. */
export const RUN_LABEL = /^cd-[a-z0-9]{10}$/;
/** Where the challenge's TXT record goes, before the hostname (`podster_core::hostnames::CHALLENGE_PREFIX`). */
export const CHALLENGE_PREFIX = "_podster-challenge";
/** The fallback origin a hostname's CNAME points at (`podster_core::hostnames::cname_target`, label `fallback`). */
export const CNAME_TARGET = `fallback.${CONTENT_DOMAIN}`;
/** How often the proof job looks for a pending request's challenge in its first hour (`PROOF_EARLY_INTERVAL_MS`). */
export const PROOF_LOOK_MS = 60_000;
/**
 * How long a pending request is held with only another room's challenge at its name before the run says it wasn't
 * claimed: two of the proof job's looks and half a minute more.
 */
export const PENDING_HOLD_MS = 2 * PROOF_LOOK_MS + 30_000;
/**
 * How long apart two reads of gone must be before a removed claim is freed (`GONE_SPAN_MS` in
 * crates/core/src/hostname_requests.rs). The first may come only this long after the delete, so `ended` takes at least
 * twice this: the run doesn't wait for it.
 */
export const GONE_SPAN_MS = 10 * 60_000;
/** The HSTS a custom host's answers carry: no includeSubDomains, no preload (apps/content/src/handle.ts; **Proposed**). */
export const CUSTOM_HSTS = "max-age=31536000";
/** A DNS record's TTL, in seconds: the least Cloudflare takes, so a change is seen soon. */
export const DNS_TTL = 60;

/** Cloudflare's API, the one origin the DNS client sends to. */
export const CF_API = "https://api.cloudflare.com/client/v4";
const CF_ORIGIN = "https://api.cloudflare.com";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A run's label from random bytes: `cd-` and ten characters of [a-z0-9]. */
export const runLabel = (bytes) => `cd-${Array.from(bytes.slice(0, 10), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;

/** The run's names: its root, which is also the name it maps and routes, and the name two rooms race for. */
export function runNames(label) {
  if (!RUN_LABEL.test(label)) throw new Error("not a run label");
  const root = `${label}.${TEST_DOMAIN}`;
  return { root, main: root, race: `race.${root}` };
}
export const challengeName = (hostname) => `${CHALLENGE_PREFIX}.${hostname}`;

/** Whether `name` is the run's root or under it: lower case, no trailing dot, no wildcard, every label a plain one. */
export function underRoot(name, root) {
  if (typeof name !== "string" || typeof root !== "string") return false;
  const rootLabel = root.slice(0, -(TEST_DOMAIN.length + 1));
  if (!root.endsWith(`.${TEST_DOMAIN}`) || !RUN_LABEL.test(rootLabel)) return false;
  if (name !== root && !name.endsWith(`.${root}`)) return false;
  return name.split(".").every((label) => LABEL.test(label));
}
/** Whether `name` is the challenge's name for a run name. */
export function challengeUnderRoot(name, root) {
  return typeof name === "string" && name.startsWith(`${CHALLENGE_PREFIX}.`) && underRoot(name.slice(CHALLENGE_PREFIX.length + 1), root);
}
/** A TXT record's content as the run writes it: the challenge's value, quoted, as Cloudflare stores TXT. */
export const txtContent = (value) => `"${value}"`;

/**
 * Throws unless the DNS request may be sent. `ctx`: { zoneId, root, made } — the test zone's ID, the run's root and the
 * set of record IDs the run made, or found by a listing under its root. Cloudflare can't limit a token to record names,
 * so this is what does (spike D's guard.mjs, for DNS):
 * - GET: the token's own verification, a listing of one exact name under the root, or a record the run made;
 * - POST: a TXT at `_podster-challenge.<name under the root>` holding one challenge value, not proxied; or a CNAME at a
 *   name under the root to the fallback origin, proxied; with exactly type, name, content, ttl and proxied;
 * - DELETE: only a record ID in `made`.
 * Nothing else: no PUT or PATCH, no other type, no apex, no wildcard, no other zone, no query but the listing's.
 */
export function dnsAllow(method, url, body, { zoneId, root, made }) {
  const refuse = (why) => {
    throw new Error(`refusing a DNS request: ${why}`);
  };
  let u;
  try {
    u = new URL(url);
  } catch {
    refuse("not a URL");
  }
  if (u.origin !== CF_ORIGIN || u.username || u.password || u.hash) refuse("not Cloudflare's API");
  if (method === "GET" && u.pathname === "/client/v4/user/tokens/verify" && u.search === "") return;
  if (!HEX32.test(zoneId ?? "")) refuse("the zone ID isn't 32 hex characters");
  if (!underRoot(root, root)) refuse("the run's root isn't a cd- label under the test domain");
  const base = `/client/v4/zones/${zoneId}/dns_records`;
  if (method === "GET") {
    if (u.pathname === base) {
      const params = [...u.searchParams];
      if (params.length === 1 && params[0][0] === "name" && (underRoot(params[0][1], root) || challengeUnderRoot(params[0][1], root))) return;
      refuse("a listing must name exactly one name under the run's root");
    }
    if (u.pathname.startsWith(`${base}/`) && u.search === "" && made.has(u.pathname.slice(base.length + 1))) return;
    refuse("a read of something the run didn't make");
  }
  if (method === "POST") {
    if (u.pathname !== base || u.search !== "") refuse("a create goes to the zone's dns_records alone");
    let record;
    try {
      record = JSON.parse(body);
    } catch {
      refuse("a create's body isn't JSON");
    }
    const keys = Object.keys(record ?? {}).sort().join(",");
    if (keys !== "content,name,proxied,ttl,type") refuse(`a create carries exactly type, name, content, ttl and proxied, not ${keys}`);
    if (record.ttl !== DNS_TTL) refuse(`a record's TTL is ${DNS_TTL}`);
    if (record.type === "TXT") {
      if (!challengeUnderRoot(record.name, root)) refuse("a TXT goes only at a challenge's name under the run's root");
      if (typeof record.content !== "string" || !HEX64.test(record.content.slice(1, -1)) || record.content !== txtContent(record.content.slice(1, -1))) refuse("a TXT holds one quoted challenge value");
      if (record.proxied !== false) refuse("a TXT isn't proxied");
      return;
    }
    if (record.type === "CNAME") {
      if (!underRoot(record.name, root)) refuse("a CNAME goes only at a name under the run's root");
      if (record.content !== CNAME_TARGET) refuse(`a CNAME points only at ${CNAME_TARGET}`);
      if (record.proxied !== true) refuse("the CNAME is proxied, as spike D's was");
      return;
    }
    refuse("only TXT and CNAME records");
  }
  if (method === "DELETE") {
    if (!u.pathname.startsWith(`${base}/`) || u.search !== "" || body !== undefined) refuse("a delete names one record and carries nothing");
    const id = u.pathname.slice(base.length + 1);
    if (HEX32.test(id) && made.has(id)) return;
    refuse("a delete of a record the run didn't make");
  }
  refuse(`${method} isn't sent`);
}

/** Whether a record a listing found is the run's: an ID, TXT or CNAME, at a name under the run's root. */
export function adoptable(record, root) {
  if (!record || !HEX32.test(record.id ?? "")) return false;
  if (record.type === "TXT") return challengeUnderRoot(record.name, root);
  if (record.type === "CNAME") return underRoot(record.name, root);
  return false;
}

/**
 * The run's DNS client, the one way it writes the test zone. `fetch` is passed in. Every request goes through
 * `dnsAllow` first, so a refusal sends nothing. It keeps every record it made, and every name it tried to make one at,
 * so clean-up can list a name whose create's answer was lost and delete what the listing finds there. `log` gets one
 * line per request: method, type, name and status, never the token, the zone's ID or a URL.
 */
export function dnsClient({ token, zoneId, root, fetch, log = () => {}, timeoutMs = 30_000 }) {
  const made = new Map();
  const tried = new Set();
  async function send(method, url, body, what) {
    dnsAllow(method, url, body, { zoneId, root, made: new Set(made.keys()) });
    let res;
    try {
      res = await fetch(url, { method, redirect: "manual", headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      log(`cloudflare DNS ${method} ${what}: no answer (${error?.name ?? "Error"})`);
      throw new Error(`a DNS request got no answer (${error?.name ?? "Error"})`);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Not JSON: the status says enough.
    }
    log(`cloudflare DNS ${method} ${what}: ${res.status}${json?.success === false ? ` (${(json.errors ?? []).map((e) => e?.code).filter(Boolean).join(",") || "refused"})` : ""}`);
    return { status: res.status, json };
  }
  const zoneBase = `${CF_API}/zones/${zoneId}/dns_records`;
  return {
    made,
    tried,
    /** Whether the token is active, read from its own verification. */
    async verify() {
      const { status, json } = await send("GET", `${CF_API}/user/tokens/verify`, undefined, "token verification");
      return status === 200 && json?.success === true && json?.result?.status === "active";
    },
    /** The records at one exact name, as Cloudflare lists them, or null when the listing failed. */
    async list(name) {
      const { status, json } = await send("GET", `${zoneBase}?name=${encodeURIComponent(name)}`, undefined, `listing ${name}`);
      return status === 200 && json?.success === true && Array.isArray(json.result) ? json.result : null;
    },
    /** Makes one record. Answers its ID. */
    async create(type, name, content, proxied) {
      const body = JSON.stringify({ type, name, content, ttl: DNS_TTL, proxied });
      // Checked before the name is noted, so a refused create notes nothing.
      dnsAllow("POST", zoneBase, body, { zoneId, root, made: new Set(made.keys()) });
      tried.add(name);
      const { status, json } = await send("POST", zoneBase, body, `${type} ${name}`);
      const id = json?.result?.id;
      if (status !== 200 || json?.success !== true || !HEX32.test(id ?? "")) throw new Error(`Cloudflare didn't make the ${type} at ${name} (HTTP ${status})`);
      made.set(id, { type, name });
      return id;
    },
    txt(hostname, value) {
      if (!HEX64.test(value ?? "")) throw new Error("a challenge value is 64 hex characters");
      return this.create("TXT", challengeName(hostname), txtContent(value), false);
    },
    cname(hostname) {
      return this.create("CNAME", hostname, CNAME_TARGET, true);
    },
    /** Deletes one record the run made. Answers whether it is gone. */
    async remove(id) {
      const what = made.get(id);
      const { status } = await send("DELETE", `${zoneBase}/${id}`, undefined, `${what?.type ?? "record"} ${what?.name ?? id}`);
      if (status === 200 || status === 404) {
        made.delete(id);
        return true;
      }
      return false;
    },
    /**
     * Clean-up: every name the run tried is listed, and what is found there that is the run's is adopted; then every
     * record the run holds is deleted, and every name listed again. Answers what is left, by name, and what couldn't be read.
     */
    async removeAll() {
      const unread = [];
      for (const name of tried) {
        const found = await this.list(name).catch(() => null);
        if (!found) unread.push(name);
        for (const record of found ?? []) if (adoptable(record, root) && !made.has(record.id)) made.set(record.id, { type: record.type, name: record.name });
      }
      for (const id of [...made.keys()]) await this.remove(id).catch(() => false);
      const left = [];
      for (const name of tried) {
        const found = await this.list(name).catch(() => null);
        if (!found) unread.push(name);
        else if (found.some((record) => adoptable(record, root))) left.push(name);
      }
      return { left, unread: [...new Set(unread)], held: [...made.values()].map((r) => `${r.type} ${r.name}`) };
    },
  };
}

// ---- the configuration ----

/** Why the DNS settings can't be right, or null. Never names a value. */
export function dnsEnvProblem(env) {
  const token = env.OPSTER_DNS_TOKEN;
  const zone = env.OPSTER_ZONE_ID;
  if (!token) return "OPSTER_DNS_TOKEN isn't set";
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return "OPSTER_DNS_TOKEN isn't shaped like a Cloudflare API token";
  if (!zone) return "OPSTER_ZONE_ID isn't set";
  if (!HEX32.test(zone)) return "OPSTER_ZONE_ID isn't 32 hex characters";
  return null;
}

/**
 * Why the API refuses every name under the test domain, or null, read from `crates/core/src/hostnames.rs`'s
 * `RESERVED_DOMAINS`: a name under a reserved domain is refused `hostname_reserved`, so no claim could be shown.
 */
export function reservedProblem(source, domain = TEST_DOMAIN) {
  if (typeof source !== "string") return "crates/core/src/hostnames.rs couldn't be read";
  const list = source.match(/pub const RESERVED_DOMAINS: \[&str; \d+\] = \[([^\]]*)\];/);
  if (!list) return "crates/core/src/hostnames.rs has no RESERVED_DOMAINS list";
  const named = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (named.includes(domain) || domain === PODSTER_DOMAIN || domain === CONTENT_DOMAIN) {
    return `${domain} is in podster_core::hostnames::RESERVED_DOMAINS, so every name under it is refused hostname_reserved and no claim can be shown. A ruling must take it off that list, or name another test domain`;
  }
  return null;
}

// ---- the names refused ----

/** Names the API must refuse, with the status and code, asked in a room with release on (M6-X15). None leaves a request. */
export const REFUSED_NAMES = [
  ["podster.dev", 409, "hostname_reserved"],
  ["app.podster.dev", 409, "hostname_reserved"],
  [CONTENT_DOMAIN, 409, "hostname_reserved"],
  [CNAME_TARGET, 409, "hostname_reserved"],
  ["github.io", 409, "hostname_public_suffix"],
  ["co.uk", 409, "hostname_public_suffix"],
  ["192.0.2.1", 400, "hostname_ip_address"],
  ["*.example.com", 400, "hostname_wildcard"],
  ["localhost", 400, "hostname_single_label"],
  ["bad..example.com", 400, "hostname_invalid"],
  ["-bad.example.com", 400, "hostname_invalid"],
  [`${"x".repeat(64)}.example.com`, 400, "hostname_invalid"],
].map(([hostname, status, code]) => ({ body: { hostname }, status, code }));
/** Bodies that aren't `{ hostname }`. */
export const REFUSED_BODIES = [
  { body: { hostname: "x.example.com", extra: 1 }, status: 400, code: "invalid_argument" },
  { body: { hostname: 7 }, status: 400, code: "invalid_argument" },
];

// ---- judging ----

/**
 * What's wrong with a hostname request as the API gives it, against what the run asked for, or null. `state`, when
 * given, is the state it must be in. The challenge's name and the CNAME target come from the name and the deployment,
 * never from the caller.
 */
export function requestProblem(request, { hostname, state, setup }) {
  if (!request || typeof request !== "object") return "no request";
  if (request.hostname !== hostname) return "the request is for another name";
  if (request.challenge_name !== challengeName(hostname)) return "the challenge's name isn't _podster-challenge.<name>";
  if (!HEX64.test(request.challenge_value ?? "")) return "the challenge's value isn't 64 hex characters";
  if (request.cname_target !== CNAME_TARGET) return `the CNAME target isn't ${CNAME_TARGET}`;
  if (state && request.state !== state) return `the request is ${request.state}, not ${state}`;
  if (setup && request.setup_status !== setup) return `its setup is ${request.setup_status}, not ${setup}`;
  return null;
}

/**
 * The race's outcome, from both rooms' requests once neither is pending: one claimed, the other refused with a reason
 * code. Answers { winner: "a" | "b", reason } or { problem }.
 */
export function raceOutcome(a, b) {
  const states = [a?.state, b?.state];
  if (states.includes("pending")) return { problem: "a request is still pending" };
  const claimed = states.filter((s) => s === "claimed").length;
  if (claimed === 2) return { problem: "both rooms were claimed for one name" };
  if (claimed === 0) return { problem: `neither room was claimed (${states.join(" and ")})` };
  const [winner, loser] = a.state === "claimed" ? ["a", b] : ["b", a];
  if (loser.state !== "refused") return { problem: `the room that lost is ${loser.state}, not refused` };
  if (!/^[a-z][a-z0-9_]*$/.test(loser.end_reason ?? "")) return { problem: "the refusal has no reason code" };
  return { winner, reason: loser.end_reason };
}

/** What's wrong with one answer from a custom host, against the fixed headers, a custom host's HSTS and no cookie. */
export function customHeaderProblems(headers) {
  const h = new Headers(headers);
  const problems = Object.entries(FIXED_HEADERS)
    .filter(([name]) => name !== "strict-transport-security")
    .filter(([name, okay]) => !okay(h.get(name)))
    .map(([name]) => `${name} isn't the content Worker's`);
  if (h.get("strict-transport-security") !== CUSTOM_HSTS) problems.push(`strict-transport-security isn't ${CUSTOM_HSTS}`);
  if (h.has("set-cookie")) problems.push("it set a cookie");
  return problems;
}

/** One line on what a name served before its claim, from an answer or the error a request ended in. Never the body. */
export function unclaimedLine(answer, error) {
  if (error) return `no HTTPS answer (${error})`;
  return `HTTP ${answer.status}${answer.headers ? `, ${new Headers(answer.headers).get("server") ?? "no server header"}` : ""}`;
}

/** One line on the certificate a custom host served: its names, issuer and dates, and whether it names the host. */
export function certificateLine(cert, host) {
  if (!cert || typeof cert !== "object" || !cert.subject) return "no certificate was read";
  const names = String(cert.subjectaltname ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
  const covers = names.some((name) => name === host || (name.startsWith("*.") && host.endsWith(name.slice(1)) && !host.slice(0, -name.length + 1).includes(".")));
  const issuer = [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(", ") || "unknown issuer";
  return `${covers ? "names the host" : "does NOT name the host"}; names ${names.length ? names.join(" ") : "nothing"}; issued by ${issuer}; valid ${cert.valid_from ?? "?"} to ${cert.valid_to ?? "?"}${cert.authorized === false ? `; not trusted (${cert.authorizationError ?? "unknown"})` : "; trusted by Node"}`;
}

// ---- the plan ----

/** The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. The agent takes none. */
export const SIGN_UPS = [
  { who: "the rooms' owner", why: "owns the organization, the three rooms and their repositories, links the coding agent, and asks for the names. Taken only after the signed-out preflight and the DNS token's check" },
  { who: "the rooms' admin", why: "a second person, who doesn't control the agent: merges its task, switches release on in each room and approves the release. Taken only once the owner's room shows release answers" },
];

const TIME_GAP = "time-dependent: staging has no test clock (failpoints never ship, apps/api/wrangler.jsonc), and a run can't wait the days it takes. Checked by crates/core's and the API's own tests; on staging it would need state kept across days, as m6-staging-kept.mjs does";

/**
 * Every check, in the order it runs. `outOfScope` checks always say OUT OF SCOPE, with why, and don't stop exit 0.
 * `recordOnly` checks say RECORDED with what was seen, are never judged, and don't change the exit code. Every other
 * check must pass for exit 0.
 */
export const PLAN = [
  ["X15-1", "M6-X15, refused names, in a room with release on: Podster's own domains, the content domain, its fallback origin and names under them hostname_reserved (409); public suffixes (github.io, co.uk) hostname_public_suffix (409); an IP address, a wildcard and a single label 400 with their codes; malformed names hostname_invalid (400); a body that isn't { hostname } invalid_argument. None leaves a request"],
  ["X14-1", "M6-X14, before proof: with the name's CNAME to the fallback origin in place and only another room's challenge at its challenge name, the room's request stays pending (proof_pending), the configuration names no custom host, and the name doesn't serve the room's marker"],
  ["X15-2", "M6-X15, a race: two other rooms ask for one name and both challenges are published at once; exactly one room is claimed and the other refused with a reason code"],
  ["X26-1", "M6-X26: another room's value at the challenge's name didn't claim the name during the hold; once the room publishes its own, it is claimed within the wait"],
  ["X14-2", "M6-X14, after proof: Cloudflare reads the custom hostname active (setup_status active), and the release configuration names it as custom_host"],
  ["X14-3", "M6-X14 and 8e, over HTTPS on the custom name: the marker names the room's served release and merge commit; the index is the release's, with the content Worker's fixed headers, HSTS without includeSubDomains, and no cookie"],
  ["X14-4", "The certificate served for the custom name: the first live check that Cloudflare's HTTP validation passes with the */* route and its no-Worker validation routes in place (ssl.status active)", { recordOnly: "the API doesn't expose ssl.status; a certificate Node trusts naming the host is what it shows" }],
  ["X14-5", "M6-X14, removal: the request goes ending, the configuration names no custom host at once, and the name stops serving the marker within the wait"],
  ["X14-6", "A removed claim is freed (ended) once Cloudflare reads the custom hostname gone twice, GONE_SPAN_MS apart", { outOfScope: `it takes at least ${(2 * GONE_SPAN_MS) / 60_000} minutes after the delete; the run leaves the request ending, and the API's tests check the count` }],
  ["X26-2", "M6-26: a pending request nobody proved expires after 72 hours", { outOfScope: TIME_GAP }],
  ["X26-3", "M6-26: the daily recheck ends a claim after two definite noes at least 24 hours apart, or seven days with no match", { outOfScope: TIME_GAP }],
].map(([id, title, flags = {}]) => ({ id, title, outOfScope: flags.outOfScope ?? null, recordOnly: flags.recordOnly ?? null }));

/** The waits, in seconds: flag, option name, default. Each is bounded from 10 to 1800. */
export const WAITS = {
  "--setup-wait": ["setupWait", 300],
  "--merge-wait": ["mergeWait", 300],
  "--release-wait": ["releaseWait", 300],
  "--takedown-wait": ["takedownWait", 180],
  "--claim-wait": ["claimWait", 300],
  "--active-wait": ["activeWait", 900],
  "--serve-wait": ["serveWait", 600],
};

export const USAGE = `Usage: node m6-custom-domain-staging.mjs --base-url ${STAGING} [--dry-run] [--contract FILE] [--core-hostnames FILE] [--setup-wait S] [--merge-wait S] [--release-wait S] [--takedown-wait S] [--claim-wait S] [--active-wait S] [--serve-wait S]

M6's staging acceptance test for custom domains (M6-X14, M6-X15, M6-X26). One room releases a tiny static site; then
names under a fresh label of ${TEST_DOMAIN}, cd-<random>.${TEST_DOMAIN}, are asked for, proved through Cloudflare's DNS
API, routed and removed. Run from GitHub Actions (.github/workflows/m6-custom-domain-staging.yml): the owner's machine
can't reach the content domain.

  --dry-run          check the configuration, the contract and the reserved domains, and print the plan. Sends nothing.
  --contract         the OpenAPI contract read for the deploy grant's route. Defaults to packages/contracts/openapi.yaml.
  --core-hostnames   crates/core/src/hostnames.rs, read for RESERVED_DOMAINS. Defaults to this checkout's.
  --setup-wait       seconds to wait for each room's repository (default 300).
  --merge-wait       seconds to wait for the merge (default 300).
  --release-wait     seconds to wait for the release to be served (default 300).
  --takedown-wait    seconds to wait for the custom name to stop serving after its removal (default 180).
  --claim-wait       seconds to wait for a claim, or the race's outcome (default 300).
  --active-wait      seconds to wait for Cloudflare to read the custom hostname active (default 900).
  --serve-wait       seconds to wait for the custom name to serve the release's marker (default 600).

  PODSTER_E2E_SIGNUP_SECRET   staging's test sign-up secret. Needed. Never printed.
  OPSTER_DNS_TOKEN            a Cloudflare API token with Zone, DNS, Edit on ${TEST_DOMAIN} alone. Needed. Never printed.
  OPSTER_ZONE_ID              ${TEST_DOMAIN}'s zone ID. Needed. Never printed.

  Every DNS write goes through one guard: only TXT at _podster-challenge.<name> and CNAME to ${CNAME_TARGET}, only
  under the run's own label, and a delete only of a record the run made. Refuses to start, exit 3, when ${TEST_DOMAIN}
  is one of the API's reserved domains; when the contract's grant route gives no deploy grant; or when, signed out,
  staging doesn't list deploy_release, or ${CONTENT_DOMAIN} or ${CNAME_TARGET} doesn't answer with the content Worker's
  own not found. Refuses, exit 2, when the DNS token isn't active or can't list a name in the zone. Neither takes a
  sign-up.

  It takes ${SIGN_UPS.length} test sign-ups (the rooms' owner and admin), makes three public repositories in podsterdev, merges
  one task and releases once. It makes at most 2 custom hostnames at Cloudflare, each removed through the API. It waits
  about ${Math.round(PENDING_HOLD_MS / 1000)} s with a request pending, then for the claims, Cloudflare and the route. It cleans up on every way
  out: each room's hostname request removed, every DNS record it made deleted and the names listed again, release off,
  the rooms private, grants taken back, the agent disconnected, sessions signed out. It can't delete the repositories:
  it prints their names for the owner to archive or delete. Person IDs are printed as their role.

  Exit 0 only when every judged check passed; 1 otherwise; 2 for a refused configuration or a failed preflight, with no
  sign-up taken; 3 when release or custom domains aren't on, with at most the owner's sign-up.`;

/** The run's options, or why they're refused. An unknown flag or a missing value is an error: nothing is guessed. */
export function parseArgs(argv, env = {}) {
  const options = { base: undefined, dryRun: false, help: false, contract: undefined, coreHostnames: undefined };
  for (const [name, fallback] of Object.values(WAITS)) options[name] = fallback;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--base-url" || flag === "--contract" || flag === "--core-hostnames" || WAITS[flag]) {
      const value = argv[++at];
      if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
      if (flag === "--base-url") options.base = value;
      else if (flag === "--contract") options.contract = value;
      else if (flag === "--core-hostnames") options.coreHostnames = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) < 10 || Number(value) > 1800) return { error: `${flag} takes whole seconds from 10 to 1800` };
        options[WAITS[flag][0]] = Number(value);
      }
    } else return { error: `unknown argument ${flag}` };
  }
  if (options.help) return { options };
  options.base ??= env.PODSTER_E2E_BASE_URL;
  if (!options.base) return { error: "pass --base-url, or set PODSTER_E2E_BASE_URL" };
  const refusal = stagingOnly(options.base);
  if (refusal) return { error: refusal };
  options.base = STAGING;
  return { options };
}
