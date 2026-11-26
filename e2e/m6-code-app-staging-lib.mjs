// The parts of m6-code-app-staging.mjs that touch nothing: the app it releases, the plan of checks and the run's exit
// code, the figures it holds the deployed content Worker to, and how it judges an app's answers. Kept apart so
// m6-code-app-staging-selftest.mjs can check them without a network, a secret or the e2e packages.
//
// The run is the staging run with a real app with code that the M6 plan owes ("The content Worker serves apps with
// code, built 2026-11-25", and ADR 0010's revision, section 10): its read, its marker, a write within and over the
// budget, a fetch and a socket refused, and an app that spins being stopped.
export { CONTENT_DOMAIN, contentNotFoundProblem, defaultHostProblem, deployGrantProblem, DEPLOY_GRANT, FIXED_HEADERS, fixedHeaderProblems, markerBody, markerProblem, MARKER_PATH, parseArgs, RELEASE_DIRECTORY, resultUrlProblem, secretProblem, STAGING, STAGING_ORG, slowestLine, statusProblems, unknownLabel, WAITS } from "./m6-release-staging-lib.mjs";
import { CONTENT_DOMAIN, FIXED_HEADERS, RELEASE_DIRECTORY, STAGING } from "./m6-release-staging-lib.mjs";

/**
 * The write budget the content Worker is deployed with: `WRITE_BUDGET_WRITES` and `WRITE_BUDGET_WINDOW_MS` in its
 * configuration (the owner's figure of 2026-11-16), which the self-test reads from that package's configuration test,
 * which pins them. Windows are aligned to the epoch, so every counter, and this run, agrees on where one starts.
 */
export const WRITE_CAP = { writes: 300, windowMs: 600_000 };
/** The dispatch's limits the content Worker is deployed with: `APP_LIMIT_CPU_MS` and `APP_LIMIT_SUBREQUESTS` there. */
export const APP_LIMITS = { cpuMs: 50, subRequests: 50 };
/** podster-outbound's one answer to every fetch an app makes (apps/outbound/src/refuse.ts), which the self-test reads there. */
export const OUTBOUND_REFUSAL = { status: 403, body: "outbound requests from apps are refused\n" };
/** The preflight's fixed allowance (apps/content/src/requests.ts). */
export const PREFLIGHT_ALLOWANCE = { methods: "GET, HEAD, POST, PUT, PATCH, DELETE", headers: "content-type" };

/**
 * How long a spinning app may take to be answered `502 app_error`, request and all. With 50 CPU milliseconds the
 * platform stops it at once; the spin would take seconds of CPU unstopped, and a platform-wide limit far longer. So an
 * answer later than this was stopped by something else, and fails.
 */
export const STOP_WITHIN_MS = 10_000;
/** The spin's loop, as rounds: seconds of CPU unstopped. Bounded, so an app the limit doesn't stop still ends. */
export const SPIN_ROUNDS = 4_000_000_000;
/**
 * How long the module's second after-headers route waits after its first bytes before its body fails: past the
 * content Worker's 1-second hold (`apps/content/src/hold.ts`), so the failure lands after the headers were sent (C09).
 * The route that spins past the hold waits as long.
 */
export const AFTER_HOLD_MS = 2_500;
/**
 * How long the module's first after-headers route waits after its first bytes before its body fails: well within the
 * content Worker's hold, so the content Worker answers before any header is sent (C09).
 *
 * C09's routes fail their own body rather than spin (2026-11-26). Staging's runs showed the CPU limit stops a spin
 * about 2.1 to 2.7 s of wall time after it begins, not 50 ms in: M6-C08's `/api/spin` answered `502` in 2607 ms
 * (run 45598024983) and 2741 ms (run 45874919600). So a spin begun 300 ms in was stopped past the hold, and could
 * never test it. And a CPU stop mid-stream reached the visitor as a body that ended normally, which no Worker in
 * front can tell from a whole one; that is recorded alongside C09 from `/api/spin-after-hold`, not judged.
 */
export const WITHIN_HOLD_MS = 300;
/** The fixed message the module's after-headers routes fail their body with. */
export const APP_BODY_FAILURE = "app body failed";
/** The light work the same module does, to show it computes when it isn't stopped. */
export const LIGHT_ROUNDS = 100_000;
/** Writes past the budget the run sends at most before it calls the budget not enforced: the burst is bounded. */
export const BURST_SPARE = 5;
/** How much of a window the burst needs left: it waits for the next window when less remains. */
export const BURST_NEEDS_MS = 120_000;
/** How far this machine's clock and the counter's may disagree on a window's edge, for the burst's arithmetic. */
export const CLOCK_MARGIN_MS = 5_000;

/**
 * The secrets M6-CX1 needs, held by the workflow's environment: a read-only Cloudflare API token on the content account
 * (the second account, which holds the content domain) with Account, D1, Read alone, and that account's ID. Without
 * both, CX1 is skipped, naming them, and the run's exit code doesn't change. scripts/wizards/store-list-token.sh adds
 * them.
 */
export const STORE_LIST_SECRETS = ["PODSTER_E2E_STORE_LIST_TOKEN", "PODSTER_E2E_CONTENT_ACCOUNT_ID"];
export const STORE_LIST_WIZARD = "scripts/wizards/store-list-token.sh";
/** How long CX1 waits, from release being switched off, for the store to leave the account's list. */
export const STORE_GONE_WAIT_MS = 20 * 60_000;
/** How often CX1 reads the list while it waits. */
export const STORE_POLL_MS = 30_000;

/** The test sign-up's takes one run spends, of 6 a minute and 40 a day across every run. The agent takes none. */
export const SIGN_UPS = [
  { who: "the room's owner", why: "owns the organization, the room and its repository, and links the coding agent. Taken only after the signed-out preflight" },
  { who: "the room's admin", why: "a second person, who doesn't control the agent: reviews and merges its task, switches release on and approves the release. Taken only once the owner's room shows release answers" },
];

/**
 * Every check, in the order it runs. `outOfScope` checks always say OUT OF SCOPE, with why, and don't stop exit 0.
 * `recordOnly` checks say RECORDED with what was seen, are never judged, and don't change the exit code. Every other
 * check must pass for exit 0.
 */
export const PLAN = [
  ["M6-C01", "An app with code (a worker/ module and podster-app.json asking for its store) is released through the real path: merged, asked for by an agent holding a deploy grant, approved by the room's admin who doesn't control it, and served; the result URL is its default host on the content domain"],
  ["M6-C02", "The release marker on the app's host is the static file, byte for byte, not the module's answer, while a path with no file reaches the module; HEAD of the marker is 200"],
  ["M6-C03", "A read reaches the module, with the fixed headers: no-store, Access-Control-Allow-Origin null, the sandbox CSP, HSTS, nosniff, no-referrer; the app's Set-Cookie, CORS, Cache-Control and own headers are dropped; HEAD of the same path is 200; the static index on the same host gets the same fixed headers"],
  ["M6-C04", "The module's environment holds exactly one binding, STORE, and it reads a row from that store"],
  ["M6-C05", "Writes: the content Worker answers the preflight itself (204, origin null, the fixed methods and content-type); a JSON POST reaches the module with its body, with the fixed headers and without the app's Set-Cookie; a POST that isn't JSON is refused 415 write_not_json"],
  ["M6-C06", `The write budget, at the deployed ${WRITE_CAP.writes} writes a ${WRITE_CAP.windowMs / 60_000}-minute window: every write within it reaches the app, and the first over it is refused 429 write_budget_spent, with a Retry-After to the window's end that the page may read`],
  ["M6-C07", "The app's fetch gets podster-outbound's 403 and fixed body, and its connect() is refused before a socket opens"],
  ["M6-C08", `An app that spins is stopped by the ${APP_LIMITS.cpuMs} ms CPU limit: 502 app_error within ${STOP_WITHIN_MS / 1000} s, with nothing of the app's in it; the same module's light work answers 200`],
  ["M6-C09", `An app whose body fails after its answer's headers were sent never reaches a visitor as a clean 200: failing ${WITHIN_HOLD_MS} ms in, within the content Worker's hold, it is 502 app_error; failing ${AFTER_HOLD_MS / 1000} s in, past the hold, it is a 200 whose body was aborted; with the fixed headers either way. What a CPU stop ${AFTER_HOLD_MS / 1000} s in reaches a visitor as is recorded with it, not judged: the platform most likely ends that body normally, which no Worker in front could tell from a whole one; unconfirmed until /api/after-hold passes on staging`],
  ["M6-C10", "Unpublish: release switched off in the room; the host and its marker answer the content Worker's not found within the wait; a write gets 405 method_not_allowed and never reaches the app; while release is off the task's status says no release exists"],
  ["M6-CX1", "From the operator's side: the app's store, the one D1 database the release made in the content account, is gone from that account's list once the unpublish retired its label", { needs: STORE_LIST_SECRETS }],
  ["M6-C11", "The room made private again, and the host still answers not found"],
].map(([id, title, flags = {}]) => ({ id, title, outOfScope: flags.outOfScope ?? null, recordOnly: flags.recordOnly ?? null, needs: flags.needs ?? null }));

const LABELS = { pass: "PASS", fail: "FAIL", outOfScope: "OUT OF SCOPE", recorded: "RECORDED", skipped: "SKIP" };

/** Results by ID, printed as they come: PASS, FAIL, OUT OF SCOPE, RECORDED or SKIP. */
export class Results {
  results = [];
  #say;
  #known;

  constructor(plan = PLAN, say = console.log) {
    this.#known = new Map(plan.map((entry) => [entry.id, entry]));
    this.#say = say;
  }

  /**
   * `status` is `pass`, `fail`, `outOfScope`, `recorded` or `skipped`. Each planned ID gets one result, and no other ID
   * gets any. Only a check that `needs` secrets may be skipped, for want of them.
   */
  add(id, status, detail = "") {
    const entry = this.#known.get(id);
    if (!entry) throw new Error(`${id} isn't in the plan`);
    if (this.has(id)) throw new Error(`${id} already has a result`);
    if (!LABELS[status]) throw new Error(`${status} isn't a result`);
    if ((status === "outOfScope") !== Boolean(entry.outOfScope)) throw new Error(`${id} ${entry.outOfScope ? "is" : "isn't"} out of scope`);
    if ((status === "recorded") !== Boolean(entry.recordOnly)) throw new Error(`${id} ${entry.recordOnly ? "is only recorded" : "is judged"}`);
    if (status === "skipped" && !entry.needs) throw new Error(`${id} needs nothing, so it can't be skipped`);
    this.results.push({ id, status, detail });
    this.#say(`${LABELS[status]} ${id.padEnd(7)} ${entry.title}${detail ? `\n             ${detail}` : ""}`);
  }

  has(id) {
    return this.results.some((r) => r.id === id);
  }

  passed(id) {
    return this.results.some((r) => r.id === id && r.status === "pass");
  }

  summary() {
    const count = (status) => this.results.filter((r) => r.status === status).length;
    return `${count("pass")} passed, ${count("fail")} failed, ${count("outOfScope")} out of scope, ${count("recorded")} recorded${count("skipped") ? `, ${count("skipped")} skipped` : ""}`;
  }
}

/**
 * The run's exit code, and what it didn't show. 0 only when every judged check passed. Out-of-scope and recorded checks
 * never change the code, and nor does a check skipped for want of the secrets it needs: it is named in `skipped`.
 */
export function runOutcome(results, plan = PLAN) {
  const status = new Map(results.results.map((r) => [r.id, r.status]));
  const skipped = plan.filter((entry) => entry.needs && status.get(entry.id) === "skipped").map((entry) => entry.id);
  const judged = plan.filter((entry) => !entry.outOfScope && !entry.recordOnly && !skipped.includes(entry.id));
  const failed = judged.filter((entry) => status.get(entry.id) === "fail").map((entry) => entry.id);
  const unshown = judged.filter((entry) => status.get(entry.id) !== "pass").map((entry) => entry.id);
  return { code: failed.length || unshown.length || judged.length === 0 ? 1 : 0, failed, unshown, skipped };
}

/** Exit codes, named once: the same as m6-release-staging.mjs's. */
export const EXIT = { passed: 0, failed: 1, refused: 2, releaseNotOn: 3 };

export const USAGE = `Usage: node m6-code-app-staging.mjs --base-url ${STAGING} [--dry-run] [--contract FILE] [--setup-wait S] [--merge-wait S] [--release-wait S] [--takedown-wait S]

M6's staging run with a real app with code: one tiny app (a worker/ module and podster-app.json asking for its store)
is merged and released through the real path, then its host is asked for its marker, a read, writes within and over
the budget, an outbound fetch and socket, a spin past the CPU limit, and a body that fails after the headers. Then the
app is unpublished. Run from GitHub Actions (.github/workflows/m6-code-app-staging.yml): the owner's machine can't
reach the content domain.

  --dry-run         check the configuration and the contract, and print the plan. Sends nothing anywhere.
  --contract        the OpenAPI contract read for the deploy grant's route. Defaults to packages/contracts/openapi.yaml.
  --setup-wait      seconds to wait for the room's repository to be ready (default 300).
  --merge-wait      seconds to wait for the merge (default 300).
  --release-wait    seconds to wait for the release to be served (default 300).
  --takedown-wait   seconds to wait for the host to stop serving after the unpublish (default 180).

  PODSTER_E2E_SIGNUP_SECRET     staging's test sign-up secret. Needed. Never printed.
  PODSTER_E2E_STORE_LIST_TOKEN  a read-only token on the content account (Account, D1, Read alone), for M6-CX1.
  PODSTER_E2E_CONTENT_ACCOUNT_ID  that account's ID, for M6-CX1. Without both, M6-CX1 is skipped, naming them, and
                                the exit code doesn't change. Neither is printed, nor any store's name or ID.

  Refuses to start, exit 3, unless the contract's grant route gives a deploy grant; signed out, staging lists
  deploy_release; and ${CONTENT_DOMAIN} answers an unknown app's host with the content Worker's own not found. Then, after
  the owner's sign-up only: the room answers its release configuration, and a request isn't refused
  release_not_available.

  It takes ${SIGN_UPS.length} test sign-ups (the room's owner and its admin), makes one public repository in podsterdev,
  merges one task, releases once (one of the room's 2 uploads an hour), and sends about ${WRITE_CAP.writes + 20} small
  requests to the app's host, one at a time: the write budget is shown at its deployed figure. It may wait up to
  ${Math.ceil((BURST_NEEDS_MS + CLOCK_MARGIN_MS) / 1000)} s for a fresh write window. It cleans up: release off (which unpublishes the app and retires its
  label), the room private, grants taken back, the agent disconnected, sessions signed out. It can't delete the
  repository: it prints its name for the owner to archive or delete. Person IDs are printed as their role. With
  M6-CX1's secrets, it lists the content account's D1 databases before and after the release, and after the unpublish
  every ${STORE_POLL_MS / 1000} s for up to ${STORE_GONE_WAIT_MS / 60_000} minutes, until the app's store is gone: GETs only.

  Exit 0 only when every judged check passed; 1 otherwise; 2 for a refused configuration or a failed preflight, with no
  sign-up taken; 3 when release isn't on with a provider, with at most the owner's sign-up.`;

// ---- the app ----

/** The manifest: the entry module, by its name under worker/, and the app's one store. */
export const MANIFEST = { main: "index.js", store: true };

/**
 * The app's one module, as committed: plain JavaScript, nothing of Podster's in it, since the repository is public.
 * Every path with no static file gets JSON naming the module as its source; the paths under /api/ are the run's probes.
 * Every answer of the module's carries headers the content Worker must drop. It reports its bindings' names, never
 * their values. `tag` is written into it, so an answer says which run's module gave it.
 */
export function moduleSource(tag) {
  if (!/^[a-z0-9-]{1,40}$/.test(tag)) throw new Error("not a tag");
  return String.raw`import { connect } from "cloudflare:sockets";
const TAG = ${JSON.stringify(tag)};
// Headers the content Worker must never pass to a visitor.
const DROPPED = { "set-cookie": "app_probe=1; Path=/; Secure", "access-control-allow-origin": "*", "access-control-allow-credentials": "true", "cache-control": "public, max-age=3600", "x-app-probe": "1" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...DROPPED } });
const within = (promise, ms) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error("probe timeout"), { name: "ProbeTimeout" })), ms))]);
const err = (e) => ({ name: String(e && e.name), message: String(e && e.message).slice(0, 200) });
function spin(rounds) {
  let x = 1;
  for (let i = 0; i < rounds; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
  return x;
}
async function tryFetch(url) {
  try {
    const answer = await within(fetch(url, { redirect: "manual" }), 8000);
    return { url, status: answer.status, body: (await within(answer.text(), 4000)).slice(0, 200) };
  } catch (e) {
    return { url, error: err(e) };
  }
}
async function trySocket(hostname, port) {
  const out = { hostname, port, opened: false, bytes: 0 };
  let socket;
  try {
    socket = connect({ hostname, port });
  } catch (e) {
    return { ...out, at: "connect", error: err(e) };
  }
  try {
    await within(socket.opened, 6000);
    out.opened = true;
    const writer = socket.writable.getWriter();
    await within(writer.write(new TextEncoder().encode("HEAD / HTTP/1.0\r\nHost: " + hostname + "\r\n\r\n")), 4000);
    const chunk = await within(socket.readable.getReader().read(), 6000);
    out.bytes = chunk && chunk.value ? chunk.value.length : 0;
  } catch (e) {
    out.at = out.opened ? "use" : "opened";
    out.error = err(e);
  }
  try {
    socket.close();
  } catch {}
  return out;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = { from: "module", tag: TAG, method: request.method, path: url.pathname, env: Object.keys(env || {}).sort() };
    if (url.pathname === "/api/echo" && request.method === "POST") return json({ ...base, received: await request.json() });
    if (url.pathname === "/api/store") {
      if (!env || !env.STORE) return json({ ...base, store: "none" });
      try {
        return json({ ...base, store: await within(env.STORE.prepare("select 7 as seven").first(), 8000) });
      } catch (e) {
        return json({ ...base, store: "error", error: err(e) });
      }
    }
    if (url.pathname === "/api/outbound") {
      const fetches = [await tryFetch("https://example.com/"), await tryFetch("http://example.com/")];
      const sockets = [await trySocket("example.com", 80), await trySocket("example.com", 443)];
      return json({ ...base, fetches, sockets });
    }
    if (url.pathname === "/api/spin") return json({ ...base, spun: spin(${SPIN_ROUNDS}) });
    if (url.pathname === "/api/spin-light") return json({ ...base, spun: spin(${LIGHT_ROUNDS}) });
    if (url.pathname === "/api/after-headers" || url.pathname === "/api/after-hold") {
      const encoder = new TextEncoder();
      const wait = url.pathname === "/api/after-headers" ? ${WITHIN_HOLD_MS} : ${AFTER_HOLD_MS};
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("start\n"));
          await new Promise((done) => setTimeout(done, wait));
          controller.error(new Error(${JSON.stringify(APP_BODY_FAILURE)}));
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/api/spin-after-hold") {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("start\n"));
          await new Promise((done) => setTimeout(done, ${AFTER_HOLD_MS}));
          controller.enqueue(encoder.encode("spun " + spin(${SPIN_ROUNDS}) + "\n"));
          controller.enqueue(encoder.encode("end\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json(base);
  },
};
`;
}

/** The app's files, by path in the repository: a page, the manifest and the module, under the release directory. */
export function appFiles(tag) {
  return {
    [`${RELEASE_DIRECTORY}/index.html`]: "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Hello</title></head><body><h1>Hello</h1><p>An app with code.</p></body></html>\n",
    [`${RELEASE_DIRECTORY}/podster-app.json`]: `${JSON.stringify(MANIFEST)}\n`,
    [`${RELEASE_DIRECTORY}/worker/index.js`]: moduleSource(tag),
  };
}

// ---- judging the host's answers ----

/** The app's headers that must never reach a visitor, as the module sends them. */
export const DROPPED_HEADERS = ["set-cookie", "access-control-allow-credentials", "x-app-probe"];

/**
 * What's wrong with one answer from a host with code, against its fixed headers: the content Worker's four on every
 * answer, `no-store`, readable by the origin `null` only, and none of the app's dropped headers.
 */
export function codeHeaderProblems(headers) {
  const h = new Headers(headers);
  const problems = Object.entries(FIXED_HEADERS).filter(([name, okay]) => !okay(h.get(name))).map(([name]) => `${name} isn't the content Worker's`);
  if (h.get("cache-control") !== "no-store") problems.push(`cache-control is ${JSON.stringify(h.get("cache-control"))}, not no-store`);
  if (h.get("access-control-allow-origin") !== "null") problems.push(`access-control-allow-origin is ${JSON.stringify(h.get("access-control-allow-origin"))}, not null`);
  for (const name of DROPPED_HEADERS) if (h.has(name)) problems.push(`the app's ${name} was passed on`);
  return problems;
}

/** The module's JSON answer, or null when the body isn't one from this run's module. */
export function moduleAnswer(body, tag) {
  try {
    const value = JSON.parse(body);
    return value?.from === "module" && value.tag === tag ? value : null;
  } catch {
    return null;
  }
}

/** Why a preflight's answer isn't the content Worker's own allowance, or null. */
export function preflightProblem({ status, body, headers }) {
  const h = new Headers(headers);
  if (status !== 204) return `answered ${status}, not 204`;
  if (body) return "it has a body";
  if (h.get("access-control-allow-origin") !== "null") return "it isn't readable by the origin null only";
  if (h.get("access-control-allow-methods") !== PREFLIGHT_ALLOWANCE.methods) return "its methods aren't the fixed ones";
  if (h.get("access-control-allow-headers") !== PREFLIGHT_ALLOWANCE.headers) return "its headers aren't the fixed one";
  if (h.get("cache-control") !== "no-store") return "it may be kept";
  return null;
}

/** Why the module's outbound report doesn't show every fetch refused by podster-outbound and every socket refused, or null. */
export function outboundProblems(report) {
  if (!report || !Array.isArray(report.fetches) || !Array.isArray(report.sockets) || report.fetches.length === 0 || report.sockets.length === 0) return ["the module gave no outbound report"];
  const problems = [];
  for (const f of report.fetches) if (f.status !== OUTBOUND_REFUSAL.status || f.body !== OUTBOUND_REFUSAL.body) problems.push(`fetch ${f.url} got ${f.status ?? f.error?.name ?? "nothing"}, not podster-outbound's refusal`);
  for (const s of report.sockets) {
    if (s.opened || s.bytes > 0) problems.push(`the socket to ${s.hostname}:${s.port} opened or read`);
    // A socket that only timed out never answered either way: that isn't a refusal.
    else if (!["connect", "opened"].includes(s.at) || !s.error || s.error.name === "ProbeTimeout") problems.push(`the socket to ${s.hostname}:${s.port} wasn't refused (${s.error?.name ?? "no error"})`);
  }
  return problems;
}

/** Why a spinning app's answer isn't the content Worker's own stop, within STOP_WITHIN_MS, or null. */
export function spinProblem({ status, body, headers }, ms, tag) {
  if (moduleAnswer(body, tag)) return `the module finished its spin and answered ${status}: the CPU limit didn't stop it`;
  if (status !== 502 || String(body).trim() !== "app_error") return `answered ${status}, not 502 app_error`;
  if (ms > STOP_WITHIN_MS) return `it was stopped only after ${ms} ms, so not by the ${APP_LIMITS.cpuMs} ms CPU limit`;
  const problems = codeHeaderProblems(headers);
  return problems.length ? problems.join("; ") : null;
}

/** The start of the write window `ms` falls in: windows are aligned to the epoch, as the counter's are. */
export const windowStart = (ms, windowMs = WRITE_CAP.windowMs) => ms - (((ms % windowMs) + windowMs) % windowMs);

/**
 * When the burst may start, and how many of its writes the budget should admit. `nowMs` is this machine's clock;
 * `earlier` is when each write the run sent before was counted. The burst needs BURST_NEEDS_MS of its window left and
 * must start CLOCK_MARGIN_MS into it; otherwise it waits for the next window, where nothing earlier counts. In the
 * window it starts in, an earlier write counts for certain if it was sent CLOCK_MARGIN_MS or more after the window
 * began, and may count if within that margin of its start.
 */
export function burstPlan(nowMs, earlier = [], cap = WRITE_CAP, needMs = BURST_NEEDS_MS, marginMs = CLOCK_MARGIN_MS) {
  let start = windowStart(nowMs, cap.windowMs);
  let waitMs = 0;
  if (start + cap.windowMs - nowMs < needMs) {
    start += cap.windowMs;
    waitMs = start + marginMs - nowMs;
  } else if (nowMs - start < marginMs) waitMs = start + marginMs - nowMs;
  const certain = earlier.filter((at) => at >= start + marginMs && at < start + cap.windowMs).length;
  const maybe = earlier.filter((at) => at >= start - marginMs && at < start + marginMs).length;
  return { waitMs, windowStartMs: start, admitted: { least: Math.max(0, cap.writes - certain - maybe), most: Math.max(0, cap.writes - certain) } };
}

/**
 * Why the answer to the first write over the budget isn't the content Worker's refusal, or null: 429
 * write_budget_spent, a Retry-After of whole seconds to the window's end (within the clock margin, and at least 1 and at
 * most the window), exposed to the page, with the fixed headers.
 */
export function budgetRefusalProblem({ status, body, headers }, nowMs, cap = WRITE_CAP) {
  const h = new Headers(headers);
  if (status !== 429 || String(body).trim() !== "write_budget_spent") return `answered ${status} ${String(body).trim().slice(0, 40)}, not 429 write_budget_spent`;
  const retry = h.get("retry-after") ?? "";
  if (!/^[1-9][0-9]*$/.test(retry) || Number(retry) > cap.windowMs / 1000) return `its Retry-After is ${JSON.stringify(retry)}, not whole seconds within the window`;
  const toEnd = Math.ceil((windowStart(nowMs, cap.windowMs) + cap.windowMs - nowMs) / 1000);
  if (Math.abs(Number(retry) - toEnd) > CLOCK_MARGIN_MS / 1000 + 1) return `its Retry-After is ${retry} s, but the window ends in about ${toEnd} s`;
  if (!(h.get("access-control-expose-headers") ?? "").split(",").map((v) => v.trim().toLowerCase()).includes("retry-after")) return "the page can't read its Retry-After";
  const problems = codeHeaderProblems(headers);
  return problems.length ? problems.join("; ") : null;
}

/**
 * Why what a visitor got from an app whose body failed after its headers isn't what `expected` says, or null (C09,
 * 2026-11-26). `held`: the body failed within the content Worker's hold, before the headers, so the answer is its own
 * 502 app_error. `aborted`: the body failed past the hold, so the answer is a 200 whose body failed and didn't end. A
 * 200 whose body ended normally always fails, cut short or whole, and so does a body that only hung until the run gave
 * up, which is no abort.
 */
export function afterHeadersProblem({ status, text, bytes, ended, error, headers }, expected) {
  const body = String(text ?? "");
  if (status === undefined || status === null) return `no answer: ${error ?? "nothing"}`;
  if (body.includes("end\n")) return `the module finished and answered ${status}: its body didn't fail`;
  if (status === 200 && ended) return `a truncated 200: ${bytes} byte(s) and a body that ended normally, which a visitor can't tell from a whole answer`;
  if (expected === "held") {
    if (status !== 502 || body.trim() !== "app_error" || !ended) return `answered ${status} ${JSON.stringify(body.trim().slice(0, 40))}${ended ? "" : ", whose body failed"}, not the content Worker's 502 app_error from its hold`;
  } else if (expected === "aborted") {
    if (status !== 200) return `answered ${status} ${JSON.stringify(body.trim().slice(0, 40))}, not a 200 whose body was aborted past the hold`;
    if (/^(TimeoutError|AbortError)\b/.test(String(error ?? ""))) return `the body hung until the run gave up (${error}), which isn't an abort`;
    if (!body.startsWith("start\n")) return `a 200 whose body failed, but began ${JSON.stringify(body.slice(0, 20))}, not the module's start`;
  } else throw new Error(`afterHeadersProblem: expected is "held" or "aborted", not ${JSON.stringify(expected)}`);
  const problems = codeHeaderProblems(headers ?? []);
  return problems.length ? problems.join("; ") : null;
}

/** What a visitor got from an app that passed a limit after its headers: one line, for the run's output. */
export function afterHeadersLine({ status, contentType, cacheControl, allowOrigin, text, bytes, ended, error, ms }) {
  const seen = JSON.stringify(String(text ?? "").slice(0, 60));
  return `status ${status ?? "none"}, content-type ${contentType ?? "none"}, cache-control ${cacheControl ?? "none"}, allow-origin ${allowOrigin ?? "none"}; body ${bytes} byte(s) ${seen}; ${ended ? "the body ended normally" : `the body ended with ${error ?? "nothing"}`}; ${ms} ms`;
}

// ---- the store's deletion, from the operator's side (M6-CX1) ----

/** D1 databases asked for in one page of the list, and pages read at most: the API's reconcile's figures (core's LIST_PAGE and MAX_LIST_PAGES). */
export const STORE_LIST_PAGE = 100;
export const STORE_LIST_PAGES = 20;
/** Cloudflare's API. The only host CX1 sends to, and only GETs of the account's D1 list. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** A store's name as the room gives it (podster_core::app_store::is_store_name): the prefix, then 32 lower-case hex digits. */
const STORE_NAME = /^podster-store-[0-9a-f]{32}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const API_TOKEN = /^[A-Za-z0-9_-]{40,}$/;

/**
 * CX1's configuration from the environment: `{ config: { token, accountId } }`; `{ needs }`, the line a skipped CX1
 * prints, when either secret is unset or empty (as GitHub passes an unset one); or `{ problem }` when one is set but
 * malformed, which fails CX1 rather than skipping it.
 */
export function storeListConfig(env = {}) {
  const missing = STORE_LIST_SECRETS.filter((name) => !env[name]);
  if (missing.length) return { needs: `needs ${missing.join(" and ")} in the workflow's environment (${STORE_LIST_WIZARD} adds them, run by the owner)` };
  const [token, accountId] = STORE_LIST_SECRETS.map((name) => env[name]);
  if (!API_TOKEN.test(token)) return { problem: `${STORE_LIST_SECRETS[0]} isn't shaped like a Cloudflare API token` };
  if (!ACCOUNT_ID.test(accountId)) return { problem: `${STORE_LIST_SECRETS[1]} isn't 32 hex digits` };
  return { config: { token, accountId } };
}

/**
 * The account's Podster stores, by a whole read of its D1 list: `{ stores: [{ id, name }] }`, or `{ problem }`. Only
 * GETs, each with the token in the Authorization header alone. A list longer than STORE_LIST_PAGES pages, a page that
 * isn't Cloudflare's success, or one whose entries aren't databases is no list. The answer is never printed: problems
 * carry statuses and Cloudflare's error codes only.
 */
export async function listStores({ token, accountId }, fetchFn = fetch) {
  const stores = [];
  for (let page = 1; page <= STORE_LIST_PAGES; page++) {
    let res, body;
    try {
      res = await fetchFn(`${CLOUDFLARE_API}/accounts/${accountId}/d1/database?page=${page}&per_page=${STORE_LIST_PAGE}`, { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      body = await res.json();
    } catch (error) {
      return { problem: `the account's D1 list couldn't be read (${error?.name ?? "Error"})` };
    }
    if (!res.ok || body?.success !== true || !Array.isArray(body.result)) {
      const codes = Array.isArray(body?.errors) ? body.errors.map((e) => e?.code).filter(Number.isInteger) : [];
      return { problem: `the account's D1 list answered ${res.status}${codes.length ? ` (Cloudflare ${codes.join(", ")})` : ""}` };
    }
    for (const entry of body.result) {
      if (typeof entry?.uuid !== "string" || typeof entry?.name !== "string") return { problem: "the account's D1 list held an entry with no uuid or name" };
      if (STORE_NAME.test(entry.name)) stores.push({ id: entry.uuid, name: entry.name });
    }
    const pages = body.result_info?.total_pages;
    if (body.result.length < STORE_LIST_PAGE || (Number.isInteger(pages) && page >= pages)) return { stores };
  }
  return { problem: `the account's D1 list is longer than ${STORE_LIST_PAGES} pages of ${STORE_LIST_PAGE}, so it can't be read whole` };
}

/**
 * The app's store: the one Podster store listed after the release and not before it, `{ store }`, or `{ problem }`.
 * None new means the release made none; more than one means another room made one meanwhile, and which is the app's
 * can't be told, so CX1 decides nothing.
 */
export function appStoreOf(before, after) {
  const known = new Set(before.flatMap((s) => [s.id, s.name]));
  const made = after.filter((s) => !known.has(s.id) && !known.has(s.name));
  if (made.length === 1) return { store: made[0] };
  if (made.length === 0) return { problem: "no Podster store was listed after the release that wasn't before it, though the app asked for one" };
  return { problem: `${made.length} Podster stores were made in the account during the release, so which is the app's can't be told` };
}

/** Whether a store is gone from a whole list: neither its ID nor its name is in it. */
export const storeGone = (stores, store) => !stores.some((s) => s.id === store.id || s.name === store.name);
