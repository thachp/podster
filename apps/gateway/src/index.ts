import { agentAuth } from "@better-auth/agent-auth";
import { DurableObject } from "cloudflare:workers";
import { authorizationErrorRedirect, insufficientScope, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { APIError } from "better-auth/api";
import { calculateJwkThumbprint, decodeJwt, type JWK } from "jose";
import { handleOrgPeople, retryDepartures } from "./organizations";
import { mintAssertion, type Identity } from "./assertion";
import { CAPABILITIES, InvalidArguments, jsonSchema, toApiCall, zodShape, type ApiCall, type Capability } from "./capabilities";
import { EMAIL_LINK_ROUTE, EMAIL_LINK_SECONDS, EMAIL_VERIFY_ROUTE, emailSignInEnabled, handleEmailLink, handleEmailVerify, linkMustNotReach, linkTokenHash, sendSignInLink, type EmailBinding } from "./email-sign-in";
import { handleTestSignUp, isTestEmail, TEST_ID_PREFIX, TEST_SESSION_SECONDS, TEST_SIGNUP_ROUTE } from "./test-people";
import { handleAgentDownload, isFilePath, serveFile } from "./downloads";
import { handleUpload } from "./uploads";
import { answerA2a, checkA2aRequest, handleA2aCard, isA2aPath } from "./a2a";
import type { ApiReads } from "./a2a/reads";
import { buildOAuth, resourceKind, routeOAuth } from "./oauth";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  API: Fetcher;
  BASE_URL: string;
  /** The application host, reached only through the web Worker's service binding. See docs/adr/0001. Unset, nothing changes. */
  APP_URL?: string;
  AUTH_SECRET: string;
  ASSERTION_SIGNING_JWK: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Limits per minute, set in wrangler.jsonc: anything per IP, per credential or person, and sensitive actions. */
  RL_GENERAL: RateLimit;
  RL_ACCOUNT: RateLimit;
  RL_SENSITIVE: RateLimit;
  /** One object per route and client, for an exact count on routes that store what anonymous callers send. */
  STRICT_COUNTER: DurableObjectNamespace<StrictCounter>;
  /** Overrides the counter's limits. Tests only. */
  STRICT_PER_MINUTE?: string;
  STRICT_PER_DAY?: string;
  /** Email sign-in, off unless all three are set, and only on the application host. See email-sign-in.ts. */
  ENABLE_EMAIL_SIGNIN?: string;
  EMAIL?: EmailBinding;
  EMAIL_FROM?: string;
  /** Test environments only. Never set in staging or production. */
  ENABLE_PASSWORD_SIGNIN?: string;
  /** Staging's test sign-up, set only in env.staging. See test-people.ts. */
  ENABLE_E2E_SIGNUP?: string;
  E2E_SIGNUP_SECRET?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const denied = (code: string, status: number) => json({ error: { code, message: code } }, status);
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const personId = (userId: string) => `per_${userId}`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_NAME_BYTES = 200;
const API_TIMEOUT_MS = 25_000;
const AGENT_JWT_MAX_AGE_SECONDS = 60;
const validName = (name: string) => name.length > 0 && new TextEncoder().encode(name).length <= MAX_NAME_BYTES;
/** Agents choose their registered name, and its limit is in characters, so it's shortened to fit ours. */
function fitName(name: string) {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= MAX_NAME_BYTES) return name;
  return new TextDecoder().decode(bytes.slice(0, MAX_NAME_BYTES)).replace(/\uFFFD+$/, "");
}

/**
 * The only plugin and Better Auth routes that are public. Everything else, including `/host/*`, approve, grant and
 * revoke routes, stays private: they would let a signed-in stranger replace a pending agent's keys or decide its fate.
 */
const PUBLIC_AUTH_ROUTES = [
  /^\/sign-in\/(social|email)$/,
  /^\/sign-up\/email$/,
  /^\/sign-out$/,
  /^\/callback\/[\w-]+$/,
  /^\/get-session$/,
  /^\/error$/,
  /^\/ok$/,
  /^\/agent-configuration$/,
  /^\/agent\/register$/,
  /^\/agent\/status$/,
  /^\/capability\/(list|describe|execute)$/,
];
export const isPublicAuthRoute = (path: string) => PUBLIC_AUTH_ROUTES.some((route) => route.test(path));

/** The routes that start a session. With an application host, only it may, so no browser gets a session on the gateway's host. */
const STARTS_SESSION = /^\/(sign-in\/(social|email|magic-link)|magic-link\/verify|sign-up\/email|callback\/[\w-]+)$/;

/** A key's `kid` must be its own thumbprint, because the plugin finds hosts by the `kid` a caller supplies. */
async function honestKey(key: unknown) {
  if (key === undefined) return true;
  if (!key || typeof key !== "object") return false;
  // Extra members don't change a key's thumbprint, but they're stored.
  if (JSON.stringify(key).length > MAX_PUBLIC_KEY_LENGTH) return false;
  const { kid } = key as JWK;
  if (kid === undefined) return true;
  return await calculateJwkThumbprint(key as JWK, "sha256").then((thumbprint) => thumbprint === kid, () => false);
}

/**
 * Refuses the registration options that let a caller touch a host it doesn't hold the key for. With a borrowed `kid`,
 * the plugin puts the agent on the victim's host, and a claim with `force_approval` then revokes the victim's agents
 * and takes the host. Remote key URLs are refused too, since we'd fetch them and a host could change keys with them.
 */
const MAX_HOST_NAME_LENGTH = 200;
const MAX_PUBLIC_KEY_LENGTH = 1024;

async function refusedRegistration(request: Request, text: string): Promise<Response | null> {
  let body: { force_approval?: unknown; capabilities?: unknown } | null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return denied("invalid_argument", 400);
  if (body.force_approval !== undefined) return denied("force_approval_not_supported", 400);
  // An agent with no capabilities could never gain one, because requesting more isn't public.
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) return denied("capabilities_required", 400);
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  } catch {
    return denied("invalid_jwt", 401);
  }
  // The plugin limits a host name in the body, but stores one from the token as it is.
  if (typeof claims.host_name === "string" && claims.host_name.length > MAX_HOST_NAME_LENGTH) return denied("invalid_argument", 400);
  if (claims.host_jwks_url !== undefined || claims.agent_jwks_url !== undefined) return denied("jwks_url_not_supported", 400);
  if (!(await honestKey(claims.host_public_key)) || !(await honestKey(claims.agent_public_key))) return denied("invalid_public_key", 400);
  return null;
}

/** Test environments only: password sign-in can't be turned on anywhere with a real hostname. */
function passwordSignInEnabled(env: Env) {
  const host = new URL(env.BASE_URL).hostname;
  return env.ENABLE_PASSWORD_SIGNIN === "true" && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".test"));
}

const STRICT_PER_MINUTE = 20;
const STRICT_PER_DAY = 500;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * An exact count, because Cloudflare's rate-limit binding overshot by 8 times or more on new connections when measured
 * on staging. A Durable Object is one thread in one place, so requests can't slip between counts. The record removes
 * itself after a day, so an attacker changing address doesn't leave storage behind.
 */
export class StrictCounter extends DurableObject<Env> {
  /** Returns 0 if allowed, or the seconds until the client may try again. */
  async take(perMinute: number, perDay: number): Promise<number> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<{ minuteStart: number; minute: number; dayStart: number; day: number }>("count");
    const count = stored ?? { minuteStart: now, minute: 0, dayStart: now, day: 0 };
    if (now - count.minuteStart >= MINUTE_MS) Object.assign(count, { minuteStart: now, minute: 0 });
    if (now - count.dayStart >= DAY_MS) Object.assign(count, { dayStart: now, day: 0 });
    if (count.day >= perDay) return Math.ceil((count.dayStart + DAY_MS - now) / 1000);
    if (count.minute >= perMinute) return Math.ceil((count.minuteStart + MINUTE_MS - now) / 1000);
    count.minute += 1;
    count.day += 1;
    await this.ctx.storage.put("count", count);
    if (!stored) await this.ctx.storage.setAlarm(now + DAY_MS);
    return 0;
  }

  async alarm() {
    const stored = await this.ctx.storage.get<{ dayStart: number }>("count");
    if (stored && Date.now() - stored.dayStart < DAY_MS) await this.ctx.storage.setAlarm(stored.dayStart + DAY_MS);
    else await this.ctx.storage.deleteAll();
  }
}

/** A value that isn't a positive number falls back, so a bad setting can't turn the limit off or refuse everyone. */
function configuredLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return value && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A day limit only where requests leave long-lived records. Elsewhere, anyone sharing an address could use up the day
 * and lock everyone there out for hours: an agent refreshes its token up to 24 times a day, and sign-in state is
 * short-lived anyway.
 */
const DAY_LIMITED_ROUTES = new Set(["oauth-register", "agent-register"]);

/** Seconds until the client may try again, or 0. Like the binding, a failure lets the request through. */
async function strictRetryAfter(env: Env, route: string, client: string) {
  try {
    const stub = env.STRICT_COUNTER.get(env.STRICT_COUNTER.idFromName(`${route}:${client}`));
    const perDay = DAY_LIMITED_ROUTES.has(route) ? configuredLimit(env.STRICT_PER_DAY, STRICT_PER_DAY) : Number.MAX_SAFE_INTEGER;
    return await stub.take(configuredLimit(env.STRICT_PER_MINUTE, STRICT_PER_MINUTE), perDay);
  } catch (error) {
    if (!limiterFailureLogged) console.error("strict counter failed", error);
    limiterFailureLogged = true;
    return 0;
  }
}

export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
const RETRY_AFTER_SECONDS = "60";

/**
 * In the shape each kind of client reads. OAuth clients need a standard error: the MCP SDK treats anything else as
 * unrecoverable and starts a new consent, which a headless agent can't complete. The Agent Auth SDK reads `error`.
 */
export function rateLimited(path = "", retryAfter = RETRY_AFTER_SECONDS) {
  // A 503 on discovery makes OAuth clients stop and retry. They treat a 429 as no metadata, and head for a new consent.
  if (path.startsWith("/.well-known/")) return new Response(JSON.stringify({ error: { code: "temporarily_unavailable", message: "rate_limited" } }), { status: 503, headers: { "content-type": "application/json", "retry-after": retryAfter } });
  const body = path.startsWith("/oauth/") ? { error: "temporarily_unavailable", error_description: "rate_limited" } : path.startsWith("/api/auth/") ? { error: "rate_limited", message: "rate_limited" } : { error: { code: "rate_limited", message: "rate_limited" } };
  return new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", "retry-after": retryAfter } });
}

let limiterFailureLogged = false;

/** Limits protect against abuse, so a limiter failure doesn't take the service down. The limits are approximate by design. */
export async function withinLimit(limiter: RateLimit, key: string) {
  try {
    return (await limiter.limit({ key })).success;
  } catch (error) {
    // Once per isolate, so a failing limiter can't be turned into a flood of logs.
    if (!limiterFailureLogged) console.error("rate limiter failed", error);
    limiterFailureLogged = true;
    return true;
  }
}

const WORKER_SUBREQUEST_IP = "2a06:98c0:3600::103";

/** Cloudflare sets this and overwrites any client value. An IPv6 client controls a whole /64, so it counts as one. */
export function clientKey(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // Cloudflare gives every request from another zone's Worker this one address, and names the zone in `cf-worker`.
  if (ip === WORKER_SUBREQUEST_IP) return `worker:${request.headers.get("cf-worker") ?? "unknown"}`;
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

/** Anonymous routes that start something, each counted separately for each client. */
export function sensitiveRoute(method: string, path: string) {
  if (path.startsWith("/api/auth/sign-in/") || path.startsWith("/api/auth/sign-up/") || path.startsWith("/api/auth/callback/") || path.startsWith("/api/auth/magic-link/")) return "auth";
  if (method !== "POST") return null;
  return ({ "/sign-in": "sign-in", "/oauth/register": "oauth-register", "/oauth/token": "oauth-token", "/api/auth/agent/register": "agent-register" } as Record<string, string>)[path] ?? null;
}

/** Dashboard commands that create something, or that invite others, and previews, because a preview checks a token. */
const sensitiveCommand = (method: string, path: string) => method === "POST" && /^\/v1\/(workspaces|workspaces\/[^/]+\/invitations|invitations\/accept|invitations\/preview)$/.test(path);

const ERROR_NAMES: Record<number, "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_ENTITY" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "INTERNAL_SERVER_ERROR" | "NOT_IMPLEMENTED" | "GATEWAY_TIMEOUT"> = {
  400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 415: "UNSUPPORTED_MEDIA_TYPE", 422: "UNPROCESSABLE_ENTITY", 500: "INTERNAL_SERVER_ERROR", 501: "NOT_IMPLEMENTED", 504: "GATEWAY_TIMEOUT",
};

class AgentRefused extends Error {}

/** Resolves a verified credential to one agent, and refuses unclaimed or disconnected ones before minting anything. */
export async function resolveAgent(env: Env, provider: "agent_auth" | "mcp_oauth", externalId: string): Promise<Identity> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.org_id, a.generation, a.revoked_at, l.person_id AS linker_id, l.created_at AS linked_at, EXISTS (SELECT 1 FROM org_member m WHERE m.org_id = a.org_id AND m.person_id = l.person_id AND m.created_at <= l.created_at) AS linker_present FROM identity_link l JOIN podster_agent a ON a.id = l.agent_id WHERE l.provider = ? AND l.external_id = ?`,
  ).bind(provider, externalId).first<{ id: string; org_id: string; generation: number; revoked_at: number | null; linker_id: string; linked_at: number; linker_present: number }>();
  if (!row) throw new AgentRefused("agent_unclaimed");
  if (row.revoked_at) throw new AgentRefused("agent_disconnected");
  // A credential ends when whoever connected it leaves the organization, and rejoining doesn't bring it back, so it must
  // be newer than their current membership. An admin can connect a new one to this agent.
  if (!row.linker_present) throw new AgentRefused("credential_owner_left");
  // Who linked this credential, and when, so the API can stop A2A sends to an endpoint they set once they leave (step 12).
  return { kind: "agent", id: row.id, org: row.org_id, generation: row.generation, linker: { person: row.linker_id, since: row.linked_at } };
}

export async function callApi(env: Pick<Env, "API" | "ASSERTION_SIGNING_JWK">, identity: Identity, call: ApiCall, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const headers: Record<string, string> = { "x-podster-assertion": await mintAssertion(identity, env.ASSERTION_SIGNING_JWK), "content-type": "application/json" };
  if (call.idempotencyKey) headers["idempotency-key"] = call.idempotencyKey;
  try {
    return await env.API.fetch(new Request(`https://api.internal${call.path}`, { method: call.method, headers, body: call.body, signal: AbortSignal.timeout(timeoutMs) }));
  } catch (error) {
    // A panic in the API hangs its request, so callers get a clear answer instead of hanging too.
    return denied("upstream_unavailable", (error as Error)?.name === "TimeoutError" ? 504 : 502);
  }
}

async function runCapability(env: Env, identity: Identity, capability: Capability, args: Record<string, unknown>) {
  const response = await callApi(env, identity, toApiCall(capability, args));
  return { status: response.status, body: (await response.json()) as any };
}

/**
 * The plugin's default replay guard doesn't span requests here, so the agent's Principal spends each token, in the same
 * call that checks its connection. The token is only named here. Without an ID it can't be tracked, so it's refused.
 */
export function spentToken(pluginAgent: string, authorization: string | null | undefined) {
  const { jti, iat } = decodeJwt(authorization?.replace(/^Bearer\s+/i, "") ?? "");
  if (!jti) return null;
  // The plugin accepts a token for its maximum age from when it was issued, whatever `exp` the client wrote, so the
  // record lasts that long plus clock tolerance. A far-off `exp` can't grow the record, and a missing one can't shorten it.
  const now = Math.floor(Date.now() / 1000);
  return { key: `${pluginAgent}:${jti}`, expiresAt: Math.min(iat ?? now, now) + AGENT_JWT_MAX_AGE_SECONDS + 30 };
}

/** `testPeople` is only for the test sign-up, once it has checked everything. Requests never get this instance. */
export function createAuth(env: Env, { testPeople = false } = {}) {
  // Better Auth falls back to a public default outside production, and Workers don't set NODE_ENV.
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set");
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  return betterAuth({
    database: env.DB,
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    emailAndPassword: { enabled: testPeople || passwordSignInEnabled(env) },
    ...(testPeople ? { session: { expiresIn: TEST_SESSION_SECONDS } } : {}),
    // Never join accounts on a matching email: an address can move to someone else, or be verified somewhere it shouldn't.
    account: { accountLinking: { disableImplicitLinking: true } },
    // A failed sign-in comes back to our page, which only offers another try, instead of a page with no way back.
    onAPIError: { errorURL: "/sign-in" },
    // The schema check would run on every request, because an instance lasts one request. A test checks for drift instead.
    advanced: { database: { validateSchema: false, ...(testPeople ? { generateId: ({ model }: { model: string }) => `${model === "user" ? TEST_ID_PREFIX : ""}${crypto.randomUUID().replaceAll("-", "")}` } : {}) } },
    socialProviders: social,
    databaseHooks: {
      session: {
        create: {
          // Checked here as well as before sending, because someone can sign up with GitHub while a link is on its way.
          // A link never signs in to a person who has another way in: see docs/adr/0004-email-sign-in.md.
          before: async (session, ctx) => (ctx?.path === EMAIL_VERIFY_ROUTE && (await linkMustNotReach(env, "u.id", session.userId)) ? false : undefined),
        },
        update: {
          // Refreshing moves a session's expiry a full term out, and any route that reads a session can do it. A test
          // session keeps the end it started with, on every instance, so a killed run's session really does end.
          before: async (_session, ctx) => {
            const current = ctx?.context.session as { session: { expiresAt: Date }; user: { id: string } } | null | undefined;
            return current?.user.id.startsWith(TEST_ID_PREFIX) ? { data: { expiresAt: current.session.expiresAt } } : undefined;
          },
        },
      },
      user: {
        create: {
          // An unverified email could claim someone else's address and lock out its real owner.
          // The reserved test domain means a test person, so nobody else gets an address on it.
          before: async (user) => ((isTestEmail(user.email) ? testPeople : user.emailVerified || passwordSignInEnabled(env)) ? undefined : false),
          // Everyone starts with a personal organization, so individuals aren't a second ownership model. If this write
          // fails, the person's next request restores it, so a failure here doesn't fail the sign-up.
          after: async (user) => ensurePersonalOrg(env, personId(user.id)),
        },
      },
    },
    plugins: [
      // Always loaded, because no route reaches it until appHandler's checks pass.
      magicLink({ expiresIn: EMAIL_LINK_SECONDS, storeToken: { type: "custom-hasher", hash: linkTokenHash }, sendMagicLink: ({ email, url, token }) => sendSignInLink(env, email, token, new URL(url).searchParams.get("callbackURL")) as Promise<void> }),
      agentAuth({
        providerName: "podster",
        providerDescription: "Podster coordinates work between independently run agents.",
        // Claiming an autonomous agent ends it, so agents wait in delegated mode until a person approves them.
        modes: ["delegated"],
        approvalMethods: ["device_authorization"],
        allowDynamicHostRegistration: true,
        deviceAuthorizationPage: "/claim",
        jwtMaxAge: AGENT_JWT_MAX_AGE_SECONDS,
        // Long-running agents shouldn't expire or lose their grants when idle. Disconnecting is how access ends.
        agentSessionTTL: 0,
        agentMaxLifetime: 0,
        absoluteLifetime: 0,
        // Claiming is an explicit action on a signed-in session, so an older session is fine.
        freshSessionWindow: 0,
        capabilities: CAPABILITIES.map((c) => ({ name: c.name, description: c.description, input: jsonSchema(c) as any, approvalStrength: "session" as const })),
        onExecute: async ({ ctx, capability, arguments: args, agentSession }) => {
          const definition = CAPABILITIES.find((c) => c.name === capability);
          if (!definition) throw new APIError("BAD_REQUEST", { message: "unknown_capability" });
          // A download reaches here only once the plugin has checked the agent's get_asset_link grant, as for any call of it.
          const download = ctx.request ? DOWNLOADS.get(ctx.request) : undefined;
          if (download && capability === DOWNLOAD_CAPABILITY) {
            download.response = await download.serve(agentSession.agent.id, ctx.headers?.get("authorization"));
            return {};
          }
          // Before the token is spent, so an agent that was limited can retry with the same one.
          if (!(await withinLimit(env.RL_ACCOUNT, `agent:${agentSession.agent.id}`))) throw new APIError("TOO_MANY_REQUESTS", { error: "rate_limited", message: "rate_limited" }, { "retry-after": RETRY_AFTER_SECONDS });
          const spends = spentToken(agentSession.agent.id, ctx.headers?.get("authorization"));
          if (!spends) throw new APIError("UNAUTHORIZED", { message: "jwt_replay" });
          let identity: Identity;
          try {
            identity = { ...(await resolveAgent(env, "agent_auth", agentSession.agent.id)), spends } as Identity;
          } catch (error) {
            if (error instanceof AgentRefused) throw new APIError("FORBIDDEN", { message: error.message });
            throw error;
          }
          try {
            const { status, body } = await runCapability(env, identity, definition, args ?? {});
            if (status >= 400) throw new APIError(ERROR_NAMES[status] ?? "INTERNAL_SERVER_ERROR", { message: body?.error?.code ?? "error", code: body?.error?.code });
            return body;
          } catch (error) {
            if (error instanceof InvalidArguments) throw new APIError("BAD_REQUEST", { message: "invalid_argument" });
            throw error;
          }
        },
      }),
    ],
  });
}

type Memberships = { orgs: string[]; adminOrgs: string[]; defaultOrg: string | null; orgSince: Record<string, number> };

/**
 * Writes the person's personal organization and their admin membership if either is missing. It's safe to repeat, and
 * concurrent calls leave one organization, because of the unique index in migration 0003. A failure is only logged: the
 * person has no organization to act in, and their next request tries again.
 */
async function ensurePersonalOrg(env: Env, person: string) {
  const now = Date.now();
  // The membership is only ever written with a new organization, so nothing here re-adds someone to an existing one.
  const org = newId("org");
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO organization (id, name, personal, created_by, created_at) SELECT ?, COALESCE(NULLIF(name, ''), 'Personal'), 1, ?, ? FROM "user" WHERE id = ?`).bind(org, person, now, person.slice("per_".length)),
      env.DB.prepare(`INSERT OR IGNORE INTO org_member (org_id, person_id, role, created_at) SELECT id, ?, 'admin', ? FROM organization WHERE id = ? AND created_by = ?`).bind(person, now, org, person),
    ]);
  } catch (error) {
    // The driver's message names the SQL and the failure, and bound values, such as the person's name, aren't in it.
    console.error("personal organization not written", person, (error as Error)?.message);
  }
}

const membershipRows = async (env: Env, person: string) =>
  (await env.DB.prepare(`SELECT m.org_id, m.role, m.created_at, o.personal, o.created_by FROM org_member m JOIN organization o ON o.id = m.org_id WHERE m.person_id = ? ORDER BY m.created_at, o.personal DESC`).bind(person).all<{ org_id: string; role: string; created_at: number; personal: number; created_by: string }>()).results;

/**
 * The person's organizations, restoring their personal one first if a failed sign-up left it unwritten. The default is
 * the one they've belonged to longest, which is normally the personal one. That way a late repair can't move someone's
 * requests out of a team organization and into a personal one, which has no recovery.
 */
async function memberships(env: Env, person: string): Promise<Memberships> {
  let results = await membershipRows(env, person);
  // Their own, because belonging to someone else's personal organization isn't having one.
  if (!results.some((r) => r.personal && r.created_by === person)) {
    await ensurePersonalOrg(env, person);
    results = await membershipRows(env, person);
  }
  return {
    orgs: results.map((r) => r.org_id),
    adminOrgs: results.filter((r) => r.role === "admin").map((r) => r.org_id),
    defaultOrg: results[0]?.org_id ?? null,
    orgSince: Object.fromEntries(results.map((r) => [r.org_id, r.created_at])),
  };
}

/** A signed-in person, acting in the organization they choose among their own. */
async function personIdentity(env: Env, request: Request, userId: string): Promise<Identity | null> {
  const person = personId(userId);
  const { orgs, adminOrgs, defaultOrg, orgSince } = await memberships(env, person);
  const org = request.headers.get("x-podster-org") ?? defaultOrg;
  if (!org || !orgs.includes(org)) return null;
  return { kind: "person", id: person, org, orgs, adminOrgs, orgSince };
}

/**
 * A request for the application host is for a person there, so sign-in, its cookies and the origin check all use that
 * host. This assumes only the web Worker can send one, because public traffic for that hostname is routed to it. ADR 0001
 * lists that as something to probe on staging.
 */
const forPublicHost = (request: Request, env: Env): Env => (env.APP_URL && new URL(request.url).origin === new URL(env.APP_URL).origin ? { ...env, BASE_URL: env.APP_URL } : env);

/** Session requests that change something must come from our own origin. */
export const sameOrigin = (request: Request, env: Env) => request.headers.get("origin") === new URL(env.BASE_URL).origin;

/** Dashboard routes people may reach through the session. Agent registration and connection have their own handlers. */
export function allowedPassthrough(path: string) {
  // Something between here and the API may collapse a double slash, which would slip past the prefix checks below.
  if (!path.startsWith("/v1/") || path.includes("//")) return false;
  // An upload's bytes have their own path, and this one would read them all into memory.
  return !path.startsWith("/v1/agents") && !path.startsWith("/v1/inbox") && !path.startsWith("/v1/org-departures") && !path.startsWith("/v1/uploads") && !path.startsWith("/v1/files");
}

/**
 * A person's own inbox and read-only oversight of an agent's. An `ack` on a read would let a link move the cursor, because
 * reads skip the origin check, so acknowledging is only the POST.
 */
function allowedInbox(method: string, path: string, search: URLSearchParams) {
  if (method === "POST") return path === "/v1/inbox/ack";
  if (method !== "GET" || search.has("ack")) return false;
  return path === "/v1/inbox" || /^\/v1\/agents\/[\w-]+\/(inbox|rooms)$/.test(path);
}

/**
 * The API can't see the directory, so when a room adds a person or names an owner, the assertion states what the directory says about them.
 * It's a fact from our own rows, present only if true. The API decides what follows from it.
 */
async function withTargetMember(env: Env, identity: Identity, method: string, path: string, body: string | undefined): Promise<Identity> {
  if (identity.kind !== "person" || method !== "POST") return identity;
  const person = /^\/v1\/workspaces\/[^/]+\/members$/.test(path)
    ? addedPerson(body)
    : /^\/v1\/workspaces\/[^/]+\/owner\/(transfer|recover)$/.test(path)
      ? namedOwner(body)
      : path.match(/^\/v1\/workspaces\/[^/]+\/members\/(per_[\w-]+)\/role$/)?.[1];
  if (!person) return identity;
  const { results } = await env.DB.prepare(`SELECT org_id, created_at FROM org_member WHERE person_id = ?`).bind(person).all<{ org_id: string; created_at: number }>();
  return results.length ? { ...identity, targetMember: { person, orgs: Object.fromEntries(results.map((r) => [r.org_id, r.created_at])) } } : identity;
}

function addedPerson(body: string | undefined) {
  try {
    const target = JSON.parse(body ?? "") as { kind?: unknown; principal_id?: unknown };
    return target?.kind === "person" && typeof target.principal_id === "string" ? target.principal_id : undefined;
  } catch {
    return undefined;
  }
}

function namedOwner(body: string | undefined) {
  try {
    const target = JSON.parse(body ?? "") as { to?: unknown };
    return typeof target?.to === "string" ? target.to : undefined;
  } catch {
    return undefined;
  }
}

const MAX_LISTED_AGENTS = 500;

/**
 * Agents the person's organizations own. The directory is the gateway's own, and this reads only their memberships.
 * `credentials_owner_left` counts credentials that stopped working because whoever connected them left.
 */
async function listAgents(env: Env, orgs: string[]): Promise<Response> {
  const placeholders = orgs.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT a.id, a.org_id, a.name, a.description, a.created_at, a.revoked_at, (SELECT COUNT(*) FROM identity_link l WHERE l.agent_id = a.id AND NOT EXISTS (SELECT 1 FROM org_member m WHERE m.org_id = a.org_id AND m.person_id = l.person_id AND m.created_at <= l.created_at)) AS credentials_owner_left FROM podster_agent a WHERE a.org_id IN (${placeholders}) ORDER BY a.created_at DESC LIMIT ?`).bind(...orgs, MAX_LISTED_AGENTS + 1).all();
  // Newest first. There's no paging yet, so a longer list says it was cut.
  return json({ agents: results.slice(0, MAX_LISTED_AGENTS), truncated: results.length > MAX_LISTED_AGENTS });
}

async function registerWithApi(env: Env, identity: Identity, agentId: string, org: string, name: string) {
  const response = await callApi(env, identity, { method: "PUT", path: `/v1/agents/${agentId}`, body: JSON.stringify({ org_id: org, name }) });
  await response.text();
  return response.status;
}

type LinkProvider = "agent_auth" | "mcp_oauth";

const linkStatement = (env: Env, provider: LinkProvider, externalId: string, agentId: string, person: string, now: number) =>
  env.DB.prepare(`INSERT INTO identity_link (provider, external_id, agent_id, person_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(provider, externalId, agentId, person, now);

async function createAgent(env: Env, org: string, name: string, provider: LinkProvider, externalId: string, agentId: string, person: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO podster_agent (id, org_id, name, created_at) VALUES (?, ?, ?, ?)`).bind(agentId, org, name, now),
    linkStatement(env, provider, externalId, agentId, person, now),
  ]);
}

/**
 * An MCP consent reuses one credential per person, client and organization. If that credential is from an earlier
 * membership it stopped working, and a current admin consenting again is what starts it. Only a link older than the
 * membership changes, and the organization's audit log records it. An Agent Auth key can't be claimed twice, so its
 * way back is a new key linked to the agent.
 */
async function renewLink(env: Env, externalId: string, person: string, org: string) {
  const now = Date.now();
  const stale = `l.provider = 'mcp_oauth' AND l.external_id = ? AND l.person_id = ? AND l.created_at < (SELECT m.created_at FROM org_member m WHERE m.org_id = ? AND m.person_id = l.person_id)`;
  const binds = [externalId, person, org];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, role, created_at) SELECT ?, ?, ?, 'credential.reconnected', l.agent_id, NULL, ? FROM identity_link l WHERE ${stale}`).bind(newId("oau"), org, person, now, ...binds),
    env.DB.prepare(`UPDATE identity_link AS l SET created_at = MAX(?, (SELECT m.created_at FROM org_member m WHERE m.org_id = ? AND m.person_id = l.person_id)) WHERE ${stale}`).bind(now, org, ...binds),
  ]);
}

/** An existing, connected agent in this organization, which a new credential may link to. */
async function linkableAgent(env: Env, id: string, org: string) {
  const row = await env.DB.prepare(`SELECT org_id FROM podster_agent WHERE id = ? AND revoked_at IS NULL`).bind(id).first<{ org_id: string }>();
  return row?.org_id === org;
}

export const sha256Hex = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

/** The API's answer when registering an agent, as this gateway's refusal. It refuses an agent already in another organization. */
const registrationRefused = (status: number) => (status === 403 || status === 404 || status === 409 ? denied("not_allowed", 403) : denied("upstream_unavailable", 502));

/**
 * A credential's OAuth grants, so one credential can be replaced or ended without touching this person's others. With
 * `kind`, only its grants for that resource, so consenting to `/a2a` doesn't end the same client's `/mcp` grant. A grant
 * with no stored resource is the legacy `/mcp` one.
 */
async function grantIds(env: Env, person: string, externalId: string, only?: { kind: "mcp" | "a2a"; gatewayUrl: string }) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(person, { cursor });
    for (const grant of page.items) {
      if ((grant.metadata as { externalId?: string } | undefined)?.externalId !== externalId) continue;
      // Resources are always the gateway's own URLs, even when the person is on the application host.
      if (only && resourceKind(only.gatewayUrl, grant.resource) !== only.kind) continue;
      ids.push(grant.id);
    }
    cursor = page.cursor;
  } while (cursor);
  return ids;
}

type ConsentChoices = { clientName: string; redirectHosts: string[]; query: string; protocol: "mcp" | "a2a"; orgs: { id: string; name: string }[]; agents: { id: string; org_id: string; name: string }[] };

/** Our pages run no script and load nothing. Every value in `body` must already be escaped. */
function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body>
<h1>${escapeHtml(title)}</h1>
${body}
</body></html>`;
  // No form-action: Chromium applies it to the redirect after a form, which would block the return to a client or provider.
  // Referrer policy same-origin: under no-referrer, Chromium sends `Origin: null` on a form's POST, which we refuse.
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`, "x-frame-options": "DENY", "referrer-policy": "same-origin" },
  });
}

/**
 * Where sign-in may return to. Only our own pages that need a session, so a link can't use sign-in to send someone
 * elsewhere. Anything else falls back to a plain confirmation.
 */
const MAX_NEXT_LENGTH = 8 * 1024;

export function safeNext(value: string | null | undefined) {
  const fallback = "/signed-in";
  // It's stored with extra encoding during sign-in, so a long one costs far more than its size.
  if (!value || value.length > MAX_NEXT_LENGTH || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, "https://gateway.invalid");
    if (url.origin !== "https://gateway.invalid") return fallback;
    return url.pathname === "/authorize" || url.pathname === "/claim" ? url.pathname + url.search : fallback;
  } catch {
    return fallback;
  }
}

const signInRedirect = (request: Request) => {
  const url = new URL(request.url);
  return new Response(null, { status: 302, headers: { location: `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}` } });
};

const SIGN_IN_PROVIDERS = { github: "GitHub", google: "Google" } as const;
type SignInProvider = keyof typeof SIGN_IN_PROVIDERS;

const configuredProviders = (env: Env): SignInProvider[] =>
  [env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? ("github" as const) : null, env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? ("google" as const) : null].filter((p) => p !== null);

function signInPage(env: Env, next: string, failed: boolean) {
  const providers = configuredProviders(env);
  // Fixed text, so a link can't put its own words on our page.
  const notice = failed ? "<p>That sign-in didn't finish. Please try again, using the account you first signed in with, which needs a verified email.</p>" : "";
  const buttons = providers.map((provider) => `<form method="post" action="/sign-in"><input type="hidden" name="provider" value="${provider}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Continue with ${SIGN_IN_PROVIDERS[provider]}</button></form>`).join("");
  return page("Sign in to Podster", notice + (buttons || "<p>Sign-in isn't set up here yet.</p>"), providers.length ? 200 : 503);
}

/** Starts a provider's sign-in as a form POST, so it needs no script on our page. */
async function handleSignIn(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const form = await request.formData().catch(() => null);
  if (!form) return denied("invalid_argument", 400);
  const provider = String(form.get("provider") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  if (!(configuredProviders(env) as string[]).includes(provider)) return denied("invalid_argument", 400);
  const started = await createAuth(env).api.signInSocial({ headers: request.headers, body: { provider, callbackURL: new URL(next, env.BASE_URL).toString(), errorCallbackURL: new URL(`/sign-in?next=${encodeURIComponent(next)}`, env.BASE_URL).toString() }, asResponse: true });
  const body = await started.json<{ url?: string }>().catch(() => null);
  if (!started.ok || !body?.url) return denied("sign_in_unavailable", 502);
  const headers = new Headers({ location: body.url });
  for (const cookie of started.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** The organizations a person can act for, and their agents an approval can connect to. */
async function approverChoices(env: Env, adminOrgs: string[]) {
  const placeholders = adminOrgs.map(() => "?").join(",");
  const orgs = await env.DB.prepare(`SELECT id, name FROM organization WHERE id IN (${placeholders})`).bind(...adminOrgs).all<{ id: string; name: string }>();
  const agents = await env.DB.prepare(`SELECT id, org_id, name FROM podster_agent WHERE revoked_at IS NULL AND org_id IN (${placeholders})`).bind(...adminOrgs).all<{ id: string; org_id: string; name: string }>();
  return { orgs: orgs.results, agents: agents.results };
}

/** What an agent's approval link may show. It reveals nothing about the agent unless the code is right. */
async function claimChoices(env: Env, url: URL, userId: string) {
  const agentId = url.searchParams.get("agent_id") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const { adminOrgs } = await memberships(env, personId(userId));
  if (adminOrgs.length === 0) return "not_admin" as const;
  const choices = await approverChoices(env, adminOrgs);
  // Nothing from the link appears until its code proves a real request, so a link can't put its own words on our page.
  if (agentId === "" || !(await codeMatchesLiveApproval(env, agentId, code))) return "invalid_link" as const;
  const registered = await env.DB.prepare(`SELECT name FROM agent WHERE id = ?`).bind(agentId).first<{ name: string | null }>();
  return { agent_id: agentId, agent_name: registered?.name ?? null, code, ...choices };
}

async function claimPage(request: Request, env: Env, userId: string) {
  const choices = await claimChoices(env, new URL(request.url), userId);
  if (choices === "not_admin") return page("Connect an agent", "<p>You need to be an admin of an organization to connect an agent.</p>", 403);
  if (choices === "invalid_link") return page("Connect an agent", "<p>This link isn't valid or has expired. Ask the agent for a new one.</p>", 404);
  const orgName = (id: string) => choices.orgs.find((o) => o.id === id)?.name ?? id;
  const who = choices.agent_name ? `An agent calling itself <strong>${escapeHtml(choices.agent_name)}</strong>` : "An agent";
  return page("Connect an agent", `<p>${who} is asking to join your organization. Podster hasn't verified this name.</p>
<p>Only continue if you started this, and your agent showed you this code: <strong>${escapeHtml(choices.code)}</strong></p>
<p>Connecting doesn't run or wake the agent, and workroom access is set separately.</p>
<form method="post" action="/claim">
<input type="hidden" name="agent_id" value="${escapeHtml(choices.agent_id)}">
<input type="hidden" name="user_code" value="${escapeHtml(choices.code)}">
<label>Organization <select name="org_id" required>${choices.orgs.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("")}</select></label>
<label>Connect as <select name="link_agent_id"><option value="">A new agent</option>${choices.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(`${a.name} (${orgName(a.org_id)})`)}</option>`).join("")}</select></label>
<label>Name for a new agent <input name="name" maxlength="${MAX_NAME_BYTES}"></label>
<button type="submit">Connect</button>
</form>`);
}

function consentPage(choices: ConsentChoices) {
  const orgOptions = choices.orgs.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("");
  const orgName = (id: string) => choices.orgs.find((o) => o.id === id)?.name ?? id;
  const agentOptions = choices.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(`${a.name} (${orgName(a.org_id)})`)}</option>`).join("");
  const hosts = choices.redirectHosts.map(escapeHtml).join(", ");
  return page("Connect an agent to Podster", `<p>An app calling itself <strong>${escapeHtml(choices.clientName)}</strong> wants to act as an agent in your organization. Podster hasn't verified this name.</p>
<p>After you approve, it receives access at <strong>${hosts}</strong>. Only continue if you started this and trust that site.</p>
<p>${choices.protocol === "a2a" ? "It will act as the agent over A2A, through Podster's A2A interface," : "It can use the agent's tools"} in any workroom that agent has joined. Connecting doesn't create, run or wake an agent, and workroom access is set separately.</p>
<form method="post" action="/authorize">
<input type="hidden" name="oauth_query" value="${escapeHtml(choices.query)}">
<label>Organization <select name="org_id" required>${orgOptions}</select></label>
<label>Connect as <select name="link_agent_id"><option value="">A new agent, or its existing one</option>${agentOptions}</select></label>
<label>Name for a new agent <input name="agent_name" maxlength="${MAX_NAME_BYTES}"></label>
<p>If this app is already connected to the organization, it keeps its agent and name.</p>
<button type="submit">Connect</button>
</form>`);
}

/**
 * A client's address is somewhere else by definition. On one of our hosts, the consent page would navigate to any of our
 * routes from our own origin, even on Decline, and an authorization code would land on our own page.
 */
function namesOurHost(env: Env, redirectUri: unknown, ...others: string[]) {
  if (typeof redirectUri !== "string") return false;
  const hostOf = (value: string) => new URL(value).hostname.replace(/\.+$/, "");
  try {
    return [env.BASE_URL, env.APP_URL, ...others].some((ours) => ours && hostOf(ours) === hostOf(redirectUri));
  } catch {
    // What this can't read, it can't say is somewhere else.
    return true;
  }
}

/** The provider has no check for this, and handles registration before our routes, so it's asked here first. */
async function registersOurHost(request: Request, env: Env) {
  const body = await request.clone().json<{ redirect_uris?: unknown }>().catch(() => null);
  return Array.isArray(body?.redirect_uris) && body.redirect_uris.some((uri) => namesOurHost(env, uri));
}

async function parseOAuth(env: Env, request: Request) {
  try {
    const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    // `request` is for the gateway's host even when `env` is the application host's, so this covers both.
    if (namesOurHost(env, parsed.redirectUri, request.url)) return null;
    // Each resource grants only its own scope. MCP clients often send no scope, and refresh tokens are issued anyway, so
    // both of those mean plain access to the resource asked for. A request naming no resource is for `/mcp`.
    // The resource is the gateway's, whichever host the person is on, and `request` is always for the gateway's host.
    const kind = resourceKind(new URL(request.url).origin, parsed.resource);
    if (!kind) return null;
    if (parsed.scope.some((scope) => scope !== kind && scope !== "offline_access")) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Always parsed as a request to the gateway's own host, whichever host the person is on: the provider takes the `iss` it
 * sends the client from this URL, and the client checks that against the issuer it discovered.
 */
const parseOAuthQuery = (env: Env, gatewayUrl: string, query: string) => parseOAuth(env, new Request(`${gatewayUrl}/authorize${query}`));

async function consentChoices(env: Env, gatewayUrl: string, person: string, query: string): Promise<ConsentChoices | Response> {
  const { adminOrgs } = await memberships(env, person);
  const parsed = await parseOAuthQuery(env, gatewayUrl, query);
  if (!parsed) return denied("invalid_request", 400);
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return denied("invalid_client", 400);
  if (adminOrgs.length === 0) return denied("not_allowed", 403);
  const protocol = resourceKind(gatewayUrl, parsed.resource) ?? "mcp";
  return { clientName: client.clientName ?? parsed.clientId, redirectHosts: [new URL(parsed.redirectUri).host], query, protocol, ...(await approverChoices(env, adminOrgs)) };
}

type ConsentFields = { query: string; org: string; linkAgent: string; name: string };

/** Connects the client as an agent. The answer goes back to the client, so a caller only ever passes it on. */
async function approveConsent(request: Request, env: Env, gatewayUrl: string, userId: string, fields: ConsentFields): Promise<{ redirectTo: string } | Response> {
  const person = personId(userId);
  const { adminOrgs } = await memberships(env, person);
  const { org, linkAgent, query } = fields;
  if (!adminOrgs.includes(org)) return denied("not_allowed", 403);
  const parsed = await parseOAuthQuery(env, gatewayUrl, query);
  if (!parsed) return denied("invalid_request", 400);
  const kind = resourceKind(gatewayUrl, parsed.resource) ?? "mcp";
  const name = fields.name.trim() || (kind === "a2a" ? "A2A agent" : "MCP agent");
  if (!validName(name)) return denied("invalid_argument", 400);

  const identity = await personIdentity(env, new Request(request.url, { headers: { "x-podster-org": org } }), userId);
  if (!identity) return denied("not_allowed", 403);
  // One person, client and organization is one credential, so a repeat consent or double submit keeps the same agent.
  const externalId = `grant_${await sha256Hex(`${person}|${parsed.clientId}|${org}`)}`;
  const existing = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'mcp_oauth' AND external_id = ?`).bind(externalId).first<{ agent_id: string }>();
  if (!existing) {
    if (linkAgent) {
      if (!(await linkableAgent(env, linkAgent, org))) return denied("not_allowed", 403);
      await linkStatement(env, "mcp_oauth", externalId, linkAgent, person, Date.now()).run();
    } else {
      const agentId = newId("agt");
      const status = await registerWithApi(env, identity, agentId, org, name);
      if (status !== 200) return registrationRefused(status);
      await createAgent(env, org, name, "mcp_oauth", externalId, agentId, person);
    }
  } else if (linkAgent && linkAgent !== existing.agent_id) {
    return denied("already_linked", 409);
  }
  await renewLink(env, externalId, person, org);
  // The provider's own cleanup covers every grant for this person and client, which would end this client's agents in
  // other organizations. Only the grant being replaced goes.
  const replaced = await grantIds(env, person, externalId, { kind, gatewayUrl });
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: parsed, userId: person, metadata: { org, externalId }, scope: [kind], props: { externalId }, revokeExistingGrants: false });
  for (const id of replaced) await env.OAUTH_PROVIDER.revokeGrant(id, person);
  return { redirectTo };
}

async function handleAuthorize(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method === "GET") {
    const choices = await consentChoices(env, env.BASE_URL, personId(userId), new URL(request.url).search);
    return choices instanceof Response ? choices : consentPage(choices);
  }

  // Approving is a POST from our own page, so a link can't connect an agent on someone's behalf.
  if (request.method !== "POST" || !sameOrigin(request, env)) return denied("not_allowed", 403);
  const form = await request.formData().catch(() => null);
  if (!form) return denied("invalid_argument", 400);
  const answer = await approveConsent(request, env, env.BASE_URL, userId, { query: String(form.get("oauth_query") ?? ""), org: String(form.get("org_id") ?? ""), linkAgent: String(form.get("link_agent_id") ?? ""), name: String(form.get("agent_name") ?? "") });
  return answer instanceof Response ? answer : Response.redirect(answer.redirectTo, 302);
}

/**
 * The application host's read and decision for consent, reached only over the service binding. A decision answers with
 * where to send the browser, because a page's fetch can't follow a redirect to another host. A query is only ever a
 * query: it's joined to our own URL as text.
 */
async function handleConsentApi(request: Request, env: Env, gatewayUrl: string, userId: string): Promise<Response> {
  if (request.method === "GET") {
    const choices = await consentChoices(env, gatewayUrl, personId(userId), new URL(request.url).search);
    if (choices instanceof Response) return choices;
    return json({ client_name: choices.clientName, redirect_hosts: choices.redirectHosts, oauth_query: choices.query, protocol: choices.protocol, orgs: choices.orgs, agents: choices.agents });
  }
  if (request.method !== "POST") return denied("not_found", 404);
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  if (!(await withinLimit(env.RL_SENSITIVE, `consent:${userId}`))) return rateLimited();
  const body = await request.json<{ decision?: unknown; oauth_query?: unknown; org_id?: unknown; link_agent_id?: unknown; agent_name?: unknown }>().catch(() => null);
  if (typeof body?.oauth_query !== "string" || !body.oauth_query.startsWith("?")) return denied("invalid_argument", 400);
  if (body.decision === "decline") {
    const parsed = await parseOAuthQuery(env, gatewayUrl, body.oauth_query);
    return parsed ? json({ redirect_to: authorizationErrorRedirect(parsed, "access_denied") }) : denied("invalid_request", 400);
  }
  // There's no default: only an explicit approval connects anything.
  if (body.decision !== "approve" || typeof body.org_id !== "string") return denied("invalid_argument", 400);
  const answer = await approveConsent(request, env, gatewayUrl, userId, { query: body.oauth_query, org: body.org_id, linkAgent: typeof body.link_agent_id === "string" ? body.link_agent_id : "", name: typeof body.agent_name === "string" ? body.agent_name : "" });
  return answer instanceof Response ? answer : json({ redirect_to: answer.redirectTo });
}

/** The same for an agent's approval link. The code is checked on the read, so guessing through it counts as posting. */
async function handleClaimApi(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return denied("not_found", 404);
  if (request.method === "POST" && !sameOrigin(request, env)) return denied("not_allowed", 403);
  if (!(await withinLimit(env.RL_SENSITIVE, `claim:${userId}`))) return rateLimited();
  if (request.method === "POST") return claim(request, env, userId, await request.json<ClaimBody>().catch(() => null));
  const choices = await claimChoices(env, new URL(request.url), userId);
  if (choices === "not_admin") return denied("not_allowed", 403);
  if (choices === "invalid_link") return denied("not_found", 404);
  return json(choices);
}

/**
 * With an application host, a person's pages live there and this host keeps only agents' routes. A form POST to
 * `/authorize` or `/claim` stays, with this host's origin check: nothing here can start a browser's session, and the
 * journey on a deployment uses them with a session cookie it was given.
 */
async function movedToApplicationHost(request: Request, env: Env, appUrl: string): Promise<Response | null> {
  const url = new URL(request.url);
  const app = new URL(appUrl).origin;
  const to = (path: string, status = 302) => new Response(null, { status, headers: { location: app + path } });
  if (url.pathname === "/authorize" && request.method === "GET") {
    // Only a request that could really finish gets sent on, so a link can't use this host to reach the app with junk.
    return (await parseOAuth(env, request)) ? to(`/oauth/consent${url.search}`) : denied("invalid_request", 400);
  }
  if (url.pathname === "/claim" && request.method === "GET") return to(`/claim${url.search}`);
  if (url.pathname === "/sign-in" && request.method === "POST") return to("/sign-in", 303);
  if (url.pathname === "/sign-in" && request.method === "GET") {
    const next = new URL(safeNext(url.searchParams.get("next")), url.origin);
    const page = next.pathname === "/authorize" ? "/oauth/consent" : next.pathname === "/claim" ? "/claim" : null;
    const query = new URLSearchParams();
    if (page) query.set("next", page + next.search);
    if (url.searchParams.has("error")) query.set("error", "1");
    return to(`/sign-in${query.size ? `?${query}` : ""}`);
  }
  return null;
}

/** Writes a claim's link. If the write fails because a double submit got there first, the same link counts as success. */
export async function linkOnce(env: Env, pluginAgent: string, agentId: string, write: () => Promise<unknown>) {
  try {
    await write();
    return true;
  } catch (error) {
    const row = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?`).bind(pluginAgent).first<{ agent_id: string }>();
    if (!row) throw error;
    return row.agent_id === agentId;
  }
}

/** A person may only finish a claim they started, so a failure partway can be retried. */
async function claimedByThisPerson(env: Env, pluginAgent: string, userId: string) {
  const row = await env.DB.prepare(`SELECT status, userId FROM agent WHERE id = ?`).bind(pluginAgent).first<{ status: string; userId: string | null }>();
  return row?.status === "active" && row.userId === userId;
}

/**
 * Takes the agent's host for this person, unless someone else already holds it. If the plugin saw a different owner
 * when activating the agent, it would revoke that person's agents on the host, so this has to be one atomic write.
 */
export async function claimHost(env: Pick<Env, "DB">, pluginAgent: string, userId: string) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE agentHost SET userId = ?, status = 'active', activatedAt = COALESCE(activatedAt, ?), updatedAt = ? WHERE id = (SELECT hostId FROM agent WHERE id = ?) AND status IN ('pending', 'active') AND (userId IS NULL OR userId = ?)`,
  ).bind(userId, now, now, pluginAgent, userId).run();
  return result.meta.changes === 1;
}

/** The plugin's hash of a code, including how it normalizes one. */
async function userCodeHash(code: string) {
  const stripped = code.replaceAll(/[^A-Z0-9]/gi, "").toUpperCase();
  const normalized = stripped.length === 8 ? `${stripped.slice(0, 4)}-${stripped.slice(4)}` : code.toUpperCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Whether this code matches a live approval for this agent. The gateway decides, because the plugin doesn't check a
 * code when no approval is pending, which includes the moment after someone else's approval resolved it. The plugin
 * also refuses every code while an expired one is pending, which would strand an agent that registered again, so
 * expired rows go once a live code has matched.
 */
export async function codeMatchesLiveApproval(env: Env, pluginAgent: string, code: string) {
  const { results } = await env.DB.prepare(`SELECT id, expiresAt, userCodeHash FROM approvalRequest WHERE agentId = ? AND status = 'pending'`).bind(pluginAgent).all<{ id: string; expiresAt: string | number; userCodeHash: string | null }>();
  const now = Date.now();
  const hash = await userCodeHash(code);
  const live = results.filter((row) => new Date(row.expiresAt).getTime() >= now);
  if (!live.some((row) => row.userCodeHash === hash)) return false;
  for (const row of results) {
    if (!live.includes(row)) await env.DB.prepare(`DELETE FROM approvalRequest WHERE id = ?`).bind(row.id).run();
  }
  return true;
}

/** A form answers with a page, and anything else with JSON. */
async function handleClaim(request: Request, env: Env, userId: string): Promise<Response> {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const isForm = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
  const body = isForm ? Object.fromEntries(await request.formData()) : await request.json<ClaimBody>().catch(() => null);
  const answer = await claim(request, env, userId, body as ClaimBody | null);
  if (!isForm) return answer;
  const result = await answer.json<{ agent_id?: string; error?: { code?: string } }>();
  if (answer.ok) return page("Agent connected", `<p>Your agent is connected as <strong>${escapeHtml(result.agent_id ?? "")}</strong>. You can close this page.</p>`);
  if (answer.status >= 500) return page("Couldn't connect this agent", "<p>Something went wrong on our side. Reload this page to try again.</p>", answer.status);
  const reason = result.error?.code === "invalid_argument" ? "Check the name, which can be at most 200 bytes." : "The code may be wrong or expired, this agent may already be connected, or it may belong to another organization.";
  return page("Couldn't connect this agent", `<p>${reason}</p>`, answer.status);
}

type ClaimBody = { agent_id?: unknown; user_code?: unknown; org_id?: unknown; name?: unknown; link_agent_id?: unknown };

async function claim(request: Request, env: Env, userId: string, body: ClaimBody | null): Promise<Response> {
  if (!body || typeof body.agent_id !== "string" || typeof body.user_code !== "string" || typeof body.org_id !== "string") return denied("invalid_argument", 400);
  const pluginAgent = body.agent_id;
  const org = body.org_id;
  const person = personId(userId);
  const identity = await personIdentity(env, new Request(request.url, { headers: { "x-podster-org": org } }), userId);
  if (!identity || identity.kind !== "person" || !identity.adminOrgs.includes(org)) return denied("not_allowed", 403);
  const suppliedName = typeof body.name === "string" ? body.name.trim() : "";
  if (suppliedName && !validName(suppliedName)) return denied("invalid_argument", 400);
  const linked = typeof body.link_agent_id === "string" && body.link_agent_id ? body.link_agent_id : null;
  if (linked && !(await linkableAgent(env, linked, org))) return denied("not_allowed", 403);
  const alreadyLinked = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?`).bind(pluginAgent).first();
  if (alreadyLinked) return denied("not_allowed", 403);

  // Approve first, so nothing is created for a bad code. The agent ID comes from the plugin's, so a retry reuses it.
  if (!(await claimedByThisPerson(env, pluginAgent, userId))) {
    // The code comes first, so only someone holding one can learn that a host is taken.
    if (!(await codeMatchesLiveApproval(env, pluginAgent, body.user_code))) return denied("not_allowed", 403);
    if (!(await claimHost(env, pluginAgent, userId))) return denied("host_owned_by_another_person", 403);
    const approval = await createAuth(env).api.approveCapability({ headers: request.headers, body: { agent_id: pluginAgent, user_code: body.user_code, action: "approve" }, asResponse: true }).catch(() => null);
    const result = approval?.ok ? await approval.json<{ status?: string }>().catch(() => null) : null;
    // If two people raced with the right code, only the one the plugin recorded goes on.
    if (result?.status !== "approved" || !(await claimedByThisPerson(env, pluginAgent, userId))) return denied("not_allowed", 403);
  }
  const registered = await env.DB.prepare(`SELECT name FROM agent WHERE id = ?`).bind(pluginAgent).first<{ name: string | null }>();
  const name = suppliedName || fitName(registered?.name ?? "") || "agent";
  if (linked) {
    if (!(await linkOnce(env, pluginAgent, linked, () => linkStatement(env, "agent_auth", pluginAgent, linked, person, Date.now()).run()))) return denied("not_allowed", 403);
    return json({ agent_id: linked, org_id: org });
  }
  const agentId = `agt_${await sha256Hex(pluginAgent)}`;
  const status = await registerWithApi(env, identity, agentId, org, name);
  if (status !== 200) return registrationRefused(status);
  if (!(await linkOnce(env, pluginAgent, agentId, () => createAgent(env, org, name, "agent_auth", pluginAgent, agentId, person)))) return denied("not_allowed", 403);
  return json({ agent_id: agentId, org_id: org });
}

/**
 * Ends every credential for an agent, so reconnecting can't bring back a leaked one. Links go last, so a failure partway
 * can be run again. An Agent Auth key ends in the plugin too, or its owner could claim it again without a code.
 */
async function revokeCredentials(env: Env, agentId: string) {
  const { results } = await env.DB.prepare(`SELECT provider, external_id, person_id FROM identity_link WHERE agent_id = ?`).bind(agentId).all<{ provider: string; external_id: string; person_id: string }>();
  for (const link of results) {
    if (link.provider === "mcp_oauth") {
      for (const id of await grantIds(env, link.person_id, link.external_id)) await env.OAUTH_PROVIDER.revokeGrant(id, link.person_id);
    } else {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE agent SET status = 'revoked', publicKey = '', kid = NULL, updatedAt = ? WHERE id = ?`).bind(now, link.external_id),
        env.DB.prepare(`UPDATE agentCapabilityGrant SET status = 'revoked', updatedAt = ? WHERE agentId = ?`).bind(now, link.external_id),
      ]);
    }
  }
  await env.DB.prepare(`DELETE FROM identity_link WHERE agent_id = ?`).bind(agentId).run();
}

/** Disconnect and reconnect. The API decides; the directory follows so new assertions carry the right generation. */
export async function handleConnection(env: Env, identity: Identity, agentId: string, verb: "disconnect" | "reconnect"): Promise<Response> {
  if (verb === "reconnect") {
    // A disconnect can commit in the API and then lose this gateway's request, so its cleanup finishes here if needed.
    // If its state can't be read, nothing reconnects, because that could bring old credentials back.
    const current = await callApi(env, identity, { method: "GET", path: `/v1/agents/${agentId}` });
    const agent = await current.json<{ status?: string }>();
    if (current.status !== 200) return json(agent, current.status);
    if (agent.status !== "active") await revokeCredentials(env, agentId);
  }
  const response = await callApi(env, identity, { method: "POST", path: `/v1/agents/${agentId}/${verb}`, body: "{}" });
  const body = await response.json<any>();
  if (response.status === 200) {
    await env.DB.prepare(`UPDATE podster_agent SET generation = ?, revoked_at = ? WHERE id = ? AND generation <= ?`).bind(body.generation, verb === "disconnect" ? Date.now() : null, agentId, body.generation).run();
    if (verb === "disconnect") await revokeCredentials(env, agentId);
  }
  return json(body, response.status);
}

async function handleOrganizations(request: Request, env: Env, person: string): Promise<Response> {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT o.id, o.name, o.personal, m.role FROM org_member m JOIN organization o ON o.id = m.org_id WHERE m.person_id = ? ORDER BY o.created_at`).bind(person).all();
    return json({ organizations: results });
  }
  if (request.method !== "POST" || !sameOrigin(request, env)) return denied("not_allowed", 403);
  const body = await request.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!validName(name)) return denied("invalid_argument", 400);
  const id = newId("org");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO organization (id, name, personal, created_by, created_at) VALUES (?, ?, 0, ?, ?)`).bind(id, name, person, now),
    env.DB.prepare(`INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'admin', ?)`).bind(id, person, now),
  ]);
  return json({ id, name, role: "admin" });
}

/** Discovery lists only the routes that are public, so clients don't follow one to a 404. */
function publicConfiguration(configuration: any) {
  const endpoints = Object.entries((configuration.endpoints ?? {}) as Record<string, string>).filter(([, url]) => isPublicAuthRoute(new URL(url).pathname.replace(/^\/api\/auth/, "")));
  return { ...configuration, endpoints: Object.fromEntries(endpoints) };
}

const appHandler = {
  async fetch(request: Request, publicEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const env = forPublicHost(request, publicEnv);
    const url = new URL(request.url);
    const onApplicationHost = env !== publicEnv;
    const card = onApplicationHost ? null : handleA2aCard(request, url, publicEnv.BASE_URL);
    if (card) return card;
    const upload = await handleUpload(request, url, publicEnv.API, (key) => withinLimit(publicEnv.RL_ACCOUNT, key));
    if (upload) return upload;
    const download = await handleAgentDownload(request, url, publicEnv, (token) => agentFromCredential(publicEnv, token, request), (key) => withinLimit(publicEnv.RL_ACCOUNT, key));
    if (download) return download;
    if (publicEnv.APP_URL && !onApplicationHost) {
      const moved = await movedToApplicationHost(request, publicEnv, publicEnv.APP_URL);
      if (moved) return moved;
    }
    // Refusals come before the auth instance exists, so an anonymous refusal doesn't start its setup.
    if (url.pathname === "/.well-known/agent-configuration" || url.pathname === "/api/auth/agent-configuration") return json(publicConfiguration(await createAuth(env).api.getAgentConfiguration({ headers: request.headers })));
    if (url.pathname.startsWith("/api/auth/")) {
      const route = url.pathname.slice("/api/auth".length);
      if (route === TEST_SIGNUP_ROUTE) return handleTestSignUp(request, publicEnv);
      if (route === EMAIL_LINK_ROUTE || route === EMAIL_VERIFY_ROUTE) {
        if (!onApplicationHost || !emailSignInEnabled(publicEnv)) return denied("not_found", 404);
        if (route === EMAIL_LINK_ROUTE) return request.method === "POST" ? handleEmailLink(request, env, ctx) : denied("not_found", 404);
        return handleEmailVerify(request, env);
      }
      if (!isPublicAuthRoute(route)) return denied("not_found", 404);
      if (publicEnv.APP_URL && !onApplicationHost && STARTS_SESSION.test(route)) return denied("not_found", 404);
      if (route === "/agent/register" && request.method === "POST") {
        // Read once and passed on, so what we checked is what the plugin parses.
        const text = await request.text();
        const refused = await refusedRegistration(request, text);
        if (refused) return refused;
        return createAuth(env).handler(new Request(request, { body: text }));
      }
      return createAuth(env).handler(request);
    }

    const auth = createAuth(env);
    // Refreshing here would slide the session and drop its new cookie, because this response doesn't carry it. Only
    // /api/auth/get-session slides it, where the cookie reaches the browser.
    const session = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (url.pathname === "/sign-in" && request.method === "GET") return signInPage(env, safeNext(url.searchParams.get("next")), url.searchParams.has("error"));
    if (url.pathname === "/sign-in" && request.method === "POST") return handleSignIn(request, env);
    if (url.pathname === "/signed-in" && request.method === "GET") return page("You're signed in", "<p>You can close this page.</p>");
    if (url.pathname === "/authorize") {
      if (!session) return request.method === "GET" ? signInRedirect(request) : denied("sign_in_required", 401);
      if (request.method !== "GET" && !(await withinLimit(env.RL_SENSITIVE, `consent:${session.user.id}`))) return rateLimited();
      return handleAuthorize(request, env, session.user.id);
    }
    if (url.pathname === "/claim" && request.method === "POST") {
      if (!session) return denied("sign_in_required", 401);
      if (!(await withinLimit(env.RL_SENSITIVE, `claim:${session.user.id}`))) return rateLimited();
      return handleClaim(request, env, session.user.id);
    }
    if (url.pathname === "/claim" && request.method === "GET") {
      if (!session) return signInRedirect(request);
      // The page checks the code, so guessing through it counts the same as posting.
      if (!(await withinLimit(env.RL_SENSITIVE, `claim:${session.user.id}`))) return rateLimited();
      return claimPage(request, env, session.user.id);
    }
    if (!url.pathname.startsWith("/api/")) return denied("not_found", 404);
    if (!session) return denied("sign_in_required", 401);
    const person = personId(session.user.id);

    if (!(await withinLimit(env.RL_ACCOUNT, `person:${session.user.id}`))) return rateLimited();
    if (onApplicationHost && url.pathname === "/api/consent") return handleConsentApi(request, env, publicEnv.BASE_URL, session.user.id);
    if (onApplicationHost && url.pathname === "/api/claim") return handleClaimApi(request, env, session.user.id);
    if (request.method !== "GET" && request.method !== "HEAD" && url.pathname.startsWith("/api/org") && !sameOrigin(request, env)) return denied("not_allowed", 403);
    const orgPeople = await handleOrgPeople(request, env, person, url.pathname);
    if (orgPeople) return orgPeople;
    if (url.pathname === "/api/orgs") {
      if (request.method === "POST" && !(await withinLimit(env.RL_SENSITIVE, `create-org:${session.user.id}`))) return rateLimited();
      await memberships(env, person);
      return handleOrganizations(request, env, person);
    }

    const identity = await personIdentity(env, request, session.user.id);
    if (!identity) return denied("not_allowed", 403);
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request, env)) return denied("not_allowed", 403);

    const connection = url.pathname.match(/^\/api\/agents\/([\w-]+)\/(disconnect|reconnect)$/);
    if (connection && request.method === "POST") return handleConnection(env, identity, connection[1], connection[2] as "disconnect" | "reconnect");
    if (url.pathname === "/api/agents" && request.method === "GET") return listAgents(env, (await memberships(env, person)).orgs);
    // An agent's A2A endpoint, for its organization's admins (decision 119). The API checks who may, and never returns the
    // token or, outside a set, the signing secret.
    const endpoint = url.pathname.match(/^\/api\/agents\/([\w-]+)\/a2a-endpoint$/);
    if (endpoint && ["GET", "PUT", "DELETE"].includes(request.method)) {
      let body: string | undefined;
      if (request.method === "PUT") {
        // Counted in bytes as they arrive, so an oversized body is refused before it's all read.
        const bytes = await boundedBody(request, 8192);
        if (!bytes) return denied("invalid_argument", 400);
        body = new TextDecoder().decode(bytes);
      }
      const response = await callApi(env, identity, { method: request.method, path: `/v1/agents/${endpoint[1]}/a2a-endpoint`, body });
      return json(await response.json(), response.status);
    }
    const agent = url.pathname.match(/^\/api\/agents\/([\w-]+)$/);
    if (agent && request.method === "GET") {
      const response = await callApi(env, identity, { method: "GET", path: `/v1/agents/${agent[1]}` });
      return json(await response.json(), response.status);
    }

    // Everything else in the dashboard goes straight to the API, which decides.
    const path = url.pathname.slice("/api".length);
    if (isFilePath(path)) return request.method === "GET" ? serveFile(env, identity, path) : denied("not_found", 405);
    if (!allowedPassthrough(path) && !allowedInbox(request.method, path, url.searchParams)) return denied("not_found", 404);
    if (sensitiveCommand(request.method, path) && !(await withinLimit(env.RL_SENSITIVE, `invite-or-create:${session.user.id}`))) return rateLimited();
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const text = hasBody ? await request.text() : undefined;
    const response = await callApi(env, await withTargetMember(env, identity, request.method, path, text), {
      method: request.method,
      path: path + url.search,
      body: text,
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  },
};

/** Stateless MCP: one server per request, one tool per capability, on the same code path as Agent Auth. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: { externalId?: string }; auth?: { scope?: string[] } }): Promise<Response> {
    // Stateless: there's no stream to hold open, and every call is a POST.
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    // The package advertises `requiredScopes` and leaves enforcing them here. Only an `mcp` token reaches the tools.
    if (!ctx.auth?.scope?.includes("mcp")) return insufficientScope(ctx.auth as never, ["mcp"]);
    const externalId = ctx.props?.externalId ?? "";
    if (!(await withinLimit(env.RL_ACCOUNT, `mcp:${externalId}`))) return rateLimited();
    // Read once, at the size the SDK itself allows, so a huge body can't exhaust the isolate.
    const body = await boundedBody(request, MAX_MCP_BODY_BYTES);
    if (!body) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "body too large" } }, 413);
    // One batch would run up to 100 calls for one count. The protocol's clients send single messages.
    if (Array.isArray(await new Response(body).json().catch(() => null))) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests aren't supported" } }, 400);
    const server = new McpServer({ name: "podster", version: "0.0.0" });
    for (const capability of CAPABILITIES) {
      server.registerTool(capability.name, { description: capability.description, inputSchema: zodShape(capability) as any }, async (args: Record<string, unknown>) => {
        const fail = (code: string) => ({ isError: true, content: [{ type: "text" as const, text: code }] });
        try {
          const identity = await resolveAgent(env, "mcp_oauth", externalId);
          const { status, body } = await runCapability(env, identity, capability, args);
          if (status >= 400) return fail(body?.error?.code ?? "error");
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
        } catch (error) {
          if (error instanceof AgentRefused) return fail(error.message);
          if (error instanceof InvalidArguments) return fail("invalid_argument");
          throw error;
        }
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(new Request(request, { body }));
  },
};

/** The API reads A2A needs, through the same capabilities MCP calls, as the agent the token resolved to. */
function a2aReads(env: Env, identity: Identity): ApiReads {
  const run = (name: string, args: Record<string, unknown>) => runCapability(env, identity, CAPABILITIES.find((c) => c.name === name)!, args);
  return {
    getTask: (workspaceId, taskId) => run("get_task", { workspace_id: workspaceId, task_id: taskId }),
    listTasks: (workspaceId, query) => run("list_tasks", { workspace_id: workspaceId, order: query.order, ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.status ? { status: query.status } : {}) }),
    listWorkspaces: () => run("list_workspaces", {}),
    command: async (name, args, idempotencyKey) => {
      const response = await callApi(env, identity, toApiCall(CAPABILITIES.find((c) => c.name === name)!, { ...args, idempotency_key: idempotencyKey }));
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    // `send_message`'s own call, with `via` added, which no capability field can set: it tells the room the message
    // came over A2A, so a finished task refuses it (ADR 0007). It can only refuse more.
    sendMessage: async (workspaceId, taskId, body, idempotencyKey) => {
      const call = toApiCall(CAPABILITIES.find((c) => c.name === "send_message")!, { workspace_id: workspaceId, task_id: taskId, body, idempotency_key: idempotencyKey });
      const response = await callApi(env, identity, { ...call, body: JSON.stringify({ body, via: "a2a" }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

/**
 * `/a2a`, after the resource server has checked the token's audience. The checks before authentication already ran, and
 * the body is the one they read. The agent's limit is MCP's bucket, so the two protocols share one allowance (decision 123).
 */
const a2aHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: { externalId?: string }; auth?: { scope?: string[] } }): Promise<Response> {
    if (!ctx.auth?.scope?.includes("a2a")) return insufficientScope(ctx.auth as never, ["a2a"]);
    const externalId = ctx.props?.externalId ?? "";
    if (!(await withinLimit(env.RL_ACCOUNT, `mcp:${externalId}`))) return rateLimited();
    try {
      const identity = await resolveAgent(env, "mcp_oauth", externalId);
      return await answerA2a(await request.text(), identity.id, env.BASE_URL, a2aReads(env, identity), request.headers.get("A2A-Extensions"));
    } catch (error) {
      if (error instanceof AgentRefused) return denied(error.message, 403);
      throw error;
    }
  },
};

/** Downloading is what `get_asset_link` is for, so an agent needs that capability's grant to download, as it would to call it. */
const DOWNLOAD_CAPABILITY = "get_asset_link";

/** The refusal the capability path gives an agent with no grant for a capability, in the plugin's shape. */
const notGranted = (capability: string) => json({ error: "capability_not_granted", message: `Agent does not have an active grant for capability "${capability}".` }, 403);

/** A download under way through the plugin's own call of `get_asset_link`, found again by the request it was given. */
type Download = { serve: (pluginAgent: string, authorization: string | null | undefined) => Promise<Response>; response?: Response };
const DOWNLOADS = new WeakMap<Request, Download>();

/**
 * Who an agent's own credential says it is, read fresh for one download, the same way a capability call does. A credential that ended
 * for any reason, including whoever connected it leaving, stops working on its next use. `null` means it isn't one.
 *
 * An Agent Auth JWT goes through the plugin's own call of `get_asset_link`, with this file's room and ID as its arguments, so the grant
 * check is the capability path's, not a copy of it: the JWT's `capabilities` claim, a grant's constraints, a revoked grant and the host's
 * budget all count as they do there, and so do its refusals. The plugin then hands the download back here, which serves the file. The
 * request it's given is the real method and URL, so a JWT bound to this request with `htm` and `htu` verifies.
 *
 * An MCP token's tools are all granted by its `mcp` scope, which the provider requires at `/mcp`, and there's no grant for each tool, so
 * that scope is what lets it download. Every MCP token is issued with it, so for now this refuses only a token whose record lost it.
 */
async function agentFromCredential(env: Env, token: string, request: Request): Promise<Identity | Response | null> {
  try {
    if (token.split(".").length === 3) {
      const [, , workspace_id, file_id] = new URL(request.url).pathname.split("/").slice(1);
      const headers = new Headers({ authorization: `Bearer ${token}` });
      const bound = new Request(request.url, { method: request.method, headers });
      const download: Download = {
        serve: async (pluginAgent, authorization) => {
          // As the capability path counts, before the token is spent, so an agent that was limited can retry with the same one.
          if (!(await withinLimit(env.RL_ACCOUNT, `agent:${pluginAgent}`))) return rateLimited();
          const spends = spentToken(pluginAgent, authorization);
          if (!spends) return denied("invalid_credential", 401);
          try {
            const identity = { ...(await resolveAgent(env, "agent_auth", pluginAgent)), spends } as Identity;
            return await serveFile(env, identity, new URL(request.url).pathname);
          } catch (error) {
            if (error instanceof AgentRefused) return denied(error.message, 403);
            throw error;
          }
        },
      };
      DOWNLOADS.set(bound, download);
      // A refusal may come back or be thrown. Either way it's answered as the plugin's route answers it.
      const answer = (await createAuth(env)
        .api.executeCapability({ headers, request: bound, body: { capability: DOWNLOAD_CAPABILITY, arguments: { workspace_id, file_id } }, asResponse: true })
        .catch((error: unknown) => {
          if (!(error instanceof APIError)) throw error;
          const sent = new Headers(error.headers as HeadersInit | undefined);
          sent.set("content-type", "application/json");
          return new Response(JSON.stringify(error.body), { status: error.statusCode, headers: sent });
        })) as Response;
      if (download.response) {
        await answer.body?.cancel();
        return download.response;
      }
      // A JWT that doesn't verify, or names no agent, isn't a credential. Any other refusal is the capability path's own.
      if (answer.status === 401) {
        await answer.body?.cancel();
        return null;
      }
      return answer;
    }
    const held = await env.OAUTH_PROVIDER.unwrapToken<{ externalId?: string }>(token);
    const externalId = held?.grant.props?.externalId;
    if (!externalId || !forMcp(held.audience, env.BASE_URL)) return null;
    const identity = await resolveAgent(env, "mcp_oauth", externalId);
    return held.scope?.includes("mcp") ? identity : notGranted(DOWNLOAD_CAPABILITY);
  } catch (error) {
    if (error instanceof AgentRefused) return denied(error.message, 403);
    throw error;
  }
}

/**
 * Whether a token was issued for `/mcp`, as the provider checks there, so a token for any other resource doesn't work at `/v1/files`.
 * A token stored with no audience is a grant from before there were two resources, which `legacyGrantResource` makes `/mcp`.
 */
export function forMcp(audience: string | string[] | undefined, base: string) {
  const resource = new URL(`${base}/mcp`).href;
  const same = (value: unknown) => {
    try {
      return typeof value === "string" && new URL(value).href === resource;
    } catch {
      return false;
    }
  };
  if (audience === undefined) return true;
  return Array.isArray(audience) ? audience.some(same) : same(audience);
}

let oauth: ReturnType<typeof buildOAuth<Env>> | undefined;

const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 1000;

/**
 * Removes what anonymous callers left behind: sign-in state past its expiry, and agents nobody claimed. An agent stays
 * while it has a live code, and a registration that comes back afterward simply starts again.
 */
export async function cleanUp(env: Pick<Env, "DB">, now = Date.now(), batch = CLEANUP_BATCH) {
  const nowIso = new Date(now).toISOString();
  await env.DB.prepare(`DELETE FROM verification WHERE expiresAt < ?`).bind(nowIso).run();
  const { results } = await env.DB.prepare(
    `SELECT id FROM agent WHERE status = 'pending' AND userId IS NULL AND createdAt < ? AND id NOT IN (SELECT agentId FROM approvalRequest WHERE agentId IS NOT NULL AND status = 'pending' AND expiresAt >= ?) LIMIT ?`,
  ).bind(new Date(now - ABANDONED_AFTER_MS).toISOString(), nowIso, batch).all<{ id: string }>();
  // The agent's grants and approvals go with it, by the plugin's foreign keys. One batch is one query, and atomic.
  if (results.length > 0) await env.DB.batch(results.map(({ id }) => env.DB.prepare(`DELETE FROM agent WHERE id = ?`).bind(id)));
  await env.DB.prepare(`DELETE FROM agentHost WHERE userId IS NULL AND status = 'pending' AND createdAt < ? AND id NOT IN (SELECT hostId FROM agent WHERE hostId IS NOT NULL)`).bind(new Date(now - ABANDONED_AFTER_MS).toISOString()).run();
  return results.length;
}

function withHsts(response: Response, env: Env) {
  if (!env.BASE_URL.startsWith("https:")) return response;
  const secured = new Response(response.body, response);
  secured.headers.set("strict-transport-security", "max-age=31536000");
  return secured;
}

/** The first check on every request, ahead of any auth or storage work. */
async function limitByClient(request: Request, env: Env) {
  const client = clientKey(request);
  const path = new URL(request.url).pathname;
  if (!(await withinLimit(env.RL_GENERAL, `ip:${client}`))) return rateLimited(path);
  const route = sensitiveRoute(request.method, path);
  const retryAfter = route ? await strictRetryAfter(env, route, client) : 0;
  if (retryAfter > 0) return rateLimited(path, String(retryAfter));
  return null;
}

/** Routes that store what an anonymous caller sends, so a limit on requests alone would still allow large records. */
const MAX_STORED_BODY_BYTES = 16 * 1024;
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;
const storesAnonymousBody = (method: string, path: string) =>
  method === "POST" && (path === "/oauth/register" || path === "/api/auth/agent/register" || path === "/sign-in" || path.startsWith("/api/auth/sign-in/") || path.startsWith("/api/auth/sign-up/"));

/** Reads the stream as well as trusting the header, because a chunked body has no length. */
async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader?.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * A deployment on HTTPS answers nothing else. Discovery over HTTP would advertise HTTP endpoints, and an agent following
 * them would send its tokens in cleartext. A body sent over HTTP has already been exposed, so it's refused, not forwarded.
 */
function insecureRequest(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  if (url.protocol === "https:" || !env.BASE_URL.startsWith("https:")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return denied("https_required", 400);
  // Joined as text: `new URL("//evil.test", base)` would point at another host.
  return new Response(null, { status: 301, headers: { location: `${new URL(env.BASE_URL).origin}${url.pathname}${url.search}` } });
}

export default {
  // The resource URL comes from the environment, so the provider is built per deployment rather than at import.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([cleanUp(env), retryDepartures(env)]));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const insecure = insecureRequest(request, env);
    if (insecure) return insecure;
    const limitedResponse = await limitByClient(request, env);
    if (limitedResponse) return withHsts(limitedResponse, env);
    if (storesAnonymousBody(request.method, new URL(request.url).pathname)) {
      // The host name in a registration's token is stored too, so the header counts.
      const body = (request.headers.get("authorization")?.length ?? 0) > MAX_STORED_BODY_BYTES ? null : await boundedBody(request, MAX_STORED_BODY_BYTES);
      if (!body) return withHsts(json({ error: "invalid_client_metadata", error_description: "body_too_large", message: "body_too_large" }, 413), env);
      request = new Request(request, { body });
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/oauth/register" && (await registersOurHost(request, env))) {
      return withHsts(json({ error: "invalid_redirect_uri", error_description: "redirect_uri_on_our_host" }, 400), env);
    }
    if (oauth?.base !== env.BASE_URL) oauth = buildOAuth<Env>(env.BASE_URL, { mcp: mcpHandler, a2a: a2aHandler });
    // `/a2a`'s checks come before authentication, and its body is read here, once.
    if (isA2aPath(new URL(request.url))) {
      // A2A is the gateway's own, never the application host's.
      if (forPublicHost(request, env) !== env) return withHsts(denied("not_found", 404), env);
      // A preflight gets the resource server's own CORS answer. Every other method goes through the checks.
      if (request.method !== "OPTIONS") {
        const checked = await checkA2aRequest(request, env.BASE_URL);
        if (checked instanceof Response) return withHsts(checked, env);
        request = new Request(request, { body: checked.text });
      }
    }
    return withHsts(await routeOAuth(oauth, request, env, ctx, appHandler), env);
  },
};
