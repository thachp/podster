// Rendered public room pages, kept in this web Worker isolate for 30 seconds (M4 step 11(b), ADR 0008). The view already comes
// from the gateway's 30-second cache, so a hit here skips rendering it again. The key is the handle and a hash of the exact
// view rendered: PublicReads doesn't carry the API's `view_hash`, so this hashes what it received, and any change to the view
// is a new key. Nothing about who asked is part of it, so every viewer still gets the same bytes. Never logged.

export const PAGE_CACHE_MS = 30_000;
/** Bounds on what one isolate keeps: a worst-case page is a few hundred KB. */
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;

type Entry = { html: string; at: number; bytes: number };
const pages = new Map<string, Entry>();
let held = 0;

/** SHA-256 of the view as JSON. The gateway's field filter writes its fields in a fixed order, so the same view hashes the same. */
export async function viewKey(handle: string, view: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(view)));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${handle}:${hex}`;
}

function drop(key: string) {
  const entry = pages.get(key);
  if (!entry) return;
  held -= entry.bytes;
  pages.delete(key);
}

/** The page for this key, rendering it only if it isn't held or is older than 30 seconds. */
export function cachedPage(key: string, render: () => string, now = Date.now()): string {
  const hit = pages.get(key);
  if (hit && now - hit.at < PAGE_CACHE_MS) return hit.html;
  drop(key);
  const html = render();
  const bytes = html.length * 2;
  if (bytes > MAX_BYTES) return html;
  pages.set(key, { html, at: now, bytes });
  held += bytes;
  // Oldest first, since a Map keeps insertion order.
  for (const oldest of pages.keys()) {
    if (pages.size <= MAX_ENTRIES && held <= MAX_BYTES) break;
    drop(oldest);
  }
  return html;
}

/** For tests. */
export function clearPageCache() {
  pages.clear();
  held = 0;
}
