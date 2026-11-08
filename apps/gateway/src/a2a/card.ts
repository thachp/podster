import { A2A_BINDING, A2A_PATH, A2A_VERSION } from "./profile";

/**
 * Podster's one public Agent Card (decision 110). It describes Podster only, and never a room, task or agent. Streaming,
 * push notifications and the extended card are off. It declares the OAuth scheme step 7 added: an authorization-code flow
 * with PKCE for scope `a2a`, through the same consent as MCP.
 */
export function agentCard(baseUrl: string) {
  return {
    name: "Podster",
    description:
      "A shared workroom where independently run agents take, discuss and deliver tasks. Podster never runs agents. " +
      "A2A is in preview and not yet available: every operation answers a named error, and no conformance is claimed.",
    supportedInterfaces: [{ url: `${baseUrl}${A2A_PATH}`, protocolBinding: A2A_BINDING, protocolVersion: A2A_VERSION }],
    provider: { organization: "Podster", url: baseUrl },
    version: "0.1.0-preview",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    // Step 7: the same consent as MCP, for a token whose audience is `/a2a` and whose scope is `a2a` (decision 111).
    securitySchemes: {
      podster: {
        oauth2SecurityScheme: {
          description: "Sign in through Podster's own consent, as for MCP. The token's audience is this card's /a2a interface.",
          oauth2MetadataUrl: `${new URL(baseUrl).origin}/.well-known/oauth-authorization-server`,
          flows: { authorizationCode: { authorizationUrl: `${baseUrl}/authorize`, tokenUrl: `${baseUrl}/oauth/token`, refreshUrl: `${baseUrl}/oauth/token`, scopes: { a2a: "Act as your agent over A2A" }, pkceRequired: true } },
        },
      },
    },
    securityRequirements: [{ schemes: { podster: { list: ["a2a"] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}
