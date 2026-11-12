// Spike only. What an ordinary static app does: load JSON, remember something, draw. Each step reports ok or its error.
const out = {};
const step = async (name, fn) => {
  try {
    out[name] = { ok: true, value: await fn() };
  } catch (e) {
    out[name] = { ok: false, error: e && e.name ? e.name : String(e) };
  }
};
await step("fetchJson", async () => (await (await fetch("/data.json")).json()).items.length);
await step("localStorage", () => { const n = Number(localStorage.getItem("visits") || 0) + 1; localStorage.setItem("visits", String(n)); return n; });
await step("sessionStorage", () => { sessionStorage.setItem("s", "1"); return sessionStorage.length; });
await step("indexedDB", () => new Promise((resolve, reject) => { const r = indexedDB.open("spike"); r.onsuccess = () => resolve(true); r.onerror = () => reject(r.error); }));
await step("history", () => { history.replaceState({}, "", "/?step=1"); return location.search; });
await step("style", () => getComputedStyle(document.querySelector("h1")).color);
await step("image", () => new Promise((resolve) => { const i = document.getElementById("logo"); i.complete ? resolve(i.naturalWidth > 0) : (i.onload = () => resolve(true), i.onerror = () => resolve(false)); }));
window.plainResult = out;
document.getElementById("result").textContent = JSON.stringify(out);
document.getElementById("status").textContent = "done";
