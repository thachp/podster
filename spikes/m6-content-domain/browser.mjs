#!/usr/bin/env node
// Spike only. The content domain's browser facts, in a real browser: cookies across opster.dev hosts and podster.dev,
// what the hardened headers close, service workers and Clear-Site-Data. Visits only opster.dev hosts; podster.dev
// appears only as a cookie seeded into the browser's own jar, which is never sent anywhere.
// The browser gets the allow-listed environment from e2e/child-env.mjs. Values here are throwaway test values.
//   node browser.mjs [--browser=chromium|firefox|webkit]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../../e2e/child-env.mjs";
import * as playwright from "../../e2e/node_modules/playwright/index.mjs";

const browserName = process.argv.find((a) => a.startsWith("--browser="))?.slice(10) ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName)) throw new Error(`unknown browser ${browserName}`);
const Z = "opster.dev";
const url = (host, path = "/") => `https://${host}.${Z}${path}`;
const results = [];
const note = (name, value) => { results.push({ name, ...value }); console.log(JSON.stringify({ name, ...value })); };

// Runs in the page. Each returns { ok, value } or { ok: false, error: <the error's name> }.
const inPage = {
  cookies: () => wrap(() => document.cookie),
  setCookie: (text) => wrap(() => { document.cookie = text; return document.cookie; }),
  setLocal: () => wrap(() => { localStorage.setItem("spike", "1"); return Object.keys(localStorage); }),
  localKeys: () => wrap(() => Object.keys(localStorage)),
  cachePut: () => wrap(async () => { const c = await caches.open("spike"); await c.put("/cached-marker", new Response("x")); return await caches.keys(); }),
  cacheNames: () => wrap(async () => await caches.keys()),
  registerSW: () => wrap(async () => { const r = await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; return r.scope; }),
  swCount: () => wrap(async () => (await navigator.serviceWorker.getRegistrations()).length),
  marker: () => wrap(async () => (await fetch("/__sw-marker")).status + ":" + (await (await fetch("/__sw-marker")).text()).slice(0, 12)),
  echo: () => wrap(async () => (await (await fetch("/__echo-cookie", { credentials: "include" })).json()).names),
  origin: () => wrap(() => self.origin),
};
const WRAP = "const wrap = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: (e && e.name) || String(e) }; } };";
const run = (page, name, arg) => page.evaluate(`(async () => { ${WRAP} return (${inPage[name].toString()})(${arg === undefined ? "" : JSON.stringify(arg)}); })()`);

async function open(context, host, path = "/") {
  const page = await context.newPage();
  const res = await page.goto(url(host, path), { waitUntil: "load" });
  return { page, status: res?.status() ?? null };
}

const browser = await playwright[browserName].launch({ env: childEnv() });
const fresh = () => browser.newContext({ ignoreHTTPSErrors: false });

try {
  // 1. podster.dev's cookies: seeded into this browser's jar, never readable or settable from an opster.dev page.
  {
    const ctx = await fresh();
    await ctx.addCookies([{ name: "spike_pd", value: "1", domain: ".podster.dev", path: "/", secure: true, sameSite: "Lax" }]);
    const { page, status } = await open(ctx, "a");
    note("podster.dev cookie visible on a.opster.dev", { status, cookies: await run(page, "cookies"), echo: await run(page, "echo") });
    note("set a podster.dev cookie from a.opster.dev", { result: await run(page, "setCookie", "spike_pd_try=1; domain=podster.dev; path=/; secure") });
    note("podster.dev cookies in the jar afterwards", { names: (await ctx.cookies("https://app-staging.podster.dev/")).map((c) => c.name).sort() });
    await ctx.close();
  }

  // 2. Sibling hosts with the app's own headers: a parent-domain cookie from one is read and overwritten by another.
  {
    const ctx = await fresh();
    const a = await open(ctx, "a");
    note("raw a sets a cookie on opster.dev", { result: await run(a.page, "setCookie", "spike_sib=from-a; domain=opster.dev; path=/; secure") });
    const b = await open(ctx, "b");
    note("raw b reads it", { cookies: await run(b.page, "cookies"), sentToServer: await run(b.page, "echo") });
    note("raw b overwrites it", { result: await run(b.page, "setCookie", "spike_sib=from-b; domain=opster.dev; path=/; secure") });
    await a.page.reload();
    note("raw a now reads", { cookies: await run(a.page, "cookies") });
    note("raw a's localStorage", { set: await run(a.page, "setLocal") });
    note("raw b's localStorage", { keys: await run(b.page, "localKeys") });
    const h = await open(ctx, "h-b");
    note("hardened h-b: origin, cookie read, cookie sent", { status: h.status, origin: await run(h.page, "origin"), cookies: await run(h.page, "cookies"), sentToServer: await run(h.page, "echo") });
    await ctx.close();
  }

  // 3. With the hardened headers on every host: no script can set a parent-domain cookie, and Set-Cookie is stripped.
  {
    const ctx = await fresh();
    const h = await open(ctx, "h-a");
    note("hardened h-a sets a cookie on opster.dev", { status: h.status, result: await run(h.page, "setCookie", "spike_hard=1; domain=opster.dev; path=/; secure") });
    note("hardened h-a localStorage", { result: await run(h.page, "setLocal") });
    note("hardened h-a caches", { result: await run(h.page, "cachePut") });
    note("hardened h-a registers a service worker", { result: await run(h.page, "registerSW") });
    await h.page.goto(url("h-a", "/hdr.html"));
    note("cookies after hardened h-a/hdr.html (its _headers asks for Set-Cookie)", { names: (await ctx.cookies(url("b"))).map((c) => c.name).sort() });
    await h.page.goto(url("a", "/hdr.html"));
    note("cookies after raw a/hdr.html", { names: (await ctx.cookies(url("b"))).map((c) => c.name).sort() });
    await ctx.close();
  }

  // 4. Service workers: registered on a raw host; refused where the dispatch Worker refuses their script.
  {
    const ctx = await fresh();
    const a = await open(ctx, "a");
    note("raw a registers a service worker", { result: await run(a.page, "registerSW") });
    await a.page.reload();
    note("raw a is controlled by it", { marker: await run(a.page, "marker") });
    const w = await open(ctx, "w-a");
    note("w-a registers a service worker", { result: await run(w.page, "registerSW"), count: await run(w.page, "swCount") });
    await ctx.close();
  }

  // 5. Clear-Site-Data on the not-found answer: what it clears on its own host, and on a sibling's.
  for (const host of ["a", "w-a"]) {
    const ctx = await fresh();
    const p = await open(ctx, host);
    await run(p.page, "setCookie", "spike_own=1; path=/; secure");
    await run(p.page, "setCookie", "spike_parent=1; domain=opster.dev; path=/; secure");
    await run(p.page, "setLocal");
    await run(p.page, "cachePut");
    const sw = host === "a" ? await run(p.page, "registerSW") : null;
    if (sw) await p.page.reload();
    const b = await open(ctx, "b");
    await run(b.page, "setCookie", "spike_sibling_own=1; path=/; secure");
    const before = { cookies: await run(p.page, "cookies"), local: await run(p.page, "localKeys"), caches: await run(p.page, "cacheNames"), sw: host === "a" ? await run(p.page, "swCount") : null, marker: host === "a" ? await run(p.page, "marker") : null, siblingCookies: await run(b.page, "cookies") };
    const gone = await p.page.goto(url(host, "/__gone"));
    const goneStatus = gone?.status() ?? null;
    await p.page.goto(url(host));
    await b.page.reload();
    const after = { cookies: await run(p.page, "cookies"), local: await run(p.page, "localKeys"), caches: await run(p.page, "cacheNames"), sw: host === "a" ? await run(p.page, "swCount") : null, marker: host === "a" ? await run(p.page, "marker") : null, siblingCookies: await run(b.page, "cookies") };
    note(`Clear-Site-Data on ${host}/__gone`, { serviceWorker: sw, goneStatus, before, after });
    await ctx.close();
  }

  // 6. An ordinary static app, with and without the sandboxing CSP.
  for (const host of ["plain", "h-plain"]) {
    const ctx = await fresh();
    const errors = [];
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    const res = await page.goto(url(host), { waitUntil: "load" });
    await page.waitForFunction("document.getElementById('status')?.textContent === 'done'", null, { timeout: 5000 }).catch(() => {});
    note(`plain app on ${host}`, { status: res?.status() ?? null, result: await page.evaluate("window.plainResult ?? null"), consoleErrors: errors.length, firstErrors: errors.slice(0, 3) });
    await ctx.close();
  }
} finally {
  await browser.close();
}

mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
writeFileSync(join(import.meta.dirname, "results", `browser-${browserName}.json`), JSON.stringify({ at: new Date().toISOString(), browser: browserName, results }, null, 2) + "\n");
