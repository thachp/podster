import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { type Deps, handle, sandboxPolicy } from "../src/handle";
import { base64url, ENTER_PAGE, ENTER_POLICY, ENTER_SCRIPT, ENTER_SCRIPT_HASH, MARKER_HEADER, PREVIEW_ROBOTS, PREVIEW_SANDBOX, publicKeysFromSetting, SESSION_COOKIE, STATE_COOKIE, STOPPED_PAGE, webCryptoKeys } from "../src/preview";

// The gate on preview hosts (M8 step 8; docs/m8-preview-plan.md, 5.3 to 5.8; spike P1's results and step 7's
// requirements), through the content Worker's handler, against stand-ins for its bindings. Tokens are signed here with
// a key pair made for this file, in the API's wire form (`podster_core::preview_access::token_payload`), and checked
// by the Worker with the public half only, as configured.

const DOMAIN = "apps-test.example";
const LABEL = "pv7q2";
const HOST = `${LABEL}.${DOMAIN}`;
const ORIGIN = `https://${HOST}`;
const SCRIPT = `${LABEL}.rel_0123456789abcdef0123456789abcdef`;
const SLOT = "pvw_0123456789abcdef0123456789abcdef";
const OTHER_SLOT = "pvw_fedcba9876543210fedcba9876543210";
const SID = "pvs_00112233445566778899aabbccddeeff";
const KID = "test-kid";
const EPOCH = 4;
const ACCESS = "https://app-test.example.org";
// A production app beside it, with code, on its own label.
const PROD_LABEL = "k3v9q2";
const PROD_HOST = `${PROD_LABEL}.${DOMAIN}`;
const PROD_SCRIPT = `${PROD_LABEL}.rel_0123456789abcdef0123456789abcdef`;
const NOW = 1_800_000_000_000;
const RANDOM = "A".repeat(42) + "E";
const OTHER_RANDOM = "B".repeat(42) + "A";

let signer: CryptoKey;
let otherSigner: CryptoKey;
let publicHex: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  signer = pair.privateKey;
  publicHex = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
  otherSigner = ((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
});

const sha = (text: string) => createHash("sha256").update(text).digest("base64url");
const ST = () => sha(RANDOM);

type Claims = { typ: string; kid?: string; aud?: string; pvw?: string; sid?: string | null; ep?: number; iat?: number; exp?: number; st?: string | null };
/** The payload's JSON exactly as Rust writes it: keys in the fixed order, `sid` and `st` only on a browser's token. */
function json(c: Claims): string {
  const browser = c.typ !== "marker";
  const sid = c.sid === undefined ? (browser ? SID : null) : c.sid;
  const st = c.st === undefined ? (browser ? ST() : null) : c.st;
  const iat = c.iat ?? NOW - 1000;
  const exp = c.exp ?? iat + (c.typ === "session" ? 3_600_000 : 60_000);
  let out = `{"typ":"${c.typ}","kid":"${c.kid ?? KID}","aud":"${c.aud ?? HOST}","pvw":"${c.pvw ?? SLOT}"`;
  if (sid !== null) out += `,"sid":"${sid}"`;
  out += `,"ep":${c.ep ?? EPOCH},"iat":${iat},"exp":${exp}`;
  if (st !== null) out += `,"st":"${st}"`;
  return `${out}}`;
}
async function signed(text: string, key = signer): Promise<string> {
  const payload = Buffer.from(text).toString("base64url");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`podster-preview-token/v1.${payload}`)));
  return `${payload}.${base64url(signature)}`;
}
const token = (c: Claims, key = signer) => signed(json(c), key);

type World = { deps: Deps; kv: Map<string, string>; sent: { script: string; via: "APPS" | "PREVIEW_APPS"; request: Request }[]; logged: unknown[]; clock: { now: number }; randoms: number };

function world(previews = true): World {
  const w: World = { kv: new Map(), sent: [], logged: [], clock: { now: NOW }, randoms: 0, deps: undefined as unknown as Deps };
  w.kv.set(HOST, `preview:${SLOT}:${EPOCH}:code:${SCRIPT}`);
  w.kv.set(PROD_HOST, `code:${PROD_SCRIPT}`);
  // Every app answers every path, every method, with its own body and headers of its own choosing.
  const app = (script: string, via: "APPS" | "PREVIEW_APPS") => ({
    async fetch(request: Request) {
      w.sent.push({ script, via, request });
      return new Response(`APP BODY ${script}`, { headers: { "content-type": "text/html", "cross-origin-opener-policy": "unsafe-none", "set-cookie": "a=b", "access-control-allow-origin": "*" } });
    },
  });
  const keys = publicKeysFromSetting(`${KID}:${publicHex}`);
  if (keys === null) throw new Error("the test's key isn't read");
  w.deps = {
    entries: { get: async (key) => w.kv.get(key) ?? null },
    apps: { get: (script) => app(script, "APPS") },
    now: () => w.clock.now,
    wait: () => new Promise(() => {}),
    stop: { read: null },
    domain: DOMAIN,
    codeApps: true,
    limits: { cpuMs: 50, subRequests: 5 },
    writes: { admit: async () => ({ ok: true }) },
    log: (line) => w.logged.push(line),
    previews: previews ? { apps: { get: (script) => app(script, "PREVIEW_APPS") }, keys: webCryptoKeys(keys), accessOrigin: ACCESS } : null,
    random: () => {
      w.randoms += 1;
      return new Uint8Array(32).fill(w.randoms);
    },
  };
  return w;
}

const req = (w: World, path: string, init: RequestInit = {}, host = HOST) => handle(new Request(`https://${host}${path}`, init), w.deps);
const cookie = (session: string | null, state: string | null = RANDOM) => [session === null ? null : `${SESSION_COOKIE}=${session}`, state === null ? null : `${STATE_COOKIE}=${state}`].filter(Boolean).join("; ");
const nav = (cookies = "", extra: Record<string, string> = {}) => ({ headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html", ...(cookies ? { cookie: cookies } : {}), ...extra } });
const fetchy = (cookies = "", extra: Record<string, string> = {}) => ({ headers: { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", ...(cookies ? { cookie: cookies } : {}), ...extra } });
const headersOf = (response: Response) => Object.fromEntries([...response.headers.entries()].filter(([name]) => name !== "set-cookie").sort());
const setCookies = (response: Response) => response.headers.getSetCookie();

/** Every header a preview host's answer carries, its own and an app's. */
const PREVIEW_FIXED = {
  "cache-control": "private, no-store, no-transform",
  "content-security-policy": `${PREVIEW_SANDBOX}; ${sandboxPolicy(ORIGIN).split("; ").slice(1).join("; ")}`,
  "cross-origin-opener-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

async function served(w: World, response: Response) {
  return [response.status, await response.text(), w.sent.map((sent) => sent.via)];
}

describe("the gate: a session, bound to the state cookie on every request", () => {
  it("serves the app through the preview namespace, and only that, for a valid session with its own state cookie", async () => {
    const w = world();
    const response = await req(w, "/page?x=1", nav(cookie(await token({ typ: "session" }))));
    expect(await served(w, response)).toEqual([200, `APP BODY ${SCRIPT}`, ["PREVIEW_APPS"]]);
    expect(w.sent[0].script).toBe(SCRIPT);
    // No cookie of the visitor's reaches the app, and the app's own Set-Cookie and COOP never reach the visitor.
    expect(w.sent[0].request.headers.has("cookie")).toBe(false);
    expect(setCookies(response)).toEqual([]);
    expect(headersOf(response)).toEqual({ ...PREVIEW_FIXED, "content-type": "text/html", "content-length": String(`APP BODY ${SCRIPT}`.length) });
  });

  it("refuses, and never asks the app, for every session that isn't this browser's, this host's, this slot's and this epoch's", async () => {
    const cases: [string, Promise<string>, string | null][] = [
      ["no state cookie", token({ typ: "session" }), null],
      ["another browser's state cookie", token({ typ: "session" }), OTHER_RANDOM],
      ["a state cookie of no form", token({ typ: "session" }), "short"],
      ["a ticket as the session", token({ typ: "ticket" }), RANDOM],
      ["a marker token as the session", token({ typ: "marker" }), RANDOM],
      ["another host's", token({ typ: "session", aud: PROD_HOST }), RANDOM],
      ["another slot's", token({ typ: "session", pvw: OTHER_SLOT }), RANDOM],
      ["an epoch below the entry's", token({ typ: "session", ep: EPOCH - 1 }), RANDOM],
      ["a lifetime past an hour", token({ typ: "session", iat: NOW - 1000, exp: NOW - 1000 + 3_600_001 }), RANDOM],
      ["a key this Worker doesn't hold", token({ typ: "session", kid: "other-kid" }), RANDOM],
      ["a forged signature", token({ typ: "session" }, otherSigner), RANDOM],
      ["claims in another spelling", signed(json({ typ: "session" }).replaceAll(`"ep":${EPOCH}`, `"ep":${EPOCH}.0`)), RANDOM],
      ["claims with a key added", signed(`${json({ typ: "session" }).slice(0, -1)},"x":1}`), RANDOM],
      ["claims in another order", signed(json({ typ: "session" }).replaceAll(`{"typ":"session","kid":"${KID}"`, `{"kid":"${KID}","typ":"session"`)), RANDOM],
      ["a state hash for another state", token({ typ: "session", st: sha(OTHER_RANDOM) }), RANDOM],
    ];
    for (const [title, made, state] of cases) {
      const w = world();
      const response = await req(w, "/data", fetchy(cookie(await made, state)));
      expect([response.status, await response.text(), w.sent.length], title).toEqual([401, "preview_access_required\n", 0]);
      expect(headersOf(response), title).toEqual({ ...PREVIEW_FIXED, "cache-control": "private, no-store, no-transform", "content-type": "text/plain; charset=utf-8" });
    }
    // A tampered token: one character of its payload or its signature changed.
    const good = await token({ typ: "session" });
    for (const at of [3, good.indexOf(".") + 5, good.length - 2]) {
      const bad = good.slice(0, at) + (good[at] === "A" ? "B" : "A") + good.slice(at + 1);
      const w = world();
      expect((await req(w, "/", fetchy(cookie(bad)))).status, String(at)).toBe(401);
      expect(w.sent).toEqual([]);
    }
  });

  it("answers an expired session preview_session_expired, and a fresh one passes within its hour", async () => {
    const w = world();
    const session = await token({ typ: "session", iat: NOW - 3_600_000, exp: NOW });
    const response = await req(w, "/data", fetchy(cookie(session)));
    expect([response.status, await response.text(), w.sent.length]).toEqual([401, "preview_session_expired\n", 0]);
    w.clock.now = NOW - 1;
    expect((await req(w, "/data", fetchy(cookie(session)))).status).toBe(200);
  });

  it("honours a later epoch than the entry's, and refuses every session once the entry's epoch is raised past it", async () => {
    const w = world();
    const session = await token({ typ: "session" });
    expect((await req(w, "/", fetchy(cookie(session)))).status).toBe(200);
    w.kv.set(HOST, `preview:${SLOT}:${EPOCH + 1}:code:${SCRIPT}`);
    expect((await req(w, "/", fetchy(cookie(session)))).status).toBe(401);
    w.kv.set(HOST, `preview:${SLOT}:${EPOCH - 1}:code:${SCRIPT}`);
    expect((await req(w, "/", fetchy(cookie(session)))).status).toBe(200);
  });

  it("serves a static preview through the preview namespace too, GET and HEAD only", async () => {
    const w = world();
    w.kv.set(HOST, `preview:${SLOT}:${EPOCH}:${SCRIPT}`);
    const session = cookie(await token({ typ: "session" }));
    const page = await req(w, "/", nav(session));
    expect(await served(w, page)).toEqual([200, `APP BODY ${SCRIPT}`, ["PREVIEW_APPS"]]);
    expect(headersOf(page)).toEqual({ ...PREVIEW_FIXED, "content-type": "text/html" });
    const write = await req(w, "/", { method: "POST", headers: { cookie: session, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}" });
    expect([write.status, write.headers.get("allow")]).toEqual([405, "GET, HEAD"]);
  });
});

describe("cookie tossing (spike P1, items 1 and 2)", () => {
  it("matches the two names exactly: case variants and every other name are ignored, never refused", async () => {
    const session = await token({ typ: "session" });
    const tossed = ["__HOST-podster_preview=x", "__host-podster_preview=x", "__HoSt-podster_preview=x", "__HOST-podster_preview_state=y", "__Host-podster_preview_State=y", "podster_preview=x", "__Secure-podster_preview=x", " =x", "lonely"];
    for (const extra of tossed) {
      const w = world();
      // Beside a valid pair, a case variant from a sibling (which WebKit stores for the whole domain) changes nothing.
      const both = await req(w, "/", fetchy(`${extra}; ${cookie(session)}`));
      expect(both.status, extra).toBe(200);
      // And on its own it is no session: the request goes round the flow as with no cookie at all.
      const alone = await req(w, "/", nav(extra));
      expect(alone.status, extra).toBe(303);
    }
  });

  it("refuses a second cookie of an exact name, whichever is valid, and a nameless cookie that reads as one beside the real one", async () => {
    const session = await token({ typ: "session" });
    const other = await token({ typ: "session", st: sha(OTHER_RANDOM) });
    const cases = [
      `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${other}; ${STATE_COOKIE}=${RANDOM}`,
      `${SESSION_COOKIE}=${other}; ${SESSION_COOKIE}=${session}; ${STATE_COOKIE}=${RANDOM}`,
      `${SESSION_COOKIE}=${session}; ${STATE_COOKIE}=${RANDOM}; ${STATE_COOKIE}=${OTHER_RANDOM}`,
      `${SESSION_COOKIE}=${session}; ${STATE_COOKIE}=${OTHER_RANDOM}; ${STATE_COOKIE}=${RANDOM}`,
      // A nameless cookie whose value is `__Host-podster_preview=…`, as a browser sends one: the same bytes as the real.
      `${SESSION_COOKIE}=${session}; ${STATE_COOKIE}=${RANDOM}; ${SESSION_COOKIE}=${other}`,
      `${SESSION_COOKIE}=${session}; ${STATE_COOKIE}=${RANDOM}; ${SESSION_COOKIE}=${session}`,
    ];
    for (const sent of cases) {
      const w = world();
      const response = await req(w, "/data", fetchy(sent));
      expect([response.status, await response.text(), w.sent.length], sent.slice(-40)).toEqual([401, "preview_access_required\n", 0]);
    }
    // A duplicate on a navigation goes round the flow with a new state, since neither can be picked.
    const w = world();
    const round = await req(w, "/", nav(cases[2]));
    expect([round.status, w.randoms]).toEqual([303, 1]);
  });

  it("makes a session copied into another browser, without its state cookie or with that browser's own, useless", async () => {
    const session = await token({ typ: "session" });
    for (const state of [null, OTHER_RANDOM]) {
      const w = world();
      expect((await req(w, "/", fetchy(cookie(session, state)))).status).toBe(401);
      const round = await req(w, "/", nav(cookie(session, state)));
      expect(round.status).toBe(303);
      expect(w.sent).toEqual([]);
    }
  });
});

describe("going round the flow, and the loop guard", () => {
  it("sends a navigation with no session to the application host, with a new state cookie, its hash and the path, and no token anywhere", async () => {
    const w = world();
    const response = await req(w, "/deep/page?q=1&r=2", nav());
    expect(response.status).toBe(303);
    const state = base64url(new Uint8Array(32).fill(1));
    const location = new URL(response.headers.get("location") ?? "");
    expect([location.origin, location.pathname, [...location.searchParams.keys()]]).toEqual([ACCESS, "/preview-access", ["host", "st", "r"]]);
    expect([location.searchParams.get("host"), location.searchParams.get("st"), location.searchParams.get("r")]).toEqual([HOST, sha(state), "/deep/page?q=1&r=2"]);
    expect(location.hash).toBe("");
    expect(setCookies(response)).toEqual([`${STATE_COOKIE}=${state}.1.${NOW}; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`]);
    expect(headersOf(response)).toEqual({ ...PREVIEW_FIXED, location: location.toString(), "content-type": "text/plain; charset=utf-8" });
    expect(w.sent).toEqual([]);
  });

  it("keeps a state cookie that is already there, so two tabs don't undo each other, and its hash stays the same", async () => {
    const w = world();
    const response = await req(w, "/", nav(cookie(null)));
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("st")).toBe(ST());
    expect(setCookies(response)).toEqual([`${STATE_COOKIE}=${RANDOM}.1.${NOW}; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`]);
    expect(w.randoms).toBe(0);
    // A state carrying a round record hashes the same: the hash is over the random part alone.
    const again = await req(w, "/", nav(cookie(null, `${RANDOM}.1.${NOW}`)));
    expect(new URL(again.headers.get("location") ?? "").searchParams.get("st")).toBe(ST());
  });

  it("stops after the second round within a minute with a fixed 401 page, and starts counting again a minute after the first", async () => {
    const w = world();
    const second = await req(w, "/", nav(cookie(null, `${RANDOM}.1.${NOW - 5000}`)));
    expect([second.status, setCookies(second)[0]]).toEqual([303, `${STATE_COOKIE}=${RANDOM}.2.${NOW - 5000}; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`]);
    const third = await req(w, "/", nav(cookie(null, `${RANDOM}.2.${NOW - 5000}`)));
    expect([third.status, await third.text(), setCookies(third), third.headers.get("location")]).toEqual([401, STOPPED_PAGE, [], null]);
    expect(headersOf(third)).toEqual({ ...PREVIEW_FIXED, "content-type": "text/html; charset=utf-8" });
    // A minute after the first round, the count starts again.
    const later = await req(w, "/", nav(cookie(null, `${RANDOM}.2.${NOW - 60_000}`)));
    expect([later.status, setCookies(later)[0]]).toEqual([303, `${STATE_COOKIE}=${RANDOM}.1.${NOW}; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`]);
    // A first round in the future, a clock stepped back, still counts as within the minute.
    expect((await req(w, "/", nav(cookie(null, `${RANDOM}.2.${NOW + 30_000}`)))).status).toBe(401);
    expect(w.sent).toEqual([]);
  });

  it("never redirects anything but a top-level navigation", async () => {
    for (const init of <RequestInit[]>[fetchy(), { headers: { "sec-fetch-mode": "no-cors" } }, { headers: { accept: "*/*" } }, { method: "HEAD", headers: { "sec-fetch-mode": "navigate" } }, { headers: { "sec-fetch-mode": "navigate-x", accept: "text/html" } }]) {
      const w = world();
      const response = await req(w, "/", init);
      expect([response.status, response.headers.get("location"), setCookies(response)], JSON.stringify(init)).toEqual([401, null, []]);
    }
    // With no Fetch Metadata, an Accept naming HTML is a navigation.
    expect((await req(world(), "/", { headers: { accept: "text/html,*/*" } })).status).toBe(303);
  });

  it("sends a path it can't return to as /", async () => {
    const w = world();
    const long = `/${"a".repeat(2048)}`;
    expect(new URL((await req(w, long, nav())).headers.get("location") ?? "").searchParams.get("r")).toBe("/");
  });
});

describe("the exchange: GET and POST /__podster/enter", () => {
  const exchangeInit = (body: unknown, cookies = cookie(null), extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "sec-fetch-site": "same-origin", origin: ORIGIN, "content-type": "application/json", cookie: cookies, ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("serves the fixed page with its own policy: one script by hash, its own origin to post to, no frame, COOP", async () => {
    const w = world();
    const response = await req(w, "/__podster/enter", nav());
    expect([response.status, await response.text(), setCookies(response)]).toEqual([200, ENTER_PAGE, []]);
    expect(headersOf(response)).toEqual({ ...PREVIEW_FIXED, "content-security-policy": ENTER_POLICY, "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
    expect(ENTER_POLICY).toBe(`default-src 'none'; script-src '${ENTER_SCRIPT_HASH}'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts allow-same-origin`);
    expect(ENTER_SCRIPT_HASH).toBe(`sha256-${createHash("sha256").update(ENTER_SCRIPT).digest("base64")}`);
    // The page holds its one script and nothing else that runs, and the script strips the fragment before anything.
    expect(ENTER_PAGE.split("<script").length - 1).toBe(1);
    expect(ENTER_PAGE).toContain(`<script>${ENTER_SCRIPT}</script>`);
    expect(ENTER_SCRIPT.indexOf("history.replaceState(null,\"\",location.pathname)")).toBeLessThan(ENTER_SCRIPT.indexOf("fetch("));
    expect(ENTER_SCRIPT).toContain('credentials:"same-origin"');
    expect(ENTER_SCRIPT).not.toMatch(/innerHTML|eval|document\.write|postMessage|opener|localStorage|cookie/);
    expect((await req(w, "/__podster/enter", { method: "HEAD" })).status).toBe(200);
    expect(w.sent).toEqual([]);
  });

  it("exchanges a ticket and its session for the session cookie, bound to this browser's state, and clears the round record", async () => {
    const w = world();
    const t = await token({ typ: "ticket" });
    const s = await token({ typ: "session" });
    const response = await req(w, "/__podster/enter", exchangeInit({ t, s, r: "/back?x=1" }, cookie(null, `${RANDOM}.2.${NOW}`)));
    expect([response.status, await response.json()]).toEqual([200, { r: "/back?x=1" }]);
    expect(setCookies(response)).toEqual([`${SESSION_COOKIE}=${s}; Max-Age=3599; Path=/; Secure; HttpOnly; SameSite=Lax`, `${STATE_COOKIE}=${RANDOM}; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`]);
    expect(headersOf(response)).toEqual({ ...PREVIEW_FIXED, "content-type": "application/json" });
    // The cookie it set then opens the app.
    expect((await req(w, "/back?x=1", nav(cookie(s))))).toHaveProperty("status", 200);
    // An r that isn't a path on this host comes back as /.
    for (const r of ["//evil.example/", "https://evil.example/", "/\\evil", "", "/a b"]) {
      const again = await req(world(), "/__podster/enter", exchangeInit({ t, s, r }));
      expect(await again.json(), r).toEqual({ r: "/" });
    }
    // The session's cookie lives no longer than the session: here, ten seconds.
    const short = await token({ typ: "session", iat: NOW - 3_590_000, exp: NOW + 10_000 });
    expect(setCookies(await req(world(), "/__podster/enter", exchangeInit({ t, s: short, r: "/" })))[0]).toContain("Max-Age=10;");
  });

  it("refuses an exchange that isn't same-origin, by Sec-Fetch-Site and Origin both, and sets nothing", async () => {
    const t = await token({ typ: "ticket" });
    const s = await token({ typ: "session" });
    for (const extra of [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }, { origin: "null" } as Record<string, string>, { origin: `https://${PROD_HOST}` }, { origin: `http://${HOST}` }]) {
      const w = world();
      const response = await req(w, "/__podster/enter", exchangeInit({ t, s, r: "/" }, cookie(null), extra));
      expect([response.status, await response.text(), setCookies(response)], JSON.stringify(extra)).toEqual([403, "preview_exchange_not_same_origin\n", []]);
    }
    const init = exchangeInit({ t, s, r: "/" });
    delete (init.headers as Record<string, string>)["sec-fetch-site"];
    expect((await req(world(), "/__podster/enter", init)).status).toBe(403);
  });

  it("refuses every ticket or session that doesn't pass, a login CSRF with an attacker's pair among them, and sets nothing", async () => {
    const t = () => token({ typ: "ticket" });
    const s = () => token({ typ: "session" });
    const cases: [string, () => Promise<unknown>, string, string][] = [
      ["no state cookie", async () => ({ t: await t(), s: await s(), r: "/" }), "", "preview_access_required"],
      // The attacker's own ticket and session, bound to the attacker's state, opened in the victim's browser.
      ["another browser's pair (login CSRF)", async () => ({ t: await t(), s: await s(), r: "/" }), cookie(null, OTHER_RANDOM), "preview_access_required"],
      ["an expired ticket", async () => ({ t: await token({ typ: "ticket", iat: NOW - 60_000, exp: NOW }), s: await s(), r: "/" }), cookie(null), "preview_session_expired"],
      ["a ticket for another host", async () => ({ t: await token({ typ: "ticket", aud: PROD_HOST }), s: await s(), r: "/" }), cookie(null), "preview_access_required"],
      ["a ticket of another slot", async () => ({ t: await token({ typ: "ticket", pvw: OTHER_SLOT }), s: await s(), r: "/" }), cookie(null), "preview_access_required"],
      ["a forged ticket", async () => ({ t: await token({ typ: "ticket" }, otherSigner), s: await s(), r: "/" }), cookie(null), "preview_access_required"],
      ["a session as the ticket", async () => ({ t: await s(), s: await s(), r: "/" }), cookie(null), "preview_access_required"],
      ["a ticket as the session", async () => ({ t: await t(), s: await t(), r: "/" }), cookie(null), "preview_access_required"],
      ["a forged session", async () => ({ t: await t(), s: await token({ typ: "session" }, otherSigner), r: "/" }), cookie(null), "preview_access_required"],
      ["a session of another session's ID", async () => ({ t: await t(), s: await token({ typ: "session", sid: "pvs_ffffffffffffffffffffffffffffffff" }), r: "/" }), cookie(null), "preview_access_required"],
      ["an epoch below the entry's", async () => ({ t: await token({ typ: "ticket", ep: 1 }), s: await token({ typ: "session", ep: 1 }), r: "/" }), cookie(null), "preview_access_required"],
      ["no session", async () => ({ t: await t(), r: "/" }), cookie(null), "preview_access_required"],
      ["a key more", async () => ({ t: await t(), s: await s(), r: "/", x: 1 }), cookie(null), "preview_access_required"],
      ["not JSON", async () => "t=1", cookie(null), "preview_access_required"],
      ["an r that isn't a string", async () => ({ t: await t(), s: await s(), r: 1 }), cookie(null), "preview_access_required"],
      ["a body too large", async () => ({ t: await t(), s: await s(), r: `/${"a".repeat(20_000)}` }), cookie(null), "preview_access_required"],
    ];
    for (const [title, body, cookies, code] of cases) {
      const w = world();
      const response = await req(w, "/__podster/enter", exchangeInit(await body(), cookies));
      expect([response.status, await response.text(), setCookies(response), w.sent.length], title).toEqual([401, `${code}\n`, [], 0]);
    }
    // And a body that isn't JSON by its type.
    const w = world();
    const typed = await req(w, "/__podster/enter", exchangeInit({ t: await t(), s: await s(), r: "/" }, cookie(null), { "content-type": "text/plain" }));
    expect(typed.status).toBe(401);
  });

  it("answers every other method on /__podster/enter 405, and nothing on a host whose previews are off", async () => {
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const w = world();
      const response = await req(w, "/__podster/enter", { method });
      expect([response.status, response.headers.get("allow"), w.sent.length], method).toEqual([405, "GET, HEAD, POST", 0]);
    }
  });
});

describe("/__podster/ is the content Worker's own, on every host, for every method (P15)", () => {
  it("never asks an app that answers every path, on a preview host or a production host, whatever the session", async () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"];
    const paths = ["/__podster/enter", "/__podster/x", "/__podster/", "/__podster", "/__PODSTER/enter", "/__Podster/x/y", "/__podster/enter/", "/__podster/enter?x=1"];
    const session = cookie(await token({ typ: "session" }));
    for (const previews of [true, false]) {
      for (const host of [HOST, PROD_HOST]) {
        for (const method of methods) {
          for (const path of paths) {
            const w = world(previews);
            const init: RequestInit = { method, headers: { cookie: session, "sec-fetch-site": "same-origin", origin: `https://${host}`, "content-type": "application/json", "sec-fetch-mode": "navigate" } };
            if (!["GET", "HEAD"].includes(method)) init.body = "{}";
            const response = await req(w, path, init, host);
            const text = await response.text();
            const title = `${previews} ${host} ${method} ${path}`;
            expect(w.sent, title).toEqual([]);
            expect(text, title).not.toContain("APP BODY");
            expect(w.logged, title).toEqual([]);
            // Only a preview host's exact exchange path is anything but this Worker's not-found.
            const exchangePath = previews && host === HOST && (path === "/__podster/enter" || path === "/__podster/enter?x=1");
            if (!exchangePath) expect(response.status, title).toBe(404);
            // A production host's answer under the prefix carries production's headers alone: no cookie, no preview header.
            if (host === PROD_HOST || !previews) {
              expect(setCookies(response), title).toEqual([]);
              for (const name of ["x-robots-tag", "origin-agent-cluster", "cross-origin-opener-policy"]) expect(response.headers.has(name), `${title} ${name}`).toBe(false);
            } else {
              expect(response.headers.get("cross-origin-opener-policy"), title).toBe("same-origin");
            }
          }
        }
      }
    }
  });
});

describe("headers, writes and service workers on a preview host", () => {
  it("forces COOP, noindex, no shared caching and Origin-Agent-Cluster on every answer, the app's and its own, and no Access-Control-Allow-Origin", async () => {
    const w = world();
    const session = cookie(await token({ typ: "session" }));
    const answers = [
      await req(w, "/", nav(session)),
      await req(w, "/data", fetchy(session)),
      await req(w, "/x", fetchy()),
      await req(w, "/", nav()),
      await req(w, "/robots.txt"),
      await req(w, "/", { method: "POST", headers: { "sec-fetch-site": "same-site", cookie: session, "content-type": "application/json" }, body: "{}" }),
      await req(w, "/__podster/enter"),
      await req(w, "/__podster/x"),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 401, 303, 200, 403, 200, 404]);
    for (const [at, answer] of answers.entries()) {
      for (const [name, value] of Object.entries(PREVIEW_FIXED)) {
        // The exchange page has its own policy (above); every other answer has the preview's.
        if (name === "content-security-policy" && at === 6) expect(answer.headers.get(name)).toBe(ENTER_POLICY);
        else expect(answer.headers.get(name), `${at} ${name}`).toBe(value);
      }
      expect(answer.headers.has("access-control-allow-origin")).toBe(false);
      expect(answer.headers.has("access-control-expose-headers")).toBe(false);
    }
  });

  it("answers robots.txt itself, before the gate, with Disallow: /", async () => {
    const w = world();
    const response = await req(w, "/robots.txt");
    expect([response.status, await response.text(), w.sent.length]).toEqual([200, PREVIEW_ROBOTS, 0]);
    expect(PREVIEW_ROBOTS).toBe("User-agent: *\nDisallow: /\n");
  });

  it("refuses a write unless Sec-Fetch-Site is same-origin, falling back to Origin only when that header is absent", async () => {
    const session = cookie(await token({ typ: "session" }));
    const write = (headers: Record<string, string>) => ({ method: "POST", headers: { cookie: session, "content-type": "application/json", ...headers }, body: "{}" });
    for (const headers of [{ "sec-fetch-site": "same-site" } as Record<string, string>, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }, { "sec-fetch-site": "same-site", origin: ORIGIN }, { origin: "null" }, { origin: `https://${PROD_HOST}` }, {}]) {
      const w = world();
      const response = await req(w, "/data", write(headers));
      expect([response.status, await response.text(), w.sent.length], JSON.stringify(headers)).toEqual([403, "preview_write_not_same_origin\n", 0]);
    }
    // Same-origin by the header, whatever Origin says (Firefox and WebKit send `null` under no-referrer).
    for (const headers of [{ "sec-fetch-site": "same-origin" } as Record<string, string>, { "sec-fetch-site": "same-origin", origin: "null" }, { origin: ORIGIN }]) {
      const w = world();
      const response = await req(w, "/data", write(headers));
      expect([response.status, w.sent.map((sent) => sent.request.method)], JSON.stringify(headers)).toEqual([200, ["POST"]]);
    }
    // A same-origin write still needs the session.
    const w = world();
    expect((await req(w, "/data", { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("refuses a service worker's script on a preview host, with a valid session and before anything is read", async () => {
    // Before the entry is read, so its answer is the refusal every host has always given, with production's own
    // headers: nothing of the host is known yet, and nothing of any app's is sent.
    const session = cookie(await token({ typ: "session" }));
    for (const path of ["/sw.js", "/__podster/enter", "/"]) {
      const w = world();
      const response = await req(w, path, { headers: { "service-worker": "script", cookie: session } });
      expect([response.status, await response.text(), w.sent.length], path).toEqual([403, "no_service_workers\n", 0]);
    }
  });

  it("accepts a marker token for the marker's path with GET, and for nothing else", async () => {
    const marker = await token({ typ: "marker" });
    const w = world();
    const ok = await req(w, "/.well-known/podster-release.json", { headers: { [MARKER_HEADER]: marker } });
    expect([ok.status, w.sent.map((sent) => sent.via)]).toEqual([200, ["PREVIEW_APPS"]]);
    for (const [path, init] of [["/", {}], ["/.well-known/podster-release.json", { method: "HEAD" }], ["/.well-known/podster-release.jsonx", {}]] as const) {
      const v = world();
      const refused = await req(v, path, { ...init, headers: { [MARKER_HEADER]: marker } });
      expect([refused.status, v.sent.length], path).toEqual([401, 0]);
    }
    // A session as the marker token, or a marker for another host, is refused; and a marker token never sets a cookie.
    for (const bad of [await token({ typ: "session" }), await token({ typ: "marker", aud: PROD_HOST }), await token({ typ: "marker", exp: NOW, iat: NOW - 60_000 })]) {
      const v = world();
      const refused = await req(v, "/.well-known/podster-release.json", { headers: { [MARKER_HEADER]: bad, "sec-fetch-mode": "navigate" } });
      expect([refused.status, setCookies(refused), v.sent.length]).toEqual([401, [], 0]);
    }
  });

  it("logs nothing for any gate decision or exchange, and never a token, a state or a cookie", async () => {
    const w = world();
    const t = await token({ typ: "ticket" });
    const s = await token({ typ: "session" });
    await req(w, "/", nav());
    await req(w, "/", fetchy(cookie(s, OTHER_RANDOM)));
    await req(w, "/__podster/enter", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: ORIGIN, "content-type": "application/json", cookie: cookie(null) }, body: JSON.stringify({ t, s, r: "/" }) });
    await req(w, "/", nav(cookie(s)));
    expect(w.logged).toEqual([]);
    // A preview's failed dispatch logs its one line, the release's ID, and nothing of the request.
    w.deps.previews = { ...(w.deps.previews as NonNullable<Deps["previews"]>), apps: { get: () => ({ fetch: async () => { throw new Error(`boom ${s}`); } }) } };
    await req(w, "/", nav(cookie(s)));
    expect(w.logged).toEqual([{ event: "dispatch_error", release: "rel_0123456789abcdef0123456789abcdef" }]);
    expect(JSON.stringify(w.logged)).not.toContain(s.slice(0, 20));
  });
});

describe("previews off, and production unchanged", () => {
  it("serves nothing on a preview host while previews aren't configured, exactly as a host with no entry", async () => {
    const w = world(false);
    const session = cookie(await token({ typ: "session" }));
    const unknown = world(false);
    unknown.kv.delete(HOST);
    for (const [path, init] of [["/", nav(session)], ["/robots.txt", {}], ["/x", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: "{}" }]] as const) {
      const a = await req(w, path, init);
      const b = await req(unknown, path, init);
      expect([a.status, headersOf(a), await a.text(), setCookies(a)], path).toEqual([b.status, headersOf(b), await b.text(), []]);
    }
    expect(w.sent).toEqual([]);
  });

  it("answers a production host exactly the same with previews configured as without, and reads or sets no cookie there", async () => {
    const session = cookie(await token({ typ: "session", aud: PROD_HOST }));
    const requests: [string, RequestInit][] = [
      ["/", {}],
      ["/", nav(session)],
      ["/data", fetchy(session)],
      ["/x", { method: "POST", headers: { "content-type": "application/json", cookie: session }, body: "{}" }],
      ["/x", { method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }],
      ["/robots.txt", {}],
      ["/sw.js", { headers: { "service-worker": "script" } }],
      ["/.well-known/acme-challenge/x", {}],
    ];
    for (const [path, init] of requests) {
      const on = world(true);
      const off = world(false);
      const a = await req(on, path, init, PROD_HOST);
      const b = await req(off, path, init, PROD_HOST);
      expect([a.status, headersOf(a), await a.text(), setCookies(a)], `${init.method ?? "GET"} ${path}`).toEqual([b.status, headersOf(b), await b.text(), []]);
      expect(on.sent.map((sent) => [sent.via, sent.request.headers.has("cookie")])).toEqual(off.sent.map((sent) => [sent.via, false]));
      for (const sent of on.sent) expect(sent.via).toBe("APPS");
      for (const name of ["x-robots-tag", "origin-agent-cluster", "cross-origin-opener-policy"]) expect(a.headers.has(name), name).toBe(false);
      expect(a.headers.get("content-security-policy") ?? "").not.toContain(PREVIEW_SANDBOX);
    }
  });

  it("never serves a preview entry through production's namespace, nor a production entry through the preview's", async () => {
    // A production entry on the preview label's host: production's namespace, production's headers, no gate.
    const w = world();
    w.kv.set(HOST, `code:${SCRIPT}`);
    const prod = await req(w, "/", {});
    expect([prod.status, w.sent.map((sent) => sent.via), prod.headers.has("x-robots-tag")]).toEqual([200, ["APPS"], false]);
    // A preview entry naming another label's script, or of no form: not-found, nothing asked.
    for (const value of [`preview:${SLOT}:${EPOCH}:code:${PROD_SCRIPT}`, `preview:${SLOT}:${EPOCH}:`, `preview:${SLOT}:01:code:${SCRIPT}`, `preview:pvw_x:${EPOCH}:code:${SCRIPT}`, `preview:preview:${SLOT}:${EPOCH}:code:${SCRIPT}`]) {
      const v = world();
      v.kv.set(HOST, value);
      const response = await req(v, "/", nav(cookie(await token({ typ: "session" }))));
      expect([response.status, v.sent.length], value).toEqual([404, 0]);
    }
    // A custom hostname's entry in the preview form isn't routed yet (step 10): not-found, as before.
    const c = world();
    c.kv.set("app.customer.example", `preview:${SLOT}:${EPOCH}:code:${SCRIPT}@app.customer.example`);
    const custom = await req(c, "/", nav(), "app.customer.example");
    expect([custom.status, c.sent.length, custom.headers.has("x-robots-tag")]).toEqual([404, 0, false]);
  });
});
