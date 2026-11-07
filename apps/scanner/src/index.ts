import { Container, getContainer } from "@cloudflare/containers";
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

export default {
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const message of batch.messages) {
      // Retries ran out with no verdict. The room's hour ends it as failed, so nothing here says otherwise.
      if (batch.queue.endsWith("-dlq") || batch.queue.includes("-dlq-")) {
        console.log(JSON.stringify({ ...logged(message.body), outcome: "gave_up", attempts: message.attempts }));
        message.ack();
        continue;
      }
      const started = Date.now();
      const ending = await scanOne(message.body, scanningWith(env)).catch(() => ({ ack: false as const, why: "no_answer" as const }));
      console.log(JSON.stringify({ ...logged(message.body), outcome: ending.ack ? ending.outcome : ending.why, attempts: message.attempts, ms: Date.now() - started }));
      if (ending.ack) message.ack();
      else message.retry();
    }
  },
} satisfies ExportedHandler<Env, unknown>;
