// Spike P1 only. One local HTTPS server that answers for every test host, and an HTTP proxy that sends every CONNECT
// to it, so a real browser makes real TLS requests with real cookies to names that resolve nowhere. Listens on the
// loopback address alone. No DNS, no Cloudflare, nothing deployed.
//
// Hosts. `.test` isn't on the Public Suffix List, so by the list's default rule `pv.test` is one registrable domain:
// its hosts are one site, as `*.podster.site` hosts are before the entry.
//   a.pv.test, b.pv.test   probe hosts: preview A and its sibling B
//   g.pv.test              a preview host behind the plan's gate (5.3), a working stand-in of the flow
//   app.ap.test            the application host, another site, holding a stand-in session cookie
//   x.other.test           an unrelated site, to start flows from
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENTER_CSP, ENTER_SCRIPT, SESSION, SESSION_SECONDS, STATE, TICKET_SECONDS,
  check, gateCookies, newState, previewPolicy, productionPolicy, sameHostPath, sign, stateHash,
} from "./pure.mjs";

export const A = "a.pv.test";
export const B = "b.pv.test";
export const G = "g.pv.test";
export const APP = "app.ap.test";
export const X = "x.other.test";
export const APP_SESSION = "__Host-app_session";
const HOSTS = new Set([A, B, G, APP, X]);

/** A self-signed server certificate for the test hosts, made for one run. The browser is told to accept it. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "spike-p1-tls-"));
  const config = join(dir, "openssl.cnf");
  writeFileSync(config, [
    "[req]", "distinguished_name = subject", "x509_extensions = server", "prompt = no",
    "[subject]", "CN = pv.test",
    "[server]", "basicConstraints = critical,CA:FALSE", "keyUsage = critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage = serverAuth", "subjectAltName = DNS:*.pv.test,DNS:*.ap.test,DNS:*.other.test", "",
  ].join("\n"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", key, "-out", cert], { stdio: ["ignore", "ignore", "pipe"] });
  const pair = { key: readFileSync(key), cert: readFileSync(cert) };
  rmSync(dir, { recursive: true, force: true });
  return pair;
}

const html = (body, title = "p1") => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;

/** The page a probe host serves at `/page`, under the CSP its `mode` names: production's, the preview's, or none. */
function probePage(origin, mode, load) {
  const subresources = load
    ? `<script type="module" src="/sub/module.js"></script><script src="/sub/classic.js"></script><img src="/sub/img.png" alt="">`
    : "";
  const csp = mode === "strict" ? productionPolicy(origin) : mode === "same" ? previewPolicy(origin) : null;
  return { csp, body: html(`<p>probe ${mode}</p>${subresources}`) };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * Starts the server and the proxy. Returns `{ proxy, log, key, close }`: `proxy` is the proxy's address for the
 * browser; `log` is every request the server answered, names and headers only, in memory; `key` signs tickets.
 */
export async function startStack() {
  const key = randomBytes(32);
  const log = [];
  const tls = certificate();

  const server = createHttps(tls, (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const host = String(req.headers.host ?? "").replace(/:443$/, "");
      const url = new URL(req.url, `https://${host}`);
      const entry = {
        host, method: req.method, path: url.pathname, query: url.search, cookie: req.headers.cookie ?? null,
        sfs: req.headers["sec-fetch-site"] ?? null, sfm: req.headers["sec-fetch-mode"] ?? null,
        sfd: req.headers["sec-fetch-dest"] ?? null, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null,
        accept: req.headers.accept ?? null, at: Date.now(),
      };
      log.push(entry);
      if (!HOSTS.has(host)) { res.writeHead(421).end(); return; }
      try {
        route(host, url, req, res, raw, entry);
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" }).end(String(error?.message ?? error));
      }
    });
  });

  function send(res, status, headers, body = "") {
    res.writeHead(status, { "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers });
    res.end(body);
  }

  function route(host, url, req, res, raw, entry) {
    const origin = `https://${host}`;
    const p = url.pathname;

    // ---- probe routes, on every host but the gated one ----
    if (host !== G || p.startsWith("/probe/")) {
      if (p === "/set" || p === "/probe/set") {
        send(res, 200, { "content-type": "text/html", "set-cookie": url.searchParams.getAll("c") }, html("set"));
        return;
      }
      if (p === "/echo" || p === "/probe/echo") {
        const asker = req.headers.origin;
        const cors = asker && /^https:\/\/[a-z]+\.pv\.test$/.test(asker) ? { "access-control-allow-origin": asker, "access-control-allow-credentials": "true" } : {};
        send(res, 200, { "content-type": "application/json", ...cors }, JSON.stringify({ cookie: entry.cookie, sfs: entry.sfs }));
        return;
      }
      if (p === "/page") {
        const { csp, body } = probePage(origin, url.searchParams.get("mode") ?? "none", url.searchParams.get("load") === "1");
        const headers = { "content-type": "text/html" };
        if (csp) headers["content-security-policy"] = csp;
        if (url.searchParams.get("oac") === "1") headers["origin-agent-cluster"] = "?1";
        send(res, 200, headers, body);
        return;
      }
      if (p.startsWith("/sub/")) {
        // Answered as production answers a static host's files, so a page under the strict sandbox can load them.
        const headers = { "access-control-allow-origin": "*" };
        if (p === "/sub/module.js") send(res, 200, { ...headers, "content-type": "text/javascript" }, "fetch('/sub/fetch-from-module').catch(()=>{});");
        else if (p === "/sub/classic.js") send(res, 200, { ...headers, "content-type": "text/javascript" }, "fetch('/sub/fetch-default').catch(()=>{});fetch('/sub/fetch-include',{credentials:'include'}).catch(()=>{});");
        else if (p === "/sub/img.png") send(res, 200, { ...headers, "content-type": "image/png" }, PNG);
        else send(res, 200, { ...headers, "content-type": "text/plain" }, "ok");
        return;
      }
      if (p === "/w") { send(res, 204, {}); return; }
      if (p === "/oac") {
        // A plain page, no CSP, that frames its sibling and tries to join it with document.domain.
        const h = url.searchParams.get("h");
        const sib = host === A ? B : A;
        const headers = { "content-type": "text/html" };
        if (h === "1") headers["origin-agent-cluster"] = "?1";
        send(res, 200, headers, html(`<iframe id="f" src="https://${sib}/oac-frame?h=${h}"></iframe>`));
        return;
      }
      if (p === "/oac-frame") {
        const headers = { "content-type": "text/html" };
        if (url.searchParams.get("h") === "1") headers["origin-agent-cluster"] = "?1";
        send(res, 200, headers, html("<p>frame</p>", "frame-title"));
        return;
      }
      if (p === "/start") {
        const to = url.searchParams.get("to") ?? `https://${G}/`;
        send(res, 200, { "content-type": "text/html" }, html(`<a id="go" href="${to.replace(/"/g, "")}">go</a>`));
        return;
      }
      if (host === APP && p === "/login") {
        send(res, 200, { "content-type": "text/html", "set-cookie": `${APP_SESSION}=${randomBytes(16).toString("hex")}; Secure; HttpOnly; SameSite=Lax; Path=/` }, html("signed in"));
        return;
      }
      if (host === APP && p === "/preview-access") {
        const asked = url.searchParams.get("host");
        const st = url.searchParams.get("st");
        const r = sameHostPath(url.searchParams.get("r"));
        const signedIn = (entry.cookie ?? "").split(";").some((c) => c.trim().startsWith(`${APP_SESSION}=`));
        if (!signedIn) { send(res, 401, { "content-type": "text/html" }, html("signed out")); return; }
        if (asked !== G || !st) { send(res, 404, { "content-type": "text/plain" }, "preview_access_refused"); return; }
        const now = Math.floor(Date.now() / 1000);
        const ticket = sign(key, { typ: "ticket", aud: G, st, sid: randomBytes(8).toString("hex"), iat: now, exp: now + TICKET_SECONDS });
        const fragment = new URLSearchParams({ t: ticket, r }).toString();
        send(res, 303, { location: `https://${G}/__podster/enter#${fragment}` });
        return;
      }
      send(res, 404, { "content-type": "text/plain" }, "not found");
      return;
    }

    // ---- the gated preview host, g.pv.test ----
    const jar = gateCookies(entry.cookie);
    if (p === "/__podster/enter" && req.method === "GET") {
      send(res, 200, { "content-type": "text/html", "content-security-policy": ENTER_CSP, "cross-origin-opener-policy": "same-origin", "origin-agent-cluster": "?1" },
        `<!doctype html><meta charset="utf-8"><title>enter</title><body><script>${ENTER_SCRIPT}</script></body>`);
      return;
    }
    if (p === "/__podster/enter" && req.method === "POST") {
      if (entry.sfs !== "same-origin" || entry.origin !== origin) { send(res, 403, { "content-type": "text/plain" }, "not_same_origin"); return; }
      if (!jar.ok || !jar.state) { send(res, 401, { "content-type": "text/plain" }, `cookies_${jar.why ?? "no_state"}`); return; }
      let body;
      try { body = JSON.parse(raw); } catch { send(res, 400, {}, "bad"); return; }
      const ticket = check(key, body.t, { typ: "ticket", host: G, state: jar.state });
      if (!ticket.ok) { send(res, 401, { "content-type": "text/plain" }, `ticket_${ticket.why}`); return; }
      const now = Math.floor(Date.now() / 1000);
      const session = sign(key, { typ: "session", aud: G, st: ticket.claims.st, sid: ticket.claims.sid, iat: now, exp: now + SESSION_SECONDS });
      send(res, 200, {
        "content-type": "application/json",
        "set-cookie": [
          `${SESSION}=${session}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
          `${STATE}=${jar.state}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`,
        ],
      }, JSON.stringify({ r: sameHostPath(body.r) }));
      return;
    }
    const passed = jar.ok && jar.session && jar.state && check(key, jar.session, { typ: "session", host: G, state: jar.state }).ok;
    if (passed) {
      send(res, 200, { "content-type": "text/html", "content-security-policy": previewPolicy(origin), "origin-agent-cluster": "?1" }, html(`<p id="app">app ${p}</p>`, "app"));
      return;
    }
    const navigation = req.method === "GET" && (entry.sfm === "navigate" || (entry.sfm === null && /text\/html/.test(entry.accept ?? "")));
    if (!navigation) { send(res, 401, { "content-type": "text/plain" }, "preview_access_required"); return; }
    const state = jar.ok && jar.state ? jar.state : newState();
    const headers = { location: `https://${APP}/preview-access?${new URLSearchParams({ host: G, st: stateHash(state), r: p + url.search })}` };
    if (!(jar.ok && jar.state)) headers["set-cookie"] = `${STATE}=${state}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`;
    send(res, 303, headers);
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverPort = server.address().port;

  // Every CONNECT, to any of the test hosts on 443, goes to the one server. Anything else is refused.
  const proxy = createHttp((req, res) => { res.writeHead(405).end(); });
  proxy.on("connect", (req, socket, head) => {
    const [name, port] = String(req.url).split(":");
    if (!HOSTS.has(name) || port !== "443") { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upstream = connect(serverPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const drop = () => { upstream.destroy(); socket.destroy(); };
    upstream.on("error", drop);
    socket.on("error", drop);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  return {
    proxy: `http://127.0.0.1:${proxy.address().port}`,
    log,
    key,
    close: () => { server.closeAllConnections?.(); proxy.closeAllConnections?.(); server.close(); proxy.close(); },
  };
}
