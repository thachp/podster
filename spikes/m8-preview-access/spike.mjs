#!/usr/bin/env node
// Spike P1 of the M8 preview plan (docs/m8-preview-plan.md, section 12, step 2): the browser facts the preview gate
// rests on, in Chromium, Firefox and WebKit, against the local stack in server.mjs. Local only: nothing deployed, no
// DNS, no Cloudflare, no `--remote`. Every cookie value is a throwaway made for the run.
//
//   node spike.mjs [--browser=chromium|firefox|webkit] [--out=results/<browser>.json]
//
// The browser gets the allow-listed environment from e2e/child-env.mjs, with an empty temporary HOME. It downloads no
// browser: one Playwright can't launch is recorded as not shown.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../e2e/child-env.mjs";
import * as playwright from "../../e2e/node_modules/playwright/index.mjs";
import { SESSION, STATE, TICKET_SECONDS, gateCookies, newState, sign, stateHash } from "./pure.mjs";
import { A, APP, B, G, X, startStack } from "./server.mjs";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserName = arg("browser") ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName)) throw new Error(`unknown browser ${browserName}`);
const out = arg("out") ?? join(import.meta.dirname, "results", `${browserName}.json`);

const stack = await startStack();
const home = mkdtempSync(join(tmpdir(), "spike-p1-home-"));
const cleanup = () => { stack.close(); rmSync(home, { recursive: true, force: true }); };
process.on("exit", cleanup);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => { cleanup(); process.exit(code); });

const results = { browser: browserName, ran: new Date().toISOString(), facts: {} };
const note = (name, value) => { results.facts[name] = value; console.log(JSON.stringify({ name, value })); };

let browser;
try {
  browser = await playwright[browserName].launch({ headless: true, proxy: { server: stack.proxy }, env: childEnv({ HOME: home }) });
} catch (error) {
  results.notShown = `could not launch: ${String(error?.message ?? error).split("\n")[0]}`;
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(results.notShown);
  process.exit(0);
}
results.version = browser.version();

const fresh = async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  return { context, page: await context.newPage() };
};
const url = (host, path) => `https://${host}${path}`;
/** Sets cookies with `Set-Cookie` from `host`'s own answer to a top-level navigation. */
const setByHeader = async (page, host, cookies) => {
  const q = new URLSearchParams();
  for (const c of cookies) q.append("c", c);
  await page.goto(url(host, `/set?${q}`));
};
/** The raw `Cookie` header `host` receives on a top-level navigation, as the server read it. */
const cookieAt = async (page, host) => (await (await page.goto(url(host, "/echo"))).json()).cookie;
/** Sets cookies with `document.cookie` from the page's own script. Returns what each set raised, if anything. */
const setByScript = (page, cookies) => page.evaluate((list) => list.map((c) => { try { document.cookie = c; return "ok"; } catch (e) { return e.name; } }), cookies);
const since = (mark, pred) => stack.log.slice(mark).filter(pred);
const names = (cookie) => (cookie ?? "").split(";").map((c) => c.trim()).filter(Boolean).map((c) => (c.includes("=") ? c.slice(0, c.indexOf("=")) : `(nameless)${c}`));
const waitFor = async (pred, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
/**
 * Waits until the browser's jar stops changing. A page's `document.cookie` writes reach the jar asynchronously in some
 * engines, so a request sent straight after a burst of them can race them. The jar is read with the browser's own
 * storage call, which doesn't touch the cookies' last-access times.
 */
const settle = async (context) => {
  let last = -1;
  let same = 0;
  const end = Date.now() + 8000;
  while (Date.now() < end && same < 3) {
    const n = (await context.cookies()).length;
    same = n === last ? same + 1 : 0;
    last = n;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
};
const step = async (name, fn) => {
  try { await fn(); } catch (error) { note(name, { error: String(error?.message ?? error).split("\n")[0] }); }
};

const LAX = `${SESSION}=genuine; Secure; HttpOnly; Path=/; SameSite=Lax`;
const STATE_GENUINE = `${STATE}=genuinestate; Secure; HttpOnly; Path=/; SameSite=Lax`;

// ---- 1. cookies on a page's own requests, under the strict sandbox and with allow-same-origin ----
await step("sandbox", async () => {
  const { context, page } = await fresh();
  await setByHeader(page, A, [
    LAX,
    "__Host-p1_none=none; Secure; HttpOnly; Path=/; SameSite=None",
    "__Host-p1_strict=strict; Secure; HttpOnly; Path=/; SameSite=Strict",
  ]);
  const byMode = {};
  for (const mode of ["strict", "same"]) {
    const mark = stack.log.length;
    await page.goto(url(A, `/page?mode=${mode}&load=1`));
    const subs = ["/sub/module.js", "/sub/classic.js", "/sub/img.png", "/sub/fetch-default", "/sub/fetch-include", "/sub/fetch-from-module"];
    await waitFor(() => subs.every((s) => since(mark, (e) => e.path === s).length > 0));
    const page_ = await page.evaluate(() => {
      let cookie;
      try { cookie = typeof document.cookie; } catch (e) { cookie = e.name; }
      return { origin: self.origin, documentCookie: cookie };
    });
    const row = { page: page_ };
    for (const e of since(mark, (e) => e.host === A)) row[e.path === "/page" ? "document" : e.path] = { cookies: names(e.cookie), sfs: e.sfs, sfm: e.sfm };
    for (const s of subs) if (!row[s]) row[s] = "not requested";
    byMode[mode] = row;
  }
  note("sandbox", byMode);
  await context.close();
});

// ---- 2 to 4. a sibling tossing cookies onto the domain: __Host-, case variants, nameless ----
const TOSSES = {
  hostPrefixDomain: `${SESSION}=tossed; Secure; Path=/; Domain=pv.test`,
  upperHOST: "__HOST-podster_preview=tossed; Secure; Path=/; Domain=pv.test",
  lowerhost: "__host-podster_preview=tossed; Secure; Path=/; Domain=pv.test",
  mixedHoSt: "__HoSt-podster_preview=tossed; Secure; Path=/; Domain=pv.test",
  namelessSecure: "=__Host-podster_preview=tossed; Secure; Path=/; Domain=pv.test",
  namelessPlain: "=__Host-podster_preview=tossed; Path=/; Domain=pv.test",
  namelessNoEquals: "__Host-podster_preview; Secure; Path=/; Domain=pv.test",
  namelessStatePair: `=${STATE}=tossedstate; Secure; Path=/; Domain=pv.test`,
  controlPlainDomain: "podster_preview=tossed; Secure; Path=/; Domain=pv.test",
};
await step("tossing", async () => {
  const rows = {};
  for (const [label, cookie] of Object.entries(TOSSES)) {
    for (const via of ["header", "script"]) {
      for (const genuine of [false, true]) {
        const { context, page } = await fresh();
        if (genuine) await setByHeader(page, A, [LAX, STATE_GENUINE]);
        let raised = null;
        if (via === "header") await setByHeader(page, B, [cookie]);
        else { await page.goto(url(B, "/page?mode=same")); [raised] = await setByScript(page, [cookie]); }
        const atA = await cookieAt(page, A);
        const jar = await context.cookies(`https://${A}/`);
        rows[`${label}/${via}/${genuine ? "withGenuine" : "fresh"}`] = {
          raised,
          cookieHeaderAtA: atA,
          tossedReachedA: (atA ?? "").includes("tossed"),
          gate: gateCookies(atA),
          jarNames: jar.map((c) => `${c.name}@${c.domain}`),
        };
        await context.close();
      }
    }
  }
  note("tossing", rows);
});

// ---- 5. jar eviction: a sibling filling the domain's jar, and a preview planting its own session pair ----
const FILL = [50, 100, 140, 150, 160, 170, 179, 180, 181, 200, 300, 600, 1000];
await step("eviction", async () => {
  const sibling = {};
  const own = {};
  for (const n of FILL) {
    {
      const { context, page } = await fresh();
      await setByHeader(page, A, [LAX, STATE_GENUINE]);
      await page.goto(url(B, "/page?mode=same"));
      await page.evaluate((count) => { for (let i = 0; i < count; i++) document.cookie = `f${i}=x; Secure; Path=/; Domain=pv.test`; }, n);
      const jar = await settle(context);
      const atA = await cookieAt(page, A);
      const ns = names(atA);
      sibling[n] = { session: ns.includes(SESSION), state: ns.includes(STATE), cookiesSentToA: ns.length, jar };
      await context.close();
    }
    {
      const { context, page } = await fresh();
      await setByHeader(page, A, [LAX, STATE_GENUINE]);
      await page.goto(url(A, "/page?mode=same"));
      const before = await page.evaluate((s) => { document.cookie = `${s}=planted; Secure; Path=/`; return document.cookie.includes("planted"); }, SESSION);
      await page.evaluate((count) => { for (let i = 0; i < count; i++) document.cookie = `f${i}=x; Secure; Path=/`; }, n);
      const jar = await settle(context);
      await page.evaluate(([s, t]) => { document.cookie = `${s}=planted; Secure; Path=/`; document.cookie = `${t}=plantedstate; Secure; Path=/`; }, [SESSION, STATE]);
      await settle(context);
      const atA = await cookieAt(page, A);
      const pairs = (atA ?? "").split(";").map((c) => c.trim());
      own[n] = {
        overwriteBeforeFillTookEffect: before,
        genuineSession: pairs.includes(`${SESSION}=genuine`),
        genuineState: pairs.includes(`${STATE}=genuinestate`),
        plantedSession: pairs.includes(`${SESSION}=planted`),
        plantedState: pairs.includes(`${STATE}=plantedstate`),
        cookiesSentToA: pairs.filter(Boolean).length,
        jarAfterFill: jar,
      };
      await context.close();
    }
  }
  // Secure cookies first? A sibling filling with non-Secure cookies, at a count that evicted with Secure ones.
  const plain = {};
  for (const n of [300, 1000]) {
    const { context, page } = await fresh();
    await setByHeader(page, A, [LAX, STATE_GENUINE]);
    await page.goto(url(B, "/page?mode=same"));
    await page.evaluate((count) => { for (let i = 0; i < count; i++) document.cookie = `f${i}=x; Path=/; Domain=pv.test`; }, n);
    await settle(context);
    const ns = names(await cookieAt(page, A));
    plain[n] = { session: ns.includes(SESSION), state: ns.includes(STATE), cookiesSentToA: ns.length };
    await context.close();
  }
  note("eviction", { siblingSecureFill: sibling, ownHostFillThenPlant: own, siblingNonSecureFill: plain });
});

// ---- 6. the whole flow (5.3): SameSite on the redirect chain, the fragment, replaceState, the exchange ----
const TICKET_MARK = Buffer.from('{"typ":"ticket"').toString("base64url").slice(0, 16);
await step("flow", async () => {
  const rows = {};
  for (const start of ["direct", "fromSibling", "fromOtherSite"]) {
    const { context, page } = await fresh();
    await page.goto(url(APP, "/login"));
    const mark = stack.log.length;
    const target = url(G, "/x?y=1");
    if (start === "direct") await page.goto(target);
    else {
      await page.goto(url(start === "fromSibling" ? B : X, `/start?to=${encodeURIComponent(target)}`));
      await page.click("#go");
    }
    let landed = true;
    try { await page.waitForSelector("#app", { timeout: 10000 }); } catch { landed = false; }
    const finalUrl = page.url();
    const bodyText = landed ? null : await page.evaluate(() => document.body?.textContent ?? null).catch(() => null);
    const chain = since(mark, (e) => [G, APP].includes(e.host)).map((e) => ({ host: e.host, method: e.method, path: e.path, cookies: names(e.cookie), sfs: e.sfs, sfm: e.sfm, sfd: e.sfd, origin: e.origin }));
    const leaked = since(mark, (e) => [e.path, e.query, e.referer ?? ""].some((v) => v.includes(TICKET_MARK)));
    const historyLength = await page.evaluate(() => history.length);
    await page.goBack();
    const backUrl = page.url();
    // A second request in the same browser goes straight through.
    const again = await page.goto(url(G, "/second"));
    rows[start] = { landed, finalUrl, bodyText, chain, ticketSeenByServer: leaked.length, historyLength, backUrl, secondStatus: again.status() };
    // Replay: the session cookie copied into another browser, without its state cookie.
    const copied = (await context.cookies(`https://${G}/`)).filter((c) => c.name === SESSION);
    const thief = await fresh();
    await thief.context.addCookies(copied);
    const tm = stack.log.length;
    await thief.page.goto(url(G, "/x"));
    const first = since(tm, (e) => e.host === G)[0];
    rows[start].replayWithoutState = { gateAnswer: thief.page.url().startsWith(`https://${APP}/`) ? "sent to the application host" : thief.page.url(), carried: names(first?.cookie) };
    await thief.context.close();
    await context.close();
  }
  // Login CSRF: an attacker's ticket, bound to the attacker's state, opened in a victim's browser.
  {
    const now = Math.floor(Date.now() / 1000);
    const attackerTicket = sign(stack.key, { typ: "ticket", aud: G, st: stateHash(newState()), sid: "attacker", iat: now, exp: now + TICKET_SECONDS });
    const victim = await fresh();
    await victim.page.goto(url(G, "/")).catch(() => {}); // gets the victim a state cookie, then stops at the signed-out app host
    await victim.page.goto(url(G, `/__podster/enter#${new URLSearchParams({ t: attackerTicket, r: "/" })}`));
    await waitFor(() => false, 1500);
    rows.loginCsrf = { body: await victim.page.evaluate(() => document.body.textContent), url: victim.page.url() };
    await victim.context.close();
  }
  note("flow", rows);
});

// ---- 7. writes from a sibling: Sec-Fetch-Site, and whether SameSite stops the cookie ----
await step("writes", async () => {
  const { context, page } = await fresh();
  await setByHeader(page, A, [LAX]);
  const rows = {};
  const attempt = async (label, host, mode, how) => {
    await page.goto(url(host, `/page?mode=${mode}`));
    const mark = stack.log.length;
    const said = await page.evaluate(async ([target, kind]) => {
      try {
        if (kind === "fetch") { await fetch(target, { method: "POST", mode: "no-cors", credentials: "include", body: "x" }); return "sent"; }
        const f = document.createElement("form"); f.method = "POST"; f.action = target; document.body.append(f); f.submit(); return "submitted";
      } catch (e) { return e.name; }
    }, [how === "same" ? "/w" : url(A, "/w"), how === "form" ? "form" : "fetch"]);
    await waitFor(() => since(mark, (e) => e.path === "/w").length > 0, 2000);
    const hit = since(mark, (e) => e.path === "/w")[0];
    rows[label] = hit ? { said, sfs: hit.sfs, origin: hit.origin, laxCookieSent: names(hit.cookie).includes(SESSION) } : { said, reached: false };
  };
  await attempt("siblingNoCspFetch", B, "none", "fetch");
  await attempt("siblingNoCspForm", B, "none", "form");
  await attempt("siblingPreviewCspFetch", B, "same", "fetch");
  await attempt("siblingPreviewCspForm", B, "same", "form");
  await attempt("otherSiteFetch", X, "none", "fetch");
  await attempt("otherSiteForm", X, "none", "form");
  await attempt("ownPageFetch", A, "same", "same");
  note("writes", rows);
  await context.close();
});

// ---- 8. Origin-Agent-Cluster ----
await step("originAgentCluster", async () => {
  const rows = {};
  for (const h of ["0", "1"]) {
    const { context, page } = await fresh();
    await page.goto(url(A, `/oac?h=${h}`));
    const frame = await (await page.waitForSelector("#f")).contentFrame();
    await frame.waitForLoadState("load");
    const inFrame = await frame.evaluate(() => { let set; try { document.domain = "pv.test"; set = "ok"; } catch (e) { set = e.name; } return { set, domain: document.domain, oac: self.originAgentCluster }; });
    const inParent = await page.evaluate(() => {
      let set; try { document.domain = "pv.test"; set = "ok"; } catch (e) { set = e.name; }
      let reach; try { reach = document.getElementById("f").contentWindow.document.title; } catch (e) { reach = e.name; }
      return { set, domain: document.domain, oac: self.originAgentCluster, readSiblingFrameTitle: reach };
    });
    rows[h === "1" ? "withHeader" : "withoutHeader"] = { parent: inParent, frame: inFrame };
    await context.close();
  }
  {
    const { context, page } = await fresh();
    await page.goto(url(A, "/page?mode=same&oac=1"));
    rows.previewCspPage = await page.evaluate(() => { let set; try { document.domain = "pv.test"; set = "ok"; } catch (e) { set = e.name; } return { set, domain: document.domain, oac: self.originAgentCluster }; });
    await context.close();
  }
  note("originAgentCluster", rows);
});

// ---- 9. Cross-Origin-Opener-Policy on the exchange page ----
await step("coop", async () => {
  const rows = {};
  for (const [label, target] of [["enterPage", url(G, "/__podster/enter")], ["controlNoCoop", url(A, "/page?mode=none")]]) {
    const { context, page } = await fresh();
    await page.goto(url(B, "/page?mode=none"));
    const popup = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.evaluate((t) => { window.__w = window.open(t); }, target);
    const p = await popup;
    if (p) await p.waitForLoadState("load").catch(() => {});
    await waitFor(() => false, 500);
    rows[label] = await page.evaluate(() => ({ opened: !!window.__w, closedAsSeenByOpener: window.__w ? window.__w.closed : null }));
    await context.close();
  }
  note("coop", rows);
});

await browser.close();
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${out}`);
process.exit(0);
