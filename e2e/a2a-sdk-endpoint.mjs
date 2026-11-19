// The independent A2A 1.0 server for m7-nudge-interop-staging.mjs (M7 step 15, R-17): the A2A project's own JavaScript
// SDK, @a2a-js/sdk 1.3.0, behind its own Express JSON-RPC handler, as apps/api/test/a2a-sdk-endpoint.ts runs it for the
// local half. Only the script starts it, as a child process with child-env.mjs's allow-listed environment, and talks to
// it over the IPC channel: never over HTTP, since its one port is the one the owner's tunnel exposes.
//
//   PORT=<port> node a2a-sdk-endpoint.mjs     (with an IPC channel; it exits at once without one)
//
// It listens on 127.0.0.1 only. Paths, each `/<server>/<n>`:
// - `/plain/<n>`: the SDK alone, as any A2A 1.0 agent runs it;
// - `/ext/<n>`: the SDK with the owner's glue in front, which checks Podster's signature under the secret held for that
//   path, answers Podster's `podster.dev/verifyEndpoint` with the proof, and checks the bearer token held for it, if any;
// - `/old/<n>`: as `/ext`, but the SDK's card offers only A2A 0.3.
//
// IPC in: `{ hold: { path, secret, token } }`. IPC out: `{ listening: port }`, then `{ received: { server, message,
// a2aVersion } }` for each message the SDK handed its agent, as the SDK typed it. It prints nothing of its own; the script
// discards its output, so the SDK's own error lines go nowhere either.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { AgentCard, Role } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: PORT=<port> node a2a-sdk-endpoint.mjs, started by m7-nudge-interop-staging.mjs with an IPC channel.");
  process.exit(0);
}
if (!process.send) {
  console.error("a2a-sdk-endpoint.mjs is started by m7-nudge-interop-staging.mjs, with an IPC channel.");
  process.exit(2);
}
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) process.exit(2);

const held = new Map();
process.on("message", (message) => {
  if (message?.hold) held.set(message.hold.path, { secret: String(message.hold.secret), token: message.hold.token ?? null });
});
process.on("disconnect", () => process.exit(0));

const card = (name, protocolVersion) =>
  AgentCard.fromJSON({
    name,
    description: "An independent A2A server for Podster's nudge interoperability run.",
    version: "1.3.0",
    supportedInterfaces: [{ url: `http://127.0.0.1:${port}/${name}`, protocolBinding: "JSONRPC", protocolVersion }],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  });

const executor = (server) => ({
  async execute(context, bus) {
    const req = context.context?.requestedVersion;
    process.send({ received: { server, message: JSON.parse(JSON.stringify(context.userMessage)), a2aVersion: req ?? null } });
    bus.publish(AgentEvent.message({ messageId: randomUUID(), contextId: context.contextId, taskId: "", role: Role.ROLE_AGENT, parts: [{ content: { $case: "text", value: "Nudged." }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] }));
    bus.finished();
  },
  async cancelTask() {},
});
const sdk = (name, version) => jsonRpcHandler({ requestHandler: new DefaultRequestHandler(card(name, version), new InMemoryTaskStore(), executor(name)), userBuilder: UserBuilder.noAuthentication });

function signedBy(secret, header, body) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const want = createHmac("sha256", secret).update(`${match[1]}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(match[2], "hex")) && Math.abs(Number(match[1]) - Date.now() / 1000) <= 300;
}

/** The owner's glue: not Podster's code and not the SDK's. */
const ownersGlue = [
  express.json({ limit: "8kb", verify: (req, _res, buf) => void (req.raw = buf.toString("utf8")) }),
  (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    const keys = held.get(path);
    if (!keys) return void res.status(404).end();
    if (!signedBy(keys.secret, req.get("x-podster-signature"), req.raw ?? "")) return void res.status(401).end();
    const body = req.body;
    if (body?.method === "podster.dev/verifyEndpoint") {
      const { agent_id, version, challenge } = body.params ?? {};
      const proof = createHmac("sha256", keys.secret).update(`podster-endpoint-proof/1.${agent_id}.${version}.${challenge}`).digest("hex");
      return void res.json({ jsonrpc: "2.0", id: body.id, result: { proof } });
    }
    if (keys.token !== null && req.get("authorization") !== `Bearer ${keys.token}`) return void res.status(401).set("www-authenticate", 'Bearer realm="a2a"').end();
    next();
  },
];

const app = express();
app.disable("x-powered-by");
app.use("/plain/:n", sdk("plain", "1.0"));
app.use("/ext/:n", ...ownersGlue, sdk("ext", "1.0"));
app.use("/old/:n", ...ownersGlue, sdk("old", "0.3"));
const server = app.listen(port, "127.0.0.1", () => process.send({ listening: server.address().port }));
server.on("error", () => process.exit(1));
