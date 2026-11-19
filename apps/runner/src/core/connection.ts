/**
 * Runner's calls as its paired agent. Each call signs a fresh agent JWT with the stored agent key (the pinned SDK's
 * `signAgentJWT`), naming only the one capability, and posts it to the gateway's execute endpoint.
 *
 * Runner makes this call itself rather than through the SDK's `executeCapability` (M7 plan, the architect's ruling 3 on
 * spike A): the SDK misreads the gateway's own refusals, and its grant cache can refuse locally after a revocation with no
 * HTTP status at all. Here every refusal is the gateway's, read with its status (`errors.ts`).
 *
 * Only the gateway's origin is ever reached: a discovery document naming an issuer or an execute location elsewhere is
 * refused, so an agent JWT is never sent anywhere else.
 */
import { discoverProvider, signAgentJWT, type AgentConnection, type ProviderConfig } from "@auth/agent";
import type { RunnerCapability } from "./capabilities.js";
import { RUNNER_CAPABILITIES } from "./capabilities.js";
import { errorFrom, GatewayError, readBounded } from "./errors.js";
import { gatewayFetch, onGateway } from "./gateway.js";
import type { RunnerStorage } from "./storage.js";

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The longest answer Runner reads from one call. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 30_000;

/** The gateway's discovery document, checked to name the gateway itself as its issuer. */
export async function discover(origin: string, fetchImpl: typeof fetch): Promise<ProviderConfig> {
  let config: ProviderConfig;
  try {
    config = await discoverProvider(origin, gatewayFetch(origin, fetchImpl));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(0, "discovery_failed");
  }
  if (!onGateway(origin, config.issuer)) throw new GatewayError(0, "wrong_origin");
  return config;
}

/** Where a capability executes, from the discovery document, as the SDK resolves it. It must be on the gateway. */
export function executeLocation(origin: string, config: ProviderConfig, capability: string): string {
  const own = config.capabilities?.find((c) => c.name === capability)?.location;
  const issuer = config.issuer.replace(/\/+$/, "");
  const path = config.endpoints.execute ?? "/capability/execute";
  const location = own ?? config.default_location ?? (/^https?:\/\//.test(path) ? path : `${issuer}${path.startsWith("/") ? path : `/${path}`}`);
  if (!onGateway(origin, location)) throw new GatewayError(0, "wrong_origin");
  return location;
}

export class Connection {
  readonly origin: string;
  readonly pluginAgentId: string;
  private readonly storage: RunnerStorage;
  private readonly fetch: typeof fetch;
  private config: ProviderConfig | null = null;

  constructor(opts: { origin: string; pluginAgentId: string; storage: RunnerStorage; fetch: typeof fetch }) {
    this.origin = opts.origin;
    this.pluginAgentId = opts.pluginAgentId;
    this.storage = opts.storage;
    this.fetch = gatewayFetch(opts.origin, opts.fetch);
  }

  private async agentConnection(): Promise<AgentConnection> {
    const connection = await this.storage.getAgentConnection(this.pluginAgentId);
    if (!connection) throw new GatewayError(0, "no_local_key");
    return connection;
  }

  /**
   * Calls one capability as the paired agent and answers its result. A refusal throws `GatewayError` with the gateway's
   * status and code. The answer is someone else's content: callers take IDs and numbers from it, never text to act on.
   */
  async call(capability: RunnerCapability, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!(RUNNER_CAPABILITIES as readonly string[]).includes(capability)) throw new GatewayError(0, "not_runner_capability");
    const connection = await this.agentConnection();
    this.config ??= await discover(this.origin, this.fetch);
    const location = executeLocation(this.origin, this.config, capability);
    const token = await signAgentJWT({ agentKeypair: connection.agentKeypair, agentId: this.pluginAgentId, audience: location, capabilities: [capability] });
    let response: Response;
    try {
      response = await this.fetch(location, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ capability, arguments: args }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(0, "network");
    }
    if (!response.ok) throw await errorFrom(response);
    // Read only up to the bound: an answer past it, or one that never ends, is cut there, never held whole.
    const text = await readBounded(response, MAX_ANSWER_BYTES);
    if (text === null) throw new GatewayError(0, "bad_answer");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new GatewayError(0, "bad_answer");
    }
    // The plugin answers `{ data: result }`.
    return isObject(body) && "data" in body ? body.data : body;
  }
}
