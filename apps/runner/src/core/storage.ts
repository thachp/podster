/**
 * Runner's keys, behind the SDK's `Storage` interface (M7 plan, the architect's ruling 3 on spike A): the SDK has no
 * keychain store, so Runner gives it this one, over a `SecretStore` that on the owner's machine is the OS keychain
 * (`src/node/keychain.ts`), or on Linux without a Secret Service, owner-only files (`src/node/key-store.ts`, S-47).
 *
 * What it holds: the host key (the one pairing binds), and the one agent connection Runner registers on that host, each
 * with its private key; and, only once the owner switches the inbound nudge on (M7 step 14), the nudge endpoint's signing
 * secret with the URL, agent and registration version it was issued for, as an item of its own. Provider discovery documents aren't secret, and the SDK finds them again at each start, so they
 * stay in memory.
 *
 * The SDK makes a host key by itself when it finds none (`resolveHost`). Runner refuses that: only a key Runner
 * installed for a pairing may be stored as the host key, so a registration can never go out under a key nobody paired.
 */
import type { AgentConnection, HostIdentity, Keypair, ProviderConfig, Storage } from "@auth/agent";
import { STORED_CAPABILITY_BITS } from "./capabilities.js";
import { isRegistration, type NudgeRegistration } from "./nudge.js";
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
const NUDGE = "nudge";
const AGENTS = "agents";
const agentName = (id: string) => `agent:${id}`;

/** An agent connection as Runner stores it since issue 527. Short names, since every byte counts twice on macOS. */
type CompactConnection = {
  v: 2;
  /** agentId, hostId, providerName, issuer, mode */
  a: string;
  h: string;
  p: string;
  i: string;
  m: AgentConnection["mode"];
  /** The private key, whose public half is itself without `d`; or `kp`, the whole keypair, when it isn't. */
  k?: Keypair["privateKey"];
  kp?: Keypair;
  /** The active grants in `STORED_CAPABILITY_BITS`, as a bitset in lowercase hex. */
  g: string;
  /** Any other active grants, by name. Left out when there are none. */
  n?: string[];
  t: number;
};

const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isJwk = (value: unknown): value is Keypair["privateKey"] => isObject(value) && isString(value.kty);
const isKeypair = (value: unknown): value is Keypair => isObject(value) && isJwk(value.publicKey) && isJwk(value.privateKey);

/** The public half of a private JWK: the same members without `d`. */
function publicOf(privateKey: Keypair["privateKey"]): Keypair["publicKey"] {
  const { d: _d, ...rest } = privateKey;
  return rest;
}

function sameJwk(a: Keypair["publicKey"], b: Keypair["publicKey"]): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function compact(connection: AgentConnection): CompactConnection {
  const active = [...new Set(connection.capabilityGrants.filter((grant) => grant.status === "active").map((grant) => grant.capability))];
  let bits = 0n;
  const named: string[] = [];
  for (const capability of active) {
    const bit = STORED_CAPABILITY_BITS.indexOf(capability);
    if (bit >= 0) bits |= 1n << BigInt(bit);
    else named.push(capability);
  }
  const { publicKey, privateKey } = connection.agentKeypair;
  const derivable = isString(privateKey.d) && sameJwk(publicKey, publicOf(privateKey));
  return {
    v: 2,
    a: connection.agentId,
    h: connection.hostId,
    p: connection.providerName,
    i: connection.issuer,
    m: connection.mode,
    ...(derivable ? { k: privateKey } : { kp: connection.agentKeypair }),
    g: bits.toString(16),
    ...(named.length > 0 ? { n: named } : {}),
    t: connection.createdAt,
  };
}

function isCompact(value: unknown): value is CompactConnection {
  if (!isObject(value) || value.v !== 2) return false;
  if (![value.a, value.h, value.p, value.i, value.m].every(isString)) return false;
  if (typeof value.t !== "number" || !isString(value.g) || !/^[0-9a-f]{1,64}$/.test(value.g)) return false;
  if (value.n !== undefined && !(Array.isArray(value.n) && value.n.every(isString))) return false;
  return value.k !== undefined ? isJwk(value.k) && isString(value.k.d) && value.kp === undefined : isKeypair(value.kp);
}

/** A record in the slim form Runner stored before issue 527: an `AgentConnection` with only active grant names. */
function isSlim(value: unknown): value is AgentConnection {
  if (!isObject(value) || value.v !== undefined) return false;
  if (![value.agentId, value.hostId, value.providerName, value.issuer, value.mode].every(isString)) return false;
  return typeof value.createdAt === "number" && isKeypair(value.agentKeypair) && Array.isArray(value.capabilityGrants) && value.capabilityGrants.every((grant) => isObject(grant) && isString(grant.capability) && isString(grant.status));
}

function expand(record: CompactConnection): AgentConnection {
  const bits = BigInt(`0x${record.g}`);
  // A bit past the table's end came from a later Runner's table: a capability this one doesn't know, so not one it uses.
  const fromBits = STORED_CAPABILITY_BITS.filter((_, bit) => (bits >> BigInt(bit)) & 1n);
  const agentKeypair = record.k !== undefined ? { publicKey: publicOf(record.k), privateKey: record.k } : (record.kp as Keypair);
  return {
    agentId: record.a,
    hostId: record.h,
    providerName: record.p,
    issuer: record.i,
    mode: record.m,
    agentKeypair,
    capabilityGrants: [...fromBits, ...(record.n ?? [])].map((capability) => ({ capability, status: "active" as const })),
    createdAt: record.t,
  };
}

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

  /**
   * The agent's connection. A record in the compact form (`v: 2`, issue 527) is expanded; one in the slim form Runner
   * stored before it (H1 on #454) is read as it is, and is rewritten compactly at the next write. Anything else reads as
   * an error, never as no connection.
   */
  async getAgentConnection(agentId: string): Promise<AgentConnection | null> {
    const value = await this.read<unknown>(agentName(agentId));
    if (value === null) return null;
    const connection = isCompact(value) ? expand(value) : isSlim(value) ? value : null;
    if (!connection) throw new Error("Runner's key store holds something it can't read. Run `forget`, then pair again.");
    return connection;
  }

  /**
   * Stores the agent's connection in the compact form (issue 527): its IDs, issuer, mode, private key and the names of
   * its active grants as a bitset over `STORED_CAPABILITY_BITS`, with any name not in that table listed by name. The
   * plugin's answer also carries each grant's description and schemas, about 14 KB in all, which is more than macOS's
   * keychain tool takes on one line (H1 on #454); Runner reads those from the gateway when it needs them. The public key
   * is the private key without `d`, so only the private key is kept; a keypair that isn't shaped so is kept whole.
   * The agent is named in the index first, so a write that fails part way is still found and deleted by `deleteAll`.
   */
  async setAgentConnection(agentId: string, connection: AgentConnection): Promise<void> {
    const ids = (await this.read<string[]>(AGENTS)) ?? [];
    if (!ids.includes(agentId)) await this.secrets.set(AGENTS, JSON.stringify([...ids, agentId]));
    await this.secrets.set(agentName(agentId), JSON.stringify(compact(connection)));
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

  /** The nudge endpoint's registration, or null. Anything stored that isn't one reads as an error, never as none. */
  async getNudge(): Promise<NudgeRegistration | null> {
    const value = await this.read<unknown>(NUDGE);
    if (value === null) return null;
    if (!isRegistration(value)) throw new Error("Runner's key store holds something it can't read. Run `forget`, then pair again.");
    return value;
  }

  async setNudge(registration: NudgeRegistration): Promise<void> {
    if (!isRegistration(registration)) throw new Error("not a nudge registration");
    await this.secrets.set(NUDGE, JSON.stringify({ url: registration.url, agent_id: registration.agent_id, version: registration.version, secret: registration.secret }));
  }

  async deleteNudge(): Promise<void> {
    await this.secrets.delete(NUDGE);
  }

  /** Deletes every key Runner holds: the host key, each agent's, and the nudge endpoint's secret. */
  async deleteAll(): Promise<void> {
    await this.secrets.delete(NUDGE);
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
