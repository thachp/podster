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
/** The HSTS a custom host's answers carry: no includeSubDomains, no preload (the content Worker's handle.ts; **Proposed**). */
export const CUSTOM_HSTS = "max-age=31536000";
/** A DNS record's TTL, in seconds: the least Cloudflare takes, so a change is seen soon. */
export const DNS_TTL = 60;
/**
 * The least the race is waited for once both challenges are published: the placeholder's TTL, for a resolver that read
 * the challenge's name before they were published to forget the placeholder alone, then two of the proof job's looks,
 * then half a minute for the asks to the hostname's object. The race waits this or the claim wait, whichever is longer.
 */
export const RACE_SETTLE_MS = DNS_TTL * 1000 + 2 * PROOF_LOOK_MS + 30_000;

/**
 * How the custom name's CNAME to the fallback origin is published, one per run (`--cname-mode`):
 * - `dns-only`, the default since 2026-11-26: the record isn't proxied, as a customer whose DNS isn't on Cloudflare
 *   would publish it. The content zone's custom hostname then serves its own certificate, issued by HTTP validation
 *   through the catch-all Worker route and its no-Worker validation routes, and X14-4 judges that certificate.
 * - `proxied`: the record is proxied, as spike D's was. `opster.dev` is itself a Cloudflare zone on another account, so
 *   Cloudflare uses orange-to-orange (O2O) and serves the customer zone's own certificate; X14-4 is only recorded.
 * Cloudflare's documentation: cloudflare-for-saas/saas-customers/how-it-works and ssl/reference/certificate-and-hostname-priority.
 */
export const CNAME_MODES = ["dns-only", "proxied"];
export const DEFAULT_CNAME_MODE = "dns-only";
/** Whether the CNAME is proxied in `mode`. Throws for anything but the two modes, so nothing is guessed. */
export function cnameProxied(mode) {
  if (!CNAME_MODES.includes(mode)) throw new Error(`the CNAME mode is one of ${CNAME_MODES.join(" and ")}`);
  return mode === "proxied";
}
/** How recently a custom hostname's own certificate must have been issued for X14-4 to count it as this run's: 2 days. */
export const CERT_MAX_AGE_MS = 2 * 24 * 60 * 60_000;

// ---- manual-DNS mode (2026-11-26) ----
//
// Run 45832698985 (dns-only, opster.dev) still served opster.dev's own `*.opster.dev` certificate: Cloudflare picks the
// customer zone's certificate whenever the name is under a Cloudflare zone, proxied or not. X14-4 needs a customer domain
// whose DNS isn't on Cloudflare. The owner's `war3.org` is at Squarespace, which has no DNS API, so in manual mode the run
// prints the two records, the owner adds them by hand while watching the log, and the run reads them from war3.org's own
// name servers. The run makes no DNS API call in this mode.

/** The only domains manual mode accepts. Hard-coded: a domain is added here by a reviewed change, never by an input. */
export const MANUAL_DOMAINS = Object.freeze(["war3.org"]);
/** Every test domain a run accepts: the API-driven one, then the manual ones. */
export const TEST_DOMAINS = Object.freeze([TEST_DOMAIN, ...MANUAL_DOMAINS]);
/** Whether `domain` is one manual mode accepts. */
export const isManualDomain = (domain) => MANUAL_DOMAINS.includes(domain);
/** How long the run waits for the owner's two records to show at the domain's name servers: 30 minutes. */
export const MANUAL_DNS_WAIT_MS = 30 * 60_000;
/** How often the record block is printed again while waiting: every 5 minutes. */
export const MANUAL_REPRINT_MS = 5 * 60_000;
/** How often the name servers are asked while waiting. */
export const MANUAL_POLL_MS = 15_000;
/** war3.org's SOA minimum, in seconds: how long a resolver may cache a miss. Also the TTL suggested for the records. */
export const MANUAL_SOA_MINIMUM_S = 300;
/**
 * The least the claim is waited for once both records show at the name servers: the API's proof check reads through
 * cloudflare-dns.com, which may have cached the challenge's name missing for up to the SOA minimum, then two of the
 * proof job's looks, then a minute more.
 */
export const MANUAL_CLAIM_WAIT_S = MANUAL_SOA_MINIMUM_S + (2 * PROOF_LOOK_MS) / 1000 + 60;
/** Where the owner adds the records. */
export const SQUARESPACE_PATH = (domain) => `Squarespace → Domains → ${domain} → DNS → Custom records`;

/** Whether `name` is a manual run's name: exactly `cd-<10 characters>.<a manual domain>`. */
export function manualName(name) {
  if (typeof name !== "string") return false;
  const at = name.indexOf(".");
  return at > 0 && RUN_LABEL.test(name.slice(0, at)) && isManualDomain(name.slice(at + 1));
}

/**
 * The two records the owner adds by hand for a manual run's name: the TXT challenge and the CNAME to the fallback origin,
 * each with its full name and the host field Squarespace wants (the name relative to the domain). Throws unless the name
 * is `cd-<random>.<a manual domain>` and the value is one challenge value.
 */
export function manualRecords(hostname, challengeValue) {
  if (!manualName(hostname)) throw new Error(`manual mode asks only for cd-<random>.<${MANUAL_DOMAINS.join(" or ")}>`);
  if (!HEX64.test(challengeValue ?? "")) throw new Error("a challenge value is 64 hex characters");
  const domain = hostname.slice(hostname.indexOf(".") + 1);
  const relative = (name) => name.slice(0, -(domain.length + 1));
  const txt = challengeName(hostname);
  return [
    { type: "TXT", name: txt, host: relative(txt), value: challengeValue },
    { type: "CNAME", name: hostname, host: relative(hostname), value: CNAME_TARGET },
  ].map((record) => ({ ...record, domain, ttl: MANUAL_SOA_MINIMUM_S }));
}

/** The block the owner copies from the log: both records, with the full name and Squarespace's host field. */
export function recordBlock(records, { minutesLeft } = {}) {
  const domain = records[0].domain;
  const rule = "=".repeat(100);
  return [
    rule,
    `ADD THESE ${records.length} DNS RECORDS for ${domain}, in ${SQUARESPACE_PATH(domain)} → Add record:`,
    ...records.flatMap((r, i) => [
      `  ${i + 1}. Type:  ${r.type}`,
      `     Host:  ${r.host}`,
      `     Data:  ${r.value}${r.type === "TXT" ? "   (as it is, without quotes)" : ""}`,
      `     TTL:   ${r.ttl / 60} minutes (${r.ttl} s), or the lowest Squarespace offers`,
      `     Full name: ${r.name}`,
    ]),
    `The run reads them from ${domain}'s own name servers${minutesLeft === undefined ? "" : `, for ${minutesLeft} more minute(s)`}. Delete both when the run ends; it says so.`,
    rule,
  ].join("\n");
}

/** The line every way out prints: the records to delete, or that none were asked for. */
export function deleteRecordsLine(records) {
  if (!records?.length) return "No records were asked for in manual mode, so there is nothing to delete in Squarespace.";
  const domain = records[0].domain;
  return `Delete these ${records.length} records in Squarespace (${SQUARESPACE_PATH(domain)}): ${records.map((r) => `${r.type} host ${r.host} (${r.name}) → ${r.value}`).join("; ")}.`;
}

/**
 * Read-only lookups at a manual domain's own name servers, found with an NS lookup, so a resolver's cached miss can't
 * hide a record the owner has just added. `Resolver` is node:dns/promises' class, passed in. Every name asked for must be
 * a manual run's name or its challenge's name: nothing else under the domain is read.
 */
export function authoritativeLookup({ domain, Resolver, timeoutMs = 5000 }) {
  if (!isManualDomain(domain)) throw new Error(`authoritative lookups are only for ${MANUAL_DOMAINS.join(" and ")}`);
  let servers = null;
  const allowed = (name) => manualName(name) || (name.startsWith(`${CHALLENGE_PREFIX}.`) && manualName(name.slice(CHALLENGE_PREFIX.length + 1)));
  async function nameServers() {
    if (servers) return servers;
    const system = new Resolver({ timeout: timeoutMs, tries: 2 });
    const names = (await system.resolveNs(domain)).map((n) => n.toLowerCase().replace(/\.$/, "")).sort();
    const ips = [];
    for (const name of names) ips.push(...(await system.resolve4(name).catch(() => [])));
    if (!ips.length) throw new Error(`none of ${domain}'s name servers (${names.join(", ") || "none listed"}) resolved`);
    servers = { names, ips: [...new Set(ips)] };
    return servers;
  }
  async function ask(name, how) {
    if (!allowed(name)) throw new Error(`refusing a lookup of ${name}: only a manual run's names are read`);
    const at = new Resolver({ timeout: timeoutMs, tries: 2 });
    at.setServers((await nameServers()).ips);
    try {
      return await how(at);
    } catch (error) {
      if (["ENODATA", "ENOTFOUND"].includes(error?.code)) return [];
      throw error;
    }
  }
  return {
    nameServers,
    /** The TXT values at `name`, each record's strings joined. */
    txt: (name) => ask(name, async (r) => (await r.resolveTxt(name)).map((chunks) => chunks.join(""))),
    /** The CNAME targets at `name`, lower case, with no trailing dot. */
    cname: (name) => ask(name, async (r) => (await r.resolveCname(name)).map((t) => t.toLowerCase().replace(/\.$/, ""))),
  };
}

/** Which of the records `lookup` sees as the owner should have added them: { txt, cname, error }. Never throws. */
export async function recordsSeen(lookup, records) {
  const seen = { txt: false, cname: false, error: null };
  for (const record of records) {
    try {
      if (record.type === "TXT") seen.txt = (await lookup.txt(record.name)).includes(record.value);
      else if (record.type === "CNAME") seen.cname = (await lookup.cname(record.name)).includes(record.value);
    } catch (error) {
      seen.error = String(error?.code ?? error?.message ?? error);
    }
  }
  return seen;
}

/** Cloudflare's API, the one origin the DNS client sends to. */
export const CF_API = "https://api.cloudflare.com/client/v4";
const CF_ORIGIN = "https://api.cloudflare.com";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A run's label from random bytes: `cd-` and ten characters of [a-z0-9]. */
export const runLabel = (bytes) => `cd-${Array.from(bytes.slice(0, 10), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;

/**
 * The run's names: its root, which is also the name it maps and routes, and the name two rooms race for. In manual mode
 * (a domain of MANUAL_DOMAINS) there is no race, so no race name: only `cd-<random>.<domain>`.
 */
export function runNames(label, domain = TEST_DOMAIN) {
  if (!RUN_LABEL.test(label)) throw new Error("not a run label");
  if (!TEST_DOMAINS.includes(domain)) throw new Error(`the test domain is one of ${TEST_DOMAINS.join(" and ")}`);
  const root = `${label}.${domain}`;
  if (isManualDomain(domain)) return { domain, root, main: root, race: null };
  return { domain, root, main: root, race: `race.${root}` };
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
 * Throws unless the DNS request may be sent. `ctx`: { zoneId, root, made, cnameMode } — the test zone's ID, the run's
 * root, the set of record IDs the run made, or found by a listing under its root, and the run's CNAME mode. Cloudflare can't limit a token to record names,
 * so this is what does (spike D's guard.mjs, for DNS):
 * - GET: the token's own verification, a listing of one exact name under the root, or a record the run made;
 * - POST: a TXT at `_podster-challenge.<name under the root>` holding one challenge value, not proxied; or a CNAME at a
 *   name under the root to the fallback origin, proxied exactly when the run's mode is `proxied` and not proxied when
 *   it is `dns-only`; with exactly type, name, content, ttl and proxied;
 * - DELETE: only a record ID in `made`.
 * Nothing else: no PUT or PATCH, no other type, no apex, no wildcard, no other zone, no query but the listing's.
 */
export function dnsAllow(method, url, body, { zoneId, root, made, cnameMode }) {
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
      if (!CNAME_MODES.includes(cnameMode)) refuse(`the run's CNAME mode isn't one of ${CNAME_MODES.join(" and ")}`);
      if (record.proxied !== cnameProxied(cnameMode)) refuse(`a CNAME in ${cnameMode} mode has proxied ${cnameProxied(cnameMode)}`);
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
export function dnsClient({ token, zoneId, root, cnameMode, fetch, log = () => {}, timeoutMs = 30_000 }) {
  const proxied = cnameProxied(cnameMode);
  const made = new Map();
  const tried = new Set();
  async function send(method, url, body, what) {
    dnsAllow(method, url, body, { zoneId, root, made: new Set(made.keys()), cnameMode });
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
      dnsAllow("POST", zoneBase, body, { zoneId, root, made: new Set(made.keys()), cnameMode });
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
      return this.create("CNAME", hostname, CNAME_TARGET, proxied);
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
     * The fast clean-up a SIGTERM gets: every record the run holds deleted at once, side by side, with no listing.
     * Answers how many are still held.
     */
    async removeMade() {
      await Promise.all([...made.keys()].map((id) => this.remove(id).catch(() => false)));
      return made.size;
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
 * code. `labels` names the two rooms, in the order their requests are given, so the winner is named as the run names
 * the room (run 45803085099 said "room A" for a race between rooms B and C). Answers { winner, reason }, the winner
 * being one of `labels`, or { problem }.
 */
export function raceOutcome(a, b, labels) {
  if (!Array.isArray(labels) || labels.length !== 2 || labels[0] === labels[1]) return { problem: "the race's two rooms aren't named" };
  const states = [a?.state, b?.state];
  if (states.includes("pending")) return { problem: "a request is still pending" };
  const claimed = states.filter((s) => s === "claimed").length;
  if (claimed === 2) return { problem: "both rooms were claimed for one name" };
  if (claimed === 0) return { problem: `neither room was claimed (${states.join(" and ")})` };
  const [winner, loser] = a.state === "claimed" ? [labels[0], b] : [labels[1], a];
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

/** A certificate's DNS names, from Node's `subjectaltname` string. */
const certNames = (cert) =>
  String(cert?.subjectaltname ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4).toLowerCase());

/** One line on the certificate a custom host served: its names, issuer and dates, and whether it names the host. */
export function certificateLine(cert, host) {
  if (cert && typeof cert === "object" && cert.handshakeError) return `the TLS handshake with certificate validation on failed: ${cert.handshakeError}`;
  if (!cert || typeof cert !== "object" || !cert.subject) return "no certificate was read";
  const names = certNames(cert);
  const covers = names.some((name) => name === host || (name.startsWith("*.") && host.endsWith(name.slice(1)) && !host.slice(0, -name.length + 1).includes(".")));
  const issuer = [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(", ") || "unknown issuer";
  return `${covers ? "names the host" : "does NOT name the host"}; names ${names.length ? names.join(" ") : "nothing"}; issued by ${issuer}; valid ${cert.valid_from ?? "?"} to ${cert.valid_to ?? "?"}${cert.authorized === true ? "; trusted by Node" : `; not trusted (${cert.authorizationError ?? "unknown"})`}`;
}

/**
 * X14-4 in dns-only mode: what's wrong with the certificate served for the custom name, or null. It must be the content
 * zone's own certificate for this custom hostname: naming the exact host among its DNS names (a wildcard alone doesn't
 * do); not the test zone's universal certificate (one naming the test domain or `*.<test domain>`, as O2O serves); trusted
 * by Node; issued within `maxAgeMs` of `now`, since every run's name is new; and not yet expired.
 */
export function certificateProblem(cert, host, { now = Date.now(), maxAgeMs = CERT_MAX_AGE_MS, domain = TEST_DOMAIN } = {}) {
  if (cert && typeof cert === "object" && cert.handshakeError) return `the TLS handshake with certificate validation on failed (${cert.handshakeError})`;
  if (!cert || typeof cert !== "object" || !cert.subject) return "no certificate was read";
  const names = certNames(cert);
  if (!names.includes(host)) return `its DNS names don't include ${host} itself${names.some((n) => n.startsWith("*.")) ? " (a wildcard isn't enough)" : ""}`;
  if (names.includes(domain) || names.includes(`*.${domain}`)) return `it names ${domain} or *.${domain}: it is the test zone's own certificate, not one issued for the custom hostname`;
  if (cert.authorized !== true) return `Node doesn't trust it (${cert.authorizationError ?? "unknown"})`;
  const from = Date.parse(cert.valid_from ?? "");
  const to = Date.parse(cert.valid_to ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "its validity dates couldn't be read";
  if (from > now + 60 * 60_000) return "it isn't valid yet";
  if (now - from > maxAgeMs) return `it was issued ${Math.round((now - from) / 3_600_000)} hours ago, more than ${Math.round(maxAgeMs / 3_600_000)}: not one issued for this run's new name`;
  if (to <= now) return "it has expired";
  return null;
}

// ---- the plan ----

/** The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. The agent takes none. */
export const SIGN_UPS = [
  { who: "the rooms' owner", why: "owns the organization, the rooms (three, or room A alone in manual mode) and their repositories, links the coding agent, and asks for the names. Taken only after the signed-out preflight and, outside manual mode, the DNS token's check" },
  { who: "the rooms' admin", why: "a second person, who doesn't control the agent: merges its task, switches release on in each room and approves the release. Taken only once the owner's room shows release answers" },
];

const TIME_GAP = "time-dependent: staging has no test clock (failpoints never ship in the API's deployed build), and a run can't wait the days it takes. Checked by crates/core's and the API's own tests; on staging it would need state kept across days, as m6-staging-kept.mjs does";

/** Why X14-4 is only recorded with a proxied CNAME. */
const X14_4_PROXIED = `proxied CNAME: ${TEST_DOMAIN} is a Cloudflare zone, so Cloudflare uses orange-to-orange and serves the customer zone's own certificate, not one issued for the custom hostname; run with --cname-mode dns-only to judge it`;

/**
 * Every check, in the order it runs, for a proxied CNAME. `outOfScope` checks always say OUT OF SCOPE, with why, and
 * don't stop exit 0. `recordOnly` checks say RECORDED with what was seen, are never judged, and don't change the exit
 * code. Every other check must pass for exit 0. `planFor` gives the plan for a run's mode.
 */
const PROXIED_PLAN = [
  ["X15-1", "M6-X15, refused names, in a room with release on: Podster's own domains, the content domain, its fallback origin and names under them hostname_reserved (409); public suffixes (github.io, co.uk) hostname_public_suffix (409); an IP address, a wildcard and a single label 400 with their codes; malformed names hostname_invalid (400); a body that isn't { hostname } invalid_argument. None leaves a request"],
  ["X14-1", "M6-X14, before proof: with the name's CNAME to the fallback origin in place and only another room's challenge at its challenge name, the room's request stays pending (proof_pending), the configuration names no custom host, and the name doesn't serve the room's marker"],
  ["X15-2", "M6-X15, a race: two other rooms ask for one name and both challenges are published at once; exactly one room is claimed and the other refused with a reason code"],
  ["X26-1", "M6-X26: another room's value at the challenge's name didn't claim the name during the hold; once the room publishes its own, it is claimed within the wait"],
  ["X14-2", "M6-X14, after proof: Cloudflare reads the custom hostname active (setup_status active), and the release configuration names it as custom_host"],
  ["X14-3", "M6-X14 and 8e, over HTTPS on the custom name: the marker names the room's served release and merge commit; the index is the release's, with the content Worker's fixed headers, HSTS without includeSubDomains, and no cookie"],
  ["X14-4", "The certificate served for the custom name: the first live check that Cloudflare's HTTP validation passes with the */* route and its no-Worker validation routes in place (ssl.status active). With a DNS-only CNAME: a certificate Node trusts, naming the exact host, not the test zone's own, issued within 2 days", { recordOnly: X14_4_PROXIED }],
  ["X14-5", "M6-X14, removal: the request goes ending, the configuration names no custom host at once, and the name stops serving the marker within the wait"],
  ["X14-6", "A removed claim is freed (ended) once Cloudflare reads the custom hostname gone twice, GONE_SPAN_MS apart", { outOfScope: `it takes at least ${(2 * GONE_SPAN_MS) / 60_000} minutes after the delete; the run leaves the request ending, and the API's tests check the count` }],
  ["X26-2", "M6-26: a pending request nobody proved expires after 72 hours", { outOfScope: TIME_GAP }],
  ["X26-3", "M6-26: the daily recheck ends a claim after two definite noes at least 24 hours apart, or seven days with no match", { outOfScope: TIME_GAP }],
].map(([id, title, flags = {}]) => ({ id, title, outOfScope: flags.outOfScope ?? null, recordOnly: flags.recordOnly ?? null }));

/** The checks manual mode runs: room A's name, active, served over HTTPS, its certificate, and its removal. */
export const MANUAL_CHECKS = Object.freeze(["X14-2", "X14-3", "X14-4", "X14-5"]);
const NOT_IN_MANUAL = "not in manual mode: it runs room A's one name alone, with no race, no other room's challenge and no refused names";

/**
 * The plan for a CNAME mode and test domain: with `dns-only`, X14-4 is judged; with `proxied`, it is only recorded. With
 * a manual domain the CNAME is DNS-only (a proxied one is refused), only MANUAL_CHECKS run, judged, and every other check
 * says it isn't in manual mode.
 */
export function planFor(mode, domain = TEST_DOMAIN) {
  if (!TEST_DOMAINS.includes(domain)) throw new Error(`the test domain is one of ${TEST_DOMAINS.join(" and ")}`);
  const proxied = cnameProxied(mode);
  if (isManualDomain(domain)) {
    if (proxied) throw new Error("manual mode's CNAME is DNS-only");
    return PROXIED_PLAN.map((entry) => (MANUAL_CHECKS.includes(entry.id) ? { ...entry, outOfScope: null, recordOnly: null } : { ...entry, recordOnly: null, outOfScope: entry.outOfScope ? `not in manual mode; ${entry.outOfScope}` : NOT_IN_MANUAL }));
  }
  return proxied ? PROXIED_PLAN : PROXIED_PLAN.map((entry) => (entry.id === "X14-4" ? { ...entry, recordOnly: null } : entry));
}
/** The default run's plan. */
export const PLAN = planFor(DEFAULT_CNAME_MODE);

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

export const USAGE = `Usage: node m6-custom-domain-staging.mjs --base-url ${STAGING} [--dry-run] [--contract FILE] [--core-hostnames FILE] [--setup-wait S] [--merge-wait S] [--release-wait S] [--takedown-wait S] [--claim-wait S] [--active-wait S] [--serve-wait S] [--cname-mode dns-only|proxied] [--test-domain opster.dev|war3.org]

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
  --cname-mode       dns-only (the default) or proxied: whether the custom name's CNAME to ${CNAME_TARGET} is proxied.
                     dns-only is how a customer off Cloudflare publishes it: the content zone serves the custom hostname's
                     own certificate, and X14-4 judges it. proxied makes ${TEST_DOMAIN}, itself a Cloudflare zone,
                     orange-to-orange: its own certificate is served, and X14-4 is only recorded.
  --test-domain      ${TEST_DOMAIN} (the default, the full run, its DNS written through Cloudflare's API) or one of the
                     manual domains, ${MANUAL_DOMAINS.join(", ")}: manual-DNS mode. Its DNS is off Cloudflare and has no API,
                     so the run prints the TXT and CNAME for room A's one name, cd-<random>.<domain>, waits up to
                     ${MANUAL_DNS_WAIT_MS / 60_000} minutes for the owner to add them by hand (read from the domain's own name servers),
                     and runs X14-2 to X14-5 alone. No race, no decoy, no rooms B or C, no DNS API call, and the
                     OPSTER_* settings aren't read. Every way out prints the records to delete. Only dns-only.

  PODSTER_E2E_SIGNUP_SECRET   staging's test sign-up secret. Needed. Never printed.
  OPSTER_DNS_TOKEN            a Cloudflare API token with Zone, DNS, Edit on ${TEST_DOMAIN} alone, used only for TXT and
                              CNAME records under the run's own label. Needed, except in manual mode. Never printed.
  OPSTER_ZONE_ID              ${TEST_DOMAIN}'s zone ID. Needed, except in manual mode. Never printed.

  Every DNS write goes through one guard: only TXT at _podster-challenge.<name> and CNAME to ${CNAME_TARGET}, proxied
  as the mode says and no other way, only under the run's own label, and a delete only of a record the run made. Refuses to start, exit 3, when ${TEST_DOMAIN}
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
  const options = { base: undefined, dryRun: false, help: false, contract: undefined, coreHostnames: undefined, cnameMode: DEFAULT_CNAME_MODE, testDomain: TEST_DOMAIN };
  for (const [name, fallback] of Object.values(WAITS)) options[name] = fallback;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--base-url" || flag === "--contract" || flag === "--core-hostnames" || flag === "--cname-mode" || flag === "--test-domain" || WAITS[flag]) {
      const value = argv[++at];
      if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
      if (flag === "--base-url") options.base = value;
      else if (flag === "--contract") options.contract = value;
      else if (flag === "--core-hostnames") options.coreHostnames = value;
      else if (flag === "--cname-mode") {
        if (!CNAME_MODES.includes(value)) return { error: `--cname-mode is ${CNAME_MODES.join(" or ")}` };
        options.cnameMode = value;
      } else if (flag === "--test-domain") {
        if (!TEST_DOMAINS.includes(value)) return { error: `--test-domain is ${TEST_DOMAINS.join(" or ")}` };
        options.testDomain = value;
      }
      else {
        if (!/^\d+$/.test(value) || Number(value) < 10 || Number(value) > 1800) return { error: `${flag} takes whole seconds from 10 to 1800` };
        options[WAITS[flag][0]] = Number(value);
      }
    } else return { error: `unknown argument ${flag}` };
  }
  if (options.help) return { options };
  options.manual = isManualDomain(options.testDomain);
  if (options.manual && cnameProxied(options.cnameMode)) return { error: `--test-domain ${options.testDomain} is manual-DNS mode, whose CNAME is DNS-only: --cname-mode proxied isn't taken with it` };
  options.base ??= env.PODSTER_E2E_BASE_URL;
  if (!options.base) return { error: "pass --base-url, or set PODSTER_E2E_BASE_URL" };
  const refusal = stagingOnly(options.base);
  if (refusal) return { error: refusal };
  options.base = STAGING;
  return { options };
}
