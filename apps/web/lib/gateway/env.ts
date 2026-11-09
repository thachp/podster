import { env } from "cloudflare:workers";

export type WebEnv = {
  /** The gateway's Worker. There is no binding to the Rust API, D1 or Durable Objects. */
  GATEWAY: Fetcher;
  /** This application's public origin. */
  APP_URL: string;
  /** The gateway's public address, which agents connect to. It's shown to people and never called from here. */
  GATEWAY_URL: string;
  SIGN_IN_PROVIDERS: string;
  LOCAL_PASSWORD_SIGNIN: string;
  /** The gateway's PublicReads entrypoint, the public room page's one way to its view (M4 step 7). */
  PUBLIC_READS?: { getWorkroom(handle: string): Promise<{ status: 200; view: Record<string, unknown> } | { status: 404 }> };
  /** Per client address: the signed-out room page, and Explore, where one request reads up to 20 rooms (M4 step 11(b)). */
  PUBLIC_PAGE_LIMIT?: import("../public/limit").RateLimiter;
  EXPLORE_LIMIT?: import("../public/limit").RateLimiter;
};

export const webEnv = () => env as unknown as WebEnv;
