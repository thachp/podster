import { checkEndpoint } from "./egress";

/**
 * Spike C, Podster's side: an offer goes out through a queue as `SendMessage` with `returnImmediately`, then the remote
 * task is read back with `GetTask` until it ends (decision 117). Queue messages carry IDs only (decision 118): the task's
 * text is read when the send happens, after access is checked again. State lives in KV, standing in for the room.
 */

type Env = {
  STATE: KVNamespace;
  A2A_OUTBOUND: Queue<Job>;
  BASE_URL: string;
  SEND_TIMEOUT_MS: string;
  POLL_DELAYS_S: string;
  MAX_POLLS: string;
};

export type Job = { kind: "send"; taskId: string; attempt: number } | { kind: "poll"; taskId: string; attempt: number; n: number };

/** A Podster task as the room holds it. `endpoint` is the assignee's registered A2A endpoint (decision 119). */
type RoomTask = { id: string; title: string; instructions: string; criteria: string; status: "offered" | "accepted" | "submitted" | "open" | "canceled"; assignee: string | null; endpoint: string | null };

/** What Podster recorded about one offer attempt. One Podster task may have several (one per attempt). */
export type Delivery = {
  taskId: string;
  attempt: number;
  messageId: string;
  outcome: "pending" | "sent" | "refused_endpoint" | "redirect_not_followed" | "timeout" | "http_error" | "rpc_error" | "access_gone";
  detail?: string;
  remoteTaskId?: string;
  remoteStates: string[];
  /** What step 5's mapping would do with each read, in order: Podster commands or a hold, never a verify. */
  effects: string[];
  polls: number;
  done: boolean;
};

const key = (taskId: string, attempt: number) => `delivery:${taskId}:${attempt}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function getTask(env: Env, id: string) {
  return (await env.STATE.get<RoomTask>(`task:${id}`, "json")) ?? null;
}

async function save(env: Env, d: Delivery) {
  await env.STATE.put(key(d.taskId, d.attempt), JSON.stringify(d));
}

/** IDs only, as Podster's logs must be. */
const log = (event: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ event, ...fields }));

async function rpc(env: Env, endpoint: string, method: string, params: unknown, id: string) {
  // No redirects: a 3xx is a failed delivery, never followed (decision 134). A slow agent can't hold a consumer.
  const res = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(Number(env.SEND_TIMEOUT_MS)),
    headers: { "content-type": "application/json", "A2A-Version": "1.0", "user-agent": "Podster-A2A/0 (spike)" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res;
}

/** Step 5's pure mapping, sketched: a remote state plus what was seen before gives one effect. Rust owns this in M3. */
function effectOf(state: string, seen: string[]): string {
  const accepted = seen.includes("TASK_STATE_WORKING");
  switch (state) {
    case "TASK_STATE_SUBMITTED": return "none";
    case "TASK_STATE_WORKING": return accepted ? "none" : "accept_task"; // decision 112
    case "TASK_STATE_INPUT_REQUIRED": return "thread_message";
    case "TASK_STATE_COMPLETED": return accepted ? "submit_task" : "hold_unaccepted_response"; // never verify_task
    case "TASK_STATE_REJECTED": return "decline_task";
    case "TASK_STATE_FAILED": return accepted ? "release_task" : "decline_task";
    case "TASK_STATE_CANCELED": return "record_remote_cancel";
    case "TASK_STATE_AUTH_REQUIRED": return "thread_message_no_authority";
    default: return "ignore_unknown_state";
  }
}
const TERMINAL = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);

async function send(env: Env, job: Extract<Job, { kind: "send" }>) {
  const messageId = `${job.taskId}:${job.attempt}`;
  const existing = await env.STATE.get<Delivery>(key(job.taskId, job.attempt), "json");
  const d: Delivery = existing ?? { taskId: job.taskId, attempt: job.attempt, messageId, outcome: "pending", remoteStates: [], effects: [], polls: 0, done: false };
  if (d.done || d.outcome === "sent") return; // a redelivered queue message sends nothing twice

  // Read fresh, after access is checked again: a task that moved on, or an endpoint that's gone, sends nothing.
  const task = await getTask(env, job.taskId);
  if (!task || task.status !== "offered" || !task.endpoint) {
    Object.assign(d, { outcome: "access_gone", done: true });
    await save(env, d);
    log("a2a.offer.dropped", { task: job.taskId, attempt: job.attempt });
    return;
  }
  const allowed = checkEndpoint(task.endpoint);
  if (!allowed.ok) {
    Object.assign(d, { outcome: "refused_endpoint", detail: allowed.refusal, done: true });
    await save(env, d);
    log("a2a.offer.refused", { task: job.taskId, attempt: job.attempt, reason: allowed.refusal });
    return;
  }

  const text = `${task.title}\n\n${task.instructions}\n\nAcceptance criteria:\n${task.criteria}`;
  const params = {
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ text, mediaType: "text/markdown" }, { url: `${env.BASE_URL}/tasks/${task.id}`, mediaType: "text/html", filename: "podster-task" }],
      metadata: { "podster.dev/task": task.id, "podster.dev/attempt": job.attempt },
    },
    configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain", "text/markdown"] },
  };
  try {
    const res = await rpc(env, allowed.url, "SendMessage", params, messageId);
    if (res.status >= 300 && res.status < 400) {
      Object.assign(d, { outcome: "redirect_not_followed", detail: String(res.status), done: true });
    } else if (!res.ok) {
      Object.assign(d, { outcome: "http_error", detail: String(res.status) });
      await save(env, d);
      throw new Error(`http ${res.status}`); // the queue retries; the same messageId goes out again
    } else {
      const body = (await res.json()) as any;
      if (body.error) {
        Object.assign(d, { outcome: "rpc_error", detail: String(body.error.code), done: true });
      } else {
        const remote = body.result?.task ?? null;
        d.outcome = "sent";
        d.remoteTaskId = remote?.id;
        if (remote?.status?.state) {
          d.effects.push(effectOf(remote.status.state, d.remoteStates));
          d.remoteStates.push(remote.status.state);
          d.done = TERMINAL.has(remote.status.state);
        }
        if (!remote) Object.assign(d, { detail: "message_not_task", done: true });
      }
    }
  } catch (error) {
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      Object.assign(d, { outcome: "timeout" });
      await save(env, d);
      log("a2a.offer.timeout", { task: job.taskId, attempt: job.attempt });
      throw error;
    }
    if (d.outcome === "http_error") throw error;
    throw error;
  }
  await save(env, d);
  log("a2a.offer.result", { task: job.taskId, attempt: job.attempt, outcome: d.outcome });
  if (d.outcome === "sent" && !d.done) await env.A2A_OUTBOUND.send({ kind: "poll", taskId: job.taskId, attempt: job.attempt, n: 1 }, { delaySeconds: delayFor(env, 1) });
}

const delayFor = (env: Env, n: number) => {
  const delays = env.POLL_DELAYS_S.split(",").map(Number);
  return delays[Math.min(n - 1, delays.length - 1)];
};

async function poll(env: Env, job: Extract<Job, { kind: "poll" }>) {
  const d = await env.STATE.get<Delivery>(key(job.taskId, job.attempt), "json");
  if (!d || d.done || !d.remoteTaskId || job.n <= d.polls) return; // a redelivered poll does nothing twice
  const task = await getTask(env, job.taskId);
  if (!task?.endpoint || task.status === "canceled") {
    Object.assign(d, { done: true });
    await save(env, d);
    return;
  }
  const allowed = checkEndpoint(task.endpoint);
  if (!allowed.ok) return;
  const res = await rpc(env, allowed.url, "GetTask", { id: d.remoteTaskId, historyLength: 0 }, `${d.messageId}:poll:${job.n}`);
  d.polls = job.n;
  if (res.ok) {
    const body = (await res.json()) as any;
    const state = body.result?.status?.state;
    if (state && state !== d.remoteStates[d.remoteStates.length - 1]) {
      d.effects.push(effectOf(state, d.remoteStates));
      d.remoteStates.push(state);
    }
    if (TERMINAL.has(state)) d.done = true;
  }
  if (!d.done && job.n >= Number(env.MAX_POLLS)) d.done = true; // stands in for "after 7 days"
  await save(env, d);
  log("a2a.poll", { task: job.taskId, attempt: job.attempt, n: job.n });
  if (!d.done) await env.A2A_OUTBOUND.send({ kind: "poll", taskId: job.taskId, attempt: job.attempt, n: job.n + 1 }, { delaySeconds: delayFor(env, job.n + 1) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/spike/task" && request.method === "PUT") {
      const task = (await request.json()) as RoomTask;
      await env.STATE.put(`task:${task.id}`, JSON.stringify(task));
      return json({ ok: true });
    }
    if (url.pathname === "/spike/offer" && request.method === "POST") {
      const { taskId, attempt } = (await request.json()) as { taskId: string; attempt: number };
      await env.A2A_OUTBOUND.send({ kind: "send", taskId, attempt });
      return json({ queued: true }, 202);
    }
    // Spike only: the same messageId twice, to record what a remote server does with a resend.
    if (url.pathname === "/spike/resend" && request.method === "POST") {
      const { endpoint, messageId } = (await request.json()) as { endpoint: string; messageId: string };
      const params = { message: { messageId, role: "ROLE_USER", parts: [{ text: "resend check" }] }, configuration: { returnImmediately: true } };
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const body = (await (await rpc(env, endpoint, "SendMessage", params, `${messageId}:${i}`)).json()) as any;
        ids.push(body.result?.task?.id ?? body.error?.code ?? null);
      }
      return json({ remoteTaskIds: ids });
    }
    const m = /^\/spike\/delivery\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (m) return json(await env.STATE.get(key(m[1], Number(m[2])), "json"));
    return json({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "send") await send(env, message.body);
        else await poll(env, message.body);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 0 });
      }
    }
  },
};
