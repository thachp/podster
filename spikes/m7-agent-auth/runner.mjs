// A stand-in for Podster Runner: a plain Node process with no browser, using the pinned Agent Auth client SDK
// (@auth/agent 0.6.2). Throwaway spike code. Nothing builds on it.
//
//   node runner.mjs <command> --base <gateway URL> --state <dir>
//
// Commands:
//   connect      generate keys locally, register one delegated agent, print the approval to stdout, wait until a person
//                approves it in Podster, then call read_inbox once
//   inbox        a restart: a new process loads the stored key and calls read_inbox, with no browser and no person
//   status       a restart that only asks /agent/status with the host key
//   rotate       try the plugin's agent key rotation
//   disconnect   try the SDK's own disconnect (the plugin's /agent/revoke)
//
// Each command prints one JSON line on stdout with what happened. It never prints a key, a JWT or the stored file.
import { AgentAuthClient, KVStorage } from "@auth/agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const base = option("base");
const state = option("state");
if (!command || !base || !state) {
  console.error("Usage: node runner.mjs <connect|inbox|status|rotate|disconnect> --base <url> --state <dir>");
  process.exit(2);
}

// The SDK's storage is a small interface. This one is a JSON file readable only by its owner: the stand-in for an OS
// keychain, which a real Runner would use where it's validated (RUNNER.md, local key protection).
mkdirSync(state, { recursive: true, mode: 0o700 });
const file = join(state, "agent-auth.json");
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const kv = {
  get: async (key) => load()[key] ?? null,
  set: async (key, value) => {
    const all = load();
    all[key] = value;
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  },
  del: async (key) => {
    const all = load();
    delete all[key];
    writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
  },
};
const storage = new KVStorage(kv, { prefix: "podster-runner" });

// Only the gateway's own URL: no directory, so the SDK never discovers providers from anywhere else.
const client = new AgentAuthClient({
  storage,
  urls: [base],
  hostName: "spike-runner",
  approvalTimeoutMs: 120_000,
  // A person reads the code in Runner and types it into Podster's claim page. Here the harness reads this line.
  onApprovalRequired: (approval) => out({ event: "approval_required", method: approval.method, user_code: approval.user_code, verification_uri: approval.verification_uri, verification_uri_complete: approval.verification_uri_complete ?? null, expires_in: approval.expires_in, interval: approval.interval }),
});

function out(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function stored() {
  const connections = await storage.listAgentConnections();
  return connections[0] ?? null;
}

const errorOf = (error) => ({ name: error?.name, code: error?.code, status: error?.status, message: error?.message });

try {
  await client.init();
  if (command === "connect") {
    const capabilities = ["get_identity", "read_inbox"];
    const result = await client.connectAgent({ provider: base, capabilities, mode: "delegated", preferredMethod: "device_authorization", name: "Spike Runner" });
    out({ event: "connected", agent_id: result.agentId, status: result.status, grants: result.capabilityGrants?.map((g) => `${g.capability}:${g.status}`) });
    const inbox = await client.executeCapability({ agentId: result.agentId, capability: "read_inbox", arguments: {} });
    out({ event: "read_inbox", ok: true, keys: Object.keys(inbox?.data ?? {}) });
  } else if (command === "inbox" || command === "status") {
    const connection = await stored();
    if (!connection) throw Object.assign(new Error("no stored connection"), { code: "no_connection" });
    const mode = statSync(file).mode & 0o777;
    if (command === "status") {
      const status = await client.agentStatus(connection.agentId);
      out({ event: "status", agent_id: connection.agentId, status: status.status, file_mode: mode.toString(8) });
    } else {
      const identity = await client.executeCapability({ agentId: connection.agentId, capability: "get_identity", arguments: {} });
      const inbox = await client.executeCapability({ agentId: connection.agentId, capability: "read_inbox", arguments: {} });
      out({ event: "reconnected", agent_id: connection.agentId, podster_agent: identity?.data?.id ?? null, inbox_keys: Object.keys(inbox?.data ?? {}), file_mode: mode.toString(8) });
    }
  } else if (command === "rotate") {
    const connection = await stored();
    const result = await client.rotateAgentKey(connection.agentId);
    out({ event: "rotated", result });
  } else if (command === "disconnect") {
    const connection = await stored();
    await client.disconnectAgent(connection.agentId);
    out({ event: "sdk_disconnect_returned", local_connection_left: Boolean(await stored()) });
  } else {
    throw new Error(`unknown command ${command}`);
  }
  client.destroy();
} catch (error) {
  out({ event: "error", command, error: errorOf(error) });
  client.destroy();
  process.exitCode = 1;
}
