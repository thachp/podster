// A small static app, as a room's app might be, for the browser run only. Its script tries each thing an ordinary
// static app does and writes what happened into the page as text, because a sandboxed page's own results can't be
// read by evaluating script in it from outside in every browser.

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const INDEX = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>sandbox probe</title>
<link rel="stylesheet" href="/style.css">
<style>#inline-styled { color: rgb(1, 2, 3); }</style>
<script>document.documentElement.dataset.inlineScript = "ran";</script>
<script type="module" src="/app.js"></script>
</head>
<body>
<h1 id="styled">probe</h1>
<p id="inline-styled">inline style</p>
<p id="webfont" style="font-family: probe-font">web font</p>
<img id="img" src="/pixel.png" alt="">
<img id="data-img" src="data:image/png;base64,${PIXEL}" alt="">
<img id="other-img" src="https://elsewhere.example/pixel.png" alt="">
<a id="next" href="/second.html">next page</a>
<a id="download" href="/file.bin" download="file.bin">download</a>
<form id="form" action="/submitted" method="get"><input name="q" value="1"><button id="submit" type="submit">submit</button></form>
<button id="popup" type="button">popup</button>
<button id="modal" type="button">modal</button>
<iframe id="frame" src="/frame.html" title="frame"></iframe>
<pre id="results" data-done="0">pending</pre>
<pre id="actions"></pre>
</body>
</html>
`;

const APP = `const results = {};
const violations = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective + " " + (event.blockedURI || "inline")));
const attempt = async (name, run) => {
  try { results[name] = { ok: true, value: await run() }; } catch (error) { results[name] = { ok: false, error: (error && error.name) || String(error) }; }
};
const loaded = (img) => new Promise((resolve) => {
  if (img.complete) return resolve(img.naturalWidth > 0);
  img.addEventListener("load", () => resolve(true));
  img.addEventListener("error", () => resolve(false));
});
const actions = document.getElementById("actions");
const act = (text) => { actions.textContent += text + "\\n"; };

await attempt("origin", () => self.origin);
await attempt("moduleScript", () => true);
await attempt("inlineScript", () => document.documentElement.dataset.inlineScript === "ran");
await attempt("fetchJson", async () => (await (await fetch("/data.json")).json()).hello);
await attempt("css", () => getComputedStyle(document.getElementById("styled")).color);
await attempt("inlineStyle", () => getComputedStyle(document.getElementById("inline-styled")).color);
await attempt("image", () => loaded(document.getElementById("img")));
await attempt("dataImage", () => loaded(document.getElementById("data-img")));
await attempt("otherHostImage", () => loaded(document.getElementById("other-img")));
await attempt("history", () => { history.pushState({}, "", "/pushed"); const at = location.pathname; history.replaceState({}, "", "/"); return at; });
await attempt("fetchOtherHost", async () => (await fetch("https://elsewhere.example/data.json")).status);
await attempt("fetchPost", async () => (await fetch("/data.json", { method: "POST" })).status);
await attempt("webFont", async () => { const font = new FontFace("probe-font", "url(/font.woff2)"); try { await font.load(); return "loaded"; } catch (error) { return "requested, then " + error.name; } });
await attempt("cookieWrite", () => { document.cookie = "probe=1; path=/"; return document.cookie; });
await attempt("cookieWriteForDomain", () => { document.cookie = "shared=1; path=/; domain=" + location.hostname.split(".").slice(1).join("."); return document.cookie; });
await attempt("cookieRead", () => document.cookie);
await attempt("localStorage", () => { localStorage.setItem("probe", "1"); return localStorage.getItem("probe"); });
await attempt("sessionStorage", () => { sessionStorage.setItem("probe", "1"); return sessionStorage.getItem("probe"); });
await attempt("indexedDB", () => new Promise((resolve, reject) => { const open = indexedDB.open("probe"); open.onsuccess = () => resolve("opened"); open.onerror = () => reject(open.error); }));
await attempt("cacheApi", async () => { await caches.open("probe"); return "opened"; });
await attempt("serviceWorker", async () => { const registration = await navigator.serviceWorker.register("/sw.js"); return registration.scope; });

document.getElementById("form").addEventListener("submit", () => { act("form submit event"); fetch("/sentinel?after=form"); });
document.getElementById("download").addEventListener("click", () => { act("download click"); fetch("/sentinel?after=download"); });
document.getElementById("popup").addEventListener("click", () => { let opened = "threw"; try { opened = window.open("/popup.html") === null ? "null" : "a window"; } catch (error) { opened = "threw " + error.name; } act("window.open returned " + opened); fetch("/sentinel?after=popup"); });
document.getElementById("modal").addEventListener("click", () => { let said = "threw"; try { said = String(alert("probe")); } catch (error) { said = "threw " + error.name; } act("alert returned " + said); fetch("/sentinel?after=modal"); });

results.violations = violations;
const out = document.getElementById("results");
out.textContent = JSON.stringify(results);
out.dataset.done = "1";
`;

const text = (type: string, body: string) => ({ type, body: new TextEncoder().encode(body).buffer as ArrayBuffer });
const bytes = (type: string, base64: string) => ({ type, body: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer as ArrayBuffer });

/** The app's files, by path. */
export const FILES: Record<string, { type: string; body: ArrayBuffer }> = {
  "/": text("text/html; charset=utf-8", INDEX),
  "/app.js": text("text/javascript; charset=utf-8", APP),
  "/style.css": text("text/css; charset=utf-8", "#styled { color: rgb(10, 20, 30); }\n"),
  "/data.json": text("application/json", '{"hello":"world"}\n'),
  "/pixel.png": bytes("image/png", PIXEL),
  "/second.html": text("text/html; charset=utf-8", '<!doctype html><title>second</title><p id="second">second page</p>\n'),
  "/frame.html": text("text/html; charset=utf-8", '<!doctype html><title>frame</title><p id="framed">framed</p>\n'),
  "/popup.html": text("text/html; charset=utf-8", "<!doctype html><title>popup</title><p>popup</p>\n"),
  "/submitted": text("text/html; charset=utf-8", '<!doctype html><title>submitted</title><p id="submitted">submitted</p>\n'),
  "/file.bin": text("application/octet-stream", "a file to download\n"),
  // Not a real font: the run shows whether the browser may ask for it, not how it renders.
  "/font.woff2": text("font/woff2", "not a font\n"),
  "/sw.js": text("text/javascript; charset=utf-8", "self.addEventListener('fetch', () => {});\n"),
  "/sentinel": text("text/plain", "ok\n"),
};
