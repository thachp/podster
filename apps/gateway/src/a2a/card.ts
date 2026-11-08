import { A2A_BINDING, A2A_PATH, A2A_VERSION } from "./profile";

/**
 * Podster's one public Agent Card (decision 110). It describes Podster only, and never a room, task or agent. Streaming,
 * push notifications and the extended card are off. It declares no security scheme until step 7 adds the `/a2a` OAuth
 * audience, and until then every operation refuses, so there's nothing a credential would open.
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
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}
