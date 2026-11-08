import { OAuthAuthorizationServer, OAuthResourceServer, insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { A2A_VERSION_HEADER, TaskState } from "@a2a-js/sdk";
import { defaultServerCallContextBuilder, JsonRpcTransportHandler, type A2ARequestHandler } from "@a2a-js/sdk/server";
import { TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { AGENT, PERSON } from "./identity";

/**
 * Spike B: one authorization server with two resources, `/mcp` and `/a2a`, each its own token audience, in one Worker.
 * The gateway today uses the combined `OAuthProvider`, which has one resource, so every protected route would share
 * one audience. This uses the split roles from the same package, still in one Worker.
 */

type Env = { BASE_URL: string; OAUTH_KV: KVNamespace };
type Props = { externalId: string };


/** Each resource grants only its own scope, whatever a client asks for. */
const SCOPE_FOR: Record<string, string> = { mcp: "mcp", a2a: "a2a" };

let built: { base: string; as: OAuthAuthorizationServer<Env>; mcp: OAuthResourceServer<Env, Props>; a2a: OAuthResourceServer<Env, Props> } | undefined;

function build(base: string) {
  const mcpResource = `${base}/mcp`;
  const a2aResource = `${base}/a2a`;
  const as = new OAuthAuthorizationServer<Env>({
    issuer: base,
    resources: [mcpResource, a2aResource],
    // Today's MCP clients may leave `resource` out, and they must keep getting an MCP token.
    defaultResource: mcpResource,
    // Grants stored before there was a second resource stay MCP grants.
    legacyGrantResource: mcpResource,
    authorizeEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    clientRegistrationEndpoint: `${base}/oauth/register`,
    scopesSupported: ["mcp", "a2a", "offline_access"],
  });
  const validate = (env: Env) => (resource: string, token: string) => as.validateToken<Props>(resource, token, env);
  const mcp = new OAuthResourceServer<Env, Props>({
    resourceMetadata: { resource: mcpResource, authorization_servers: [base] },
    requiredScopes: ["mcp"],
    validateToken: validate,
    handler: {
      async fetch(_request: Request, _env: Env, ctx: OAuthResourceContext<Props>) {
        if (!ctx.auth.scope.includes("mcp")) return insufficientScope(ctx.auth, ["mcp"]);
        return Response.json({ resource: "mcp", agent: ctx.props.externalId });
      },
    } as never,
  });
  const a2a = new OAuthResourceServer<Env, Props>({
    resourceMetadata: { resource: a2aResource, authorization_servers: [base] },
    requiredScopes: ["a2a"],
    validateToken: validate,
    handler: {
      async fetch(request: Request, _env: Env, ctx: OAuthResourceContext<Props>) {
        if (!ctx.auth.scope.includes("a2a")) return insufficientScope(ctx.auth, ["a2a"]);
        return a2aRpc(request, ctx.props.externalId, base);
      },
    } as never,
  });
  return { base, as, mcp, a2a };
}

function cardJson(base: string) {
  return {
    name: "Podster (spike B)",
    description: "Audience check only.",
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    version: "0.0.0-spike",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: {
      podster: {
        oauth2SecurityScheme: {
          description: "The same consent as MCP, for a token whose audience is /a2a.",
          oauth2MetadataUrl: `${base}/.well-known/oauth-authorization-server`,
          flows: { authorizationCode: { authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/oauth/token`, scopes: { a2a: "Act as your agent over A2A" }, pkceRequired: true } },
        },
      },
    },
    securityRequirements: [{ schemes: { podster: { list: ["a2a"] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}

/** Just enough A2A to show the client got through: `GetTask` answers with the agent the token resolved to. */
async function a2aRpc(request: Request, agent: string, base: string) {
  const unsupported = async () => {
    throw new UnsupportedOperationError("Not in spike B.");
  };
  const handler = {
    getAgentCard: async () => (await import("@a2a-js/sdk")).AgentCard.fromJSON(cardJson(base)),
    getTask: async (params: { id: string }) => {
      if (params.id !== "tsk_whoami") throw new TaskNotFoundError("Task not found.");
      return { id: params.id, contextId: params.id, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined }, artifacts: [], history: [], metadata: { agent } };
    },
    sendMessage: unsupported, sendMessageStream: unsupported, cancelTask: unsupported, listTasks: unsupported, resubscribe: unsupported,
    getAuthenticatedExtendedAgentCard: unsupported, createTaskPushNotificationConfig: unsupported, getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported, deleteTaskPushNotificationConfig: unsupported,
  } as unknown as A2ARequestHandler;
  const context = defaultServerCallContextBuilder({
    extensions: undefined,
    user: { isAuthenticated: true, userName: agent },
    headers: Object.fromEntries(request.headers),
    requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined,
  } as never);
  return Response.json(await new JsonRpcTransportHandler(handler).handle(await request.text(), context));
}

/** The gateway's `forMcp` check on `/v1/files`, written again: the token's audience must be `/mcp`. */
function forMcp(audience: string | string[] | undefined, base: string) {
  const resource = new URL(`${base}/mcp`).href;
  const same = (v: unknown) => typeof v === "string" && new URL(v).href === resource;
  if (audience === undefined) return true;
  return Array.isArray(audience) ? audience.some(same) : same(audience);
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (built?.base !== env.BASE_URL) built = build(env.BASE_URL);
    const { as, mcp, a2a } = built;
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/.well-known/agent-card.json") return Response.json(cardJson(env.BASE_URL));

    // A stand-in consent page: the one test person approves at once. The real one is the gateway's.
    if (path === "/authorize" && request.method === "GET") {
      const oauth = as.getOAuthApi(env);
      let auth;
      try {
        auth = await oauth.parseAuthRequest(request);
      } catch {
        // An unknown or doubled resource is refused here, before any consent or grant.
        return Response.json({ error: "invalid_target" }, { status: 400 });
      }
      const kind = auth.resource === `${env.BASE_URL}/a2a` ? "a2a" : "mcp";
      const { redirectTo } = await oauth.completeAuthorization({
        request: auth,
        userId: PERSON,
        metadata: { kind },
        scope: [SCOPE_FOR[kind], ...(auth.scope.includes("offline_access") ? ["offline_access"] : [])],
        props: { externalId: AGENT } satisfies Props,
        revokeExistingGrants: false,
      });
      return Response.redirect(redirectTo, 302);
    }

    // A download, as the gateway checks one: the token's own record, with its audience.
    if (under(path, "/v1/files")) {
      const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token) return new Response(null, { status: 401 });
      const held = await as.getOAuthApi(env).unwrapToken<Props>(token);
      if (!held || !forMcp(held.audience as string | string[] | undefined, env.BASE_URL) || !held.scope?.includes("mcp")) return new Response(null, { status: 401 });
      return Response.json({ file: path.slice("/v1/files/".length), agent: held.grant.props.externalId });
    }

    // Disconnecting the agent revokes every grant, as the gateway's disconnect does.
    if (path === "/spike/disconnect" && request.method === "POST") {
      const oauth = as.getOAuthApi(env);
      const grants = await oauth.listUserGrants(PERSON);
      for (const g of grants.items) await oauth.revokeGrant(g.id, PERSON);
      return Response.json({ revoked: grants.items.length });
    }

    if (under(path, "/mcp") || path === "/.well-known/oauth-protected-resource/mcp") return mcp.fetch(request, env, ctx);
    if (under(path, "/a2a") || path === "/.well-known/oauth-protected-resource/a2a") return a2a.fetch(request, env, ctx);
    return as.fetch(request, env, ctx);
  },
};
