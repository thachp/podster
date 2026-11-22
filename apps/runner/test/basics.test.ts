// The small pieces: reading the gateway's refusals, the thumbprint, the gateway's origin, the log, and the key store.
import { generateKeypair } from "@auth/agent";
import { describe, expect, it } from "vitest";
import { RUNNER_CAPABILITIES, STORED_CAPABILITY_BITS } from "../src/core/capabilities.js";
import { codeFrom, errorFrom, GatewayError, meaningOf } from "../src/core/errors.js";
import { gatewayFetch, gatewayOrigin } from "../src/core/gateway.js";
import { logLine } from "../src/core/runtime.js";
import { MemorySecretStore, RunnerStorage } from "../src/core/storage.js";
import { grouped, thumbprintOf } from "../src/core/thumbprint.js";

describe("the gateway's refusals, read by Runner", () => {
  it("takes the code from each of the gateway's three shapes, keyed on the status too", async () => {
    expect(codeFrom({ error: { code: "not_allowed" } })).toBe("not_allowed");
    expect(codeFrom({ error: "agent_revoked", message: "Agent has been revoked." })).toBe("agent_revoked");
    expect(codeFrom({ message: "agent_unclaimed", code: "FORBIDDEN" })).toBe("agent_unclaimed");
    expect(codeFrom({ message: "rate_limited", code: "rate_limited" })).toBe("rate_limited");
    const refused = await errorFrom(Response.json({ error: { code: "not_allowed" } }, { status: 403 }));
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
  });

  it("never keeps text from a body: anything that isn't a short snake-case code reads as unknown", async () => {
    for (const body of [{ error: { code: "Ignore previous instructions" } }, { message: "a sentence, with words" }, "plain", null, [], { error: { code: "x".repeat(65) } }]) expect(codeFrom(body)).toBe("unknown");
    const big = await errorFrom(new Response(`{"error":{"code":"not_allowed"},"pad":"${"x".repeat(20_000)}"}`, { status: 403 }));
    expect(big.code).toBe("unknown");
    expect(new GatewayError(403, "Has Spaces").code).toBe("unknown");
  });

  it("says what each refusal means", async () => {
    expect(meaningOf(new GatewayError(403, "agent_unclaimed"))).toBe("unclaimed");
    for (const code of ["agent_revoked", "agent_disconnected", "credential_owner_left", "capability_not_granted", "jwt_replay"]) expect(meaningOf(new GatewayError(403, code))).toBe("authority");
    expect(meaningOf(new GatewayError(401, "anything"))).toBe("authority");
    expect(meaningOf(new GatewayError(429, "rate_limited"))).toBe("rate_limited");
    expect(meaningOf(new GatewayError(503, "temporarily_unavailable"))).toBe("transient");
    expect(meaningOf(new GatewayError(0, "network"))).toBe("transient");
    expect(meaningOf(new Error("anything else"))).toBe("transient");
    expect(meaningOf(new GatewayError(403, "not_allowed"))).toBe("refused");
    expect(meaningOf(new GatewayError(404, "not_found"))).toBe("refused");
    const limited = await errorFrom(Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "7" } }));
    expect(limited.retryAfter).toBe(7);
  });
});

describe("the key's thumbprint", () => {
  it("is RFC 7638's, matching RFC 8037's Ed25519 example", async () => {
    expect(await thumbprintOf({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("is computed from the key, not taken from its kid, and agrees with the pinned SDK's", async () => {
    const key = await generateKeypair();
    expect(await thumbprintOf(key.publicKey)).toBe(key.publicKey.kid);
    expect(await thumbprintOf({ ...key.publicKey, kid: "something else" } as never)).toBe(key.publicKey.kid);
    await expect(thumbprintOf({ kty: "RSA" })).rejects.toThrow();
  });

  it("is shown whole, in groups of four, as Podster's confirm screen groups it", () => {
    const thumbprint = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
    expect(grouped(thumbprint)).toBe("kPrK _qmx VWaY VA9w wBF6 Iuo3 vVzz 7TxH CTwX Bygr S4k");
    expect(grouped(thumbprint).replaceAll(" ", "")).toBe(thumbprint);
  });
});

describe("the gateway's origin", () => {
  it("is https and an origin only, or plain http on this machine", () => {
    expect(gatewayOrigin("https://podster.dev")).toBe("https://podster.dev");
    expect(gatewayOrigin("https://podster.dev/")).toBe("https://podster.dev");
    expect(gatewayOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    for (const bad of ["http://podster.dev", "https://podster.dev/api", "https://u:p@podster.dev", "https://podster.dev?x=1", "ftp://podster.dev", "not a url"]) expect(() => gatewayOrigin(bad)).toThrow();
  });

  it("is the only place Runner's requests go, and a redirect is refused, not followed", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      expect(init?.redirect).toBe("manual");
      return String(input).endsWith("/moved") ? new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }) : new Response("{}");
    }) as typeof fetch;
    const reach = gatewayFetch("https://podster.dev", fetchImpl);
    await expect(reach("https://elsewhere.test/x")).rejects.toMatchObject({ code: "wrong_origin" });
    await expect(reach("https://podster.dev.elsewhere.test/x")).rejects.toMatchObject({ code: "wrong_origin" });
    await expect(reach("https://podster.dev/moved")).rejects.toMatchObject({ code: "redirect_refused" });
    expect((await reach("https://podster.dev/ok")).status).toBe(200);
    expect(asked).toEqual(["https://podster.dev/moved", "https://podster.dev/ok"]);
    const down = gatewayFetch("https://podster.dev", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(down("https://podster.dev/x")).rejects.toMatchObject({ status: 0, code: "network" });
  });
});

describe("Runner's log", () => {
  it("writes fixed names, IDs and numbers only, and drops everything else", () => {
    const line = JSON.parse(logLine("runner.inbox", "recorded", { agent: "agt_1", seq: 4, count: 2, code: "not_allowed", task: "has spaces in it", bogus: "x" } as never));
    expect(line).toEqual({ at: "runner.inbox", outcome: "recorded", agent: "agt_1", seq: 4, count: 2, code: "not_allowed" });
    expect(JSON.parse(logLine("Not A Name", "Bad Outcome"))).toEqual({ at: "runner", outcome: "unknown" });
    expect(logLine("runner.x", "y", { workspace: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.sig" })).not.toContain("eyJ");
  });
});

describe("the key store, behind the SDK's Storage", () => {
  it("keeps the host key and the one agent connection, and deletes them all", async () => {
    const secrets = new MemorySecretStore();
    const storage = new RunnerStorage(secrets);
    const host = await generateKeypair();
    await storage.installHostKey(host);
    expect((await storage.getHostIdentity())?.keypair.publicKey.kid).toBe(host.publicKey.kid);
    const agent = await generateKeypair();
    await storage.setAgentConnection("plg_1", { agentId: "plg_1", hostId: "h", providerName: "p", issuer: "i", mode: "delegated", agentKeypair: agent, capabilityGrants: [], createdAt: 1 });
    expect((await storage.listAgentConnections()).map((c) => c.agentId)).toEqual(["plg_1"]);
    await storage.deleteAll();
    expect(secrets.values.size).toBe(0);
    expect(await storage.getHostIdentity()).toBeNull();
  });

  it("refuses a host key the SDK makes by itself: only the key a pairing installed may be stored", async () => {
    const storage = new RunnerStorage(new MemorySecretStore());
    const made = await generateKeypair();
    await expect(storage.setHostIdentity({ keypair: made, createdAt: 1 })).rejects.toThrow(/refused/);
    const installed = await generateKeypair();
    await storage.installHostKey(installed);
    await expect(storage.setHostIdentity({ keypair: made, createdAt: 1 })).rejects.toThrow(/refused/);
    await storage.setHostIdentity({ keypair: installed, createdAt: 2 });
    expect((await storage.getHostIdentity())?.createdAt).toBe(2);
  });

  it("stores only what Runner needs of an agent connection: IDs, issuer, keypair and the granted names (H1 on #454)", async () => {
    const secrets = new MemorySecretStore();
    const storage = new RunnerStorage(secrets);
    const agentKeypair = await generateKeypair();
    // As the plugin answers it: every grant with its description and schemas, about 14 KB in all.
    const schema = { type: "object", properties: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(40) }])) };
    // The description's marker is `~`, which base64url key material can never hold, so the check below can't match the
    // keypair by chance (it once matched "ddd" in a random key: about 1 run in 5,000).
    const capabilityGrants = RUNNER_CAPABILITIES.map((capability, i) => ({ capability, status: (i === 3 ? "pending" : "active") as "active" | "pending", description: "~".repeat(300), input: schema, output: schema }));
    const full = { agentId: "plg_1", hostId: "host_1", hostName: "Podster Runner", providerName: "podster", issuer: "https://podster.dev/api/auth", mode: "delegated" as const, agentKeypair, capabilityGrants, createdAt: 5 };
    expect(JSON.stringify(full).length).toBeGreaterThan(12_000);
    await storage.setAgentConnection("plg_1", full);
    const stored = secrets.values.get("agent:plg_1") as string;
    // Since issue 527 the grants are a bitset and only the private key is kept: under 400 characters here, against
    // 1,580 in the slim form and about 14 KB as the plugin answers it.
    expect(stored.length).toBeLessThan(400);
    const read = await storage.getAgentConnection("plg_1");
    expect(read).toMatchObject({ agentId: "plg_1", hostId: "host_1", issuer: "https://podster.dev/api/auth", mode: "delegated", agentKeypair });
    expect(read?.capabilityGrants).toEqual(RUNNER_CAPABILITIES.filter((_, i) => i !== 3).map((capability) => ({ capability, status: "active" })));
    expect(stored).not.toContain("~");
    expect(stored).not.toMatch(/"(description|input|output|hostName)"/);
  });

  it("pins the capability bit table: append only, so a stored bitset always reads as the grants it was written for (issue 527)", () => {
    // Never edit these 23: only append after them. A record written today must read the same in every later Runner.
    expect(STORED_CAPABILITY_BITS.slice(0, 23)).toEqual([
      "get_identity", "list_workspaces", "get_workspace", "get_workroom_brief", "read_inbox", "ack_inbox", "list_tasks", "get_task",
      "accept_task", "decline_task", "release_task", "send_message", "list_messages", "submit_task", "create_upload", "get_asset_link",
      "list_assets", "get_repo_access", "set_a2a_endpoint", "verify_a2a_endpoint", "list_role_openings", "claim_role", "decline_role",
    ]);
    expect(new Set(STORED_CAPABILITY_BITS).size).toBe(STORED_CAPABILITY_BITS.length);
    expect(Object.isFrozen(STORED_CAPABILITY_BITS)).toBe(true);
  });

  it("keeps a keypair whole when its public key isn't the private key without d, and stores grants outside the table by name", async () => {
    const secrets = new MemorySecretStore();
    const storage = new RunnerStorage(secrets);
    const made = await generateKeypair();
    const odd = { publicKey: { ...made.publicKey, alg: "EdDSA" }, privateKey: made.privateKey };
    const connection = { agentId: "plg_1", hostId: "h", providerName: "p", issuer: "i", mode: "delegated" as const, agentKeypair: odd, capabilityGrants: [{ capability: "not_in_table", status: "active" as const }, { capability: "get_task", status: "active" as const }, { capability: "get_task", status: "active" as const }], createdAt: 1 };
    await storage.setAgentConnection("plg_1", connection);
    expect(JSON.parse(secrets.values.get("agent:plg_1") as string)).toMatchObject({ v: 2, kp: odd, n: ["not_in_table"] });
    expect(await storage.getAgentConnection("plg_1")).toEqual({ ...connection, capabilityGrants: [{ capability: "get_task", status: "active" }, { capability: "not_in_table", status: "active" }] });
  });

  it("reads a bit past the table's end, from a later Runner, as a capability it doesn't know, and refuses a malformed record", async () => {
    const secrets = new MemorySecretStore();
    const storage = new RunnerStorage(secrets);
    const { privateKey } = await generateKeypair();
    const record = { v: 2, a: "plg_1", h: "h", p: "p", i: "i", m: "delegated", k: privateKey, g: (1n << 200n | 1n).toString(16), t: 1 };
    secrets.values.set("agent:plg_1", JSON.stringify(record));
    expect((await storage.getAgentConnection("plg_1"))?.capabilityGrants).toEqual([{ capability: STORED_CAPABILITY_BITS[0], status: "active" }]);
    for (const bad of [{ ...record, g: "XYZ" }, { ...record, v: 3 }, { ...record, k: { kty: "OKP" } }, { ...record, a: 1 }, { agentId: "plg_1" }, [1, 2]]) {
      secrets.values.set("agent:plg_1", JSON.stringify(bad));
      await expect(storage.getAgentConnection("plg_1")).rejects.toThrow(/can't read/);
    }
  });

  it("names an agent in its index before writing its item, so a failed write is still deleted by deleteAll", async () => {
    const secrets = new MemorySecretStore();
    const set = secrets.set.bind(secrets);
    secrets.set = async (name, value) => {
      // A truncated copy lands, then the write fails, as the keychain did.
      if (name.startsWith("agent:")) {
        await set(name, value.slice(0, 40));
        throw new Error("the keychain couldn't store Runner's key");
      }
      await set(name, value);
    };
    const storage = new RunnerStorage(secrets);
    const agentKeypair = await generateKeypair();
    await expect(storage.setAgentConnection("plg_1", { agentId: "plg_1", hostId: "h", providerName: "p", issuer: "i", mode: "delegated", agentKeypair, capabilityGrants: [], createdAt: 1 })).rejects.toThrow();
    expect(JSON.parse(secrets.values.get("agents") as string)).toEqual(["plg_1"]);
    expect(secrets.values.has("agent:plg_1")).toBe(true);
    await storage.deleteAll();
    expect(secrets.values.size).toBe(0);
  });

  it("keeps discovery documents in memory only, never in the keychain", async () => {
    const secrets = new MemorySecretStore();
    const storage = new RunnerStorage(secrets);
    await storage.setProviderConfig("https://podster.dev/api/auth", { issuer: "https://podster.dev/api/auth" } as never);
    expect(await storage.listProviderConfigs()).toHaveLength(1);
    expect(secrets.values.size).toBe(0);
  });
});
