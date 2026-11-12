// Spike only. Each call reports what the browser allowed, and the error's name when it refused. No values leave the page.
const attempt = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e && e.name ? e.name : String(e) };
  }
};

window.probe = {
  origin: () => attempt(() => self.origin),
  setCookie: (text) => attempt(() => {
    document.cookie = text;
    return document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).sort();
  }),
  cookieNames: () => attempt(() => document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).sort()),
  setLocal: (k, v) => attempt(() => { localStorage.setItem(k, v); return localStorage.length; }),
  localKeys: () => attempt(() => Object.keys(localStorage).sort()),
  cachePut: (name) => attempt(async () => { const c = await caches.open(name); await c.put("/cached-marker", new Response("x")); return (await caches.keys()).sort(); }),
  cacheNames: () => attempt(async () => (await caches.keys()).sort()),
  registerSW: () => attempt(async () => { const r = await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; return r.scope; }),
  swRegistrations: () => attempt(async () => (await navigator.serviceWorker.getRegistrations()).length),
  swControlled: () => attempt(() => Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)),
  fetchStatus: (path) => attempt(async () => (await fetch(path, { credentials: "include" })).status),
};
document.getElementById("status").textContent = "ready";
