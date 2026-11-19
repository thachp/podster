// Pairing from the machine, against the stand-in gateway: a fresh proof each time, one agent registered and reused,
// waiting while unclaimed, and a retired key after any pairing that's canceled or refused.
import { describe, expect, it } from "vitest";
import { RUNNER_CAPABILITIES } from "../src/core/capabilities.js";
import { pair, type PairingDeps, type PairingNotice } from "../src/core/pairing.js";
import { MemoryStateStore } from "../src/core/state.js";
import { MemorySecretStore } from "../src/core/storage.js";
import { AGENT, CODE, FakeGateway, ORIGIN, TestClock } from "./fake-gateway.js";

function setup(consent = true) {
  const clock = new TestClock();
  const gateway = new FakeGateway(clock);
  const secrets = new MemorySecretStore();
  const state = new MemoryStateStore();
  const notices: PairingNotice[] = [];
  const logged: string[] = [];
  const asked: { origin: string; agentId: string }[] = [];
  const deps: PairingDeps = {
    origin: ORIGIN,
    fetch: gateway.fetch,
    secrets,
    state,
    clock,
    log: (at, outcome, fields) => void logged.push(JSON.stringify({ at, outcome, ...fields })),
    consent: async (details) => {
      asked.push(details);
      return consent;
    },
    notify: (notice) => void notices.push(notice),
  };
  // The person confirms in Podster after Runner's first wait.
  clock.onIdle = () => {
    if (gateway.session === "redeemed" && gateway.registrations.length > 0) gateway.session = "confirmed";
  };
  return { clock, gateway, secrets, state, notices, logged, asked, deps };
}

describe("pairing from the machine", () => {
  it("registers without `get_repo_access` only where the deployment doesn't list it, and drops nothing else (M7 step 10)", async () => {
    const { gateway, deps } = setup();
    gateway.listed = (c) => c !== "get_repo_access";
    expect((await pair(deps, { agentId: AGENT, code: CODE })).outcome).toBe("connected");
    expect(gateway.refusedRegistrations).toEqual([[...RUNNER_CAPABILITIES]]);
    expect(gateway.registrations).toEqual([{ capabilities: RUNNER_CAPABILITIES.filter((c) => c !== "get_repo_access"), name: "Podster Runner" }]);
  });

  it("asks consent, shows the whole thumbprint, redeems with a fresh proof, registers one agent within the allowlist, and waits for confirmation", async () => {
    const { gateway, deps, notices, asked, state, secrets, logged } = setup();
    const result = await pair(deps, { agentId: AGENT, code: CODE });
    expect(result.outcome).toBe("connected");
    expect(asked).toEqual([{ origin: ORIGIN, agentId: AGENT }]);
    const shown = notices.find((n) => n.kind === "thumbprint");
    expect(shown).toMatchObject({ kind: "thumbprint", thumbprint: result.thumbprint });
    expect(shown && "grouped" in shown && shown.grouped.replaceAll(" ", "")).toBe(result.thumbprint);
    expect(shown && "grouped" in shown && shown.grouped.split(" ").slice(0, -1).every((g) => g.length === 4)).toBe(true);
    // The proof: the session's agent as issuer and subject, the gateway as audience, no agent key.
    expect(gateway.proofs).toHaveLength(1);
    expect(gateway.proofs[0].payload).toMatchObject({ iss: AGENT, sub: AGENT, aud: ORIGIN });
    expect(gateway.proofs[0].payload.agent_public_key).toBeUndefined();
    expect(gateway.registrations).toEqual([{ capabilities: [...RUNNER_CAPABILITIES], name: "Podster Runner" }]);
    const record = await state.load();
    expect(record).toMatchObject({ phase: "connected", agent_id: AGENT, plugin_agent_id: gateway.pluginAgent, plugin_host_id: gateway.hostId, thumbprint: result.thumbprint, stopped: null, gateway: ORIGIN });
    // The record holds no key; the key store does.
    expect(JSON.stringify(record)).not.toMatch(/"d":/);
    expect([...secrets.values.keys()].sort()).toEqual(["agent:plugin_agent_one", "agents", "host"]);
    // Every capability call names only its one capability.
    expect(gateway.agentJwts.every((jwt) => Array.isArray(jwt.payload.capabilities) && (jwt.payload.capabilities as string[]).length === 1)).toBe(true);
    // Logs: IDs and fixed outcomes, never the code.
    expect(logged.join("\n")).not.toContain(CODE);
  });

  it("treats agent_unclaimed as waiting, asking again with a backoff, until the person confirms", async () => {
    const { gateway, deps, clock } = setup();
    let waits = 0;
    clock.onIdle = () => {
      if (gateway.registrations.length > 0 && ++waits === 4) gateway.session = "confirmed";
    };
    expect((await pair(deps, { agentId: AGENT, code: CODE })).outcome).toBe("connected");
    const identity = gateway.calls.filter((c) => c.capability === "get_identity");
    expect(identity).toHaveLength(5);
    expect(clock.idles.slice(0, 4)).toEqual([2000, 3000, 4500, 6750]);
  });

  it("stops waiting after its bound, keeps the pairing, and carries on waiting when run again, without a code or a second registration", async () => {
    const { gateway, deps, clock, state } = setup();
    clock.onIdle = null;
    const first = await pair({ ...deps, confirmWithinMs: 60_000 }, { agentId: AGENT, code: CODE });
    expect(first.outcome).toBe("waiting");
    expect((await state.load()).phase).toBe("registered");
    gateway.session = "confirmed";
    const again = await pair(deps, { agentId: AGENT });
    expect(again).toMatchObject({ outcome: "connected", thumbprint: first.thumbprint });
    expect(gateway.registrations).toHaveLength(1);
    expect(gateway.proofs).toHaveLength(1);
  });

  it("retries a redeem it couldn't finish with the same key and a fresh proof each time", async () => {
    const { gateway, deps, clock } = setup();
    gateway.redeemScript = ["network", 503, 429];
    expect((await pair(deps, { agentId: AGENT, code: CODE })).outcome).toBe("connected");
    // Four proofs reached it, each with its own jti, all signed by the same key.
    expect(gateway.proofs).toHaveLength(3);
    const jtis = new Set(gateway.proofs.map((p) => p.payload.jti));
    expect(jtis.size).toBe(3);
    expect(new Set(gateway.proofs.map((p) => JSON.stringify(p.payload.host_public_key))).size).toBe(1);
    // The 429 asked for two seconds.
    expect(clock.idles.slice(0, 3)).toEqual([2000, 4000, 2000]);
  });

  it("leaves an unreachable gateway to the owner with the key kept, and the same key redeems when run again", async () => {
    const { gateway, deps, state } = setup();
    gateway.redeemScript = ["network", "network", "network", "network", "network"];
    const first = await pair(deps, { agentId: AGENT, code: CODE });
    expect(first.outcome).toBe("unreachable");
    expect((await state.load()).phase).toBe("key_made");
    const again = await pair(deps, { agentId: AGENT, code: CODE });
    expect(again).toMatchObject({ outcome: "connected", thumbprint: first.thumbprint });
  });

  it("retires the key after a refused redeem: it's never used again, and the next pairing makes a new one", async () => {
    const { gateway, deps, state, secrets } = setup();
    gateway.code = "d".repeat(43);
    const refused = await pair(deps, { agentId: AGENT, code: CODE });
    expect(refused.outcome).toBe("pairing_ended");
    const record = await state.load();
    expect(record.stopped).toBe("pairing_ended");
    expect(record.retired).toHaveLength(1);
    const retired = record.retired[0];
    expect(secrets.values.size).toBe(0);
    expect(gateway.registrations).toHaveLength(0);
    // The person starts again; the same code now works, and Runner makes a new key.
    gateway.code = CODE;
    const next = await pair(deps, { agentId: AGENT, code: CODE });
    expect(next.outcome).toBe("connected");
    expect(next.thumbprint).not.toBe(retired);
    expect(gateway.proofs.map((p) => JSON.stringify(p.payload.host_public_key)).filter((k, i, all) => all.indexOf(k) === i)).toHaveLength(2);
  });

  it("on agent_revoked while waiting (the pairing was canceled or expired), stops, retires the key and never registers with it again", async () => {
    const { gateway, deps, clock, state, secrets } = setup();
    clock.onIdle = () => {
      gateway.session = "canceled";
    };
    const ended = await pair(deps, { agentId: AGENT, code: CODE });
    expect(ended.outcome).toBe("pairing_ended");
    const record = await state.load();
    expect(record).toMatchObject({ stopped: "pairing_ended", phase: null, plugin_agent_id: null });
    expect(record.retired).toContain(ended.thumbprint);
    expect(secrets.values.size).toBe(0);
    // Running pair again for the same agent can't reuse it: there is no key, and a new one is made for a new pairing.
    gateway.session = "pending";
    gateway.hostKey = null;
    clock.onIdle = () => {
      if (gateway.session === "redeemed") gateway.session = "confirmed";
    };
    const next = await pair(deps, { agentId: AGENT, code: CODE });
    expect(next.thumbprint).not.toBe(ended.thumbprint);
    expect(gateway.registrations).toHaveLength(2);
  });

  it("never registers again when registration's answer was lost", async () => {
    const { gateway, deps, state } = setup();
    gateway.registerScript = ["network"];
    const lost = await pair(deps, { agentId: AGENT, code: CODE });
    expect(lost.outcome).toBe("registration_unknown");
    expect((await state.load()).stopped).toBe("registration_unknown");
    const again = await pair(deps, { agentId: AGENT, code: CODE });
    // Running pair again for the same agent is a new pairing with a new key, never a second registration with this one.
    expect(again.thumbprint).not.toBe(lost.thumbprint);
    expect((await state.load()).retired).toContain(lost.thumbprint);
  });

  it("records registering before it registers, so a crash there never registers twice", async () => {
    const { gateway, deps, state } = setup();
    const crashed = new MemoryStateStore();
    // A pairing that crashed mid-registration: the record says registering.
    const first = await pair({ ...deps, state: crashed }, { agentId: AGENT, code: CODE });
    expect(first.outcome).toBe("connected");
    const record = await crashed.load();
    await state.save({ ...record, phase: "registering", plugin_agent_id: null });
    const registrations = gateway.registrations.length;
    const resumed = await pair({ ...deps, state }, { agentId: AGENT });
    expect(resumed.outcome).toBe("registration_unknown");
    expect(gateway.registrations).toHaveLength(registrations);
  });

  it("ends the pairing when registration is refused or would need an approval: it asked for nothing more than the host's defaults", async () => {
    const refused = setup();
    refused.gateway.registerScript = [403];
    expect((await pair(refused.deps, { agentId: AGENT, code: CODE })).outcome).toBe("pairing_ended");
    const pending = setup();
    pending.gateway.registerStatus = "pending";
    expect((await pair(pending.deps, { agentId: AGENT, code: CODE })).outcome).toBe("pairing_ended");
    expect((await pending.state.load()).retired).toHaveLength(1);
  });

  it("makes nothing when the owner declines, and refuses a code or agent that isn't Podster's shape before any key", async () => {
    const declined = setup(false);
    expect((await pair(declined.deps, { agentId: AGENT, code: CODE })).outcome).toBe("declined");
    expect(declined.secrets.values.size).toBe(0);
    expect(declined.gateway.asked).toHaveLength(0);
    const { deps, secrets } = setup();
    await expect(pair(deps, { agentId: AGENT, code: "short" })).rejects.toThrow();
    await expect(pair(deps, { agentId: "../../v1/x", code: CODE })).rejects.toThrow();
    expect(secrets.values.size).toBe(0);
  });

  it("refuses to pair a connected Runner again until the owner runs forget", async () => {
    const { deps } = setup();
    expect((await pair(deps, { agentId: AGENT, code: CODE })).outcome).toBe("connected");
    expect((await pair(deps, { agentId: "agt_ffffffffffffffffffffffffffffffff", code: CODE })).outcome).toBe("already_paired");
  });

  it("ends the pairing if Podster says it is another agent", async () => {
    const { gateway, deps } = setup();
    gateway.identity = "agt_someone_else";
    expect((await pair(deps, { agentId: AGENT, code: CODE })).outcome).toBe("pairing_ended");
  });
});
