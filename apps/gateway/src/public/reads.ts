import { WorkerEntrypoint } from "cloudflare:workers";
import { mintPublicAssertion } from "../assertion";

// The public read (M4 step 7, ADR 0008), on the gateway's side. Rust decides what's public: this only mints the public
// assertion, keeps successful views for 30 seconds, and copies the contract's named fields, as a second filter.

/** How long a successful view is kept. A view outlives unpublishing or suspension by at most this (M4-03). */
export const PUBLIC_VIEW_SECONDS = 30;
const HANDLE = /^pub_[0-9a-f]{32}$/;
/** The cache's own key space. It's only ever the normalized handle, never anything else from a request. */
const CACHE_ORIGIN = "https://public-view.podster.internal";

/** The contract's `PublicWorkroomView` fields, `packages/contracts/public-workroom-view.schema.json`. A test pins them. */
export const VIEW_FIELDS = {
  top: ["handle", "published_on", "content"],
  content: ["name", "goal", "context", "topic", "workflow", "openings", "outputs", "participant_count", "person_review", "archived"],
  opening: ["id", "title", "responsibilities", "capacity", "filled", "preset", "lead", "publicly_claimable"],
  output: ["title", "description", "ready"],
} as const;

export type PublicAnswer = { status: 200; view: Record<string, unknown> } | { status: 404 };
const NOT_FOUND: PublicAnswer = { status: 404 };

const pick = (value: any, fields: readonly string[]) => {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = value?.[field] ?? null;
  return out;
};

/** Copies only the contract's fields, at every level. It decides nothing: the API already built the view. */
export function contractView(view: any): Record<string, unknown> {
  const top = pick(view, VIEW_FIELDS.top);
  const content = pick(view?.content, VIEW_FIELDS.content);
  content.openings = Array.isArray(view?.content?.openings) ? view.content.openings.map((o: any) => pick(o, VIEW_FIELDS.opening)) : [];
  content.outputs = Array.isArray(view?.content?.outputs) ? view.content.outputs.map((o: any) => pick(o, VIEW_FIELDS.output)) : [];
  top.content = content;
  return top;
}

/** The handle exactly as the API takes it, or null. No trimming or case folding, so every path answers one not-found. */
export function normalizeHandle(handle: unknown): string | null {
  return typeof handle === "string" && HANDLE.test(handle) ? handle : null;
}

/** An Explore page with only the contract's fields in each entry. */
export function contractPage(page: any): { workrooms: Record<string, unknown>[]; next_cursor: string | null } {
  return { workrooms: (Array.isArray(page?.workrooms) ? page.workrooms : []).map(contractView), next_cursor: typeof page?.next_cursor === "string" ? page.next_cursor : null };
}

export type PublicRead = "workroom" | "explore";

/** Which public read an API path is, by its path alone, without a query. */
export function publicReadOf(path: string): PublicRead | null {
  if (path === "/v1/public/explore") return "explore";
  return /^\/v1\/public\/workrooms\/[^/]+$/.test(path) ? "workroom" : null;
}

/** The agent capabilities that are public reads. */
export const PUBLIC_READ_CAPABILITIES: Record<string, PublicRead> = { get_public_workroom: "workroom", discover_workrooms: "explore" };

/**
 * The one field filter for every public read the gateway returns: `PublicReads`, agents' capabilities and people's
 * passthrough (ADR 0008, layer 3).
 */
export function filterPublicRead(read: PublicRead, body: unknown): Record<string, unknown> {
  return read === "workroom" ? contractView(body) : contractPage(body);
}

/**
 * A signed-in person's public read through the dashboard's passthrough: a 200 carries only the contract's fields, and
 * every answer on these paths says `no-store`. `null` leaves any other path to the passthrough as it was.
 */
export async function publicPassthrough(path: string, response: Response): Promise<Response | null> {
  const read = publicReadOf(path);
  if (!read) return null;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (response.status !== 200) return new Response(response.body, { status: response.status, headers });
  const body = await response.json().catch(() => undefined);
  if (body === undefined) return new Response(JSON.stringify({ error: { code: "upstream_unavailable", message: "upstream_unavailable" } }), { status: 502, headers });
  return new Response(JSON.stringify(filterPublicRead(read, body)), { status: 200, headers });
}

type Fetch = (handle: string) => Promise<Response>;
type Store = Pick<Cache, "match" | "put">;

/**
 * One room's public view. Only a successful view is kept, for 30 seconds, under the handle alone, so a not-found, an error
 * or a refusal is never pinned and publishing shows at once. Anything that isn't a view is the one not-found.
 */
export async function publicView(handle: unknown, fetchView: Fetch, store: Store | null): Promise<PublicAnswer> {
  const normalized = normalizeHandle(handle);
  if (!normalized) return NOT_FOUND;
  const key = new Request(`${CACHE_ORIGIN}/workrooms/${normalized}`);
  const hit = await store?.match(key).catch(cacheTrouble);
  if (hit) {
    // A corrupt entry is treated as a miss would be, never served.
    const cached = await hit.json().catch(() => undefined);
    if (cached !== undefined) {
      const view = filterPublicRead("workroom", cached);
      if (view.handle === normalized) return { status: 200, view };
    }
  }
  const response = await fetchView(normalized);
  if (response.status !== 200) return NOT_FOUND;
  const body = await response.json().catch(() => undefined);
  if (body === undefined) return NOT_FOUND;
  const view = filterPublicRead("workroom", body);
  // The API's view is canonical, so a mismatched handle means something's wrong: it's not served or kept.
  if (view.handle !== normalized) return NOT_FOUND;
  await store?.put(key, new Response(JSON.stringify(view), { headers: { "content-type": "application/json", "cache-control": `max-age=${PUBLIC_VIEW_SECONDS}` } })).catch(cacheTrouble);
  return { status: 200, view };
}

type PublicEnv = { API: Fetcher; ASSERTION_SIGNING_JWK: string };

/** Asks the API for the view as nobody, with the public assertion. */
export function viewFetcher(env: PublicEnv): Fetch {
  return async (handle) => {
    const headers = { "x-podster-assertion": await mintPublicAssertion(env.ASSERTION_SIGNING_JWK) };
    try {
      return await env.API.fetch(new Request(`https://api.internal/v1/public/workrooms/${handle}`, { headers, signal: AbortSignal.timeout(10_000) }));
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}

/** The public views' own named cache, apart from anything else the gateway might keep. */
export const PUBLIC_VIEW_CACHE = "podster-public-views";

let troubleLogged = false;
/** A cache that throws is a miss. It's logged once per isolate, with no handle or ID. */
function cacheTrouble(): undefined {
  if (!troubleLogged) {
    troubleLogged = true;
    console.error("public view cache unavailable");
  }
  return undefined;
}

async function viewCache(): Promise<Store | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(PUBLIC_VIEW_CACHE);
  } catch {
    return cacheTrouble() ?? null;
  }
}

/**
 * The public read for `apps/web`, by service binding only. No route of the gateway reaches it, so no custom domain can, and
 * nothing a client sends reaches the assertion: it takes a handle and nothing else.
 */
export class PublicReads extends WorkerEntrypoint<PublicEnv> {
  async getWorkroom(handle: string): Promise<PublicAnswer> {
    return publicView(handle, viewFetcher(this.env), await viewCache());
  }
}
