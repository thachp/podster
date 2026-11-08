import { OAuthAuthorizationServer, OAuthResourceServer, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * One authorization server with two protected resources, `/mcp` and `/a2a`, in this Worker (ADR 0007, M3 step 7). The
 * package's combined `OAuthProvider` takes one resource, so every route it protects shares one audience. Here every
 * grant and token is bound to exactly one resource, and a token for one is refused at the other.
 *
 * - A request that leaves `resource` out, which today's MCP clients may, gets `/mcp` (`defaultResource`).
 * - A grant stored before there was a second resource stays `/mcp` (`legacyGrantResource`).
 * - Each resource's handler checks its own scope, because the package advertises `requiredScopes` but doesn't enforce them.
 *
 * The gateway owns the routing, and gives every other handler `env.OAUTH_PROVIDER` as the combined provider did.
 */

export const MCP_PATH = "/mcp";
export const A2A_PATH = "/a2a";
export const TOKEN_PATH = "/oauth/token";
export const REGISTRATION_PATH = "/oauth/register";
export const AUTHORIZE_PATH = "/authorize";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PR_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export const resourceUrl = (base: string, path: string) => new URL(`${base}${path}`).href;

/** Which resource a grant or request names. One with none is the legacy MCP grant. */
export function resourceKind(base: string, resource: string | string[] | undefined): "mcp" | "a2a" | null {
  if (resource === undefined) return "mcp";
  if (Array.isArray(resource)) return resource.length === 1 ? resourceKind(base, resource[0]) : null;
  try {
    const href = new URL(resource).href;
    if (href === resourceUrl(base, MCP_PATH)) return "mcp";
    if (href === resourceUrl(base, A2A_PATH)) return "a2a";
  } catch {
    // Not a URL, so not one of ours.
  }
  return null;
}

type Handler<Env> = { fetch(request: Request, env: Env, ctx: any): Promise<Response> };
type Roles<Env> = { base: string; as: OAuthAuthorizationServer<Env>; mcp: OAuthResourceServer<Env, any>; a2a: OAuthResourceServer<Env, any> };

export function buildOAuth<Env>(base: string, handlers: { mcp: Handler<Env>; a2a: Handler<Env> }): Roles<Env> {
  const mcpResource = resourceUrl(base, MCP_PATH);
  const a2aResource = resourceUrl(base, A2A_PATH);
  const as = new OAuthAuthorizationServer<Env>({
    issuer: new URL(base).origin,
    resources: [mcpResource, a2aResource],
    defaultResource: mcpResource,
    legacyGrantResource: mcpResource,
    authorizeEndpoint: `${base}${AUTHORIZE_PATH}`,
    tokenEndpoint: `${base}${TOKEN_PATH}`,
    clientRegistrationEndpoint: `${base}${REGISTRATION_PATH}`,
    scopesSupported: ["mcp", "a2a", "offline_access"],
  });
  const validateToken = (env: Env) => (resource: string, token: string) => as.validateToken(resource, token, env);
  const mcp = new OAuthResourceServer<Env, any>({
    resourceMetadata: { resource: mcpResource, authorization_servers: [new URL(base).origin] },
    requiredScopes: ["mcp"],
    validateToken,
    handler: handlers.mcp as never,
  });
  const a2a = new OAuthResourceServer<Env, any>({
    resourceMetadata: { resource: a2aResource, authorization_servers: [new URL(base).origin] },
    requiredScopes: ["a2a"],
    validateToken,
    handler: handlers.a2a as never,
  });
  return { base, as, mcp, a2a };
}

/** Which build each env's helpers came from, so an env reused with another `BASE_URL` gets helpers for the new issuer. */
const helpersFrom = new WeakMap<object, Roles<any>>();

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Where a request goes. The authorization server's own endpoints, then each resource and its metadata, then the app.
 * `/a2a` reaches here only after the A2A checks that come before authentication.
 */
export async function routeOAuth<Env extends { OAUTH_PROVIDER: OAuthHelpers }>(
  roles: Roles<Env>,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  app: Handler<Env>,
): Promise<Response> {
  // The helpers, as the combined provider gave them to its handlers. Replaced whenever the build changes, so they never
  // belong to another issuer.
  if (helpersFrom.get(env) !== roles) {
    env.OAUTH_PROVIDER = roles.as.getOAuthApi(env);
    helpersFrom.set(env, roles);
  }
  const path = new URL(request.url).pathname;
  if (path === AS_METADATA_PATH || path === TOKEN_PATH || path === REGISTRATION_PATH) return roles.as.fetch(request, env, ctx);
  if (under(path, MCP_PATH) || path === `${PR_METADATA_PREFIX}${MCP_PATH}`) return roles.mcp.fetch(request, env, ctx);
  if (path === A2A_PATH || path === `${PR_METADATA_PREFIX}${A2A_PATH}`) return roles.a2a.fetch(request, env, ctx);
  // Nothing else in the protected-resource namespace exists, as before.
  if (under(path, PR_METADATA_PREFIX)) return new Response(null, { status: 404 });
  return app.fetch(request, env, ctx);
}
