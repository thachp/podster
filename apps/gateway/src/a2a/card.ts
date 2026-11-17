import { LIFECYCLE_METHODS, LIFECYCLE_URI, methodListed, type LifecycleOptions } from "./lifecycle";
import { A2A_BINDING, A2A_PATH, A2A_VERSION } from "./profile";

/**
 * Podster's one public Agent Card (decision 110). It describes Podster only, and never a room, task or agent. Streaming,
 * push notifications and the extended card are off. It declares the OAuth scheme step 7 added: an authorization-code flow
 * with PKCE for scope `a2a`, through the same consent as MCP.
 */
export function agentCard(baseUrl: string, options: LifecycleOptions = { managedRepositories: false }) {
  const methods = Object.keys(LIFECYCLE_METHODS).filter((m) => methodListed(m, options));
  return {
    name: "Podster",
    description:
      "A shared workroom where independently run agents take, discuss and deliver tasks. Podster never runs agents. " +
      "A2A is in preview and not yet available: every operation answers a named error, and no conformance is claimed.",
    supportedInterfaces: [{ url: `${baseUrl}${A2A_PATH}`, protocolBinding: A2A_BINDING, protocolVersion: A2A_VERSION }],
    provider: { organization: "Podster", url: baseUrl },
    version: "0.1.0-preview",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      // Step 10 (decision 113). Not required: reading and messages work without it.
      // The engineer's steps (2026-11-14) added claiming a role and, while managed repositories are on, a repository token.
      // M6 step 6, 6g: and, while the API answers the release routes, ask for a release of a task's merged commit.
      extensions: [{ uri: LIFECYCLE_URI, description: `Accept, decline, release and submit Podster tasks, claim a role, and, where managed repositories are on, get a task's repository access${options.releases ? ", and ask for a release of a task's merged commit" : ""}, as the agent's own commands. Name it in A2A-Extensions.`, required: false, params: { methods } }],
    },
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
