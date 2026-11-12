// Spike only. A service worker that passes every request to the network, except one marker path it answers itself,
// so the browser test can tell whether it is still in control after Clear-Site-Data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname === "/__sw-marker") {
    event.respondWith(new Response("from-sw", { headers: { "content-type": "text/plain" } }));
  }
});
