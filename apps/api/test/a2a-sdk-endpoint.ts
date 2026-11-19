// M7 step 15 (R-17): an independent A2A 1.0 server for the nudge's outbound half, run by vitest.config.ts in Node, on
// 127.0.0.1 only. It is the A2A project's own JavaScript SDK, @a2a-js/sdk pinned at 1.3.0, served by the SDK's own Express
// JSON-RPC handler (`jsonRpcHandler`) and `DefaultRequestHandler`: they parse and validate what Podster sends, check its
// `A2A-Version` against the card, and write the answer Podster reads. None of it is Podster's code. The API's requests to
// the made-up public name a2a-sdk.example.com are forwarded here, as a2a-langgraph.spec.ts's are to LangGraph.
//
// Three servers, chosen by the path's first segment:
//
// - `/plain/<n>`: the SDK alone, as any A2A 1.0 agent would run it. It knows nothing of Podster.
// - `/ext/<n>`: the same SDK server with the owner's glue in front, as a Runner-like endpoint would need: it checks
//   Podster's signature under the secret held for that path, and the bearer token if one is held (the card's HTTP bearer
//   scheme), and answers Podster's `podster.dev/verifyEndpoint` extension method with the proof. Every A2A method goes on
//   to the SDK untouched.
// - `/old/<n>`: as `/ext`, but the SDK's card offers only A2A 0.3, so the SDK refuses Podster's 1.0 request itself.
//
// The test drives it through a2a-sdk-control.example.com: `POST /hold` gives a path its secret and token, as an endpoint
// keeps what Podster showed it, and `GET /received` answers each message the SDK handed its executor, as the SDK typed it.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { AgentCard, Role } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

export const A2A_SDK_HOST = "a2a-sdk.example.com";
export const A2A_SDK_CONTROL_HOST = "a2a-sdk-control.example.com";

type Held = { secret: string; token: string | null };
const held = new Map<string, Held>();
const received: { server: string; message: unknown }[] = [];

function card(name: string, protocolVersion: string, bearer: boolean) {
  return AgentCard.fromJSON({
    name,
    description: "An independent A2A server for Podster's nudge interoperability test.",
    version: "1.3.0",
    supportedInterfaces: [{ url: `https://${A2A_SDK_HOST}/${name}`, protocolBinding: "JSONRPC", protocolVersion }],
    capabilities: { streaming: false, pushNotifications: false },
    ...(bearer ? { securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] } : {}),
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  });
}

/** The agent behind each server: records the message the SDK parsed, and answers with a Message, as a nudge needs no task. */
function executor(server: string): AgentExecutor {
  return {
    async execute(context, bus) {
      received.push({ server, message: JSON.parse(JSON.stringify(context.userMessage)) });
      bus.publish(AgentEvent.message({ messageId: crypto.randomUUID(), contextId: context.contextId, taskId: "", role: Role.ROLE_AGENT, parts: [{ content: { $case: "text", value: "Nudged." }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] }));
      bus.finished();
    },
    async cancelTask() {},
  };
}

const sdk = (name: string, protocolVersion: string, bearer: boolean) =>
  jsonRpcHandler({ requestHandler: new DefaultRequestHandler(card(name, protocolVersion, bearer), new InMemoryTaskStore(), executor(name)), userBuilder: UserBuilder.noAuthentication });

function signedBy(secret: string, header: string | undefined, body: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const want = createHmac("sha256", secret).update(`${match[1]}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(match[2], "hex")) && Math.abs(Number(match[1]) - Date.now() / 1000) <= 300;
}

/** The owner's glue in front of the SDK. Not Podster's code, and not the SDK's: what an endpoint's owner would add. */
const ownersGlue = [
  express.json({ verify: (req, _res, buf) => void ((req as unknown as { raw: string }).raw = buf.toString("utf8")) }),
  (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const path = req.originalUrl.split("?")[0];
    const keys = held.get(path);
    if (!keys) return void res.status(404).end();
    const raw = (req as unknown as { raw?: string }).raw ?? "";
    if (!signedBy(keys.secret, req.get("x-podster-signature"), raw)) return void res.status(401).end();
    const body = req.body as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    // Podster's extension method: authenticated by its signature, and answered here, since A2A has no such method.
    if (body?.method === "podster.dev/verifyEndpoint") {
      const { agent_id, version, challenge } = body.params ?? {};
      const proof = createHmac("sha256", keys.secret).update(`podster-endpoint-proof/1.${agent_id}.${version}.${challenge}`).digest("hex");
      return void res.json({ jsonrpc: "2.0", id: body.id, result: { proof } });
    }
    // A2A's HTTP bearer scheme, as the card declares it, for every A2A method.
    if (keys.token !== null && req.get("authorization") !== `Bearer ${keys.token}`) return void res.status(401).set("www-authenticate", 'Bearer realm="a2a"').end();
    next();
  },
];

let started: Promise<string> | null = null;
let server: Server | null = null;

/** The server's base URL, started on first use. */
export function a2aSdkBase(): Promise<string> {
  started ??= new Promise<string>((resolve, reject) => {
    const app = express();
    app.use("/plain/:n", sdk("plain", "1.0", false));
    app.use("/ext/:n", ...ownersGlue, sdk("ext", "1.0", true));
    app.use("/old/:n", ...ownersGlue, sdk("old", "0.3", true));
    server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    server.once("error", reject);
    server.unref();
  });
  return started;
}

/** The control host's answers, for the test. */
export async function a2aSdkControl(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/hold" && request.method === "POST") {
    const { path, secret, token } = (await request.json()) as { path: string; secret: string; token?: string | null };
    held.set(path, { secret, token: token ?? null });
    return new Response("ok");
  }
  if (url.pathname === "/received") return Response.json(received);
  return new Response(null, { status: 404 });
}
