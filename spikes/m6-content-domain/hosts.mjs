#!/usr/bin/env node
// Spike only. What curl-level requests show about the content domain: certificates on arbitrary hosts, the wildcard
// route, a missing app, Set-Cookie and the hardened headers. Calls only opster.dev hosts; prints statuses and header names.
import { randomBytes } from "node:crypto";
import { connect } from "node:tls";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ZONE = "opster.dev";
const results = [];
const note = (name, value) => { results.push({ name, ...value }); console.log(JSON.stringify({ name, ...value })); };

function certOf(host) {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ authorized: s.authorized, error: s.authorizationError ?? null, issuer: c?.issuer?.O ?? null, subjectAltNames: c?.subjectaltname ?? null, validTo: c?.valid_to ?? null });
      s.end();
    });
    s.on("error", (e) => resolve({ authorized: false, error: e.code ?? e.message }));
    s.on("timeout", () => { s.destroy(); resolve({ authorized: false, error: "timeout" }); });
  });
}

async function get(url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", ...init });
    const body = await res.text();
    const headers = Object.fromEntries([...res.headers].filter(([k]) => /^(content-security-policy|set-cookie|clear-site-data|cache-control|x-spike-|x-content-type-options|referrer-policy|location|content-type|server|cf-ray)$/.test(k) || k.startsWith("x-spike")).map(([k, v]) => [k, k === "set-cookie" ? v.split(";")[0].split("=")[0] + "=<value>" : k === "cf-ray" ? "<id>" : v]));
    return { status: res.status, ms: Date.now() - t0, headers, bodyStart: body.slice(0, 120) };
  } catch (e) {
    return { error: e.cause?.code ?? e.message, ms: Date.now() - t0 };
  }
}

const random = () => randomBytes(6).toString("hex");

// 1. One certificate for arbitrary first-level hosts, and none for a second level.
for (const host of [`${random()}.${ZONE}`, `a.${ZONE}`, `h-a.${ZONE}`, `x.${random()}.${ZONE}`]) note("certificate", { host, ...(await certOf(host)) });
// 2. The wildcard route reaches the dispatch Worker on arbitrary hosts; an unknown label and a bad label.
for (const host of [`a.${ZONE}`, `plain.${ZONE}`, `${random().slice(0, 8)}.${ZONE}`, `bad_label.${ZONE}`]) note("route", { host, ...(await get(`https://${host}/`)) });
// 3. _headers' Set-Cookie and header, raw and hardened.
for (const host of [`a.${ZONE}`, `h-a.${ZONE}`, `w-a.${ZONE}`]) note("_headers page", { host, ...(await get(`https://${host}/hdr.html`)) });
// 4. The hardened modes' refusals.
note("service-worker script, raw", await get(`https://a.${ZONE}/sw.js`, { headers: { "service-worker": "script" } }));
note("service-worker script, w-", await get(`https://w-a.${ZONE}/sw.js`, { headers: { "service-worker": "script" } }));
note("service-worker script, w-, without the header", await get(`https://w-a.${ZONE}/sw.js`));
note("POST, hardened", await get(`https://h-a.${ZONE}/`, { method: "POST", body: "x" }));
note("not-found answer", await get(`https://h-a.${ZONE}/__gone`));
// 5. A Podster-looking cookie and an Authorization header change nothing.
const plainAnswer = await get(`https://h-plain.${ZONE}/`);
const withCreds = await get(`https://h-plain.${ZONE}/`, { headers: { cookie: "__Secure-better-auth.session_token=spike", authorization: "Bearer spike" } });
note("credentials ignored", { same: plainAnswer.status === withCreds.status && plainAnswer.bodyStart === withCreds.bodyStart, status: withCreds.status });

mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
writeFileSync(join(import.meta.dirname, "results", "hosts.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
