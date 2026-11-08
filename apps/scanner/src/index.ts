import { Container, getContainer } from "@cloudflare/containers";
import { consumeFairly, type Queued } from "./fair";
import { scanOne, sendResult, type Scanning } from "./scan";

/** Reads hostile files, so it holds no secrets, reaches nothing and is handed one file at a time. Signatures come in the image. */
export class ClamAV extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = false;
  // Listening starts at once. `/ready` waits for the signatures to load.
  pingEndpoint = "localhost/live";
}

export type Env = {
  ASSETS: R2Bucket;
  API: Fetcher;
  /** A secret, for this Worker only. The Container is given no environment. */
  SCANNER_SECRET?: string;
  CLAMAV: DurableObjectNamespace<ClamAV>;
  /** The queue this consumes, so jobs a batch didn't reach can go to its back. */
  SCAN: Queue<unknown>;
};

const scanningWith = (env: Env): Scanning => ({
  now: () => Date.now(),
  read: async (key) => {
    const object = await env.ASSETS.get(key);
    return object ? { size: object.size, body: object.body } : null;
  },
  container: (request) => getContainer(env.CLAMAV, "scanner").fetch(request),
  send: (result, signal) => sendResult(env.API, env.SCANNER_SECRET, result, signal),
});

/** IDs and outcomes only. A key, a hash or a reason says nothing a log needs. */
const logged = (body: unknown) => {
  const { workspace_id, object_id } = (typeof body === "object" && body !== null ? body : {}) as { workspace_id?: unknown; object_id?: unknown };
  const id = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "unknown");
  return { at: "scanner", workspace_id: id(workspace_id), object_id: id(object_id) };
};

/** Scans one job and acks or retries it, logging only IDs and the outcome. */
async function handle(message: Queued, env: Env) {
  const started = Date.now();
  const ending = await scanOne(message.body, scanningWith(env)).catch(() => ({ ack: false as const, why: "no_answer" as const }));
  const refused = ending.ack && ending.outcome === "not_recorded" ? ending.status : null;
  // A 404 is a wrong or missing secret as often as an unknown file, and a wrong secret fails every file, so it has its own word to
  // alert on.
  const outcome = refused === 404 ? "room_said_not_found" : ending.ack ? ending.outcome : ending.why;
  const line = JSON.stringify({ ...logged(message.body), outcome, ...(refused === null ? {} : { status: refused }), attempts: message.attempts, ms: Date.now() - started });
  if (refused === 404) console.error(line);
  else console.log(line);
  if (ending.ack) message.ack();
  else message.retry();
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env) {
    // Retries ran out with no verdict. The room's hour ends it as failed, so nothing here says otherwise.
    if (batch.queue.endsWith("-dlq") || batch.queue.includes("-dlq-")) {
      for (const message of batch.messages) {
        console.log(JSON.stringify({ ...logged(message.body), outcome: "gave_up", attempts: message.attempts }));
        message.ack();
      }
      return;
    }
    const done = await consumeFairly(batch.messages, {
      now: () => Date.now(),
      handle: (message) => handle(message, env),
      // Its room's sweep ends the file as failed after the hour, so neither says anything to the room.
      settle: (message, why) => {
        console.log(JSON.stringify({ ...logged(message.body), outcome: why, attempts: message.attempts }));
        message.ack();
      },
      requeue: async (messages) => {
        await env.SCAN.sendBatch(messages);
      },
      // Its own word to alert on: sending back is how turns are shared, and when it fails every deferred job spends a try.
      requeueFailed: (count) => console.error(JSON.stringify({ at: "scanner", outcome: "requeue_failed", count })),
    });
    if (done.delayed + done.requeued + done.retried + done.settled > 0) console.log(JSON.stringify({ at: "scanner", outcome: "batch_shared", ...done }));
  },
} satisfies ExportedHandler<Env, unknown>;
