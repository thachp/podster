/**
 * Remote A2A agents, in Node, built on the A2A project's JavaScript SDK server. The test pool routes the Worker's
 * outbound fetches here, so Podster's real `fetch`, with `redirect: "manual"` and a timeout, is what reaches them.
 * Each host behaves differently. This is the project's own server, not an independent implementation.
 */
import { AgentCard, TaskState, type Task } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, defaultServerCallContextBuilder, type AgentExecutor } from "@a2a-js/sdk/server";

type Mode = "steady" | "eager" | "reject";
const counts = { sendMessage: 0, tasksCreated: 0, byMessageId: new Map<string, number>(), lastText: "" };

const card = (host: string) =>
  AgentCard.fromJSON({
    name: host, description: "remote test agent", version: "0",
    supportedInterfaces: [{ url: `https://${host}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ["text/plain", "text/markdown"], defaultOutputModes: ["text/plain"], skills: [],
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function executor(mode: Mode): AgentExecutor {
  return {
    async execute(ctx, bus) {
      counts.tasksCreated += 1;
      const base = (state: TaskState): Task => ({ id: ctx.taskId, contextId: ctx.contextId, status: { state, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [ctx.userMessage], metadata: undefined });
      const status = (state: TaskState) => AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state, message: undefined, timestamp: new Date().toISOString() }, metadata: undefined });
      if (mode === "eager") {
        // Answers at once, without ever saying it's working: Podster must hold this, not accept it.
        bus.publish(AgentEvent.task(base(TaskState.TASK_STATE_COMPLETED)));
        bus.finished();
        return;
      }
      if (mode === "reject") {
        bus.publish(AgentEvent.task(base(TaskState.TASK_STATE_REJECTED)));
        bus.finished();
        return;
      }
      bus.publish(AgentEvent.task(base(TaskState.TASK_STATE_SUBMITTED)));
      await sleep(150);
      bus.publish(status(TaskState.TASK_STATE_WORKING));
      await sleep(1500);
      bus.publish(status(TaskState.TASK_STATE_COMPLETED));
      bus.finished();
    },
    async cancelTask() {},
  } as AgentExecutor;
}

const handlers = new Map<string, JsonRpcTransportHandler>();
function handlerFor(host: string, mode: Mode) {
  let h = handlers.get(host);
  if (!h) handlers.set(host, (h = new JsonRpcTransportHandler(new DefaultRequestHandler(card(host), new InMemoryTaskStore(), executor(mode)))));
  return h;
}

export async function remoteAgents(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;
  if (host === "control.example.com") {
    return Response.json({ sendMessage: counts.sendMessage, tasksCreated: counts.tasksCreated, byMessageId: Object.fromEntries(counts.byMessageId), lastText: counts.lastText });
  }
  if (host === "redirect.example.com") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
  if (host === "slow.example.com") {
    await sleep(5000);
    return new Response("too late", { status: 200 });
  }
  if (host === "metadata.example.com") return new Response("Podster followed a redirect", { status: 200 });
  const mode: Mode | null = host.startsWith("steady") ? "steady" : host.startsWith("eager") ? "eager" : host.startsWith("reject") ? "reject" : null;
  if (!mode || url.pathname !== "/a2a") return new Response("not found", { status: 404 });
  const text = await request.text();
  const body = JSON.parse(text);
  if (body.method === "SendMessage") {
    counts.sendMessage += 1;
    const id = body.params?.message?.messageId;
    counts.byMessageId.set(id, (counts.byMessageId.get(id) ?? 0) + 1);
    counts.lastText = body.params?.message?.parts?.[0]?.text ?? "";
  }
  const context = defaultServerCallContextBuilder({ extensions: undefined, user: undefined, headers: Object.fromEntries(request.headers), requestedVersion: request.headers.get("A2A-Version") ?? undefined } as never);
  const result = await handlerFor(host, mode).handle(text, context);
  return Response.json(result);
}
