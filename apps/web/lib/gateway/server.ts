import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { webEnv } from "./env";
import { safeNext } from "../safe-next";
import { forwardedHeaders } from "./forward";
import { toResult, type GatewayResult } from "./result";

/** Where a person goes when a read the whole page needs was refused for their rate limit. It reads nothing from the gateway. */
export const RATE_LIMITED_PATH = "/too-many-requests";

/** The longest wait a page says, whatever the gateway asked, so a bad header can't strand someone. */
export const MAX_WAIT_SECONDS = 300;

/** Whole seconds only, which is all the gateway sends, and capped. Anything else means no wait is known. */
export function secondsToWait(header: string | null | undefined) {
  return header && /^\d{1,6}$/.test(header) ? Math.min(Number(header), MAX_WAIT_SECONDS) : undefined;
}

/** A read for a server component, as the signed-in person. Paths are the gateway's, such as `/api/v1/me`. */
export async function gatewayQuery<T>(path: string): Promise<GatewayResult<T>> {
  const forwarded = forwardedHeaders(await headers());
  // Rendering a page isn't a cross-site write, and a query has no use for these.
  forwarded.delete("origin");
  forwarded.delete("content-type");
  return toResult<T>(await webEnv().GATEWAY.fetch(new URL(path, webEnv().APP_URL).toString(), { headers: forwarded }));
}

/**
 * Sends the person to the rate-limit page, which says how long to wait and links back to where they were. It's a redirect,
 * not an error, so it works from any layout or page, and the error page's "something went wrong" isn't what they see. The way
 * back is the path middleware set, never one a client sent, and it goes through `safeNext`.
 */
export async function rateLimited(retryAfter?: number): Promise<never> {
  const back = safeNext((await headers()).get("x-podster-path"));
  const query = new URLSearchParams();
  // `toResult` keeps whatever whole seconds the gateway sent, so the cap is applied here.
  const wait = retryAfter === undefined ? undefined : secondsToWait(String(retryAfter));
  if (wait !== undefined) query.set("after", String(wait));
  // Never back to itself, which would go round.
  if (!back.startsWith(RATE_LIMITED_PATH)) query.set("next", back);
  const search = query.toString();
  redirect(search ? `${RATE_LIMITED_PATH}?${search}` : RATE_LIMITED_PATH);
}

export type Session = { user: { id: string; name: string; email: string } };

/** Once per render, whichever layouts and pages ask. */
export const getSession = cache(async (): Promise<Session | null> => {
  // A read here can't pass a new cookie on to the browser, so it mustn't slide the session. AppShell's fetch does that.
  const result = await gatewayQuery<Session | null>("/api/auth/get-session?disableRefresh=true");
  if (result.ok) return result.data;
  // Neither is a signed-out person. Sending them to sign in would look like the session ended.
  if (result.status === 429) return rateLimited(result.retryAfter);
  if (result.status >= 500) throw new Error("gateway_unavailable");
  return null;
});

export const signInPath = (next: string) => `/sign-in?next=${encodeURIComponent(next)}`;

/** Sends a signed-out person to sign in. Being signed in says nothing about what they may see: Rust decides that per request. */
export async function requireSession(next: string) {
  const session = await getSession();
  if (!session) redirect(signInPath(next));
  return session;
}

export type Identity = { id: string; org_id: string; orgs: string[]; admin_orgs: string[]; inbox_unread: number };
export type Organization = { id: string; name: string; personal: number; role: string };

export const getIdentity = cache(async () => gatewayQuery<Identity>("/api/v1/me"));
export const getOrganizations = cache(async () => gatewayQuery<{ organizations: Organization[] }>("/api/orgs"));
export const currentOrgCookie = async () => (await cookies()).get("podster-org")?.value ?? null;
