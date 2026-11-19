/**
 * Runner's keys, behind the SDK's `Storage` interface (M7 plan, the architect's ruling 3 on spike A): the SDK has no
 * keychain store, so Runner gives it this one, over a `SecretStore` that on the owner's machine is the OS keychain
 * (`src/node/keychain.ts`), or on Linux without a Secret Service, owner-only files (`src/node/key-store.ts`, S-47).
 *
 * What it holds: the host key (the one pairing binds), and the one agent connection Runner registers on that host, each
 * with its private key. Provider discovery documents aren't secret, and the SDK finds them again at each start, so they
 * stay in memory.
 *
 * The SDK makes a host key by itself when it finds none (`resolveHost`). Runner refuses that: only a key Runner
 * installed for a pairing may be stored as the host key, so a registration can never go out under a key nobody paired.
 */
import type { AgentConnection, HostIdentity, Keypair, ProviderConfig, Storage } from "@auth/agent";
import { thumbprintOf } from "./thumbprint.js";

/** Named secrets, as strings. On the owner's machine, the OS keychain. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** For tests only: secrets in memory. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(name: string) {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.values.delete(name);
  }
}

const HOST = "host";
const AGENTS = "agents";
const agentName = (id: string) => `agent:${id}`;

export class RunnerStorage implements Storage {
  private readonly secrets: SecretStore;
  private readonly providers = new Map<string, ProviderConfig>();

  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  private async read<T>(name: string): Promise<T | null> {
    const text = await this.secrets.get(name);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Runner's key store holds something it can't read. Run `forget`, then pair again.");
    }
  }

  /** Stores the key a pairing made as the host key, replacing any other. Runner's own path, never the SDK's. */
  async installHostKey(keypair: Keypair): Promise<void> {
    await this.secrets.set(HOST, JSON.stringify({ keypair, createdAt: Date.now() } satisfies HostIdentity));
  }

  async getHostIdentity(): Promise<HostIdentity | null> {
    return this.read<HostIdentity>(HOST);
  }

  /** The SDK's own write of a host key. Only the key already installed may be written back; any other is refused. */
  async setHostIdentity(host: HostIdentity): Promise<void> {
    const current = await this.getHostIdentity();
    if (!current || (await thumbprintOf(current.keypair.publicKey)) !== (await thumbprintOf(host.keypair.publicKey))) {
      throw new Error("refused: Runner stores only the host key a pairing made");
    }
    await this.secrets.set(HOST, JSON.stringify(host));
  }

  async deleteHostIdentity(): Promise<void> {
    await this.secrets.delete(HOST);
  }

  async getAgentConnection(agentId: string): Promise<AgentConnection | null> {
    return this.read<AgentConnection>(agentName(agentId));
  }

  /**
   * Stores the agent's connection, slimmed to what Runner uses (H1 on #454): its IDs, issuer, mode, keypair and the names
   * of its active grants. The plugin's answer also carries each grant's description and schemas, about 14 KB in all,
   * which is more than macOS's keychain tool takes on one line; Runner reads those from the gateway when it needs them.
   * The agent is named in the index first, so a write that fails part way is still found and deleted by `deleteAll`.
   */
  async setAgentConnection(agentId: string, connection: AgentConnection): Promise<void> {
    const ids = (await this.read<string[]>(AGENTS)) ?? [];
    if (!ids.includes(agentId)) await this.secrets.set(AGENTS, JSON.stringify([...ids, agentId]));
    const slim: AgentConnection = {
      agentId: connection.agentId,
      hostId: connection.hostId,
      providerName: connection.providerName,
      issuer: connection.issuer,
      mode: connection.mode,
      agentKeypair: connection.agentKeypair,
      capabilityGrants: connection.capabilityGrants.filter((grant) => grant.status === "active").map((grant) => ({ capability: grant.capability, status: "active" })),
      createdAt: connection.createdAt,
    };
    await this.secrets.set(agentName(agentId), JSON.stringify(slim));
  }

  async deleteAgentConnection(agentId: string): Promise<void> {
    await this.secrets.delete(agentName(agentId));
    const ids = (await this.read<string[]>(AGENTS)) ?? [];
    if (ids.includes(agentId)) await this.secrets.set(AGENTS, JSON.stringify(ids.filter((id) => id !== agentId)));
  }

  async listAgentConnections(): Promise<AgentConnection[]> {
    const ids = (await this.read<string[]>(AGENTS)) ?? [];
    const found = await Promise.all(ids.map((id) => this.getAgentConnection(id)));
    return found.filter((connection): connection is AgentConnection => connection !== null);
  }

  /** Deletes every key Runner holds: the host key and each agent's. */
  async deleteAll(): Promise<void> {
    for (const id of (await this.read<string[]>(AGENTS)) ?? []) await this.secrets.delete(agentName(id));
    await this.secrets.delete(AGENTS);
    await this.secrets.delete(HOST);
  }

  async getProviderConfig(issuer: string): Promise<ProviderConfig | null> {
    return this.providers.get(issuer) ?? null;
  }

  async setProviderConfig(issuer: string, config: ProviderConfig): Promise<void> {
    this.providers.set(issuer, config);
  }

  async listProviderConfigs(): Promise<ProviderConfig[]> {
    return [...this.providers.values()];
  }
}
